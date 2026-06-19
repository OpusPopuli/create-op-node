/**
 * GitHub helpers used by `create-op-node init`.
 *
 * Mix of two clients on purpose:
 *
 *   - Octokit (REST) for typed API calls — create-from-template, content
 *     write, PR open. These return well-shaped data we care about (URLs,
 *     SHAs).
 *   - `gh` CLI shell-out for repository secret seeding. Secrets need to be
 *     encrypted with the repo's libsodium public key before PUT — Octokit
 *     doesn't bundle libsodium and the wrapper packages are ~800 KB.
 *     `gh secret set` does the encryption transparently. The operator
 *     already has `gh` (it's part of the runbook), so the dep is free.
 *
 * The Octokit instance is created lazily so a missing token surfaces as a
 * clear error rather than a cryptic auth failure inside a downstream call.
 */

import { Octokit } from '@octokit/rest';

import { safeExeca } from './exec.js';

export interface GhAuth {
  /** A GitHub Personal Access Token (Classic or Fine-grained) with at least
   *  `repo` scope. */
  token: string;
}

// One Octokit per token — fine for a one-shot CLI. NOT safe to wire into a
// long-running service that issues calls under different identities; the
// memoization will hand out the wrong client. If that ever happens, key the
// cache by (token, …other-dimensions) or drop the memoization.
let _client: Octokit | null = null;
let _clientToken: string | null = null;

function client(token: string): Octokit {
  if (_client && _clientToken === token) return _client;
  _client = new Octokit({ auth: token });
  _clientToken = token;
  return _client;
}

// Test-only: reset the memoized client between cases. Not exported via
// index, intentionally — tests reach into the module.
export function _resetClient(): void {
  _client = null;
  _clientToken = null;
}

// ----------------------------------------------------------------------------
// Create from template
// ----------------------------------------------------------------------------

export interface CreateFromTemplateInput extends GhAuth {
  /** `<owner>/<repo>` of the template repo, e.g. `OpusPopuli/opuspopuli-node`. */
  template: string;
  /** The new repo's owner (user or org). */
  owner: string;
  /** The new repo's name. */
  name: string;
  /** Optional repo description. */
  description?: string;
  /** When true, create the repo as private. Default: false (public). */
  private?: boolean;
  /** Include all template branches, not just default. Default: false. */
  includeAllBranches?: boolean;
}

export interface CreatedRepo {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
}

/**
 * Create a new repository from a template repository. Wraps
 * `POST /repos/{template_owner}/{template_repo}/generate`.
 *
 * Caller should handle "repository already exists" as a recoverable case —
 * the operator may have started + abandoned a previous run. We throw on the
 * 422 (already exists) so the caller can show a "use existing? overwrite?"
 * prompt.
 */
export async function createRepoFromTemplate(
  input: CreateFromTemplateInput,
): Promise<CreatedRepo> {
  const [templateOwner, templateRepo] = input.template.split('/');
  if (!templateOwner || !templateRepo) {
    throw new Error(`Bad template spec "${input.template}" — expected <owner>/<repo>`);
  }

  const res = await client(input.token).request(
    'POST /repos/{template_owner}/{template_repo}/generate',
    {
      template_owner: templateOwner,
      template_repo: templateRepo,
      owner: input.owner,
      name: input.name,
      private: input.private ?? false,
      include_all_branches: input.includeAllBranches ?? false,
      ...(input.description ? { description: input.description } : {}),
    },
  );

  return {
    fullName: res.data.full_name,
    htmlUrl: res.data.html_url,
    defaultBranch: res.data.default_branch ?? 'main',
  };
}

// ----------------------------------------------------------------------------
// Seed secrets via gh CLI
// ----------------------------------------------------------------------------

export interface SetRepoSecretInput {
  /** `<owner>/<repo>`. */
  repo: string;
  /** Secret name (e.g. `CLOUDFLARE_API_TOKEN`). */
  name: string;
  /** Secret value. Passed via stdin to `gh secret set` so it never lands in
   *  argv or the shell history. */
  value: string;
}

export interface SetSecretResult {
  written: boolean;
  reason?: string;
}

