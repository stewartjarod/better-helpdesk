// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { ApiError } from '../ui/api';
import { HelpdeskAdmin } from './index';
import { formatSnooze } from './snooze';
import { setQueueOn } from './ui';

const me = {
  agent: { id: 'a1', name: 'Agent' },
  referencePrefix: 'DG',
  types: ['question', 'bug'],
  statuses: ['open', 'pending', 'resolved'],
  priorities: ['low', 'normal', 'high', 'urgent'],
  inboxes: ['support', 'sales'],
  inboxNames: { sales: { en: 'Sales' } },
  inboxHours: {},
  segments: {},
  leadStages: ['lead', 'customer'],
  dealStages: ['new', 'won'],
  customFields: {},
  ai: false,
  features: { deals: true, crm: true },
};

const conversation = {
  id: 'c1',
  reference: 'DG-1000',
  subject: 'Export broken',
  type: 'bug',
  status: 'open',
  priority: 'high',
  inbox: 'support',
  waitingSince: new Date(Date.now() - 3 * 3600_000).toISOString(),
  lastMessageAt: new Date().toISOString(),
  assigneeId: null,
  companyId: null,
  tags: ['billing'],
  contact: { id: 'p1', name: 'Ada', email: 'ada@example.test' },
  context: { url: 'javascript:alert(1)', title: 'Controls' },
  aiSuggestion: null,
};

const routes: Record<string, unknown> = {
  'agent/me/': me,
  'agent/conversations/?': { conversations: [conversation] },
  'agent/conversations/c1/': {
    conversation,
    contact: {
      id: 'p1',
      name: 'Ada',
      email: 'ada@example.test',
      verified: true,
    },
    company: null,
    suggestedCompany: null,
    customerContext: {},
    participants: [],
    viewers: [],
    messages: [
      {
        id: 'm1',
        authorType: 'contact',
        body: 'The CSV export fails',
        internal: false,
        createdAt: new Date().toISOString(),
        agentName: null,
        contactName: 'Ada',
      },
    ],
    attachments: [],
    events: [],
  },
  'agent/agents/': { agents: [] },
  'agent/canned/': { replies: [] },
  'agent/tags/': { tags: ['billing', 'vip'] },
  'agent/views/': { views: [] },
  'agent/notifications/': { unread: 0, notifications: [] },
  'agent/settings/': { confirmation: {} },
  'agent/deals/': { deals: [] },
  'agent/overview/?days=30': {
    openHours: false,
    total: { new: 4, resolved: 2, firstResponse: 2, resolution: 50 },
    inboxes: [
      { inbox: 'sales', new: 4, resolved: 2, firstResponse: 2, resolution: 50 },
    ],
    agents: [
      {
        agentId: null,
        name: null,
        new: 4,
        resolved: 2,
        firstResponse: 0.5,
        resolution: null,
      },
    ],
    tags: [{ tag: 'billing', count: 3 }],
  },
  'agent/overview/?days=7': {
    openHours: false,
    total: { new: 0, resolved: 0, firstResponse: null, resolution: null },
    inboxes: [],
    agents: [],
    tags: [],
  },
};

const original = routes['agent/conversations/c1/'];

// A URL with no entry in `routes` fails the test instead of getting an empty body.
const unrouted: string[] = [];
const respond = (url: string) => {
  const key = Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .find(k => url.includes(k));
  if (key) return new Response(JSON.stringify(routes[key]));
  unrouted.push(url);
  return new Response('{}', { status: 404 });
};

// jsdom has no modal dialogs.
const stubDialogs = () => {
  const { showModal, close } = HTMLDialogElement.prototype;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  onTestFinished(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
  });
};

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/support/conversations/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => respond(String(input)))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(unrouted.splice(0)).toEqual([]);
});

