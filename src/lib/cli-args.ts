/**
 * argv helpers for the CLI entrypoint. Kept in their own module (not `cli.ts`)
 * so they're unit-testable without triggering `cli.ts`'s top-level
 * `program.parseAsync` side effect on import.
 */

/** Program-level flags Commander handles itself — never route these to a
 *  subcommand. */
const GLOBAL_FLAGS = new Set(['-v', '--version', '-h', '--help']);

/**
 * Inject the default `init` subcommand when the caller didn't name one, so the
 * create-* convention holds: `npx create-op-node` AND `npx create-op-node
 * --region us-ca` both "just work" instead of erroring on an unknown program
 * option. (#36 — previously only the zero-arg case was handled.)
 *
 * `argv` is the full `process.argv` (`[node, script, ...rest]`). Returns a new
 * array — the input is not mutated. `init` is inserted before the first user
 * arg UNLESS that arg is already a known subcommand or a global flag
 * (`-v`/`--version`/`-h`/`--help`).
 */
export function withDefaultSubcommand(argv: string[], known: readonly string[]): string[] {
  const first = argv[2];
  if (first !== undefined && (known.includes(first) || GLOBAL_FLAGS.has(first))) {
    return argv;
  }
  return [...argv.slice(0, 2), 'init', ...argv.slice(2)];
}
