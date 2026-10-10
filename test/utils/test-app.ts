import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp, setupSwagger } from '../../src/app.setup';
import { Clock, FakeClock } from '../../src/billing/clock';
import { EngineClient } from '../../src/engine/engine-client';
import { MockEngineClient } from '../../src/engine/mock-engine.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_WIDGET_LIMITS,
  WIDGET_LIMITS,
  WidgetLimits,
} from '../../src/widget/widget.constants';
import { createPrismaMock } from './prisma-mock';

export interface StaffTokenUser {
  userId: string;
  tenantId: string;
  role: string;
}

/** What the database says about a staff user, beyond what the token carries. */
export interface StaffRecord {
  role?: string;
  status?: string;
  emailVerified?: boolean;
  passwordChangedAt?: Date | null;
}

/**
 * Boots the real `AppModule` with the same prefix, pipes, filter and CORS as production, but with
 * Prisma replaced by mocks, so the HTTP layer (guards, roles, error shapes, envelopes) is tested
 * without a database. See test/README.md.
 */
export async function createTestApp(
  options: { widgetLimits?: Partial<WidgetLimits> } = {},
) {
  const prisma = createPrismaMock();
  // Billing reads time from the injected Clock; tests move it instead of waiting.
  const clock = new FakeClock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(Clock)
    .useValue(clock)
    // Small numbers let a test reach a rate limit in a few calls.
    .overrideProvider(WIDGET_LIMITS)
    .useValue({ ...DEFAULT_WIDGET_LIMITS, ...options.widgetLimits })
    .compile();

  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  configureApp(app);
  setupSwagger(app);
  await app.init();

  const jwt = app.get(JwtService);
  // ENGINE_MODE defaults to the in-process mock in tests; tests drive and inspect it directly.
  const engine = app.get(EngineClient) as MockEngineClient;

  // The staff directory: JwtStrategy re-checks every token against the database (H2), so tests
  // describe the users that "exist". `staffToken` registers its user as an active, verified one.
  const directory = new Map<string, StaffRecord & StaffTokenUser>();
  const staffToken = (
    user: StaffTokenUser,
    record: StaffRecord = {},
    issuedAt?: number,
  ) => {
    directory.set(user.userId, { ...user, ...record });
    return jwt.sign({
      sub: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      scope: 'tenant',
      ...(issuedAt !== undefined && { iat: issuedAt }),
    });
  };

  return {
    app,
    prisma,
    clock,
    engine,
    jwt,
    /** A staff token, as `AuthService.login` would issue it. */
    staffToken,
    /**
     * Installs the `tenantUser.findUnique` stub that answers JwtStrategy from the directory. Call
     * it in `beforeEach` after `jest.resetAllMocks()`.
     */
    allowStaff: () => {
      prisma.tenantUser.findUnique.mockImplementation(
        ({ where }: { where: { id: string; tenantId?: string } }) => {
          const user = directory.get(where.id);
          if (!user || (where.tenantId && user.tenantId !== where.tenantId)) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            role: user.role,
            status: user.status ?? 'active',
            emailVerifiedAt:
              user.emailVerified === false ? null : new Date('2026-01-01'),
            passwordChangedAt: user.passwordChangedAt ?? null,
          });
        },
      );
    },
    /** A platform-admin token. */
    platformToken: (adminId = 'admin-1') =>
      jwt.sign({ sub: adminId, scope: 'platform' }),
  };
}
