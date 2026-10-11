import type { Response } from 'express';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { RateLimiter } from '../common/throttle/rate-limiter';
import {
  WidgetCorsService,
  applyWidgetCors,
  isWidgetPath,
} from './widget-cors.service';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { DEFAULT_WIDGET_LIMITS } from './widget.constants';

const preflight = (origin: string | undefined, ip = '1.1.1.1') => ({
  method: 'OPTIONS',
  headers: {
    origin,
    'access-control-request-method': 'POST',
  },
  ip,
});

describe('isWidgetPath', () => {
  it.each([
    ['/v1/widget', true],
    ['/v1/widget/sessions', true],
    ['/v1/widget/messages?x=1', true],
    ['/v1/widgets', false],
    ['/v1/widget-admin', false],
    ['/v1/tenants/t/api-keys', false],
    ['/v2/widget/sessions', false],
    [undefined, false],
  ])('%s -> %s', (url, expected) => {
    expect(isWidgetPath(url, 'v1')).toBe(expected);
  });
});

describe('WidgetCorsService (D8)', () => {
  let prisma: PrismaMock;
  let service: WidgetCorsService;

  const make = (preflightPerIp = 100) => {
    prisma = createPrismaMock();
    prisma.apiKey.findFirst.mockResolvedValue(null);
    return new WidgetCorsService(
      prisma as never,
      new WidgetRateLimitService(new RateLimiter(), {
        ...DEFAULT_WIDGET_LIMITS,
        preflightPerIp,
      }),
    );
  };

  beforeEach(() => {
    service = make();
  });

  it('answers a preflight only for an origin some active widget key lists, echoing exactly that origin', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
    const options = await service.optionsFor(
      preflight('https://Shop.example.com') as never,
    );
    expect(options).toMatchObject({
      origin: 'https://shop.example.com',
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
    });
    expect(options.origin).not.toBe('*');
    expect(options.origin).not.toBe(true);
    expect(options.allowedHeaders).toEqual(
      expect.arrayContaining([
        'Authorization',
        'Idempotency-Key',
        'Last-Event-ID',
      ]),
    );
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: {
        type: 'widget',
        revokedAt: null,
        allowedOrigins: { has: 'https://shop.example.com' },
      },
      select: { id: true },
    });
  });

  it('refuses an origin no key lists, a missing or malformed origin, and a wildcard', async () => {
    for (const origin of [
      'https://evil.example.com',
      undefined,
      'null',
      '*',
      'https://*.example.com',
    ]) {
      const options = await service.optionsFor(preflight(origin) as never);
      expect(options).toEqual({ origin: false });
    }
  });

  it('adds nothing to a real (non-preflight) request: the gateway does that after the key check', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
    const options = await service.optionsFor({
      method: 'POST',
      headers: { origin: 'https://shop.example.com' },
    } as never);
    expect(options).toEqual({ origin: false });
    expect(prisma.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it('caches the answer briefly so a flood of preflights does not hit the database each time', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
    for (let i = 0; i < 5; i++) {
      await service.optionsFor(preflight('https://shop.example.com') as never);
    }
    expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1);
  });

  it('stops answering preflights from an IP that floods them', async () => {
    service = make(2);
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
    const ask = () =>
      service.optionsFor(preflight('https://shop.example.com') as never);
    expect((await ask()).origin).toBe('https://shop.example.com');
    expect((await ask()).origin).toBe('https://shop.example.com');
    expect(await ask()).toEqual({ origin: false });
  });

  it('applyWidgetCors echoes the origin, varies on it and never allows credentials', () => {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => (headers[name] = value),
      vary: jest.fn(),
    } as unknown as Response;
    applyWidgetCors(response, 'https://shop.example.com');
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://shop.example.com',
    );
    expect(headers['Access-Control-Expose-Headers']).toContain('Retry-After');
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(response.vary).toHaveBeenCalledWith('Origin');
  });
});
