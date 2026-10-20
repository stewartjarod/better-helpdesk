import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { type Locale, PRIORITIES, STATUSES } from './config';
import { clock } from './db/adapter';
import type {
  Agent,
  Company,
  Contact,
  Conversation,
  Message,
} from './db/store';
import { formatReference } from './domain';
import { emitUpdated } from './events';
import { toInbound } from './inbound/parse';
import { fromDomainSigned } from './inbound/verify';
import { plainText } from './rich';
import {
  ATTACHMENT_TYPES,
  type Customer,
  type Helpdesk,
  HelpdeskError,
  MAX_ADDRESS,
  MAX_ATTACHMENTS,
} from './service';
import { sourceOf } from './source';
import { translator } from './ui/i18n';

type Params = { id: string; attachmentId: string };
type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  run: (ctx: {
    request: Request;
    params: Params;
    url: URL;
    body: () => Promise<unknown>;
  }) => Promise<Response>;
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c
  );

/** A small page of its own, for links opened from an email; with `button`, a form that posts back to the same URL. */
function page(locale: Locale, status: number, text: string, button?: string) {
  const form = button
    ? `<form method="post"><button type="submit">${escapeHtml(button)}</button></form>`
    : '';
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(text)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0c2034}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#0c2034;color:#f0f4f8;cursor:pointer}</style></head><body><p>${escapeHtml(text)}</p>${form}</body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The URL carries the signature.
        'referrer-policy': 'no-referrer',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      },
    }
  );
}

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });

const uuid = z.uuid();
const previewOf = (body: string | undefined, length: number) =>
  body
    ? plainText(body.slice(0, 2000)).replace(/\s+/g, ' ').slice(0, length)
    : null;
/** What the widget says after a first message, per locale; `{email}` and `{reference}` are filled in. */
type ConfirmationSetting = Partial<Record<Locale, string>>;
const MAX_TAGS = 50;
const MAX_VIEWS = 50;
/** The inbox filters a saved view keeps, in the order it stores them. */
const VIEW_FILTERS = [
  'inbox',
  'status',
  'assignee',
  'q',
  'tag',
  'sort',
  'priority',
];
// A message is at most 20,000 characters; this leaves room for its context.
const MAX_JSON_BYTES = 256 * 1024;
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
const MAX_INBOUND_HEADER_BYTES = 64 * 1024;

