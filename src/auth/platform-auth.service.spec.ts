import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuthService } from './platform-auth.service';

describe('PlatformAuthService', () => {
  let service: PlatformAuthService;
  let prisma: PrismaMock;
  let jwt: { sign: jest.Mock };
  let passwordHash: string;

  beforeAll(() => {
    passwordHash = bcrypt.hashSync('password123', 4);
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    jwt = { sign: jest.fn().mockReturnValue('platform.jwt') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback: string) => fallback },
        },
      ],
    }).compile();
    service = module.get(PlatformAuthService);
  });

  it('signs a token with scope "platform", no tenant, and a short lifetime', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue({
      id: 'admin-1',
      passwordHash,
    });
    await expect(
      service.login({ email: 'ops@example.com', password: 'password123' }),
    ).resolves.toEqual({ access_token: 'platform.jwt' });
    expect(jwt.sign).toHaveBeenCalledWith(
      { sub: 'admin-1', scope: 'platform' },
      { expiresIn: '1h' },
    );
  });

  it('rejects a wrong password and an unknown email identically', async () => {
    prisma.platformAdmin.findUnique.mockResolvedValue({
      id: 'admin-1',
      passwordHash,
    });
    await expect(
      service.login({ email: 'ops@example.com', password: 'wrong-pass' }),
    ).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_CREDENTIALS' },
    });

    prisma.platformAdmin.findUnique.mockResolvedValue(null);
    await expect(
      service.login({ email: 'who@example.com', password: 'password123' }),
    ).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_CREDENTIALS' },
    });
    expect(jwt.sign).not.toHaveBeenCalled();
  });
});
