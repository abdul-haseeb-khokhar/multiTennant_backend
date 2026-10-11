import { ExecutionContext } from '@nestjs/common';
import { FakeClock } from '../billing/clock';
import { EngineEventsAuthGuard } from './engine-events-auth.guard';
import {
  SIGNATURE_TOLERANCE_SECONDS,
  checkEngineSignature,
  signEngineEvent,
} from './engine-event-signature';

const SECRET = 's'.repeat(40);
const NOW = Date.parse('2026-10-10T10:00:00.000Z');
const ts = (offsetSeconds = 0) =>
  String(Math.floor(NOW / 1000) + offsetSeconds);
const body = Buffer.from('{"id":"e1","type":"conversation.escalated"}');

describe('checkEngineSignature', () => {
  const headers = (timestamp = ts(), raw: Buffer | string = body) => ({
    timestamp,
    signature: signEngineEvent(SECRET, timestamp, raw),
  });

  it('accepts a request signed over the exact bytes with the shared secret', () => {
    expect(checkEngineSignature(SECRET, headers(), body, NOW)).toBe('ok');
  });

  it('signs "<timestamp>.<body>" with HMAC-SHA256 as documented', () => {
    expect(headers().signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signEngineEvent(SECRET, '1', 'x')).toBe(
      signEngineEvent(SECRET, '1', Buffer.from('x')),
    );
    expect(signEngineEvent(SECRET, '1', 'x')).not.toBe(
      signEngineEvent(SECRET, '2', 'x'),
    );
  });

  it('rejects a changed body, a wrong secret, a different timestamp and a mangled signature', () => {
    expect(
      checkEngineSignature(SECRET, headers(), Buffer.from('{"id":"e2"}'), NOW),
    ).toBe('invalid');
    expect(checkEngineSignature('x'.repeat(40), headers(), body, NOW)).toBe(
      'invalid',
    );
    const h = headers();
    expect(
      checkEngineSignature(SECRET, { ...h, timestamp: ts(5) }, body, NOW),
    ).toBe('invalid');
    expect(
      checkEngineSignature(SECRET, { ...h, signature: 'sha256=00' }, body, NOW),
    ).toBe('invalid');
    expect(
      checkEngineSignature(
        SECRET,
        { ...h, signature: h.signature.toUpperCase() },
        body,
        NOW,
      ),
    ).toBe('invalid');
  });

  it('rejects a request outside the 5 minute window in either direction', () => {
    const tolerance = SIGNATURE_TOLERANCE_SECONDS;
    expect(
      checkEngineSignature(SECRET, headers(ts(-tolerance - 1)), body, NOW),
    ).toBe('stale');
    expect(
      checkEngineSignature(SECRET, headers(ts(tolerance + 1)), body, NOW),
    ).toBe('stale');
    expect(
      checkEngineSignature(SECRET, headers(ts(-tolerance)), body, NOW),
    ).toBe('ok');
  });

  it('reports missing parts, and refuses a timestamp that is not plain digits', () => {
    expect(checkEngineSignature(SECRET, {}, body, NOW)).toBe('missing');
    expect(checkEngineSignature(SECRET, headers(), undefined, NOW)).toBe(
      'missing',
    );
    expect(checkEngineSignature(SECRET, { timestamp: ts() }, body, NOW)).toBe(
      'missing',
    );
    for (const bad of ['1e9', '-5', '0x10', '12 ', 'abc', '1'.repeat(13)]) {
      expect(
        checkEngineSignature(
          SECRET,
          { timestamp: bad, signature: signEngineEvent(SECRET, bad, body) },
          body,
          NOW,
        ),
      ).toBe('invalid');
    }
  });
});

describe('EngineEventsAuthGuard', () => {
  const clock = new FakeClock(new Date(NOW));
  const context = (request: object) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;
  const guardWith = (secret: string | undefined) =>
    new EngineEventsAuthGuard({ get: () => secret } as never, clock);
  const signed = (secret = SECRET, rawBody = body) => ({
    headers: {
      'x-engine-timestamp': ts(),
      'x-engine-signature': signEngineEvent(secret, ts(), rawBody),
    },
    rawBody,
  });

  it('lets a correctly signed delivery through', () => {
    expect(guardWith(SECRET).canActivate(context(signed()))).toBe(true);
  });

  it('answers every failure with the same 401, whatever was wrong', () => {
    const wrongSecret = signed('z'.repeat(40));
    const noHeaders = { headers: {}, rawBody: body };
    const noBody = { headers: signed().headers };
    const stale = {
      headers: {
        'x-engine-timestamp': ts(-3600),
        'x-engine-signature': signEngineEvent(SECRET, ts(-3600), body),
      },
      rawBody: body,
    };
    const messages = new Set<string>();
    for (const request of [wrongSecret, noHeaders, noBody, stale]) {
      try {
        guardWith(SECRET).canActivate(context(request));
        throw new Error('should have refused');
      } catch (error) {
        expect(error).toMatchObject({
          status: 401,
          response: { code: 'UNAUTHORIZED' },
        });
        messages.add(
          (error as { response: { message: string } }).response.message,
        );
      }
    }
    expect(messages.size).toBe(1);
  });

  it('is switched off (503) when the deployment has no INTERNAL_API_TOKEN', () => {
    expect(() => guardWith(undefined).canActivate(context(signed()))).toThrow(
      expect.objectContaining({ status: 503 }),
    );
  });
});
