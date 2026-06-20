/**
 * Small pure helpers for the local-state-only bits of `create-op-node init`:
 * generating a fresh pgsodium master key, and rendering a region's
 * `prod.tfvars` file.
 *
 * Both are side-effect free — they produce strings the caller decides what to
 * do with. Tests exercise them in isolation.
 */

import { createHmac, randomBytes } from 'node:crypto';

/**
 * Generate a 32-byte (256-bit) key encoded as 64 lowercase hex characters —
 * the format `pgsodium` expects in `PGSODIUM_ROOT_KEY` and what the runbook
 * documents. The bytes come from Node's CSPRNG.
 */
export function generatePgsodiumRootKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * url-safe base64 helper (RFC 4648 §5) — the JWT spec mandates this variant
 * (no `+`, no `/`, no padding). `Buffer#toString('base64url')` exists on
 * Node ≥ 16 but expressing it locally keeps the dependency surface tiny and
 * avoids type-coverage games across older `@types/node`.
 */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * 32-byte CSPRNG password rendered as base64url (no `+`, no `/`, no `=`).
 * Used for POSTGRES_PASSWORD — every Supabase admin user (supabase_admin,
 * authenticator, pgbouncer, supabase_auth_admin, supabase_functions_admin,
 * supabase_storage_admin) shares this one password by design of the
 * upstream init scripts.
 *
 * MUST be URL-safe: the value lands in postgres:// connection-string URIs
 * inside docker-compose env vars (gotrue, postgrest, storage). libpq parses
 * those as RFC 3986 URIs, so `/` would terminate the password component and
 * `+`/`=` are reserved sub-delims that can confuse some URI parsers. base64url
 * keeps the alphabet to `[A-Za-z0-9_-]` which is unambiguously safe in every
 * URI component.
 *
 * 32 bytes → 256 bits of entropy. The base64url encoding is ~43 chars (no
 * padding) — well above what any offline attack on a bcrypt store could
 * threaten.
 */
export function generatePostgresPassword(): string {
  return base64url(randomBytes(32));
}

/** Alias for clarity at the call site. Also base64url so it composes safely
 *  into kong's declarative config (where DASHBOARD_PASSWORD is interpolated). */
export function generateDashboardPassword(): string {
  return base64url(randomBytes(24));
}

/**
 * 48-byte (384-bit) base64 secret used to sign every Supabase-issued JWT.
 *
 * gotrue, postgrest, storage, and studio all verify tokens against this
 * value, so it must stay identical across the stack and across restarts.
 * Treat it like a master key — rotating it invalidates every session and
 * every long-lived ANON/SERVICE_ROLE token derived from it.
 */
export function generateJwtSecret(): string {
  return randomBytes(48).toString('base64');
}

export type SupabaseRole = 'anon' | 'service_role';

export interface SupabaseJwtInput {
  role: SupabaseRole;
  /** HS256 signing key — same JWT_SECRET that gotrue/postgrest verify with. */
  secret: string;
  /** `iat` claim, seconds since epoch. Defaults to 1700000000 (2023-11-14)
   *  — a stable past timestamp. This is deliberate, not a test artifact:
   *  bootstrap re-runs generate the SAME token shape so we don't churn
   *  the cached Keychain entry on every invocation. Pass `Date.now()/1000`
   *  if you need a fresh `iat` (e.g. tests that exercise expiry handling). */
  issuedAtSeconds?: number;
  /** Token lifetime in seconds. Default: 10 years — Supabase's own
   *  self-hosting docs ship `exp = iat + 10y` for the long-lived
   *  anon + service_role keys. */
  ttlSeconds?: number;
  /** `iss` claim. Default: `supabase`. */
  issuer?: string;
}

/**
 * Verify that a stored JWT's signature was produced by the given secret.
 *
 * Constant-time-ish compare via Buffer length + manual byte loop — the
 * tokens are short and rare enough that the timing channel here doesn't
 * meaningfully advantage an attacker (and the attacker would need to be
 * able to feed bootstrap arbitrary candidate tokens, which they can't).
 *
 * Use case: bootstrap loaded supabase-anon-key from Keychain, but JWT_SECRET
 * may have rotated since. If the cached token's signature doesn't match the
 * current secret, we treat it as stale and regenerate. Without this check,
 * a partial Keychain wipe (e.g. operator deletes only jwt-secret) leaves
 * the derived tokens looking valid by shape but useless against gotrue/
 * postgrest, and every auth call silently fails 401.
 */
export function verifySupabaseJwt(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts as [string, string, string];
  const expected = base64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  if (sig.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Mint a Supabase-shaped HS256 JWT for the `anon` or `service_role` claim.
 *
 * Shape matches what the official `supabase` CLI / hosted-Supabase docs
 * produce, so the token works with @supabase/supabase-js, postgrest's
 * `Authorization: Bearer …`, storage-api, and Studio out of the box.
 *
 * No third-party JWT lib — we'd have to add `jsonwebtoken` (+ its CVE
 * history) for ~30 lines of HMAC code. Implementing it here keeps the
 * dep tree clean and the algorithm pinned to HS256 by construction.
 */
export function signSupabaseJwt(input: SupabaseJwtInput): string {
  const iat = input.issuedAtSeconds ?? 1_700_000_000;
  const ttl = input.ttlSeconds ?? 10 * 365 * 24 * 60 * 60;
  const issuer = input.issuer ?? 'supabase';

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: input.role,
    iss: issuer,
    iat,
    exp: iat + ttl,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64url(
    createHmac('sha256', input.secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

export interface ProdTfvarsInput {
  /** Resource-name prefix used across the Terraform module
   *  (e.g. `<project>-tunnel-prod`). Defaults to `opuspopuli`. */
  project?: string;
  /** Operator's registered domain in Cloudflare (e.g. `civicfeed.tx`). */
  domain: string;
  /** Subdomain for the API tunnel (e.g. `api`). Default: `api`. */
  apiSubdomain?: string;
  /** Subdomain for the Cloudflare Pages frontend (e.g. `app`). Default: `app`. */
  appSubdomain?: string;
  /** Local port the API Gateway listens on inside the Studio. Default: 8080. */
  tunnelApiPort?: number;
  /** R2 region hint. Default: `WNAM` (Western North America). */
  r2LocationHint?: string;
}

/**
 * Render a region operator's `prod.tfvars` from their answers. Mirrors the
 * shape of `opuspopuli-node/infra/cloudflare/environments/prod.tfvars.example`
 * so the file lands ready for the cloudflare-infra workflow without any
 * post-processing.
 *
 * The output is the literal file contents — caller writes it to the repo via
 * the GitHub Contents API (`commitFile`).
 */
export function renderProdTfvars(input: ProdTfvarsInput): string {
  const project = input.project ?? 'opuspopuli';
  const api = input.apiSubdomain ?? 'api';
  const app = input.appSubdomain ?? 'app';
  const port = input.tunnelApiPort ?? 8080;
  const r2 = input.r2LocationHint ?? 'WNAM';

  return `# =============================================================================
# Production environment — generated by create-op-node init
# =============================================================================
# Region-specific values for the OpusPopuli/opuspopuli-node template's
# infra/cloudflare/ Terraform. Edit by hand to tweak.

project = ${JSON.stringify(project)}

domain_name = ${JSON.stringify(input.domain)}

api_subdomain = ${JSON.stringify(api)}
app_subdomain = ${JSON.stringify(app)}

tunnel_api_port = ${port}

r2_location_hint = ${JSON.stringify(r2)}

enable_tunnel   = true
enable_frontend = true
enable_r2       = true
`;
}
