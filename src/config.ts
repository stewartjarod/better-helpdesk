import type { DNSResolver } from 'mailauth';
import { z } from 'zod';

import type { DatabaseAdapter } from './db/adapter';
import { createStore, type HelpdeskStore } from './db/store';
import type { HelpdeskEvent } from './events';

export type Locale = 'en' | 'de' | 'fr' | 'it';

/** Copy the host writes per language. English is required; a language left out shows the English text. */
export type Translated = { en: string } & Partial<Record<Locale, string>>;

export type HelpdeskUser = {
  id: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  locale?: string | null;
  /** Shown to customers when this user answers as an agent. */
  image?: string | null;
};

export type HelpdeskOrg = { id: string; name?: string };

/** A link into the host's own tools, labelled per locale. */
export type HostLink = { label: Partial<Record<Locale, string>>; url: string };
/** `userId` is the host's own id for a customer it signed in; `null` for one who only emailed or wrote in. */
export type LinkContact = {
  id: string;
  name: string | null;
  email: string | null;
  userId: string | null;
};
/** `orgId` is the host's own id for the organization; `null` for a company an agent made. */
export type LinkCompany = {
  id: string;
  name: string;
  domain: string | null;
  orgId: string | null;
};

/** Who is calling. `orgs` must list only organizations the user is an active member of. */
export type Identity = {
  user: HelpdeskUser;
  orgs: HelpdeskOrg[];
  isAgent: boolean;
};

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * When the team answers, as wall-clock spans per weekday in `timeZone`.
 * A span whose end is not after its start runs into the next day; `24:00` ends at midnight.
 */
export type BusinessHours = {
  timeZone: string;
  weekly: Partial<Record<(typeof DAY_KEYS)[number], [string, string][]>>;
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const endTime = z.union([time, z.literal('24:00')]);
const businessHours = z.object({
  timeZone: z.string().refine(zone => {
    try {
      // supportedValuesOf lists canonical names only, so an alias such as US/Eastern is checked by what it resolves to.
      const { timeZone } = new Intl.DateTimeFormat('en', {
        timeZone: zone,
      }).resolvedOptions();
      return (
        timeZone === 'UTC' ||
        Intl.supportedValuesOf('timeZone').includes(timeZone)
      );
    } catch {
      return false;
    }
  }, 'Unknown IANA time zone'),
  weekly: z
    .strictObject(
      Object.fromEntries(
        DAY_KEYS.map(d => [d, z.array(z.tuple([time, endTime])).optional()])
      )
    )
    .refine(
      weekly => Object.values(weekly).some(spans => spans?.length),
      'At least one open span'
    ),
});

export type InboxConfig = {
  /** What agents see instead of the key, per locale. */
  name?: Partial<Record<Locale, string>>;
  /** Anonymous visitors may open conversations here. */
  public?: boolean;
  /** Origins allowed to call the widget API cross-origin. */
  allowedOrigins?: string[];
  /** Email agents when a customer has waited this long; open hours only when `hours` is set. */
  reminderAfterHours?: number;
  /** Unset, reminders and the waiting colours count every hour, and the team is back on the next weekday. */
  hours?: BusinessHours;
  /** Priority new conversations start with, e.g. `high` for sales. */
  defaultPriority?: (typeof PRIORITIES)[number];
  /** Widget header for this inbox, per locale. */
  title?: Partial<Record<Locale, string>>;
  /** What the widget promises about replies, per locale. */
  replyPromise?: Partial<Record<Locale, string>>;
  /** One qualifying question asked before the first message is sent. */
  qualify?: {
    label: Translated;
    options: {
      value: string;
      label: Translated;
      /** Short form for badges; `label` shows as its tooltip. */
      badge?: Translated;
    }[];
  };
  /** Linked under the first-message form, per locale. */
  privacyUrl?: Partial<Record<Locale, string>>;
  /** Send a receipt when someone writes in; for inboxes whose people are not signed in. */
  receipt?: boolean;
  /** Offered once someone has written, in the widget and the receipt; e.g. a meeting calendar. */
  bookingUrl?: string;
  /** The booking link in emails, e.g. through a redirect that counts clicks; `bookingUrl` when unset. */
  bookingLink?(reference: string): string;
};

export type HelpdeskEmail =
  | {
      kind: 'customer-reply';
      to: string;
      locale: Locale;
      reference: string;
      /** What the customer called it; absent while their address is unproven. */
      subject?: string;
      body: string;
      agentName: string;
      replyTo?: string;
      inReplyTo?: string;
      /**
       * When the conversation is resolved: links that let the customer rate it
       * from the email, each opening a page under `basePath` to confirm.
       */
      ratingLinks?: { good: string; bad: string };
    }
  | {
      kind: 'customer-receipt';
      to: string;
      locale: Locale;
      reference: string;
      /** The one agent who answers, when there is only one; the receipt is signed by them. */
      responderName?: string;
      responderTitle?: string;
      responderAvatarUrl?: string;
      /**
       * Everyone who answers is away until then, back on `backOn`; ISO timestamps.
       * An inbox with `hours` sets `backOn` alone while it is closed.
       */
      awayUntil?: string;
      backOn?: string;
      bookingUrl?: string;
      replyTo?: string;
    }
  | {
      kind: 'agent-new' | 'agent-reminder';
      to: string;
      locale: Locale;
      reference: string;
      subject: string;
      body: string;
      url: string;
      reopened?: boolean;
    }
  | {
      kind: 'agent-mention';
      to: string;
      locale: Locale;
      reference: string;
      subject: string;
      body: string;
      url: string;
      authorName: string;
    };

export type StorageAdapter = {
  presignUpload(
    key: string,
    opts: { contentType: string; maxBytes: number }
  ): Promise<{ url: string; fields: Record<string, string> }>;
  presignDownload(key: string, filename: string): Promise<string>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
};

export type HelpResult = { title: string; url: string; excerpt?: string };

export type AiAdapter = {
  generate<T>(input: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
  }): Promise<T>;
};

