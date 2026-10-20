import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createHarness } from './harness';

async function withHarness(
  overrides: Parameters<typeof createHarness>[0],
  run: (harness: ReturnType<typeof createHarness>) => Promise<void>
) {
  const harness = createHarness(overrides);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

describe('features', () => {
  it('reports both on by default, and serves the deal routes', async () => {
    await withHarness({}, async h => {
      h.addUser('agent', { isAgent: true });
      const me = await h.call('GET', 'agent/me', { user: 'agent' });
      expect(me.data.features).toEqual({ deals: true, crm: true });
      expect(
        (await h.call('GET', 'agent/deals', { user: 'agent' })).status
      ).toBe(200);
    });
  });

  it('answers every deal route with the 404 of an unknown path when deals are off', async () => {
    await withHarness({ features: { deals: false } }, async h => {
      h.addUser('agent', { isAgent: true });
      const unknown = await h.call('GET', 'agent/no-such-route', {
        user: 'agent',
      });
      expect(unknown.status).toBe(404);
      const id = randomUUID();
      const attempts = [
        await h.call('GET', 'agent/deals', { user: 'agent' }),
        await h.call('POST', 'agent/deals', {
          user: 'agent',
          body: { title: 'Renewal' },
        }),
        await h.call('PATCH', `agent/deals/${id}`, {
          user: 'agent',
          body: { stage: 'won' },
        }),
        await h.call('DELETE', `agent/deals/${id}`, { user: 'agent' }),
        await h.call('POST', 'agent/activities', {
          user: 'agent',
          body: { kind: 'note', body: 'Call back', dealId: id },
        }),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(404);
        expect(res.data).toEqual(unknown.data);
      }
    });
  });

  it('keeps a conversation’s contact and company loadable when the CRM is off', async () => {
    await withHarness({ features: { crm: false } }, async h => {
      h.addUser('ada');
      h.addUser('agent', { isAgent: true });
      const opened = await h.call('POST', 'widget/conversations', {
        user: 'ada',
        body: {
          inbox: 'support',
          type: 'question',
          subject: 'How do I export?',
          body: 'Looking for the export button',
        },
      });
      expect(opened.status).toBe(201);
      const conversation = opened.data.conversation as { id: string };
      const company = await h.support.store.createCompany({ name: 'Acme' });
      const [ada] = await h.find('contact', { email: 'ada@example.test' });
      await h.support.store.updateContact(ada?.id as string, {
        companyId: company.id,
      });

      const me = await h.call('GET', 'agent/me', { user: 'agent' });
      expect(me.data.features).toEqual({ deals: true, crm: false });
      const detail = await h.call(
        'GET',
        `agent/conversations/${conversation.id}`,
        { user: 'agent' }
      );
      expect(detail.status).toBe(200);
      const contact = await h.call(
        'GET',
        `agent/contacts/${detail.data.contact.id}`,
        { user: 'agent' }
      );
      expect(contact.status).toBe(200);
      const org = await h.call('GET', `agent/companies/${company.id}`, {
        user: 'agent',
      });
      expect(org.status).toBe(200);
    });
  });
});
