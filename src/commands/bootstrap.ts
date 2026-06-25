import { join } from 'node:path';

import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  PGSODIUM_KEY_RE,
  SAFE_LAUNCHCTL_VALUE_RE,
  SAFE_URL_RE,
  TUNNEL_TOKEN_RE,
  URL_SAFE_PASSWORD_RE,
} from '../lib/constants.js';
import {
  detectBrew,
  HOMEBREW_INSTALL_COMMAND,
  installPackages,
  STUDIO_PACKAGES,
} from '../lib/homebrew.js';
import {
  detectUnifiedMemoryGB,
  disableDiskSleep,
  enableAutoRestartOnPowerFailure,
  inspectSystem,
} from '../lib/macos.js';
import {
  detectKeychain,
  isKeychainLocked,
  isSshSession,
  readSecret,
  saveSecret,
  unlockKeychain,
  type SecretAccount,
} from '../lib/keychain.js';
import {
  generateDashboardPassword,
  generateHmacApiKey,
  generateJwtSecret,
  generatePgsodiumRootKey,
  generatePostgresPassword,
  signSupabaseJwt,
  verifySupabaseJwt,
} from '../lib/secrets.js';
import { setupLaunchAgent } from '../lib/launchagent.js';
import { installOpComposeWrapper } from '../lib/op-compose-install.js';
import {
  composePull,
  composeRemoveService,
  composeUp,
  loginToGhcr,
  waitForHealthy,
} from '../lib/docker.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_LLM_MODEL,
  checkOllamaHealth,
  probeHostDockerInternal,
  setupModels,
  startOllamaService,
} from '../lib/ollama.js';
import { locateOrCloneRepo, type LocateOutcome } from '../lib/noderepo.js';
import { safeExeca } from '../lib/exec.js';
import { unwrap } from '../lib/prompts.js';

/** Compose profile set used in production mode — activates cloudflared. */
const PUBLIC_PROFILES = ['public'] as const;
/** Compose profile set used in --local-only mode — keeps cloudflared down
 *  via the template's profile gating. */
const LOCAL_PROFILES = [] as const;

/** Node deployment topology — selects which docker compose stack(s) +
 *  Keychain entries bootstrap provisions.
 *
 *  - `region` — standard region node (civic data for one region). Connects
 *    to a REMOTE prompt-service via PROMPT_SERVICE_URL. The HMAC key for
 *    that remote service is issued by the prompts team and pasted in;
 *    bootstrap stores it under the same Keychain account as the colocated
 *    case so the wrapper exports it transparently. This is the production
 *    default for any operator who isn't on the prompts team.
 *
 *  - `region-with-prompts` — region node + colocated prompt-service overlay
 *    (the us-ca / team / dev case). Bootstrap generates a local HMAC key,
 *    a prompt-service admin key, and a prompts-db password — all stored
 *    in Keychain — and the op-compose wrapper exports them so the
 *    `docker-compose-prompt-service.yml` overlay can layer on top.
 *
 *  - `prompts-only` — STUB. Reserved for when the prompts team deploys the
 *    central prompts.opuspopuli.org instance. No region services; only the
 *    prompt-service + its DB. Bootstrap currently exits with a "not yet
 *    implemented" message — the flag exists so the CLI surface is stable
 *    for the future deployment.
 */
type NodeType = 'region' | 'region-with-prompts' | 'prompts-only';

interface BootstrapOptions {
  region?: string;
  owner?: string;
  repoDir?: string;
  composeFile?: string[];
  envFile?: string;
  skipBrew?: boolean;
  skipLaunchAgent?: boolean;
  skipOllama?: boolean;
  skipStack?: boolean;
  localOnly?: boolean;
  llmModel?: string;
  embeddingModel?: string;
  /** Public-facing Supabase URL. Defaults to `http://localhost:8000` in
   *  --local-only mode, otherwise `https://supabase.<domain>` — operator
   *  can override with --supabase-url. */
  supabaseUrl?: string;
  /** Selects which deployment stack to provision. Defaults to `region`. */
  nodeType?: NodeType;
  /** For `--node-type region` (remote prompt-service): the URL of the
   *  central prompt-service the backend should call. Defaults to
   *  `https://prompts.opuspopuli.org`. Ignored in `region-with-prompts`
   *  (the overlay pins it to the in-network hostname). */
  promptServiceUrl?: string;
  yes?: boolean;
}

