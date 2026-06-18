import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  minify: false,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // Single-file shebang so `create-op-node` is directly executable from the
  // npm-published bin script.
  banner: { js: '#!/usr/bin/env node' },
  // No need to bundle node built-ins.
  external: [],
});
