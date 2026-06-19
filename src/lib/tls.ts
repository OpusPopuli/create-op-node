/**
 * Off-LAN TLS handshake probe. Verify uses this to confirm `api.<domain>`
 * actually negotiates a real, in-date cert from anywhere on the internet
 * before bothering with HTTP probes.
 *
 * We use `tls.connect` rather than just letting fetch do its thing because
 * fetch swallows cert-chain details — we want to surface days-to-expiry so
 * the operator can see "TLS green, but cert expires in 12 days" as a soft
 * warning, not just "fetch failed."
 */

import * as tls from 'node:tls';

import { VERIFY_NETWORK_TIMEOUT_MS } from './constants.js';

export interface TlsHandshakeOk {
  ok: true;
  /** Negotiated subject CN (from the leaf cert). */
  subject: string;
  /** Issuer organization (e.g. "Let's Encrypt"). */
  issuer: string;
  /** Whole days until the leaf cert's `notAfter` field. Negative when the
   *  cert is already expired but the server still happened to return one. */
  daysToExpiry: number;
}

export interface TlsHandshakeFailed {
  ok: false;
  reason: string;
}

export type TlsHandshakeResult = TlsHandshakeOk | TlsHandshakeFailed;

export interface TlsProbeInput {
  host: string;
  port?: number;
  /** Socket-level timeout in milliseconds. Anything that doesn't ALPN/SNI
   *  within this window is reported as a timeout reason, not a hang. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the real `tls.connect`. */
  connect?: typeof tls.connect;
  /** Reference time for daysToExpiry math. Injectable for tests so the
   *  expected value doesn't drift. */
  now?: Date;
}

/** Cert subject/issuer fields can be string or string[] (multi-valued RDNs).
 *  We render the first item for display. */
function first(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * One-shot TLS handshake. Returns the result rather than throwing — the
 * verify wizard wants to fold every failure into a single report.
 */
export function tlsHandshake(input: TlsProbeInput): Promise<TlsHandshakeResult> {
  const host = input.host;
  const port = input.port ?? 443;
  const timeoutMs = input.timeoutMs ?? VERIFY_NETWORK_TIMEOUT_MS;
  const connect = input.connect ?? tls.connect;
  const now = input.now ?? new Date();

  return new Promise<TlsHandshakeResult>((resolve) => {
    let socket: tls.TLSSocket;
    let settled = false;
    const settle = (r: TlsHandshakeResult): void => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(r);
    };

    // `tls.connect` is async by contract, but the injectable `connect` plus
    // certain pathological options (bad servername length, etc.) can throw
    // synchronously. Convert that into a failure result so callers keep
    // seeing the discriminated union instead of a rejection. (review B2)
    try {
      socket = connect({
        host,
        port,
        servername: host,
        timeout: timeoutMs,
      });
    } catch (err) {
      settle({ ok: false, reason: `tls.connect to ${host}:${port} threw: ${(err as Error).message}` });
      return;
    }

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert || Object.keys(cert).length === 0) {
        settle({ ok: false, reason: 'TLS connected but peer presented no certificate' });
        return;
      }
      const notAfter = new Date(cert.valid_to);
      if (Number.isNaN(notAfter.getTime())) {
        settle({ ok: false, reason: `cert presented an unparseable notAfter: ${cert.valid_to}` });
        return;
      }
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysToExpiry = Math.floor((notAfter.getTime() - now.getTime()) / msPerDay);
      const subject = first(cert.subject?.CN) ?? '<no CN>';
      const issuer = first(cert.issuer?.O) ?? first(cert.issuer?.CN) ?? '<no issuer>';
      settle({ ok: true, subject, issuer, daysToExpiry });
    });

    socket.once('timeout', () => {
      settle({ ok: false, reason: `TLS handshake to ${host}:${port} timed out after ${timeoutMs}ms` });
    });

    socket.once('error', (err) => {
      settle({ ok: false, reason: `TLS handshake to ${host}:${port} failed: ${err.message}` });
    });
  });
}
