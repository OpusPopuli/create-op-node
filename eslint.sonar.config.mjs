// SonarJS-only lint pass — separate from the base config in
// `eslint.config.mjs` so cognitive-complexity / duplication / hot-spot
// findings produce a distinct signal in pre-push and CI. Mirrors the
// `eslint.sonar.config.mjs` pattern in @opuspopuli/regions and the
// `.eslintrc.sonar.js` pattern in prompt-service.
//
// Invoke via `pnpm lint:sonar`. The base `pnpm lint` does NOT run these
// rules, so both passes must succeed for code to be fully clean.
//
// NOTE: this pass is not yet wired into CI. It surfaces pre-existing
// findings (mostly cognitive-complexity in the command flows) that are
// being burned down in #37; once green, the CI step and the
// `prepublishOnly` chain get the `lint:sonar` gate added back.
//
// We pull in the typescript-eslint parser (but not its rules) so the
// sonarjs rules can analyze .ts files. Without the parser, sonarjs
// either errors on TS syntax or silently skips TS files.

import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
    // Register the typescript-eslint plugin (without enabling any rules)
    // so `eslint-disable @typescript-eslint/<rule>` directives in source
    // files are recognized rather than flagged as unknown rules in this
    // pass. tseslint.plugin re-exports the plugin object without needing a
    // separate `@typescript-eslint/eslint-plugin` package install.
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: {
      // Mirror image of the base config: typescript-eslint disables
      // here target rules that fire in the BASE pass, not this one.
      reportUnusedDisableDirectives: 'off',
    },
  },
  sonarjs.configs.recommended,
  {
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
);
