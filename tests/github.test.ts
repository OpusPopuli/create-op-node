import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const requestMock = vi.hoisted(() => vi.fn());
const getContentMock = vi.hoisted(() => vi.fn());
const createOrUpdateFileMock = vi.hoisted(() => vi.fn());
const getRefMock = vi.hoisted(() => vi.fn());
const createRefMock = vi.hoisted(() => vi.fn());
const createPullMock = vi.hoisted(() => vi.fn());

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
  })),
}));

import {
  commitFile,
  createBranch,
  createRepoFromTemplate,
  openPullRequest,
  setRepoSecret,
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

describe('setRepoSecret', () => {
  it('pipes the value via stdin to `gh secret set`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const r = await setRepoSecret({
      repo: 'OpusPopuli/opuspopuli-node-us-ca',
      name: 'CLOUDFLARE_API_TOKEN',
      value: 'cfat_secret',
    });

    expect(r.written).toBe(true);
    const call = execaMock.mock.calls[0];
    expect(call).toBeTruthy();
    const [cmd, args, opts] = call as [string, string[], { input: string }];
    expect(cmd).toBe('gh');
    expect(args).toContain('secret');
    expect(args).toContain('set');
    expect(args).toContain('CLOUDFLARE_API_TOKEN');
    expect(args).toContain('--body');
    expect(args).toContain('-');
    // Value MUST go via stdin, never argv.
    expect(args).not.toContain('cfat_secret');
    expect(opts.input).toBe('cfat_secret');
  });

  it('returns a clear reason on gh exit != 0', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: not authenticated',
    });

    const r = await setRepoSecret({ repo: 'a/b', name: 'X', value: 'v' });
    expect(r.written).toBe(false);
    expect(r.reason).toContain('not authenticated');
  });

  it("returns 'gh not installed' cleanly on ENOENT (B2 — supports the --gh-token escape hatch when gh isn't on PATH)", async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);

    const r = await setRepoSecret({ repo: 'a/b', name: 'X', value: 'v' });
    expect(r.written).toBe(false);
    expect(r.reason).toContain('not installed');
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
