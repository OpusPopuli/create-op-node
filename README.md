# create-op-node

> Interactive bootstrap for an [Opus Populi](https://github.com/OpusPopuli) federation node.
> From a sealed-box Mac Studio + a Cloudflare account to a live public API in one command.

```bash
npx create-op-node
```

That's it. The wizard walks you through:

1. **Cloudflare** — verifies your API token's 5 scopes (Zone Read, DNS Edit, Tunnel Edit, R2 Storage Edit, Pages Edit). Fails fast with a specific scope name if anything's missing.
2. **GitHub** — creates your region's node repo from the [`OpusPopuli/opuspopuli-node`](https://github.com/OpusPopuli/opuspopuli-node) template via the GitHub API. Seeds the 5 required GitHub Secrets (Cloudflare token, account ID, zone ID, Terraform Cloud token, TFC org) for you.
3. **Terraform Cloud** — verifies your TFC token, prepares the workspace.
4. **First PR** — writes `environments/prod.tfvars` from your answers, commits, opens the first PR. The node repo's `cloudflare-infra.yml` workflow runs `terraform plan` against the PR; on merge to `main` it applies — Tunnel, DNS, R2 buckets, and Pages project come up automatically.
5. **pgsodium master key** — generates a fresh 64-hex root key, stores it in your **macOS login Keychain** as `org.opuspopuli.<region>/pgsodium-root-key`. No third-party password manager required.
6. **Tunnel token retrieval** — after `terraform apply` lands, fetches the Tunnel token from Terraform Cloud outputs and stores it alongside the pgsodium key in your Keychain.

> Doing **local dev / testing first** (no public exposure yet)?
> See [Local-only mode](#local-only-mode-no-cloudflare) — `init --local-only`
> skips the Cloudflare/TFC/PR phases entirely.

Then on the Mac Studio itself:

```bash
npx create-op-node bootstrap
```

Configures macOS power settings, installs Homebrew + the CLI tool list, sets up Docker Desktop + Tailscale + Ollama, clones the node repo you created, reads the pgsodium key + Tunnel token from the Studio's Keychain (or prompts you to paste them once, then persists for re-runs), writes the LaunchAgent plist, logs into ghcr.io, pulls + warms the LLM model, and finally `docker compose --profile public pull && up -d` brings the whole stack online. Health-check loop waits until all containers are `(healthy)`.

### Choosing the LLM model

By default bootstrap pulls `qwen3.5:9b` (LLM) and `nomic-embed-text`
(embeddings) — small enough to validate the inference path on first
run. Override with flags:

```bash
# Just swap the LLM, keep the default embedding model:
npx create-op-node bootstrap --region us-ca --llm-model llama3.3:70b

# Override both:
npx create-op-node bootstrap \
  --region us-ca \
  --llm-model llama3.3:70b \
  --embedding-model mxbai-embed-large
```

The chosen models flow two places:

1. **Ollama**: bootstrap pulls + warms them so the daemon has them
   resident before the stack comes up. The embedding model pulls first
   (small, fast feedback); the LLM pulls second (can be tens of GB).
2. **LaunchAgent**: the plist exports `LLM_MODEL` and `EMBEDDINGS_MODEL`
   into the launchd session, which Docker Desktop inherits — so compose
   services read them via env, no `.env.production` edits needed.

> **`--embedding-model` only takes effect when the knowledge service
> runs with `EMBEDDINGS_PROVIDER=ollama`.** The default provider is
> `xenova` (in-process), which bundles its own embedding model and
> ignores both `EMBEDDINGS_MODEL` and the local Ollama model. Setting
> `EMBEDDINGS_PROVIDER=ollama` is a separate decision (set in your
> region repo's `.env.production`) — see `docs/provider-pattern.md`.

> **Template contract**: for `--llm-model` to actually change the
> running model, the region repo's `docker-compose-prod.yml` must use
> `${LLM_MODEL:-qwen3.5:9b}` (or similar) on the knowledge service's
> `environment:` block. The current `opuspopuli-node` template does;
> a fork that hardcodes the value would ignore the flag silently.

For RAM sizing, the [Docker resources doc](https://github.com/OpusPopuli/opuspopuli-node/blob/main/docs/docker-resources.md)
has a tier table: 9B-class needs ~8 GB Ollama; 70B-class needs ~50 GB;
frontier MoE needs ~80 GB. Allocate Docker the remainder.

To switch models post-bootstrap, re-run with the new flag and
`docker compose down && up -d` to pick up the changed env.

### Local-only mode (no Cloudflare)

For local dev / testing — frontend on your laptop, backend on the Studio
over Tailscale, no public exposure. The flow mirrors production-init →
production-bootstrap, just with the Cloudflare half cut out on both
sides.

**On the laptop:**

```bash
npx create-op-node init --region us-ca --local-only
```

This creates the region repo from the `OpusPopuli/opuspopuli-node`
template (private, no public exposure), generates the pgsodium master
key, and saves it to Keychain. No Cloudflare, no Terraform Cloud, no PR
to merge.

**On the Studio:**

```bash
npx create-op-node bootstrap --region us-ca --local-only
```

Differences from production bootstrap:

- **No Tunnel token required.** `init --local-only` skipped that phase.
- **`cloudflared` stays down.** It's gated behind the `public` compose
  profile, which `--local-only` doesn't activate. Bootstrap also evicts
  any leftover cloudflared from a prior public run so it doesn't strand
  in `compose ps`.
- **Backup stack skipped by default.** `docker-compose-backup.yml`
  isn't loaded; pass `--compose-file docker-compose-backup.yml` to
  include it explicitly.
- **LaunchAgent omits `TUNNEL_TOKEN`.** Only `PGSODIUM_ROOT_KEY` is
  exported into the launchd session.
- **Outro tells you to use Tailscale**, not `npx create-op-node verify`.

When you're ready to expose publicly, re-run **both** commands without
`--local-only`. Same region repo, same pgsodium key — promotes
cleanly to the production-shaped deploy.

> **Template version**: this mode depends on the `opuspopuli-node`
> template having `profiles: [public]` on its cloudflared service. If
> you cloned the template before that landed, refresh your fork
> (or recreate from template) before using `--local-only` — otherwise
> cloudflared starts regardless and will restart-loop without a
> TUNNEL_TOKEN.

> **Secret transport between laptop and Studio**
>
> The macOS `security` CLI writes to the local login keychain — items
> don't sync to iCloud Keychain automatically. On the Studio's first
> bootstrap, the operator pastes the pgsodium key + Tunnel token once
> (from the laptop's Keychain Access, or wherever you copied them); the
> Studio bootstrap validates the format and persists locally so re-runs
> read straight through. Use AirDrop / `security find-generic-password`
> output / Tailscale `scp` to ferry the values.

## Resetting the Studio

To start over (e.g. before rerunning `bootstrap` against a different
region, or after a misconfiguration), reverse the Studio-side state:

```bash
npx create-op-node reset --region us-ca
```

Three phases run in reverse-bootstrap order. By default volumes are
preserved — the database survives so you can bring the stack back up
with `bootstrap` without losing data.

1. **Stop the stack** — `docker compose down`. Pass `--wipe-data` to
   add `-v` (destroys named volumes including the database). The wipe
   mode requires retyping the region label as confirmation — and the
   prompt deliberately doesn't pre-fill the answer, so you have to type
   it from memory. `y` won't do it.
2. **Unload + remove the LaunchAgent** — `launchctl unload` then `rm`
   the plist and the pgsodium key file. `--keep-key-file` leaves the
   key in place as a belt-and-suspenders backup before a wipe-data run.
3. **`docker logout`** — clears the registry-credentials store entry
   for `ghcr.io` (or override with `--registry`). This only clears the
   store entry; if your credential helper caches the token elsewhere
   (or `~/.docker/config.json` has stale entries from another host),
   those need separate cleanup.

Reset does **not** touch cloud-side state: the Cloudflare resources,
the GitHub repo, and the TFC workspace remain. Keychain items on the
Studio are also left in place — `security delete-generic-password -s
org.opuspopuli.<region> -a pgsodium-root-key` etc. if you want them
gone.
`init` is idempotent against existing cloud setup, so re-running it
won't duplicate anything.

Useful flags:

- `--dry-run` — print the plan without acting. Phases that would run
  show with a `?` icon; phases that are skipped show with `·`.
- `--skip-stack` / `--skip-launch-agent` / `--skip-docker-logout` —
  surgical resets when only one piece needs cleaning.
- `--no-remove-orphans` — drop `--remove-orphans` from `compose down`.
  Useful when you ran bootstrap with a custom `--compose-file` set and
  reset without it.
- `--repo-dir <path>` — explicit path to the cloned node repo when
  reset is run from outside the checkout. Passing a path that doesn't
  look like a node repo is a hard error, not a silent skip.
- `--registry <reg>` — log out of a registry other than `ghcr.io`.

```bash
# Try-before-you-buy: preview every step.
npx create-op-node reset --region us-ca --dry-run

# Nuke from orbit: containers + volumes + LaunchAgent + ghcr credentials.
npx create-op-node reset --region us-ca --wipe-data
```

## Verifying a live node

```bash
npx create-op-node verify --domain your-domain.example
```

Off-LAN health probe of a live node, runnable from anywhere with internet
access. Five phases:

1. **TLS handshake** to `api.<domain>:443` — surfaces cert subject, issuer,
   and days-to-expiry. Warns when the cert is within `--cert-warn-days`
   of expiring (default 14d). Negative expiries render as
   `expired Nd ago`.
2. **`GET https://api.<domain>/health`** must return 200.
3. **`POST https://api.<domain>/api`** with `{ __typename }` must return a
   valid GraphQL envelope (catches the "TLS green, but a misconfigured
   proxy returns HTML" case).
4. **Cloudflare Tunnel status** (optional) — looks up `connections` via
   the CF API. Zero connectors registered → warning that cloudflared on
   the Studio is offline. Requires all three of `--cf-token` (or
   `--cf-token-file`), `--cf-account-id`, `--tunnel-id`; partial
   configuration warns + names the missing flag.
5. **`cosign verify`** (optional, repeatable `--image`) — keyless
   verification against the GitHub Actions OIDC issuer + Fulcio +
   the Rekor transparency log. Silently skipped when `cosign` isn't on
   `PATH` (install with `brew install cosign` to enable).

No phase short-circuits the others — verify always runs the full pass so
the operator sees the whole landscape in one report. Exits non-zero only
when at least one phase failed; warnings are reported but don't fail the
run. Skipped phases are hidden by default; add `--show-skipped` to see them.

Full flag set:

```bash
npx create-op-node verify \
  --domain yournode.example.org \
  --cf-token-file ~/.config/opuspopuli/cf-token \
  --cf-account-id $CF_ACCOUNT_ID \
  --tunnel-id $TUNNEL_ID \
  --image ghcr.io/opuspopuli/api:latest \
  --image ghcr.io/opuspopuli/users:latest \
  --cert-warn-days 21
```

`--cf-token-file` is preferred over `--cf-token` for cron / systemd
invocations — the latter ends up in `ps` output, the former doesn't.
Use `--api-host <host>` to override the default `api.<domain>`
construction when your node exposes the API at a different subdomain.

## Bootstrapping a region config

A node serves data; **what** data it serves is defined by a declarative region
config in [`OpusPopuli/opuspopuli-regions`](https://github.com/OpusPopuli/opuspopuli-regions).
Hand-writing one of those JSON files against the schema is the same kind of
fiddly, error-prone step the rest of this CLI exists to remove — so there's a
subcommand for it. Run it from the root of your `opuspopuli-regions` checkout:

```bash
npx create-op-node region
```

The wizard walks you through level (state or county), names, the two-letter
state code, FIPS code, timezone, and at least one data source (URL, data type,
source type, content goal). It then:

1. Derives the `regionId` and keeps `name === config.regionId` (the invariant
   the regions repo enforces).
2. Validates the generated file against the **vendored copy of
   `region-plugin.schema.json`** (the canonical contract) using an ESM-native
   JSON Schema validator, then layers on the cross-field rules the repo's
   `pnpm test` adds in code: semver shape, FIPS length per level
   (2 digits for state, 5 for county), county-id-prefixed-by-parent, no
   duplicate data sources keyed by `(dataType, url)`. All checks run **before**
   writing, so the file lands green instead of bouncing off CI.
3. Writes it to the canonical path
   (`regions/<state>/<state>.json` or
   `regions/<state>/counties/<county>/<county>.json`).

> **Conventions you may not expect**
>
> - New configs are stamped at **version `0.1.0`** — the documented starting
>   point in `opuspopuli-regions/CLAUDE.md`. Bump manually as the config
>   matures (additions → minor, breaking changes → major).
> - `boundarySources` is **not** prompted for. It's optional per the schema, so
>   the scaffolded file is valid without it — but if your region has TIGER /
>   ArcGIS boundary coverage and you want PostGIS point-in-polygon district
>   lookups, you'll need to add the block by hand after scaffolding (see
>   `regions/california/california.json` for a worked example).
> - `civics_blocks` is **not** part of the region config schema. It's a
>   per-region taxonomy that lives elsewhere in the platform — don't look for
>   a prompt for it here.

Then it's just `pnpm test` + a PR. Non-interactive flags (`--level`, `--name`,
`--parent`, `--state-code`, `--fips`, `--timezone`, `--out-dir`, `--force`) are
available for scripting; run `create-op-node region --help` for the list.

### What it looks like

```text
┌  create-op-node region

◇  What level is this region?
│  County

◇  County name?
│  Alameda

◇  Parent state slug?
│  california

◇  Display name?
│  Alameda County

◇  One-line description of the data coverage?
│  Civic data for Alameda County, California

◇  Two-letter state code?
│  CA

◇  County FIPS (5 digits)?
│  06001

◇  IANA timezone?
│  America/Los_Angeles

◇  Data source #1 — URL?
│  https://bos.acgov.org/

◇  Data type?
│  meetings

◇  Source type?
│  html_scrape

◇  Content goal (what should the scraper extract)?
│  Fetch Board of Supervisors agendas, minutes, and votes

◇  Category label (optional)?
│  Board of Supervisors

◇  Add another data source?
│  No

◆  regions/california/counties/alameda/alameda.json (preview) ──────────╮
│  {                                                                     │
│    "name": "california-alameda",                                       │
│    "displayName": "Alameda County",                                    │
│    "description": "Civic data for Alameda County, California",         │
│    "version": "0.1.0",                                                 │
│    "config": {                                                         │
│      "regionId": "california-alameda",                                 │
│      "regionName": "Alameda County",                                   │
│      "description": "Civic data for Alameda County, California",       │
│      "timezone": "America/Los_Angeles",                                │
│      "stateCode": "CA",                                                │
│      "fipsCode": "06001",                                              │
│      "dataSources": [                                                  │
│        {                                                               │
│          "url": "https://bos.acgov.org/",                              │
│          "dataType": "meetings",                                       │
│          "sourceType": "html_scrape",                                  │
│          "contentGoal": "Fetch Board of Supervisors agendas, ...",     │
│          "category": "Board of Supervisors"                            │
│        }                                                               │
│      ]                                                                 │
│    },                                                                  │
│    "parentRegionId": "california"                                      │
│  }                                                                     │
├────────────────────────────────────────────────────────────────────────╯

◇  Write regions/california/counties/alameda/alameda.json?
│  Yes

◆  Done ────────────────────────────────────────────────────╮
│  ✓ Wrote regions/california/counties/alameda/alameda.json  │
│                                                            │
│  Next steps in your opuspopuli-regions checkout:           │
│    pnpm test                 # schema + hierarchy          │
│    pnpm test:connectivity    # URL reachability            │
│    git add … && git commit && open a PR                    │
├──────────────────────────────────────────────────────────────╯

└  Region scaffolded: california-alameda
```

### Caveats

A couple of honest sharp edges, since this command lives in the *node* CLI
rather than in the regions repo itself:

- **Run it from a `opuspopuli-regions` checkout.** The file is written relative
  to `--out-dir` (default: current directory) at the canonical `regions/…`
  path. Run it anywhere else and the file lands in the wrong tree.
- **The validation here mirrors the regions schema; it does not import it.**
  `create-op-node` can't see `region-plugin.schema.json` at runtime, so its
  pre-write checks are a hand-maintained copy of the rules. They can drift if
  the schema changes. The regions repo's own `pnpm test` is the source of
  truth — **always run it after scaffolding**; treat a green run there, not a
  green run here, as the real signal. If the two ever disagree, the schema
  wins and this command needs updating.

## What lands where

`create-op-node` touches several secret stores. Here's the full map of
what we own (the two macOS Keychain items) vs. what we just route to its
destination.

### Stored by `create-op-node` in macOS Keychain

Two items per region, both generic-password class
(`kSecClassGenericPassword`). Visible in **Keychain Access.app**
(`/System/Applications/Utilities/Keychain Access.app`) — **not** in the
new Passwords.app, which is filtered to website-login items only.

| # | Service | Account | Label (GUI display)                                              | Value format               | Written by                       | Read by                  |
|---|---|---|---|---|---|---|
| 1 | `org.opuspopuli.<region>` | `pgsodium-root-key` | `Opus Populi (<region>) — pgsodium root key`             | 64 lowercase hex chars     | `init` on laptop                 | `bootstrap` on Studio    |
| 2 | `org.opuspopuli.<region>` | `tunnel-token`      | `Opus Populi (<region>) — Cloudflare Tunnel token`       | JWT-style base64url string | `init` on laptop (after TFC apply) | `bootstrap` on Studio    |

Both items also carry `-D 'Opus Populi secret'` (the "Kind" column in
Keychain Access) so you can filter for them at a glance.

Inspect from a shell:

```bash
# Metadata only (safe to share output):
security find-generic-password -s org.opuspopuli.us-ca -a pgsodium-root-key

# Reveal the value (you'll be prompted to allow access on first call):
security find-generic-password -s org.opuspopuli.us-ca -a pgsodium-root-key -w
```

### Stored elsewhere (we don't put these in Keychain)

Everything else flows through transiently or lives in its destination
system's own credential store.

| Secret                              | Where it lives                                                                          | Why not in Keychain                                                                                                              |
|---|---|---|
| Cloudflare API token                | Pasted into `init` prompt → forwarded to **GitHub Secrets** + **Terraform Cloud** vars  | One-shot during init. Re-runs prompt again. We could store it; adds risk vs benefit.                                             |
| Cloudflare account ID, zone ID      | Same as above                                                                            | Not really a "secret" but flow alongside the token                                                                              |
| Terraform Cloud token               | Pasted, used to verify + poll runs                                                       | Same one-shot pattern                                                                                                            |
| GitHub PAT                          | Read from `gh auth token` if available, else pasted                                      | `gh` already manages it                                                                                                          |
| pgsodium key (Studio runtime form)  | `~/.config/opuspopuli/pgsodium_root_key` (mode `0400`)                                  | LaunchAgent reads it at every login → interpolates into the `PGSODIUM_ROOT_KEY` env var. Same value as in Keychain; file is runtime form. |
| Cloudflare Tunnel token (Studio runtime form) | Baked into `~/Library/LaunchAgents/org.opuspopuli.envloader.plist` (mode `0600`) | launchd's `launchctl setenv TUNNEL_TOKEN` injects it into the session at every boot. Same value as in Keychain; plist is runtime form. |
| ghcr.io credentials                 | `~/.docker/config.json` or `docker-credential-osxkeychain`                              | Docker manages its own credential store — it actually saves the ghcr token to a separate Keychain item under service `ghcr.io`. We just call `docker login`. |

Per region, the **only** persistent secrets `create-op-node` owns are
the two Keychain items above. Everything else is either transient
(prompted, used, forgotten) or lives in its destination system.

## Why this exists

Each Opus Populi region is operated independently by a local maintainer — its own Cloudflare account, its own Mac Studio, its own domain. The full bootstrap is a few hours of manual steps across Cloudflare, GitHub, Terraform Cloud, macOS Setup Assistant, Docker Desktop, Tailscale, Ollama, and the node's own Docker Compose stack. Doable from the runbook, but error-prone.

This CLI exists to make that bootstrap **foolproof** — every prompt validates immediately, every secret is retrieved from a secure source (never echoed, never written to disk in plaintext), and every step has an explicit "what happens next" message. The goal is zero documentation reading required to get a node running.

The CLI itself never holds any credentials beyond the scope of a single command — secrets flow from your macOS Keychain → through the CLI → directly into the destination (GitHub Secrets, Terraform Cloud workspace variables, Mac Studio LaunchAgent). Nothing persists in this process.

## Architecture

```
                       ┌──────────────────────────────────────┐
                       │  Your laptop                         │
                       │                                      │
   npx create-op-node ─┤  ┌─ init  ──────► Cloudflare API     │
                       │  ├─ bootstrap     GitHub API         │
                       │  ├─ verify        Terraform Cloud    │
                       │  └─ region        `op` CLI (optional)│
                       │     (writes a regions repo config)   │
                       └──────────────────────────────────────┘
                                            │
                                            ▼
                       ┌──────────────────────────────────────┐
                       │ <your-org>/opuspopuli-node-<region>  │
                       │ (created from template by `init`)    │
                       │                                      │
                       │  Terraform applies to your CF account│
                       │  Mac Studio pulls compose + scripts  │
                       └──────────────────────────────────────┘
                                            │
                                            ▼
                       ┌──────────────────────────────────────┐
                       │  Mac Studio                          │
                       │                                      │
                       │  `bootstrap` configures the OS +     │
                       │  installs tools + brings up Docker   │
                       │  Compose, pulling ghcr.io images.    │
                       └──────────────────────────────────────┘
```

## Status

**`init` — fully wired.** Full Phase 1 of the runbook: prompts → Cloudflare 5-scope probe → Terraform Cloud verify → GitHub template clone → 5 repo secrets seeded → branch + prod.tfvars committed → PR opened → pgsodium key generated → (after operator merges PR) Terraform apply polled → Tunnel token retrieved + saved to the macOS Keychain.

**`bootstrap` — fully wired.** Phase 2 on the Mac Studio: macOS sanity (auto-restart, disk sleep), Homebrew + tool installs (gh, pnpm, jq, cloudflared, rclone, ollama, docker, tailscale), GitHub + Tailscale signin prompts, pgsodium key + Tunnel token read from the Studio's Keychain (or pasted in once if first run on that machine, then persisted), LaunchAgent written + loaded, ghcr.io login, Ollama models pulled + warmed, region repo located or cloned, `docker compose pull && up -d`, health-check loop until everything reports `(healthy)`.

**`verify` — scaffold stub.** Type-safe argument parsing only; prints a roadmap-style message and exits.

**`region`** — fully wired. Scaffolds schema-valid region configs for the `OpusPopuli/opuspopuli-regions` repo.

### Roadmap

- **v0.1.0** ✅ `init` end-to-end + `region` scaffolder.
- **v0.2.0** ✅ `bootstrap` fully wired on the Studio side.
- **v0.3.0** — `verify` fully wired: TLS + GraphQL + cosign signature checks.
- **v0.4.0** — Resend domain + DKIM automation, drift detection, automated backup-restore drill.

## Stack (2026)

- Node 22 LTS (native `fetch`, native test runner — no polyfills)
- TypeScript strict + `verbatimModuleSyntax`
- ESM-only — no CJS shim
- [`commander`](https://github.com/tj/commander.js) v13 for argument parsing
- [`@clack/prompts`](https://github.com/bombshell-dev/clack) for the interactive UI
- [`@octokit/rest`](https://github.com/octokit/rest.js) for GitHub
- [`cloudflare`](https://github.com/cloudflare/cloudflare-typescript) official SDK
- [`execa`](https://github.com/sindresorhus/execa) for shell-out
- [`picocolors`](https://github.com/alexeyraspopov/picocolors) for terminal colors
- [`zod`](https://github.com/colinhacks/zod) for runtime validation
- [`vitest`](https://vitest.dev) for tests
- [`tsup`](https://tsup.egoist.dev) for the single-file ESM build
- `oxlint` (fast, Rust-based) for pre-commit lint; ESLint v9 flat config for the full CI pass

## Contributing

This is a young project against the still-stabilizing `opuspopuli-node` template. PRs welcome; please open an issue first to discuss anything non-trivial.

```bash
pnpm install
pnpm dev -- --help          # run from source
pnpm test                   # vitest
pnpm build                  # tsup → dist/
node dist/cli.js --help     # test the built binary
```

## License

[AGPL-3.0-or-later](./LICENSE). The Opus Populi platform code is AGPL-3.0 + dual commercial; this CLI inherits the AGPL-3.0 terms.

## Related

- [`OpusPopuli/opuspopuli-node`](https://github.com/OpusPopuli/opuspopuli-node) — the per-region deployment template this CLI creates from.
- [`OpusPopuli/opuspopuli-regions`](https://github.com/OpusPopuli/opuspopuli-regions) — declarative region configs; `create-op-node region` scaffolds one.
- [`OpusPopuli/opuspopuli`](https://github.com/OpusPopuli/opuspopuli) — the central monorepo that builds + publishes `ghcr.io/opuspopuli/*` images.
- [`OpusPopuli/prompt-service`](https://github.com/OpusPopuli/prompt-service) — private prompt-template service consumed by every node.
