import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type {
  BusinessHours,
  CustomFieldDef,
  Locale,
  Translated,
} from '../config';
import type { Api } from '../ui/api';
import type { Translate } from '../ui/i18n';

/** Fired on `window` after every change an agent makes, so a host can refresh its own counts. */
export const HELPDESK_CHANGED = 'helpdesk:changed';

export type Me = {
  agent: { id: string; name: string | null; awayUntil: string | null };
  referencePrefix: string;
  types: string[];
  statuses: string[];
  priorities: string[];
  inboxes: string[];
  inboxNames: Record<string, Partial<Record<Locale, string>>>;
  /** Only the inboxes that have `hours`. */
  inboxHours: Record<string, BusinessHours>;
  /** Labels of the qualifying answers that end up as contact tags. */
  segments: Record<string, { label: Translated; badge: Translated }>;
  leadStages: string[];
  dealStages: string[];
  customFields: Partial<
    Record<'contact' | 'company' | 'deal', CustomFieldDef[]>
  >;
  ai: boolean;
  features: { deals: boolean; crm: boolean };
};

export type AdminContext = {
  api: Api;
  apiBase: string;
  t: Translate;
  locale: Locale;
  me: Me;
  refreshMe: () => Promise<void>;
  route: Route;
  navigate: (route: Route) => void;
  href: (route: Route) => string;
  inboxName: (key: string) => string;
  /** False when the host renders its own section tabs instead of the rail. */
  nav: boolean;
  /** The inbox list's rows in their current order, kept by `Inbox` for working the queue. */
  queue: QueueEntry[];
  setQueue: (update: (queue: QueueEntry[]) => QueueEntry[]) => void;
  openShortcuts: () => void;
};

export type Route = Record<string, string>;

/** `viewed`: a teammate has it open. */
export type QueueEntry = { id: string; viewed: boolean };

const Ctx = createContext<AdminContext | null>(null);

export function AdminProvider({
  value,
  children,
}: {
  value: AdminContext;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAdmin outside HelpdeskAdmin');
  return value;
}

const SECTIONS: Record<string, string> = {
  conversations: 'conversation',
  contacts: 'contact',
  companies: 'company',
};
const ID_KEYS = Object.values(SECTIONS);

/**
 * Views live in the path under `basePath` (`/conversations/<id>/`,
 * `/contacts/`, …) and filters in the query, so every screen is a deep link
 * and a host tab bar can link straight to a section.
 */
export function routeFromLocation(
  basePath: string,
  pathname: string,
  search: string
): Route {
  const rest = pathname.startsWith(basePath)
    ? pathname.slice(basePath.length)
    : '';
  const [section, id] = rest.split('/').filter(Boolean);
  const route: Route = Object.fromEntries(new URLSearchParams(search));
  const key = section ? SECTIONS[section] : undefined;
  if (key && id) route[key] = id;
  else if (section && section !== 'conversations') route.view = section;
  return route;
}

export function hrefForRoute(basePath: string, route: Route) {
  const { view, ...rest } = route;
  const idKey = ID_KEYS.find(k => rest[k]);
  let path = `${basePath}/`;
  if (idKey) {
    const section = Object.keys(SECTIONS).find(k => SECTIONS[k] === idKey);
    path += `${section}/${rest[idKey]}/`;
  } else {
    path += `${view && view !== 'inbox' ? view : 'conversations'}/`;
  }
  const query = Object.fromEntries(
    Object.entries(rest).filter(([k, v]) => v !== '' && !ID_KEYS.includes(k))
  );
  const search = new URLSearchParams(query).toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Host-controlled routing when `location` and `onNavigate` are given (a
 * Next router, say); otherwise the History API.
 */
export function useAdminRoute({
  basePath,
  location,
  onNavigate,
}: {
  basePath: string;
  location?: { pathname: string; search: string };
  onNavigate?: (href: string) => void;
}): [Route, (route: Route) => void] {
  const read = useCallback(
    () =>
      typeof window === 'undefined'
        ? {}
        : routeFromLocation(
            basePath,
            window.location.pathname,
            window.location.search
          ),
    [basePath]
  );
  const [own, setOwn] = useState<Route>(read);

  useEffect(() => {
    if (location) return;
    const onPop = () => setOwn(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [location, read]);

  const pathname = location?.pathname;
  const search = location?.search;
  const route = useMemo(
    () =>
      pathname === undefined
        ? own
        : routeFromLocation(basePath, pathname, search ?? ''),
    [basePath, pathname, search, own]
  );

  const navigate = useCallback(
    (next: Route) => {
      const href = hrefForRoute(basePath, next);
      if (onNavigate) {
        onNavigate(href);
      } else {
        window.history.pushState(null, '', href);
        setOwn(next);
      }
      window.scrollTo({ top: 0 });
    },
    [basePath, onNavigate]
  );

  return [route, navigate];
}
