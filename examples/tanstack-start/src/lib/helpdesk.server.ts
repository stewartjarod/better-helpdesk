import { DatabaseSync } from 'node:sqlite';

import {
  buildHelpdesk,
  type Identity,
  migrate,
  sqliteAdapter,
} from 'better-helpdesk';

import { roleFromRequest } from './role';

// The app's own origin. The helpdesk refuses mutations from any other origin,
// so set ORIGIN for the production server to the URL the app is reached at.
const origin = process.env.ORIGIN ?? 'http://localhost:3000';

const db = sqliteAdapter({
  database: new DatabaseSync(process.env.HELPDESK_SQLITE ?? 'helpdesk.db'),
});

const IDENTITIES = {
  customer: {
    user: {
      id: 'demo-customer',
      email: 'nadia@brightline.test',
      emailVerified: true,
      name: 'Nadia Olufemi',
    },
    orgs: [{ id: 'demo-org', name: 'Brightline Logistics' }],
    isAgent: false,
  },
  agent: {
    user: {
      id: 'demo-agent',
      email: 'rowan@harbor.test',
      emailVerified: true,
      name: 'Rowan Vester',
    },
    orgs: [],
    isAgent: true,
  },
} satisfies Record<'customer' | 'agent', Identity>;

const helpdesk = buildHelpdesk({
  db,
  basePath: '/api/helpdesk',
  referencePrefix: 'TSS',
  adminUrl: `${origin}/helpdesk/`,
  inboxes: {
    support: { name: { en: 'Support' }, public: true },
  },
  // The demo's cookie stands in for a session. Anyone who sets it becomes
  // an agent here, so this is no place for production traffic.
  identify: async request => {
    const role = roleFromRequest(request);
    return role === 'visitor' ? null : IDENTITIES[role];
  },
  // Swap for your app's session, for example Better Auth. The commented
  // version below is the same shape as examples/adapters/identify-better-auth.ts.
  //
  // identify: async request => {
  //   const session = await auth.api.getSession({ headers: request.headers });
  //   if (!session) return null;
  //   const orgs = await auth.api.listOrganizations({ headers: request.headers });
  //   const { user } = session;
  //   return {
  //     user: {
  //       id: user.id,
  //       email: user.email,
  //       emailVerified: user.emailVerified,
  //       name: user.name,
  //       image: user.image,
  //     },
  //     orgs: orgs.map(org => ({ id: org.id, name: org.name })),
  //     isAgent: user.role?.split(',').includes('support') ?? false,
  //   };
  // },
});

// Migrates on the first request rather than at import, so a build that only
// imports this module never touches the database.
let migrated: ReturnType<typeof migrate> | undefined;

export async function handleHelpdesk(request: Request): Promise<Response> {
  migrated ??= migrate(db);
  await migrated;
  return helpdesk.handler(request);
}
