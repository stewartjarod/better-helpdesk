// Outbound mail through @wraps.dev/email, which sends from SES in the host's
// own AWS account. The client is built on the first send, so `next build`
// can load this module without AWS credentials.

import { WrapsEmail } from '@wraps.dev/email';
import type { HelpdeskEmail } from 'better-helpdesk';

const from = 'Acme Support <support@example.com>';

let client: WrapsEmail | undefined;

function render(m: HelpdeskEmail) {
  switch (m.kind) {
    case 'customer-reply':
      return {
        subject: `Re: ${m.subject ?? m.reference}`,
        text: `${m.body}\n\n${m.agentName}${
          m.ratingLinks
            ? `\n\nSolved? ${m.ratingLinks.good}\nNot solved? ${m.ratingLinks.bad}`
            : ''
        }`,
        replyTo: m.replyTo,
        headers: m.inReplyTo ? { 'In-Reply-To': m.inReplyTo } : undefined,
      };
    case 'customer-receipt':
      return {
        subject: `We got your message (${m.reference})`,
        text: [
          `Thanks for writing. ${m.responderName ?? 'We'} will answer here.`,
          m.backOn && `We are back on ${new Date(m.backOn).toDateString()}.`,
          m.bookingUrl && `Or book a call: ${m.bookingUrl}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        replyTo: m.replyTo,
      };
    case 'agent-new':
    case 'agent-reminder':
      return {
        subject: m.reopened ? `Reopened: ${m.subject}` : m.subject,
        text: `${m.body}\n\n${m.url}`,
      };
    case 'agent-mention':
      return {
        subject: `${m.authorName} mentioned you: ${m.subject}`,
        text: `${m.body}\n\n${m.url}`,
      };
  }
}

export const email = {
  async send(message: HelpdeskEmail) {
    client ??= new WrapsEmail();
    // Wraps throws on a rejected send, so the job is retried.
    await client.send({ from, to: message.to, ...render(message) });
  },
};
