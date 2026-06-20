# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0](https://github.com/OpusPopuli/create-op-node/compare/v0.6.0...v0.7.0) (2026-06-20)


### Features

* **bootstrap:** interactive LLM model picker (Qwen-only) + time estimates on long phases ([36e8049](https://github.com/OpusPopuli/create-op-node/commit/36e80493a2e0f712bd6b5153b09ecc5490cd026f))
* **bootstrap:** interactive LLM picker (Qwen-only) + time estimates ([cec5c79](https://github.com/OpusPopuli/create-op-node/commit/cec5c7974fd46cb9179cb2413fc822dc13d1cb7a))

## [0.6.0] — 2026-06-19

### Added

- **`bootstrap --llm-model <model>`** and **`--embedding-model <model>`**
  flags. Override the defaults (`qwen3.5:9b` and `nomic-embed-text`)
  with any Ollama model identifier (e.g. `llama3.3:70b`,
  `qwen2.5:72b`). Bootstrap pulls + warms whichever models you pick,
  embedding model first (small, fast operator feedback) then the LLM.
- **LaunchAgent exports `LLM_MODEL` and `EMBEDDINGS_MODEL`** into the
  launchd session. Docker Desktop inherits them, so the knowledge
  service reads them via env without operator edits to
  `.env.production`. The plist's `sh -c` body validates both values
  against a model-name safe set (`[A-Za-z0-9][A-Za-z0-9._:/-]*`) —
  same defense-in-depth pattern as the existing TUNNEL_TOKEN
  injection guard.
- `DEFAULT_LLM_MODEL` and `DEFAULT_EMBEDDING_MODEL` exported scalars in
  `src/lib/ollama.ts` (existing `DEFAULT_MODELS` is now composed from
  them, so they can't drift).
- `resolveModels(opts)` exported pure helper paralleling
  `resolveComposeFiles`. Five unit tests cover default fallback,
  per-flag override, and the embedding-first ordering invariant.
- README "Choosing the LLM model" subsection with both single-flag and
  two-flag examples, a callout that `--embedding-model` only takes
  effect with `EMBEDDINGS_PROVIDER=ollama`, and a callout documenting
  the template-side `${LLM_MODEL:-default}` contract.

## [0.5.0] — 2026-06-19

### Added

- **`init --local-only`** — symmetric with `bootstrap --local-only`. Creates
  the region repo from template (private, no public exposure), generates the
  pgsodium master key, saves it to Keychain. Skips: Cloudflare 5-scope
  probe, Terraform Cloud verification, repo secrets seeding, prod.tfvars
  + PR generation, the post-merge TFC apply poll, and the tunnel token
  retrieval. The `bootstrap --local-only` happy path now expects `init`
  to have run first (the inline pgsodium auto-generation in bootstrap
  stays as a safety net for operators who skip init entirely).
- Warns when `--local-only` is combined with production-only flags
  (`--domain`, `--cf-token`, `--cf-account`, `--cf-zone`, `--tf-token`,
  `--tf-org`, `--skip-wait`) so they don't appear to silently no-op.
- `listIgnoredLocalOnlyFlags` and `summarizePhases` pure helpers exported
  for testing; first unit-test coverage for `init.ts` (8 tests).

### Changed

- Init's flow now mirrors bootstrap: local-only is a first-class mode on
  both sides, with consistent CLI semantics and outros pointing at the
  next step. Production flow unchanged byte-for-byte.
- v0.4.0's local-only flow worked but expected operators to skip `init`
  entirely; bootstrap's locate-or-clone phase would then fail because
  the region repo wasn't on GitHub yet. v0.5.0 makes `init --local-only`
  the documented start of the local-only flow — it creates the region
  repo from template, so bootstrap's clone fallback finds it cleanly.
  The inline pgsodium auto-generation in bootstrap from v0.4.0 stays as
  a safety net for operators who run bootstrap without init.

### Refactored

- Cloudflare + TFC config collection lifted into `collectPublicConfig`
  returning a `PublicConfig | null` shape — eliminates the loose
  `let cfToken; let tfOrg; ...` + non-null-assertion pattern. TS now
  narrows the production-only fields automatically.

## [0.4.0] — 2026-06-19

### Added

- **`bootstrap --local-only`** — runs the Studio for local dev / testing
  without Cloudflare. No Tunnel token required; the LaunchAgent omits
  `TUNNEL_TOKEN`; `cloudflared` stays down (it's now gated behind the
  `public` compose profile, which `--local-only` doesn't activate); the
  pgsodium key is auto-generated inline if not already in Keychain
  (so `init` is unnecessary). Designed for the "frontend on laptop +
  Studio on LAN/Tailscale, sync data while iterating" workflow. The
  same Studio promotes to a full public deploy by re-running `bootstrap`
  without the flag.
- `composeOptions.profiles` — pass-through to `docker compose --profile`,
  defaulted to `['public']` in production mode and `[]` in local-only.

### Changed

- `renderLaunchAgentPlist` and `setupLaunchAgent` now accept an optional
  `tunnelToken`. When omitted, the plist sets only `PGSODIUM_ROOT_KEY`.
  Existing production callers (which always pass a token) are unaffected.

### Requires

- `OpusPopuli/opuspopuli-node` template with `profiles: [public]` on the
  cloudflared service in `docker-compose-prod.yml`. Operators who cloned
  the template before that landed will see cloudflared start regardless
  of the CLI flag — pull the latest from the template (`gh repo sync`
  against your fork, or re-create from template) before using
  `--local-only`. Future template releases (when we cut them) will be
  pinned by version here.

## [0.3.0] — 2026-06-19

### Changed

- **Secret store: 1Password → macOS Keychain.** `init` writes the pgsodium
  master key + Cloudflare Tunnel token to the operator's login keychain via
  the built-in `security` CLI. `bootstrap` reads from the Studio's local
  Keychain; on a first-run miss, it prompts the operator to paste the value
  (with format validation), then persists locally so re-runs read straight
  through. Removes the 1Password CLI dependency + paid-sub assumption.

### Removed

- `--vault` flag on `init` and `bootstrap` (no concept of vaults in Keychain).
- `src/lib/onepassword.ts` and its tests.

### Notes

- macOS Keychain items written via the `security` CLI don't sync to
  iCloud Keychain (no `kSecAttrSynchronizable` flag exposed). Operators
  ferry the secret to the Studio once via AirDrop / `security find-generic-
  password` output / scp. The paste prompt in bootstrap handles the
  transport step.

## [0.2.0] — 2026-06-19

### Added

- **`reset`** — reverses the Mac Studio side of bootstrap. Three phases
  in reverse-bootstrap order: `docker compose down` (volumes preserved
  by default; `--wipe-data` destroys them after a typed region-label
  retype), `launchctl unload` + remove plist + remove pgsodium key file
  (`--keep-key-file` preserves the key), and `docker logout` against
  `ghcr.io` (or `--registry <reg>`). Continue-on-failure design: a
  docker daemon down doesn't block LaunchAgent / logout cleanup. Cloud-
  side state untouched.
- `composeDown` + `dockerLogout` helpers in `src/lib/docker.ts`.
- `teardownLaunchAgent` promoted from a test seam to a public API
  (returns per-step results so the caller knows what was removed).
- `unwrap()` extracted to `src/lib/prompts.ts` — five commands now share
  one definition instead of redefining it.

### Changed

- README "Resetting the Studio" section added between Bootstrap and
  Verify, with the credential-helper caveat documented (we only clear
  the store entry, not all credential caches).

## [0.1.0] — 2026-06-18

First feature-complete release. All four subcommands wired end-to-end and
testable from `npx create-op-node`.

### Added

- **`init`** — interactive wizard for first-time setup: probes the
  Cloudflare API token for the 5 required scopes, creates the node repo
  from the `opuspopuli-node` template, seeds the 5 GitHub Secrets, opens
  the first PR with a generated `environments/prod.tfvars`, generates the
  pgsodium master key (64-hex), and stores it + the Cloudflare Tunnel
  token in 1Password.
- **`bootstrap`** — Mac Studio side. Detects macOS + Apple Silicon,
  installs the Homebrew package set (git, gh, pnpm, jq, cloudflared,
  rclone, ollama, docker, tailscale), ensures gh + Tailscale auth,
  locates or clones the region node repo, reads secrets from 1Password,
  writes the LaunchAgent plist (with shell-injection guards on the
  pgsodium key file path), logs into ghcr.io, primes Ollama (auto-starts
  via `brew services` if not running, pulls + warms required models),
  runs `docker compose up -d`, and polls `compose ps` until every dep
  container reports `(healthy)`.
- **`verify`** — off-LAN node-health probe. TLS handshake (with
  days-to-expiry warning), `GET /health`, GraphQL `{ __typename }` POST,
  optional Cloudflare Tunnel connector count via the CF API
  (`--cf-token-file` to avoid `ps` leakage), and optional `cosign verify`
  (keyless against the GitHub Actions OIDC issuer + Rekor transparency
  log). `--show-skipped` to surface phases that were silently
  configured-off.
- **`region`** — interactive generator for `@opuspopuli/regions` config
  files, validated against the vendored `region-plugin.schema.json` plus
  the cross-field rules from the regions repo (semver shape, FIPS length
  per level, county-id-prefixed-by-parent, no duplicate data sources).
  Writes to the canonical path. Non-interactive flags available for
  scripting.

### Security

- pgsodium master key file mode `0400`, plist mode `0600`.
- LaunchAgent plist refuses tunnel tokens or key-file paths containing
  characters outside the documented safe sets — defense in depth against
  a hostile path becoming shell injection in launchd's `sh -c` body.
- `pnpm audit`, `trivy`, `gitleaks` all clean.

[0.6.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.6.0
[0.5.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.5.0
[0.4.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.4.0
[0.3.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.3.0
[0.2.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.1.0
