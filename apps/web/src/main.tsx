import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { CardPage } from './routes/card';
import { JoinPage } from './routes/join';
import { HomePage, UnavailablePage } from './routes/misc';
import { RecoverPage, RedeemPage } from './routes/recovery';
import { ScanPage } from './routes/scan';

const rootRoute = createRootRoute({ component: () => <Outlet />, notFoundComponent: UnavailablePage });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/join/$code', component: JoinPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/m/$token', component: CardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/s/$token', component: ScanPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/recuperar/$code', component: RecoverPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/r/$token', component: RedeemPage }),
  // El panel (y el cliente de Supabase Auth) se descarga solo al abrirlo: la tarjeta del cliente queda liviana.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/panel',
    component: lazyRouteComponent(() => import('./routes/panel'), 'PanelPage'),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/enlace-no-disponible', component: UnavailablePage }),
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
