import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const requestMock = vi.hoisted(() => vi.fn());
const getContentMock = vi.hoisted(() => vi.fn());
const createOrUpdateFileMock = vi.hoisted(() => vi.fn());
const getRefMock = vi.hoisted(() => vi.fn());
const createRefMock = vi.hoisted(() => vi.fn());
const createPullMock = vi.hoisted(() => vi.fn());
const getRepoPublicKeyMock = vi.hoisted(() => vi.fn());
const createOrUpdateSecretMock = vi.hoisted(() => vi.fn());

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    request: requestMock,
    repos: {
      getContent: getContentMock,
      createOrUpdateFileContents: createOrUpdateFileMock,
    },
    git: {
      getRef: getRefMock,
      createRef: createRefMock,
    },
    pulls: {
      create: createPullMock,
    },
    actions: {
      getRepoPublicKey: getRepoPublicKeyMock,
      createOrUpdateRepoSecret: createOrUpdateSecretMock,
    },
  })),
}));

import _sodium from 'libsodium-wrappers';

import {
  commitFile,
  createBranch,
  createRepoFromTemplate,
  openPullRequest,
  setRepoSecrets,
  _resetClient,
} from '../src/lib/github.js';

beforeEach(() => {
  _resetClient();
  execaMock.mockReset();
  requestMock.mockReset();
  getContentMock.mockReset();
  createOrUpdateFileMock.mockReset();
  getRefMock.mockReset();
  createRefMock.mockReset();
  createPullMock.mockReset();
  getRepoPublicKeyMock.mockReset();
  createOrUpdateSecretMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRepoFromTemplate', () => {
  it('hits POST /repos/{template_owner}/{template_repo}/generate with the inputs', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        full_name: 'OpusPopuli/opuspopuli-node-us-ca',
        html_url: 'https://github.com/OpusPopuli/opuspopuli-node-us-ca',
        default_branch: 'main',
      },
    });

    const r = await createRepoFromTemplate({
      token: 'gh_x',
      template: 'OpusPopuli/opuspopuli-node',
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      description: 'CA region',
    });

    expect(r).toEqual({
      fullName: 'OpusPopuli/opuspopuli-node-us-ca',
      htmlUrl: 'https://github.com/OpusPopuli/opuspopuli-node-us-ca',
      defaultBranch: 'main',
    });
    expect(requestMock).toHaveBeenCalledWith(
      'POST /repos/{template_owner}/{template_repo}/generate',
      expect.objectContaining({
        template_owner: 'OpusPopuli',
        template_repo: 'opuspopuli-node',
        owner: 'OpusPopuli',
        name: 'opuspopuli-node-us-ca',
        private: false,
      }),
    );
  });

  it('throws on a malformed template spec', async () => {
    await expect(
      createRepoFromTemplate({
        token: 'x',
        template: 'no-slash',
        owner: 'OpusPopuli',
        name: 'foo',
      }),
    ).rejects.toThrow(/expected <owner>\/<repo>/);
  });
});

