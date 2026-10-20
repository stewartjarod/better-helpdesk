import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import type { HostLink } from '../config';
import { useResource } from '../ui/api';
import { CodeBlock } from '../ui/code-block';
import { relativeTime, translated } from '../ui/i18n';
import { plainText, RichText } from '../ui/rich';
import { isMac, RichEditor, type RichEditorHandle } from '../ui/rich-editor';
import { useAdmin } from './context';
import { MergeDialog } from './merge';
import { ContactPicker } from './pickers';
import { formatSnooze, SnoozeControl } from './snooze';
import {
  Avatar,
  browserLabel,
  HostLinks,
  humanizeKey,
  LoadError,
  Property,
  paths,
  RatingChip,
  Select,
  Skeleton,
  Svg,
  useKeysOn,
  useQueueOn,
  useShortcuts,
  useToast,
  type Viewer,
  viewingLine,
} from './ui';

type Detail = {
  conversation: {
    id: string;
    reference: string;
    subject: string | null;
    title: string | null;
    customerSubject: string | null;
    type: string;
    status: string;
    priority: string;
    inbox: string;
    assigneeId: string | null;
    companyId: string | null;
    tags: string[];
    snoozedUntil: string | null;
    mergedIntoId: string | null;
    rating: 'good' | 'bad' | null;
    ratingComment: string | null;
    context: {
      url?: string;
      title?: string;
      userAgent?: string;
      viewport?: string;
      locale?: string;
      appVersion?: string;
      referrer?: string;
      landingPage?: string;
      utm?: Record<string, string>;
      host?: Record<string, string>;
      errors?: string[];
    };
    aiSuggestion: {
      type?: string;
      priority?: string;
      title?: string;
      summary?: string;
      duplicates?: {
        conversationId: string;
        reference: string;
        reason: string;
      }[];
      acceptedAt?: string;
    } | null;
  };
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    verified: boolean;
    locale: string | null;
    tags: string[];
  } | null;
  company: { id: string; name: string } | null;
  suggestedCompany: { id: string; name: string } | null;
  links: HostLink[];
  customerContext: Record<string, string>;
  participants: { id: string; name: string | null; email: string | null }[];
  viewers: Viewer[];
  messages: {
    id: string;
    authorType: 'contact' | 'agent' | 'system';
    body: string;
    internal: boolean;
    verified: boolean | null;
    createdAt: string;
    agentName: string | null;
    contactName: string | null;
  }[];
  attachments: { id: string; filename: string; size: number }[];
  events: TimelineEvent[];
};

type TimelineEvent = {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  agentId: string | null;
  agentName: string | null;
  createdAt: string;
};

export const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|proton|protonmail)\./i;

type Unsent = { internal: boolean; reply: string; note: string };

// Storage can be blocked (private windows, site data off) or full; the composer works without it.
function readUnsent(key: string): Unsent {
  try {
    const d = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return {
      internal: d.internal === true,
      reply: typeof d.reply === 'string' ? d.reply : '',
      note: typeof d.note === 'string' ? d.note : '',
    };
  } catch {
    return { internal: false, reply: '', note: '' };
  }
}

function writeUnsent(key: string, unsent: Unsent) {
  try {
    if (unsent.reply.trim() || unsent.note.trim())
      sessionStorage.setItem(key, JSON.stringify(unsent));
    else sessionStorage.removeItem(key);
  } catch {}
}

const ASIDE_KEY = 'helpdesk.aside';

function readAside(): boolean | null {
  try {
    const stored = localStorage.getItem(ASIDE_KEY);
    return stored === 'open' ? true : stored === 'closed' ? false : null;
  } catch {
    return null;
  }
}

function writeAside(open: boolean) {
  try {
    localStorage.setItem(ASIDE_KEY, open ? 'open' : 'closed');
  } catch {}
}

