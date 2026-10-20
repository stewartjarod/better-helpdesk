<p align="center">
  <img alt="Better Helpdesk" src="https://raw.githubusercontent.com/better-helpdesk/better-helpdesk/main/.github/assets/logo.gif" width="96" height="96">
</p>

<h1 align="center">Better Helpdesk</h1>

<p align="center">
  The open-source helpdesk that lives inside your Next.js app.<br>
  Support inbox, ticketing and a lightweight CRM, in your database, behind your login.
</p>

<p align="center">
  <a href="https://better-helpdesk.com/demo/"><img alt="A customer asks a question in the widget, an agent answers from the inbox, and the reply appears in the widget" src="https://raw.githubusercontent.com/better-helpdesk/better-helpdesk/main/.github/assets/loop.gif" width="880"></a>
</p>

<p align="center">
  <a href="https://better-helpdesk.com/demo/"><b>Try the live demo, no install</b></a>
</p>

<p align="center">
  <a href="https://github.com/better-helpdesk/better-helpdesk/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/better-helpdesk/better-helpdesk/ci.yml?branch=main&label=CI"></a>
  <a href="https://www.npmjs.com/package/better-helpdesk"><img alt="npm version" src="https://img.shields.io/npm/v/better-helpdesk"></a>
  <a href="https://www.npmjs.com/package/better-helpdesk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/better-helpdesk"></a>
  <a href="https://github.com/better-helpdesk/better-helpdesk/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/better-helpdesk/better-helpdesk"></a>
  <a href="https://nodejs.org/"><img alt="Node.js version" src="https://img.shields.io/node/v/better-helpdesk"></a>
</p>

<p align="center">
  <a href="#why-better-helpdesk">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://better-helpdesk.com/docs">Docs</a> ·
  <a href="https://better-helpdesk.com/demo/">Demo</a> ·
  <a href="https://github.com/better-helpdesk/better-helpdesk/releases">Releases</a>
</p>

Better Helpdesk is an npm package, not a service. You mount one route
handler, render one React component for your support team and drop one
widget onto your site. Conversations, contacts and companies live in the
database you already run (Postgres, MySQL, SQL Server or SQLite), and your
app's own session decides who is a customer and who is on the team. There is no second
system to deploy, no users to sync and no per-seat bill.

```sh
npm install better-helpdesk pg
```

Better Helpdesk is not affiliated with Better Auth. It works with it, as with
Auth.js, Clerk and Supabase Auth.

## Why Better Helpdesk

Hosted helpdesks keep your customer data on their servers and charge per
seat. Self-hosted ones are a second application with its own login, database
and deploy pipeline, which you then integrate with your product. Better
Helpdesk is a library. It reuses what your app already has: its session, its
database, its deploy and its design tokens.

|                | Better Helpdesk              | Hosted (Intercom, Zendesk) | Self-hosted apps (Chatwoot, Libredesk) |
| -------------- | ---------------------------- | -------------------------- | -------------------------------------- |
| Runs           | inside your Next.js app      | on the vendor's servers    | as a separate app you operate          |
| Customer data  | your database                | the vendor's database      | its own database                       |
| Sign-in        | your existing session        | separate agent accounts    | separate agent accounts                |
| Look and feel  | your CSS custom properties   | vendor theming             | vendor theming                         |
| Cost           | MIT, free                    | per seat, per month        | free, plus the hosting                 |

## Features

- **Shared inbox.** Several inboxes (say, support and sales), priorities,
  human-readable references like `ACME-1042`, internal notes, canned replies,
  keyboard navigation, saved views of the inbox filters for one agent or the
  whole team, and reminder emails when a customer has waited too long.
- **Lightweight CRM.** Contacts and companies taken from your app's identity,
  lead stages, deals with stages and values, logged activities, tags and
  custom fields.
- **Widget.** A `<helpdesk-widget>` web component with a React wrapper and a
  standalone script for sites that are not React. Cross-origin capable, with
  one qualifying question, a privacy link, a booking link, receipts for
  anonymous visitors, captured page context (URL, viewport, recent errors,
  referrer, UTM) and a dark theme.
