/**
 * Shared invariants reused across libs + commands. Each constant has exactly
 * one definition so a format change can't drift between callers (which
 * happened during review: the pgsodium-key shape was hand-rolled in three
 * places).
 */

/** A pgsodium master key is 32 bytes of CSPRNG output, encoded as 64
 *  lowercase hex characters. Match it everywhere with this regex so an
 *  uppercase-hex or wrong-length value gets a consistent reason. */
export const PGSODIUM_KEY_RE = /^[a-f0-9]{64}$/;

/** Allowed character set for a Cloudflare Tunnel token before we
 *  interpolate it into a launchd plist string. JWT-style tokens
 *  (header.payload.signature) use base64-url — letters, digits, `-`,
 *  `_`, `.`, `=`. We deliberately reject anything outside that set so
 *  a crafted token can't inject XML attributes or break the plist
 *  string content.
 *
 *  Stricter than SAFE_LAUNCHCTL_VALUE_RE on purpose: Cloudflare Tunnel
 *  tokens are guaranteed base64url by the issuer, so allowing `+` or `/`
 *  here would silently accept malformed tokens that would later fail at
 *  cloudflared startup with a less actionable error. Kept separate from
 *  SAFE_LAUNCHCTL_VALUE_RE for that reason. */
export const TUNNEL_TOKEN_RE = /^[A-Za-z0-9_\-.=]+$/;

/** Operator-friendly path safety check used before interpolating a path
 *  into a launchd `sh -c` command. Any shell metacharacter would let an
 *  attacker-supplied path execute arbitrary code at every login. The set
 *  permits everything macOS allows in a normal path (letters, digits,
 *  `/`, `-`, `_`, `.`, space) — and rejects `;`, `$`, backticks, quotes,
 *  newlines, etc. */
export const SAFE_PATH_RE = /^[A-Za-z0-9_\-./ ]+$/;

/** Character set allowed for any value we interpolate into the launchd
 *  `sh -c` body as a `launchctl setenv VAR "<value>"` argument. Permits
 *  every character that base64 (`+`, `/`, `=`), base64url (`-`, `_`), and
 *  JWT (`.`) produce, plus alphanumerics — covers JWT_SECRET and the signed
 *  Supabase tokens (which use JWT shape `xxx.yyy.zzz`). Rejects shell
 *  metacharacters (`;`, `$`, backticks, quotes, spaces, newlines) that
 *  would let a tampered value inject commands into the login session.
 *
 *  POSTGRES_PASSWORD and DASHBOARD_PASSWORD use the stricter
 *  URL_SAFE_PASSWORD_RE — they land in postgres:// URIs where `+`/`/`/`=`
 *  cause parser ambiguity. */
export const SAFE_LAUNCHCTL_VALUE_RE = /^[A-Za-z0-9+/=._-]+$/;

/** Subset of SAFE_LAUNCHCTL_VALUE_RE for values that ALSO land in URI
 *  components (postgres:// connection strings, basic-auth headers).
 *  base64url alphabet — no `+`, no `/`, no `=`. */
export const URL_SAFE_PASSWORD_RE = /^[A-Za-z0-9_-]+$/;

/** Same shape as TUNNEL_TOKEN_RE but documented separately because the
 *  SUPABASE_URL value also lands in the plist and we want to allow `://`
 *  and `:` for the port. Letters, digits, `-`, `_`, `.`, `:`, `/`. */
export const SAFE_URL_RE = /^[A-Za-z0-9:/_.-]+$/;

/** Default network timeout used by `verify`'s probes (TLS handshake, HTTP
 *  GET /health, GraphQL POST). One number so tls.ts and http.ts don't drift. */
export const VERIFY_NETWORK_TIMEOUT_MS = 10_000;

/** First N chars of a probe response body that get echoed back to the
 *  operator for diagnostics. Capped low because the wizard renders this
 *  inline; for the real body, use `curl -v` and friends. */
export const BODY_PREVIEW_MAX = 200;