export const bootstrapCommand = new Command('bootstrap')
  .description(
    'Configure the Mac Studio and bring the stack up. Run this on the Studio itself, after `init` has finished on your laptop.',
  )
  .addOption(new Option('--region <slug>', 'Region label set during init (e.g. us-ca)'))
  .addOption(new Option('--owner <owner>', 'GitHub owner for the node repo').default('OpusPopuli'))
  .addOption(new Option('--repo-dir <path>', 'Explicit path to a checked-out node repo (overrides cwd + clone)'))
  .addOption(
    new Option(
      '--compose-file <path>',
      'Repeatable. Compose file relative to repo root. Default: prod + backup (production), prod only (--local-only).',
    ),
  )
  .addOption(new Option('--env-file <path>', 'Compose --env-file. Default: .env.production'))
  .addOption(new Option('--skip-brew', "Skip the Homebrew package install pass").default(false))
  .addOption(
    new Option(
      '--skip-launch-agent',
      "Skip the LaunchAgent setup (assumes one is already in place)",
    ).default(false),
  )
  .addOption(new Option('--skip-ollama', "Skip the Ollama model pull + warm").default(false))
  .addOption(
    new Option(
      '--llm-model <model>',
      `Ollama LLM model to pull and warm. Default: ${DEFAULT_LLM_MODEL}. Examples: \`llama3.3:70b\`, \`qwen2.5:72b\`. Memory sizing table: docs/docker-resources.md in the opuspopuli-node template (or your region repo's checkout).`,
    ),
  )
  .addOption(
    new Option(
      '--embedding-model <model>',
      `Ollama embedding model. Default: ${DEFAULT_EMBEDDING_MODEL}. Only takes effect when the knowledge service runs with EMBEDDINGS_PROVIDER=ollama (otherwise embeddings are computed in-process via xenova).`,
    ),
  )
  .addOption(
    new Option(
      '--supabase-url <url>',
      'Public-facing Supabase URL (what browsers + microservices use). Default: `http://localhost:8000` in --local-only mode, otherwise `https://supabase.<domain>` (which the operator can override).',
    ),
  )
  .addOption(
    new Option(
      '--node-type <type>',
      'Deployment topology. `region` (default) = region node connecting to remote prompt-service. `region-with-prompts` = region node + colocated prompt-service overlay (team/dev use). `prompts-only` = future stub for the central prompts deployment.',
    ).choices(['region', 'region-with-prompts', 'prompts-only']),
  )
  .addOption(
    new Option(
      '--prompt-service-url <url>',
      "Remote prompt-service URL. Only meaningful for --node-type=region (default: https://prompts.opuspopuli.org). Ignored for --node-type=region-with-prompts (the overlay pins it to http://opuspopuli-prompts:3210).",
    ),
  )
  .addOption(new Option('--skip-stack', "Stop before `docker compose pull && up`").default(false))
  .addOption(
    new Option(
      '--local-only',
      "Run for local dev / testing: no Tunnel token required, cloudflared stays down. Auto-generates the pgsodium key if not in Keychain (init unnecessary).",
    ).default(false),
  )
  .addOption(new Option('-y, --yes', 'Skip confirmation prompts').default(false))
  .action(async (opts: BootstrapOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node bootstrap ')));

    // ---- Node type (selects which stack to provision) ----
    // Default is `region` — the common case for any operator who isn't
    // on the prompts team. `region-with-prompts` covers the team/dev case
    // where the operator runs prompt-service alongside the region stack.
    // `prompts-only` is a documented stub for the future central prompts
    // deployment — exits early to keep the CLI surface stable now.
    const nodeType: NodeType = opts.nodeType
      ? opts.nodeType
      : (unwrap(
          await p.select({
            message: 'What kind of node are you provisioning?',
            options: [
              {
                value: 'region',
                label: 'Region node (civic data for one region, remote prompt-service)',
              },
              {
                value: 'region-with-prompts',
                label: 'Region + colocated prompt-service (team / dev)',
              },
              {
                value: 'prompts-only',
                label: 'Prompt-service node (central prompts deployment — future)',
              },
            ],
            initialValue: 'region',
          }),
        ) as NodeType);

    if (nodeType === 'prompts-only') {
      p.cancel(
        'prompts-only node deployment is not yet implemented. ' +
          'This flag exists so the CLI surface is stable for when the prompts team ' +
          'deploys the central prompts.opuspopuli.org instance — but the deployment ' +
          'stack (compose file, healthchecks, observability) is filled in later, ' +
          'when there is an actual central prompt-service to deploy.',
      );
      process.exit(1);
    }

    // ---- Region label (required to find Keychain items + repo name) ------
    const region = opts.region
      ? opts.region
      : unwrap(
          await p.text({
            message: 'Region label (the slug used during init — e.g. us-ca)?',
            placeholder: 'us-ca',
            validate: (v) =>
              /^[a-z0-9-]{2,32}$/.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens; 2–32 chars',
          }),
        );

    const owner = opts.owner ?? 'OpusPopuli';
    const repoName = `opuspopuli-node-${region}`;

    // Default compose file set by mode (review S4): production runs the
    // backup stack (restic / rclone) alongside the main stack; local-only
    // skips it (don't burn dev-machine disk on backups; don't try to push
    // to an R2 bucket that may not exist). Operator can still override
    // with explicit --compose-file flags.
    const composeFileDefault = opts.localOnly
      ? ['docker-compose-prod.yml']
      : ['docker-compose-prod.yml', 'docker-compose-backup.yml'];
    const composeFile = opts.composeFile ?? composeFileDefault;

    // Model selection: flags override > interactive prompt > defaults.
    // The resolved values flow to both Ollama (pull + warm) and the
    // LaunchAgent (LLM_MODEL / EMBEDDINGS_MODEL env vars Docker Desktop
    // inherits).
    //
    // Note: the LaunchAgent ALWAYS exports both env vars now that they
    // default — bootstrap is the source of truth for what model runs.
    // The absence of a flag doesn't fall through to a compose default;
    // it falls through to the CLI's default. (N3)
    const llmModelChoice = opts.llmModel ?? (await selectLlmModel(opts));
    const [embeddingModel, llmModel] = resolveModels({
      llmModel: llmModelChoice,
      ...(opts.embeddingModel !== undefined ? { embeddingModel: opts.embeddingModel } : {}),
    });

    // ---- Phase 1: macOS sanity ----
    const sysSpin = p.spinner();
    sysSpin.start('Inspecting macOS…');
    const snap = await inspectSystem();
    sysSpin.stop(pc.green('✓ macOS inspected.'));

    if (!snap.isAppleSilicon) {
      p.cancel(
        `Bootstrap requires an Apple Silicon Mac (the runbook targets M-series). Detected: ${snap.osVersion ?? 'unknown'} (uname -m != arm64).`,
      );
      process.exit(1);
    }

    p.note(
      [
        `Hostname:                 ${pc.cyan(snap.hostname)}`,
        `macOS:                    ${pc.cyan(snap.osVersion ?? '(sw_vers failed)')}`,
        `Auto-restart on power:    ${kvBool(snap.autoRestartOnPowerFailure)}`,
        `Disk sleep disabled:      ${kvBool(snap.diskSleepDisabled)}`,
        `FileVault:                ${kvFileVault(snap.fileVaultEnabled)}`,
      ].join('\n'),
      'System snapshot',
    );

    if (!snap.autoRestartOnPowerFailure) {
      const fix = unwrap(
        await p.confirm({
          message: 'Auto-restart-on-power-failure is OFF. Enable now (requires sudo)?',
          initialValue: true,
        }),
      );
      if (fix) {
        const r = await enableAutoRestartOnPowerFailure();
        if (!r.ok) p.note(`${pc.red('✗')} ${r.reason}`, 'pmset failed');
      }
    }
    if (!snap.diskSleepDisabled) {
      const fix = unwrap(
        await p.confirm({
          message: 'Disk sleep is enabled. Disable now (requires sudo)?',
          initialValue: true,
        }),
      );
      if (fix) {
        const r = await disableDiskSleep();
        if (!r.ok) p.note(`${pc.red('✗')} ${r.reason}`, 'pmset failed');
      }
    }

    // ---- Phase 2: Homebrew + tool installs ----
    if (!opts.skipBrew) {
      const brewInfo = await detectBrew();
      if (!brewInfo.installed) {
        p.note(
          [
            `Homebrew is not installed. Open another shell and run:`,
            '',
            pc.cyan(HOMEBREW_INSTALL_COMMAND),
            '',
            pc.dim('Then come back and press Enter.'),
          ].join('\n'),
          'Manual step',
        );
        unwrap(await p.confirm({ message: 'Homebrew installed?', initialValue: true }));
      }

      const brewSpin = p.spinner();
      brewSpin.start('Installing Studio packages… (~5–15 min first run)');
      const report = await installPackages(STUDIO_PACKAGES, (pkg, status) => {
        brewSpin.message(`${status}: ${pkg.name}`);
      });
      brewSpin.stop(
        report.failed.length === 0
          ? pc.green(
              `✓ ${report.installed.length} installed, ${report.alreadyPresent.length} already present`,
            )
          : pc.yellow(
              `⚠ ${report.installed.length} installed, ${report.alreadyPresent.length} present, ${report.failed.length} failed`,
            ),
      );
      if (report.failed.length > 0) {
        p.note(
          [
            report.failed.map((f) => `${pc.red('•')} ${f.pkg.name}: ${f.reason}`).join('\n'),
            '',
            pc.dim('A partial install usually fails downstream (Docker / Ollama / compose).'),
            pc.dim('Install the failed packages manually and re-run with --skip-brew.'),
          ].join('\n'),
          'Brew failures',
        );
        const cont = unwrap(
          await p.confirm({
            message: 'Continue anyway? (Default no — recommended to fix and re-run.)',
            initialValue: false,
          }),
        );
        if (!cont) process.exit(1);
      }
    }

    // ---- Phase 3: GitHub + Tailscale auth ----
    await ensureGhAuth();
    await promptTailscaleSignin();

    // ---- Phase 4: Locate / clone the region repo (fail-fast — S6 review fix) ----
    // Moved up from Phase 8: a repo-not-found error after 5-10 minutes of
    // brew + Ollama work is operator-hostile. The clone only needs `gh`
    // (Phase 3), so we can validate the repo exists early and bail before
    // the slow stuff if it doesn't.
    const repoSpin = p.spinner();
    repoSpin.start('Locating your region node repo…');
    const located = await locateOrCloneRepo({
      owner,
      name: repoName,
      cwd: process.cwd(),
      ...(opts.repoDir ? { explicit: opts.repoDir } : {}),
    });
    const repoPath = repoPathFromLocate(located);
    if (!repoPath) {
      repoSpin.stop(pc.red('✗ Couldn\'t locate or clone the region repo.'));
      handleLocateError(located, owner, repoName);
      process.exit(1);
    }
    repoSpin.stop(
      located.kind === 'cloned'
        ? pc.green(`✓ Cloned ${owner}/${repoName} to ${repoPath}`)
        : pc.green(`✓ Found region repo at ${repoPath}`),
    );

    // ---- Phase 5: secrets (Keychain → paste fallback → persist) ----
    //
    // The Keychain item is local to the machine that wrote it (`init` on
    // the laptop). On a fresh Studio, both items will be missing on first
    // run — bootstrap prompts the operator to paste, validates the format,
    // and writes to the Studio's local Keychain for re-runs.
    //
    // In --local-only mode there's no Tunnel token at all (cloudflared
    // stays down via compose profile gating). The pgsodium key is still
    // required since the data services use it; if missing, we generate
    // a fresh one inline rather than requiring an `init` call first.
    const keychain = await detectKeychain();
    if (!keychain.available) {
      p.cancel(
        `${keychain.reason ?? 'Keychain unavailable'}. Bootstrap requires the macOS Keychain.`,
      );
      process.exit(1);
    }

    // SSH sessions don't auto-unlock the login keychain at session start.
    // When the operator is over SSH AND the keychain is currently locked,
    // every `security add-generic-password` call will fail with exit 36
    // (errSecInteractionNotAllowed). Prompt for the login password once
    // up front, unlock, then proceed — much better UX than 9 identical
    // failures (one per secret) before the operator figures it out.
    if (isSshSession() && (await isKeychainLocked())) {
      p.note(
        [
          'SSH session detected with a locked login keychain.',
          'macOS keychain operations require an unlocked keychain — your',
          'login password will be used once to unlock it for this session.',
          'The keychain remains unlocked until the session ends or it',
          'idle-locks. To skip and unlock manually, press Ctrl+C and run',
          '`security unlock-keychain` yourself.',
        ].join('\n'),
        'Keychain unlock required',
      );
      const pw = unwrap(
        await p.password({
          message: 'macOS login password (for `security unlock-keychain`):',
          validate: (v) => (v && v.length > 0 ? undefined : 'password required'),
        }),
      );
      const unlock = await unlockKeychain(pw);
      if (!unlock.ok) {
        p.cancel(unlock.reason ?? 'security unlock-keychain failed.');
        process.exit(1);
      }
      p.note(`${pc.green('✓')} Keychain unlocked for this session.`, 'Keychain');
    }

    const pgsodiumKey = await loadSecret({
      region,
      account: 'pgsodium-root-key',
      label: 'pgsodium master key',
      validate: (v) =>
        PGSODIUM_KEY_RE.test(v) ? undefined : 'must be exactly 64 lowercase hex characters',
      ...(opts.localOnly ? { generate: generatePgsodiumRootKey } : {}),
    });

    const tunnelToken = opts.localOnly
      ? undefined
      : await loadSecret({
          region,
          account: 'tunnel-token',
          label: 'Cloudflare Tunnel token',
          placeholder: 'JWT-style base64url string from `terraform output tunnel_token`',
          validate: (v) =>
            TUNNEL_TOKEN_RE.test(v) ? undefined : 'tunnel token must be a base64-url JWT',
        });

    // ---- Phase 5b: Supabase self-hosted credentials ----
    //
    // The template's docker-compose-prod.yml runs the full self-hosted
    // Supabase stack (kong, auth, rest, storage, meta, optional studio).
    // Every one of those containers + every microservice in the platform
    // needs the same shared values: POSTGRES_PASSWORD for DB connections,
    // JWT_SECRET for auth, and the long-lived anon/service_role JWTs that
    // @supabase/supabase-js authenticates with.
    //
    // All five are auto-generated on first run via the same `loadSecret`
    // path used for the pgsodium key — Keychain hit → reuse; miss →
    // generate fresh + persist + hard-fail if persist fails (so the next
    // re-run doesn't silently mint a different password and lock us out
    // of the old DB).
    //
    // The two Supabase JWTs are derived from JWT_SECRET so they're not
    // independent secrets — but we cache them in Keychain anyway because:
    //   (a) re-signing on every bootstrap means the `iat`/`exp` claims
    //       drift, which is fine functionally but noisy in audit logs,
    //   (b) it lets operators rotate ANON without rotating JWT_SECRET
    //       by manually replacing the Keychain item.
    const postgresPassword = await loadSecret({
      region,
      account: 'postgres-password',
      label: 'Postgres password',
      // URL-safe alphabet required — value lands in postgres:// URIs where
      // `+`/`/`/`=` cause parser ambiguity in gotrue/postgrest/storage.
      validate: (v) =>
        URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
      generate: generatePostgresPassword,
    });

    const jwtSecret = await loadSecret({
      region,
      account: 'jwt-secret',
      label: 'JWT signing secret',
      validate: (v) =>
        SAFE_LAUNCHCTL_VALUE_RE.test(v) && v.length >= 32
          ? undefined
          : 'must be ≥32 base64 characters',
      generate: generateJwtSecret,
    });

    // Derived JWTs MUST match the current jwtSecret's signature — otherwise
    // a stale anon/service_role token (cached from a previous bootstrap with
    // a different JWT_SECRET) sails past the shape check and breaks every
    // auth call silently. verifySupabaseJwt re-runs the HMAC and rejects on
    // mismatch, triggering regeneration with the current secret.
    const supabaseAnonKey = await loadSecret({
      region,
      account: 'supabase-anon-key',
      label: 'Supabase anon key',
      validate: (v) =>
        SAFE_LAUNCHCTL_VALUE_RE.test(v) && verifySupabaseJwt(v, jwtSecret)
          ? undefined
          : 'must be a base64url JWT signed by the current JWT_SECRET',
      generate: () => signSupabaseJwt({ role: 'anon', secret: jwtSecret }),
    });

    const supabaseServiceRoleKey = await loadSecret({
      region,
      account: 'supabase-service-role-key',
      label: 'Supabase service role key',
      validate: (v) =>
        SAFE_LAUNCHCTL_VALUE_RE.test(v) && verifySupabaseJwt(v, jwtSecret)
          ? undefined
          : 'must be a base64url JWT signed by the current JWT_SECRET',
      generate: () => signSupabaseJwt({ role: 'service_role', secret: jwtSecret }),
    });

    const dashboardPassword = await loadSecret({
      region,
      account: 'dashboard-password',
      label: 'Supabase Studio dashboard password',
      // URL-safe alphabet required — value lands in basic-auth headers via
      // kong's declarative config. Avoid `+`/`/`/`=` for the same reasons.
      validate: (v) =>
        URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
      generate: generateDashboardPassword,
    });

    // ---- prompt-service credentials ----
    //
    // Generated unconditionally (cheap; rare Keychain entries). The
    // op-compose wrapper exports them on every invocation so operators who
    // layer the prompt-service overlay
    // (`./bin/op-compose -f docker-compose-prod.yml -f
    //   docker-compose-prompt-service.yml up`) have a working set of
    // credentials with no extra steps.
    //
    // Operators who connect to a REMOTE prompt-service (Phase 2:
    // prompts.opuspopuli.org) will receive their region-specific HMAC from
    // the prompts team and overwrite this Keychain entry — wrapper
    // continues to export it under the same name, so nothing else changes.
    // ---- prompt-service credentials ----
    //
    // Branches on nodeType:
    //   `region-with-prompts` — operator owns both ends. Generate all three
    //     secrets (DB password + HMAC + admin HMAC); the colocated overlay
    //     consumes them via env.
    //   `region` — operator's prompt-service is REMOTE. They received an
    //     HMAC key from the prompts team; bootstrap prompts them to paste
    //     it. The DB password + admin key are skipped (no local DB, no
    //     admin access from the operator's side).
    if (nodeType === 'region-with-prompts') {
      await loadSecret({
        region,
        account: 'prompts-db-password',
        label: 'prompt-service Postgres password',
        validate: (v) =>
          URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
        generate: generatePostgresPassword,
      });

      await loadSecret({
        region,
        account: 'prompt-service-api-key',
        label: 'prompt-service HMAC API key',
        // Same URL-safe alphabet as other HMAC keys; embedded in the
        // `<region>:<key>` API_KEYS list and in Authorization headers.
        validate: (v) =>
          URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
        generate: generateHmacApiKey,
      });

      await loadSecret({
        region,
        account: 'prompt-service-admin-api-key',
        label: 'prompt-service admin API key',
        validate: (v) =>
          URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
        generate: generateHmacApiKey,
      });
    } else {
      // nodeType === 'region': paste-only path. No `generate`, so loadSecret
      // falls through to the operator-paste prompt.
      await loadSecret({
        region,
        account: 'prompt-service-api-key',
        label: 'prompt-service HMAC API key (issued by the prompts team)',
        placeholder: 'paste the region-specific HMAC key',
        validate: (v) =>
          URL_SAFE_PASSWORD_RE.test(v) ? undefined : 'must be base64url chars only (no + / =)',
      });
    }

    // Remote prompt-service URL — only resolved when NOT colocating.
    // For region-with-prompts the overlay hardcodes http://opuspopuli-prompts:3210
    // on the relevant services; no shell env needed.
    const promptServiceUrl =
      nodeType === 'region-with-prompts'
        ? 'http://opuspopuli-prompts:3210'
        : (opts.promptServiceUrl ?? 'https://prompts.opuspopuli.org');
    if (!SAFE_URL_RE.test(promptServiceUrl)) {
      p.cancel(
        `--prompt-service-url ${JSON.stringify(promptServiceUrl)} contains characters outside the allowed URL set`,
      );
      process.exit(1);
    }

    // SUPABASE_URL gets baked into gotrue's API_EXTERNAL_URL and into every
    // magic-link callback gotrue emails to users. localhost is only correct
    // in --local-only mode; for a Tunnel-exposed production node, emailing
    // links pointing at http://localhost:8000 silently breaks signups.
    //
    // Resolution order:
    //   --local-only mode → default http://localhost:8000 (no prompt)
    //   non-local-only   → require --supabase-url OR prompt for the
    //                       public-facing URL (typically
    //                       https://supabase.<region-domain>)
    let supabaseUrl: string;
    if (opts.supabaseUrl) {
      supabaseUrl = opts.supabaseUrl;
    } else if (opts.localOnly) {
      supabaseUrl = 'http://localhost:8000';
    } else {
      supabaseUrl = unwrap(
        await p.text({
          message: 'Public-facing Supabase URL (what browsers + microservices use to reach kong)?',
          placeholder: 'https://supabase.civicfeed.tx',
          validate: (v) =>
            !v
              ? 'required'
              : SAFE_URL_RE.test(v)
                ? undefined
                : 'contains characters outside the allowed URL set',
        }),
      );
    }
    if (!SAFE_URL_RE.test(supabaseUrl)) {
      p.cancel(
        `--supabase-url ${JSON.stringify(supabaseUrl)} contains characters outside the allowed URL set`,
      );
      process.exit(1);
    }

    // ---- Phase 6: LaunchAgent ----
    if (!opts.skipLaunchAgent) {
      const laSpin = p.spinner();
      laSpin.start('Writing pgsodium key file + LaunchAgent plist…');
      const la = await setupLaunchAgent({
        pgsodiumKey,
        ...(tunnelToken !== undefined ? { tunnelToken } : {}),
        llmModel,
        embeddingModel,
        postgresPassword,
        jwtSecret,
        supabaseAnonKey,
        supabaseServiceRoleKey,
        dashboardPassword,
        supabaseUrl,
      });
      if (!la.ok) {
        laSpin.stop(pc.red(`✗ LaunchAgent step ${la.step} failed.`));
        p.cancel(la.reason ?? 'LaunchAgent setup failed.');
        process.exit(1);
      }
      laSpin.stop(
        pc.green(
          `✓ LaunchAgent loaded (${la.paths.plistFile})${opts.localOnly ? ' — local-only mode, no TUNNEL_TOKEN set' : ''}.`,
        ),
      );
    }

    // ---- Phase 6b: install op-compose wrapper ----
    //
    // launchctl setenv doesn't reach pre-existing shells or sshd children,
    // so operator-driven `docker compose` invocations would hard-fail on
    // the `${VAR:?…}` enforcement in the template even though the values
    // sit safely in Keychain. The wrapper reads Keychain on every
    // invocation and exports the values only into the docker compose
    // subprocess's env — vault-first principle (#811) applied to the
    // bootstrap layer: secrets stay in FileVault-encrypted Keychain at
    // rest, never on disk in plaintext.
    //
    // Operators run: ./bin/op-compose -f docker-compose-prod.yml up -d
    const wrapperSpin = p.spinner();
    wrapperSpin.start('Installing bin/op-compose wrapper…');
    const wrapper = await installOpComposeWrapper({ repoDir: repoPath, region, promptServiceUrl });
    if (!wrapper.ok) {
      wrapperSpin.stop(pc.red('✗ op-compose wrapper install failed.'));
      p.cancel(wrapper.reason ?? 'op-compose wrapper install failed.');
      process.exit(1);
    }
    wrapperSpin.stop(pc.green(`✓ Installed ${wrapper.path} (mode 0755).`));

    // ---- Phase 7: ghcr.io login ----
    const ghcrSpin = p.spinner();
    ghcrSpin.start('Authenticating Docker to ghcr.io…');
    const ghcr = await loginToGhcr();
    if (!ghcr.ok) {
      ghcrSpin.stop(pc.red('✗ ghcr.io login failed.'));
      p.cancel(ghcr.reason ?? 'ghcr.io login failed.');
      process.exit(1);
    }
    ghcrSpin.stop(pc.green('✓ Logged in to ghcr.io.'));

    // ---- Phase 8: Ollama ----
    if (!opts.skipOllama) {
      const olSpin = p.spinner();
      olSpin.start(`Pulling + warming Ollama models… (${estimatedPullTime(llmModel)})`);
      let olHealth = await checkOllamaHealth();
      if (!olHealth.reachable) {
        // S5 review fix: try to start the service before bailing. The
        // operator's pretty much always going to want this anyway, and
        // `brew services start` is no-op-safe.
        olSpin.message('Ollama not reachable — running `brew services start ollama`…');
        const start = await startOllamaService();
        if (!start.ok) {
          olSpin.stop(pc.red('✗ Couldn\'t start Ollama service.'));
          p.cancel(
            `${start.reason ?? 'unknown'} — start it manually with \`brew services start ollama\` and re-run with --skip-brew --skip-launch-agent.`,
          );
          process.exit(1);
        }
        // Brew services start returns immediately; the daemon needs a few
        // seconds before /api/tags responds. Quick wait + re-probe.
        await new Promise((res) => setTimeout(res, 3000));
        olHealth = await checkOllamaHealth();
        if (!olHealth.reachable) {
          olSpin.stop(
            pc.yellow('⚠ Ollama service started but daemon not yet answering on :11434.'),
          );
          p.cancel(
            'Give it another few seconds, then re-run with --skip-brew --skip-launch-agent.',
          );
          process.exit(1);
        }
      }
      const modelReport = await setupModels([embeddingModel, llmModel], (model, status) => {
        olSpin.message(`${status}: ${model}`);
      });
      olSpin.stop(
        modelReport.failed.length === 0
          ? pc.green(
              `✓ ${modelReport.pulled.length} pulled, ${modelReport.alreadyPresent.length} present, ${modelReport.warmed.length} warmed`,
            )
          : pc.yellow(`⚠ ${modelReport.failed.length} model pull(s) failed`),
      );
      const probe = await probeHostDockerInternal();
      if (!probe.ok) {
        p.note(`${pc.yellow('⚠')} ${probe.reason}`, 'Docker host networking');
      }
    }

    // ---- Phase 9: docker compose pull + up ----
    // (Phase 4 already located the repo.)
    if (opts.skipStack) {
      const profileFlag = opts.localOnly ? '' : '--profile public ';
      p.outro(
        pc.cyan(
          `Stack-up skipped. Run \`./bin/op-compose -f ${composeFile.join(' -f ')} ${profileFlag}pull && ./bin/op-compose -f ${composeFile.join(' -f ')} ${profileFlag}up -d\` from ${repoPath} when ready. (op-compose hydrates Keychain secrets per-invocation; use it instead of raw \`docker compose\`.)`,
        ),
      );
      return;
    }

    const composeFiles = resolveComposeFiles(repoPath, composeFile);
    // Hydrate every `${VAR:?…}`-enforced env var on the compose subprocess.
    // launchctl setenv doesn't reach pre-existing shells or sshd children,
    // so bootstrap's own compose calls would otherwise hard-fail even
    // though every value sits in process scope from the loadSecret pass
    // above. Pass them directly via execa's env option — no plaintext
    // .env file lands on disk; the bin/op-compose wrapper does the same
    // hydration just-in-time for operator-driven compose invocations.
    const composeEnv: NodeJS.ProcessEnv = {
      PGSODIUM_ROOT_KEY: pgsodiumKey,
      POSTGRES_PASSWORD: postgresPassword,
      JWT_SECRET: jwtSecret,
      SUPABASE_ANON_KEY: supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
      DASHBOARD_PASSWORD: dashboardPassword,
      SUPABASE_URL: supabaseUrl,
      AUTH_JWT_SECRET: process.env['AUTH_JWT_SECRET'] ?? jwtSecret,
      ...(tunnelToken !== undefined ? { TUNNEL_TOKEN: tunnelToken } : {}),
      ...(llmModel ? { LLM_MODEL: llmModel } : {}),
      ...(embeddingModel ? { EMBEDDINGS_MODEL: embeddingModel } : {}),
    };
    // In production mode, activate the `public` compose profile so cloudflared
    // starts. In --local-only mode pass no profiles — the template gates
    // cloudflared behind `public`, so an empty profiles array keeps it down.
    const composeOpts = {
      files: composeFiles,
      cwd: repoPath,
      ...(opts.envFile ? { envFile: opts.envFile } : {}),
      profiles: opts.localOnly ? LOCAL_PROFILES : PUBLIC_PROFILES,
      env: composeEnv,
    };

    // In --local-only mode, evict any cloudflared container left over from a
    // prior public bootstrap on this Studio. Without this, `compose ps` would
    // still list cloudflared and the health-check loop would demand it reach
    // healthy with no TUNNEL_TOKEN — hanging until timeout. (review S3)
    if (opts.localOnly) {
      const evict = p.spinner();
      evict.start('Evicting any cloudflared from a prior public bootstrap…');
      const rm = await composeRemoveService(
        { ...composeOpts, profiles: PUBLIC_PROFILES },
        'cloudflared',
      );
      evict.stop(
        rm.ok
          ? pc.green('✓ cloudflared not present (or removed).')
          : pc.yellow(`⚠ cloudflared eviction reported: ${rm.reason ?? 'unknown'} — continuing.`),
      );
    }

    const pullSpin = p.spinner();
    pullSpin.start('Pulling images from ghcr.io… (~5–15 min first run, < 1 min cached)');
    const pull = await composePull(composeOpts);
    if (!pull.ok) {
      pullSpin.stop(pc.red('✗ compose pull failed.'));
      p.cancel(pull.reason ?? 'compose pull failed.');
      process.exit(1);
    }
    pullSpin.stop(pc.green('✓ Images pulled.'));

    const upSpin = p.spinner();
    upSpin.start('Starting the stack…');
    const up = await composeUp(composeOpts);
    if (!up.ok) {
      upSpin.stop(pc.red('✗ compose up failed.'));
      p.cancel(up.reason ?? 'compose up failed.');
      process.exit(1);
    }
    upSpin.stop(pc.green('✓ Containers started — waiting for healthy…'));

    // ---- Phase 10: health-check loop ----
    const healthSpin = p.spinner();
    healthSpin.start('Polling for healthy containers… (every 5s, up to 5 min)');
    const outcome = await waitForHealthy(composeOpts, {
      onPoll: (snaps) => {
        const healthy = snaps.filter((s) => s.health === 'healthy').length;
        const running = snaps.filter((s) => s.state === 'running').length;
        healthSpin.message(`${healthy}/${running} healthy`);
      },
    });

    switch (outcome.kind) {
      case 'healthy':
        healthSpin.stop(pc.green(`✓ All ${outcome.snapshots.length} containers healthy.`));
        if (opts.localOnly) {
          p.outro(
            pc.cyan(
              [
                `Region ${region} is up locally (no public Cloudflare Tunnel — cloudflared stays down).`,
                `Access from your laptop over Tailscale at this Studio's tailnet IP.`,
                `When you're ready to expose publicly, re-run \`bootstrap\` without --local-only.`,
              ].join('\n'),
            ),
          );
        } else {
          p.outro(
            pc.cyan(
              `Region ${region} is up. Next: verify off-LAN with \`npx create-op-node verify --domain <your-domain>\`.`,
            ),
          );
        }
        return;
      case 'unhealthy':
        healthSpin.stop(pc.red(`✗ ${outcome.problem}`));
        // Surface the full snapshot table for diagnosis — N10 review fix.
        p.note(
          outcome.snapshots
            .map((s) => `  ${kvHealth(s.health)} ${s.name} (${s.state})`)
            .join('\n'),
          'Container state',
        );
        p.cancel(
          `Inspect with \`docker compose -f ${composeFiles.join(' -f ')} logs\`. Fix and re-run.`,
        );
        process.exit(1);
      // eslint-disable-next-line no-fallthrough
      case 'timeout':
        healthSpin.stop(pc.yellow('⚠ Timed out waiting for all containers to report healthy.'));
        p.note(
          outcome.snapshots
            .map((s) => `  ${kvHealth(s.health)} ${s.name} (${s.state})`)
            .join('\n'),
          'Container state at timeout',
        );
        // B1 review fix: don't print the success outro. The stack hasn't
        // settled and `verify` would mislead — instruct the operator to
        // re-poll and exit non-zero.
        p.cancel(
          `Re-run \`create-op-node bootstrap --skip-brew --skip-launch-agent --skip-ollama\` to skip the already-done phases and poll again once containers settle.`,
        );
        process.exit(1);
      // eslint-disable-next-line no-fallthrough
      default: {
        // Exhaustiveness check — adding a new HealthOutcome variant without
        // updating this switch fails the type check.
        const _exhaustive: never = outcome;
        void _exhaustive;
        return;
      }
    }
  });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Resolve the compose-file paths the wizard will pass to docker. Absolute
 * paths pass through; relative paths are resolved against `repoPath`. Pure
 * helper for unit testing — keeps the path-resolution rule in one place.
 */
