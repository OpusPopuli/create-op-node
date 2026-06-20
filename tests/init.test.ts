import { describe, expect, it } from 'vitest';

import { listIgnoredLocalOnlyFlags, summarizePhases } from '../src/commands/init.js';

describe('summarizePhases', () => {
  it('runs every phase in production mode (no flag)', () => {
    expect(summarizePhases({})).toEqual({
      cloudflareProbe: true,
      tfcProbe: true,
      seedSecrets: true,
      branchAndPR: true,
      tunnelTokenWait: true,
    });
  });

  it('runs every phase in production mode (localOnly=false explicit)', () => {
    expect(summarizePhases({ localOnly: false })).toEqual({
      cloudflareProbe: true,
      tfcProbe: true,
      seedSecrets: true,
      branchAndPR: true,
      tunnelTokenWait: true,
    });
  });

  it('skips all five phases in --local-only mode', () => {
    expect(summarizePhases({ localOnly: true })).toEqual({
      cloudflareProbe: false,
      tfcProbe: false,
      seedSecrets: false,
      branchAndPR: false,
      tunnelTokenWait: false,
    });
  });
});

describe('listIgnoredLocalOnlyFlags', () => {
  it('returns an empty list when no production-only flags are passed', () => {
    expect(listIgnoredLocalOnlyFlags({})).toEqual([]);
    expect(listIgnoredLocalOnlyFlags({ region: 'us-ca' })).toEqual([]);
  });

  it('names each production-only flag that was passed', () => {
    const result = listIgnoredLocalOnlyFlags({
      domain: 'example.org',
      cfToken: 't',
      cfAccount: 'a',
      cfZone: 'z',
      tfToken: 'tf',
      tfOrg: 'org',
      skipWait: true,
    });
    expect(result).toEqual([
      '--domain',
      '--cf-token',
      '--cf-account',
      '--cf-zone',
      '--tf-token',
      '--tf-org',
      '--skip-wait',
    ]);
  });

  it('names only the flags that were passed', () => {
    expect(listIgnoredLocalOnlyFlags({ cfToken: 'x', tfOrg: 'org' })).toEqual([
      '--cf-token',
      '--tf-org',
    ]);
  });

  it('does NOT flag region/owner/template/yes etc. — those are universal', () => {
    const result = listIgnoredLocalOnlyFlags({
      region: 'us-ca',
      owner: 'OpusPopuli',
      template: 'OpusPopuli/opuspopuli-node',
      ghToken: 'ghp_xyz',
      yes: true,
      overwrite: true,
    });
    expect(result).toEqual([]);
  });

  it('treats skipWait=false as not passed (commander default)', () => {
    expect(listIgnoredLocalOnlyFlags({ skipWait: false })).toEqual([]);
  });
});
