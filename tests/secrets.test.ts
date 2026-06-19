import { describe, expect, it } from 'vitest';

import { generatePgsodiumRootKey, renderProdTfvars } from '../src/lib/secrets.js';

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