describe('setRepoSecrets', () => {
  async function freshRepoKeypair() {
    await _sodium.ready;
    const kp = _sodium.crypto_box_keypair();
    const key = _sodium.to_base64(kp.publicKey, _sodium.base64_variants.ORIGINAL);
    return { kp, key };
  }

  function decrypt(kp: { publicKey: Uint8Array; privateKey: Uint8Array }, b64: string): string {
    return _sodium.to_string(
      _sodium.crypto_box_seal_open(
        _sodium.from_base64(b64, _sodium.base64_variants.ORIGINAL),
        kp.publicKey,
        kp.privateKey,
      ),
    );
  }

  it('fetches the repo public key once and seals every secret under the PAT', async () => {
    const { kp, key } = await freshRepoKeypair();
    getRepoPublicKeyMock.mockResolvedValueOnce({ data: { key, key_id: 'kid-1' } });
    createOrUpdateSecretMock.mockResolvedValue({ status: 201 });

    const r = await setRepoSecrets({
      token: 'pat-xyz',
      repo: 'OpusPopuli/opuspopuli-node-us-ca',
      secrets: [
        { name: 'CLOUDFLARE_API_TOKEN', value: 'cfat_secret' },
        { name: 'TF_API_TOKEN', value: 'tf_secret' },
      ],
    });

    expect(r).toEqual({ seeded: ['CLOUDFLARE_API_TOKEN', 'TF_API_TOKEN'] });
    // Key fetched ONCE for both secrets; no shell-out.
    expect(getRepoPublicKeyMock).toHaveBeenCalledTimes(1);
    expect(getRepoPublicKeyMock).toHaveBeenCalledWith({
      owner: 'OpusPopuli',
      repo: 'opuspopuli-node-us-ca',
    });
    expect(execaMock).not.toHaveBeenCalled();
    expect(createOrUpdateSecretMock).toHaveBeenCalledTimes(2);

    // Each ciphertext round-trips back to its plaintext (valid, decryptable, and
    // the plaintext never appears in the payload).
    const [put1, put2] = createOrUpdateSecretMock.mock.calls.map(
      (c) => c[0] as { secret_name: string; encrypted_value: string; key_id: string },
    );
    expect(put1!.key_id).toBe('kid-1');
    expect(put1!.encrypted_value).not.toContain('cfat_secret');
    expect(decrypt(kp, put1!.encrypted_value)).toBe('cfat_secret');
    expect(decrypt(kp, put2!.encrypted_value)).toBe('tf_secret');
  });

  it('reports the public-key fetch failure without attempting any PUT', async () => {
    getRepoPublicKeyMock.mockRejectedValueOnce(new Error('403 Forbidden'));
    const r = await setRepoSecrets({
      token: 'pat',
      repo: 'a/b',
      secrets: [{ name: 'X', value: 'v' }],
    });
    expect(r.seeded).toEqual([]);
    expect(r.failed?.reason).toContain('403');
    expect(createOrUpdateSecretMock).not.toHaveBeenCalled();
  });

  it('stops at the first PUT failure and reports what was seeded', async () => {
    const { key } = await freshRepoKeypair();
    getRepoPublicKeyMock.mockResolvedValueOnce({ data: { key, key_id: 'k' } });
    createOrUpdateSecretMock
      .mockResolvedValueOnce({ status: 201 }) // first succeeds
      .mockRejectedValueOnce(new Error('422 Unprocessable')); // second fails

    const r = await setRepoSecrets({
      token: 'pat',
      repo: 'a/b',
      secrets: [
        { name: 'FIRST', value: 'v1' },
        { name: 'SECOND', value: 'v2' },
        { name: 'THIRD', value: 'v3' },
      ],
    });
    expect(r.seeded).toEqual(['FIRST']);
    expect(r.failed).toMatchObject({ name: 'SECOND' });
    expect(r.failed?.reason).toContain('422');
    // Stopped — THIRD never attempted; key still fetched once.
    expect(createOrUpdateSecretMock).toHaveBeenCalledTimes(2);
    expect(getRepoPublicKeyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed repo slug before hitting the API', async () => {
    const r = await setRepoSecrets({
      token: 'pat',
      repo: 'no-slash',
      secrets: [{ name: 'X', value: 'v' }],
    });
    expect(r.seeded).toEqual([]);
    expect(r.failed?.reason).toContain('expected <owner>/<repo>');
    expect(getRepoPublicKeyMock).not.toHaveBeenCalled();
  });
});

describe('commitFile', () => {
  it('creates a new file when no SHA exists at the path', async () => {
    getContentMock.mockRejectedValueOnce({ status: 404 });
    createOrUpdateFileMock.mockResolvedValueOnce({
      data: {
        commit: { sha: 'commit-sha-1' },
        content: { sha: 'content-sha-1' },
      },
    });

    const r = await commitFile({
      token: 'x',
      repo: 'a/b',
      branch: 'main',
      path: 'foo.txt',
      content: 'hi',
      message: 'add foo',
    });

    expect(r).toEqual({ commitSha: 'commit-sha-1', contentSha: 'content-sha-1' });
    expect(createOrUpdateFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'foo.txt',
        branch: 'main',
        content: Buffer.from('hi', 'utf8').toString('base64'),
      }),
    );
    expect(createOrUpdateFileMock.mock.calls[0]?.[0]).not.toHaveProperty('sha');
  });

  it('updates an existing file by passing its sha', async () => {
    getContentMock.mockResolvedValueOnce({
      data: { type: 'file', sha: 'existing-sha' },
    });
    createOrUpdateFileMock.mockResolvedValueOnce({
      data: {
        commit: { sha: 'commit-sha-2' },
        content: { sha: 'content-sha-2' },
      },
    });

    await commitFile({
      token: 'x',
      repo: 'a/b',
      branch: 'main',
      path: 'foo.txt',
      content: 'updated',
      message: 'update foo',
    });

    expect(createOrUpdateFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'existing-sha' }),
    );
  });

  it('re-throws non-404 errors from getContent', async () => {
    getContentMock.mockRejectedValueOnce({ status: 500, message: 'server error' });

    await expect(
      commitFile({
        token: 'x',
        repo: 'a/b',
        branch: 'main',
        path: 'foo.txt',
        content: 'hi',
        message: 'msg',
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('createBranch', () => {
  it('copies the SHA of the source branch into a new refs/heads/<name>', async () => {
    getRefMock.mockResolvedValueOnce({ data: { object: { sha: 'head-sha' } } });
    createRefMock.mockResolvedValueOnce({ data: {} });

    await createBranch({
      token: 'x',
      repo: 'a/b',
      branch: 'init/setup',
      fromBranch: 'main',
    });

    expect(getRefMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main' }),
    );
    expect(createRefMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/init/setup', sha: 'head-sha' }),
    );
  });
});

describe('openPullRequest', () => {
  it('returns the PR number + URL', async () => {
    createPullMock.mockResolvedValueOnce({
      data: { number: 42, html_url: 'https://github.com/a/b/pull/42' },
    });

    const r = await openPullRequest({
      token: 'x',
      repo: 'a/b',
      head: 'init/setup',
      base: 'main',
      title: 't',
      body: 'b',
    });

    expect(r).toEqual({ number: 42, htmlUrl: 'https://github.com/a/b/pull/42' });
  });
});
