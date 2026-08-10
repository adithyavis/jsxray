import type { RouteObject } from 'react-router-dom';
import ROUTES from 'constants/routes';
import { AlertsPage, DashboardPage, LoginPage, ServicePage, SettingsPage } from 'pages/index';

/**
 * A v6 route array: paths come from a constants module, one branch nests through
 * `children`, and one entry is an index route with no path of its own.
 */
const routes: RouteObject[] = [
  { path: ROUTES.LOGIN, Component: LoginPage },
  { path: ROUTES.SERVICE, Component: ServicePage },
  { path: ROUTES.CHANNELS, Component: AlertsPage },
  {
    path: ROUTES.DASHBOARD,
    Component: DashboardPage,
    children: [
      { index: true, Component: DashboardPage },
      { path: 'settings', Component: SettingsPage },
      { path: 'members/:memberId', lazy: () => import('pages/Team') },
    ],
  },
];

export default routes;
