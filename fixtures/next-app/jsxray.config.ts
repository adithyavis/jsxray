import { defineConfig } from '@jsxray/core';

export default defineConfig({
  url: 'http://localhost:3100',
  personas: [{ id: 'anon' }],
  seedRoutes: ['/'],
  bounds: { maxDepth: 3, maxStates: 30, actionCap: 8, timeoutMs: 120000 },
});
