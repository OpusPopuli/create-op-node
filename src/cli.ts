import { Command } from 'commander';
import pc from 'picocolors';

import { initCommand } from './commands/init.js';
import { bootstrapCommand } from './commands/bootstrap.js';
import { resetCommand } from './commands/reset.js';
import { verifyCommand } from './commands/verify.js';
import { regionCommand } from './commands/region.js';

// Bumped manually; published version comes from package.json.
const VERSION = '0.2.0';

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

// When invoked with no subcommand, default to `init` — the create-* convention
// is that `npx create-op-node` "just works" without specifying a subcommand.
if (process.argv.length === 2) {
  process.argv.push('init');
}

await program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n${pc.red('✗')} ${msg}\n`);
  process.exit(1);
});