export function resolveComposeFiles(
  repoPath: string,
  composeFile: string[] | undefined,
): string[] {
  const inputs = composeFile ?? ['docker-compose-prod.yml'];
  return inputs.map((f) => (f.startsWith('/') ? f : join(repoPath, f)));
}

/**
 * Resolve the Ollama model identifiers from operator flags + defaults.
 * Pure helper — mirrors `resolveComposeFiles` so the flag-resolution rule
 * lives in one place and stays unit-testable.
 *
 * Returned in the order Ollama pulls + warms them: `[embedding, llm]`.
 * The embedding model is typically tiny (~500 MB), so emitting it first
 * gives the operator a visible "✓ pulled" milestone before the LLM's
 * potentially-tens-of-gigabytes download dominates the spinner. (S3)
 */
export function resolveModels(opts: {
  llmModel?: string;
  embeddingModel?: string;
}): readonly [embedding: string, llm: string] {
  return [
    opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    opts.llmModel ?? DEFAULT_LLM_MODEL,
  ] as const;
}

/** Curated LLM choices shown in the interactive picker. Qwen-only because
 *  the Opus Populi platform serves Spanish-speaking civic users and Qwen
 *  has the strongest Spanish (and broader multilingual) capability of the
 *  open-weight models in this tier. Other Ollama models are still
 *  reachable via the "Other…" sentinel. Sized per
 *  docs/docker-resources.md in the opuspopuli-node template.
 *  Order = display order. */
