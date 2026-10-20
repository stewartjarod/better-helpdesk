/**
 * Relay for Wraps inbound email. Wraps' EventBridge rule POSTs each
 * `email.received` event to this relay as JSON with an `X-Wraps-Inbound-Key`
 * header. The relay reads `rawS3Key` from the event, fetches the raw MIME the
 * Wraps Lambda stored in S3 and delivers it, unmodified, to the helpdesk's
 * `/inbound/` route. It is a plain `Request -> Response` function, so the
 * caller supplies the two I/O edges: `getRaw` (the S3 read) and `deliver`
 * (a fetch to the helpdesk, or `helpdesk.handler` in-process). No AWS SDK
 * is imported here.
 *
 * EventBridge retries 401, 407, 409, 429 and 5xx responses and drops the
 * rest, so every outcome below picks its status for that rule. See README.
 */
export interface WrapsRelayOptions {
  /** Expected `X-Wraps-Inbound-Key`. An empty key rejects every request. */
  inboundKey: string;
  /** The raw MIME at `rawS3Key`, or `null` when the object is gone. */
  getRaw(rawS3Key: string): Promise<Uint8Array | Buffer | null>;
  /** Delivers the request to the helpdesk and resolves with its response. */
  deliver(request: Request): Promise<Response>;
  /** The helpdesk's `{basePath}/inbound/` URL. */
  inboundUrl: string;
  /** The host's `inboundWebhookSecret`, sent as the bearer token. */
  inboundSecret: string;
  /**
   * How long `deliver` may take before the relay gives up and answers 504,
   * which EventBridge retries. Default 4,000 ms: EventBridge cancels an API
   * destination call after 5 seconds.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

export function createWrapsRelay(
  opts: WrapsRelayOptions
): (request: Request) => Promise<Response> {
  if (!opts.inboundUrl || !opts.inboundSecret) {
    throw new Error('createWrapsRelay needs inboundUrl and inboundSecret');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function relay(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    // 403, not 401: EventBridge retries 401 for 24 hours.
    const given = request.headers.get('x-wraps-inbound-key') ?? '';
    if (!(await keyMatches(given, opts.inboundKey))) {
      return new Response(null, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('Not JSON', { status: 400 });
    }
    const rawS3Key = rawS3KeyOf(body);
    if (!rawS3Key) {
      return new Response('No rawS3Key in the event', { status: 400 });
    }

    let raw: Uint8Array | Buffer | null;
    try {
      raw = await opts.getRaw(rawS3Key);
    } catch {
      return new Response('Could not read the raw message', { status: 502 });
    }
    // The Lambda writes the object before it sends the event, so a missing
    // one means it expired or was deleted: retrying cannot bring it back.
    if (raw === null) {
      return new Response('The raw message is gone', { status: 404 });
    }

    const message = new Request(opts.inboundUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.inboundSecret}`,
        'content-type': 'message/rfc822',
      },
      // A copy: Buffer is not a BodyInit for TypeScript, and the bytes are the same.
      body: new Uint8Array(raw),
    });

    let response: Response;
    try {
      response = await within(opts.deliver(message), timeoutMs);
    } catch (error) {
      if (error === TIMED_OUT) {
        return new Response('Helpdesk did not answer in time', { status: 504 });
      }
      return new Response('Helpdesk unreachable', { status: 502 });
    }
    if (response.ok) return new Response(null, { status: 200 });
    // The helpdesk refuses these for good: a 422 stops the retries.
    if (response.status === 400 || response.status === 413) {
      return new Response(`Helpdesk refused the message (${response.status})`, {
        status: 422,
      });
    }
    // Anything else, including 401 from a wrong secret, is recoverable
    // once the configuration is fixed, so EventBridge retries it.
    return new Response(`Helpdesk unavailable (${response.status})`, {
      status: 502,
    });
  };
}

/** The S3 key from the event: EventBridge's envelope or its bare `detail`. */
function rawS3KeyOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const detail = (body as { detail?: unknown }).detail;
  const source = typeof detail === 'object' && detail !== null ? detail : body;
  const key = (source as { rawS3Key?: unknown }).rawS3Key;
  return typeof key === 'string' && key !== '' ? key : undefined;
}

const TIMED_OUT = Symbol('timed out');

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Compares digests byte by byte, so the time taken does not reveal how much
// of the key matched.
async function keyMatches(given: string, expected: string) {
  if (!expected) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
}
