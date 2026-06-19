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
 *  string content. */
export const TUNNEL_TOKEN_RE = /^[A-Za-z0-9_\-.=]+$/;

/** Operator-friendly path safety check used before interpolating a path
 *  into a launchd `sh -c` command. Any shell metacharacter would let an
 *  attacker-supplied path execute arbitrary code at every login. The set
 *  permits everything macOS allows in a normal path (letters, digits,
 *  `/`, `-`, `_`, `.`, space) — and rejects `;`, `$`, backticks, quotes,
 *  newlines, etc. */
export const SAFE_PATH_RE = /^[A-Za-z0-9_\-./ ]+$/;
