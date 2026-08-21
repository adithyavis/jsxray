import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(here, 'packages', name, 'src/index.ts');

export default defineConfig({
  resolve: {
    // Test the sources, not the last build output (technical §16).
    alias: {
      '@jsxray/core': pkg('core'),
      '@jsxray/providers': pkg('providers'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
