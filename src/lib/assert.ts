/**
 * Compile-time exhaustiveness guard. Passing a value that TypeScript has
 * not narrowed to `never` is a type error, so an unhandled `switch` / `if`
 * variant fails the build. At runtime this is a no-op — callers keep their
 * existing control flow (fall through, `return`, etc.).
 */
export function assertNever(_value: never): void {
  /* compile-time only */
}
