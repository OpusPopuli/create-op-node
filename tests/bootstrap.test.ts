import { describe, expect, it } from 'vitest';

import { resolveComposeFiles } from '../src/commands/bootstrap.js';

describe('resolveComposeFiles', () => {
  it('uses the default compose path when no flag is passed', () => {
    expect(resolveComposeFiles('/Users/op/Development/opuspopuli-node-us-ca', undefined)).toEqual([
      '/Users/op/Development/opuspopuli-node-us-ca/docker-compose-prod.yml',
    ]);
  });

  it('joins relative paths against the repo root', () => {
    expect(
      resolveComposeFiles('/repo', ['docker-compose-prod.yml', 'docker-compose-backup.yml']),
    ).toEqual([
      '/repo/docker-compose-prod.yml',
      '/repo/docker-compose-backup.yml',
    ]);
  });

  it('passes absolute paths through unchanged', () => {
    expect(
      resolveComposeFiles('/repo', ['/etc/some.yml', 'docker-compose-prod.yml']),
    ).toEqual(['/etc/some.yml', '/repo/docker-compose-prod.yml']);
  });

  it('normalizes trailing-slash repo paths via path.join', () => {
    expect(resolveComposeFiles('/repo/', ['x.yml'])).toEqual(['/repo/x.yml']);
  });
});