export function createHandler(support: Helpdesk) {
  const { config, store } = support;
  const routes: Route[] = [];
  const ownOrigin = new URL(config.adminUrl).origin;
  const allowedOrigins = new Set(
    Object.values(config.inboxes).flatMap(i => i.allowedOrigins ?? [])
  );

  const define: RouteDefiner = (method, path, run) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })}/?$`
    );
    routes.push({ method, pattern, keys, run });
  };

  const customerView = (customer: Customer, c: Conversation) => ({
    id: c.id,
    reference: support.reference(c),
    subject: c.subject,
    type: c.type,
    // In the customer's terms: who holds the ball.
    status:
      c.status === 'resolved'
        ? 'resolved'
        : c.waitingSince
          ? 'open'
          : 'pending',
    inbox: c.inbox,
    sharedWithCompany: c.sharedWithCompany,
    own: c.contactId === customer.contact?.id,
    lastMessageAt: c.lastMessageAt,
    unread:
      c.contactId === customer.contact?.id &&
      (!c.customerSeenAt || c.customerSeenAt < c.lastMessageAt) &&
      c.waitingSince === null,
    rating: c.rating,
    merged: c.mergedIntoId !== null,
    // The newest message an agent has opened the thread on; the widget shows "Seen" from it.
    agentSeenAt: c.agentSeenAt,
    createdAt: c.createdAt,
  });

  // Widget ------------------------------------------------------------------

  define('GET', 'widget/session', async ({ request, url }) => {
    const customer = await support.resolveCustomer(request, { create: false });
    const conversations = await store.listCustomerConversations(
      customer.contact?.id ?? null,
      customer.companies.map(c => c.id)
    );
    const last = await store.lastMessages(conversations.map(c => c.id));
    const key = url.searchParams.get('inbox') ?? '';
    const inbox = Object.hasOwn(config.inboxes, key)
      ? config.inboxes[key]
      : undefined;
    const team = (await store.recentAgents(3)).flatMap(a =>
      a.name
        ? [{ name: a.name, initials: initials(a.name), avatarUrl: a.avatarUrl }]
        : []
    );
    const awayUntil = await support.teamAwayUntil();
    const confirmation =
      await store.getSetting<ConfirmationSetting>('confirmation');
    return json({
      // Agents using the widget in the host app see what waits in their inbox.
      agent: customer.identity?.isAgent
        ? {
            waiting: await store.countWaiting(),
            url: `${config.adminUrl.replace(/\/$/, '')}/conversations/`,
          }
        : null,
      awayUntil: awayUntil?.toISOString() ?? null,
      nextOpening: support.reopensAt(key, awayUntil)?.toISOString() ?? null,
      confirmation:
        confirmation?.[support.toLocale(url.searchParams.get('locale'))] ||
        null,
      inbox: inbox
        ? {
            title: inbox.title ?? null,
            replyPromise: inbox.replyPromise ?? null,
            privacyUrl:
              inbox.privacyUrl?.[
                support.toLocale(url.searchParams.get('locale'))
              ] ?? null,
            qualify: inbox.qualify ?? null,
            bookingUrl: inbox.bookingUrl ?? null,
          }
        : null,
      team,
      teamName:
        config.teamName?.[support.toLocale(url.searchParams.get('locale'))] ??
        null,
      identified: Boolean(customer.identity),
      name: customer.identity?.user.name ?? customer.contact?.name ?? null,
      email: customer.identity?.user.email ?? customer.contact?.email ?? null,
      orgs: await support.namedOrgs(customer.identity),
      types: config.types,
      help: Boolean(config.help),
      uploads: Boolean(config.storage),
      conversations: conversations.map(c => ({
        ...customerView(customer, c),
        preview: previewOf(last.get(c.id)?.body, 140),
        lastFromSupport: last.get(c.id)?.authorType === 'agent',
      })),
    });
  });

  define('POST', 'widget/conversations', async ({ request, body }) => {
    const { conversation, visitorToken } = await support.createConversation(
      request,
      await body()
    );
    return json(
      {
        conversation: conversation
          ? { id: conversation.id, reference: support.reference(conversation) }
          : null,
        visitorToken,
      },
      201
    );
  });

  define('GET', 'widget/conversations/:id', async ({ request, params }) => {
    const customer = await support.resolveCustomer(request, {
      create: false,
    });
    const conversation = await support.requireVisible(customer, params.id);
    const messages = await store.listMessages(conversation.id, {
      includeInternal: false,
    });
    const files = await store.listAttachments(conversation.id);
    return json({
      conversation: customerView(customer, conversation),
      messages: messages.map(m => ({
        id: m.message.id,
        author: m.message.authorType,
        name:
          m.message.authorType === 'agent'
            ? (m.agentName ?? null)
            : (m.contactName ?? null),
        own: m.message.contactId === customer.contact?.id,
        body: m.message.body,
        createdAt: m.message.createdAt,
      })),
      attachments: files.map(f => ({
        id: f.id,
        messageId: f.messageId,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
      })),
    });
  });

  define(
    'POST',
    'widget/conversations/:id/messages',
    async ({ request, params, body }) => {
      let customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      // A teammate who reads a shared thread before ever writing to support
      // has no contact yet; one is made only once the thread is visible.
      if (!customer.contact && customer.identity) {
        customer = await support.resolveCustomer(request, { create: true });
      }
      const data = z
        .object({ body: z.string().trim().min(1).max(20_000) })
        .parse(await body());
      const message = await support.addCustomerMessage(
        request,
        customer,
        conversation,
        data.body
      );
      return json({ id: message.id }, 201);
    }
  );

  define(
    'PATCH',
    'widget/conversations/:id',
    async ({ request, params, body }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      if (conversation.contactId !== customer.contact?.id) {
        throw new HelpdeskError(403, 'Only the author can change this');
      }
      const data = z
        .object({
          sharedWithCompany: z.boolean().optional(),
          status: z.literal('resolved').optional(),
        })
        .refine(d => d.sharedWithCompany !== undefined || d.status, {
          message: 'Nothing to change',
        })
        .parse(await body());
      if (data.sharedWithCompany !== undefined) {
        if (data.sharedWithCompany && !conversation.companyId) {
          throw new HelpdeskError(400, 'Conversation has no organization');
        }
        // An agent may have linked the thread to a company its author never proved membership of.
        if (
          data.sharedWithCompany &&
          !customer.companies.some(c => c.id === conversation.companyId)
        ) {
          throw new HelpdeskError(403, 'Not a member of that organization');
        }
        // An agent may move the thread between the check above and this write.
        if (
          conversation.companyId &&
          !(await store.setSharing(
            conversation.id,
            conversation.companyId,
            data.sharedWithCompany
          ))
        ) {
          throw new HelpdeskError(409, 'Conversation moved');
        }
      }
      // A repeat would move resolvedAt and with it the retention deadline.
      if (data.status && conversation.status !== 'resolved') {
        const patch: Partial<Conversation> = {
          status: 'resolved',
          resolvedAt: clock(),
          waitingSince: null,
          snoozedUntil: null,
        };
        const updated = await store.updateConversation(conversation.id, patch, {
          unlessResolved: true,
        });
        await emitUpdated(
          config,
          conversation,
          updated,
          patch,
          null,
          'customer'
        );
      }
      return json({ ok: true });
    }
  );

  define(
    'POST',
    'widget/conversations/:id/rating',
    async ({ request, params, body }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      if (conversation.contactId !== customer.contact?.id) {
        throw new HelpdeskError(403, 'Only the author can rate this');
      }
      const data = z
        .object({
          rating: z.enum(['good', 'bad']),
          comment: z.string().trim().max(2000).optional(),
        })
        .parse(await body());
      const updated = await support.rateAsCustomer(
        conversation,
        data.rating,
        data.comment
      );
      if (!updated) {
        throw new HelpdeskError(409, 'Not open for a rating');
      }
      return json({ conversation: customerView(customer, updated) });
    }
  );

  define(
    'POST',
    'widget/conversations/:id/seen',
    async ({ request, params }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      if (conversation.contactId === customer.contact?.id) {
        await store.updateConversation(conversation.id, {
          customerSeenAt: clock(),
        });
      }
      return json({ ok: true });
    }
  );

  const uploadInput = z.object({
    filename: z.string().trim().min(1).max(200),
    contentType: z.string().regex(ATTACHMENT_TYPES),
    size: z.number().int().positive(),
  });

  async function startUpload(conversation: Conversation, raw: unknown) {
    if (!config.storage) throw new HelpdeskError(400, 'Uploads are disabled');
    const data = uploadInput.parse(raw);
    if (data.size > config.maxAttachmentBytes) {
      throw new HelpdeskError(413, 'File too large');
    }
    if ((await store.countAttachments(conversation.id)) >= MAX_ATTACHMENTS) {
      throw new HelpdeskError(429, 'Too many attachments');
    }
    const key = support.attachmentKey(conversation.id, data.filename);
    const attachment = await store.createAttachment({
      conversationId: conversation.id,
      messageId: null,
      key,
      filename: data.filename,
      contentType: data.contentType,
      size: data.size,
    });
    const upload = await config.storage.presignUpload(key, {
      contentType: data.contentType,
      maxBytes: config.maxAttachmentBytes,
    });
    return { id: attachment.id, upload };
  }

  async function completeUpload(conversation: Conversation, id: string) {
    const attachment = uuid.safeParse(id).success
      ? await store.getAttachment(id)
      : null;
    if (!attachment || attachment.conversationId !== conversation.id) {
      throw new HelpdeskError(404, 'Not found');
    }
    if (!(await config.storage?.exists(attachment.key))) {
      throw new HelpdeskError(409, 'Upload missing');
    }
    await store.updateAttachment(id, { uploaded: true });
    return { ok: true };
  }

  async function download(conversation: Conversation, id: string) {
    const attachment = uuid.safeParse(id).success
      ? await store.getAttachment(id)
      : null;
    if (
      !attachment?.uploaded ||
      attachment.conversationId !== conversation.id ||
      !config.storage
    ) {
      throw new HelpdeskError(404, 'Not found');
    }
    const location = await config.storage.presignDownload(
      attachment.key,
      attachment.filename
    );
    return new Response(null, {
      status: 302,
      headers: { location, 'cache-control': 'no-store' },
    });
  }

  define(
    'POST',
    'widget/conversations/:id/attachments',
    async ({ request, params, body }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      // Files live with the author's thread, so erasing a person erases theirs.
      if (conversation.contactId !== customer.contact?.id) {
        throw new HelpdeskError(403, 'Only the author can attach files');
      }
      await support.limitCustomer(request, customer);
      return json(await startUpload(conversation, await body()), 201);
    }
  );

  define(
    'POST',
    'widget/conversations/:id/attachments/:attachmentId/complete',
    async ({ request, params }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      if (conversation.contactId !== customer.contact?.id) {
        throw new HelpdeskError(403, 'Only the author can attach files');
      }
      return json(await completeUpload(conversation, params.attachmentId));
    }
  );

  define(
    'GET',
    'widget/conversations/:id/attachments/:attachmentId',
    async ({ request, params }) => {
      const customer = await support.resolveCustomer(request, {
        create: false,
      });
      const conversation = await support.requireVisible(customer, params.id);
      return download(conversation, params.attachmentId);
    }
  );

  define('GET', 'widget/help', async ({ url }) => {
    const q = url.searchParams.get('q')?.trim().slice(0, 200);
    if (!q || !config.help) return json({ results: [] });
    const locale = support.toLocale(url.searchParams.get('locale'));
    return json({ results: (await config.help.search(q, locale)).slice(0, 5) });
  });

  // Agent -------------------------------------------------------------------

  const agentRoute = (
    method: string,
    path: string,
    run: (ctx: {
      request: Request;
      params: Params;
      url: URL;
      body: () => Promise<unknown>;
      agent: Agent;
    }) => Promise<Response>
  ) =>
    define(method, `agent/${path}`, async ctx =>
      run({ ...ctx, agent: await support.requireAgent(ctx.request) })
    );

  const tag = z.string().trim().min(1).max(50);
  const tags = z.array(tag).max(MAX_TAGS).optional();

  const requireConversation = async (id: string) => {
    if (!uuid.safeParse(id).success) throw new HelpdeskError(404, 'Not found');
    const conversation = await store.getConversation(id);
    if (!conversation) throw new HelpdeskError(404, 'Not found');
    return conversation;
  };

  // A contact's first captured context is only ever read for its source.
  const contactRow = ({
    firstContext,
    ...contact
  }: Awaited<ReturnType<typeof store.listContacts>>[number]) => ({
    ...contact,
    source: sourceOf(firstContext),
  });

  const agentView = (c: Conversation) => ({
    ...c,
    subject: c.title ?? c.subject,
    customerSubject: c.subject,
    search: undefined,
    reference: support.reference(c),
    unread:
      c.waitingSince !== null &&
      (!c.agentSeenAt || c.agentSeenAt < c.lastMessageAt),
  });

  agentRoute('GET', 'settings', async () =>
    json({
      confirmation:
        (await store.getSetting<ConfirmationSetting>('confirmation')) ?? {},
    })
  );

  agentRoute('PUT', 'settings', async ({ body }) => {
    const text = z.string().trim().max(1000).optional();
    const data = z
      .object({ confirmation: z.object({ en: text, de: text }) })
      .parse(await body());
    await store.setSetting('confirmation', data.confirmation);
    return json({ ok: true });
  });

  agentRoute('GET', 'overview', async ({ url }) => {
    const days = z
      .enum(['7', '30', '90'])
      .catch('30')
      .parse(url.searchParams.get('days'));
    return json(await support.overview(Number(days)));
  });

  agentRoute('PATCH', 'me', async ({ agent, body }) => {
    const data = z
      .object({ awayUntil: z.iso.datetime({ offset: true }).nullable() })
      .parse(await body());
    await store.setAgentAway(
      agent.id,
      data.awayUntil ? new Date(data.awayUntil) : null
    );
    return json({ ok: true });
  });

  agentRoute('GET', 'me', async ({ agent }) =>
    json({
      agent,
      referencePrefix: config.referencePrefix,
      types: config.types,
      statuses: STATUSES,
      priorities: PRIORITIES,
      inboxes: Object.keys(config.inboxes),
      inboxHours: Object.fromEntries(
        Object.entries(config.inboxes).flatMap(([key, inbox]) =>
          inbox.hours ? [[key, inbox.hours]] : []
        )
      ),
      inboxNames: Object.fromEntries(
        Object.entries(config.inboxes).map(([key, inbox]) => [
          key,
          inbox.name ?? {},
        ])
      ),
      leadStages: config.leadStages,
      dealStages: config.dealStages,
      customFields: config.customFields ?? {},
      segments: Object.fromEntries(
        Object.values(config.inboxes).flatMap(inbox =>
          (inbox.qualify?.options ?? []).map(o => [
            o.value,
            { label: o.label, badge: o.badge ?? o.label },
          ])
        )
      ),
      ai: Boolean(config.ai),
      features: config.features,
    })
  );

  agentRoute('GET', 'unread', async () =>
    json({ waiting: await store.countWaiting() })
  );

  agentRoute('GET', 'tags', async () => json({ tags: await store.topTags() }));

  agentRoute('GET', 'agents', async () =>
    json({ agents: await store.listAgents() })
  );

  agentRoute('DELETE', 'agents/:id', async ({ params }) => {
    const target = await requireRow(params.id, store.getAgent);
    await support.removeAgent(target.externalUserId);
    return json({ ok: true });
  });

  /** The agent inbox's query parameters as a filter, for its list and for saved views. */
  function inboxFilter(p: URLSearchParams, agentId: string) {
    const id = (key: string) => uuid.optional().parse(p.get(key) || undefined);
    const assignee = p.get('assignee');
    const status = p.get('status');
    return {
      inbox: p.get('inbox') || undefined,
      status: status && status !== 'any' ? status : undefined,
      assigneeId:
        assignee === 'me'
          ? agentId
          : assignee === 'none'
            ? null
            : id('assignee'),
      contactId: id('contactId'),
      companyId: id('companyId'),
      tag: p.get('tag')?.trim().toLowerCase() || undefined,
      query: p.get('q') || undefined,
      priority: p.get('priority') === 'high' ? ('high' as const) : undefined,
      sort:
        p.get('sort') === 'priority'
          ? ('priority' as const)
          : ('waiting' as const),
    };
  }

  agentRoute('GET', 'conversations', async ({ url, agent }) => {
    const [rows, counts] = await Promise.all([
      store.listInbox(inboxFilter(url.searchParams, agent.id)),
      store.countOpen(agent.id),
    ]);
    const ids = rows.map(r => r.conversation.id);
    const [last, viewers] = await Promise.all([
      store.lastMessages(ids),
      store.viewers(ids, agent.id),
    ]);
    return json({
      counts,
      conversations: rows.map(r => ({
        ...agentView(r.conversation),
        preview: previewOf(last.get(r.conversation.id)?.body, 160),
        viewers: viewers.get(r.conversation.id) ?? [],
        contact: {
          id: r.contact.id,
          name: r.contact.name,
          email: r.contact.email,
        },
      })),
    });
  });

  type SavedView = { id: string; name: string; query: string };
  const viewsKey = (agentId: string | null) =>
    agentId ? `views:agent:${agentId}` : 'views:shared';
  const readViews = async (key: string) =>
    (await store.getSetting<SavedView[]>(key)) ?? [];
  // ponytail: read-modify-write on one setting row; two agents saving shared views in the same instant can drop one.
  async function findView(agentId: string, id: string) {
    for (const key of [viewsKey(agentId), viewsKey(null)]) {
      const views = await readViews(key);
      if (views.some(v => v.id === id)) return { key, views };
    }
    throw new HelpdeskError(404, 'Not found');
  }

  agentRoute('GET', 'notifications', async ({ agent }) => {
    const [rows, seenAt] = await Promise.all([
      store.notificationsFor(agent.id),
      store.notificationsSeenAt(agent.id),
    ]);
    return json({
      unread: rows.filter(r => !seenAt || r.at > seenAt).length,
      notifications: rows.map(r => ({
        kind: r.kind,
        conversationId: r.conversation_id,
        reference: formatReference(config.referencePrefix, r.number),
        subject: r.subject,
        who: r.who,
        at: r.at,
      })),
    });
  });

  agentRoute('POST', 'notifications/seen', async ({ agent }) => {
    await store.markNotificationsSeen(agent.id);
    return json({ ok: true });
  });

  agentRoute('GET', 'views', async ({ agent }) => {
    const [own, shared] = await Promise.all([
      readViews(viewsKey(agent.id)),
      readViews(viewsKey(null)),
    ]);
    const views = [
      ...own.map(v => ({ ...v, shared: false })),
      ...shared.map(v => ({ ...v, shared: true })),
    ];
    // A view stored before its filters were checked must not hide the others.
    const counts = await Promise.all(
      views.map(v => {
        try {
          return store.countInbox(
            inboxFilter(new URLSearchParams(v.query), agent.id)
          );
        } catch {
          return null;
        }
      })
    );
    return json({ views: views.map((v, i) => ({ ...v, count: counts[i] })) });
  });

  agentRoute('POST', 'views', async ({ agent, body }) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        query: z.string().max(2000),
        shared: z.boolean().default(false),
      })
      .parse(await body());
    const given = new URLSearchParams(data.query);
    const query = new URLSearchParams(
      VIEW_FILTERS.flatMap(k => {
        const value = given.get(k)?.trim();
        return value ? [[k, value]] : [];
      })
    ).toString();
    // Refuses what the inbox could not filter by, such as an unknown assignee.
    inboxFilter(new URLSearchParams(query), agent.id);
    const key = viewsKey(data.shared ? null : agent.id);
    const views = await readViews(key);
    if (views.length >= MAX_VIEWS) {
      throw new HelpdeskError(409, 'Too many views');
    }
    const view = { id: randomUUID(), name: data.name, query };
    await store.setSetting(key, [...views, view]);
    return json({ view: { ...view, shared: data.shared } }, 201);
  });

  agentRoute('PATCH', 'views/:id', async ({ agent, params, body }) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(80) })
      .parse(await body());
    const { key, views } = await findView(agent.id, params.id);
    await store.setSetting(
      key,
      views.map(v => (v.id === params.id ? { ...v, name } : v))
    );
    return json({ ok: true });
  });

  agentRoute('DELETE', 'views/:id', async ({ agent, params }) => {
    const { key, views } = await findView(agent.id, params.id);
    await store.setSetting(
      key,
      views.filter(v => v.id !== params.id)
    );
    return json({ ok: true });
  });

  /** The host's links for a contact and company; a failing hook or a non-web URL shows nothing rather than an error. */
  async function hostLinks(
    contact: Contact | null,
    company: Company | null,
    identities: { channel: string; externalId: string }[] = []
  ) {
    if (!config.links || (!contact && !company)) return [];
    try {
      const links = await config.links(
        contact && {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          userId:
            identities.find(i => i.channel === 'host')?.externalId ?? null,
        },
        company && {
          id: company.id,
          name: company.name,
          domain: company.domain,
          orgId: company.externalOrgId,
        }
      );
      return links.filter(link => {
        try {
          return ['http:', 'https:'].includes(new URL(link.url).protocol);
        } catch {
          return false;
        }
      });
    } catch (error) {
      console.error('[helpdesk] links failed', error);
      return [];
    }
  }

  agentRoute('GET', 'conversations/:id', async ({ params, agent }) => {
    const conversation = await requireConversation(params.id);
    const [
      contact,
      company,
      participants,
      messages,
      files,
      identities,
      events,
      viewers,
    ] = await Promise.all([
      store.getContact(conversation.contactId),
      conversation.companyId ? store.getCompany(conversation.companyId) : null,
      store.listParticipants(conversation.id),
      store.listMessages(conversation.id, { includeInternal: true }),
      store.listAttachments(conversation.id),
      store.listIdentities(conversation.contactId),
      store.listEvents(conversation.id),
      store.viewers([conversation.id], agent.id),
      // Written on the GET so opening a thread fires no HELPDESK_CHANGED refetch.
      store.markAgentSeen(conversation.id),
      store.markViewing(agent.id, conversation.id),
    ]);
    const domain = contact?.email?.split('@')[1];
    // A contact already filed under a company is offered that one; only an
    // unfiled one falls back to its email domain.
    const suggestedCompany = contact?.companyId
      ? await store.getCompany(contact.companyId)
      : domain
        ? await store.findCompanyByDomain(domain)
        : null;
    return json({
      conversation: agentView(conversation),
      contact: contact && {
        ...contact,
        verified: identities.some(i => i.verified),
      },
      company,
      suggestedCompany,
      links: await hostLinks(contact, company, identities),
      customerContext: conversation.companyId
        ? await support.companyContext(conversation.companyId)
        : {},
      participants: participants.map(p => p.contact),
      viewers: viewers.get(conversation.id) ?? [],
      messages: messages.map(m => ({
        ...m.message,
        search: undefined,
        agentName: m.agentName,
        contactName: m.contactName,
      })),
      attachments: files,
      events,
    });
  });

  const conversationBody = z.object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z
      .string()
      .refine(t => config.types.includes(t))
      .optional(),
    inbox: z
      .string()
      .refine(i => Object.hasOwn(config.inboxes, i))
      .optional(),
    subject: z.string().trim().max(200).nullable().optional(),
    assigneeId: uuid.nullable().optional(),
    companyId: uuid.nullable().optional(),
    tags: z
      .array(tag.toLowerCase())
      .max(MAX_TAGS)
      .transform(list => [...new Set(list)])
      .optional(),
    snoozedUntil: z.iso
      .datetime({ offset: true })
      .transform(v => new Date(v))
      .refine(d => d.getTime() > Date.now(), 'Must be in the future')
      .nullable()
      .optional(),
  });
  type ConversationBody = z.infer<typeof conversationBody>;

  const checkConversationBody = async (data: ConversationBody) => {
    if (data.snoozedUntil) {
      if (data.status && data.status !== 'pending') {
        throw new HelpdeskError(400, 'A snoozed conversation is pending');
      }
      data.status = 'pending';
    }
    if (data.assigneeId && !(await store.getActiveAgent(data.assigneeId))) {
      throw new HelpdeskError(400, 'Unknown agent');
    }
    if (data.companyId && !(await store.getCompany(data.companyId))) {
      throw new HelpdeskError(400, 'Unknown company');
    }
    return data;
  };

  /**
   * The row update an agent's change makes to `conversation` as it stands, with
   * whether it resolves it. `last` is its newest public message, needed when
   * a resolved conversation is reopened.
   */
  function conversationPatch(
    conversation: Conversation,
    data: ConversationBody,
    last: Message | undefined
  ) {
    const { subject, ...rest } = data;
    const patch: Partial<Conversation> = {
      ...rest,
      ...(subject !== undefined ? { title: subject } : {}),
    };
    // A snooze left on an open thread would hold back its reminders.
    if (data.status && data.status !== 'pending') patch.snoozedUntil = null;
    // Sharing was granted to one organization; it does not follow a move.
    if (
      data.companyId !== undefined &&
      data.companyId !== conversation.companyId
    ) {
      patch.sharedWithCompany = false;
    }
    const resolving =
      data.status === 'resolved' && conversation.status !== 'resolved';
    if (resolving) {
      patch.resolvedAt = clock();
      patch.waitingSince = null;
    } else if (data.status && data.status !== 'resolved') {
      patch.resolvedAt = null;
      // Reopened while the customer had the last word: they are waiting again.
      if (
        conversation.status === 'resolved' &&
        last?.authorType === 'contact'
      ) {
        patch.waitingSince = last.createdAt;
      }
    }
    return { patch, resolving };
  }

  agentRoute('PATCH', 'conversations/:id', async ({ params, body, agent }) => {
    const conversation = await requireConversation(params.id);
    const data = await checkConversationBody(
      conversationBody.parse(await body())
    );
    const last =
      conversation.status === 'resolved'
        ? (await store.lastMessages([conversation.id])).get(conversation.id)
        : undefined;
    const { patch, resolving } = conversationPatch(conversation, data, last);
    // A concurrent resolve that lands first keeps its resolvedAt and its timeline row.
    const updated = await store.updateConversation(conversation.id, patch, {
      unlessResolved: resolving,
    });
    await emitUpdated(config, conversation, updated, patch, agent.id);
    const current = updated ?? (await store.getConversation(conversation.id));
    return json({ conversation: current && agentView(current) });
  });

  const bulkBody = conversationBody
    .omit({ subject: true, companyId: true, tags: true })
    .extend({
      ids: z
        .array(uuid)
        .min(1)
        .max(100)
        .transform(list => [...new Set(list)]),
      addTag: tag.toLowerCase().optional(),
    });

  agentRoute('POST', 'conversations/bulk', async ({ body, agent }) => {
    const { ids, addTag, ...fields } = bulkBody.parse(await body());
    const data = await checkConversationBody(fields);
    // Read before the transaction: inside it a second pool connection could
    // wait on connections held by batches that wait on it.
    const lastMessages =
      data.status && data.status !== 'resolved'
        ? await store.lastMessages(ids)
        : new Map<string, Message>();
    const { missing, changes } = await store.updateConversations(
      ids,
      conversation => {
        const tags =
          addTag && !conversation.tags.includes(addTag)
            ? [...conversation.tags, addTag]
            : undefined;
        if (tags && tags.length > MAX_TAGS) {
          throw new HelpdeskError(400, 'Too many tags', [conversation.id]);
        }
        return conversationPatch(
          conversation,
          tags ? { ...data, tags } : data,
          lastMessages.get(conversation.id)
        ).patch;
      }
    );
    if (missing.length > 0) throw new HelpdeskError(404, 'Not found', missing);
    for (const { before, updated, patch } of changes) {
      await emitUpdated(config, before, updated, patch, agent.id);
    }
    return json({ ok: true });
  });

  agentRoute(
    'POST',
    'conversations/:id/messages',
    async ({ params, body, agent }) => {
      const conversation = await requireConversation(params.id);
      const data = z
        .object({
          body: z.string().trim().min(1).max(20_000),
          internal: z.boolean().default(false),
          notify: z.array(uuid).max(20).default([]),
        })
        .parse(await body());
      const message = await support.addAgentMessage(
        agent.id,
        conversation,
        data.body,
        data.internal,
        data.notify
      );
      return json({ id: message.id }, 201);
    }
  );

  agentRoute(
    'POST',
    'conversations/:id/participants',
    async ({ params, body, agent }) => {
      const conversation = await requireConversation(params.id);
      const data = z.object({ contactId: uuid }).parse(await body());
      if (!(await store.getContact(data.contactId))) {
        throw new HelpdeskError(400, 'Unknown contact');
      }
      if (await store.addParticipant(conversation.id, data.contactId)) {
        await store.recordEvents([
          {
            conversationId: conversation.id,
            agentId: agent.id,
            kind: 'participant.added',
            data: { contactId: data.contactId },
          },
        ]);
      }
      return json({ ok: true });
    }
  );

  agentRoute(
    'POST',
    'conversations/:id/merge',
    async ({ params, body, agent }) => {
      const source = await requireConversation(params.id);
      const { targetId } = z.object({ targetId: uuid }).parse(await body());
      if (targetId === source.id) {
        throw new HelpdeskError(400, 'A conversation cannot merge into itself');
      }
      const target = await store.getConversation(targetId);
      if (!target) throw new HelpdeskError(400, 'Unknown conversation');
      const merged = await store.mergeConversation(
        source.id,
        target.id,
        agent.id,
        {
          source: support.reference(source),
          target: support.reference(target),
        }
      );
      if (!merged) throw new HelpdeskError(409, 'Already merged');
      return json({ ok: true });
    }
  );

  agentRoute('POST', 'conversations/:id/draft', async ({ params, body }) => {
    const conversation = await requireConversation(params.id);
    // Asking for a draft took no body before rewrites existed, so none still means a draft.
    const raw = await body().catch(error => {
      if (error instanceof SyntaxError) return {};
      throw error;
    });
    const data = z
      .object({
        mode: z.enum(['shorten', 'formal', 'translate']).optional(),
        text: z.string().trim().min(1).max(20_000).optional(),
      })
      .refine(d => !d.mode || d.text, { message: 'A mode needs the text' })
      .parse(raw ?? {});
    return json({
      text:
        data.mode && data.text
          ? await support.rewriteDraft(conversation, data.mode, data.text)
          : await support.draftReply(conversation),
    });
  });

  agentRoute('POST', 'conversations/:id/triage', async ({ params }) => {
    const conversation = await requireConversation(params.id);
    if (!config.ai) throw new HelpdeskError(400, 'AI is not configured');
    await support.triage(conversation);
    return json({ ok: true });
  });

  agentRoute(
    'POST',
    'conversations/:id/suggestion',
    async ({ params, body, agent }) => {
      const conversation = await requireConversation(params.id);
      const suggestion = conversation.aiSuggestion;
      if (!suggestion) throw new HelpdeskError(404, 'No suggestion');
      const data = z
        .object({ action: z.enum(['accept', 'dismiss']) })
        .parse(await body());
      if (data.action === 'accept' && suggestion.acceptedAt) {
        return json({ ok: true });
      }
      if (data.action === 'dismiss') {
        await store.updateConversation(conversation.id, { aiSuggestion: null });
      } else {
        const patch = {
          type: suggestion.type ?? conversation.type,
          priority: suggestion.priority ?? conversation.priority,
          // An agent's own title stands; the banner never offered to replace it.
          title: conversation.title ?? suggestion.title,
          aiSuggestion: { ...suggestion, acceptedAt: clock().toISOString() },
        };
        const updated = await store.updateConversation(conversation.id, patch);
        await emitUpdated(config, conversation, updated, patch, agent.id);
      }
      await store.recordEvents([
        {
          conversationId: conversation.id,
          agentId: agent.id,
          kind:
            data.action === 'accept'
              ? 'suggestion.accepted'
              : 'suggestion.dismissed',
        },
      ]);
      return json({ ok: true });
    }
  );

  agentRoute(
    'GET',
    'conversations/:id/attachments/:attachmentId',
    async ({ params }) =>
      download(await requireConversation(params.id), params.attachmentId)
  );

  agentRoute('GET', 'canned', async () =>
    json({ replies: await store.listCannedReplies() })
  );

  const cannedReply = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    locale: z.enum(['en', 'de', 'fr', 'it']).nullable().optional(),
  });

  agentRoute('POST', 'canned', async ({ body }) => {
    const data = cannedReply.parse(await body());
    return json({ reply: await store.createCannedReply(data) }, 201);
  });

  agentRoute('PATCH', 'canned/:id', async ({ params, body }) => {
    if (!uuid.safeParse(params.id).success)
      throw new HelpdeskError(404, 'Not found');
    const data = cannedReply.parse(await body());
    const replaced = { ...data, locale: data.locale ?? null };
    if (!(await store.updateCannedReply(params.id, replaced)))
      throw new HelpdeskError(404, 'Not found');
    return json({ ok: true });
  });

  agentRoute('DELETE', 'canned/:id', async ({ params }) => {
    if (!uuid.safeParse(params.id).success)
      throw new HelpdeskError(404, 'Not found');
    await store.deleteCannedReply(params.id);
    return json({ ok: true });
  });

  // CRM ---------------------------------------------------------------------

  // A value equal to the stored one passes, so a record whose field or stage
  // the host has since removed can still be saved with its other changes.
  const customValues = (
    entity: 'contact' | 'company' | 'deal',
    stored: Record<string, unknown>
  ) =>
    z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .superRefine((values, ctx) => {
        const defs = config.customFields?.[entity] ?? [];
        for (const [key, value] of Object.entries(values)) {
          if (value === stored[key]) continue;
          const def = defs.find(d => d.key === key);
          if (!def) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'Unknown field',
            });
          } else if (value !== null && !customValueValid(def, value)) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'Invalid value',
            });
          }
        }
      });

  const requireRow = async <T>(
    id: string,
    get: (id: string) => Promise<T | null>
  ) => {
    if (!uuid.safeParse(id).success) throw new HelpdeskError(404, 'Not found');
    const row = await get(id);
    if (!row) throw new HelpdeskError(404, 'Not found');
    return row;
  };

  const leadStage = (stored?: string | null) =>
    z
      .string()
      .refine(s => config.leadStages.includes(s) || s === stored)
      .nullable()
      .optional();

  agentRoute('GET', 'contacts', async ({ url }) => {
    const p = url.searchParams;
    return json({
      contacts: (
        await store.listContacts({
          query: p.get('q') || undefined,
          leadStage: p.get('leadStage') || undefined,
          companyId: uuid.optional().parse(p.get('companyId') || undefined),
        })
      ).map(contactRow),
    });
  });

  agentRoute('POST', 'contacts', async ({ body }) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.email().max(MAX_ADDRESS).optional(),
        companyId: uuid.nullable().optional(),
        leadStage: leadStage(),
      })
      .parse(await body());
    if (data.companyId) await requireRow(data.companyId, store.getCompany);
    const contact = await store.createContact({
      ...data,
      email: data.email?.toLowerCase() ?? null,
    });
    return json({ contact }, 201);
  });

  agentRoute('GET', 'contacts/:id', async ({ params }) => {
    const contact = await requireRow(params.id, store.getContact);
    const [identities, company, conversations, activities, deals] =
      await Promise.all([
        store.listIdentities(contact.id),
        contact.companyId ? store.getCompany(contact.companyId) : null,
        store.listInbox({ contactId: contact.id }),
        store.listActivities({ contactId: contact.id }),
        store.listDeals({ contactId: contact.id }),
      ]);
    const first = conversations
      .map(r => r.conversation)
      .reduce<Conversation | undefined>(
        (a, c) => (!a || c.createdAt < a.createdAt ? c : a),
        undefined
      );
    return json({
      contact: { ...contact, source: sourceOf(first?.context) },
      identities: identities.map(i => ({
        channel: i.channel,
        verified: i.verified,
        externalId: i.channel === 'visitor' ? null : i.externalId,
      })),
      company,
      links: await hostLinks(contact, company, identities),
      conversations: conversations.map(r => agentView(r.conversation)),
      timeline: await timeline(
        conversations.map(r => r.conversation),
        activities
      ),
      deals: deals.map(d => d.deal),
    });
  });

  agentRoute('PATCH', 'contacts/:id', async ({ params, body }) => {
    const contact = await requireRow(params.id, store.getContact);
    const data = z
      .object({
        name: z.string().trim().max(200).nullable().optional(),
        companyId: uuid.nullable().optional(),
        leadStage: leadStage(contact.leadStage),
        tags,
        custom: customValues('contact', contact.custom).optional(),
        blocked: z.boolean().optional(),
      })
      .parse(await body());
    if (data.companyId) await requireRow(data.companyId, store.getCompany);
    return json({ contact: await store.updateContact(contact.id, data) });
  });

  agentRoute('POST', 'contacts/:id/merge', async ({ params, body }) => {
    const target = await requireRow(params.id, store.getContact);
    const data = z.object({ sourceId: uuid }).parse(await body());
    await requireRow(data.sourceId, store.getContact);
    await store.mergeContacts(target.id, data.sourceId);
    return json({ ok: true });
  });

  agentRoute('DELETE', 'contacts/:id', async ({ params }) => {
    const contact = await requireRow(params.id, store.getContact);
    return json(await support.deleteContact(contact.id));
  });

  agentRoute('GET', 'companies', async ({ url }) =>
    json({
      companies: await store.listCompanies({
        query: url.searchParams.get('q') || undefined,
        leadStage: url.searchParams.get('leadStage') || undefined,
      }),
    })
  );

  agentRoute('POST', 'companies', async ({ body }) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(200),
        domain: z.string().trim().toLowerCase().max(200).nullable().optional(),
        leadStage: leadStage(),
      })
      .parse(await body());
    return json({ company: await store.createCompany(data) }, 201);
  });

  agentRoute('GET', 'companies/:id', async ({ params }) => {
    const company = await requireRow(params.id, store.getCompany);
    const [contactList, conversations, activities, deals] = await Promise.all([
      store.listContacts({ companyId: company.id }),
      store.listInbox({ companyId: company.id }),
      store.listActivities({ companyId: company.id }),
      store.listDeals({ companyId: company.id }),
    ]);
    return json({
      company,
      context: await support.companyContext(company.id),
      links: await hostLinks(null, company),
      contacts: contactList.map(contactRow),
      conversations: conversations.map(r => agentView(r.conversation)),
      timeline: await timeline(
        conversations.map(r => r.conversation),
        activities
      ),
      deals: deals.map(d => d.deal),
    });
  });

  agentRoute('PATCH', 'companies/:id', async ({ params, body }) => {
    const company = await requireRow(params.id, store.getCompany);
    const data = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        domain: z.string().trim().toLowerCase().max(200).nullable().optional(),
        leadStage: leadStage(company.leadStage),
        tags,
        custom: customValues('company', company.custom).optional(),
      })
      .parse(await body());
    return json({ company: await store.updateCompany(company.id, data) });
  });

  const dealStage = (stored?: string) =>
    z.string().refine(s => config.dealStages.includes(s) || s === stored);

  // Off, a deal route is not registered at all, so it answers the 404 an unknown path gets.
  const dealRoute: typeof agentRoute = (...args) => {
    if (config.features.deals) agentRoute(...args);
  };

  dealRoute('GET', 'deals', async () => {
    const rows = await store.listDeals({});
    return json({
      deals: rows.map(r => ({
        ...r.deal,
        companyName: r.companyName,
        contactName: r.contactName,
      })),
    });
  });

  dealRoute('POST', 'deals', async ({ body, agent }) => {
    const data = z
      .object({
        title: z.string().trim().min(1).max(200),
        companyId: uuid.nullable().optional(),
        contactId: uuid.nullable().optional(),
        stage: dealStage().optional(),
        value: z.number().nonnegative().nullable().optional(),
        currency: z.string().length(3).optional(),
        expectedCloseAt: z.iso.datetime().nullable().optional(),
      })
      .parse(await body());
    if (data.companyId) await requireRow(data.companyId, store.getCompany);
    if (data.contactId) await requireRow(data.contactId, store.getContact);
    const deal = await store.createDeal({
      ...data,
      stage: data.stage ?? config.dealStages[0] ?? 'new',
      value: data.value == null ? null : String(data.value),
      expectedCloseAt: data.expectedCloseAt
        ? new Date(data.expectedCloseAt)
        : null,
      ownerId: agent.id,
    });
    return json({ deal }, 201);
  });

  dealRoute('PATCH', 'deals/:id', async ({ params, body }) => {
    const deal = await requireRow(params.id, store.getDeal);
    const data = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        stage: dealStage(deal.stage).optional(),
        value: z.number().nonnegative().nullable().optional(),
        currency: z.string().length(3).optional(),
        expectedCloseAt: z.iso.datetime().nullable().optional(),
        ownerId: uuid.nullable().optional(),
        custom: customValues('deal', deal.custom).optional(),
      })
      .parse(await body());
    if (data.ownerId && !(await store.getActiveAgent(data.ownerId))) {
      throw new HelpdeskError(400, 'Unknown agent');
    }
    const updated = await store.updateDeal(deal.id, {
      ...data,
      value:
        data.value === undefined
          ? undefined
          : data.value === null
            ? null
            : String(data.value),
      expectedCloseAt:
        data.expectedCloseAt === undefined
          ? undefined
          : data.expectedCloseAt
            ? new Date(data.expectedCloseAt)
            : null,
      ...(data.stage && data.stage !== deal.stage
        ? { stageChangedAt: clock() }
        : {}),
    });
    return json({ deal: updated });
  });

  dealRoute('DELETE', 'deals/:id', async ({ params }) => {
    const deal = await requireRow(params.id, store.getDeal);
    await store.deleteDeal(deal.id);
    return json({ ok: true });
  });

  agentRoute('POST', 'activities', async ({ body, agent }) => {
    const data = z
      .object({
        kind: z.enum(['note', 'call', 'meeting']),
        body: z.string().trim().min(1).max(20_000),
        contactId: uuid.optional(),
        companyId: uuid.optional(),
        dealId: uuid.optional(),
        occurredAt: z.iso.datetime().optional(),
      })
      .refine(d => d.contactId || d.companyId || d.dealId)
      .parse(await body());
    if (data.contactId) await requireRow(data.contactId, store.getContact);
    if (data.companyId) await requireRow(data.companyId, store.getCompany);
    if (data.dealId) {
      if (!config.features.deals) throw new HelpdeskError(404, 'Not found');
      await requireRow(data.dealId, store.getDeal);
    }
    const activity = await store.createActivity({
      ...data,
      agentId: agent.id,
      occurredAt: data.occurredAt ? new Date(data.occurredAt) : clock(),
    });
    return json({ activity }, 201);
  });

  async function timeline(
    list: Conversation[],
    activities: Awaited<ReturnType<typeof store.listActivities>>
  ) {
    return [
      ...list.map(c => ({
        kind: 'conversation' as const,
        at: c.createdAt,
        id: c.id,
        title: `${support.reference(c)} ${c.title ?? c.subject ?? ''}`.trim(),
      })),
      ...activities.map(a => ({
        kind: a.activity.kind,
        at: a.activity.occurredAt,
        id: a.activity.id,
        title: a.activity.event ?? a.activity.body ?? '',
        agentName: a.agentName,
        props: a.activity.props,
      })),
    ].sort((a, b) => +new Date(b.at) - +new Date(a.at));
  }

  // Inbound email -----------------------------------------------------------

  // Rating from an email: the link opens a page whose button records it, as a
  // mail scanner that follows every link must not cast a rating.
  async function ratePage(url: URL, submit: boolean) {
    const link = await support.verifyRatingLink(url.searchParams);
    const conversation =
      link && uuid.safeParse(link.conversationId).success
        ? await store.getConversation(link.conversationId)
        : null;
    if (!link || !conversation) {
      return page('en', 404, translator('en')('rate.invalid'));
    }
    const contact = await store.getContact(conversation.contactId);
    const locale = support.toLocale(contact?.locale);
    const t = translator(locale);
    const reference = support.reference(conversation);
    if (conversation.rating) {
      return page(locale, 200, t('rate.done', { reference }));
    }
    if (conversation.status !== 'resolved' || conversation.mergedIntoId) {
      return page(locale, 409, t('rate.closed', { reference }));
    }
    if (!submit) {
      return page(
        locale,
        200,
        t(`rate.confirm.${link.rating}`, { reference }),
        t(`rate.button.${link.rating}`)
      );
    }
    const updated = await support.rateAsCustomer(conversation, link.rating);
    return updated
      ? page(locale, 200, t(`rate.thanks.${link.rating}`, { reference }))
      : page(locale, 409, t('rate.closed', { reference }));
  }

  define('GET', 'rate', async ({ url }) => ratePage(url, false));
  define('POST', 'rate', async ({ url }) => ratePage(url, true));

  define('POST', 'inbound', async ({ request }) => {
    const secret = config.inboundWebhookSecret;
    const given = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secret || !given || !secretMatches(given, secret)) {
      throw new HelpdeskError(401, 'Unauthenticated');
    }
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_INBOUND_BYTES) throw new HelpdeskError(413, 'Too large');
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.byteLength === 0) throw new HelpdeskError(400, 'Empty message');
    if (raw.byteLength > MAX_INBOUND_BYTES) {
      throw new HelpdeskError(413, 'Too large');
    }
    // Header parsers downstream are not linear in a crafted header; real mail
    // headers stay far below this.
    const head = raw
      .subarray(0, MAX_INBOUND_HEADER_BYTES + 4)
      .toString('latin1');
    if (!/\r?\n\r?\n/.test(head)) {
      throw new HelpdeskError(413, 'Headers too large');
    }
    await support.handleInbound(
      await toInbound(raw, (raw, from) =>
        fromDomainSigned(raw, from, config.dnsResolver)
      )
    );
    return json({ ok: true }, 202);
  });

  // Jobs --------------------------------------------------------------------

  define('POST', 'jobs', async ({ request }) => {
    const secret = config.jobsSecret;
    const given = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secret || !given || !secretMatches(given, secret)) {
      throw new HelpdeskError(401, 'Unauthenticated');
    }
    return json(await support.runJobs());
  });

  function corsHeaders(request: Request, path: string): HeadersInit {
    const origin = request.headers.get('origin');
    if (!origin || origin === ownOrigin || !path.startsWith('widget/')) {
      return {};
    }
    if (!allowedOrigins.has(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      'access-control-allow-headers':
        'content-type, x-helpdesk-visitor, x-helpdesk-identity',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  /**
   * Mutations must be JSON and, when a browser says where they come from, come
   * from this app or an inbox's allowed origin. The JSON requirement forces a
   * CORS preflight, so a cross-site form cannot ride an agent's cookie.
   */
  function checkMutation(request: Request, path: string) {
    // `rate` acts only on the signed link in its own URL, never on a session.
    if (
      request.method === 'GET' ||
      path === 'jobs' ||
      path === 'inbound' ||
      path === 'rate'
    ) {
      return;
    }
    // Only a POST can come from a plain form; PATCH and DELETE always preflight.
    const type = request.headers.get('content-type') ?? '';
    if (request.method === 'POST' && !type.startsWith('application/json')) {
      throw new HelpdeskError(415, 'Expected application/json');
    }
    const origin = request.headers.get('origin');
    if (!origin || origin === ownOrigin) return;
    if (path.startsWith('widget/') && allowedOrigins.has(origin)) return;
    throw new HelpdeskError(403, 'Cross-origin request refused');
  }

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${config.basePath}/`)
      ? url.pathname.slice(config.basePath.length + 1).replace(/\/$/, '')
      : '';
    const cors = corsHeaders(request, path);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      // Params are ids, never encoded; decoding one would only let `%E0` throw.
      const values = Object.fromEntries(
        route.keys.map((key, i) => [key, match[i + 1] ?? ''])
      );
      const params: Params = {
        id: values.id ?? '',
        attachmentId: values.attachmentId ?? '',
      };
      try {
        checkMutation(request, path);
        const response = await route.run({
          request,
          params,
          url,
          body: () => readJson(request),
        });
        for (const [key, value] of Object.entries(cors)) {
          response.headers.set(key, value);
        }
        return response;
      } catch (error) {
        return errorResponse(error, cors);
      }
    }
    return json({ error: 'Not found' }, 404, cors);
  };
}

