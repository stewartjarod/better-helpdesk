import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryAdapter } from '../examples/adapters/database-memory';
import { buildHelpdesk } from '../src';
import { createAdapter } from '../src/adapters';
import { createWrapsRelay, type WrapsRelayOptions } from './wraps';

const eml = readFileSync(
  new URL('./fixtures/wraps-inbound.eml', import.meta.url)
);
const event = JSON.parse(
  readFileSync(
    new URL('./fixtures/wraps-inbound-event.json', import.meta.url),
    'utf8'
  )
) as { detail: Record<string, unknown> };
const rawS3Key = event.detail.rawS3Key as string;

const INBOUND_URL = 'https://app.harbor.test/api/helpdesk/inbound/';
const KEY = 'wraps-inbound-key';

/** The statuses EventBridge retries, per https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html */
const retried = (status: number) =>
  [401, 407, 409, 429].includes(status) || (status >= 500 && status <= 599);

function eventRequest(body: unknown = event, key: string | null = KEY) {
  return new Request('https://relay.harbor.test/', {
    method: 'POST',
    headers: {
      ...(key === null ? {} : { 'x-wraps-inbound-key': key }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function relayWith(overrides: Partial<WrapsRelayOptions> = {}) {
  const getRaw = vi.fn(async () => new Uint8Array(eml));
  const deliver = vi.fn(async () => new Response(null, { status: 202 }));
  const relay = createWrapsRelay({
    inboundKey: KEY,
    getRaw,
    deliver,
    inboundUrl: INBOUND_URL,
    inboundSecret: 'inbound-secret',
    ...overrides,
  });
  return { relay, getRaw, deliver };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Wraps relay', () => {
  it('delivers the stored MIME byte for byte as message/rfc822 with the bearer secret', async () => {
    const { relay, getRaw, deliver } = relayWith();

    const response = await relay(eventRequest());

    expect(response.status).toBe(200);
    expect(getRaw).toHaveBeenCalledWith(rawS3Key);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [sent] = deliver.mock.calls[0] as unknown as [Request];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(INBOUND_URL);
    expect(sent.headers.get('authorization')).toBe('Bearer inbound-secret');
    expect(sent.headers.get('content-type')).toBe('message/rfc822');
    // Latin-1 bytes survive: a UTF-8 decode would turn ü into two other bytes.
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(
      new Uint8Array(eml)
    );
  });

  it('accepts a bare detail as well as the full EventBridge envelope', async () => {
    const { relay, getRaw } = relayWith();

    const response = await relay(eventRequest(event.detail));

    expect(response.status).toBe(200);
    expect(getRaw).toHaveBeenCalledWith(rawS3Key);
  });

  it('refuses a wrong key with 403, which EventBridge does not retry', async () => {
    const { relay, getRaw, deliver } = relayWith();

    const response = await relay(eventRequest(event, 'guess'));

    expect(response.status).toBe(403);
    expect(retried(response.status)).toBe(false);
    expect(getRaw).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses a missing key with 403 too', async () => {
    const { relay, deliver } = relayWith();

    const response = await relay(eventRequest(event, null));

    expect(response.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses every request when the configured key is empty', async () => {
    const { relay, deliver } = relayWith({ inboundKey: '' });

    const response = await relay(eventRequest(event, ''));

    expect(response.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('answers 404 when the raw object is gone, which EventBridge does not retry', async () => {
    const { relay, deliver } = relayWith({ getRaw: async () => null });

    const response = await relay(eventRequest());

    expect(response.status).toBe(404);
    expect(retried(response.status)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('answers 502 when reading S3 fails, so the event is retried', async () => {
    const { relay, deliver } = relayWith({
      getRaw: async () => {
        throw new Error('ServiceUnavailable');
      },
    });

    const response = await relay(eventRequest());

    expect(response.status).toBe(502);
    expect(retried(response.status)).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON or has no rawS3Key', async () => {
    const { relay, getRaw } = relayWith();
    const garbled = new Request('https://relay.harbor.test/', {
      method: 'POST',
      headers: { 'x-wraps-inbound-key': KEY },
      body: 'not json',
    });

    const notJson = await relay(garbled);
    const noKey = await relay(eventRequest({ detail: { emailId: 'x' } }));

    expect(notJson.status).toBe(400);
    expect(noKey.status).toBe(400);
    expect(getRaw).not.toHaveBeenCalled();
  });

  it('answers 405 for anything but POST', async () => {
    const { relay } = relayWith();

    const response = await relay(
      new Request('https://relay.harbor.test/', {
        method: 'GET',
        headers: { 'x-wraps-inbound-key': KEY },
      })
    );

    expect(response.status).toBe(405);
  });

  it('answers 422 when the helpdesk refuses the message for good', async () => {
    for (const status of [400, 413]) {
      const { relay } = relayWith({
        deliver: async () => new Response(null, { status }),
      });

      const response = await relay(eventRequest());

      expect(response.status).toBe(422);
      expect(retried(response.status)).toBe(false);
    }
  });

  it('answers 502 when the helpdesk is down or misconfigured, so the event is retried', async () => {
    for (const status of [401, 404, 503]) {
      const { relay } = relayWith({
        deliver: async () => new Response(null, { status }),
      });

      const response = await relay(eventRequest());

      expect(response.status).toBe(502);
      expect(retried(response.status)).toBe(true);
    }
  });

  it('answers 502 on a network error, so the event is retried', async () => {
    const { relay } = relayWith({
      deliver: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const response = await relay(eventRequest());

    expect(response.status).toBe(502);
    expect(retried(response.status)).toBe(true);
  });

  it('answers 504 when the helpdesk is slower than the budget, so the event is retried', async () => {
    const { relay } = relayWith({
      timeoutMs: 10,
      deliver: () => new Promise<Response>(() => {}),
    });

    const response = await relay(eventRequest());

    expect(response.status).toBe(504);
    expect(retried(response.status)).toBe(true);
  });

  it('refuses to build without the helpdesk URL or secret', () => {
    expect(() =>
      createWrapsRelay({
        inboundKey: KEY,
        getRaw: async () => null,
        deliver: async () => new Response(null, { status: 202 }),
        inboundUrl: '',
        inboundSecret: 'inbound-secret',
      })
    ).toThrow('inboundUrl');
  });
});

describe('Wraps relay into a real helpdesk', () => {
  function helpdesk() {
    const db = createAdapter(memoryAdapter());
    const support = buildHelpdesk({
      db,
      referencePrefix: 'HD',
      adminUrl: 'https://app.harbor.test/helpdesk/',
      inboxes: { support: { reminderAfterHours: 1 } },
      identify: async () => null,
      email: { send: async () => {} },
      inboundWebhookSecret: 'inbound-secret',
      // No DNS: the signature check fails fast instead of looking things up.
      dnsResolver: async () => {
        throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
      },
      replyToAddress: ref => `support+${ref}@inbound.harbor.test`,
    });
    return { db, support };
  }

  it('turns the same event delivered twice into one conversation and one message', async () => {
    const { db, support } = helpdesk();
    const { relay } = relayWith({
      deliver: request => support.handler(request),
    });

    const first = await relay(eventRequest());
    const second = await relay(eventRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await db.count('conversation')).toBe(1);
    expect(await db.count('message')).toBe(1);
  });
});