- **Email.** Outbound through your own sender. Inbound through a webhook from
  any relay, verified against DKIM and threaded back into the conversation.
- **Everything optional is an adapter.** File storage, AI suggestions and
  draft replies, help center search and scheduled jobs are small interfaces
  you implement, or leave out.
- **Your identity, your data.** No passwords and no sessions are stored.
  Your `identify(request)`, or a signed identity token from another origin,
  decides who someone is. Retention and rate limits are yours to set.
- **English, German, French and Italian**, with every agent UI string overridable. Theming through
  `--helpdesk-*` CSS custom properties.
- **TypeScript, ESM, four runtime dependencies**: `kysely`, `zod`,
  `mailparser` and `mailauth`. Peer dependencies are React 19 and the driver of the host's database (`pg`, `mysql2`, or `tedious` and `tarn`; SQLite needs none).

## Compared with

The table under [Why Better Helpdesk](#why-better-helpdesk) is the short version.
[Compared with Chatwoot, Libredesk, Intercom and Zendesk](https://better-helpdesk.com/docs/compared)
has the full one, feature by feature: channels, real-time delivery, SLA,
automation, reporting, AI, API, roles, languages and theming, with the dates
and sources.

## How it works

One route handler serves every route under `basePath`. Your `identify`
function runs on widget and agent requests, and everything is written to the
`helpdesk` schema in your database.

| Who                     | Uses                                                        | Talks to               |
| ----------------------- | ----------------------------------------------------------- | ---------------------- |
| Visitors and customers  | `<HelpdeskWidget />`, or `widget.js` on any site            | `{basePath}/widget/*`  |
| Your support team       | `<HelpdeskAdmin />`, open only when `identify` says `isAgent` | `{basePath}/agent/*`   |
| Your mail relay         | POSTs each raw inbound email                                | `{basePath}/inbound`   |
| Your scheduler          | `helpdesk.runJobs()`, or a POST with a bearer secret        | `{basePath}/jobs`      |

In this project an *agent* is a member of your support team. It is never an
AI; AI only ever produces a suggestion or a draft that a person reviews.

## Requirements

- Node.js 22.19 or newer
- A database: PostgreSQL 14, MySQL 8.4 or SQL Server 2022 or newer, or SQLite through Node's own `node:sqlite`
- React 19, and the driver of your database (`pg` for Postgres), as peer dependencies.
  [Choose and connect a database](https://better-helpdesk.com/docs/database/connect)
  covers each one, and [Write your own database adapter](https://better-helpdesk.com/docs/database/own-adapter)
  any other.
- Next.js 15 or newer for the examples below. The handler is a plain
  function from `Request` to `Response`, so any server with that shape can
  mount it: [`examples/hono`](https://github.com/better-helpdesk/better-helpdesk/tree/main/examples/hono),
  [`examples/sveltekit`](https://github.com/better-helpdesk/better-helpdesk/tree/main/examples/sveltekit) and
  [`examples/tanstack-start`](https://github.com/better-helpdesk/better-helpdesk/tree/main/examples/tanstack-start) show three.

## The whole integration

Three files in your Next.js app, and the helpdesk is in it:

```ts
// app/api/helpdesk/[...slug]/route.ts: every helpdesk route, one handler
import { helpdesk } from '@/lib/helpdesk';

const handle = (request: Request) => helpdesk.handler(request);
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE, handle as OPTIONS };
```

```tsx
// app/helpdesk/[[...slug]]/page.tsx: the inbox, for your support team
import { HelpdeskAdmin } from 'better-helpdesk/admin';

export default () => <HelpdeskAdmin api="/api/helpdesk" basePath="/helpdesk" locale="en" />;
```

```tsx
// app/layout.tsx: the widget, for your customers
import { HelpdeskWidget } from 'better-helpdesk/widget';

<HelpdeskWidget inbox="support" locale="en" />
```

`lib/helpdesk.ts` builds the helpdesk from your database and your session;
step 4 below has it in full.

## Quickstart

### 1. Install

```sh
npm install better-helpdesk pg
npm install --save-dev @types/pg
```

`react` and `react-dom` are peer dependencies that a Next.js app already has.

### 2. Create the schema

```sh
HELPDESK_DATABASE_URL=postgres://… npx better-helpdesk-migrate
```

The CLI opens one connection, creates the `helpdesk` schema and its tables,
and exits, so it fits into a release step next to your own migrations. It
also reads `APP_DATABASE_URL`. The steps here use Postgres; on MySQL, SQL
Server or SQLite the URL starts with `mysql://`, `mssql://` or `file:`. For
Postgres, `DATABASE_SSL=true` turns on TLS and verifies the server's
certificate; `DATABASE_SSL=no-verify` encrypts without checking
it, for a database with a self-signed certificate. An `sslmode` in the
connection string takes precedence over both.

### 3. Let Next.js compile the package

```js
// next.config.mjs
import { withHelpdesk } from 'better-helpdesk/next';

export default withHelpdesk({
  // Both UIs request paths with a trailing slash. Without this every call
  // pays a redirect first, and a widget on another origin fails its CORS
  // preflight.
  trailingSlash: true,
});
```

`trailingSlash` also adds a slash to every other URL of your app. The
[install guide](https://better-helpdesk.com/docs/installation) shows how to
keep your own URLs as they are.

### 4. Build the helpdesk and mount the handler

```ts
// lib/helpdesk.ts
import { buildHelpdesk, postgresAdapter } from 'better-helpdesk';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.HELPDESK_DATABASE_URL });

export const helpdesk = buildHelpdesk({
  db: postgresAdapter({ pool }),
  referencePrefix: 'ACME',
  adminUrl: 'https://app.example.com/helpdesk/',
  inboxes: {
    support: { receipt: true },
    sales: { public: true, allowedOrigins: ['https://www.example.com'] },
  },
  identify: async request => {
    const session = await getSession(request); // however your app does it
    if (!session) return null; // an anonymous visitor
    return {
      user: { id: session.user.id, email: session.user.email, emailVerified: true, name: session.user.name },
      orgs: session.orgs.map(org => ({ id: org.id, name: org.name })),
      isAgent: session.user.role === 'support',
    };
  },
});
```

```ts
// app/api/helpdesk/[...slug]/route.ts
import { helpdesk } from '@/lib/helpdesk';

const handle = (request: Request) => helpdesk.handler(request);
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE, handle as OPTIONS };
```

Two things to get right here:

- `isAgent` is the only thing that grants the agent UI, and `orgs` must list
  only the organizations the user is an active member of.
- `adminUrl` must be the URL your team actually opens in the browser. The
  handler refuses mutations from any other origin, so a mismatch turns every
  reply into a 403.

Worked `identify` functions for [Better Auth](https://github.com/better-helpdesk/better-helpdesk/blob/main/examples/adapters/identify-better-auth.ts),
[Auth.js](https://github.com/better-helpdesk/better-helpdesk/blob/main/examples/adapters/identify-nextauth.ts),
[Clerk](https://github.com/better-helpdesk/better-helpdesk/blob/main/examples/adapters/identify-clerk.ts) and
[Supabase Auth](https://github.com/better-helpdesk/better-helpdesk/blob/main/examples/adapters/identify-supabase.ts) are in `examples/adapters/`,
next to one for every other adapter below.

### 5. Render the agent UI

```tsx
// app/helpdesk/[[...slug]]/page.tsx
import { HelpdeskAdmin } from 'better-helpdesk/admin';

export default function Page() {
  return <HelpdeskAdmin api="/api/helpdesk" basePath="/helpdesk" locale="en" />;
}
```

Put the page behind your own agent check as well. The API refuses anyone who
is not an agent either way.

### 6. Add the widget

```tsx
import { HelpdeskWidget } from 'better-helpdesk/widget';

export function Layout({ children }) {
  return (
    <>
      {children}
      <HelpdeskWidget inbox="support" locale="en" />
    </>
  );
}
```

Send a message from the widget, open `/helpdesk` as an agent and answer it.
That is the whole loop, and the
[docs](https://better-helpdesk.com/docs/operations/production) take it from
there: sign-in, production, email, jobs, attachments, AI and theming.
[`examples/demo`](https://github.com/better-helpdesk/better-helpdesk/tree/main/examples/demo)
has it wired up end to end.

## Documentation

[better-helpdesk.com/docs](https://better-helpdesk.com/docs):
[Quickstart](https://better-helpdesk.com/docs/quickstart) ·
[Installation](https://better-helpdesk.com/docs/installation) ·
[How it works](https://better-helpdesk.com/docs/how-it-works) ·
[Reference](https://better-helpdesk.com/docs/reference/configuration).
The pages are MDX in [`site/content/docs`](site/content/docs).

## Demo

Try it without installing anything at
[better-helpdesk.com/demo](https://better-helpdesk.com/demo/): write in as a
customer, answer as the agent, and see the rows land in Postgres. Everyone
shares that inbox, and it starts over every quarter hour.

[`examples/demo`](https://github.com/better-helpdesk/better-helpdesk/tree/main/examples/demo)
is Harbor, a pretend shipping product with the package installed the way the
quickstart describes: one route handler, the agent UI at `/helpdesk`, the widget
in the corner. With a local Postgres running:

```sh
pnpm install
cp examples/demo/.env.example examples/demo/.env.local
pnpm --filter better-helpdesk-demo db:migrate
pnpm --filter better-helpdesk-demo dev
```

Its README explains the role switcher and what the demo deliberately gets
wrong. CI builds and runs the same app against the packed tarball on the
current and the previous major of Next.js, and against `next@canary` once a
week.

## Status

Better Helpdesk is young and under active development. Until 1.0 a minor
version may change the API, and every release's notes list the pull requests
it contains. Releases are published to npm with provenance through trusted
publishing. The architecture is settled, though: embedded in the host, Next.js
first, the host's own database through an adapter, the host owns identity. A standalone server, a hosted
mode or its own login are not planned.
[`ROADMAP.md`](https://github.com/better-helpdesk/better-helpdesk/blob/main/ROADMAP.md)
lists what Better Helpdesk will not do and what comes next.

## Contributing

Issues and pull requests are welcome.
[`CONTRIBUTING.md`](https://github.com/better-helpdesk/better-helpdesk/blob/main/CONTRIBUTING.md)
walks you through setup, the tests and what a pull request needs. For the
full detail, read
[`AGENTS.md`](https://github.com/better-helpdesk/better-helpdesk/blob/main/AGENTS.md)
for how the repository works and what is off-limits, and
[`CONTEXT.md`](https://github.com/better-helpdesk/better-helpdesk/blob/main/CONTEXT.md)
for the vocabulary the code uses.

```sh
pnpm install --frozen-lockfile
pnpm lint                 # Biome, then tsc --noEmit
pnpm test                 # unit tests
TEST_DATABASE_URL=postgres://postgres@localhost:5432/db pnpm test:integration
```

The integration tests create a `helpdesk_test` database next to the one the
URL names. A `postgres:18-alpine` container started with
`POSTGRES_HOST_AUTH_METHOD=trust` is enough. Green CI (lint, both test
suites, the tarball smoke test and the demo build) is the bar for every pull
request. Commit messages follow the conventional form in the history
(`fix(widget): …`, `feat(admin): …`), and pull request titles become the
release notes, so write them as changelog lines.

## Security

Better Helpdesk stores no passwords and no sessions. Mutations are checked
against the agent UI's origin, inbound mail is verified against DKIM,
identity tokens are signed and expire, and anonymous and customer traffic is
rate limited. Attachments go to your storage, never through the package's
own hosting.

If you find a vulnerability, please do not open a public issue. Report it
privately through
[GitHub's security advisories](https://github.com/better-helpdesk/better-helpdesk/security/advisories/new)
for this repository.

## License

[MIT](https://github.com/better-helpdesk/better-helpdesk/blob/main/LICENSE) © 2026 devguard AG