describe('HelpdeskAdmin', () => {
  it('links a conversation reference in a message to the inbox search for it', async () => {
    const base = original as { messages: { body: string }[] };
    routes['agent/conversations/c1/'] = {
      ...base,
      messages: [
        { ...base.messages[0], body: 'Same as DG-1001, please check' },
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const link = await screen.findByRole('link', { name: 'DG-1001' });
    expect(link.getAttribute('href')).toBe(
      '/support/conversations/?q=DG-1001&status=any'
    );

    fireEvent.click(link);
    expect(window.location.search).toBe('?q=DG-1001&status=any');
  });

  it('offers the host’s links for the customer beside the conversation', async () => {
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      links: [
        {
          label: { en: 'Open in Acme admin', de: 'In Acme öffnen' },
          url: 'https://app.test/users/7',
        },
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
    });
    // sessionStorage is cleared before each test, so the open panel stays in this one.
    vi.stubGlobal('localStorage', sessionStorage);
    localStorage.setItem('helpdesk.aside', 'open');
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const link = await screen.findByRole('link', {
      name: /Open in Acme admin/,
    });
    expect(link.getAttribute('href')).toBe('https://app.test/users/7');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('blocks a sender from their contact page and marks them blocked', async () => {
    let blocked = false;
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('agent/contacts/p1/')) {
          if (init?.method === 'PATCH') {
            patches.push(JSON.parse(String(init.body)));
            blocked = true;
            return new Response(JSON.stringify({ contact: {} }));
          }
          return new Response(
            JSON.stringify({
              contact: {
                id: 'p1',
                name: 'Spam Bot',
                email: 'spam@bot.test',
                companyId: null,
                leadStage: null,
                tags: [],
                custom: {},
                blocked,
                createdAt: new Date().toISOString(),
              },
              identities: [],
              company: null,
              conversations: [],
              timeline: [],
              deals: [],
            })
          );
        }
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/contacts/p1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Block sender' })
    );

    await waitFor(() => expect(patches).toEqual([{ blocked: true }]));
    expect(await screen.findByText('Blocked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unblock sender' })).toBeTruthy();
  });

  it('shows when the contact was last seen through the widget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('agent/contacts/p1/')) {
          return new Response(
            JSON.stringify({
              contact: {
                id: 'p1',
                name: 'Mia Keller',
                email: 'mia@harbor.test',
                companyId: null,
                leadStage: null,
                tags: [],
                custom: {},
                createdAt: new Date(Date.now() - 864e5 * 9).toISOString(),
                lastSeenAt: new Date(Date.now() - 3 * 36e5).toISOString(),
              },
              identities: [],
              company: null,
              conversations: [],
              timeline: [],
              deals: [],
            })
          );
        }
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/contacts/p1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    expect(await screen.findByText('Last seen 3 hours ago')).toBeTruthy();
  });

  it('keeps a lead stage the host removed when saving other changes to a contact', async () => {
    stubDialogs();
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('agent/contacts/p1/')) {
          if (init?.method === 'PATCH') {
            patches.push(JSON.parse(String(init.body)));
            return new Response(JSON.stringify({ contact: {} }));
          }
          return new Response(
            JSON.stringify({
              contact: {
                id: 'p1',
                name: 'Ada',
                email: 'ada@example.test',
                companyId: null,
                leadStage: 'trial',
                tags: [],
                custom: { gone: 'kept' },
                createdAt: new Date().toISOString(),
              },
              identities: [],
              company: null,
              conversations: [],
              timeline: [],
              deals: [],
            })
          );
        }
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/contacts/p1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    const stage = within(dialog).getByRole('combobox', {
      name: 'Lead stage',
    }) as HTMLSelectElement;
    expect(stage.selectedOptions[0]?.textContent).toBe('trial');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Ada Lovelace' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patches).toEqual([
        {
          name: 'Ada Lovelace',
          leadStage: 'trial',
          tags: [],
          custom: { gone: 'kept' },
        },
      ])
    );
  });

  it('shows a deal whose stage the host removed in a column of its own, and moves it to a configured stage', async () => {
    const deal = {
      id: 'd1',
      title: 'Pilot',
      stage: 'trial',
      value: '1200',
      currency: 'CHF',
      companyId: null,
      companyName: null,
      contactName: null,
      expectedCloseAt: null,
      createdAt: new Date().toISOString(),
      stageChangedAt: new Date().toISOString(),
    };
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('agent/deals/d1/') && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          patches.push(body);
          Object.assign(deal, body);
          return new Response(JSON.stringify({ deal }));
        }
        if (url.endsWith('agent/deals/'))
          return new Response(JSON.stringify({ deals: [deal] }));
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/deals/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const removed = await screen.findByRole('region', { name: 'trial' });
    expect(
      screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))
    ).toEqual(['New', 'Won', 'trial']);
    const card = within(removed).getByRole('button', { name: /Pilot/ });

    const dataTransfer = { setData: vi.fn(), getData: () => 'd1' };
    fireEvent.dragStart(card, { dataTransfer });
    const won = screen.getByRole('region', { name: 'Won' });
    fireEvent.dragOver(won, { dataTransfer });
    fireEvent.drop(won, { dataTransfer });

    await waitFor(() => expect(patches).toEqual([{ stage: 'won' }]));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'trial' })).toBeNull()
    );
    expect(
      within(screen.getByRole('region', { name: 'Won' })).getByRole('button', {
        name: /Pilot/,
      })
    ).toBeTruthy();
  });

  it('keeps the removed stage of a deal saved from its dialog', async () => {
    stubDialogs();
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('agent/deals/d1/') && init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ deal: {} }));
        }
        if (url.endsWith('agent/deals/'))
          return new Response(
            JSON.stringify({
              deals: [
                {
                  id: 'd1',
                  title: 'Pilot',
                  stage: 'trial',
                  value: null,
                  currency: 'CHF',
                  companyId: null,
                  companyName: null,
                  contactName: null,
                  expectedCloseAt: null,
                  createdAt: new Date().toISOString(),
                  stageChangedAt: new Date().toISOString(),
                },
              ],
            })
          );
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/deals/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Pilot/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patches).toEqual([
        {
          title: 'Pilot',
          stage: 'trial',
          value: null,
          expectedCloseAt: null,
          custom: {},
        },
      ])
    );
  });

  it('shows and saves a deal\u2019s custom fields, keeping values of fields the host removed', async () => {
    stubDialogs();
    routes['agent/me/'] = {
      ...me,
      customFields: {
        deal: [
          {
            key: 'region',
            label: { en: 'Region', de: 'Region' },
            type: 'select',
            options: ['emea', 'apac'],
          },
          {
            key: 'seats',
            label: { en: 'Seats', de: 'Plätze' },
            type: 'number',
          },
        ],
      },
    };
    onTestFinished(() => {
      routes['agent/me/'] = me;
    });
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('agent/deals/d1/') && init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ deal: {} }));
        }
        if (url.endsWith('agent/deals/'))
          return new Response(
            JSON.stringify({
              deals: [
                {
                  id: 'd1',
                  title: 'Pilot',
                  stage: 'new',
                  value: null,
                  currency: 'CHF',
                  companyId: null,
                  companyName: null,
                  contactName: null,
                  expectedCloseAt: null,
                  createdAt: new Date().toISOString(),
                  stageChangedAt: new Date().toISOString(),
                  custom: { region: 'emea', seats: 5, legacy: 'kept' },
                },
              ],
            })
          );
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/deals/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Pilot/ }));
    const dialog = screen.getByRole('dialog');
    expect(
      (
        within(dialog).getByRole('combobox', {
          name: 'Region',
        }) as HTMLSelectElement
      ).value
    ).toBe('emea');
    fireEvent.change(
      within(dialog).getByRole('spinbutton', { name: 'Seats' }),
      {
        target: { value: '12' },
      }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patches).toEqual([
        expect.objectContaining({
          custom: { region: 'emea', seats: 12, legacy: 'kept' },
        }),
      ])
    );
  });

  it('lists waiting conversations and opens one as a deep link', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const row = await screen.findByRole('link', { name: /DG-1000/ });
    expect(screen.getByText('3 hr')).toBeTruthy();

    fireEvent.click(row);
    expect(window.location.pathname).toBe('/support/conversations/c1/');
    expect(await screen.findByText('The CSV export fails')).toBeTruthy();
  });

  it('opens a saved view with its count, and saves the current filters as a new one', async () => {
    routes['agent/views/'] = {
      views: [
        {
          id: 'v1',
          name: 'Urgent anywhere',
          query: 'status=any&priority=high',
          shared: true,
          count: 3,
        },
      ],
    };
    const { showModal, close } = HTMLDialogElement.prototype;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    onTestFinished(() => {
      routes['agent/views/'] = { views: [] };
      Object.assign(HTMLDialogElement.prototype, { showModal, close });
    });
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ view: {} }), { status: 201 });
        }
        return respond(String(input));
      })
    );
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const views = await screen.findByRole('group', { name: 'Views' });
    const view = await within(views).findByRole('button', {
      name: /Urgent anywhere/,
    });
    expect(view.textContent).toBe('Urgent anywhere 3');

    fireEvent.click(view);
    expect(window.location.search).toBe('?status=any&priority=high');
    await waitFor(() => expect(view.ariaPressed).toBe('true'));
    expect(
      within(views).getByRole('button', { name: 'Delete view' })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }));
    fireEvent.click(
      await within(views).findByRole('button', { name: 'Save as view' })
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Up for grabs' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Share with the team' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          name: 'Up for grabs',
          query: 'status=any&assignee=none&priority=high',
          shared: true,
        },
      ])
    );
  });

  it('counts new notifications on the bell and in the tab title, marks them seen when opened, and opens their conversation', async () => {
    routes['agent/notifications/'] = {
      unread: 2,
      notifications: [
        {
          kind: 'reply',
          conversationId: 'c1',
          reference: 'DG-1000',
          subject: 'Export broken',
          who: 'Ada',
          at: new Date().toISOString(),
        },
        {
          kind: 'assigned',
          conversationId: 'c1',
          reference: 'DG-1000',
          subject: 'Export broken',
          who: null,
          at: new Date().toISOString(),
        },
      ],
    };
    document.title = 'Support';
    onTestFinished(() => {
      routes['agent/notifications/'] = { unread: 0, notifications: [] };
      document.title = '';
    });
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(String(input));
          routes['agent/notifications/'] = {
            ...(routes['agent/notifications/'] as object),
            unread: 0,
          };
          return new Response(JSON.stringify({ ok: true }));
        }
        return respond(String(input));
      })
    );
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const bell = await screen.findByLabelText('Notifications, 2 new');
    await waitFor(() => expect(document.title).toBe('(2) Support'));

    fireEvent.click(bell);
    (bell.parentElement as HTMLDetailsElement).open = true;
    fireEvent(bell.parentElement as Element, new Event('toggle'));
    await waitFor(() =>
      expect(posts.some(p => p.endsWith('agent/notifications/seen/'))).toBe(
        true
      )
    );
    await waitFor(() => expect(document.title).toBe('Support'));
    expect(screen.getByText('Someone assigned DG-1000 to you')).toBeTruthy();

    fireEvent.click(screen.getByText('Ada replied in DG-1000'));
    expect(window.location.pathname).toBe('/support/conversations/c1/');
  });

  it('shows the open count on each assignee tab and keeps it while another tab loads', async () => {
    routes['agent/conversations/?'] = {
      conversations: [conversation],
      counts: { all: 4, mine: 1, unassigned: 2 },
    };
    onTestFinished(() => {
      routes['agent/conversations/?'] = { conversations: [conversation] };
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const group = await screen.findByRole('group', { name: 'Assignee' });
    const tabs = () =>
      within(group)
        .getAllByRole('button')
        .map(b => `${b.textContent}${b.ariaPressed === 'true' ? ' *' : ''}`);
    await waitFor(() =>
      expect(tabs()).toEqual(['All 4 *', 'Assigned to me 1', 'Unassigned 2'])
    );

    fireEvent.click(within(group).getByRole('button', { name: /me/ }));
    expect(tabs()).toEqual(['All 4', 'Assigned to me 1 *', 'Unassigned 2']);
  });

  it('says who else has the conversation open, above the reply too, and drops them once they leave', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
      routes['agent/conversations/c1/'] = original;
    });
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      viewers: [
        { id: 'a2', name: 'Grace', avatarUrl: null },
        { id: 'a3', name: 'Linus', avatarUrl: null },
      ],
    };
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    expect(await screen.findByText('Grace and Linus are viewing')).toBeTruthy();
    const warning = () => document.querySelector('.sa-viewing-warning');
    expect(warning()?.getAttribute('role')).toBe('status');
    expect(warning()?.textContent).toBe(
      'Someone else on the team has this conversation open. Check they are not replying already.'
    );

    routes['agent/conversations/c1/'] = original;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() =>
      expect(screen.queryByText('Grace and Linus are viewing')).toBeNull()
    );
    expect(warning()?.textContent).toBe('');
  });

  it('labels the conversation\u2019s properties above their values, unlike the inbox filters', async () => {
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const props = await screen.findByRole('group', { name: 'Properties' });
    const status = within(props).getByRole('combobox', { name: 'Status' });
    expect((status as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      'Open'
    );
    expect(within(props).getByText('Status')).toBeTruthy();
  });

  it('never renders a non-http context URL as a link', async () => {
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const context = (await screen.findByText('Captured context')).closest(
      'div'
    );
    if (!context) throw new Error('missing context card');
    expect(
      within(context).getByText('javascript:alert(1)').closest('a')
    ).toBeNull();
  });

  it('shows pasted code and captured errors as code blocks with a copy button', async () => {
    const trace = '<script>alert(1)</script>\n    at f (a.js:1:1)';
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      conversation: {
        ...conversation,
        context: { errors: ['Error: <img src=x onerror=alert(2)>'] },
      },
      messages: [
        {
          id: 'm1',
          authorType: 'contact',
          body: `It broke:\n\`\`\`\n${trace}\n\`\`\``,
          internal: false,
          createdAt: new Date().toISOString(),
          agentName: null,
          contactName: 'Ada',
        },
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    const { container } = render(
      <HelpdeskAdmin basePath="/support" locale="en" />
    );
    await screen.findByText('It broke:');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByText('1 recent error'));

    expect(
      [...container.querySelectorAll('.code pre')].map(p => p.textContent)
    ).toEqual([trace, 'Error: <img src=x onerror=alert(2)>']);
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(
      2
    );
    expect(container.querySelector('script, img')).toBeNull();
  });

  it('clears a sent reply when resolving it fails, so a retry cannot send it twice', async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (init?.method === 'PATCH')
          return new Response('{}', { status: 500 });
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'Fixed in the next release';
    fireEvent.input(composer);

    fireEvent.click(screen.getByRole('button', { name: 'Send and resolve' }));

    expect(
      await screen.findByText(
        'Sent, but the conversation could not be resolved.'
      )
    ).toBeTruthy();
    expect(composer.textContent).toBe('');
    expect(posts.filter(u => u.includes('/messages'))).toHaveLength(1);
  });

  it('works the queue: a reply opens the next conversation, s skips, and one a teammate has open is passed over', async () => {
    const next = (id: string, n: number, extra = {}) => ({
      ...conversation,
      id,
      reference: `DG-100${n}`,
      subject: `Conversation ${n}`,
      ...extra,
    });
    const second = next('c2', 1);
    const third = next('c3', 2, { viewers: [{ id: 'a2', name: 'Grace' }] });
    const fourth = next('c4', 3);
    routes['agent/conversations/?'] = {
      conversations: [conversation, second, third, fourth],
    };
    for (const c of [second, fourth])
      routes[`agent/conversations/${c.id}/`] = {
        ...(original as object),
        conversation: c,
      };
    onTestFinished(() => {
      routes['agent/conversations/?'] = { conversations: [conversation] };
      delete routes['agent/conversations/c2/'];
      delete routes['agent/conversations/c4/'];
      setQueueOn(false);
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Work the queue' })
    );
    fireEvent.click(await screen.findByRole('link', { name: /DG-1000/ }));
    expect(await screen.findByText('1 of 4')).toBeTruthy();

    const reply = await screen.findByRole('textbox', { name: 'Reply' });
    reply.innerHTML = 'Fixed in the next release';
    fireEvent.input(reply);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/support/conversations/c2/')
    );
    expect(await screen.findByText('2 of 4')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 's' });
    await waitFor(() =>
      expect(window.location.pathname).toBe('/support/conversations/c4/')
    );
  });

  it('leaves the queue off until the agent turns it on', async () => {
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByRole('textbox', { name: 'Reply' });
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 's' });
    expect(window.location.pathname).toBe('/support/conversations/c1/');
  });

  it('keeps the unsent reply and note across navigation and a reload, and clears only what was sent', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const type = (box: HTMLElement, text: string) => {
      box.innerHTML = text;
      fireEvent.input(box);
    };
    type(await screen.findByRole('textbox', { name: 'Reply' }), 'Half a reply');
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }));
    type(
      screen.getByRole('textbox', { name: 'Internal note' }),
      'Ask billing first'
    );

    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    fireEvent.click(await screen.findByRole('link', { name: /DG-1000/ }));
    expect(
      (await screen.findByRole('textbox', { name: 'Internal note' }))
        .textContent
    ).toBe('Ask billing first');

    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect(
      (await screen.findByRole('textbox', { name: 'Internal note' }))
        .textContent
    ).toBe('Ask billing first');
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const reply = screen.getByRole('textbox', { name: 'Reply' });
    expect(reply.textContent).toBe('Half a reply');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(reply.textContent).toBe('');
    expect(posts).toEqual([{ body: 'Half a reply', internal: false }]);

    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect(
      (await screen.findByRole('textbox', { name: 'Reply' })).textContent
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }));
    expect(
      screen.getByRole('textbox', { name: 'Internal note' }).textContent
    ).toBe('Ask billing first');
  });

  it('mentions a teammate picked with @ in a note and notifies only who is still named', async () => {
    const sent: unknown[] = [];
    routes['agent/agents/'] = {
      agents: [
        { id: 'a1', name: 'Agent', email: 'agent@devguard.test' },
        { id: 'a2', name: 'Bea', email: 'bea@devguard.test' },
        { id: 'a3', name: 'Cy', email: 'cy@devguard.test' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url.includes('/messages')) {
          sent.push(JSON.parse(String(init.body)));
          return new Response('{"id":"m2"}', { status: 201 });
        }
        return respond(url);
      })
    );
    try {
      window.history.replaceState(null, '', '/support/conversations/c1/');
      render(<HelpdeskAdmin basePath="/support" locale="en" />);
      await screen.findByRole('textbox', { name: 'Reply' });
      fireEvent.click(screen.getByRole('button', { name: 'Internal note' }));
      const note = screen.getByRole('textbox', { name: 'Internal note' });
      note.innerHTML = 'Ask @b';
      fireEvent.input(note);
      const list = await screen.findByRole('listbox', {
        name: 'Mention a teammate',
      });
      expect(within(list).queryByText('Agent')).toBeNull();
      fireEvent.keyDown(note, { key: 'Enter' });
      await waitFor(() => expect(note.textContent).toBe('Ask @Bea '));
      expect(screen.queryByRole('listbox')).toBeNull();
      note.innerHTML = 'Ask @Bea';
      fireEvent.input(note);
      expect(screen.queryByRole('listbox')).toBeNull();
      note.innerHTML = 'Ask @Bea and @c';
      fireEvent.input(note);
      fireEvent.mouseDown(
        await within(await screen.findByRole('listbox')).findByRole('option', {
          name: 'Cy',
        })
      );
      await waitFor(() => expect(note.textContent).toBe('Ask @Bea and @Cy '));
      note.innerHTML = 'Ask @Cy';
      fireEvent.input(note);
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(sent).toEqual([
          { body: 'Ask @Cy', internal: true, notify: ['a3'] },
        ])
      );
    } finally {
      routes['agent/agents/'] = { agents: [] };
    }
  });

  it('keeps a draft when sending it fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') return new Response('{}', { status: 500 });
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'Half a reply';
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();

    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect(
      (await screen.findByRole('textbox', { name: 'Reply' })).textContent
    ).toBe('Half a reply');
  });

  it('labels the send button while the reply is on its way', async () => {
    let finish = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return respond(String(input));
        await new Promise<void>(resolve => {
          finish = resolve;
        });
        return new Response('{}');
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'On its way';
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const sending = await screen.findByRole('button', { name: 'Sending…' });
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('offers to try again when a conversation fails to load, and loads it on retry', async () => {
    let down = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (down && url.includes('agent/conversations/c1/'))
          return new Response('{}', { status: 500 });
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('This could not be loaded.');
    down = false;
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: 'Reply' })).toBeTruthy();
    expect(screen.queryByText('This could not be loaded.')).toBeNull();
  });

  it('never brings back a reply that finished sending after the agent left the conversation', async () => {
    let release = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST')
          await new Promise<void>(resolve => {
            release = resolve;
          });
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'Already sent';
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    await screen.findByRole('link', { name: /DG-1000/ });
    release();
    await waitFor(() =>
      expect(sessionStorage.getItem('helpdesk.draft.a1.c1')).toBeNull()
    );

    fireEvent.click(screen.getByRole('link', { name: /DG-1000/ }));
    expect(
      (await screen.findByRole('textbox', { name: 'Reply' })).textContent
    ).toBe('');
  });

  it('puts an AI draft in the reply and leaves the note alone', async () => {
    routes['agent/me/'] = { ...me, ai: true };
    routes['agent/conversations/c1/draft'] = { text: 'Try the new export' };
    onTestFinished(() => {
      routes['agent/me/'] = me;
      delete routes['agent/conversations/c1/draft'];
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByRole('textbox', { name: 'Reply' });
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }));
    const note = screen.getByRole('textbox', { name: 'Internal note' });
    note.innerHTML = 'Ask billing first';
    fireEvent.input(note);

    fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));

    expect(
      (await screen.findByRole('textbox', { name: 'Reply' })).textContent
    ).toBe('Try the new export');
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }));
    expect(
      screen.getByRole('textbox', { name: 'Internal note' }).textContent
    ).toBe('Ask billing first');
  });

  it('shortens, formalises or translates what the agent wrote, in place', async () => {
    routes['agent/me/'] = { ...me, ai: true };
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).endsWith('agent/conversations/c1/draft/')) {
          posts.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ text: 'Bitte lesen Sie das.' }));
        }
        return respond(String(input));
      })
    );
    onTestFinished(() => {
      routes['agent/me/'] = me;
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const reply = await screen.findByRole('textbox', { name: 'Reply' });
    expect(screen.queryByRole('button', { name: 'Shorten' })).toBeNull();
    reply.innerHTML = 'Please read this.';
    fireEvent.input(reply);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Into the customer’s language',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reply' }).textContent).toBe(
        'Bitte lesen Sie das.'
      )
    );
    expect(posts).toEqual([{ mode: 'translate', text: 'Please read this.' }]);
    expect(screen.getByRole('button', { name: 'Shorten' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More formal' })).toBeTruthy();
  });

  it('never shows a draft to another agent signed in to the same browser', async () => {
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'Half a reply';
    fireEvent.input(composer);
    cleanup();

    routes['agent/me/'] = { ...me, agent: { id: 'a2', name: 'Other' } };
    onTestFinished(() => {
      routes['agent/me/'] = me;
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect(
      (await screen.findByRole('textbox', { name: 'Reply' })).textContent
    ).toBe('');
  });

  it('still sends when the browser blocks storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const composer = await screen.findByRole('textbox', { name: 'Reply' });
    composer.innerHTML = 'Fixed in the next release';
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(composer.textContent).toBe('');
  });

  it('filters the inbox by a tag on a row and keeps it across other filters', async () => {
    const lists: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('agent/conversations/?')) lists.push(url);
        return respond(url);
      })
    );
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Filter by tag: billing' })
    );
    expect(window.location.search).toContain('tag=billing');
    expect(
      (screen.getByRole('combobox', { name: 'Tag' }) as HTMLInputElement).value
    ).toBe('billing');

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'pending' },
    });
    expect(window.location.search).toContain('tag=billing');
    await waitFor(() => {
      const query = new URL(lists.at(-1) ?? '', 'http://x.test').searchParams;
      expect([query.get('status'), query.get('tag')]).toEqual([
        'pending',
        'billing',
      ]);
    });
    expect(window.location.pathname).toBe('/support/conversations/');
  });

  it('adds the tags typed under the title and removes one by its chip', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PATCH')
          patches.push(JSON.parse(String(init.body)));
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const tags = await screen.findByRole('group', { name: 'Tags' });
    expect(within(tags).getByText('billing')).toBeTruthy();

    fireEvent.click(within(tags).getByRole('button', { name: 'Add tag' }));
    const input = within(tags).getByRole('combobox', { name: 'Add tag' });
    fireEvent.change(input, { target: { value: 'Refunds, BILLING,' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(patches).toEqual([{ tags: ['billing', 'refunds'] }])
    );

    fireEvent.click(
      within(tags).getByRole('button', { name: 'Remove tag billing' })
    );
    await waitFor(() => expect(patches.at(-1)).toEqual({ tags: [] }));
  });

  it('shows the saved tags and an error when saving them fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'PATCH')
          return new Response(JSON.stringify({ error: 'invalid' }), {
            status: 400,
          });
        const url = String(input);
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const tags = await screen.findByRole('group', { name: 'Tags' });
    fireEvent.click(within(tags).getByRole('button', { name: 'Add tag' }));
    const input = within(tags).getByRole('combobox', { name: 'Add tag' });
    fireEvent.change(input, { target: { value: 'refunds' } });
    fireEvent.blur(input);

    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
    expect(
      within(tags)
        .getAllByText(/./, { selector: '.sa-tag-chip' })
        .map(chip => chip.textContent)
    ).toEqual(['billing']);
  });

  it('snoozes a conversation until tomorrow morning and says until when', async () => {
    const patches: Record<string, unknown>[] = [];
    let snoozedUntil: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          patches.push(body);
          snoozedUntil = body.snoozedUntil;
        }
        if (url.includes('agent/conversations/c1/')) {
          const detail = original as { conversation: object };
          return new Response(
            JSON.stringify({
              ...detail,
              conversation: {
                ...detail.conversation,
                status: snoozedUntil ? 'pending' : 'open',
                snoozedUntil,
              },
            })
          );
        }
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const select = await screen.findByRole('combobox', { name: 'Snooze' });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    fireEvent.change(select, { target: { value: 'tomorrow' } });

    await waitFor(() =>
      expect(
        (select as HTMLSelectElement).selectedOptions[0]?.textContent
      ).toBe(`Snoozed until ${formatSnooze(tomorrow, 'en')}`)
    );
    expect(patches).toEqual([{ snoozedUntil: tomorrow.toISOString() }]);

    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() =>
      expect(
        (select as HTMLSelectElement).selectedOptions[0]?.textContent
      ).toBe('Snooze')
    );
    expect(patches.at(-1)).toEqual({ snoozedUntil: null });
  });

  it('snoozes until a picked time, opened with the z key', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PATCH')
          patches.push(JSON.parse(String(init.body)));
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    // z is pressed in the first moment the select is in the page, before
    // React runs the passive effects of the commit that added it.
    const select = await new Promise<HTMLElement>(resolve => {
      const observer = new MutationObserver(() => {
        const shown = document.querySelector<HTMLElement>(
          'select[aria-label="Snooze"]'
        );
        if (!shown) return;
        observer.disconnect();
        fireEvent.keyDown(document.body, { key: 'z' });
        resolve(shown);
      });
      onTestFinished(() => observer.disconnect());
      observer.observe(document.body, { childList: true, subtree: true });
      render(<HelpdeskAdmin basePath="/support" locale="en" />);
    });
    expect(document.activeElement).toBe(select);

    fireEvent.change(select, { target: { value: 'pick' } });
    const input = screen.getByLabelText('Snooze until') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const until = new Date();
    until.setDate(until.getDate() + 3);
    until.setHours(10, 15, 0, 0);
    const value = new Date(until.getTime() - until.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));

    await waitFor(() =>
      expect(screen.queryByLabelText('Snooze until')).toBeNull()
    );
    expect(patches).toEqual([{ snoozedUntil: until.toISOString() }]);
  });

  it('says so when the server refuses a snooze and keeps the conversation awake', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ error: 'invalid' }), {
            status: 400,
          });
        }
        const url = String(input);
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const select = await screen.findByRole('combobox', { name: 'Snooze' });

    fireEvent.change(select, { target: { value: 'tomorrow' } });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Snoozing failed. Nothing changed.'
    );
    expect(patches).toHaveLength(1);
    expect((select as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      'Snooze'
    );
  });

  it('marks the section it is in and scrolls that tab into the rail', async () => {
    // jsdom has no layout, so the method the rail calls does not exist there.
    const scrollIntoView = vi.fn();
    const absent = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = absent;
    });
    window.history.replaceState(null, '', '/support/settings/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const current = within(nav).getByRole('button', { current: 'page' });
    expect(current.textContent).toBe('Settings');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    fireEvent.click(within(nav).getByRole('button', { name: 'Deals' }));
    expect(
      within(nav).getByRole('button', { current: 'page' }).textContent
    ).toBe('Deals');
  });

  it('offers to set yourself away in the rail, and in the inbox toolbar when the host hides the rail', async () => {
    const { unmount } = render(
      <HelpdeskAdmin basePath="/support" locale="en" />
    );
    await screen.findByRole('link', { name: /DG-1000/ });
    const away = screen.getByRole('button', { name: 'Set away…' });
    expect(away.closest('.sa-rail')).toBeTruthy();
    expect(away.closest('.sa-toolbar')).toBeNull();
    unmount();

    render(<HelpdeskAdmin basePath="/support" locale="en" nav={false} />);
    await screen.findByRole('link', { name: /DG-1000/ });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Set away…' }).closest('.sa-toolbar')
    ).toBeTruthy();
  });

  it('asks reply or note before the text, and hints at canned replies in the empty reply', async () => {
    window.history.replaceState(null, '', '/support/conversations/c1/');
    const { container } = render(
      <HelpdeskAdmin basePath="/support" locale="en" />
    );
    const reply = await screen.findByRole('textbox', { name: 'Reply' });
    const composer = container.querySelector('.sa-composer') as HTMLElement;
    const first = composer.querySelector(
      'button, input, select, textarea, [contenteditable="true"]'
    );
    expect(first?.textContent).toBe('Reply');
    expect(first?.getAttribute('aria-pressed')).toBe('true');
    expect(reply.dataset.placeholder).toBe('Type / for canned replies');

    fireEvent.click(
      within(composer).getByRole('button', { name: 'Internal note' })
    );
    expect(
      (await screen.findByRole('textbox', { name: 'Internal note' })).dataset
        .placeholder
    ).toContain('Only your team sees internal notes.');
  });

  it('says so when saving the settings fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Response('{}', { status: 400 });
        }
        const url = String(input);
        if (url.includes('agent/settings')) {
          return new Response(JSON.stringify({ confirmation: {} }));
        }
        if (url.includes('agent/agents')) {
          return new Response(JSON.stringify({ agents: [] }));
        }
        return new Response(JSON.stringify(me));
      })
    );
    window.history.replaceState(null, '', '/support/settings/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });

  it('removes a former teammate from the team, never the agent themselves', async () => {
    let team = [
      { id: 'a1', name: 'Agent', email: 'agent@example.test' },
      { id: 'a2', name: 'Former', email: 'former@example.test' },
    ];
    const removed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          const id = url.match(/agent\/agents\/([^/]+)/)?.[1] ?? '';
          removed.push(id);
          team = team.filter(a => a.id !== id);
          return new Response('{"ok":true}');
        }
        if (url.includes('agent/settings')) {
          return new Response(JSON.stringify({ confirmation: {} }));
        }
        if (url.includes('agent/agents')) {
          return new Response(JSON.stringify({ agents: team }));
        }
        return new Response(JSON.stringify(me));
      })
    );
    window.history.replaceState(null, '', '/support/settings/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    expect(await screen.findByText('Former')).toBeTruthy();
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    expect(removeButtons).toHaveLength(1);
    fireEvent.click(removeButtons[0] as HTMLElement);
    expect(removed).toEqual([]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove and unassign?' })
    );

    await vi.waitFor(() => expect(screen.queryByText('Former')).toBeNull());
    expect(removed).toEqual(['a2']);
  });

  it('marks a customer message nobody proved, and names an automatic reply', async () => {
    routes['agent/conversations/c1/'] = {
      ...(routes['agent/conversations/c1/'] as object),
      messages: [
        {
          id: 'm1',
          authorType: 'contact',
          body: 'Typed into the form',
          internal: false,
          verified: false,
          createdAt: new Date().toISOString(),
          agentName: null,
          contactName: 'Ada',
        },
        {
          id: 'm2',
          authorType: 'system',
          body: 'I am out of office, see [my calendar](https://evil.test/c)',
          internal: true,
          verified: null,
          createdAt: new Date().toISOString(),
          agentName: null,
          contactName: null,
        },
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    const typed = (await screen.findByText('Typed into the form')).closest(
      'article'
    );
    expect(typed?.querySelector('header')?.textContent).toContain('Unverified');
    const auto = screen.getByText('my calendar').closest('article');
    expect(auto?.querySelector('header')?.textContent).toContain(
      'Automatic reply'
    );
    expect(auto?.textContent).toContain('(evil.test)');
  });

  it('interleaves the conversation events with the messages as one line each', async () => {
    const at = (minute: number) =>
      new Date(Date.UTC(2026, 8, 1, 9, minute)).toISOString();
    const event = (
      minute: number,
      kind: string,
      data: Record<string, unknown> = {},
      agent: string | null = 'a2'
    ) => ({
      id: `e${minute}`,
      kind,
      data,
      agentId: agent,
      agentName: agent === 'a2' ? 'Grace' : null,
      createdAt: at(minute),
    });
    const until = at(50);
    routes['agent/agents/'] = {
      agents: [{ id: 'a2', name: 'Grace', email: 'grace@devguard.test' }],
    };
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      participants: [{ id: 'p2', name: 'Bob', email: 'bob@example.test' }],
      messages: [
        {
          id: 'm1',
          authorType: 'contact',
          body: 'The CSV export fails',
          internal: false,
          verified: true,
          createdAt: at(0),
          agentName: null,
          contactName: 'Ada',
        },
        {
          id: 'm2',
          authorType: 'agent',
          body: 'Looking into it',
          internal: false,
          verified: null,
          createdAt: at(5),
          agentName: 'Grace',
          contactName: null,
        },
      ],
      events: [
        event(
          1,
          'email.sent',
          { kind: 'agent-new', to: ['grace@devguard.test'] },
          null
        ),
        event(2, 'assigneeId', { from: null, to: 'a2' }),
        event(2, 'status', { from: 'open', to: 'pending' }),
        event(6, 'tags', { from: ['billing'], to: ['vip'] }),
        event(7, 'snoozedUntil', { from: null, to: until }),
        event(8, 'status', { from: 'pending', to: 'open' }, null),
        event(9, 'reopened', {}, null),
        event(10, 'participant.added', { contactId: 'p2' }),
        event(10, 'mentioned', { agentIds: ['a2', 'gone'] }),
        event(11, 'priority', { from: 'normal', to: 'urgent' }, 'gone'),
        event(12, 'mystery'),
        event(
          13,
          'snoozedUntil',
          { from: until, to: null, by: 'customer' },
          null
        ),
        event(
          13,
          'status',
          { from: 'pending', to: 'resolved', by: 'customer' },
          null
        ),
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
      routes['agent/agents/'] = { agents: [] };
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    const { container } = render(
      <HelpdeskAdmin basePath="/support" locale="en" />
    );
    await screen.findByText('Grace assigned this to Grace');

    const thread = [
      ...container.querySelectorAll('.sa-thread > article, .sa-thread > p'),
    ].map(el =>
      el.tagName === 'P'
        ? (el.firstChild?.textContent ?? '')
        : (el.querySelector('.sa-msg-body')?.textContent ?? '')
    );
    expect(thread).toEqual([
      'The CSV export fails',
      'New-conversation email sent to grace@devguard.test',
      'Grace assigned this to Grace',
      'Grace set the status to Waiting on customer',
      'Looking into it',
      'Grace added tags: vip · Grace removed tags: billing',
      `Grace snoozed this until ${formatSnooze(until, 'en')}`,
      'Status changed to Open',
      'A customer reply reopened this',
      'Grace added Bob',
      'Grace mentioned Grace, A former agent',
      'A former agent set the priority to Urgent',
      'The customer marked this resolved',
    ]);
  });

  it.each([
    ['/support/conversations/', 'agent/conversations/?', 'thead th', 4],
    ['/support/conversations/c1/', 'agent/conversations/c1/', '.sa-fields', 1],
    ['/support/contacts/', 'agent/contacts/', 'thead th', 6],
    ['/support/companies/', 'agent/companies/', 'thead th', 4],
    ['/support/contacts/p1/', 'agent/contacts/p1/', '.sa-summary', 1],
    ['/support/companies/o1/', 'agent/companies/o1/', '.sa-summary', 0],
  ])(
    'shows %s as a busy skeleton of the page until it loads',
    async (path, pending, shape, count) => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
          const url = String(input);
          if (url.includes(pending)) return new Promise(() => {});
          if (url.includes('agent/me/'))
            return Promise.resolve(new Response(JSON.stringify(me)));
          // The inbox list stays mounted beside an open conversation.
          if (url.includes('agent/conversations/?'))
            return Promise.resolve(
              new Response(JSON.stringify({ conversations: [] }))
            );
          return Promise.resolve(new Response('{}'));
        })
      );
      window.history.replaceState(null, '', path);
      const { container } = render(
        <HelpdeskAdmin basePath="/support" locale="en" />
      );

      // The inbox list beside an open conversation is busy for a moment too.
      const busy = await vi.waitFor(() => {
        const found = container.querySelectorAll('[aria-busy="true"]');
        if (found.length !== 1) throw new Error(`${found.length} busy`);
        return found[0] as Element;
      });
      expect(busy.textContent).toBe('Loading…');
      expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
      expect(busy.querySelectorAll(shape)).toHaveLength(count);
    }
  );

  it.each([
    '/support/contacts/',
    '/support/companies/',
    '/support/contacts/p1/',
    '/support/companies/o1/',
  ])(
    'replaces the skeleton of %s with a retry notice when loading fails',
    async path => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) =>
          String(input).includes('agent/me/')
            ? new Response(JSON.stringify(me))
            : new Response('{}', { status: 500 })
        )
      );
      window.history.replaceState(null, '', path);
      const { container } = render(
        <HelpdeskAdmin basePath="/support" locale="en" />
      );

      expect(await screen.findByText('This could not be loaded.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    }
  );

  it('keeps an unhandled action failure on screen under a host router', async () => {
    render(
      <HelpdeskAdmin
        basePath="/support"
        locale="en"
        location={{ pathname: '/support/conversations/', search: '' }}
      />
    );
    await screen.findByRole('link', { name: /DG-1000/ });

    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection', { cancelable: true }), {
          reason: new ApiError(500, 'boom'),
        })
      );
    });

    expect(screen.getByRole('alert').textContent).toBe('Something went wrong.');
  });
});

