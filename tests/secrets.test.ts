import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateDashboardPassword,
  generateHmacApiKey,
  generateJwtSecret,
  generatePgsodiumRootKey,
  generatePostgresPassword,
  renderProdTfvars,
  signSupabaseJwt,
  verifySupabaseJwt,
} from '../src/lib/secrets.js';

describe('generatePgsodiumRootKey', () => {
  it('returns 64 lowercase hex chars', () => {
    const k = generatePgsodiumRootKey();
    expect(k).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a different value on every call (statistically)', () => {
    const a = generatePgsodiumRootKey();
    const b = generatePgsodiumRootKey();
    expect(a).not.toBe(b);
  });
});

describe('renderProdTfvars', () => {
  it('renders the minimal tfvars with sensible defaults', () => {
    const out = renderProdTfvars({ domain: 'civicfeed.tx' });
    expect(out).toContain('project = "opuspopuli"');
    expect(out).toContain('domain_name = "civicfeed.tx"');
    expect(out).toContain('api_subdomain = "api"');
    expect(out).toContain('app_subdomain = "app"');
    expect(out).toContain('tunnel_api_port = 8080');
    expect(out).toContain('r2_location_hint = "WNAM"');
    expect(out).toContain('enable_tunnel   = true');
    expect(out).toContain('enable_frontend = true');
    expect(out).toContain('enable_r2       = true');
  });

  it('honors caller overrides', () => {
    const out = renderProdTfvars({
      project: 'oprc',
      domain: 'example.org',
      apiSubdomain: 'gateway',
      appSubdomain: 'www',
      tunnelApiPort: 9090,
      r2LocationHint: 'EEU',
    });
    expect(out).toContain('project = "oprc"');
    expect(out).toContain('domain_name = "example.org"');
    expect(out).toContain('api_subdomain = "gateway"');
    expect(out).toContain('app_subdomain = "www"');
    expect(out).toContain('tunnel_api_port = 9090');
    expect(out).toContain('r2_location_hint = "EEU"');
  });

  it('quote-escapes a domain with special chars', () => {
    const out = renderProdTfvars({ domain: 'has"quote.test' });
    expect(out).toContain('domain_name = "has\\"quote.test"');
  });
});

describe('generatePostgresPassword', () => {
  it('returns a URL-safe base64url string with no + / = (postgres:// URI compat)', () => {
    const pw = generatePostgresPassword();
    // 32 bytes → 43 chars base64url unpadded.
    expect(pw.length).toBeGreaterThanOrEqual(32);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
    // Explicitly assert the URL-reserved chars never appear.
    expect(pw).not.toMatch(/[+/=]/);
  });

  it('does not collide across calls', () => {
    expect(generatePostgresPassword()).not.toBe(generatePostgresPassword());
  });
});

describe('generateDashboardPassword', () => {
  it('returns a URL-safe base64url string', () => {
    const pw = generateDashboardPassword();
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pw).not.toMatch(/[+/=]/);
    expect(pw.length).toBeGreaterThanOrEqual(24);
  });
});

describe('generateHmacApiKey', () => {
  it('returns a URL-safe base64url string (no + / = chars)', () => {
    const k = generateHmacApiKey();
    // 32 bytes → 43 chars base64url unpadded
    expect(k.length).toBeGreaterThanOrEqual(40);
    expect(k).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(k).not.toMatch(/[+/=]/);
  });

  it('survives unescaped embedding in <region>:<key> comma-separated list', () => {
    // The op-compose wrapper splices the key into PROMPT_SERVICE_API_KEYS as
    // `<region>:<key>`. The key must NOT contain `:` or `,` or it'd corrupt
    // the list. base64url alphabet guarantees this.
    const k = generateHmacApiKey();
    expect(k).not.toContain(':');
    expect(k).not.toContain(',');
  });

  it('produces a different value on every call', () => {
    expect(generateHmacApiKey()).not.toBe(generateHmacApiKey());
  });
});

describe('generateJwtSecret', () => {
  it('returns a high-entropy base64 string (≥64 chars for 48 bytes)', () => {
    const s = generateJwtSecret();
    expect(s).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(s.length).toBeGreaterThanOrEqual(64);
  });
});

describe('signSupabaseJwt', () => {
  const SECRET = 'test-secret-of-sufficient-length-for-hs256';

  function decodePart(part: string): unknown {
    // base64url → base64
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  }

  it('produces a JWT with the expected role claim for anon', () => {
    const jwt = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 100 });
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = decodePart(parts[0]!) as { alg: string; typ: string };
    const payload = decodePart(parts[1]!) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload.role).toBe('anon');
    expect(payload.iss).toBe('supabase');
    expect(payload.iat).toBe(100);
    // Default ttl = 10 years in seconds.
    expect(payload.exp).toBe(100 + 10 * 365 * 24 * 60 * 60);
  });

  it('produces a service_role JWT distinct from anon under the same secret', () => {
    const anon = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 1 });
    const sr = signSupabaseJwt({ role: 'service_role', secret: SECRET, issuedAtSeconds: 1 });
    expect(anon).not.toBe(sr);
  });

  it('produces a valid HS256 signature', () => {
    const jwt = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 1 });
    const [h, p, sig] = jwt.split('.');
    // eslint-disable-next-line sonarjs/hardcoded-secret-signatures -- SECRET is a local test constant, not a real credential
    const expected = createHmac('sha256', SECRET)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(sig).toBe(expected);
  });

  it('is deterministic when iat is fixed (so re-runs produce the same token)', () => {
    const a = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 42 });
    const b = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 42 });
    expect(a).toBe(b);
  });

  it('uses the deterministic default iat (1_700_000_000) when none is passed', () => {
    // Bootstrap relies on this — re-runs with a cached JWT_SECRET produce
    // bit-for-bit identical anon/service_role tokens, so the Keychain entry
    // doesn't churn on every invocation.
    const a = signSupabaseJwt({ role: 'anon', secret: SECRET });
    const b = signSupabaseJwt({ role: 'anon', secret: SECRET });
    expect(a).toBe(b);
  });
});

describe('verifySupabaseJwt', () => {
  const SECRET = 'jwt-secret-bytes-for-the-test';
  const OTHER = 'a-completely-different-secret';

  it('accepts a token signed with the same secret', () => {
    const t = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 1 });
    expect(verifySupabaseJwt(t, SECRET)).toBe(true);
  });

  it('rejects a token signed with a different secret (rotation detection)', () => {
    // The exact use case bootstrap needs: anon-key was minted with JWT_SECRET=A,
    // then JWT_SECRET rotated to B. Without verification, the stale token sails
    // through and every Supabase call silently 401s.
    const t = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 1 });
    expect(verifySupabaseJwt(t, OTHER)).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifySupabaseJwt('not.a.token-but-three-parts', SECRET)).toBe(false);
    expect(verifySupabaseJwt('twoparts.only', SECRET)).toBe(false);
    expect(verifySupabaseJwt('singlepart', SECRET)).toBe(false);
    expect(verifySupabaseJwt('', SECRET)).toBe(false);
  });

  it('rejects when only the signature has been tampered with', () => {
    const t = signSupabaseJwt({ role: 'anon', secret: SECRET, issuedAtSeconds: 1 });
    const [h, p] = t.split('.');
    expect(verifySupabaseJwt(`${h}.${p}.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, SECRET)).toBe(
      false,
    );
  });
});
