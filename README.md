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
5. **pgsodium master key** — generates a fresh 64-hex root key, stores it in 1Password (via the `op` CLI if available, otherwise prompts you to paste it once).
6. **Tunnel token retrieval** — after `terraform apply` lands, fetches the Tunnel token from Terraform Cloud outputs and stores it in 1Password alongside the pgsodium key.

Then on the Mac Studio itself:

```bash
npx create-op-node bootstrap
```

Configures macOS power settings, installs Homebrew + the CLI tool list, sets up Docker Desktop + Tailscale + Ollama, clones the node repo you created, materializes the pgsodium key from 1Password, writes the LaunchAgent plist, logs into ghcr.io, pulls + warms the LLM model, and finally `docker compose pull && up -d` brings the whole stack online. Health-check loop waits until all 10 containers are `(healthy)`.

And at any time after that:

```bash
npx create-op-node verify --domain your-domain.example
```

Off-LAN health probe of a live node — TLS, GraphQL reachability, cosign signature check on the running images.

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

## Why this exists

Each Opus Populi region is operated independently by a local maintainer — its own Cloudflare account, its own Mac Studio, its own domain. The full bootstrap is a few hours of manual steps across Cloudflare, GitHub, Terraform Cloud, macOS Setup Assistant, Docker Desktop, Tailscale, Ollama, and the node's own Docker Compose stack. Doable from the runbook, but error-prone.

This CLI exists to make that bootstrap **foolproof** — every prompt validates immediately, every secret is retrieved from a secure source (never echoed, never written to disk in plaintext), and every step has an explicit "what happens next" message. The goal is zero documentation reading required to get a node running.

The CLI itself never holds any credentials beyond the scope of a single command — secrets flow from your 1Password vault → through the CLI → directly into the destination (GitHub Secrets, Terraform Cloud workspace variables, Mac Studio LaunchAgent). Nothing persists in this process.

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

**`init` — fully wired.** Full Phase 1 of the runbook: prompts → Cloudflare 5-scope probe → Terraform Cloud verify → GitHub template clone → 5 repo secrets seeded → branch + prod.tfvars committed → PR opened → pgsodium key generated → (after operator merges PR) Terraform apply polled → Tunnel token retrieved + saved to 1Password.

**`bootstrap` — fully wired.** Phase 2 on the Mac Studio: macOS sanity (auto-restart, disk sleep), Homebrew + tool installs (gh, pnpm, jq, cloudflared, rclone, ollama, docker, tailscale), GitHub + Tailscale signin prompts, pgsodium key + Tunnel token read from 1Password, LaunchAgent written + loaded, ghcr.io login, Ollama models pulled + warmed, region repo located or cloned, `docker compose pull && up -d`, health-check loop until everything reports `(healthy)`.

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
