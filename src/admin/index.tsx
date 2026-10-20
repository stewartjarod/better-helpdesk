'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { Locale } from '../config';
import { type Api, ApiError, createApi, useResource } from '../ui/api';
import { type Translate, translator } from '../ui/i18n';
import { isMac, SHORTCUT } from '../ui/rich-editor';
import { CannedReplies } from './canned';
import {
  AdminProvider,
  HELPDESK_CHANGED,
  hrefForRoute,
  type Me,
  type QueueEntry,
  useAdminRoute,
} from './context';
import { ConversationView } from './conversation';
import { CompanyList, CompanyView, ContactList, ContactView } from './crm';
import { DealsBoard } from './deals';
import { AwayControl, Inbox } from './inbox';
import { NotificationBell } from './notifications';
import { OverviewPage } from './overview';
import { Settings } from './settings';
import { adminCss } from './styles';
import {
  Avatar,
  Dialog,
  LoadError,
  setKeysOn,
  useKeysOn,
  useShortcuts,
} from './ui';

/** The agent UI's sections, for a host that renders its own tabs. */
export { HELPDESK_CHANGED };

export const HELPDESK_SECTIONS = [
  'inbox',
  'contacts',
  'companies',
  'deals',
  'canned',
  'overview',
  'settings',
] as const;
const VIEWS = HELPDESK_SECTIONS;

/** The sections a host turns off with `features`; every other section is always on. */
function sectionOn(section: string, features?: Me['features']) {
  if (section === 'deals') return features?.deals ?? true;
  if (section === 'contacts' || section === 'companies')
    return features?.crm ?? true;
  return true;
}

/** The agent UI. Mount it in any React page; it routes through the query string. */
export function HelpdeskAdmin({
  api: apiBase = '/api/helpdesk',
  basePath,
  locale,
  messages,
  location,
  onNavigate,
  nav = true,
}: {
  api?: string;
  /** Where the agent UI is mounted, e.g. `/support`. */
  basePath: string;
  locale: Locale;
  /** Overrides for the package's own strings, keyed like `admin.inbox`. */
  messages?: Record<string, string>;
  /** Host router state; the History API is used when absent. */
  location?: { pathname: string; search: string };
  onNavigate?: (href: string) => void;
  /** Off when the host renders its own section tabs (see `HELPDESK_SECTIONS`). */
  nav?: boolean;
}) {
  const api = useMemo<Api>(() => {
    const call = createApi(apiBase);
    return async (path, init) => {
      const result = await call(path, init);
      if (
        (init?.method ?? (init?.body === undefined ? 'GET' : 'POST')) !== 'GET'
      ) {
        window.dispatchEvent(new Event(HELPDESK_CHANGED));
      }
      return result as never;
    };
  }, [apiBase]);
  const t = useMemo(() => translator(locale, messages), [locale, messages]);
  const root = basePath.replace(/\/$/, '');
  const [route, navigate] = useAdminRoute({
    basePath: root,
    location,
    onNavigate,
  });
  const me = useResource(() => api<Me>('agent/me'), 'me');
  const [sheet, setSheet] = useState(false);
  useShortcuts(me.data ? { '?': () => setSheet(true) } : {});

  // An action whose failure no handler caught would otherwise fail silently.
  const [unhandled, setUnhandled] = useState(false);
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof ApiError)) return;
      event.preventDefault();
      setUnhandled(true);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page clears the last page's failure.
  useEffect(() => setUnhandled(false), [route]);

  // A list the host turned off falls back to the inbox; a contact or company
  // card still opens, because a conversation links to it.
  const requested = route.conversation
    ? 'conversation'
    : route.contact
      ? 'contact'
      : route.company
        ? 'company'
        : (route.view ?? 'inbox');
  const features = me.data?.features;
  const view = sectionOn(requested, features) ? requested : 'inbox';
  const section =
    view === 'conversation'
      ? 'inbox'
      : view === 'contact'
        ? 'contacts'
        : view === 'company'
          ? 'companies'
          : view;

  // On a phone the rail scrolls, and the section you are in can start off-screen.
  // `ready` is in the deps because the nav is not mounted until `me` lands.
  const navRef = useRef<HTMLElement>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const ready = Boolean(me.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab to show is the one the section moved to.
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      // Optional: jsdom has no layout and so does not implement it.
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section, ready]);

  return (
    <>
      <style href="support-admin" precedence="default">
        {adminCss}
      </style>
      {me.error ? (
        <LoadError t={t} onRetry={me.refresh} />
      ) : (
        unhandled && (
          <p className="sa-error" role="alert">
            {t('admin.error')}
          </p>
        )
      )}
      {me.data && (
        <AdminProvider
          value={{
            api,
            apiBase: apiBase.replace(/\/$/, ''),
            t,
            locale,
            me: me.data,
            refreshMe: me.refresh,
            route,
            navigate,
            href: next => hrefForRoute(root, next),
            inboxName: key =>
              me.data?.inboxNames?.[key]?.[locale] ??
              key.charAt(0).toUpperCase() + key.slice(1),
            nav,
            queue,
            setQueue,
            openShortcuts: () => setSheet(true),
          }}>
          <div className="sa">
            {nav && (
              <div className="sa-rail">
                <nav
                  className="sa-nav"
                  ref={navRef}
                  aria-label={t('admin.sections')}>
                  {VIEWS.filter(v => sectionOn(v, features)).map(v => (
                    <button
                      key={v}
                      type="button"
                      aria-current={section === v ? 'page' : undefined}
                      onClick={() =>
                        navigate(v === 'inbox' ? {} : { view: v })
                      }>
                      {t(`admin.${v}`)}
                    </button>
                  ))}
                </nav>
                <div className="sa-me">
                  <NotificationBell />
                  <Avatar name={me.data.agent.name} agent />
                  <AwayControl />
                </div>
              </div>
            )}
            {(view === 'inbox' || view === 'conversation') && (
              // The list stays mounted beside the thread, so it keeps its cursor and data; CSS hides it on a narrow container.
              <div
                className="sa-panes"
                data-open={route.conversation ? '' : undefined}>
                <div className="sa-list-pane">
                  <Inbox />
                </div>
                {route.conversation && (
                  // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles up from the composer and the thread's controls.
                  <div
                    className="sa-thread-pane"
                    onKeyDown={e => {
                      if (
                        e.key !== 'Escape' ||
                        e.defaultPrevented ||
                        (e.target as Element).closest('dialog')
                      )
                        return;
                      const row =
                        e.currentTarget.parentElement?.querySelector<HTMLElement>(
                          '.sa-list-pane tr[aria-current] a'
                        );
                      if (row?.checkVisibility?.() === false) return;
                      row?.focus();
                    }}>
                    <ConversationView
                      key={route.conversation}
                      id={route.conversation}
                    />
                  </div>
                )}
              </div>
            )}
            {view === 'contacts' && <ContactList />}
            {view === 'contact' && route.contact && (
              <ContactView key={route.contact} id={route.contact} />
            )}
            {view === 'companies' && <CompanyList />}
            {view === 'company' && route.company && (
              <CompanyView key={route.company} id={route.company} />
            )}
            {view === 'deals' && <DealsBoard />}
            {view === 'canned' && <CannedReplies />}
            {view === 'overview' && <OverviewPage />}
            {view === 'settings' && <Settings />}
          </div>
          <Dialog
            open={sheet}
            title={t('admin.shortcuts')}
            onClose={() => setSheet(false)}>
            <ShortcutSheet t={t} onClose={() => setSheet(false)} />
          </Dialog>
        </AdminProvider>
      )}
    </>
  );
}

