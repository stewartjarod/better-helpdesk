import { createFileRoute } from '@tanstack/react-router';
import { HelpdeskWidget } from 'better-helpdesk/widget';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>TanStack Start with Better Helpdesk</h1>
      <p>
        Sign in as <a href="/role?as=customer">a customer</a>,{' '}
        <a href="/role?as=agent">an agent</a> or{' '}
        <a href="/role?as=visitor">a visitor</a>. The agent inbox is at{' '}
        <a href="/helpdesk/">/helpdesk/</a>.
      </p>
      <HelpdeskWidget api="/api/helpdesk" inbox="support" locale="en" />
    </main>
  );
}
