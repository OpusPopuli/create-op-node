# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/OpusPopuli/create-op-node/releases/tag/v0.1.0