export const LLM_MODEL_CHOICES = [
  {
    value: 'qwen2.5:72b',
    label: 'qwen2.5:72b',
    hint: '72B, ~50 GB Ollama RAM. Recommended for 128 GB Studios. Best Spanish + multilingual quality. Pull ~40 GB, 30–60 min.',
  },
  {
    value: 'qwen2.5:32b',
    label: 'qwen2.5:32b',
    hint: '32B, ~22 GB Ollama RAM. Middle-tier for 64 GB Studios. Solid Spanish, faster than 72B. Pull ~20 GB, 15–30 min.',
  },
  {
    value: 'qwen3.5:9b',
    label: 'qwen3.5:9b',
    hint: '9B, ~8 GB Ollama RAM. Validation / smaller Studios (36–48 GB). Pull ~5 GB, 3–5 min.',
  },
] as const;

const OTHER_SENTINEL = '__OTHER__';

/**
 * Pick the LLM that fits the operator's unified-memory budget. Ollama uses
 * roughly the model's parameter count in GB (in q4 quantization), plus a
 * context-window buffer. The Studio also needs RAM for macOS + Docker +
 * the data services. Thresholds below leave 30–40 GB headroom for that.
 *
 * Returns null when `ramGB` is null (sysctl unavailable) so the caller
 * falls back to the platform-default recommendation. (Pure helper —
 * exported for unit tests.)
 */