describe('empty states', () => {
  const empty = (path: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).includes('agent/me/')
          ? new Response(JSON.stringify(me))
          : new Response(
              JSON.stringify({
                conversations: [],
                contacts: [],
                companies: [],
                replies: [],
                deals: [],
              })
            )
      )
    );
    window.history.replaceState(null, '', path);
    return render(<HelpdeskAdmin basePath="/support" locale="en" />);
  };

  it('says how the first conversation arrives on an empty inbox', async () => {
    empty('/support/conversations/');
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
    expect(
      screen.getByText(
        'The first message from the widget or by email shows up here.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('names a filter that hides every conversation and clears it', async () => {
    empty('/support/conversations/?status=resolved&q=export');
    expect(
      await screen.findByText('Nothing matches these filters.')
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(window.location.pathname + window.location.search).toBe(
      '/support/conversations/'
    );
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
    expect(
      (screen.getByRole('searchbox', { name: 'Search' }) as HTMLInputElement)
        .value
    ).toBe('');
  });

  it.each([
    ['/support/contacts/', 'No contacts yet.'],
    ['/support/contacts/?q=nobody', 'Nothing matches these filters.'],
    ['/support/companies/', 'No companies yet.'],
    ['/support/companies/?q=nobody', 'Nothing matches these filters.'],
    ['/support/canned/', 'No canned replies yet.'],
  ])('tells %s what fills it', async (path, title) => {
    empty(path);
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('shows one empty state over an empty deals board, not one per column', async () => {
    empty('/support/deals/');
    expect(await screen.findByText('No deals yet.')).toBeTruthy();
    expect(screen.getAllByRole('region')).toHaveLength(me.dealStages.length);
    expect(screen.queryByText('Drag a deal here')).toBeNull();
  });
});

describe('bulk changes', () => {
  const three = ['c1', 'c2', 'c3'].map((id, i) => ({
    ...conversation,
    id,
    reference: `DG-100${i}`,
    subject: `Outage report ${i}`,
  }));
  const posts: unknown[] = [];
  let fail: { status: number; error: string; ids?: string[] } | null = null;

  beforeEach(() => {
    posts.length = 0;
    fail = null;
    routes['agent/conversations/?'] = { conversations: three };
    routes['agent/agents/'] = {
      agents: [{ id: 'a2', name: 'Grace Hopper', email: null }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('agent/conversations/bulk')) {
          posts.push(JSON.parse(String(init?.body)));
          return fail
            ? new Response(JSON.stringify(fail), { status: fail.status })
            : new Response(JSON.stringify({ ok: true }));
        }
        return respond(url);
      })
    );
    onTestFinished(() => {
      routes['agent/conversations/?'] = { conversations: [conversation] };
      routes['agent/agents/'] = { agents: [] };
    });
  });

  // The selection count; a toast is a second status.
  const status = () =>
    document.querySelector('.sa-sr-only[role="status"]') as HTMLElement;

  it('selects a range with shift-click and resolves it in one request', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select DG-1000' })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select DG-1002' }), {
      shiftKey: true,
    });
    const bar = screen.getByRole('toolbar', { name: 'Change selected' });

    fireEvent.change(within(bar).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'resolved' },
    });

    await waitFor(() =>
      expect(posts).toEqual([{ ids: ['c1', 'c2', 'c3'], status: 'resolved' }])
    );
    expect(
      (await screen.findByText('Selected conversations changed.')).getAttribute(
        'role'
      )
    ).toBe('status');
    expect(status().textContent).toBe('3 selected');
    expect(window.location.pathname).toBe('/support/conversations/');
  });

  it('assigns, sets the priority and adds a tag to the selection', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select DG-1001' })
    );
    const bar = screen.getByRole('toolbar', { name: 'Change selected' });
    await within(bar).findByRole('option', { name: 'Assignee: Grace Hopper' });

    fireEvent.change(within(bar).getByRole('combobox', { name: 'Assignee' }), {
      target: { value: 'a2' },
    });
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'urgent' },
    });
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Add tag' }), {
      target: { value: ' Outage ' },
    });
    fireEvent.submit(within(bar).getByRole('combobox', { name: 'Add tag' }));
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Assignee' }), {
      target: { value: 'none' },
    });

    await waitFor(() =>
      expect(posts).toEqual([
        { ids: ['c2'], assigneeId: 'a2' },
        { ids: ['c2'], priority: 'urgent' },
        { ids: ['c2'], addTag: 'outage' },
        { ids: ['c2'], assigneeId: null },
      ])
    );
  });

  it('selects all, keeps the selection across a refresh that drops a row, and clears it', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select all' })
    );
    expect(status().textContent).toBe('3 selected');

    routes['agent/conversations/?'] = { conversations: [three[2], three[0]] };
    act(() => {
      window.dispatchEvent(new Event('helpdesk:changed'));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', { name: 'Select DG-1001' })
      ).toBeNull()
    );
    expect(status().textContent).toBe('2 selected');
    const all = screen.getByRole('checkbox', {
      name: 'Select all',
    }) as HTMLInputElement;
    expect([all.checked, all.indeterminate]).toEqual([true, false]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(status().textContent).toBe('');
    expect(
      screen.queryByRole('toolbar', { name: 'Change selected' })
    ).toBeNull();
  });

  it('toggles the highlighted row with x and marks select-all as partial', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByRole('checkbox', { name: 'Select DG-1000' });

    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'x' });

    const second = screen.getByRole('checkbox', {
      name: 'Select DG-1001',
    }) as HTMLInputElement;
    const all = screen.getByRole('checkbox', {
      name: 'Select all',
    }) as HTMLInputElement;
    expect([second.checked, all.checked, all.indeterminate]).toEqual([
      true,
      false,
      true,
    ]);
    expect(status().textContent).toBe('1 selected');
  });

  it('names the conversation a change failed on and keeps the selection', async () => {
    fail = { status: 404, error: 'Not found', ids: ['c3'] };
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select DG-1000' })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select DG-1002' }));
    const bar = screen.getByRole('toolbar', { name: 'Change selected' });

    fireEvent.change(within(bar).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'resolved' },
    });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'None of the selected conversations were changed. It failed on DG-1002.'
    );
    expect(status().textContent).toBe('2 selected');
  });

  it("shows the server's reason for a refusal that names no conversation", async () => {
    fail = { status: 400, error: 'Unknown agent' };
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select DG-1000' })
    );
    const bar = screen.getByRole('toolbar', { name: 'Change selected' });

    fireEvent.change(within(bar).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'resolved' },
    });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unknown agent'
    );
  });

  it('refuses a selection over the bulk limit without sending it', async () => {
    routes['agent/conversations/?'] = {
      conversations: Array.from({ length: 101 }, (_, i) => ({
        ...conversation,
        id: `m${i}`,
        reference: `DG-${2000 + i}`,
      })),
    };
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select all' })
    );
    const bar = screen.getByRole('toolbar', { name: 'Change selected' });
    const select = within(bar).getByRole('combobox', {
      name: 'Status',
    }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'resolved' } });

    expect(screen.getByRole('alert').textContent).toBe(
      'Select at most 100 conversations.'
    );
    expect(select.disabled).toBe(true);
    expect(
      (
        within(bar).getByRole('combobox', {
          name: 'Add tag',
        }) as HTMLInputElement
      ).disabled
    ).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posts).toEqual([]);
  });

  it('leaves the selection alone when x comes with Ctrl, Cmd or Alt', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByRole('checkbox', { name: 'Select DG-1000' });

    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'x', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'x', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'x', altKey: true });

    expect(status().textContent).toBe('');
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(status().textContent).toBe('1 selected');
  });

  it('selects a range from the keyboard with shift and x', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByRole('checkbox', { name: 'Select DG-1000' });

    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'x' });
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'X', shiftKey: true });

    expect(status().textContent).toBe('3 selected');
  });
});