export type InboundMessage = {
  messageId: string;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references: string[];
  /** The From domain signed the message (aligned DKIM), and From is a single address. */
  verified: boolean;
  /** An out-of-office, a bounce or other mail no person wrote. */
  automated: boolean;
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
};

export type CustomFieldDef = {
  key: string;
  label: Translated;
  type: 'text' | 'number' | 'date' | 'select';
  options?: string[];
};

export type HelpdeskConfig = {
  /** Where the helpdesk keeps its data: `postgresAdapter({ pool })` or another adapter. */
  db: DatabaseAdapter;
  /** Prefix of human-readable references, e.g. `DG` gives `DG-1042`. */
  referencePrefix: string;
  /** Who answers when more than one person does, e.g. "The Acme team"; the widget names the one person otherwise. */
  teamName?: Partial<Record<Locale, string>>;
  /** Role shown under an agent's name where they sign an email, by agent email. */
  agentTitles?: Record<string, Partial<Record<Locale, string>>>;
  /** Mount path of the route handler. */
  basePath?: string;
  /** Absolute URL of the agent UI, used in agent emails. */
  adminUrl: string;
  types?: string[];
  inboxes: Record<string, InboxConfig>;
  identify(request: Request): Promise<Identity | null>;
  /**
   * Signs `x-helpdesk-identity` tokens (HS256 JWT) that a host on another origin
   * mints for its signed-in users; consulted only when `identify` returns null.
   */
  identityTokenSecret?: string;
  resolveContext?(externalOrgId: string): Promise<Record<string, string>>;
  /** Links into the host's own tools for a customer (its admin, Stripe, a CRM), shown with the contact and company. */
  links?(
    contact: LinkContact | null,
    company: LinkCompany | null
  ): HostLink[] | Promise<HostLink[]>;
  /** Names for orgs `identify` returned without one; asked only when shown or stored. */
  orgNames?(externalOrgIds: string[]): Promise<Record<string, string>>;
  storage?: StorageAdapter;
  email?: { send(message: HelpdeskEmail): Promise<void> };
  /** Reply-To address that threads a customer's email reply into a conversation. */
  replyToAddress?(reference: string): string;
  /**
   * Accept raw emails POSTed to `{basePath}/inbound/` with this bearer secret,
   * from any relay that can forward a message to a URL.
   */
  inboundWebhookSecret?: string;
  /** DNS lookups for DKIM keys; the system resolver when unset. */
  dnsResolver?: DNSResolver;
  /** Inbox that inbound email lands in. */
  inboundInbox?: string;
  help?: { search(query: string, locale: Locale): Promise<HelpResult[]> };
  ai?: AiAdapter;
  /**
   * Told about each new conversation, message and agent change once it is
   * stored. Awaited inside the request, so keep it fast or enqueue; what it
   * throws is logged, never returned to the caller.
   */
  onEvent?(event: HelpdeskEvent): Promise<void>;
  /** Bearer secret for `POST {basePath}/jobs`. */
  jobsSecret?: string;
  /** The caller's address as your proxy reports it; the default takes the last X-Forwarded-For hop. */
  clientIp?(request: Request): string | null;
  leadStages?: string[];
  dealStages?: string[];
  /** Parts of the agent UI to turn off, and their routes with them. Both are on by default. */
  features?: { deals?: boolean; crm?: boolean };
  customFields?: Partial<
    Record<'contact' | 'company' | 'deal', CustomFieldDef[]>
  >;
  /** Delete resolved conversations this many days after resolution. */
  retentionDays?: number;
  maxAttachmentBytes?: number;
  /** Anonymous posts allowed per IP per hour. */
  anonymousRateLimit?: number;
  /** Conversations, messages and uploads a signed-in customer may start per hour. */
  customerRateLimit?: number;
};