export function recommendLlmModel(ramGB: number | null): string | null {
  if (ramGB === null) return null;
  if (ramGB >= 96) return 'qwen2.5:72b';
  if (ramGB >= 48) return 'qwen2.5:32b';
  return 'qwen3.5:9b';
}

/**
 * Prompt the operator to pick an LLM model. Skipped when `--yes` is set
 * (returns the conservative default) or when `--llm-model` was passed
 * (caller short-circuits before this is reached).
 *
 * Pre-selects based on the Studio's detected unified memory — 128 GB
 * studios get qwen2.5:72b, 64 GB get qwen2.5:32b, smaller fall back to
 * qwen3.5:9b. When detection fails (non-macOS, sysctl missing), defaults
 * to qwen2.5:72b (the documented platform target).
 *
 * "Other..." branches to a text input validated against the same
 * MODEL_NAME_RE the LaunchAgent uses for setenv injection safety.
 */
async function selectLlmModel(opts: { yes?: boolean }): Promise<string> {
  if (opts.yes) return DEFAULT_LLM_MODEL;

  const ramGB = await detectUnifiedMemoryGB();
  const recommended = recommendLlmModel(ramGB) ?? 'qwen2.5:72b';
  const ramNote = ramGB !== null
    ? `Detected ${ramGB} GB unified memory — pre-selecting ${recommended}.`
    : `Couldn't detect Studio memory — defaulting to ${recommended} (override if your config differs).`;

  p.note(ramNote, 'Hardware');

  const choice = unwrap(
    await p.select({
      message: 'Choose the LLM model to pull + run',
      initialValue: recommended,
      options: [
        ...LLM_MODEL_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
        {
          value: OTHER_SENTINEL,
          label: 'Other…',
          hint: 'Specify any Ollama model name (e.g. mistral-small:24b)',
        },
      ],
    }),
  );

  if (choice !== OTHER_SENTINEL) return choice;

  return unwrap(
    await p.text({
      message: 'Ollama model name',
      placeholder: 'e.g. mistral-small:24b',
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v ?? '')
          ? undefined
          : 'Letters, digits, `.`, `:`, `_`, `-`, `/` only; must start with alphanumeric',
    }),
  );
}