describe('conversation shortcuts', () => {
  const patches: Record<string, unknown>[] = [];
  beforeEach(() => {
    patches.length = 0;
    let current = conversation;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PATCH') {
          const values = JSON.parse(String(init.body));
          patches.push(values);
          current = { ...current, ...values };
        }
        if (url.includes('agent/conversations/c1/'))
          return new Response(
            JSON.stringify({
              ...(original as object),
              conversation: current,
            })
          );
        return respond(url);
      })
    );
    window.history.replaceState(null, '', '/support/conversations/c1/');
  });
  const select = (name: string) =>
    screen.getByRole('combobox', { name }) as HTMLSelectElement;

  it('resolves with e and says so', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    fireEvent.keyDown(document.body, { key: 'e' });
    fireEvent.keyDown(document.body, { key: 'e' });

    expect(await screen.findByText('Resolved DG-1000')).toBeTruthy();
    await waitFor(() => expect(select('Status').value).toBe('resolved'));
    expect(patches).toEqual([{ status: 'resolved' }]);
  });

  it('assigns to me with a and says so', async () => {
    routes['agent/agents/'] = {
      agents: [{ id: 'a1', name: 'Agent', email: null }],
    };
    onTestFinished(() => {
      routes['agent/agents/'] = { agents: [] };
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    fireEvent.keyDown(document.body, { key: 'a' });

    expect(await screen.findByText('Assigned to you')).toBeTruthy();
    await waitFor(() => expect(select('Assignee').value).toBe('a1'));
    expect(patches).toEqual([{ assigneeId: 'a1' }]);
  });

  it('sends both a and e pressed one after the other', async () => {
    routes['agent/agents/'] = {
      agents: [{ id: 'a1', name: 'Agent', email: null }],
    };
    onTestFinished(() => {
      routes['agent/agents/'] = { agents: [] };
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'e' });

    await waitFor(() => expect(select('Status').value).toBe('resolved'));
    await waitFor(() => expect(select('Assignee').value).toBe('a1'));
    expect(patches).toEqual([{ assigneeId: 'a1' }, { status: 'resolved' }]);
  });

  it('announces the toast in a status region that is there before it', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');
    const region = document.querySelector('.sa-toast');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');

    fireEvent.keyDown(document.body, { key: 'e' });

    await waitFor(() => expect(region?.textContent).toBe('Resolved DG-1000'));
    expect(document.querySelector('.sa-toast')).toBe(region);
  });

  it('says so when resolving with e fails', async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
          : fetch(input, init)
      )
    );
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    fireEvent.keyDown(document.body, { key: 'e' });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong.'
    );
    expect(select('Status').value).toBe('open');
  });

  it('switches to the note with n and back to the reply with r, without typing the letter', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    expect(fireEvent.keyDown(document.body, { key: 'n' })).toBe(false);
    const note = await screen.findByRole('textbox', { name: 'Internal note' });
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(note.textContent).toBe('');

    fireEvent.keyDown(document.body, { key: 'r' });
    const reply = await screen.findByRole('textbox', { name: 'Reply' });
    await waitFor(() => expect(document.activeElement).toBe(reply));
  });

  it('leaves the keys to the text while an agent types', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const reply = await screen.findByRole('textbox', { name: 'Reply' });

    for (const key of ['e', 'a', 'n', 'z', '?'])
      expect(fireEvent.keyDown(reply, { key })).toBe(true);
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'e', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'e', altKey: true });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(patches).toEqual([]);
    expect(select('Status').value).toBe('open');
    expect(screen.getByRole('textbox', { name: 'Reply' })).toBe(reply);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists every key in a sheet that ? opens, and takes no key while it is open', async () => {
    const { showModal, close } = HTMLDialogElement.prototype;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    onTestFinished(() => {
      Object.assign(HTMLDialogElement.prototype, { showModal, close });
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');

    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

    const sheet = await screen.findByRole('dialog', {
      name: 'Keyboard shortcuts',
    });
    const keys = [...sheet.querySelectorAll('dt')].map(dt => dt.textContent);
    expect(keys).toEqual([
      'j k',
      '↵',
      'x',
      '⇧ x',
      'e',
      'a',
      'r',
      'n',
      's',
      'z',
      'Ctrl ↵',
      'Ctrl ⇧ ↵',
      'Ctrl B',
      'Ctrl I',
      'Ctrl U',
      'Ctrl K',
      '/',
      '?',
    ]);

    const closeButton = within(sheet).getByRole('button', { name: 'Close' });
    fireEvent.keyDown(closeButton, { key: 'e' });
    fireEvent.keyDown(document.body, { key: 'e' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(patches).toEqual([]);

    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('takes no single key once the agent turns them off, and remembers it', async () => {
    vi.stubGlobal('localStorage', sessionStorage);
    onTestFinished(() => sessionStorage.removeItem('helpdesk.keys'));
    const { showModal, close } = HTMLDialogElement.prototype;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    onTestFinished(() => {
      Object.assign(HTMLDialogElement.prototype, { showModal, close });
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');
    const reply = screen.getByRole('button', { name: 'Reply' });
    expect(reply.getAttribute('aria-keyshortcuts')).toBe('R');

    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const sheet = await screen.findByRole('dialog', {
      name: 'Keyboard shortcuts',
    });
    const box = within(sheet).getByRole('checkbox', {
      name: 'Single-key shortcuts',
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(fireEvent.keyDown(document.body, { key: 'e' })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(patches).toEqual([]);
    expect(reply.hasAttribute('aria-keyshortcuts')).toBe(false);

    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await screen.findByText('The CSV export fails');
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'e' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(patches).toEqual([]);

    cleanup();
    window.history.replaceState(null, '', '/support/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keyboard shortcuts' })
    );
    expect(
      await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    ).toBeTruthy();
  });
});

describe('inbox beside a conversation', () => {
  it('marks the open row, keeps the filters on the way back, and Escape returns to the row', async () => {
    window.history.replaceState(
      null,
      '',
      '/support/conversations/c1/?tag=billing'
    );
    const { container } = render(
      <HelpdeskAdmin basePath="/support" locale="en" />
    );
    await screen.findByText('The CSV export fails');
    // jsdom ignores container queries, so the narrow rule hides the list.
    const row = await screen.findByRole('link', {
      name: /DG-1000/,
      hidden: true,
    });
    expect(row.closest('tr')?.getAttribute('aria-current')).toBe('true');
    expect(
      screen.getByRole('link', { name: 'Inbox' }).getAttribute('href')
    ).toBe('/support/conversations/?tag=billing');

    const composer = container.querySelector(
      '.sa-thread-pane [contenteditable="true"]'
    ) as HTMLElement;
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(document.activeElement).toBe(row);
  });
});

describe('details sidebar', () => {
  beforeEach(() => {
    // Newer Node versions shadow jsdom's localStorage with their own, which
    // is undefined unless Node runs with --localstorage-file.
    vi.stubGlobal('localStorage', sessionStorage);
    window.history.replaceState(null, '', '/support/conversations/c1/');
  });
  const toggle = () =>
    screen.findByRole('button', { name: /^(Details|Hide details)$/ });
  const aside = () => screen.getByRole('complementary', { hidden: true });
  const widen = (width: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(
      width
    );
  };

  it('starts hidden in a narrow container, opens, and stays open after a reload', async () => {
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const button = await toggle();
    expect(button.textContent).toBe('Details');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(aside().id);
    expect(aside().hidden).toBe(true);

    fireEvent.click(button);
    expect(button.textContent).toBe('Hide details');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(aside().hidden).toBe(false);

    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect((await toggle()).getAttribute('aria-expanded')).toBe('true');
    expect(aside().hidden).toBe(false);
  });

  it('starts open in a wide container and stays hidden once hidden', async () => {
    widen(1440);
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const button = await toggle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(aside().hidden).toBe(false);

    fireEvent.click(button);
    cleanup();
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    expect((await toggle()).getAttribute('aria-expanded')).toBe('false');
    expect(aside().hidden).toBe(true);
  });

  it('moves focus to the toggle when it hides the sidebar with focus inside', async () => {
    widen(1440);
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const button = await toggle();
    const [inside] = within(aside()).getAllByRole('button');
    inside?.focus();
    expect(document.activeElement).toBe(inside);

    fireEvent.click(button);
    expect(aside().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('falls back to the default and still toggles when storage is blocked', async () => {
    widen(1440);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const button = await toggle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(aside().hidden).toBe(true);
  });

  it('merges into an AI duplicate after a warning that the customers differ', async () => {
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      conversation: {
        ...conversation,
        mergedIntoId: null,
        aiSuggestion: {
          duplicates: [
            { conversationId: 'c2', reference: 'DG-1001', reason: 'Same' },
          ],
        },
      },
    };
    routes['agent/conversations/?q=DG-1001'] = {
      conversations: [
        {
          ...conversation,
          id: 'c2',
          reference: 'DG-1001',
          subject: 'CSV export',
          contact: { id: 'p2', name: 'Bob', email: 'bob@example.test' },
        },
      ],
    };
    routes['agent/conversations/c1/merge/'] = { ok: true };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
      delete routes['agent/conversations/?q=DG-1001'];
      delete routes['agent/conversations/c1/merge/'];
    });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
        }
        return respond(url);
      })
    );
    const { showModal, close } = HTMLDialogElement.prototype;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    onTestFinished(() => {
      Object.assign(HTMLDialogElement.prototype, { showModal, close });
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge into…' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'DG-1001 CSV export' })
    );

    const ask = await screen.findByRole('dialog', { name: 'Merge' });
    expect(ask.textContent).toContain('DG-1001 belongs to another customer');
    expect(posts).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toContain('agent/conversations/c1/merge');
    expect(posts[0]?.body).toEqual({ targetId: 'c2' });
  });

  it('links a merged conversation to its target and offers no second merge', async () => {
    routes['agent/conversations/c1/'] = {
      ...(original as object),
      conversation: {
        ...conversation,
        status: 'resolved',
        mergedIntoId: 'c2',
      },
      events: [
        {
          id: 'e1',
          kind: 'merged.into',
          data: { conversationId: 'c2', reference: 'DG-1001' },
          agentId: 'a1',
          agentName: 'Grace',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    onTestFinished(() => {
      routes['agent/conversations/c1/'] = original;
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);

    const banner = await screen.findByRole('link', {
      name: 'Merged into DG-1001.',
    });
    expect(banner.getAttribute('href')).toBe('/support/conversations/c2/');
    expect(screen.getByText('Grace merged this into DG-1001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge into…' })).toBeNull();
  });

  it('shows the overview numbers and a table by inbox and assignee for the chosen period', async () => {
    window.history.replaceState(null, '', '/support/overview/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const totals = await waitFor(() => {
      const list = document.querySelector('.sa-stats');
      if (!list) throw new Error('no stats');
      return list as HTMLElement;
    });
    expect([...totals.querySelectorAll('div')].map(d => d.textContent)).toEqual(
      [
        'New4',
        'Resolved2',
        'Median first response2 hr',
        'Median resolution2 days',
      ]
    );
    const [byInbox, byAgent] = screen.getAllByRole('table');
    expect(
      within(byInbox as HTMLElement).getByRole('row', { name: /Sales/ })
        .textContent
    ).toBe('Sales422 hr2 days');
    expect(
      within(byAgent as HTMLElement).getByRole('row', { name: /Unassigned/ })
        .textContent
    ).toBe('Unassigned4230 min—');
    expect(screen.getByText('billing · 3')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: '7' },
    });
    expect(
      await screen.findByText(
        'No conversations were opened or resolved in this period.'
      )
    ).toBeTruthy();
  });
});

describe('features the host turns off', () => {
  // Routes a test overrides are put back as they were when it ends.
  const setRoutes = (entries: Record<string, unknown>) => {
    const before = Object.fromEntries(
      Object.keys(entries).map(k => [k, routes[k]])
    );
    Object.assign(routes, entries);
    onTestFinished(() => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete routes[k];
        else routes[k] = v;
      }
    });
  };
  const withFeatures = (features: { deals: boolean; crm: boolean }) =>
    setRoutes({ 'agent/me/': { ...me, features } });
  const navOf = async () =>
    within(await screen.findByRole('navigation', { name: 'Sections' }));

  it('shows the Deals tab and board by default', async () => {
    window.history.replaceState(null, '', '/support/deals/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const nav = await navOf();
    expect(nav.getByRole('button', { name: 'Deals' })).toBeTruthy();
    expect(nav.getByRole('button', { current: 'page' }).textContent).toBe(
      'Deals'
    );
  });

  it('shows no Deals tab, and a deals address opens the inbox, when deals are off', async () => {
    withFeatures({ deals: false, crm: true });
    window.history.replaceState(null, '', '/support/deals/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const nav = await navOf();
    expect(nav.queryByRole('button', { name: 'Deals' })).toBeNull();
    expect(nav.getByRole('button', { name: 'Contacts' })).toBeTruthy();
    expect(nav.getByRole('button', { current: 'page' }).textContent).toBe(
      'Inbox'
    );
  });

  it('hides the Contacts and Companies lists and their tabs when the CRM is off', async () => {
    withFeatures({ deals: true, crm: false });
    window.history.replaceState(null, '', '/support/contacts/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    const nav = await navOf();
    expect(nav.queryByRole('button', { name: 'Contacts' })).toBeNull();
    expect(nav.queryByRole('button', { name: 'Companies' })).toBeNull();
    expect(nav.getByRole('button', { name: 'Deals' })).toBeTruthy();
    expect(nav.getByRole('button', { current: 'page' }).textContent).toBe(
      'Inbox'
    );
  });

  it('still shows a conversation’s contact and company card when the CRM is off', async () => {
    withFeatures({ deals: true, crm: false });
    setRoutes({
      'agent/conversations/c1/': {
        ...(original as object),
        company: { id: 'co1', name: 'Acme', domain: 'acme.test' },
      },
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await waitFor(() =>
      expect(
        document.querySelector('a[href="/support/contacts/p1/"]')
      ).not.toBeNull()
    );
    expect(
      document.querySelector('a[href="/support/companies/co1/"]')
    ).not.toBeNull();
    expect(unrouted).toEqual([]);
  });

  it('hides the create-deal button on a lead when deals are off', async () => {
    withFeatures({ deals: false, crm: true });
    setRoutes({
      'agent/conversations/c1/': {
        ...(original as object),
        conversation: { ...conversation, type: 'lead' },
      },
    });
    window.history.replaceState(null, '', '/support/conversations/c1/');
    render(<HelpdeskAdmin basePath="/support" locale="en" />);
    await waitFor(() =>
      expect(
        document.querySelector('a[href="/support/contacts/p1/"]')
      ).not.toBeNull()
    );
    expect(screen.queryByRole('button', { name: 'Create deal' })).toBeNull();
  });
});
