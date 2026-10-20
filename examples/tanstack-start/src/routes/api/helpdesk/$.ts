import { createFileRoute } from '@tanstack/react-router';

import { handleHelpdesk } from '../../../lib/helpdesk.server';

// The helpdesk routes live under /api/helpdesk. The handler reads the path
// itself, so one splat route serves every method.
export const Route = createFileRoute('/api/helpdesk/$')({
  server: {
    handlers: {
      ANY: ({ request }) => handleHelpdesk(request),
    },
  },
});
