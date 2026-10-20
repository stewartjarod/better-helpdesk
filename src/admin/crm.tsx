import { useState } from 'react';

import type { CustomFieldDef, HostLink } from '../config';
import { useResource } from '../ui/api';
import { relativeTime, translated } from '../ui/i18n';
import { useAdmin } from './context';
import { FREE_MAIL } from './conversation';
import { DealDialog } from './deals';
import { type ConversationRow, ConversationTable } from './inbox';
import { CompanyPicker, ContactPicker } from './pickers';
import {
  Avatar,
  CustomFields,
  Dialog,
  Empty,
  HostLinks,
  LoadError,
  money,
  paths,
  Skeleton,
  Svg,
  useConfirm,
} from './ui';

type Contact = {
  id: string;
  conversationCount?: number;
  lastMessageAt?: string | null;
  source?: string | null;
  isTeam?: boolean;
  name: string | null;
  email: string | null;
  companyId: string | null;
  leadStage: string | null;
  tags: string[];
  custom: Record<string, string | number | null>;
  blocked?: boolean;
  createdAt: string;
  lastSeenAt?: string | null;
};

type Company = {
  id: string;
  name: string;
  domain: string | null;
  externalOrgId: string | null;
  leadStage: string | null;
  tags: string[];
  custom: Record<string, string | number | null>;
};

type TimelineEntry = {
  kind: string;
  at: string;
  id: string;
  title: string;
  agentName?: string | null;
};

type Deal = {
  id: string;
  title: string;
  stage: string;
  value: string | null;
  currency: string;
};

function Toolbar({
  view,
  newLabel,
  onNew,
  extra,
}: {
  view: 'contacts' | 'companies';
  newLabel: string;
  onNew: () => void;
  extra?: React.ReactNode;
}) {
  const { t, route, navigate } = useAdmin();
  const [query, setQuery] = useState(route.q ?? '');
  return (
    <div className="sa-toolbar">
      <form
        className="sa-grow"
        onSubmit={e => {
          e.preventDefault();
          navigate({ ...route, view, q: query });
        }}>
        <input
          type="search"
          className="sa-input"
          aria-label={t('admin.search')}
          placeholder={t('admin.search')}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </form>
      {extra}
      <button type="button" className="sa-btn sa-primary" onClick={onNew}>
        <Svg d={paths.plus} />
        {newLabel}
      </button>
    </div>
  );
}

