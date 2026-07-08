import { Command } from 'commander';
import pc from 'picocolors';

import { initCommand } from './commands/init.js';
import { bootstrapCommand } from './commands/bootstrap.js';
import { resetCommand } from './commands/reset.js';
import { verifyCommand } from './commands/verify.js';
import { regionCommand } from './commands/region.js';
import { withDefaultSubcommand } from './lib/cli-args.js';

// release-please updates the string in `const VERSION = '...'` on each
// release. See release-please-config.json's extra-files entry that points
// at this file with type: generic — that scanner finds the version string
// in package.json (via the manifest file) and updates literals on lines
// like the one below.
// x-release-please-start-version
const VERSION = '0.11.2';
// x-release-please-end

const program = new Command();

program
  .name('create-op-node')
  .description(
    'Interactive bootstrap for an Opus Populi federation node.\n' +
      'Cloudflare infrastructure → Mac Studio → live public API.',
  )
  .version(VERSION, '-v, --version', 'show version');

program.addCommand(initCommand);
program.addCommand(bootstrapCommand);
program.addCommand(resetCommand);
program.addCommand(verifyCommand);
program.addCommand(regionCommand);

// Default to `init` — the create-* convention is that `npx create-op-node`
// (and `npx create-op-node --region us-ca`) "just work" without naming a
// subcommand. Only skip when the first arg is already a known subcommand or a
// global flag. Known names are derived from the registered commands so the
// list can't drift.
process.argv = withDefaultSubcommand(
  process.argv,
  program.commands.map((c) => c.name()),
);

await program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n${pc.red('✗')} ${msg}\n`);
  process.exit(1);
});