/** Rough wall-clock estimate for pulling an Ollama model, based on the
 *  size suffix in the tag. Used to populate the Ollama-pull spinner so
 *  the operator knows whether to wait or step away. Estimates assume a
 *  ~100 Mbps connection; faster networks finish proportionally sooner.
 *
 *  Sparse-MoE shapes (`8x22b`) are matched before the plain `Nb` parse
 *  because their size suffix in the tag refers to per-expert size, not
 *  the total model footprint. */
export function estimatedPullTime(model: string): string {
  if (/\d+x\d+b/i.test(model)) return '~60+ min for frontier MoE';
  const match = /(\d+)b\b/i.exec(model);
  if (!match) return 'time depends on model size';
  const size = Number.parseInt(match[1]!, 10);
  if (size <= 13) return '~3–5 min for ≤ 13B-class';
  if (size <= 35) return '~15–30 min for ~32B-class';
  if (size <= 80) return '~30–60 min for 70B-class';
  return '~60+ min for frontier-class';
}

function kvBool(b: boolean): string {
  return b ? pc.green('on') : pc.yellow('off');
}

function kvFileVault(v: boolean | 'unknown'): string {
  if (v === 'unknown') return pc.dim('unknown');
  return v ? pc.green('on') : pc.dim('off');
}

