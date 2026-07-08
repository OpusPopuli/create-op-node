import { describe, expect, it } from 'vitest';

import { withDefaultSubcommand } from '../src/lib/cli-args.js';

const KNOWN = ['init', 'bootstrap', 'reset', 'verify', 'region'];
// Full process.argv always starts [node, script, ...].
const base = ['/usr/bin/node', '/path/create-op-node'];

describe('withDefaultSubcommand (#36)', () => {
  it('injects `init` when invoked with no args', () => {
    expect(withDefaultSubcommand([...base], KNOWN)).toEqual([...base, 'init']);
  });

  it('injects `init` before flags when the first arg is not a subcommand', () => {
    expect(withDefaultSubcommand([...base, '--region', 'us-ca'], KNOWN)).toEqual([
      ...base,
      'init',
      '--region',
      'us-ca',
    ]);
  });

  it('leaves a known subcommand untouched', () => {
    for (const cmd of KNOWN) {
      expect(withDefaultSubcommand([...base, cmd, '--foo'], KNOWN)).toEqual([
        ...base,
        cmd,
        '--foo',
      ]);
    }
  });

  it('leaves global flags for commander to handle', () => {
    for (const flag of ['-v', '--version', '-h', '--help']) {
      expect(withDefaultSubcommand([...base, flag], KNOWN)).toEqual([...base, flag]);
    }
  });

  it('does not mutate the input argv', () => {
    const argv = [...base, '--region', 'us-ca'];
    const copy = [...argv];
    withDefaultSubcommand(argv, KNOWN);
    expect(argv).toEqual(copy);
  });
});
