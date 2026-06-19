import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { tlsHandshake } from '../src/lib/tls.js';

interface FakeSocket extends EventEmitter {
  destroy: () => void;
  getPeerCertificate: () => Record<string, unknown>;
}

function fakeConnect(
  behavior: {
    cert?: Record<string, unknown>;
    emit?: 'secureConnect' | 'timeout' | 'error';
    error?: Error;
  },
): { connect: () => FakeSocket; lastOptions: unknown } {
  let lastOptions: unknown;
  const connect = (options: unknown) => {
    lastOptions = options;
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      getPeerCertificate: () => behavior.cert ?? {},
    }) as FakeSocket;
    queueMicrotask(() => {
      if (behavior.emit === 'secureConnect') socket.emit('secureConnect');
      else if (behavior.emit === 'timeout') socket.emit('timeout');
      else if (behavior.emit === 'error') socket.emit('error', behavior.error ?? new Error('boom'));
    });
    return socket;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { connect: connect as any, get lastOptions() { return lastOptions; } };
}

describe('tlsHandshake', () => {
  it('returns ok with subject/issuer/daysToExpiry on a clean handshake', async () => {
    const future = new Date('2026-09-01T00:00:00Z');
    const { connect } = fakeConnect({
      emit: 'secureConnect',
      cert: {
        subject: { CN: 'api.example.org' },
        issuer: { O: "Let's Encrypt", CN: 'R3' },
        valid_to: future.toISOString(),
      },
    });
    const r = await tlsHandshake({
      host: 'api.example.org',
      connect,
      now: new Date('2026-06-18T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subject).toBe('api.example.org');
      expect(r.issuer).toBe("Let's Encrypt");
      expect(r.daysToExpiry).toBe(75);
    }
  });

  it('passes host as SNI servername to tls.connect', async () => {
    const f = fakeConnect({
      emit: 'secureConnect',
      cert: {
        subject: { CN: 'api.example.org' },
        issuer: { O: 'Issuer' },
        valid_to: new Date('2030-01-01').toISOString(),
      },
    });
    await tlsHandshake({ host: 'api.example.org', connect: f.connect });
    expect(f.lastOptions).toMatchObject({
      host: 'api.example.org',
      port: 443,
      servername: 'api.example.org',
    });
  });

  it('reports a negative daysToExpiry on an already-expired cert', async () => {
    const { connect } = fakeConnect({
      emit: 'secureConnect',
      cert: {
        subject: { CN: 'old.example.org' },
        issuer: { O: 'X' },
        valid_to: new Date('2026-01-01').toISOString(),
      },
    });
    const r = await tlsHandshake({
      host: 'old.example.org',
      connect,
      now: new Date('2026-06-18T00:00:00Z'),
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.daysToExpiry).toBeLessThan(0);
  });

  it('fails cleanly when the peer presents no certificate', async () => {
    const { connect } = fakeConnect({ emit: 'secureConnect', cert: {} });
    const r = await tlsHandshake({ host: 'x', connect });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no certificate');
  });

  it('reports timeout cleanly', async () => {
    const { connect } = fakeConnect({ emit: 'timeout' });
    const r = await tlsHandshake({ host: 'slow.example.org', connect, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('timed out');
  });

  it('reports socket errors with the underlying message', async () => {
    const { connect } = fakeConnect({ emit: 'error', error: new Error('ECONNREFUSED') });
    const r = await tlsHandshake({ host: 'dead.example.org', connect });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ECONNREFUSED');
  });

  it('converts a synchronous throw from connect() into a failure (review B2)', async () => {
    const connect = (() => {
      throw new Error('bad options');
    }) as unknown as Parameters<typeof tlsHandshake>[0]['connect'];
    const r = await tlsHandshake({ host: 'x', connect });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('tls.connect');
      expect(r.reason).toContain('bad options');
    }
  });

  it('handles an unparseable notAfter without crashing', async () => {
    const { connect } = fakeConnect({
      emit: 'secureConnect',
      cert: {
        subject: { CN: 'x' },
        issuer: { O: 'y' },
        valid_to: 'not a date',
      },
    });
    const r = await tlsHandshake({ host: 'x', connect });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('notAfter');
  });
});