/** The JSON body, refused past `MAX_JSON_BYTES` before more of it is read. */
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) {
    throw new HelpdeskError(413, 'Too large');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new HelpdeskError(413, 'Too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

type RouteDefiner = (method: string, path: string, run: Route['run']) => void;

function errorResponse(error: unknown, headers: HeadersInit) {
  if (error instanceof HelpdeskError) {
    return json(
      { error: error.message, ...(error.ids && { ids: error.ids }) },
      error.status,
      headers
    );
  }
  if (error instanceof z.ZodError) {
    return json(
      {
        error: 'Invalid request',
        issues: error.issues.map(i => i.path.join('.')),
      },
      400,
      headers
    );
  }
  if (error instanceof SyntaxError) {
    return json({ error: 'Invalid JSON' }, 400, headers);
  }
  console.error('[helpdesk]', error);
  return json({ error: 'Internal error' }, 500, headers);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

function secretMatches(given: string, expected: string) {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function customValueValid(
  def: NonNullable<
    NonNullable<Helpdesk['config']['customFields']>['contact']
  >[number],
  value: string | number
) {
  switch (def.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'select':
      return typeof value === 'string' && (def.options ?? []).includes(value);
    default:
      return typeof value === 'string' && value.length <= 2000;
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map(part => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
