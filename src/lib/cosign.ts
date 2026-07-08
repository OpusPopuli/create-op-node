/**
 * `cosign verify` wrapper for the verify wizard.
 *
 * Keyless verification path: cosign maps the image to a Fulcio-issued
 * certificate, checks the certificate's identity (GitHub Actions workflow URL)
 * + OIDC issuer, AND consults the Rekor transparency log (cosign default,
 * `rekor.sigstore.dev`) for an inclusion proof. So a passing verify means
 * the image was signed by the expected workflow AND that signing event is
 * publicly logged.
 *
 * If `cosign` isn't on PATH we report it as a skip rather than a failure —
 * verify can still pass without it (TLS + GraphQL probes are load-bearing).
 */

import { safeExeca } from './exec.js';

export const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export interface CosignVerifyInput {
  image: string;
  /** Glob/regex passed as `--certificate-identity-regexp`. Defaults to the
   *  publishing workflow path in the opuspopuli-node template. */
  certificateIdentityRegexp?: string;
  /** OIDC issuer that signed the image. Defaults to GitHub Actions. */
  certificateOidcIssuer?: string;
}

export type CosignVerifyResult =
  | { ok: true; output: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

// Ref-pinned to the exact publishing workflow. The opuspopuli `release.yml`
// signs each image (keyless cosign) on push to main, and can also be run
// ad-hoc via `workflow_dispatch` from a fix branch for an arm64 build — both
// carry a `.../release.yml@refs/heads/<branch>` certificate identity. We pin
// the workflow FILE (not `.../workflows/.*`, which would accept any workflow
// in the repo that ever obtained a Fulcio cert) and allow any `refs/heads/`
// branch so legitimate ad-hoc builds still verify. (#34)
//
// Provenance of each segment (the cert SAN is GitHub's OIDC `job_workflow_ref`,
// format `<owner>/<repo>/.github/workflows/<file>@<ref>`):
//   - `OpusPopuli/opuspopuli` — the repo's canonical path (GitHub API), the
//     exact casing OIDC emits.
//   - `release.yml@refs/heads/` — the actual signing workflow + trigger
//     (push to main / workflow_dispatch), confirmed in opuspopuli/release.yml.
// End-to-end confirmation against a live image's Fulcio cert (needs `cosign` +
// a published image) lands with the fail-closed bootstrap gate, where a
// `--certificate-identity-regexp` override is exposed as the escape valve.
export const DEFAULT_IDENTITY_REGEXP =
  '^https://github\\.com/OpusPopuli/opuspopuli/\\.github/workflows/release\\.yml@refs/heads/.*$';

/**
 * Verify a single OCI image's cosign signature against the GitHub Actions
 * OIDC issuer. Returns one of three shapes:
 *
 *   - `{ ok: true }` — signature valid.
 *   - `{ ok: false, skipped: true }` — cosign binary not on PATH; caller
 *     should render this as a warning, not a failure.
 *   - `{ ok: false, skipped: false }` — cosign ran and rejected the image.
 */
export async function cosignVerifyImage(input: CosignVerifyInput): Promise<CosignVerifyResult> {
  const idRegex = input.certificateIdentityRegexp ?? DEFAULT_IDENTITY_REGEXP;
  const issuer = input.certificateOidcIssuer ?? COSIGN_OIDC_ISSUER;

  const res = await safeExeca('cosign', [
    'verify',
    '--certificate-identity-regexp',
    idRegex,
    '--certificate-oidc-issuer',
    issuer,
    input.image,
  ]);

  if (res === null) {
    return {
      ok: false,
      skipped: true,
      reason: '`cosign` not on PATH (install with `brew install cosign` and rerun to enable signature checks)',
    };
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      reason: `cosign verify ${input.image} failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true, output: res.stdout || res.stderr };
}
