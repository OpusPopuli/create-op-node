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
                       │  └─ verify        Terraform Cloud    │
                       │                   `op` CLI (optional)│
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

**v0.0.1 — scaffold only.** The 3 subcommands exist with type-safe argument parsing and the Cloudflare 5-scope probe. The interactive prompts collect inputs but stop before doing destructive work. Iterating in the open against the OpusPopuli/opuspopuli-node template as it stabilizes.

### Roadmap

- **v0.1.0** — `init` fully wired: GitHub template clone, secret seeding, prod.tfvars generation, pgsodium key flow, first PR, Tunnel token retrieval.
- **v0.2.0** — `bootstrap` fully wired: macOS config, brew installs, Docker Desktop setup, Tailscale, repo clone, LaunchAgent, ghcr.io login, Ollama, `docker compose up`.
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
- [`OpusPopuli/opuspopuli`](https://github.com/OpusPopuli/opuspopuli) — the central monorepo that builds + publishes `ghcr.io/opuspopuli/*` images.
- [`OpusPopuli/prompt-service`](https://github.com/OpusPopuli/prompt-service) — private prompt-template service consumed by every node.
