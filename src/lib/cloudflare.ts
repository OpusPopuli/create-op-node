/**
 * Cloudflare API helpers used by `create-op-node init`.
 *
 * The probe replicates what we built interactively on 2026-06-16: hit each of
 * the 5 endpoints we need so we know the token has every scope before going any
 * further. Failing early here saves a ~60-second Terraform plan that would fail
 * with a less useful error.
 *
 * Account-owned tokens (`cfat_…`) cannot use `/user/tokens/verify`. We hit
 * `/accounts/{id}/tokens/verify` for validity and the 5 resource endpoints for
 * scope coverage.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

interface ProbeInput {
  token: string;
  accountId: string;
  zoneId: string;
}

export interface ProbeResult {
  ok: boolean;
  issues: string[];
}

async function get(
  token: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — leave as null */
  }
  return { status: res.status, body };
}

function shortError(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'errors' in body &&
    Array.isArray((body as { errors: unknown[] }).errors)
  ) {
    const errs = (body as { errors: Array<{ message?: string; code?: number }> }).errors;
    return errs
      .map((e) => `${e.code ? `CF ${e.code}: ` : ''}${e.message ?? 'unknown'}`)
      .join('; ');
  }
  return 'no error message returned';
}

interface ScopeCheck {
  name: string;
  path: string;
  /** Endpoints that 404 when the underlying feature isn't enabled but the scope
   *  IS present (e.g. R2 before "Enable R2"). We treat those as passes with a
   *  note rather than failures. */
  treat404AsPass?: boolean;
}

export async function probeCloudflareToken(input: ProbeInput): Promise<ProbeResult> {
  const issues: string[] = [];

  // ---- Validity probe (Account-owned token endpoint) ----
  const verify = await get(input.token, `/accounts/${input.accountId}/tokens/verify`);
  if (verify.status !== 200) {
    issues.push(
      `Token verify failed (HTTP ${verify.status}): ${shortError(verify.body)}`,
    );
    return { ok: false, issues };
  }

  // ---- Scope probes ----
  const checks: ScopeCheck[] = [
    { name: 'Zone : Zone : Read', path: `/zones/${input.zoneId}` },
    { name: 'Zone : DNS : Edit', path: `/zones/${input.zoneId}/dns_records?per_page=1` },
    { name: 'Account : Cloudflare Tunnel : Edit', path: `/accounts/${input.accountId}/cfd_tunnel` },
    { name: 'Account : Workers R2 Storage : Edit', path: `/accounts/${input.accountId}/r2/buckets` },
    { name: 'Account : Cloudflare Pages : Edit', path: `/accounts/${input.accountId}/pages/projects` },
  ];

  for (const check of checks) {
    const res = await get(input.token, check.path);
    if (res.status === 200) continue;
    if (res.status === 404 && check.treat404AsPass) continue;
    if (res.status === 401 || res.status === 403) {
      issues.push(`Missing scope: ${check.name}`);
    } else if (
      res.status === 400 &&
      typeof res.body === 'object' &&
      res.body !== null &&
      'errors' in res.body &&
      Array.isArray((res.body as { errors: Array<{ code?: number }> }).errors) &&
      (res.body as { errors: Array<{ code?: number }> }).errors.some((e) => e.code === 10042)
    ) {
      // R2 not enabled yet — actionable, not a scope problem.
      issues.push(
        `R2 not enabled on this account. ` +
          `Enable it once in Cloudflare dashboard → R2 → Get started, then re-run.`,
      );
    } else {
      issues.push(`${check.name} probe returned HTTP ${res.status}: ${shortError(res.body)}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/* ------------------------------------------------------------------ *
 *  Tunnel-status probe (used by `verify`, not `init`)                *
 * ------------------------------------------------------------------ */

export interface TunnelStatusInput {
  token: string;
  accountId: string;
  tunnelId: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface TunnelStatusOk {
  ok: true;
  /** Active connector connections registered with Cloudflare's edge. Zero on
   *  a freshly-created tunnel that hasn't been started, > 0 on a healthy one. */
  connections: number;
  /** Cloudflare's own status field — `healthy`, `degraded`, `inactive`, etc. */
  status: string;
}

export interface TunnelStatusFailed {
  ok: false;
  reason: string;
}

export type TunnelStatusResult = TunnelStatusOk | TunnelStatusFailed;

interface CfTunnelEnvelope {
  result?: {
    status?: string;
    connections?: Array<unknown>;
  };
}

/**
 * Look up a single tunnel's current edge-side status. The CF API endpoint
 * returns `connections: []` until at least one cloudflared connector
 * registers — useful as a verify signal that the Studio's cloudflared is
 * actually online.
 */
export async function tunnelStatus(input: TunnelStatusInput): Promise<TunnelStatusResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await get(
      input.token,
      `/accounts/${input.accountId}/cfd_tunnel/${input.tunnelId}`,
      fetchImpl,
    );
    if (res.status !== 200) {
      return {
        ok: false,
        reason: `tunnel lookup failed (HTTP ${res.status}): ${shortError(res.body)}`,
      };
    }
    const env = res.body as CfTunnelEnvelope;
    const status = env.result?.status ?? '<no status>';
    const connections = env.result?.connections?.length ?? 0;
    return { ok: true, connections, status };
  } catch (err) {
    return { ok: false, reason: `tunnel lookup threw: ${(err as Error).message}` };
  }
}
