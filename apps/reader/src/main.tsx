import { createRouter, RouterProvider } from '@tanstack/react-router';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { routeTree } from './routeTree.gen.js';

import './style.css';

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  // TanStack Router requires interface merging for type registration.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
