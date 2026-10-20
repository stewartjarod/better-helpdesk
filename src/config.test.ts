import { describe, expect, it } from 'vitest';

import { type HelpdeskConfig, resolveConfig } from './config';

const config = (identityTokenSecret?: string) =>
  ({
    db: { capabilities: {} },
    inboxes: { support: {} },
    identityTokenSecret,
  }) as unknown as HelpdeskConfig;

describe('features', () => {
  it('turns the deals board and the CRM on unless the host turns one off', () => {
    expect(resolveConfig(config()).features).toEqual({
      deals: true,
      crm: true,
    });
    const deals = {
      ...config(),
      features: { deals: false },
    } as HelpdeskConfig;
    expect(resolveConfig(deals).features).toEqual({ deals: false, crm: true });
  });
});

describe('identityTokenSecret', () => {
  it('refuses a secret short enough to guess offline', () => {
    expect(() => resolveConfig(config('helpdesk2026'))).toThrow(
      /identityTokenSecret.*32 bytes/
    );
  });

  it('accepts 32 bytes or more, or none at all', () => {
    expect(() => resolveConfig(config('x'.repeat(32)))).not.toThrow();
    expect(() => resolveConfig(config())).not.toThrow();
  });
});