export const DEFAULT_TYPES = ['question', 'bug', 'feature', 'lead'];
export const STATUSES = ['open', 'pending', 'resolved'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const DEFAULT_LEAD_STAGES = ['lead', 'qualified', 'customer', 'churned'];
export const DEFAULT_DEAL_STAGES = [
  'new',
  'qualified',
  'proposal',
  'won',
  'lost',
];

export type ResolvedConfig = HelpdeskConfig & {
  store: HelpdeskStore;
  basePath: string;
  types: string[];
  leadStages: string[];
  dealStages: string[];
  features: { deals: boolean; crm: boolean };
  maxAttachmentBytes: number;
  anonymousRateLimit: number;
  customerRateLimit: number;
};

export function resolveConfig(config: HelpdeskConfig): ResolvedConfig {
  // Every signed-in user holds a token signed with it, so a short one can be
  // guessed offline and used to sign in as anyone.
  if (
    config.identityTokenSecret !== undefined &&
    Buffer.byteLength(config.identityTokenSecret) < 32
  ) {
    throw new Error(
      'identityTokenSecret needs 32 bytes or more; generate one with `openssl rand -base64 32`'
    );
  }
  for (const [key, inbox] of Object.entries(config.inboxes)) {
    if (!inbox.hours) continue;
    const parsed = businessHours.safeParse(inbox.hours);
    if (!parsed.success)
      throw new Error(
        `Invalid hours for inbox ${key}: ${z.prettifyError(parsed.error)}`
      );
  }
  return {
    ...config,
    store: createStore(config.db),
    basePath: (config.basePath ?? '/api/helpdesk').replace(/\/$/, ''),
    types: config.types ?? DEFAULT_TYPES,
    leadStages: config.leadStages ?? DEFAULT_LEAD_STAGES,
    dealStages: config.dealStages ?? DEFAULT_DEAL_STAGES,
    features: {
      deals: config.features?.deals ?? true,
      crm: config.features?.crm ?? true,
    },
    maxAttachmentBytes: config.maxAttachmentBytes ?? 10 * 1024 * 1024,
    anonymousRateLimit: config.anonymousRateLimit ?? 20,
    customerRateLimit: config.customerRateLimit ?? 60,
  };
}
