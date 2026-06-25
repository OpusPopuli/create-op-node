import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderOpComposeScript } from '../src/lib/op-compose-script.js';
import { installOpComposeWrapper } from '../src/lib/op-compose-install.js';

describe('renderOpComposeScript', () => {
  it('emits a sh script with the region baked into the Keychain service identifier', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toMatch(/^#!\/bin\/bash$/m);
    expect(s).toMatch(/SVC="org\.opuspopuli\.us-ca"/);
  });

  it('exports every required secret + the optional tunnel + supabase URL', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    for (const v of [
      'PGSODIUM_ROOT_KEY',
      'POSTGRES_PASSWORD',
      'JWT_SECRET',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DASHBOARD_PASSWORD',
      'AUTH_JWT_SECRET',
      'SUPABASE_URL',
      'TUNNEL_TOKEN',
    ]) {
      expect(s).toContain(v);
    }
  });

  it('ends with `exec docker compose "$@"` so all args pass through', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toMatch(/exec docker compose "\$@"/);
  });

  it('points the operator at create-op-node bootstrap on a Keychain miss', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toMatch(/create-op-node bootstrap --region us-ca/);
  });

  it('exports prompt-service credentials conditionally (optional_secret)', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toContain('prompts-db-password');
    expect(s).toContain('prompt-service-api-key');
    expect(s).toContain('prompt-service-admin-api-key');
    // The exports must be conditional — `if [ -n "$..." ]` guards so the
    // wrapper works when the prompt-service overlay is NOT in use.
    expect(s).toMatch(/if \[ -n "\$PROMPT_SERVICE_API_KEY_VAL" \]/);
    expect(s).toMatch(/if \[ -n "\$PROMPTS_DB_PASSWORD_VAL" \]/);
  });

  it('renders PROMPT_SERVICE_API_KEYS as <region>:<key> for prompt-service env', () => {
    // prompt-service expects API_KEYS=<region>:<key>,<region>:<key>; the
    // backend sends just <key>. Wrapper has to bridge the two formats.
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toMatch(/PROMPT_SERVICE_API_KEYS="us-ca:\$PROMPT_SERVICE_API_KEY_VAL"/);
  });

  it('refuses a region with shell metacharacters even for prompt-service exports', () => {
    // The region slug is interpolated unescaped into PROMPT_SERVICE_API_KEYS;
    // the region-validation regex must reject anything that could inject.
    expect(() => renderOpComposeScript({ region: 'us-ca";rm -rf /;#' })).toThrow(
      /not allowed in a launchd \/ Keychain service identifier/,
    );
  });

  describe('PROMPT_SERVICE_URL handling', () => {
    it('omits PROMPT_SERVICE_URL export when no URL is provided', () => {
      const s = renderOpComposeScript({ region: 'us-ca' });
      expect(s).not.toMatch(/export PROMPT_SERVICE_URL=/);
    });

    it('bakes the remote URL as a fallback the wrapper exports', () => {
      const s = renderOpComposeScript({
        region: 'us-ca',
        promptServiceUrl: 'https://prompts.opuspopuli.org',
      });
      expect(s).toMatch(/export PROMPT_SERVICE_URL="\$\{PROMPT_SERVICE_URL:-https:\/\/prompts\.opuspopuli\.org\}"/);
    });

    it('bakes the in-network URL for colocated deployments', () => {
      const s = renderOpComposeScript({
        region: 'us-ca',
        promptServiceUrl: 'http://opuspopuli-prompts:3210',
      });
      expect(s).toMatch(/http:\/\/opuspopuli-prompts:3210/);
    });

    it('refuses a promptServiceUrl with shell metacharacters', () => {
      for (const bad of [
        'https://prompts.opuspopuli.org;rm -rf $HOME',
        'https://prompts$(echo pwn).org',
        'has spaces',
        'has`backtick',
      ]) {
        expect(() => renderOpComposeScript({ region: 'us-ca', promptServiceUrl: bad })).toThrow(
          /promptServiceUrl.*not allowed/,
        );
      }
    });

    it('accepts realistic prompt-service URLs', () => {
      for (const ok of [
        'http://localhost:8000',
        'http://opuspopuli-prompts:3210',
        'https://prompts.opuspopuli.org',
        'https://prompts-staging.opuspopuli.org/api',
      ]) {
        expect(() => renderOpComposeScript({ region: 'us-ca', promptServiceUrl: ok })).not.toThrow();
      }
    });
  });

  it('uses `set -euo pipefail` so a Keychain-read failure fails the script', () => {
    const s = renderOpComposeScript({ region: 'us-ca' });
    expect(s).toMatch(/set -euo pipefail/);
  });

  it('refuses a region name with shell-injection characters', () => {
    for (const evil of [
      'us-ca; rm -rf $HOME',
      'us-ca$(echo pwned)',
      'us-ca`whoami`',
      'us ca',
      'us/ca',
      '.us-ca',
      '',
    ]) {
      expect(() => renderOpComposeScript({ region: evil })).toThrow(
        /not allowed in a launchd \/ Keychain service identifier/,
      );
    }
  });

  it('accepts valid region slugs (lowercase letters + digits + hyphens, 2–32 chars)', () => {
    for (const ok of ['us-ca', 'ny-nyc', 'eu1', 'a1', 'a'.repeat(32)]) {
      expect(() => renderOpComposeScript({ region: ok })).not.toThrow();
    }
  });
});

describe('installOpComposeWrapper', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'op-compose-install-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes bin/op-compose at mode 0755 with the rendered content', async () => {
    const r = await installOpComposeWrapper({ repoDir: dir, region: 'us-ca' });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(dir, 'bin', 'op-compose'));

    const content = await readFile(r.path!, 'utf8');
    expect(content).toMatch(/SVC="org\.opuspopuli\.us-ca"/);

    const st = await stat(r.path!);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it('creates the bin/ directory if it does not exist', async () => {
    const r = await installOpComposeWrapper({ repoDir: dir, region: 'us-ca' });
    expect(r.ok).toBe(true);
    const binStat = await stat(join(dir, 'bin'));
    expect(binStat.isDirectory()).toBe(true);
  });

  it('overwrites an existing wrapper atomically', async () => {
    await installOpComposeWrapper({ repoDir: dir, region: 'us-ca' });
    const r = await installOpComposeWrapper({ repoDir: dir, region: 'us-tx' });
    expect(r.ok).toBe(true);
    const content = await readFile(r.path!, 'utf8');
    expect(content).toMatch(/SVC="org\.opuspopuli\.us-tx"/);
    expect(content).not.toMatch(/SVC="org\.opuspopuli\.us-ca"/);
  });

  it('reports a clean error on an invalid region', async () => {
    const r = await installOpComposeWrapper({ repoDir: dir, region: 'has; injection' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/);
  });
});
