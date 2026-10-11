import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ConversationsService } from '../conversations/conversations.service';
import { EndCustomersController } from './end-customers.controller';
import { EndCustomersService } from './end-customers.service';

describe('EndCustomersController', () => {
  let controller: EndCustomersController;
  let service: Record<
    'create' | 'findAll' | 'findOne' | 'update' | 'remove',
    jest.Mock
  >;

  let conversations: { listForCustomer: jest.Mock };

  beforeEach(async () => {
    conversations = { listForCustomer: jest.fn() };
    service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EndCustomersController],
      providers: [
        { provide: EndCustomersService, useValue: service },
        { provide: ConversationsService, useValue: conversations },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(EndCustomersController);
  });

  it('always passes the tenantId from the URL as the first argument', () => {
    void controller.create('tenant-a', { externalId: 'x' });
    void controller.findAll('tenant-a', {});
    void controller.findOne('tenant-a', 'c1');
    void controller.update('tenant-a', 'c1', { name: 'n' });
    void controller.remove('tenant-a', 'c1');

    expect(service.create).toHaveBeenCalledWith('tenant-a', {
      externalId: 'x',
    });
    expect(service.findAll).toHaveBeenCalledWith('tenant-a', {});
    expect(service.findOne).toHaveBeenCalledWith('tenant-a', 'c1');
    expect(service.update).toHaveBeenCalledWith('tenant-a', 'c1', {
      name: 'n',
    });
    expect(service.remove).toHaveBeenCalledWith('tenant-a', 'c1');
  });

  it('the customer view asks for the conversations with the token user, never a tenant from the URL', () => {
    const user = {
      userId: 'u1',
      tenantId: 'tenant-a',
      role: 'agent' as const,
      emailVerified: true,
    };
    void controller.conversationsOf(user, 'c1', { skip: 1 });
    expect(conversations.listForCustomer).toHaveBeenCalledWith(user, 'c1', {
      skip: 1,
    });
  });
});
