import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

interface VerifyOptions {
  domain?: string;
}

export const verifyCommand = new Command('verify')
  .description(
    'Off-LAN health probe of a live node — TLS, Apollo Federation reachability, GraphQL smoke. ' +
      'Run from anywhere with internet access.',
  )
  .addOption(
    new Option('--domain <domain>', 'Domain to probe (e.g. example.org → checks api.example.org)'),
  )
  .action(async (opts: VerifyOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node verify ')));
    p.note(
      [
        pc.yellow('Stub — coming in v0.0.4.'),
        '',
        opts.domain ? `Will probe api.${opts.domain}.` : 'Will prompt for domain.',
        '',
        'Will check:',
        '  • TLS handshake to api.<domain>',
        '  • GET /health returns 200',
        '  • POST /api with a public introspection query returns valid GraphQL',
        '  • cloudflared registered tunnel connections',
        '  • Cosign signatures on the running images',
      ].join('\n'),
      'Roadmap',
    );
    p.outro(pc.dim('See you next session.'));
  });
