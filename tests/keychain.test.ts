import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  _internal,
  deleteSecret,
  detectKeychain,
  isKeychainLocked,
  isSshSession,
  readSecret,
  saveSecret,
  unlockKeychain,
} from '../src/lib/keychain.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

const coords = { region: 'us-ca', account: 'pgsodium-root-key' as const };
const VALID_KEY = 'a'.repeat(64);

describe('_internal naming', () => {
  it('uses reverse-DNS service prefix scoped by region', () => {
    expect(_internal.serviceFor('us-ca')).toBe('org.opuspopuli.us-ca');
    expect(_internal.serviceFor('ny-nyc')).toBe('org.opuspopuli.ny-nyc');
  });

  it('produces a human-readable label per secret kind', () => {
    expect(_internal.labelFor({ region: 'us-ca', account: 'pgsodium-root-key' })).toContain(
      'pgsodium',
    );
    expect(_internal.labelFor({ region: 'us-ca', account: 'tunnel-token' })).toContain('Tunnel');
    expect(_internal.labelFor({ region: 'us-ca', account: 'postgres-password' })).toContain(
      'Postgres',
    );
    expect(_internal.labelFor({ region: 'us-ca', account: 'jwt-secret' })).toContain('JWT');
    expect(_internal.labelFor({ region: 'us-ca', account: 'supabase-anon-key' })).toContain('anon');
    expect(
      _internal.labelFor({ region: 'us-ca', account: 'supabase-service-role-key' }),
    ).toContain('service role');
    expect(_internal.labelFor({ region: 'us-ca', account: 'dashboard-password' })).toContain(
      'dashboard',
    );
    expect(_internal.labelFor({ region: 'us-ca', account: 'prompts-db-password' })).toContain(
      'prompt-service Postgres',
    );
    expect(_internal.labelFor({ region: 'us-ca', account: 'prompt-service-api-key' })).toContain(
      'prompt-service HMAC',
    );
    expect(
      _internal.labelFor({ region: 'us-ca', account: 'prompt-service-admin-api-key' }),
    ).toContain('prompt-service admin');
  });
});

describe('detectKeychain', () => {
  it('returns available=true when `security -h` runs', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await detectKeychain();
    expect(r.available).toBe(true);
  });

  it('returns available=false with reason when `security` is missing', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await detectKeychain();
    expect(r.available).toBe(false);
    expect(r.reason).toContain('not on PATH');
  });
});

describe('saveSecret', () => {
  it('upserts with -U and reports written=true on success', async () => {
    execaMock
      // find: not found
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      // add: success
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.written).toBe(true);
    expect(r.updated).toBe(false);

    const addCall = execaMock.mock.calls[1] as [string, string[]];
    expect(addCall[0]).toBe('security');
    const args = addCall[1];
    expect(args).toContain('add-generic-password');
    expect(args).toContain('-U');
    expect(args).toContain('-s');
    expect(args).toContain('org.opuspopuli.us-ca');
    expect(args).toContain('-a');
    expect(args).toContain('pgsodium-root-key');
    expect(args).toContain('-w');
    expect(args).toContain(VALID_KEY);
  });

  it('reports updated=true when the item already existed', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'existing', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.written).toBe(true);
    expect(r.updated).toBe(true);
  });

  it('reports written=false with reason on add failure', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 36, stdout: '', stderr: 'errSecAuthFailed' });
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.written).toBe(false);
    expect(r.reason).toContain('errSecAuthFailed');
  });

  it('reports `security` not on PATH cleanly', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.written).toBe(false);
    expect(r.reason).toContain('not on PATH');
  });
});

describe('readSecret', () => {
  it('returns the trimmed value on success', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: `${VALID_KEY}\n`, stderr: '' });
    const v = await readSecret(coords);
    expect(v).toBe(VALID_KEY);

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('find-generic-password');
    expect(args).toContain('-s');
    expect(args).toContain('org.opuspopuli.us-ca');
    expect(args).toContain('-a');
    expect(args).toContain('pgsodium-root-key');
    expect(args[args.length - 1]).toBe('-w');
  });

  it('returns null when the item does not exist (errSecItemNotFound)', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 44,
      stdout: '',
      stderr: 'The specified item could not be found in the keychain.',
    });
    const v = await readSecret(coords);
    expect(v).toBeNull();
  });

  it('returns null when `security` is missing', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const v = await readSecret(coords);
    expect(v).toBeNull();
  });

  it('returns null on an empty body (treats as not present)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '   \n', stderr: '' });
    const v = await readSecret(coords);
    expect(v).toBeNull();
  });
});

describe('deleteSecret', () => {
  it('returns ok=true on exit 0', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await deleteSecret(coords);
    expect(r.ok).toBe(true);
  });

  it('treats errSecItemNotFound (44) as ok — idempotent', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 44, stdout: '', stderr: '' });
    const r = await deleteSecret(coords);
    expect(r.ok).toBe(true);
  });

  it('reports failure cleanly on other exit codes', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 36, stdout: '', stderr: 'errSecAuthFailed' });
    const r = await deleteSecret(coords);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('errSecAuthFailed');
  });
});

describe('errSecInteractionNotAllowed hint', () => {
  it('appends an unlock-keychain hint when saveSecret hits exit 36', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // find: not found
      .mockResolvedValueOnce({ exitCode: 36, stdout: '', stderr: 'User interaction is not allowed.' });
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/login keychain is locked/);
    expect(r.reason).toMatch(/security unlock-keychain/);
  });

  it('does NOT append a hint for unrelated error codes', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 36 + 1, stdout: '', stderr: 'other' });
    const r = await saveSecret(coords, VALID_KEY);
    expect(r.reason).not.toMatch(/login keychain is locked/);
  });

  it('appends the same hint when deleteSecret hits exit 36', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 36, stdout: '', stderr: 'User interaction is not allowed.' });
    const r = await deleteSecret(coords);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/security unlock-keychain/);
  });
});

describe('isKeychainLocked', () => {
  it('returns true on exit 36 (errSecInteractionNotAllowed) from the probe', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 36, stdout: '', stderr: 'User interaction is not allowed.' });
    expect(await isKeychainLocked()).toBe(true);
  });

  it('returns false on exit 44 (errSecItemNotFound — probe target absent → unlocked)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 44, stdout: '', stderr: '' });
    expect(await isKeychainLocked()).toBe(false);
  });

  it('returns false when security CLI is missing (cannot be locked)', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    expect(await isKeychainLocked()).toBe(false);
  });
});

describe('unlockKeychain', () => {
  it('reports ok=true on exit 0', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await unlockKeychain('correct-password');
    expect(r.ok).toBe(true);

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe('unlock-keychain');
    expect(args).toContain('-p');
    expect(args).toContain('correct-password');
  });

  it('reports the security stderr on a wrong-password failure', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 51,
      stdout: '',
      stderr: 'security: The specified item is not a valid keychain.',
    });
    const r = await unlockKeychain('wrong');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/security unlock-keychain failed/);
  });
});

describe('isSshSession', () => {
  it('returns true when SSH_CONNECTION is set', () => {
    expect(isSshSession({ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' })).toBe(true);
  });

  it('returns true when SSH_TTY is set (TTY-allocated session)', () => {
    expect(isSshSession({ SSH_TTY: '/dev/ttys000' })).toBe(true);
  });

  it('returns false when neither var is present (local Mac shell)', () => {
    expect(isSshSession({})).toBe(false);
  });
});