function ShortcutSheet({ t, onClose }: { t: Translate; onClose: () => void }) {
  const mod = isMac() ? '⌘' : 'Ctrl';
  const keysOn = useKeysOn();
  const hintId = useId();
  const groups: [string, [string[], string][]][] = [
    [
      t('admin.inbox'),
      [
        [['j', 'k'], t('admin.keyMove')],
        [['↵'], t('admin.keyOpen')],
        [['x'], t('admin.keySelect')],
        [['⇧', 'x'], t('admin.keyRange')],
      ],
    ],
    [
      t('admin.keysConversation'),
      [
        [['e'], t('admin.keyResolve')],
        [['a'], t('admin.keyAssign')],
        [['r'], t('admin.keyReply')],
        [['n'], t('admin.keyNote')],
        [['s'], t('admin.keySkip')],
        [['z'], t('admin.snooze')],
        [[mod, '↵'], t('admin.send')],
        [[mod, '⇧', '↵'], t('admin.sendResolve')],
        ...Object.entries(SHORTCUT).map(([format, key]): [string[], string] => [
          [mod, key.toUpperCase()],
          t(`rich.${format}`),
        ]),
        [['/'], t('admin.keyCanned')],
      ],
    ],
    [t('admin.everywhere'), [[['?'], t('admin.keyHelp')]]],
  ];
  return (
    <div className="sa-dialog-body">
      <h2>{t('admin.shortcuts')}</h2>
      <label>
        <input
          type="checkbox"
          checked={keysOn}
          aria-describedby={hintId}
          onChange={e => setKeysOn(e.target.checked)}
        />{' '}
        {t('admin.singleKeys')}
      </label>
      <p id={hintId} className="sa-muted">
        {t('admin.singleKeysHint', { mod })}
      </p>
      {groups.map(([heading, keys]) => (
        <section key={heading}>
          <h3>{heading}</h3>
          <dl className="sa-keys">
            {keys.map(([combo, label]) => (
              <div key={label}>
                <dt className="sa-kbd">
                  {combo.map((key, i) => (
                    <span key={key}>
                      {i > 0 && ' '}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <div className="sa-dialog-foot">
        <button type="button" className="sa-btn" onClick={onClose}>
          {t('admin.close')}
        </button>
      </div>
    </div>
  );
}
