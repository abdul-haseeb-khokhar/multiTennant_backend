import { Test, TestingModule } from '@nestjs/testing';
import { EndCustomersController } from './end-customers.controller';
import { EndCustomersService } from './end-customers.service';

describe('EndCustomersController', () => {
  let controller: EndCustomersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EndCustomersController],
      providers: [EndCustomersService],
    }).compile();

    controller = module.get<EndCustomersController>(EndCustomersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
