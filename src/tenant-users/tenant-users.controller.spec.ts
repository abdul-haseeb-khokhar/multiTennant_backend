import { Test, TestingModule } from '@nestjs/testing';
import { TenantUsersController } from './tenant-users.controller';
import { TenantUsersService } from './tenant-users.service';

describe('TenantUsersController', () => {
  let controller: TenantUsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantUsersController],
      providers: [TenantUsersService],
    }).compile();

    controller = module.get<TenantUsersController>(TenantUsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
