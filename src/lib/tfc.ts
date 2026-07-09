/**
 * Terraform Cloud (HCP Terraform) API helpers used by `create-op-node init`.
 *
 * We hit a tiny subset of the TFC v2 API directly via native `fetch` — no
 * client library. Three needs:
 *
 *   1. Verify the operator's TFC token is valid and has access to the org
 *      they typed.
 *   2. Resolve a workspace by tag set so we can poll its state for outputs.
 *   3. Fetch the Tunnel token output after `terraform apply` completes.
 *
 * The TFC API responds with JSON:API-shaped documents; helpers below narrow
 * each call to the minimal shape we actually consume.
 */

import { API_REQUEST_TIMEOUT_MS } from './constants.js';

const TFC_API = 'https://app.terraform.io/api/v2';

/** TFC organization slug rules: alphanumerics, underscores, hyphens; the API
 *  doesn't formally publish a max but slugs over 40 chars are rejected in
 *  practice. We validate before any URL interpolation to neutralise typos
 *  that would otherwise hit unintended endpoints (e.g. `?` or `/` in the
 *  slug bouncing us into a different route). */
const ORG_SLUG_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isValidTfcOrgSlug(slug: string): boolean {
  return ORG_SLUG_RE.test(slug);
}

interface TfcAuth {
  token: string;
  organization: string;
}

type Headers = Record<string, string>;

function authHeaders(token: string): Headers {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/vnd.api+json',
  };
}

/**
 * GET a TFC API path as JSON, with a hard per-request timeout.
 *
 * A stalled or half-open connection (native `fetch` has no default timeout)
 * would otherwise hang `init` — including the ~10-minute apply-wait in
 * `polling.ts` — forever. We wrap the call in an `AbortController` and, on
 * any throw (timeout / DNS blip / TLS reset / proxy error), return
 * `{ status: 0, body: null }`. Every caller already treats a non-200 status
 * as a soft failure, so a `0` degrades to `null` / a network-error message
 * instead of rejecting out of the poll loop and crashing the wizard.
 */
async function getJson(
  token: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${TFC_API}${path}`, {
      headers: authHeaders(token),
      signal: ctrl.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body — leave as null */
    }
    return { status: res.status, body };
  } catch {
    // Timeout (AbortError) or any network-layer throw. status 0 = "never got
    // a response" — see the docstring above.
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface TfcProbeResult {
  ok: boolean;
  /** TFC user's display name when the token belongs to a user (`null` when it's a team / org token). */
  userName?: string;
  issues: string[];
}

/**
 * Sanity-check the token + organization at the same time:
 *
 *   - GET /account/details — confirms the token itself is valid.
 *   - GET /organizations/{org} — confirms the org exists AND that the token
 *     has the membership/permissions to see it.
 *
 * Both must pass before we let the wizard proceed; a token that's valid but
 * scoped to a different org would silently fail at the workspace step.
 */
export async function probeTfcToken(input: TfcAuth): Promise<TfcProbeResult> {
  const issues: string[] = [];

  if (!isValidTfcOrgSlug(input.organization)) {
    issues.push(
      `Organization "${input.organization}" isn't a valid TFC slug (letters, digits, hyphens, underscores; up to 40 chars).`,
    );
    return { ok: false, issues };
  }

  const account = await getJson(input.token, '/account/details');
  if (account.status === 0) {
    issues.push(
      "Couldn't reach Terraform Cloud (network error or timeout). Check your connection and retry.",
    );
    return { ok: false, issues };
  }
  if (account.status !== 200) {
    issues.push(
      `TFC token invalid (HTTP ${account.status}). Regenerate at https://app.terraform.io/app/settings/tokens.`,
    );
    return { ok: false, issues };
  }
  const userName = extractUserName(account.body);

  const org = await getJson(
    input.token,
    `/organizations/${encodeURIComponent(input.organization)}`,
  );
  if (org.status === 0) {
    issues.push(
      "Couldn't reach Terraform Cloud while checking the organization (network error or timeout).",
    );
  } else if (org.status === 404) {
    issues.push(
      `TFC organization "${input.organization}" not found, or this token lacks access. Check the org slug at https://app.terraform.io.`,
    );
  } else if (org.status === 401 || org.status === 403) {
    issues.push(
      `TFC token doesn't have permission to access org "${input.organization}".`,
    );
  } else if (org.status !== 200) {
    issues.push(`TFC org probe returned HTTP ${org.status}.`);
  }

  return {
    ok: issues.length === 0,
    issues,
    ...(userName ? { userName } : {}),
  };
}

function extractUserName(body: unknown): string | undefined {
  if (
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    typeof (body as { data: unknown }).data === 'object'
  ) {
    const data = (body as { data: { attributes?: { username?: string } } }).data;
    return data.attributes?.username;
  }
  return undefined;
}

export interface FindWorkspaceInput extends TfcAuth {
  /** Tag set the workspace must carry. For our use case: `['opuspopuli', 'cloudflare']`. */
  tags: string[];
  /** Optional name to disambiguate when multiple workspaces share the tag set. */
  name?: string;
}