/**
 * Set a single repository Actions secret via `gh secret set`. Value is piped
 * on stdin — never on argv — so it doesn't land in process listing or any
 * shell history. Returns `written: false` with a clear reason when `gh`
 * isn't installed (B2 — required for the `--gh-token` escape hatch where the
 * operator supplies a PAT and may not have `gh` at all).
 */
export async function setRepoSecret(input: SetRepoSecretInput): Promise<SetSecretResult> {
  const res = await safeExeca(
    'gh',
    ['secret', 'set', input.name, '--repo', input.repo, '--body', '-'],
    { input: input.value },
  );
  if (res === null) {
    return {
      written: false,
      reason: '`gh` CLI not installed — install from https://cli.github.com or seed secrets manually',
    };
  }
  if (res.exitCode !== 0) {
    return {
      written: false,
      reason: `gh secret set failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { written: true };
}

// ----------------------------------------------------------------------------
// Content write + PR open
// ----------------------------------------------------------------------------

export interface CommitFileInput extends GhAuth {
  /** `<owner>/<repo>`. */
  repo: string;
  /** Branch to commit on. The caller creates the branch first via
   *  `createBranch` when committing to a non-default branch. */
  branch: string;
  /** Repo-relative path (e.g. `infra/cloudflare/environments/prod.tfvars`). */
  path: string;
  /** File contents, plain text. We base64-encode for the API. */
  content: string;
  /** Commit message. */
  message: string;
}

export interface CommitFileResult {
  commitSha: string;
  contentSha: string;
}

/**
 * Create or update a file in a repo's branch via the Contents API. Handles
 * both cases transparently — looks up the existing file's SHA when present
 * and includes it in the update.
 */
export async function commitFile(input: CommitFileInput): Promise<CommitFileResult> {
  const [owner, repo] = input.repo.split('/');
  if (!owner || !repo) {
    throw new Error(`Bad repo "${input.repo}" — expected <owner>/<repo>`);
  }

  const octokit = client(input.token);

  let existingSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: input.path,
      ref: input.branch,
    });
    if (!Array.isArray(existing.data) && existing.data.type === 'file') {
      existingSha = existing.data.sha;
    }
  } catch (err: unknown) {
    // 404 is fine — file just doesn't exist yet. Re-throw anything else.
    if (!is404(err)) throw err;
  }

  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: input.path,
    branch: input.branch,
    message: input.message,
    content: Buffer.from(input.content, 'utf8').toString('base64'),
    ...(existingSha ? { sha: existingSha } : {}),
  });

  return {
    commitSha: res.data.commit.sha ?? '',
    contentSha: res.data.content?.sha ?? '',
  };
}

function is404(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === 404
  );
}

export interface CreateBranchInput extends GhAuth {
  repo: string;
  /** Name of the new branch. */
  branch: string;
  /** Name of the branch to fork from. */
  fromBranch: string;
}

/** Create a new branch by copying the head commit of `fromBranch`. */
export async function createBranch(input: CreateBranchInput): Promise<void> {
  const [owner, repo] = input.repo.split('/');
  if (!owner || !repo) {
    throw new Error(`Bad repo "${input.repo}" — expected <owner>/<repo>`);
  }
  const octokit = client(input.token);

  const ref = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${input.fromBranch}`,
  });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${input.branch}`,
    sha: ref.data.object.sha,
  });
}

export interface OpenPrInput extends GhAuth {
  repo: string;
  /** Branch to merge from. */
  head: string;
  /** Branch to merge into. */
  base: string;
  title: string;
  body: string;
}

export interface OpenedPr {
  number: number;
  htmlUrl: string;
}

/** Open a pull request. Returns the PR number + URL so the caller can show
 *  it to the operator. */
export async function openPullRequest(input: OpenPrInput): Promise<OpenedPr> {
  const [owner, repo] = input.repo.split('/');
  if (!owner || !repo) {
    throw new Error(`Bad repo "${input.repo}" — expected <owner>/<repo>`);
  }
  const octokit = client(input.token);

  const res = await octokit.pulls.create({
    owner,
    repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
  });

  return { number: res.data.number, htmlUrl: res.data.html_url };
}