function kvHealth(h: 'healthy' | 'unhealthy' | 'starting' | 'none'): string {
  switch (h) {
    case 'healthy':
      return pc.green('✓');
    case 'unhealthy':
      return pc.red('✗');
    case 'starting':
      return pc.yellow('…');
    case 'none':
      return pc.dim('-');
  }
}

function repoPathFromLocate(out: LocateOutcome): string | null {
  if (out.kind === 'found' || out.kind === 'cloned') return out.path;
  return null;
}

function handleLocateError(out: LocateOutcome, owner: string, name: string): void {
  switch (out.kind) {
    case 'explicit-not-a-node-repo':
      p.cancel(
        `${out.path} doesn't look like a node repo (missing one of docker-compose-prod.yml / supabase/init/pgsodium_getkey_env.sh). Point --repo-dir at the right place.`,
      );
      return;
    case 'gh-not-installed':
      p.cancel('`gh` not installed — install via `brew install gh` and re-run.');
      return;
    case 'clone-failed':
      p.cancel(
        `Couldn't clone ${owner}/${name}: ${out.reason}. Check repo exists + you have access.`,
      );
      return;
    case 'clone-disallowed':
      p.cancel(
        'No checked-out node repo found and --no-clone (or similar) was set. Provide --repo-dir.',
      );
      return;
    case 'found':
    case 'cloned':
      // Success cases — handleLocateError shouldn't be called for them, but
      // listing here makes the switch exhaustive so the `never` check below
      // catches any new variant added to LocateOutcome.
      return;
    default: {
      // Compile-time exhaustiveness — if LocateOutcome gains a new variant
      // and isn't handled above, TypeScript fails this assignment.
      const _exhaustive: never = out;
      void _exhaustive;
      return;
    }
  }
}