function CreateDialog({
  open,
  title,
  fields,
  onClose,
  onCreate,
}: {
  open: boolean;
  title: string;
  fields: { name: string; label: string; type?: string; required?: boolean }[];
  onClose: () => void;
  onCreate: (values: Record<string, string>) => Promise<void>;
}) {
  const { t } = useAdmin();
  const [error, setError] = useState(false);
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form
        onSubmit={async e => {
          e.preventDefault();
          const values = Object.fromEntries(
            [...new FormData(e.currentTarget)].map(([k, v]) => [
              k,
              String(v).trim(),
            ])
          );
          try {
            await onCreate(values);
            setError(false);
          } catch {
            setError(true);
          }
        }}>
        <h2>{title}</h2>
        {fields.map((field, index) => (
          <label key={field.name} className="sa-field">
            {field.label}
            <input
              className="sa-input"
              name={field.name}
              type={field.type ?? 'text'}
              required={field.required}
              autoFocus={index === 0}
            />
          </label>
        ))}
        {error && <p className="sa-error">{t('admin.error')}</p>}
        <div className="sa-dialog-foot">
          <button type="button" className="sa-btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button type="submit" className="sa-btn sa-primary">
            {t('admin.create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ContactList() {
  const { api, t, me, navigate, route, locale } = useAdmin();
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams(
    Object.entries({
      q: route.q ?? '',
      leadStage: route.leadStage ?? '',
    }).filter(([, v]) => v)
  ).toString();
  const list = useResource(
    () => api<{ contacts: Contact[] }>(`agent/contacts?${params}`),
    params
  );

  return (
    <div className="sa">
      <Toolbar
        view="contacts"
        newLabel={t('admin.newContact')}
        onNew={() => setCreating(true)}
        extra={
          <select
            className="sa-select"
            aria-label={t('admin.leadStage')}
            value={route.leadStage ?? ''}
            onChange={e =>
              navigate({
                ...route,
                view: 'contacts',
                leadStage: e.target.value,
              })
            }>
            <option value="">
              {t('admin.leadStage')}: {t('admin.all')}
            </option>
            {me.leadStages.map(s => (
              <option key={s} value={s}>
                {t(`stage.${s}`)}
              </option>
            ))}
          </select>
        }
      />
      {list.error && <LoadError t={t} onRetry={list.refresh} />}
      {!list.data && !list.error && (
        <Skeleton kind="table" columns={6} label={t('admin.loading')} />
      )}
      {list.data && (
        <div className="sa-table-wrap">
          {list.data.contacts.length === 0 ? (
            <Empty
              text={t(
                route.q || route.leadStage
                  ? 'admin.emptyFiltered'
                  : 'admin.emptyContacts'
              )}
            />
          ) : (
            <table className="sa-table">
              <thead>
                <tr>
                  <th>{t('admin.name')}</th>
                  <th>{t('admin.email')}</th>
                  <th>{t('admin.leadStage')}</th>
                  <th>{t('admin.source')}</th>
                  <th>{t('admin.conversationCount')}</th>
                  <th>{t('admin.lastWrote')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.contacts.map(c => (
                  <tr key={c.id} onClick={() => navigate({ contact: c.id })}>
                    <td>
                      <span className="sa-who">
                        <Avatar name={c.name ?? c.email} />
                        <span>
                          {c.name ?? '—'}
                          {c.isTeam && (
                            <span className="sa-pill sa-team">
                              {t('admin.team')}
                            </span>
                          )}
                          {c.tags.length > 0 && (
                            <div className="sa-fine">
                              {c.tags
                                .map(
                                  tag =>
                                    translated(
                                      me.segments?.[tag]?.badge,
                                      locale
                                    ) ?? tag
                                )
                                .join(', ')}
                            </div>
                          )}
                        </span>
                      </span>
                    </td>
                    <td>{c.email}</td>
                    <td>
                      {c.leadStage && (
                        <span className="sa-pill">
                          {t(`stage.${c.leadStage}`)}
                        </span>
                      )}
                    </td>
                    <td className="sa-muted">
                      {c.source ?? t('admin.direct')}
                    </td>
                    <td className="num">{c.conversationCount ?? 0}</td>
                    <td className="sa-muted">
                      {c.lastMessageAt
                        ? relativeTime(c.lastMessageAt, locale)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <CreateDialog
        open={creating}
        title={t('admin.newContact')}
        fields={[
          { name: 'name', label: t('admin.name'), required: true },
          { name: 'email', label: t('admin.email'), type: 'email' },
        ]}
        onClose={() => setCreating(false)}
        onCreate={async values => {
          const created = await api<{ contact: Contact }>('agent/contacts', {
            body: { name: values.name, email: values.email || undefined },
          });
          setCreating(false);
          navigate({ contact: created.contact.id });
        }}
      />
    </div>
  );
}

export function ContactView({ id }: { id: string }) {
  const { api, t, me, navigate, href, locale } = useAdmin();
  const confirm = useConfirm(t);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [newDeal, setNewDeal] = useState(false);
  const detail = useResource(
    () =>
      api<{
        contact: Contact;
        identities: {
          channel: string;
          verified: boolean;
          externalId: string | null;
        }[];
        company: Company | null;
        links: HostLink[];
        conversations: ConversationRow[];
        timeline: TimelineEntry[];
        deals: Deal[];
      }>(`agent/contacts/${id}`),
    id
  );
  const data = detail.data;
  if (detail.error) return <LoadError t={t} onRetry={detail.refresh} />;
  if (!data)
    return <Skeleton kind="cards" summary label={t('admin.loading')} />;
  const c = data.contact;
  const segments = c.tags.filter(tag => me.segments?.[tag]);
  const otherTags = c.tags.filter(tag => !me.segments?.[tag]);
  const domain = c.email?.split('@')[1];

  return (
    <div className="sa">
      <div className="sa-page-head">
        {me.features.crm && (
          <a
            className="sa-btn sa-back"
            href={href({ view: 'contacts' })}
            onClick={e => {
              e.preventDefault();
              navigate({ view: 'contacts' });
            }}>
            <Svg d={paths.back} />
            {t('admin.contacts')}
          </a>
        )}
      </div>
      <div className="sa-card sa-summary">
        <Avatar name={c.name ?? c.email} />
        <div className="sa-grow">
          <h2>{c.name ?? c.email}</h2>
          <div className="sa-muted">
            {c.email}
            {data.company && (
              <>
                {' · '}
                <a
                  href={href({ company: data.company.id })}
                  onClick={e => {
                    e.preventDefault();
                    navigate({ company: data.company?.id ?? '' });
                  }}>
                  {data.company.name}
                </a>
              </>
            )}
          </div>
          <div className="sa-toolbar" style={{ marginTop: 6 }}>
            {me.features.crm && c.leadStage && (
              <span className="sa-pill">{t(`stage.${c.leadStage}`)}</span>
            )}
            {segments.map(tag => (
              <span
                key={tag}
                className="sa-pill"
                title={translated(me.segments[tag]?.label, locale)}>
                {translated(me.segments[tag]?.badge, locale)}
              </span>
            ))}
            {otherTags.map(tag => (
              <span key={tag} className="sa-pill">
                {tag}
              </span>
            ))}
            {c.blocked && (
              <span className="sa-pill sa-pill-danger">
                {t('admin.blocked')}
              </span>
            )}
            {c.source && (
              <span className="sa-fine">
                {t('admin.sourceLine', { source: c.source })}
              </span>
            )}
            {c.lastSeenAt && (
              <span className="sa-fine">
                {t('admin.lastSeen', {
                  when: relativeTime(c.lastSeenAt, locale),
                })}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="sa-btn"
          onClick={() => setEditing(true)}>
          {t('admin.edit')}
        </button>
        <details className="sa-menu">
          <summary className="sa-btn sa-ghost" aria-label={t('widget.more')}>
            ⋯
          </summary>
          <div className="sa-menu-pop">
            <button
              type="button"
              className="sa-btn sa-ghost"
              onClick={() => setMerging(true)}>
              {t('admin.merge')}
            </button>
            <button
              type="button"
              className="sa-btn sa-ghost"
              title={c.blocked ? undefined : t('admin.blockHint')}
              onClick={async () => {
                await api(`agent/contacts/${id}`, {
                  method: 'PATCH',
                  body: { blocked: !c.blocked },
                });
                await detail.refresh();
              }}>
              {t(c.blocked ? 'admin.unblock' : 'admin.block')}
            </button>
            <button
              type="button"
              className="sa-btn sa-ghost sa-danger"
              onClick={async () => {
                if (!(await confirm.ask())) return;
                await api(`agent/contacts/${id}`, { method: 'DELETE' });
                navigate({ view: 'contacts' });
              }}>
              {t('admin.delete')}
            </button>
          </div>
        </details>
      </div>
      <div className="sa-split">
        <div className="sa">
          <Timeline
            entries={data.timeline.filter(e => e.kind !== 'conversation')}
            target={{ contactId: id }}
            onLogged={detail.refresh}
          />
          {data.conversations.length > 0 && (
            <section className="sa-card">
              <h3>{t('admin.conversations')}</h3>
              <ConversationTable
                rows={data.conversations}
                onOpen={cid => navigate({ conversation: cid })}
                hideContact
              />
            </section>
          )}
        </div>
        <aside className="sa">
          <HostLinks links={data.links} locale={locale} />
          <div className="sa-card">
            <h3>{t('admin.company')}</h3>
            {data.company ? (
              <a
                className="sa-who"
                href={href({ company: data.company.id })}
                onClick={e => {
                  e.preventDefault();
                  navigate({ company: data.company?.id ?? '' });
                }}>
                <Avatar name={data.company.name} />
                <strong>{data.company.name}</strong>
              </a>
            ) : (
              <span className="sa-muted">{t('admin.company.none')}</span>
            )}
            {!data.company && domain && !FREE_MAIL.test(domain) && (
              <button
                type="button"
                className="sa-btn"
                onClick={async () => {
                  const created = await api<{ company: { id: string } }>(
                    'agent/companies',
                    { body: { name: domain, domain } }
                  );
                  await api(`agent/contacts/${id}`, {
                    method: 'PATCH',
                    body: { companyId: created.company.id },
                  });
                  await detail.refresh();
                }}>
                <Svg d={paths.plus} />
                {t('admin.createCompanyFrom', { domain })}
              </button>
            )}
            {!data.company && (
              <span className="sa-fine">{t('admin.orLinkExisting')}</span>
            )}
            <CompanyPicker
              label={
                data.company ? t('admin.changeCompany') : t('admin.linkCompany')
              }
              onPick={async company => {
                await api(`agent/contacts/${id}`, {
                  method: 'PATCH',
                  body: { companyId: company.id },
                });
                await detail.refresh();
              }}
            />
          </div>
          {me.features.deals && (
            <div className="sa-card">
              <h3>{t('admin.deals')}</h3>
              {data.deals.map(d => (
                <a
                  key={d.id}
                  href={href({ view: 'deals' })}
                  onClick={e => {
                    e.preventDefault();
                    navigate({ view: 'deals' });
                  }}>
                  {d.title} · {t(`stage.${d.stage}`)}{' '}
                  <span className="num sa-muted">
                    {money(d.value, d.currency, locale)}
                  </span>
                </a>
              ))}
              <button
                type="button"
                className="sa-btn"
                style={{ justifySelf: 'start' }}
                onClick={() => setNewDeal(true)}>
                <Svg d={paths.plus} />
                {t('admin.newDeal')}
              </button>
            </div>
          )}
          <div className="sa-card">
            <h3>{t('admin.identities')}</h3>
            {data.identities.map(i => (
              <div key={`${i.channel}:${i.externalId}`} className="sa-identity">
                <span>
                  {t(`identity.${i.channel}`)}
                  {i.externalId && i.channel !== 'host' ? (
                    <span className="sa-muted"> {i.externalId}</span>
                  ) : null}
                </span>
                <span
                  className="sa-pill"
                  data-tone={i.verified ? undefined : 'muted'}>
                  {i.verified ? t('admin.verified') : t('admin.unverified')}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
      <Dialog
        open={editing}
        title={t('admin.edit')}
        onClose={() => setEditing(false)}>
        <EntityForm
          entity="contact"
          path={`agent/contacts/${id}`}
          initial={{
            name: c.name ?? '',
            leadStage: c.leadStage,
            tags: c.tags,
            custom: c.custom,
          }}
          fields={me.customFields.contact ?? []}
          onSaved={() => {
            setEditing(false);
            void detail.refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      </Dialog>
      <Dialog
        open={merging}
        title={t('admin.merge')}
        onClose={() => setMerging(false)}>
        <div className="sa-dialog-body">
          <h2>{t('admin.merge')}</h2>
          <ContactPicker
            label={t('admin.search')}
            onPick={async source => {
              if (source.id === id) return;
              if (
                !(await confirm.ask(
                  t('admin.confirmMerge', {
                    name: source.name ?? source.email ?? '',
                  }),
                  t('admin.mergeAction')
                ))
              )
                return;
              await api(`agent/contacts/${id}/merge`, {
                body: { sourceId: source.id },
              });
              setMerging(false);
              await detail.refresh();
            }}
          />
          <div className="sa-dialog-foot">
            <button
              type="button"
              className="sa-btn"
              onClick={() => setMerging(false)}>
              {t('admin.cancel')}
            </button>
          </div>
        </div>
      </Dialog>
      {me.features.deals && (
        <DealDialog
          deal={newDeal ? 'new' : null}
          defaults={{ contactId: id, companyId: c.companyId }}
          onClose={() => setNewDeal(false)}
          onSaved={async () => {
            setNewDeal(false);
            await detail.refresh();
          }}
        />
      )}
      {confirm.node}
    </div>
  );
}

export function CompanyList() {
  const { api, t, navigate, route } = useAdmin();
  const [creating, setCreating] = useState(false);
  const q = route.q ?? '';
  const list = useResource(
    () =>
      api<{ companies: Company[] }>(
        `agent/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`
      ),
    q
  );

  return (
    <div className="sa">
      <Toolbar
        view="companies"
        newLabel={t('admin.newCompany')}
        onNew={() => setCreating(true)}
      />
      {list.error && <LoadError t={t} onRetry={list.refresh} />}
      {!list.data && !list.error && (
        <Skeleton kind="table" columns={4} label={t('admin.loading')} />
      )}
      {list.data && (
        <div className="sa-table-wrap">
          {list.data.companies.length === 0 ? (
            <Empty
              text={t(q ? 'admin.emptyFiltered' : 'admin.emptyCompanies')}
            />
          ) : (
            <table className="sa-table">
              <thead>
                <tr>
                  <th>{t('admin.name')}</th>
                  <th>{t('admin.domain')}</th>
                  <th>{t('admin.leadStage')}</th>
                  <th>{t('admin.tags')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.companies.map(c => (
                  <tr key={c.id} onClick={() => navigate({ company: c.id })}>
                    <td>
                      <span className="sa-who">
                        <Avatar name={c.name} />
                        {c.name}
                      </span>
                    </td>
                    <td className="sa-muted">{c.domain}</td>
                    <td>
                      {c.leadStage && (
                        <span className="sa-pill">
                          {t(`stage.${c.leadStage}`)}
                        </span>
                      )}
                    </td>
                    <td className="sa-muted">{c.tags.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <CreateDialog
        open={creating}
        title={t('admin.newCompany')}
        fields={[
          { name: 'name', label: t('admin.name'), required: true },
          { name: 'domain', label: t('admin.domain') },
        ]}
        onClose={() => setCreating(false)}
        onCreate={async values => {
          const created = await api<{ company: Company }>('agent/companies', {
            body: { name: values.name, domain: values.domain || null },
          });
          setCreating(false);
          navigate({ company: created.company.id });
        }}
      />
    </div>
  );
}

export function CompanyView({ id }: { id: string }) {
  const { api, t, me, navigate, href, locale } = useAdmin();
  const detail = useResource(
    () =>
      api<{
        company: Company;
        context: Record<string, string>;
        links: HostLink[];
        contacts: Contact[];
        conversations: ConversationRow[];
        timeline: TimelineEntry[];
        deals: Deal[];
      }>(`agent/companies/${id}`),
    id
  );
  const data = detail.data;
  if (detail.error) return <LoadError t={t} onRetry={detail.refresh} />;
  if (!data) return <Skeleton kind="cards" label={t('admin.loading')} />;
  const c = data.company;

  return (
    <div className="sa">
      <div className="sa-page-head">
        <a
          className="sa-btn sa-back"
          href={href({ view: 'companies' })}
          onClick={e => {
            e.preventDefault();
            navigate({ view: 'companies' });
          }}>
          <Svg d={paths.back} />
          {t('admin.companies')}
        </a>
        <Avatar name={c.name} />
        <h2>{c.name}</h2>
        {me.features.crm && c.leadStage && (
          <span className="sa-pill">{t(`stage.${c.leadStage}`)}</span>
        )}
      </div>
      <div className="sa-split">
        <div className="sa">
          <EntityForm
            key={c.id}
            entity="company"
            path={`agent/companies/${id}`}
            initial={{
              name: c.name,
              domain: c.domain ?? '',
              leadStage: c.leadStage,
              tags: c.tags,
              custom: c.custom,
            }}
            fields={me.customFields.company ?? []}
            onSaved={detail.refresh}
          />
          <Timeline
            entries={data.timeline.filter(e => e.kind !== 'conversation')}
            target={{ companyId: id }}
            onLogged={detail.refresh}
          />
          {data.conversations.length > 0 && (
            <section className="sa-card">
              <h3>{t('admin.conversations')}</h3>
              <ConversationTable
                rows={data.conversations}
                onOpen={cid => navigate({ conversation: cid })}
              />
            </section>
          )}
        </div>
        <aside className="sa">
          <HostLinks links={data.links} locale={locale} />
          {Object.keys(data.context).length > 0 && (
            <div className="sa-card">
              <h3>{t('admin.customerContext')}</h3>
              <dl className="sa-kv">
                {Object.entries(data.context).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="sa-card">
            <h3>{t('admin.contacts')}</h3>
            {data.contacts.map(contact => (
              <a
                key={contact.id}
                className="sa-who"
                href={href({ contact: contact.id })}
                onClick={e => {
                  e.preventDefault();
                  navigate({ contact: contact.id });
                }}>
                <Avatar name={contact.name ?? contact.email} />
                {contact.name ?? contact.email}
              </a>
            ))}
          </div>
          {me.features.deals && (
            <DealsCard
              deals={data.deals}
              create={{ companyId: id }}
              onChanged={detail.refresh}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function EntityForm({
  entity,
  path,
  initial,
  fields,
  onSaved,
  onCancel,
}: {
  entity: 'contact' | 'company';
  path: string;
  initial: {
    name: string;
    domain?: string;
    leadStage: string | null;
    tags: string[];
    custom: Record<string, string | number | null>;
  };
  fields: CustomFieldDef[];
  onSaved: () => void;
  /** Present when the form sits in a dialog. */
  onCancel?: () => void;
}) {
  const { api, t, me, locale } = useAdmin();
  const [name, setName] = useState(initial.name);
  const [domain, setDomain] = useState(initial.domain ?? '');
  const [leadStage, setLeadStage] = useState(initial.leadStage ?? '');
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [custom, setCustom] = useState(initial.custom);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  return (
    <form
      className="sa-card"
      onSubmit={async e => {
        e.preventDefault();
        try {
          await api(path, {
            method: 'PATCH',
            body: {
              name: name || (entity === 'contact' ? null : undefined),
              ...(entity === 'company' ? { domain: domain || null } : {}),
              ...(me.features.crm ? { leadStage: leadStage || null } : {}),
              tags: tags
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
              custom,
            },
          });
          setStatus('saved');
          onSaved();
        } catch {
          setStatus('error');
        }
      }}>
      <div className="sa-grid">
        <label className="sa-field">
          {t('admin.name')}
          <input
            className="sa-input"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>
        {entity === 'company' && (
          <label className="sa-field">
            {t('admin.domain')}
            <input
              className="sa-input"
              value={domain}
              onChange={e => setDomain(e.target.value)}
            />
          </label>
        )}
        {me.features.crm && (
          <label className="sa-field">
            {t('admin.leadStage')}
            <select
              className="sa-select"
              style={{ width: '100%' }}
              value={leadStage}
              onChange={e => setLeadStage(e.target.value)}>
              <option value="">{t('admin.none')}</option>
              {[
                ...me.leadStages,
                ...(initial.leadStage &&
                !me.leadStages.includes(initial.leadStage)
                  ? [initial.leadStage]
                  : []),
              ].map(s => (
                <option key={s} value={s}>
                  {t(`stage.${s}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="sa-field">
          {t('admin.tags')}
          <input
            className="sa-input"
            placeholder={t('admin.tagsHint')}
            value={tags}
            onChange={e => setTags(e.target.value)}
          />
        </label>
        <CustomFields
          fields={fields}
          values={custom}
          locale={locale}
          onChange={(key, value) => setCustom(v => ({ ...v, [key]: value }))}
        />
      </div>
      <div className="sa-toolbar">
        {onCancel && (
          <button type="button" className="sa-btn" onClick={onCancel}>
            {t('admin.cancel')}
          </button>
        )}
        <button type="submit" className="sa-btn sa-primary">
          {t('admin.save')}
        </button>
        {status === 'saved' && (
          <span className="sa-muted">{t('admin.saved')}</span>
        )}
        {status === 'error' && (
          <span className="sa-error">{t('admin.error')}</span>
        )}
      </div>
    </form>
  );
}

function Timeline({
  entries,
  target,
  onLogged,
}: {
  entries: TimelineEntry[];
  target: { contactId?: string; companyId?: string };
  onLogged: () => void;
}) {
  const { api, t, locale } = useAdmin();
  const [kind, setKind] = useState<'note' | 'call' | 'meeting'>('note');
  const [body, setBody] = useState('');

  return (
    <div className="sa-card">
      <h3>{t('admin.timeline')}</h3>
      <form
        className="sa"
        style={{ gap: 8 }}
        onSubmit={async e => {
          e.preventDefault();
          if (!body.trim()) return;
          await api('agent/activities', { body: { kind, body, ...target } });
          setBody('');
          onLogged();
        }}>
        <fieldset className="sa-seg" style={{ justifySelf: 'start' }}>
          {(['note', 'call', 'meeting'] as const).map(k => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}>
              {t(`activity.${k}`)}
            </button>
          ))}
        </fieldset>
        <textarea
          className="sa-textarea sa-note-input"
          aria-label={t(`activity.${kind}`)}
          placeholder={t(`admin.add.${kind}`)}
          value={body}
          onChange={e => setBody(e.target.value)}
        />
        {body.trim() && (
          <div>
            <button type="submit" className="sa-btn sa-primary">
              {t('admin.logActivity')}
            </button>
          </div>
        )}
      </form>
      {entries.length === 0 && (
        <p className="sa-fine">{t('admin.timelineEmpty')}</p>
      )}
      <ul className="sa-timeline">
        {entries.map(entry => (
          <li key={`${entry.kind}:${entry.id}`}>
            <span className="sa-fine">
              {t(`activity.${entry.kind}`)} · {relativeTime(entry.at, locale)}
              {entry.agentName ? ` · ${entry.agentName}` : ''}
            </span>
            <div style={{ whiteSpace: 'pre-wrap' }}>{entry.title}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DealsCard({
  deals,
  create,
  onChanged,
}: {
  deals: Deal[];
  create: { contactId?: string; companyId?: string | null };
  onChanged: () => void;
}) {
  const { api, t, navigate, href, locale } = useAdmin();
  const [title, setTitle] = useState('');
  return (
    <div className="sa-card">
      <h3>{t('admin.deals')}</h3>
      {deals.map(d => (
        <a
          key={d.id}
          href={href({ view: 'deals' })}
          onClick={e => {
            e.preventDefault();
            navigate({ view: 'deals' });
          }}>
          {d.title} · {t(`stage.${d.stage}`)}{' '}
          <span className="num sa-muted">
            {money(d.value, d.currency, locale)}
          </span>
        </a>
      ))}
      <form
        className="sa-toolbar"
        onSubmit={async e => {
          e.preventDefault();
          if (!title.trim()) return;
          await api('agent/deals', {
            body: {
              title,
              contactId: create.contactId,
              companyId: create.companyId ?? undefined,
            },
          });
          setTitle('');
          onChanged();
        }}>
        <input
          className="sa-input sa-grow"
          aria-label={t('admin.dealTitle')}
          placeholder={t('admin.newDeal')}
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
        <button type="submit" className="sa-btn" disabled={!title.trim()}>
          <Svg d={paths.plus} />
        </button>
      </form>
    </div>
  );
}
