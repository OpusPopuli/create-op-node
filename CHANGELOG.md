# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.2](https://github.com/OpusPopuli/create-op-node/compare/v0.12.1...v0.12.2) (2026-07-11)


### Bug Fixes

* **reset:** hydrate placeholder env so `compose down` works with ${VAR:?} vars ([#87](https://github.com/OpusPopuli/create-op-node/issues/87)) ([32f9459](https://github.com/OpusPopuli/create-op-node/commit/32f94594e9f2180f52d9f15cbfc87429524ba107)), closes [#85](https://github.com/OpusPopuli/create-op-node/issues/85)

## [0.12.1](https://github.com/OpusPopuli/create-op-node/compare/v0.12.0...v0.12.1) (2026-07-11)


### Bug Fixes

* **cli:** collect repeated --compose-file into an array ([#83](https://github.com/OpusPopuli/create-op-node/issues/83)) ([5579493](https://github.com/OpusPopuli/create-op-node/commit/557949343fd1d08798a2034ce575475443ee83ef)), closes [#82](https://github.com/OpusPopuli/create-op-node/issues/82)

## [0.12.0](https://github.com/OpusPopuli/create-op-node/compare/v0.11.3...v0.12.0) (2026-07-09)


### Features

* **bootstrap:** generate gateway/grafana secrets + public-profile guard ([#27](https://github.com/OpusPopuli/create-op-node/issues/27)) ([628878a](https://github.com/OpusPopuli/create-op-node/commit/628878aaa39d9f3f5362acb425ef30a6f05af15c))
* **bootstrap:** generate gateway/grafana secrets and guard tunnel exposure ([5b9fcc5](https://github.com/OpusPopuli/create-op-node/commit/5b9fcc5b5f5f800fb7047a790c0bffd6f1c26885)), closes [#27](https://github.com/OpusPopuli/create-op-node/issues/27)

## [0.11.3](https://github.com/OpusPopuli/create-op-node/compare/v0.11.2...v0.11.3) (2026-07-09)


### Bug Fixes

* **polling:** retry a transient output fetch instead of reporting output-missing ([ded70a7](https://github.com/OpusPopuli/create-op-node/commit/ded70a7e647792a0d18c75455ebc864a43868b7a))
* **polling:** retry a transient output fetch instead of reporting output-missing ([f5d6137](https://github.com/OpusPopuli/create-op-node/commit/f5d6137bb6d3cb45079b75442eb1cb11151b3549)), closes [#59](https://github.com/OpusPopuli/create-op-node/issues/59)

## [0.11.2](https://github.com/OpusPopuli/create-op-node/compare/v0.11.1...v0.11.2) (2026-07-08)


### Bug Fixes

* **init:** query the real default branch when adopting an existing repo ([b0fe662](https://github.com/OpusPopuli/create-op-node/commit/b0fe6622b3ba27edec294c98717f3730c005563a))
* **init:** query the real default branch when adopting an existing repo ([1665984](https://github.com/OpusPopuli/create-op-node/commit/166598434c9e7c5a17ebe1d5ed494ee00e7a2666)), closes [#41](https://github.com/OpusPopuli/create-op-node/issues/41)

## [0.11.1](https://github.com/OpusPopuli/create-op-node/compare/v0.11.0...v0.11.1) (2026-07-08)


### Bug Fixes

* cleanup nits — cat quoting, teardown ok flag, default-subcommand routing ([a2ad94f](https://github.com/OpusPopuli/create-op-node/commit/a2ad94f7221b47a372c590b819d1aab39f7f08f7))
* cleanup nits — cat quoting, teardown ok flag, default-subcommand routing ([a354c05](https://github.com/OpusPopuli/create-op-node/commit/a354c05cfb1bc584bb6657d9948bff95818cd532)), closes [#36](https://github.com/OpusPopuli/create-op-node/issues/36)

## [0.11.0](https://github.com/OpusPopuli/create-op-node/compare/v0.10.17...v0.11.0) (2026-07-08)


### Features

* **bootstrap:** fail-closed cosign signature gate before pull ([f61c0d7](https://github.com/OpusPopuli/create-op-node/commit/f61c0d7abeb97a580ca1c0f56a8309e7a5455501))
* **bootstrap:** fail-closed cosign signature gate before pull ([8bab24b](https://github.com/OpusPopuli/create-op-node/commit/8bab24b9e79b75adfda60237a852a826ceb02469)), closes [#34](https://github.com/OpusPopuli/create-op-node/issues/34)

## [0.10.17](https://github.com/OpusPopuli/create-op-node/compare/v0.10.16...v0.10.17) (2026-07-08)


### Bug Fixes

* **cosign:** ref-pin the signature identity to release.yml ([97eff19](https://github.com/OpusPopuli/create-op-node/commit/97eff19fbce17f735c850138b764a020f96919c9))
* **cosign:** ref-pin the signature identity to release.yml ([385f93e](https://github.com/OpusPopuli/create-op-node/commit/385f93e236ca392d8150861ce72d09a622ab9f91))

## [0.10.16](https://github.com/OpusPopuli/create-op-node/compare/v0.10.15...v0.10.16) (2026-07-08)


### Bug Fixes

* **init:** seed repo secrets via Octokit + libsodium under the PAT ([2a1d8ef](https://github.com/OpusPopuli/create-op-node/commit/2a1d8efe9e348f30b4d3874c6e99945faaef17b1))
* **init:** seed repo secrets via Octokit + libsodium under the PAT ([ec084b9](https://github.com/OpusPopuli/create-op-node/commit/ec084b945d4c9010b16170eee5d8043402602c07)), closes [#32](https://github.com/OpusPopuli/create-op-node/issues/32)

## [0.10.15](https://github.com/OpusPopuli/create-op-node/compare/v0.10.14...v0.10.15) (2026-07-08)


### Bug Fixes

* **polling:** check workspace before sleeping in the discovery loop ([291ad49](https://github.com/OpusPopuli/create-op-node/commit/291ad49d5175078e3a0889e0d19f802df650c186))
* **polling:** check workspace before sleeping in the discovery loop ([4d0da64](https://github.com/OpusPopuli/create-op-node/commit/4d0da6456bb96fbf78875c4e19e91a2c3aa2e6c1)), closes [#35](https://github.com/OpusPopuli/create-op-node/issues/35)

## [0.10.14](https://github.com/OpusPopuli/create-op-node/compare/v0.10.13...v0.10.14) (2026-07-08)


### Bug Fixes

* **ollama:** add request timeouts to health + warm probes ([52e8fb1](https://github.com/OpusPopuli/create-op-node/commit/52e8fb1b7a6fa6212d3c7d0d4d89e7e5ac86ff87))
* **ollama:** add request timeouts to health + warm probes ([8d1ff58](https://github.com/OpusPopuli/create-op-node/commit/8d1ff58e5fa2ab7f91ce2310416b340f9b597aac)), closes [#31](https://github.com/OpusPopuli/create-op-node/issues/31)

## [0.10.13](https://github.com/OpusPopuli/create-op-node/compare/v0.10.12...v0.10.13) (2026-07-08)


### Bug Fixes

* **cloudflare:** add request timeout + degrade network failures gracefully ([b4aa096](https://github.com/OpusPopuli/create-op-node/commit/b4aa09632481f61a77572205eed2fecdd20fa210))
* **cloudflare:** add request timeout + degrade network failures gracefully ([3075c6a](https://github.com/OpusPopuli/create-op-node/commit/3075c6a67a6ac485819af31d6eb00ee250a7e17a))

## [0.10.12](https://github.com/OpusPopuli/create-op-node/compare/v0.10.11...v0.10.12) (2026-07-08)


### Bug Fixes

* **tfc:** add request timeouts + degrade network failures gracefully ([7159518](https://github.com/OpusPopuli/create-op-node/commit/7159518eaf98aea1f67b460ff7a472a4ac9f40c2))
* **tfc:** add request timeouts + degrade network failures gracefully ([b9a0aa0](https://github.com/OpusPopuli/create-op-node/commit/b9a0aa0cfa043ddc5fece473412905e090cc4634)), closes [#31](https://github.com/OpusPopuli/create-op-node/issues/31)

## [0.10.11](https://github.com/OpusPopuli/create-op-node/compare/v0.10.10...v0.10.11) (2026-07-08)


### Bug Fixes

* **bootstrap:** align llm-model docs + picker hints with actual defaults ([5d5913c](https://github.com/OpusPopuli/create-op-node/commit/5d5913cdbd76c05779b9ef916745c44a73871186))
* **bootstrap:** align llm-model docs + picker hints with actual defaults ([c1a2499](https://github.com/OpusPopuli/create-op-node/commit/c1a24998464064eb0a1bf96483c9446fd1b4077c)), closes [#33](https://github.com/OpusPopuli/create-op-node/issues/33)

## [0.10.10](https://github.com/OpusPopuli/create-op-node/compare/v0.10.9...v0.10.10) (2026-07-07)


### Refactors

* **lib:** extract helpers to clear remaining complexity findings ([3b8b533](https://github.com/OpusPopuli/create-op-node/commit/3b8b5337d8269729cfb173d18c9bd8c12f9596f0))
* **lib:** extract helpers to clear remaining complexity findings ([b5e6167](https://github.com/OpusPopuli/create-op-node/commit/b5e61671dd4779afe6733f920b7aefb3a3c14a06)), closes [#37](https://github.com/OpusPopuli/create-op-node/issues/37)

## [0.10.9](https://github.com/OpusPopuli/create-op-node/compare/v0.10.8...v0.10.9) (2026-07-06)


### Refactors

* **verify:** extract phase helpers to cut handler complexity ([202b7f9](https://github.com/OpusPopuli/create-op-node/commit/202b7f926de09f76c6725e36dd55461504328670))
* **verify:** extract phase helpers to cut handler complexity ([ea4db7d](https://github.com/OpusPopuli/create-op-node/commit/ea4db7d1b5c825f2321729e16622af430076e67a)), closes [#37](https://github.com/OpusPopuli/create-op-node/issues/37)

## [0.10.8](https://github.com/OpusPopuli/create-op-node/compare/v0.10.7...v0.10.8) (2026-07-06)


### Refactors

* **reset:** extract phase helpers to cut handler complexity ([dadb350](https://github.com/OpusPopuli/create-op-node/commit/dadb350bd5bc4cdbd6f03840e07ab58b58331015))
* **reset:** extract phase helpers to cut handler complexity ([4280429](https://github.com/OpusPopuli/create-op-node/commit/42804295f4bdd0b9c3e509ad759b3afcbf5628d8)), closes [#37](https://github.com/OpusPopuli/create-op-node/issues/37)

## [0.10.7](https://github.com/OpusPopuli/create-op-node/compare/v0.10.6...v0.10.7) (2026-07-06)


### Refactors

* **init:** extract phase helpers to cut handler complexity ([cc86886](https://github.com/OpusPopuli/create-op-node/commit/cc86886ee7e3df0ee67aacf6287e784a1daba1b9))
* **init:** extract phase helpers to cut handler complexity ([20b3dba](https://github.com/OpusPopuli/create-op-node/commit/20b3dba367df1fad265e182dba8417d5b8cee619)), closes [#37](https://github.com/OpusPopuli/create-op-node/issues/37)

## [0.10.6](https://github.com/OpusPopuli/create-op-node/compare/v0.10.5...v0.10.6) (2026-07-05)


### Refactors

* **bootstrap:** extract phase helpers to cut handler complexity ([d5799df](https://github.com/OpusPopuli/create-op-node/commit/d5799dfba567ffa36536f111921e083835407845))
* **bootstrap:** extract phase helpers to cut handler complexity ([407caf4](https://github.com/OpusPopuli/create-op-node/commit/407caf434a7778ccefa9bb75d625d6f289579274)), closes [#37](https://github.com/OpusPopuli/create-op-node/issues/37)

## [0.10.5](https://github.com/OpusPopuli/create-op-node/compare/v0.10.4...v0.10.5) (2026-07-05)


### Bug Fixes

* **lint:** rewrite super-linear regexes in src ([9b5789c](https://github.com/OpusPopuli/create-op-node/commit/9b5789ca38ad9bb28afd0ac4e0e13d3944326557))

## [0.10.4](https://github.com/OpusPopuli/create-op-node/compare/v0.10.3...v0.10.4) (2026-07-05)


### Refactors

* **lint:** clear cheap sonar findings in src ([68e8921](https://github.com/OpusPopuli/create-op-node/commit/68e892131c6260d7626292ed1f1cdefb45573047))

## [0.10.3](https://github.com/OpusPopuli/create-op-node/compare/v0.10.2...v0.10.3) (2026-07-05)


### Bug Fixes

* **lint:** restore working eslint gate on org-standard config ([a6e586d](https://github.com/OpusPopuli/create-op-node/commit/a6e586de999f3ec4ba1efdec6b83c9fb0c7b697e))
* **lint:** restore working eslint gate on org-standard config ([55979aa](https://github.com/OpusPopuli/create-op-node/commit/55979aaa724e4e7c0a6d9154bd17ad736b6c0aa8)), closes [#30](https://github.com/OpusPopuli/create-op-node/issues/30)

## [0.10.2](https://github.com/OpusPopuli/create-op-node/compare/v0.10.1...v0.10.2) (2026-06-26)


### Bug Fixes

* **wrapper:** distinguish keychain LOCKED (exit 36) from MISSING (exit 44) ([8a82c5f](https://github.com/OpusPopuli/create-op-node/commit/8a82c5f76206616446e0fd1be284a1ea7d3e4b1c))
* **wrapper:** distinguish keychain LOCKED (exit 36) from MISSING (exit 44) ([a154c03](https://github.com/OpusPopuli/create-op-node/commit/a154c03de659c82b4005a62879764b8cd8f9fafe))

## [0.10.1](https://github.com/OpusPopuli/create-op-node/compare/v0.10.0...v0.10.1) (2026-06-25)


### Bug Fixes

* **keychain:** SSH auto-unlock + errSecInteractionNotAllowed hint ([0b282b6](https://github.com/OpusPopuli/create-op-node/commit/0b282b68e0ffea6c8dc5d21b1e68293efe8cc9ec))
* **keychain:** SSH auto-unlock + errSecInteractionNotAllowed hint ([eb576ef](https://github.com/OpusPopuli/create-op-node/commit/eb576ef6d2e02a100c363db0bea080d68fe267dd))

## [0.10.0](https://github.com/OpusPopuli/create-op-node/compare/v0.9.1...v0.10.0) (2026-06-25)


### Features

* **bootstrap:** --node-type flag + prompt-service Keychain credentials ([9ba3ce4](https://github.com/OpusPopuli/create-op-node/commit/9ba3ce45cc12d1ac942ff1a5b3fb0648175cb8bb))
* **bootstrap:** --node-type flag + prompt-service Keychain credentials ([34094e7](https://github.com/OpusPopuli/create-op-node/commit/34094e767a8c6bb4cd8ae727eebc4c78330b86bb))

## [0.9.1](https://github.com/OpusPopuli/create-op-node/compare/v0.9.0...v0.9.1) (2026-06-21)


### Bug Fixes

* **bootstrap:** install op-compose wrapper for Keychain-on-demand env ([a519714](https://github.com/OpusPopuli/create-op-node/commit/a519714ea75859c0c355a5eb2f41f25c84360bcd))
* **bootstrap:** install op-compose wrapper for Keychain-on-demand env ([3cdc744](https://github.com/OpusPopuli/create-op-node/commit/3cdc74419ab179c0eed69590f492c0c6ab9fe461))
* **typecheck:** bracket-notation for ProcessEnv index access ([fe06046](https://github.com/OpusPopuli/create-op-node/commit/fe06046a6e4abb4d7f6891335809f116ac0006f7))

## [0.9.0](https://github.com/OpusPopuli/create-op-node/compare/v0.8.0...v0.9.0) (2026-06-20)


### Features

* auto-generate Supabase admin credentials into Keychain ([45e250c](https://github.com/OpusPopuli/create-op-node/commit/45e250c70a338b02dfd1a2728c41e01518fdbeec))
* auto-generate Supabase admin credentials into Keychain ([685182b](https://github.com/OpusPopuli/create-op-node/commit/685182b767ef6eb22be4db50a386b46af1ad5425))

## [0.8.0](https://github.com/OpusPopuli/create-op-node/compare/v0.7.0...v0.8.0) (2026-06-20)


### Features

* reset --wipe-images + auto-detect Studio RAM for LLM picker ([d3f3a49](https://github.com/OpusPopuli/create-op-node/commit/d3f3a49e840baa3b07057a4328747cc0e46a2165))
* reset --wipe-images + auto-detect Studio RAM for LLM picker default ([dfc81e0](https://github.com/OpusPopuli/create-op-node/commit/dfc81e0b3280d8daeffcf0115f308b9d5274e205))

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
