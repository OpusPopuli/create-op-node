/**
 * HTTP probes for `verify`. Two helpers:
 *
 *   - `httpProbe`      — GET against a URL, return status + truncated body.
 *                        Used for the `/health` endpoint check.
 *   - `graphqlProbe`   — POST `{ query: "{ __typename }" }`, parse the
 *                        envelope, confirm it looks like a GraphQL response
 *                        rather than (say) an HTML error page from the proxy.
 *
 * Both swallow network errors into a `{ ok: false, reason }` so the verify
 * wizard reports them as a phase failure instead of crashing.
 */

import { BODY_PREVIEW_MAX, VERIFY_NETWORK_TIMEOUT_MS } from './constants.js';

/** Spec-preferred GraphQL response media type. Apollo Gateway accepts plain
 *  `application/json` too, but stricter or future implementations may not —
 *  send both. (graphql-over-http spec) */
const GRAPHQL_ACCEPT = 'application/graphql-response+json, application/json';

/** Slice cap when reading a response body for diagnostics. Streaming would
 *  let us bail at this byte count too; for now we read the whole text and
 *  cap on display, which is fine for the small bodies these endpoints
 *  return. If a pathological server returns gigabytes, the AbortController
 *  will fire first. */
async function readBodyCapped(res: Response): Promise<string> {
  const text = await res.text();
  return text.slice(0, BODY_PREVIEW_MAX);
}

export interface HttpProbeOk {
  ok: true;
  status: number;
  /** First N chars of the response body — useful for surface-level diagnostics
   *  ("got HTML when expecting JSON"). Capped at BODY_PREVIEW_MAX. */
  bodyPreview: string;
}

export interface HttpProbeFailed {
  ok: false;
  reason: string;
  /** Set when we got a response back but the status was unexpected; the
   *  wizard renders this in the failure block. */
  status?: number;
}

export type HttpProbeResult = HttpProbeOk | HttpProbeFailed;

export interface HttpProbeInput {
  url: string;
  /** Default 200. Set to e.g. 204 if you're probing a no-content endpoint. */
  expectedStatus?: number;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function httpProbe(input: HttpProbeInput): Promise<HttpProbeResult> {
  const expected = input.expectedStatus ?? 200;
  const timeoutMs = input.timeoutMs ?? VERIFY_NETWORK_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(input.url, { method: 'GET', signal: ctrl.signal });
    const bodyPreview = await readBodyCapped(res);
    if (res.status !== expected) {
      // (review N5) Surface the body on a status mismatch the same way
      // graphqlProbe does, so the operator can see the actual error page.
      return {
        ok: false,
        status: res.status,
        reason: bodyPreview
          ? `expected HTTP ${expected}, got ${res.status}: ${bodyPreview}`
          : `expected HTTP ${expected}, got ${res.status}`,
      };
    }
    return { ok: true, status: res.status, bodyPreview };
  } catch (err) {
    const reason =
      (err as Error).name === 'AbortError'
        ? `GET ${input.url} timed out after ${timeoutMs}ms`
        : `GET ${input.url} failed: ${(err as Error).message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export interface GraphqlProbeOk {
  ok: true;
  /** The value of `data.__typename` from the response envelope. Usually
   *  "Query" on a healthy Apollo Gateway. */
  typename: string;
}

export interface GraphqlProbeFailed {
  ok: false;
  reason: string;
  status?: number;
}

export type GraphqlProbeResult = GraphqlProbeOk | GraphqlProbeFailed;

export interface GraphqlProbeInput {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * POST `{ "query": "{ __typename }" }` and confirm the envelope shape. Apollo
 * Federation gateways respond with `{ data: { __typename: "Query" } }` for
 * this; a misconfigured proxy or a 404 from a wrong path returns HTML or a
 * JSON error envelope that we surface as a failure reason.
 */
export async function graphqlProbe(input: GraphqlProbeInput): Promise<GraphqlProbeResult> {
  const timeoutMs = input.timeoutMs ?? VERIFY_NETWORK_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(input.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: GRAPHQL_ACCEPT },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: ctrl.signal,
    });
    const text = await readBodyCapped(res);
    if (res.status !== 200) {
      return {
        ok: false,
        status: res.status,
        reason: `expected HTTP 200, got ${res.status}: ${text}`,
      };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        reason: `response was not JSON: ${text}`,
      };
    }
    const data = (envelope as { data?: { __typename?: unknown } }).data;
    const typename = data?.__typename;
    if (typeof typename !== 'string') {
      return {
        ok: false,
        status: res.status,
        reason: `response missing { data: { __typename: string } }: ${text}`,
      };
    }
    return { ok: true, typename };
  } catch (err) {
    const reason =
      (err as Error).name === 'AbortError'
        ? `POST ${input.url} timed out after ${timeoutMs}ms`
        : `POST ${input.url} failed: ${(err as Error).message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
