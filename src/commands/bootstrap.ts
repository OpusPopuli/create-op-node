import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export const bootstrapCommand = new Command('bootstrap')
  .description(
    'Configure the Mac Studio and bring the stack up. ' +
      'Run this on the Studio itself, after `init` has finished on your laptop.',
  )
  .action(async () => {
    p.intro(pc.bgCyan(pc.black(' create-op-node bootstrap ')));
    p.note(
      [
        pc.yellow('Stub — coming in v0.0.3.'),
        '',
        'Will run:',
        '  • macOS sanity checks (auto-restart, FileVault off, disk-sleep off)',
        '  • Homebrew install (if missing) + brew install git gh pnpm jq cloudflared rclone ollama',
        '  • Docker Desktop install + GUI config prompts',
        '  • `gh auth login` (browser flow)',
        '  • `tailscale up` (browser flow)',
        '  • Clone the node repo created by `init`',
        '  • Materialize pgsodium key (from 1Password via `op`, or paste)',
        '  • Write LaunchAgent plist + load it',
        '  • Login to ghcr.io',
        '  • `ollama pull qwen3.5:9b` (+ embeddings)',
        '  • `docker compose -f docker-compose-prod.yml pull && up -d`',
        '  • Health-check loop until all 10 containers report (healthy)',
      ].join('\n'),
      'Roadmap',
    );
    p.outro(pc.dim('See you next session.'));
  });
