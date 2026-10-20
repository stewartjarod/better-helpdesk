import { createFileRoute } from '@tanstack/react-router';

import { ROLE_COOKIE, roleFromValue } from '../lib/role';

// The demo's sign-in: sets the role cookie that identify reads, then goes home.
// A real app signs in through its own auth instead.
export const Route = createFileRoute('/role')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const role = roleFromValue(new URL(request.url).searchParams.get('as'));
        const cookie =
          role === 'visitor'
            ? `${ROLE_COOKIE}=; Path=/; Max-Age=0`
            : `${ROLE_COOKIE}=${role}; Path=/; SameSite=Lax`;
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': cookie },
        });
      },
    },
  },
});
