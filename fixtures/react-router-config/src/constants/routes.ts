/** A route table in a constants module, referenced as `ROUTES.X` elsewhere. */
const ROUTES = {
  LOGIN: '/login',
  DASHBOARD: '/dashboard',
  SERVICE: '/services/:serviceName',
  // A query string is part of the link, not part of the route.
  CHANNELS: '/alerts?tab=Channels',
};

export default ROUTES;
