import type { HelpdeskEmail } from 'better-helpdesk';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const send = vi.fn(async (_params: unknown) => ({
  messageId: 'ses-1',
  requestId: 'req-1',
}));

vi.mock('@wraps.dev/email', () => ({
  WrapsEmail: class {
    send = send;
  },
}));

import { email } from './email-wraps';

const base = {
  to: 'maya@customer.test',
  locale: 'en' as const,
  reference: 'HD-12',
};

beforeEach(() => {
  send.mockClear();
});

function sent() {
  const [params] = send.mock.calls[0] as unknown as [Record<string, unknown>];
  return params;
}

describe('Wraps outbound adapter', () => {
  test('a customer reply keeps its reply-to and thread header', async () => {
    await email.send({
      kind: 'customer-reply',
      ...base,
      subject: 'Login fails',
      body: 'Try again now.',
      agentName: 'Sam',
      replyTo: 'reply+HD-12@acme.test',
      inReplyTo: '<abc@customer.test>',
    });

    expect(sent()).toEqual({
      from: 'Acme Support <support@example.com>',
      to: 'maya@customer.test',
      subject: 'Re: Login fails',
      text: 'Try again now.\n\nSam',
      replyTo: 'reply+HD-12@acme.test',
      headers: { 'In-Reply-To': '<abc@customer.test>' },
    });
  });

  test('a customer reply without a thread sends no headers', async () => {
    await email.send({
      kind: 'customer-reply',
      ...base,
      subject: null,
      body: 'Hi',
      agentName: 'Sam',
      replyTo: 'reply+HD-12@acme.test',
    });

    expect(sent().headers).toBeUndefined();
    expect(sent().subject).toBe('Re: HD-12');
  });

  test('a receipt says who answers and when they are back', async () => {
    await email.send({
      kind: 'customer-receipt',
      ...base,
      responderName: 'Sam',
      backOn: '2026-10-20T09:00:00Z',
      bookingUrl: 'https://acme.test/book',
    } as HelpdeskEmail);

    const params = sent();
    expect(params.subject).toBe('We got your message (HD-12)');
    expect(params.text).toContain('Sam will answer here.');
    expect(params.text).toContain('Or book a call: https://acme.test/book');
    expect(params.replyTo).toBeUndefined();
  });

  test('an agent is told about a new conversation, once it is reopened', async () => {
    await email.send({
      kind: 'agent-new',
      ...base,
      subject: 'New conversation',
      body: 'Hello',
      url: 'https://acme.test/helpdesk/HD-12',
    } as HelpdeskEmail);
    await email.send({
      kind: 'agent-reminder',
      ...base,
      subject: 'Waiting',
      reopened: true,
      body: 'Still waiting',
      url: 'https://acme.test/helpdesk/HD-12',
    } as HelpdeskEmail);

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: 'New conversation',
      text: 'Hello\n\nhttps://acme.test/helpdesk/HD-12',
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      subject: 'Reopened: Waiting',
    });
  });

  test('a mention names its author', async () => {
    await email.send({
      kind: 'agent-mention',
      ...base,
      subject: 'Refund',
      authorName: 'Lena',
      body: 'Can you take this?',
      url: 'https://acme.test/helpdesk/HD-12',
    } as HelpdeskEmail);

    expect(sent()).toMatchObject({ subject: 'Lena mentioned you: Refund' });
  });

  test('a rejected send throws, so the job retries', async () => {
    send.mockRejectedValueOnce(new Error('Email address is not verified'));
    await expect(
      email.send({
        kind: 'agent-new',
        ...base,
        subject: 'New',
        body: 'Hello',
        url: 'https://acme.test/helpdesk/HD-12',
      } as HelpdeskEmail)
    ).rejects.toThrow('Email address is not verified');
  });
});
