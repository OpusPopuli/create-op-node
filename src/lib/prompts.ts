/**
 * Tiny shared helper around @clack/prompts' cancel sentinel.
 *
 * Every wizard subcommand wants the same shape: ask for a value, if the
 * operator hit Ctrl-C / Esc, exit cleanly with a "Cancelled." note. Without
 * this helper each call site duplicates the `p.isCancel` check + `p.cancel`
 * + `process.exit(0)`.
 *
 * Keeping it dead-simple — no return-value transformation, no async, no
 * exit-code override. Subcommands that want a different exit policy
 * shouldn't use this helper.
 */

import * as p from '@clack/prompts';

export function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}
