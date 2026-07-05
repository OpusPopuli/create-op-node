// Base lint pass: ESLint recommended + typescript-eslint recommended.
// SonarJS rules live in `eslint.sonar.config.mjs` so the two passes give
// distinct signals in CI / pre-push — a sonarjs failure (cognitive
// complexity, duplication, hot-spot pattern) is reported separately from
// a basic-lint failure. Mirrors the setup in @opuspopuli/regions.
//
// We register the sonarjs plugin here but DO NOT enable any of its
// rules — that way `eslint-disable sonarjs/<rule>` directives in source
// are recognized as referring to a known (but inactive) rule and don't
// error out the base pass. Activation happens in the sonar config.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { sonarjs },
    linterOptions: {
      // `eslint-disable sonarjs/<rule>` directives in source files
      // target rules that only fire in the sonar pass. Without this,
      // the base pass would warn "unused eslint-disable directive."
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Base config uses no-console off, and the underscore-prefix escape
      // hatch for intentionally-unused args (carried over from the
      // original oxlint/eslint config).
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
);
