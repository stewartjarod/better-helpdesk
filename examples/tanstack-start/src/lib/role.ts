// Kept apart from helpdesk.server.ts so client code can import it.
export const ROLE_COOKIE = 'demo-role';

export type DemoRole = 'visitor' | 'customer' | 'agent';

export const roleFromValue = (value: string | null | undefined): DemoRole =>
  value === 'customer' || value === 'agent' ? value : 'visitor';

export const roleFromRequest = (request: Request): DemoRole => {
  const match = new RegExp(`(?:^|;\\s*)${ROLE_COOKIE}=([^;]*)`).exec(
    request.headers.get('cookie') ?? ''
  );
  return roleFromValue(match?.[1]);
};
