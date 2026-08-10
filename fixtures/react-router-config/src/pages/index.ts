import { lazy } from 'react';

/** A barrel of lazily-imported pages — the shape a route table usually points at. */
export const LoginPage = lazy(() => import('pages/Login'));
export const DashboardPage = lazy(() => import('pages/Dashboard'));
export const ServicePage = lazy(() => import('pages/Service'));
export const AlertsPage = lazy(() => import('pages/Alerts'));
export { default as SettingsPage } from './Settings';