/**
 * Verify `gh` is signed in. If not, surface the one-line command to fix and
 * wait for the operator. Doesn't auto-run `gh auth login` since it opens a
 * browser flow and we don't want to fight it. Surfaces `gh auth status`'s
 * stderr so a wrong-account / missing-scope situation isn't silent.
 */
async function ensureGhAuth(): Promise<void> {
  const status = await safeExeca('gh', ['auth', 'status']);
  if (status === null) {
    p.cancel('`gh` not on PATH. Install via `brew install gh` and re-run.');
    process.exit(1);
  }
  if (status.exitCode === 0) return;

  const detail = (status.stderr || status.stdout).trim();
  p.note(
    [
      '`gh` is not signed in (or signed in to a different account / missing scope).',
      detail ? '' : undefined,
      detail ? pc.dim(detail) : undefined,
      '',
      'In another shell:',
      '',
      pc.cyan('gh auth login --web'),
      '',
      pc.dim('Then come back and press Enter.'),
    ]
      .filter((l): l is string => typeof l === 'string')
      .join('\n'),
    'Manual step',
  );
  unwrap(await p.confirm({ message: 'gh signed in?', initialValue: true }));
}

/**
 * Tailscale needs an interactive browser signin. We surface the command +
 * wait for confirmation rather than spawning it ourselves — operators run
 * different node setups (start at login vs. on-demand) and we don't want
 * to second-guess. Tailscale is optional; the rest of the bootstrap
 * continues without it (out-of-band SSH is just less convenient).
 */
async function promptTailscaleSignin(): Promise<void> {
  const status = await safeExeca('tailscale', ['status']);
  if (status !== null && status.exitCode === 0) return;

  p.note(
    [
      'Tailscale needs to be signed in (or you can skip — Tailscale is',
      'optional; it provides out-of-band SSH from your laptop. The rest',
      'of the bootstrap continues without it).',
      '',
      'In another shell:',
      '',
      pc.cyan('tailscale up'),
      '',
      pc.dim('Accept the device on your tailnet, then come back and press Enter.'),
    ].join('\n'),
    'Manual step',
  );
  unwrap(await p.confirm({ message: 'Tailscale signed in (or skipped)?', initialValue: true }));
}

interface LoadSecretInput {
  region: string;
  account: SecretAccount;
  /** Friendly name for prompts and notes. */
  label: string;
  /** Placeholder hint shown in the paste prompt. Ignored when `generate` is set. */
  placeholder?: string;
  /** Format check applied to both Keychain reads (so a stale-bad value is
   *  treated as missing) and operator paste input. */
  validate: (v: string) => string | undefined;
  /** When set, on Keychain miss / validate-fail, generate a fresh value
   *  instead of prompting. Used by `--local-only` for the pgsodium key —
   *  no `init` needed.
   *
   *  CRITICAL: when `generate` is set we MUST be able to persist the
   *  generated value to Keychain. Otherwise the next bootstrap re-run
   *  generates a different fresh key and silently destroys any data
   *  encrypted under the previous key. So save failure in the generate
   *  path is a hard exit, not a warning. (review B1) */
  generate?: () => string;
}

/**
 * Materialize a secret. Three paths, in order:
 *
 *   1. Keychain hit + valid → return it.
 *   2. Else if `generate` is set → generate fresh, MUST persist (hard fail
 *      if save fails), return. The Keychain item is the durable record;
 *      losing it later means losing whatever it encrypted.
 *   3. Else → prompt operator to paste, validate, persist with a warning
 *      on save failure (the operator can paste again next time).
 *
 * If `validate` rejects an existing Keychain item, we surface the swap
 * explicitly before regenerating/reprompting — destructive overwrites
 * shouldn't be invisible. (review S1)
 */
async function loadSecret(input: LoadSecretInput): Promise<string> {
  const coords = { region: input.region, account: input.account };
  const spin = p.spinner();
  spin.start(`Reading ${input.label} from Keychain…`);
  const existing = await readSecret(coords);
  if (existing && input.validate(existing) === undefined) {
    spin.stop(pc.green(`✓ ${input.label} read from Keychain.`));
    return existing;
  }

  // Differentiate "missing" from "present-but-bad-format" — the latter is a
  // destructive replacement so we say so out loud.
  spin.stop(
    existing
      ? pc.yellow(`⚠ ${input.label} in Keychain failed format validation — will replace.`)
      : pc.dim(`· ${input.label} not in Keychain.`),
  );

  if (input.generate) {
    const fresh = input.generate();
    const save = await saveSecret(coords, fresh);
    if (!save.written) {
      // Hard fail (review B1) — we generated a fresh value but couldn't
      // persist it. If we continued, the next bootstrap re-run would
      // generate a DIFFERENT fresh value and destroy whatever this one
      // encrypted. Better to bail loudly and let the operator fix the
      // underlying Keychain issue.
      p.cancel(
        `Generated a fresh ${input.label} but couldn't persist it to Keychain: ${save.reason ?? 'unknown'}. ` +
          `Continuing would risk silent key rotation on the next re-run. ` +
          `Resolve the Keychain access (re-grant via Keychain Access.app or check the security CLI) and re-run.`,
      );
      process.exit(1);
    }
    p.note(`${pc.green('✓')} Generated fresh ${input.label} and stored in Keychain.`, 'Keychain');
    return fresh;
  }

  const pasted = unwrap(
    await p.password({
      message: `Paste the ${input.label} for region ${input.region}:`,
      validate: (v) => input.validate(v ?? ''),
    }),
  );
  const save = await saveSecret(coords, pasted);
  if (!save.written) {
    // Paste path: warning is fine since the operator can paste again on the
    // next run. The value isn't lost — it's still wherever they pasted from.
    p.note(
      `${pc.yellow('⚠')} Couldn't persist to Keychain: ${save.reason ?? 'unknown'}. You'll need to paste it again next run.`,
      'Keychain',
    );
  } else {
    p.note(`${pc.green('✓')} Stored ${input.label} in Keychain for re-runs.`, 'Keychain');
  }
  return pasted;
}
