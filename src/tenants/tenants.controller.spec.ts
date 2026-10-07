import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { PlatformJwtAuthGuard } from '../auth/platform-jwt-auth.guard';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

describe('TenantsController', () => {
  let controller: TenantsController;
  let service: Record<'findAll' | 'findOne' | 'update' | 'remove', jest.Mock>;

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [{ provide: TenantsService, useValue: service }],
    })
      .overrideGuard(PlatformJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(TenantsController);
  });

  it('is protected by the platform-admin guard and lives under admin/tenants', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TenantsController)).toContain(
      PlatformJwtAuthGuard,
    );
    expect(Reflect.getMetadata('path', TenantsController)).toBe(
      'admin/tenants',
    );
  });

  it('delegates to the service', () => {
    void controller.findAll({ skip: 0, take: 5 });
    void controller.findOne('t1');
    void controller.update('t1', { status: 'suspended' });
    void controller.remove('t1');

    expect(service.findAll).toHaveBeenCalledWith({ skip: 0, take: 5 });
    expect(service.findOne).toHaveBeenCalledWith('t1');
    expect(service.update).toHaveBeenCalledWith('t1', { status: 'suspended' });
    expect(service.remove).toHaveBeenCalledWith('t1');
  });
});
