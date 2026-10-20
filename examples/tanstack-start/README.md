# Better Helpdesk in a TanStack Start app

The helpdesk's handler is a plain `Request → Response` function, so it runs in
any framework that speaks web `Request`. This is a minimal TanStack Start app
that mounts it: the helpdesk API as a server route under `/api/helpdesk`, the
customer widget on the home page, the agent UI under `/helpdesk/`, and the data
in a SQLite file next to the app.

Unlike `examples/sveltekit`, which installs the published package, this one
depends on the workspace copy of `better-helpdesk`, so it runs your edits to
`src/`.

## Run it

You need Node 22.19 or newer. From the repository root:

```sh
pnpm install
pnpm --filter better-helpdesk-tanstack-start dev
```

Open `http://localhost:3000`. The server creates `helpdesk.db` and migrates it
on the first request.

The production build is served by `vite preview`, which runs the built server:

```sh
pnpm --filter better-helpdesk-tanstack-start build
ORIGIN=http://localhost:3000 pnpm --filter better-helpdesk-tanstack-start start
```

`ORIGIN` is the URL the app is reached at. The helpdesk refuses mutations from
any other origin, so without it every widget message is a 403.
`HELPDESK_SQLITE` changes the database file.

`pnpm --filter better-helpdesk-tanstack-start smoke` starts the built app on a
free port, checks the API, the agent UI and the home page, then stops it. Run
`build` first.

## Trailing slashes

The widget and the agent UI request paths ending in `/`. TanStack Router's
default `trailingSlash: 'never'` redirects `/helpdesk/` to `/helpdesk` with a
307, which breaks the agent UI. `src/router.tsx` sets `trailingSlash: 'preserve'`
so those paths are served as they are. The API needs no setting: its server
route is not a router page, and the helpdesk handler strips the trailing slash
itself.

## Sign in

Identity is a cookie, as in `examples/demo`, so the app runs with no auth
server. Use the links on the home page, or open `/role?as=agent` to become the
support agent and then `/helpdesk/`. `/role?as=visitor` signs out. This is for
the demo only; anyone who sets the cookie becomes an agent.

To use your own sign-in, replace `identify` in `src/lib/helpdesk.server.ts`.
A commented Better Auth version is there, with the same shape as
`examples/adapters/identify-better-auth.ts`. Its `auth` import is yours to
provide.

## How it is wired

- **Builds the helpdesk** in `src/lib/helpdesk.server.ts`, with the SQLite
  adapter. The migration runs on the first request, not at import, so the
  build never touches the database. On a server, run `better-helpdesk-migrate`
  as a deploy step instead.
- **Mounts the handler** in `src/routes/api/helpdesk/$.ts`. Its `ANY` server
  handler passes the request to the helpdesk, so every method and path under
  `/api/helpdesk` goes through one route. `basePath` in the configuration must
  match the route.
- **Renders the UIs.** `src/routes/index.tsx` renders `<HelpdeskWidget>`, and
  `src/routes/helpdesk/$.tsx` renders `<HelpdeskAdmin>`.

## What is left out

Email, storage, AI and scheduled jobs are optional adapters; see the
[documentation](https://better-helpdesk.com/docs).
