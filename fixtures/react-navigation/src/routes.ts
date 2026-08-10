/**
 * A flat screen→path map handed to a router object. One screen answers to two
 * paths; the rest to one each.
 */
class Router {
  constructor(public readonly routes: Record<string, string | string[]>) {}
}

export const router = new Router({
  Home: ['/', '/download'],
  Profile: '/profile/:name',
  ProfileFeed: '/profile/:name/feed/:rkey',
  Settings: '/settings',
});
