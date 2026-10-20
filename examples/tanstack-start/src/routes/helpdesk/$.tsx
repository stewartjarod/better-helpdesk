import { createFileRoute } from '@tanstack/react-router';
import { HelpdeskAdmin } from 'better-helpdesk/admin';

export const Route = createFileRoute('/helpdesk/$')({
  component: Admin,
});

// Every path under /helpdesk/ renders the agent UI; the API refuses anyone
// whose identity is not an agent, so visitors see the UI's own refusal.
function Admin() {
  return <HelpdeskAdmin api="/api/helpdesk" basePath="/helpdesk" locale="en" />;
}
