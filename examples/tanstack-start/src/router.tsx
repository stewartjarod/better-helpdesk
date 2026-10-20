import { createRouter } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    // The default, 'never', redirects /helpdesk/ to /helpdesk. Both UIs
    // request paths with a trailing slash, so keep them as they are.
    trailingSlash: 'preserve',
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
