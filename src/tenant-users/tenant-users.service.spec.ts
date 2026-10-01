import { Test, TestingModule } from '@nestjs/testing';
import { TenantUsersService } from './tenant-users.service';

describe('TenantUsersService', () => {
  let service: TenantUsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantUsersService],
    }).compile();

    service = module.get<TenantUsersService>(TenantUsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
