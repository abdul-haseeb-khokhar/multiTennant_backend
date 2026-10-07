import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp, setupSwagger } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaMock } from './prisma-mock';

/**
 * Boots the real `AppModule` with the same prefix, pipes, filter and CORS as production, but with
 * Prisma replaced by mocks, so the HTTP layer (guards, roles, error shapes, envelopes) is tested
 * without a database. See test/README.md.
 */
export async function createTestApp() {
  const prisma = createPrismaMock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  configureApp(app);
  setupSwagger(app);
  await app.init();

  const jwt = app.get(JwtService);
  return {
    app,
    prisma,
    /** A staff token, as `AuthService.login` would issue it. */
    staffToken: (user: { userId: string; tenantId: string; role: string }) =>
      jwt.sign({
        sub: user.userId,
        tenantId: user.tenantId,
        role: user.role,
        scope: 'tenant',
      }),
    /** A platform-admin token. */
    platformToken: (adminId = 'admin-1') =>
      jwt.sign({ sub: adminId, scope: 'platform' }),
  };
}