export function ConversationView({ id }: { id: string }) {
  const {
    api,
    apiBase,
    t,
    me,
    href,
    navigate,
    route,
    locale,
    inboxName,
    queue,
  } = useAdmin();
  const queueOn = useQueueOn();
  const order = queue;
  const position = order.findIndex(r => r.id === id);
  // The next conversation after this one in the inbox's order, wrapping round,
  // passing over any a teammate has open; the list when none is left.
  const advance = () => {
    const after = [
      ...order.slice(position + 1),
      ...order.slice(0, Math.max(position, 0)),
    ];
    const next = after.find(r => r.id !== id && !r.viewed);
    navigate({ ...route, conversation: next?.id ?? '' });
  };
  const detail = useResource(
    () => api<Detail>(`agent/conversations/${id}`),
    id,
    5000
  );
  const agents = useResource(
    () =>
      api<{
        agents: { id: string; name: string | null; email: string | null }[];
      }>('agent/agents'),
    'agents'
  );
  const canned = useResource(
    () =>
      api<{
        replies: {
          id: string;
          title: string;
          body: string;
          locale: string | null;
        }[];
      }>('agent/canned'),
    'canned'
  );
  const unsentKey = `helpdesk.draft.${me.agent.id}.${id}`;
  const [unsent, setUnsent] = useState(() => readUnsent(unsentKey));
  useEffect(() => writeUnsent(unsentKey, unsent), [unsentKey, unsent]);
  const internal = unsent.internal;
  const body = internal ? unsent.note : unsent.reply;
  const setBody = (update: (current: string) => string) =>
    setUnsent(d => {
      const mode = d.internal ? 'note' : 'reply';
      return { ...d, [mode]: update(d[mode]) };
    });
  const setInternal = (next: boolean) =>
    setUnsent(d => ({ ...d, internal: next }));
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentioned, setMentioned] = useState<{ id: string; label: string }[]>(
    []
  );
  const [busy, setBusy] = useState<'send' | 'draft' | 'rewrite' | null>(null);
  const [error, setError] = useState<'send' | 'resolve' | 'action' | null>(
    null
  );
  const composer = useRef<RichEditorHandle>(null);
  const toast = useToast();

  const patch = async (values: Record<string, unknown>) => {
    await api(`agent/conversations/${id}`, { method: 'PATCH', body: values });
    await detail.refresh();
  };

  const loaded = detail.data?.conversation;
  const acting = useRef(new Set<string>());
  const act = (values: Record<string, unknown>, done: () => string) => {
    const field = Object.keys(values).join();
    if (acting.current.has(field)) return;
    acting.current.add(field);
    void patch(values)
      .then(() => {
        setError(e => (e === 'action' ? null : e));
        toast.show(done());
      })
      .catch(() => setError('action'))
      .finally(() => acting.current.delete(field));
  };
  const keysOn = useKeysOn();
  const compose = (note: boolean) => {
    setInternal(note);
    composer.current?.focus();
  };
  useShortcuts(
    loaded
      ? {
          e: () =>
            loaded.status !== 'resolved' &&
            act({ status: 'resolved' }, () =>
              t('admin.resolvedToast', { reference: loaded.reference })
            ),
          a: () =>
            loaded.assigneeId !== me.agent.id &&
            act({ assigneeId: me.agent.id }, () => t('admin.assignedToYou')),
          r: () => compose(false),
          n: () => compose(true),
          s: queueOn ? advance : undefined,
        }
      : {}
  );
  const [aside, setAside] = useState(readAside);
  const [merging, setMerging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const asideToggle = useRef<HTMLButtonElement>(null);
  const asideId = useId();
  const shown = !!detail.data;
  useLayoutEffect(() => {
    if (shown && aside === null && root.current)
      setAside(root.current.clientWidth >= 900);
  }, [shown, aside]);
  const toggleAside = () => {
    const open = !aside;
    setAside(open);
    writeAside(open);
    if (!open) asideToggle.current?.focus();
  };

  const data = detail.data;
  if (detail.error) return <LoadError t={t} onRetry={detail.refresh} />;
  if (!data) return <Skeleton kind="thread" label={t('admin.loading')} />;
  const c = data.conversation;

  const send = async (resolve: boolean) => {
    if (!body.trim() || busy) return;
    setBusy('send');
    setError(null);
    try {
      const notify = internal
        ? mentioned.filter(m => body.includes(`@${m.label}`)).map(m => m.id)
        : [];
      await api(`agent/conversations/${id}/messages`, {
        body: { body, internal, ...(notify.length > 0 && { notify }) },
      });
    } catch {
      setError('send');
      setBusy(null);
      return;
    }
    // Sent: the text must not stay behind to be sent twice. Storage is cleared
    // directly, as the agent may have left and the state update would be lost.
    const mode = internal ? 'note' : 'reply';
    writeUnsent(unsentKey, { ...readUnsent(unsentKey), [mode]: '' });
    setUnsent(d => ({ ...d, [mode]: '' }));
    if (internal) setMentioned([]);
    try {
      if (resolve) await patch({ status: 'resolved' });
      else await detail.refresh();
      toast.show(t('thread.sent'));
      // A note leaves the customer waiting, so only a reply moves the queue on.
      if (queueOn && !internal) advance();
    } catch {
      setError('resolve');
      await detail.refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const contactLocale = data.contact?.locale?.slice(0, 2).toLowerCase();
  // Replies in the customer's language first, then language-neutral ones.
  const replies = [...(canned.data?.replies ?? [])].sort(
    (a, b) =>
      Number(b.locale === contactLocale) - Number(a.locale === contactLocale) ||
      Number(!b.locale) - Number(!a.locale)
  );
  const slash = /^\/(\S*)$/.exec(body);
  const slashMatches = slash
    ? replies
        .filter(r =>
          r.title.toLowerCase().includes((slash[1] ?? '').toLowerCase())
        )
        .slice(0, 6)
    : [];
  const at = internal ? /(?:^|\s)@([^\s@]*)$/.exec(body) : null;
  const query = at?.[1]?.toLowerCase() ?? '';
  // The editor trims the space after an inserted name; a finished mention stays closed.
  const finished = mentioned.some(m => m.label.toLowerCase() === query);
  const atMatches =
    at && !finished
      ? (agents.data?.agents ?? [])
          .filter(a => a.id !== me.agent.id)
          .map(a => ({ id: a.id, label: a.name ?? a.email ?? '' }))
          .filter(a => a.label.toLowerCase().includes(query))
          .slice(0, 6)
      : [];
  const mention = (agent: { id: string; label: string }) => {
    setBody(current => current.replace(/@[^\s@]*$/, `@${agent.label} `));
    setMentioned(list =>
      list.some(m => m.id === agent.id) ? list : [...list, agent]
    );
  };
  const picks = slashMatches.length > 0 ? slashMatches : atMatches;
  const insert = (text: string) => {
    setBody(current =>
      /^\/\S*$/.test(current) || !current ? text : `${current}\n\n${text}`
    );
    setSlashIndex(0);
    requestAnimationFrame(() => composer.current?.focus());
  };
  const firstName = data.contact?.name?.split(/\s+/)[0] ?? '';
  // Canned replies may say {firstName} and {reference}.
  const fill = (text: string) =>
    text
      .replaceAll('{firstName}', firstName)
      .replaceAll('{reference}', c.reference);

  const suggestion = c.aiSuggestion;
  // A title the team already set, by hand or by accepting, is not up for re-suggestion.
  const suggestionTitleChange = Boolean(
    suggestion?.title && !c.title && suggestion.title !== c.subject
  );
  const suggestionChanges =
    suggestion && !suggestion.acceptedAt
      ? [
          suggestion.type && suggestion.type !== c.type
            ? `${t(`agentType.${c.type}`)} → ${t(`agentType.${suggestion.type}`)}`
            : null,
          suggestion.priority && suggestion.priority !== c.priority
            ? `${t(`priority.${c.priority}`)} → ${t(`priority.${suggestion.priority}`)}`
            : null,
          suggestionTitleChange
            ? `${t('admin.title')}: ${suggestion.title}`
            : null,
        ].filter(Boolean)
      : [];
  const answered = data.messages.some(m => m.authorType === 'agent');
  // Triage is for the first look; once answered, only a type or priority change still matters.
  const showSuggestion =
    suggestion &&
    !suggestion.acceptedAt &&
    (answered
      ? suggestionChanges.length > (suggestionTitleChange ? 1 : 0)
      : suggestionChanges.length > 0 ||
        (suggestion.duplicates?.length ?? 0) > 0);
  const domain = data.contact?.email?.split('@')[1];
  const context = c.context;
  const agentLabel = (agentId: unknown) => {
    if (!agents.data && !agents.error) return '…';
    const agent = agents.data?.agents.find(a => a.id === agentId);
    return agent?.name ?? agent?.email ?? t('event.formerAgent');
  };
  const contactName = (contactId: unknown) => {
    const contact = [data.contact, ...data.participants].find(
      p => p?.id === contactId
    );
    return contact?.name ?? contact?.email;
  };
  const eventText = (e: TimelineEvent) => {
    const name = e.agentId
      ? (e.agentName ?? agentLabel(e.agentId))
      : t('event.system');
    const to = e.data.to;
    const from = e.data.from;
    switch (e.kind) {
      case 'status':
        if (e.agentId) {
          return t('event.status', { name, to: t(`agentStatus.${to}`) });
        }
        return e.data.by === 'customer'
          ? to === 'resolved'
            ? t('event.resolvedByCustomer')
            : t('event.reopenedByRating')
          : t('event.statusAuto', { to: t(`agentStatus.${to}`) });
      case 'priority':
        return t('event.priority', { name, to: t(`priority.${to}`) });
      case 'type':
        return t('event.type', { name, to: t(`agentType.${to}`) });
      case 'inbox':
        return t('event.inbox', { name, to: inboxName(String(to)) });
      case 'assigneeId':
        return to
          ? t('event.assigned', { name, to: agentLabel(to) })
          : t('event.unassigned', { name });
      case 'title':
        return to
          ? t('event.title', { name, to: String(to) })
          : t('event.titleCleared', { name });
      case 'tags': {
        const before = (from ?? []) as string[];
        const after = (to ?? []) as string[];
        const added = after.filter(tag => !before.includes(tag));
        const removed = before.filter(tag => !after.includes(tag));
        return [
          added.length > 0 &&
            t('event.tagsAdded', { name, tags: added.join(', ') }),
          removed.length > 0 &&
            t('event.tagsRemoved', { name, tags: removed.join(', ') }),
        ]
          .filter(Boolean)
          .join(' · ');
      }
      case 'snoozedUntil':
        return to
          ? t('event.snoozed', {
              name,
              date: formatSnooze(String(to), locale),
            })
          : e.agentId
            ? t('event.unsnoozed', { name })
            : // A customer's resolve ends the snooze; its status line says so.
              e.data.by === 'customer'
              ? null
              : t('event.woken');
      case 'reopened':
        return t('event.reopened');
      case 'merged.into':
        return t('event.mergedInto', {
          name,
          reference: String(e.data.reference),
        });
      case 'merged.from':
        return t('event.mergedFrom', {
          name,
          reference: String(e.data.reference),
        });
      case 'rating':
        return t(`event.rated.${to}`);
      case 'suggestion.accepted':
        return t('event.suggestionAccepted', { name });
      case 'suggestion.dismissed':
        return t('event.suggestionDismissed', { name });
      case 'participant.added': {
        const contact = contactName(e.data.contactId);
        if (e.agentId) {
          return t('event.participant', {
            name,
            contact: contact ?? t('event.unknownContact'),
          });
        }
        return contact
          ? t('event.participantAuto', { contact })
          : t('event.participantAutoUnknown');
      }
      case 'mentioned':
        return t('event.mentioned', {
          name,
          to: ((e.data.agentIds ?? []) as string[]).map(agentLabel).join(', '),
        });
      case 'email.sent':
        return t(`event.email.${e.data.kind}`, {
          to: ((to ?? []) as string[]).join(', '),
        });
      default:
        return null;
    }
  };
  // A stable sort keeps a message ahead of the events it caused.
  const timeline = [
    ...data.messages.map(m => ({ at: m.createdAt, message: m })),
    ...data.events.map(e => ({ at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const mergedInto = c.mergedIntoId && {
    id: c.mergedIntoId,
    reference: String(
      data.events.find(e => e.kind === 'merged.into')?.data.reference ?? ''
    ),
  };

  return (
    <div className="sa" ref={root}>
      <div className="sa-page-head sa-convo-head">
        <a
          className="sa-btn sa-back"
          href={href({ ...route, conversation: '' })}
          onClick={e => {
            e.preventDefault();
            navigate({ ...route, conversation: '' });
          }}>
          <Svg d={paths.back} />
          {t('admin.inbox')}
        </a>
        <div className="sa-convo-title">
          <h2>
            <span className="num sa-muted">{c.reference}</span>
            <TitleEditor
              value={c.subject ?? ''}
              fallback={t(`agentType.${c.type}`)}
              onSave={subject => patch({ subject })}
            />
          </h2>
          {data.viewers.length > 0 && (
            <p className="sa-fine sa-viewing">
              <span className="sa-viewers">
                {data.viewers.map(v => (
                  <Avatar key={v.id} name={v.name} agent />
                ))}
              </span>
              {viewingLine(t, data.viewers)}
            </p>
          )}
          {c.title && c.customerSubject && c.customerSubject !== c.title && (
            <p className="sa-fine">
              {t('admin.customerSees', { subject: c.customerSubject })}
            </p>
          )}
          <TagsEditor value={c.tags} onSave={tags => patch({ tags })} />
          {mergedInto && (
            <p className="sa-fine" role="status">
              <a
                href={href({ conversation: mergedInto.id })}
                onClick={e => {
                  e.preventDefault();
                  navigate({ conversation: mergedInto.id });
                }}>
                {t('admin.mergedInto', { reference: mergedInto.reference })}
              </a>
            </p>
          )}
        </div>
        <div className="sa-convo-actions">
          {queueOn && position >= 0 && (
            <span className="sa-queue">
              <span className="sa-muted">
                {t('admin.queuePosition', {
                  index: String(position + 1),
                  count: String(order.length),
                })}
              </span>
              <button
                type="button"
                className="sa-btn"
                aria-keyshortcuts={keysOn ? 'S' : undefined}
                onClick={advance}>
                {t('admin.skip')}
              </button>
            </span>
          )}
          {!c.mergedIntoId && (
            <button
              type="button"
              className="sa-btn"
              onClick={() => setMerging(true)}>
              {t('admin.mergeInto')}
            </button>
          )}
          <button
            ref={asideToggle}
            type="button"
            className="sa-btn sa-aside-toggle"
            aria-expanded={!!aside}
            aria-controls={asideId}
            onClick={toggleAside}>
            <Svg d={paths.panel} />
            {t(aside ? 'admin.hideDetails' : 'admin.showDetails')}
          </button>
        </div>
      </div>
      <div className="sa-split">
        <div className="sa">
          <fieldset
            className="sa-toolbar sa-fields sa-props"
            aria-label={t('admin.properties')}>
            <Property label={t('admin.assignee')}>
              <Select
                labelled
                label={t('admin.assignee')}
                value={c.assigneeId ?? ''}
                options={['', ...(agents.data?.agents.map(a => a.id) ?? [])]}
                render={id => {
                  const agent = agents.data?.agents.find(a => a.id === id);
                  return agent
                    ? (agent.name ?? agent.email ?? id)
                    : t('admin.unassigned');
                }}
                onChange={v => patch({ assigneeId: v || null })}
              />
            </Property>
            <Property label={t('admin.status')}>
              <Select
                labelled
                label={t('admin.status')}
                value={c.status}
                options={me.statuses}
                render={s => t(`agentStatus.${s}`)}
                onChange={v => patch({ status: v })}
              />
            </Property>
            {/* An action more than a property: its own text says what it is. */}
            <SnoozeControl
              until={c.snoozedUntil ?? null}
              onSave={async snoozedUntil => {
                await api(`agent/conversations/${id}`, {
                  method: 'PATCH',
                  body: { snoozedUntil },
                });
                await detail.refresh();
              }}
            />
            <Property label={t('admin.priority')}>
              <Select
                labelled
                label={t('admin.priority')}
                value={c.priority}
                options={me.priorities}
                render={p => t(`priority.${p}`)}
                onChange={v => patch({ priority: v })}
              />
            </Property>
            <Property label={t('admin.type')}>
              <Select
                labelled
                label={t('admin.type')}
                value={c.type}
                options={me.types}
                render={v => t(`agentType.${v}`)}
                onChange={v => patch({ type: v })}
              />
            </Property>
            <Property label={t('admin.inboxLabel')}>
              <Select
                labelled
                label={t('admin.inboxLabel')}
                value={c.inbox}
                options={me.inboxes}
                render={inboxName}
                onChange={v => patch({ inbox: v })}
              />
            </Property>
            {c.rating && (
              <RatingChip t={t} rating={c.rating} comment={c.ratingComment} />
            )}
          </fieldset>

          <div className="sa-thread">
            {timeline.map(item => {
              if ('event' in item) {
                const text = eventText(item.event);
                return (
                  text && (
                    <p key={item.event.id} className="sa-event">
                      <span>{text}</span> ·{' '}
                      <time
                        dateTime={item.at}
                        title={formatSnooze(item.at, locale)}>
                        {relativeTime(item.at, locale)}
                      </time>
                    </p>
                  )
                );
              }
              const m = item.message;
              const name =
                m.authorType === 'agent'
                  ? (m.agentName ?? t('thread.support'))
                  : m.authorType === 'system'
                    ? t('admin.automated')
                    : (m.contactName ?? data.contact?.email ?? '');
              return (
                <article
                  key={m.id}
                  className="sa-msg"
                  data-author={m.authorType}
                  data-internal={m.internal}>
                  <Avatar name={name} agent={m.authorType === 'agent'} />
                  <div>
                    <header>
                      <strong>{name}</strong>
                      {m.authorType === 'contact' &&
                        m.verified === false &&
                        ` · ${t('admin.unverified')}`}
                      {m.internal && ` · ${t('admin.note')}`} ·{' '}
                      {relativeTime(m.createdAt, locale)}
                    </header>
                    <div className="sa-msg-body">
                      <RichText
                        text={m.body}
                        hosts={m.authorType !== 'agent'}
                        code={text => <CodeBlock text={text} t={t} />}
                        reference={reference => (
                          <a
                            href={href({ q: reference, status: 'any' })}
                            onClick={e => {
                              e.preventDefault();
                              navigate({ q: reference, status: 'any' });
                            }}>
                            {reference}
                          </a>
                        )}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {showSuggestion && (
            <div className="sa-suggest">
              <Svg d={paths.sparkle} />
              <span className="sa-grow">
                <span>
                  <strong>{t('admin.suggested')}:</strong>{' '}
                  {suggestionChanges.join(' · ')}
                </span>
                {suggestion.summary && (
                  <span className="sa-fine sa-clamp">{suggestion.summary}</span>
                )}
                {suggestion.duplicates && suggestion.duplicates.length > 0 && (
                  <span className="sa-fine">
                    {' '}
                    {t('admin.duplicates')}:{' '}
                    {suggestion.duplicates.map(d => (
                      <a
                        key={d.conversationId}
                        href={href({ conversation: d.conversationId })}
                        title={d.reason}
                        onClick={e => {
                          e.preventDefault();
                          navigate({ conversation: d.conversationId });
                        }}>
                        {d.reference}{' '}
                      </a>
                    ))}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="sa-btn"
                onClick={async () => {
                  await api(`agent/conversations/${id}/suggestion`, {
                    body: { action: 'accept' },
                  });
                  await detail.refresh();
                }}>
                {t('admin.accept')}
              </button>
              <button
                type="button"
                className="sa-btn sa-ghost sa-quiet"
                aria-label={t('admin.dismiss')}
                onClick={async () => {
                  await api(`agent/conversations/${id}/suggestion`, {
                    body: { action: 'dismiss' },
                  });
                  await detail.refresh();
                }}>
                <Svg d={paths.x} />
              </button>
            </div>
          )}

          <form
            className="sa-composer"
            data-internal={internal}
            onSubmit={e => {
              e.preventDefault();
              void send(false);
            }}>
            <fieldset className="sa-seg">
              <button
                type="button"
                aria-pressed={!internal}
                aria-keyshortcuts={keysOn ? 'R' : undefined}
                onClick={() => setInternal(false)}>
                {t('admin.reply')}
              </button>
              <button
                type="button"
                aria-pressed={internal}
                aria-keyshortcuts={keysOn ? 'N' : undefined}
                onClick={() => setInternal(true)}>
                {t('admin.note')}
              </button>
            </fieldset>
            {/* Mounted while empty, so screen readers announce the warning when it appears. */}
            <p className="sa-viewing-warning" role="status">
              {data.viewers.length > 0 && t('admin.viewingWarning')}
            </p>
            <RichEditor
              ref={composer}
              className="rt-composer"
              t={t}
              label={internal ? t('admin.note') : t('admin.reply')}
              placeholder={
                internal ? t('admin.noteHint') : t('admin.slashHint')
              }
              value={body}
              onChange={next => {
                setBody(() => next);
                setSlashIndex(0);
              }}
              onKeyDown={e => {
                if (picks.length > 0) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const step = e.key === 'ArrowDown' ? 1 : -1;
                    setSlashIndex(
                      i => (i + step + picks.length) % picks.length
                    );
                    return;
                  }
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                    const canned = slashMatches[slashIndex];
                    const agent = atMatches[slashIndex];
                    if (canned) insert(fill(canned.body));
                    else if (agent) mention(agent);
                    if (canned || agent) {
                      e.preventDefault();
                      return;
                    }
                  }
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send(e.shiftKey);
                }
              }}
            />
            {slashMatches.length > 0 && (
              <div
                className="sa-slash"
                role="listbox"
                aria-label={t('admin.insertCanned')}>
                {slashMatches.map((r, index) => (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseDown={e => {
                      e.preventDefault();
                      insert(fill(r.body));
                    }}>
                    <strong>{r.title}</strong>
                    {r.locale && (
                      <span className="sa-pill">{r.locale.toUpperCase()}</span>
                    )}
                    <span className="sa-fine">{plainText(r.body)}</span>
                  </button>
                ))}
              </div>
            )}
            {slashMatches.length === 0 && atMatches.length > 0 && (
              <div
                className="sa-slash"
                role="listbox"
                aria-label={t('admin.mentionAgent')}>
                {atMatches.map((a, index) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseDown={e => {
                      e.preventDefault();
                      mention(a);
                    }}>
                    <strong>{a.label}</strong>
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p className="sa-error" role="alert">
                {t(
                  error === 'resolve' ? 'admin.sentNotResolved' : 'admin.error'
                )}
              </p>
            )}
            <div className="sa-composer-foot">
              <button
                type="submit"
                className="sa-btn sa-primary"
                title={isMac() ? '⌘ ↵' : 'Ctrl ↵'}
                disabled={busy !== null || !body.trim()}>
                {busy === 'send' ? t('admin.sending') : t('admin.send')}
              </button>
              {!internal && c.status !== 'resolved' && (
                <button
                  type="button"
                  className="sa-btn"
                  title={isMac() ? '⌘ ⇧ ↵' : 'Ctrl ⇧ ↵'}
                  aria-keyshortcuts={
                    isMac() ? 'Meta+Shift+Enter' : 'Control+Shift+Enter'
                  }
                  disabled={busy !== null || !body.trim()}
                  onClick={() => void send(true)}>
                  {t('admin.sendResolve')}
                </button>
              )}
              <span className="sa-kbd">
                <kbd>{isMac() ? '⌘' : 'Ctrl'} ↵</kbd> {t('admin.send')}
              </span>
              <span className="sa-grow" />
              {me.ai && (
                <button
                  type="button"
                  className="sa-btn sa-ghost"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy('draft');
                    try {
                      const draft = await api<{ text: string }>(
                        `agent/conversations/${id}/draft`,
                        { body: {} }
                      );
                      setInternal(false);
                      insert(draft.text);
                    } catch {
                      setError('send');
                    } finally {
                      setBusy(null);
                    }
                  }}>
                  <Svg d={paths.sparkle} />
                  {busy === 'draft' ? t('admin.drafting') : t('admin.draft')}
                </button>
              )}
              {me.ai &&
                body.trim() !== '' &&
                (['shorten', 'formal', 'translate'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    className="sa-btn sa-ghost"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy('rewrite');
                      try {
                        const sent = body;
                        const rewritten = await api<{ text: string }>(
                          `agent/conversations/${id}/draft`,
                          { body: { mode, text: sent } }
                        );
                        // Typing in the meantime wins over the rewrite.
                        setBody(current =>
                          current === sent ? rewritten.text : current
                        );
                      } catch {
                        setError('send');
                      } finally {
                        setBusy(null);
                      }
                    }}>
                    {t(`admin.rewrite.${mode}`)}
                  </button>
                ))}
              <CannedMenu
                replies={replies}
                onPick={text => insert(fill(text))}
              />
            </div>
          </form>
        </div>

        <aside className="sa" id={asideId} hidden={!aside}>
          <div className="sa-card">
            <h3>{t('admin.contact')}</h3>
            {data.contact && (
              <div className="sa-who">
                <Avatar name={data.contact.name ?? data.contact.email} />
                <div>
                  <a
                    href={href({ contact: data.contact.id })}
                    onClick={e => {
                      e.preventDefault();
                      navigate({ contact: data.contact?.id ?? '' });
                    }}>
                    <strong>{data.contact.name ?? data.contact.email}</strong>
                  </a>
                  <div className="sa-fine">
                    {data.contact.email} ·{' '}
                    {data.contact.verified
                      ? t('admin.verified')
                      : t('admin.unverified')}
                  </div>
                </div>
              </div>
            )}
            {(data.contact?.tags ?? [])
              .filter(tag => me.segments?.[tag])
              .map(tag => (
                <span
                  key={tag}
                  className="sa-pill"
                  style={{ justifySelf: 'start' }}
                  title={translated(me.segments[tag]?.label, locale)}>
                  {translated(me.segments[tag]?.badge, locale)}
                </span>
              ))}
            <HostLinks links={data.links} locale={locale} />
          </div>

          <div className="sa-card">
            <h3>{t('admin.company')}</h3>
            {data.company ? (
              <a
                href={href({ company: data.company.id })}
                onClick={e => {
                  e.preventDefault();
                  navigate({ company: data.company?.id ?? '' });
                }}>
                <strong>{data.company.name}</strong>
              </a>
            ) : (
              <>
                <span className="sa-muted">{t('admin.company.none')}</span>
                {data.suggestedCompany ? (
                  <button
                    type="button"
                    className="sa-btn"
                    onClick={async () => {
                      if (!data.contact || !data.suggestedCompany) return;
                      await api(`agent/contacts/${data.contact.id}`, {
                        method: 'PATCH',
                        body: { companyId: data.suggestedCompany.id },
                      });
                      await patch({ companyId: data.suggestedCompany.id });
                    }}>
                    {t('admin.assignCompany')}: {data.suggestedCompany.name}
                  </button>
                ) : domain && !FREE_MAIL.test(domain) && data.contact ? (
                  <button
                    type="button"
                    className="sa-btn"
                    onClick={async () => {
                      if (!data.contact) return;
                      const created = await api<{ company: { id: string } }>(
                        'agent/companies',
                        { body: { name: domain, domain } }
                      );
                      await api(`agent/contacts/${data.contact.id}`, {
                        method: 'PATCH',
                        body: { companyId: created.company.id },
                      });
                      await patch({ companyId: created.company.id });
                    }}>
                    <Svg d={paths.plus} />
                    {t('admin.createCompanyFrom', { domain })}
                  </button>
                ) : null}
              </>
            )}
            {Object.keys(data.customerContext).length > 0 && (
              <dl className="sa-kv">
                {Object.entries(data.customerContext).map(([k, v]) => (
                  <Pair key={k} label={humanizeKey(k)} value={v} />
                ))}
              </dl>
            )}
            {me.features.deals && c.type === 'lead' && data.contact && (
              <button
                type="button"
                className="sa-btn"
                onClick={async () => {
                  await api('agent/deals', {
                    body: {
                      title: c.subject ?? data.contact?.name ?? c.reference,
                      contactId: data.contact?.id,
                      companyId: data.company?.id ?? c.companyId ?? undefined,
                    },
                  });
                  toast.show(t('admin.saved'));
                }}>
                <Svg d={paths.plus} />
                {t('admin.createDeal')}
              </button>
            )}
          </div>

          {Object.keys(context).length > 0 && (
            <div className="sa-card">
              <h3>{t('admin.capturedContext')}</h3>
              <dl className="sa-kv">
                {context.url && (
                  <Pair
                    label={t('context.url')}
                    value={<Link url={context.url} />}
                  />
                )}
                {context.title && (
                  <Pair label={t('context.title')} value={context.title} />
                )}
                {context.userAgent && (
                  <Pair
                    label={t('context.userAgent')}
                    value={browserLabel(context.userAgent)}
                  />
                )}
                {context.viewport && (
                  <Pair
                    label={t('context.viewport')}
                    value={context.viewport}
                  />
                )}
                {context.locale && (
                  <Pair
                    label={t('context.locale')}
                    value={languageName(context.locale, locale)}
                  />
                )}
                {context.appVersion && (
                  <Pair
                    label={t('context.appVersion')}
                    value={context.appVersion}
                  />
                )}
                {context.landingPage && context.landingPage !== context.url && (
                  <Pair
                    label={humanizeKey('landingPage')}
                    value={<Link url={context.landingPage} />}
                  />
                )}
                {context.referrer && (
                  <Pair
                    label={humanizeKey('referrer')}
                    value={<Link url={context.referrer} />}
                  />
                )}
                {[
                  // jsonb reorders keys; keep the conventional UTM order.
                  ...Object.entries(context.utm ?? {}).sort(
                    ([a], [b]) => UTM_ORDER.indexOf(a) - UTM_ORDER.indexOf(b)
                  ),
                  // The segment already shows as a badge on the contact.
                  ...Object.entries(context.host ?? {}).filter(
                    ([k]) => k !== 'segment'
                  ),
                ].map(([k, v]) => (
                  <Pair key={k} label={humanizeKey(k)} value={v} />
                ))}
              </dl>
              {context.userAgent && (
                <details className="sa-details">
                  <summary>{t('admin.rawUserAgent')}</summary>
                  <pre>{context.userAgent}</pre>
                </details>
              )}
              {context.errors && context.errors.length > 0 && (
                <details className="sa-details">
                  <summary>
                    {context.errors.length === 1
                      ? t('admin.errorsOne')
                      : t('admin.errorsCount', {
                          count: String(context.errors.length),
                        })}
                  </summary>
                  <CodeBlock text={context.errors.join('\n')} t={t} />
                </details>
              )}
            </div>
          )}

          {data.attachments.length > 0 && (
            <div className="sa-card">
              <h3>{t('admin.attachments')}</h3>
              {data.attachments.map(a => (
                <a
                  key={a.id}
                  href={`${apiBase}/agent/conversations/${id}/attachments/${a.id}/`}
                  target="_blank"
                  rel="noreferrer">
                  {a.filename}
                </a>
              ))}
            </div>
          )}

          <div className="sa-card">
            <h3>{t('admin.participants')}</h3>
            {data.participants.map(p => (
              <span key={p.id} className="sa-who">
                <Avatar name={p.name ?? p.email} />
                {p.name ?? p.email}
              </span>
            ))}
            <ContactPicker
              label={t('admin.addParticipant')}
              onPick={async contact => {
                await api(`agent/conversations/${id}/participants`, {
                  body: { contactId: contact.id },
                });
                await detail.refresh();
              }}
            />
          </div>
        </aside>
      </div>
      <MergeDialog
        open={merging}
        onClose={() => setMerging(false)}
        onMerged={detail.refresh}
        conversationId={id}
        contactId={data.contact?.id}
        duplicates={c.aiSuggestion?.duplicates ?? []}
      />
      {toast.node}
    </div>
  );
}

/** The team's name for a conversation; the customer keeps seeing their own. */
function TitleEditor({
  value,
  fallback,
  onSave,
}: {
  value: string;
  fallback: string;
  onSave: (title: string) => Promise<void>;
}) {
  const { t } = useAdmin();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button
        type="button"
        className="sa-title-edit"
        title={value || fallback}
        aria-description={t('admin.rename')}
        onClick={() => setDraft(value)}>
        {value || fallback}
      </button>
    );
  }
  const commit = async () => {
    const next = draft.trim();
    setDraft(null);
    if (next && next !== value) await onSave(next);
  };
  return (
    <input
      className="sa-input sa-title-input"
      aria-label={t('admin.rename')}
      // biome-ignore lint/a11y/noAutofocus: opened by the click that asked to rename.
      autoFocus
      maxLength={200}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={e => {
        // Saving happens once, on blur.
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}

function TagsEditor({
  value,
  onSave,
}: {
  value: string[];
  onSave: (tags: string[]) => Promise<void>;
}) {
  const { api, t } = useAdmin();
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);
  const top = useResource(() => api<{ tags: string[] }>('agent/tags'), 'tags');
  const save = async (next: string[]) => {
    setFailed(false);
    try {
      await onSave(next);
    } catch {
      setFailed(true);
      return;
    }
    await top.refresh();
  };
  const add = async () => {
    const names = draft
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    setDraft('');
    const next = [...new Set([...value, ...names])];
    if (next.length > value.length) await save(next);
  };
  return (
    <fieldset className="sa-tags-edit" aria-label={t('admin.tags')}>
      {value.map(tag => (
        <span key={tag} className="sa-pill sa-tag sa-tag-chip">
          {tag}
          <button
            type="button"
            aria-label={t('admin.removeTag', { tag })}
            onClick={() => void save(value.filter(v => v !== tag))}>
            <Svg d={paths.x} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="sa-tag-new"
          aria-label={t('admin.addTag')}
          placeholder={t('admin.tag')}
          // biome-ignore lint/a11y/noAutofocus: opened by the click that asked to add a tag.
          autoFocus
          list={listId}
          maxLength={50}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            setAdding(false);
            void add();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft('');
              setAdding(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="sa-tag-add"
          onClick={() => setAdding(true)}>
          <Svg d={paths.plus} />
          {t('admin.addTag')}
        </button>
      )}
      <datalist id={listId}>
        {(top.data?.tags ?? [])
          .filter(tag => !value.includes(tag))
          .map(tag => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
      {failed && (
        <span className="sa-error" role="alert">
          {t('admin.error')}
        </span>
      )}
    </fieldset>
  );
}

type CannedReply = {
  id: string;
  title: string;
  body: string;
  locale: string | null;
};

function CannedMenu({
  replies,
  onPick,
}: {
  replies: CannedReply[];
  onPick: (body: string) => void;
}) {
  const { t, href, navigate } = useAdmin();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const matches = replies.filter(r =>
    `${r.title} ${r.body}`.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const close = () => {
    setOpen(false);
    setQuery('');
    setIndex(0);
  };
  const pick = (reply: CannedReply) => {
    onPick(reply.body);
    close();
  };

  return (
    <div className="sa-canned" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="sa-btn sa-ghost"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('admin.slashHint')}
        onClick={() => (open ? close() : setOpen(true))}>
        <Svg d={paths.text} />
        {t('admin.cannedReplies')}
      </button>
      {open && (
        <div className="sa-canned-pop">
          {replies.length > 0 && (
            <input
              className="sa-input"
              // biome-ignore lint/a11y/noAutofocus: the menu opens for typing.
              autoFocus
              aria-label={t('admin.search')}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                matches[index] ? `${listId}-${index}` : undefined
              }
              placeholder={t('admin.searchCanned')}
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                  trigger.current?.focus();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setIndex(
                    i =>
                      (i + step + matches.length) % Math.max(matches.length, 1)
                  );
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const picked = matches[index];
                  if (picked) pick(picked);
                }
              }}
            />
          )}
          <div
            id={listId}
            className="sa-slash"
            role="listbox"
            aria-label={t('admin.cannedReplies')}>
            {matches.map((r, i) => (
              <button
                key={r.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(r)}>
                <strong>{r.title}</strong>
                {r.locale && (
                  <span className="sa-pill">{r.locale.toUpperCase()}</span>
                )}
                <span className="sa-fine">{r.body}</span>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="sa-fine sa-canned-empty">
                {replies.length === 0
                  ? t('admin.noCanned')
                  : t('admin.noCannedMatch')}
              </p>
            )}
          </div>
          <a
            className="sa-canned-foot"
            href={href({ view: 'canned' })}
            onClick={e => {
              e.preventDefault();
              navigate({ view: 'canned' });
            }}>
            {t('admin.manageCanned')}
          </a>
        </div>
      )}
    </div>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function languageName(code: string, locale: string) {
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

const UTM_ORDER = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];

/** Customer-supplied URLs link only when they are http(s). */
function Link({ url }: { url: string }) {
  // The query is mostly UTM parameters, which the panel lists on their own rows.
  return /^https?:\/\//i.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
      {url.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '')}
    </a>
  ) : (
    url
  );
}
