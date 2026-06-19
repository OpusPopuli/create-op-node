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

const TFC_API = 'https://app.terraform.io/api/v2';

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

async function getJson(
  token: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${TFC_API}${path}`, { headers: authHeaders(token) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — leave as null */
  }
  return { status: res.status, body };
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

  const account = await getJson(input.token, '/account/details');
  if (account.status !== 200) {
    issues.push(
      `TFC token invalid (HTTP ${account.status}). Regenerate at https://app.terraform.io/app/settings/tokens.`,
    );
    return { ok: false, issues };
  }
  const userName = extractUserName(account.body);

  const org = await getJson(input.token, `/organizations/${input.organization}`);
  if (org.status === 404) {
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
  const tagFilter = encodeURIComponent(input.tags.join(','));
  const res = await getJson(
    input.token,
    `/organizations/${input.organization}/workspaces?filter[tagged]=${tagFilter}&page[size]=100`,
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
  const res = await getJson(auth.token, `/runs/${runId}`);
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
 * Pull the `tunnel_token` (or any named output) from a workspace's current
 * state version. Returns `null` when the workspace hasn't reached an applied
 * state yet — caller should poll the matching run first.
 */
export async function fetchOutput(
  auth: TfcAuth,
  workspaceId: string,
  outputName: string,
): Promise<string | null> {
  const res = await getJson(
    auth.token,
    `/workspaces/${workspaceId}/current-state-version-outputs`,
  );
  if (res.status !== 200) return null;

  const body = res.body as {
    data?: Array<{ attributes?: { name?: string; value?: unknown; sensitive?: boolean } }>;
  };
  const match = body.data?.find((o) => o.attributes?.name === outputName);
  if (!match) return null;

  const value = match.attributes?.value;
  return typeof value === 'string' ? value : null;
}
