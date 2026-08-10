import { defineConfig, env } from '@jsxray/core';

export default defineConfig({
  url: 'http://localhost:4400',
  personas: [
    { id: 'anon' },
    { id: 'user', login: { username: env('USER_EMAIL'), password: env('USER_PW') } },
    { id: 'admin', login: { username: env('ADMIN_EMAIL'), password: env('ADMIN_PW') } },
  ],
  seedRoutes: ['/', '/settings', '/signup', '/secrets'],
  ignore: { screenshots: ['/secrets'] },
  bounds: { maxDepth: 3, maxStates: 40, actionCap: 8, timeoutMs: 120000 },
});
