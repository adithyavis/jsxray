import type { ProviderRegistry } from '@jsxray/core';
import { usernamePasswordAuth } from './auth/username-password/index.js';
import { reactParser } from './parser/react/index.js';
import { playwrightRenderer } from './renderer/playwright/index.js';
import { nextRouter } from './router/next/index.js';
import { reactNavigationRouter } from './router/react-navigation/index.js';
import { reactRouterConfigRouter } from './router/react-router-config/index.js';
import { reactRouterRouter } from './router/react-router/index.js';
import { tanstackRouter } from './router/tanstack-router/index.js';

export { usernamePasswordAuth, reactParser, playwrightRenderer };
export { nextRouter, reactRouterRouter, tanstackRouter };
export { reactRouterConfigRouter, reactNavigationRouter };
export * from './module-resolution.js';
export * from './router/config-scan.js';

/** §1 — the supported set is finite and grows by a pull request. */
export const registry: ProviderRegistry = {
  parser: [reactParser],
  router: [
    nextRouter,
    tanstackRouter,
    reactRouterRouter,
    reactRouterConfigRouter,
    reactNavigationRouter,
  ],
  renderer: [playwrightRenderer],
  auth: [usernamePasswordAuth],
};