export interface TfcWorkspace {
  id: string;
  name: string;
  /** Latest run id, used to poll for apply completion. */
  currentRunId: string | null;
}

/**
 * Find the workspace this region's Terraform code will run in.
 *
 * TFC's filter syntax for tags is `filter[tagged]=tag1,tag2`. We ask for all
 * matches and let the caller pick by `name` when there's ambiguity (one TFC
 * org can host many workspaces with the same tag set).
 */
export async function findWorkspace(input: FindWorkspaceInput): Promise<TfcWorkspace | null> {
  if (!isValidTfcOrgSlug(input.organization)) return null;
  const tagFilter = encodeURIComponent(input.tags.join(','));
  const res = await getJson(
    input.token,
    `/organizations/${encodeURIComponent(input.organization)}/workspaces?filter[tagged]=${tagFilter}&page[size]=100`,
  );
  if (res.status !== 200) return null;

  const items = extractWorkspaceList(res.body);
  if (items.length === 0) return null;

  const match = input.name ? items.find((w) => w.name === input.name) : items[0];
  return match ?? null;
}

interface RawWorkspace {
  id: string;
  attributes?: { name?: string };
  relationships?: { 'current-run'?: { data?: { id?: string } | null } };
}

function extractWorkspaceList(body: unknown): TfcWorkspace[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    !Array.isArray((body as { data: unknown }).data)
  ) {
    return [];
  }
  const data = (body as { data: RawWorkspace[] }).data;
  return data.map((w) => ({
    id: w.id,
    name: w.attributes?.name ?? '',
    currentRunId: w.relationships?.['current-run']?.data?.id ?? null,
  }));
}

export interface TfcRunStatus {
  id: string;
  status: string;
  /** `true` once the run reached a terminal state (applied / errored / canceled / discarded). */
  finished: boolean;
  /** `true` only when the run finished successfully (`applied`). */
  succeeded: boolean;
}

const TERMINAL_STATUSES = new Set([
  'applied',
  'errored',
  'canceled',
  'discarded',
  'policy_soft_failed',
  'force_canceled',
]);

/**
 * Look up a single TFC run by id. Used while we're waiting for the first
 * `terraform apply` to finish.
 */
export async function getRunStatus(
  auth: TfcAuth,
  runId: string,
): Promise<TfcRunStatus | null> {
  // runId comes from a previous TFC response — trusted shape — but
  // encodeURIComponent is cheap defense if it's ever sourced from elsewhere.
  const res = await getJson(auth.token, `/runs/${encodeURIComponent(runId)}`);
  if (res.status !== 200) return null;

  const body = res.body as {
    data?: { id?: string; attributes?: { status?: string } };
  };
  const id = body.data?.id;
  const status = body.data?.attributes?.status;
  if (!id || !status) return null;

  return {
    id,
    status,
    finished: TERMINAL_STATUSES.has(status),
    succeeded: status === 'applied',
  };
}

/**
 * Discriminated result of pulling a named output. The three cases must stay
 * distinct so the poll loop can tell a recoverable transient apart from a
 * genuine absence (#59):
 *
 *   - `value`  — the output is present and usable.
 *   - `absent` — the request succeeded (HTTP 200) but the named output isn't
 *                in the state, or its value isn't a string (e.g. the operator
 *                changed the type). Permanent — retrying won't help.
 *   - `error`  — the HTTP call failed (`getJson` degraded a timeout/blip to
 *                `status: 0`, or a non-200 such as a 404/425 while the state
 *                version is still settling). Retryable.
 */
export type OutputResult =
  | { kind: 'value'; value: string }
  | { kind: 'absent' }
  | { kind: 'error' };

/**
 * Pull a named output value from a workspace's current state version.
 *
 * Caller should poll the matching run for `applied` status first; an
 * in-flight workspace returns a 404 / 425 here, which surfaces as `error`
 * (retryable) rather than `absent` — a network blip on the final fetch must
 * not be misreported as a missing output. See {@link OutputResult}.
 */
export async function fetchOutput(
  auth: TfcAuth,
  workspaceId: string,
  outputName: string,
): Promise<OutputResult> {
  const res = await getJson(
    auth.token,
    `/workspaces/${encodeURIComponent(workspaceId)}/current-state-version-outputs`,
  );
  // status 0 (timeout/network) or any non-200: could be transient (the state
  // version may still be settling right after apply), so let the caller retry.
  if (res.status !== 200) return { kind: 'error' };

  const body = res.body as {
    data?: Array<{ attributes?: { name?: string; value?: unknown; sensitive?: boolean } }>;
  };
  const match = body.data?.find((o) => o.attributes?.name === outputName);
  if (!match) return { kind: 'absent' };

  const value = match.attributes?.value;
  return typeof value === 'string' ? { kind: 'value', value } : { kind: 'absent' };
}
