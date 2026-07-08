/**
 * GitHub helpers used by `create-op-node init`.
 *
 * Every call goes through Octokit (REST) authenticated with the operator's
 * `--gh-token` PAT — a single identity for the whole flow (create-from-
 * template, content write, PR open, and Actions-secret seeding). Secret
 * seeding uses the `actions.getRepoPublicKey` + `createOrUpdateRepoSecret`
 * endpoints, encrypting the value with the repo's libsodium public key
 * (`crypto_box_seal`) before PUT, per GitHub's API contract.
 *
 * The Octokit instance is created lazily so a missing token surfaces as a
 * clear error rather than a cryptic auth failure inside a downstream call.
 */

import { Octokit } from '@octokit/rest';
import _sodium from 'libsodium-wrappers';

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

export interface SetRepoSecretsInput {
  /** PAT used for the whole `init` flow — needs Actions Secrets: write
   *  (fine-grained) or `repo` scope (classic). */
  token: string;
  /** `<owner>/<repo>`. */
  repo: string;
  /** Secrets to seed, in order. Values are encrypted with the repo public key
   *  before they leave the process — plaintext never lands in argv or on the
   *  wire. */
  secrets: ReadonlyArray<{ name: string; value: string }>;
}

export interface SetRepoSecretsResult {
  /** Secret names successfully written, in order. */
  seeded: string[];
  /** Set when a secret failed; seeding stops at the first failure (so `seeded`
   *  is the prefix that succeeded and the rest are pending). */
  failed?: { name: string; reason: string };
}

function parseRepoSlug(repo: string): { owner: string; repo: string } | null {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1 || repo.indexOf('/', slash + 1) !== -1) return null;
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) };
}

/**
 * Seed repository Actions secrets via the GitHub API, authenticated with the
 * operator's PAT (single identity for the whole flow — no `gh` CLI / ambient
 * auth). GitHub requires each value to be sealed-box encrypted with the repo's
 * public key (`crypto_box_seal`); we fetch that key **once** and reuse it for
 * every secret. `createOrUpdateRepoSecret` is idempotent, so a re-run
 * overwrites cleanly. Stops at the first failure and reports what was seeded.
 */
export async function setRepoSecrets(input: SetRepoSecretsInput): Promise<SetRepoSecretsResult> {
  const firstName = input.secrets[0]?.name ?? '(none)';
  const parsed = parseRepoSlug(input.repo);
  if (!parsed) {
    return {
      seeded: [],
      failed: { name: firstName, reason: `invalid repo "${input.repo}" (expected <owner>/<repo>)` },
    };
  }
  const { owner, repo } = parsed;
  const octokit = client(input.token);

  let key: Awaited<ReturnType<typeof octokit.actions.getRepoPublicKey>>;
  try {
    key = await octokit.actions.getRepoPublicKey({ owner, repo });
  } catch (err) {
    return {
      seeded: [],
      failed: { name: firstName, reason: `fetching the repo public key failed: ${(err as Error).message}` },
    };
  }

  await _sodium.ready;
  const sodium = _sodium;
  const publicKey = sodium.from_base64(key.data.key, sodium.base64_variants.ORIGINAL);

  const seeded: string[] = [];
  for (const s of input.secrets) {
    const encrypted_value = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(s.value), publicKey),
      sodium.base64_variants.ORIGINAL,
    );
    try {
      await octokit.actions.createOrUpdateRepoSecret({
        owner,
        repo,
        secret_name: s.name,
        encrypted_value,
        key_id: key.data.key_id,
      });
    } catch (err) {
      return { seeded, failed: { name: s.name, reason: `setting secret ${s.name} failed: ${(err as Error).message}` } };
    }
    seeded.push(s.name);
  }
  return { seeded };
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
