import { Test, TestingModule } from '@nestjs/testing';
import { EndCustomersService } from './end-customers.service';

describe('EndCustomersService', () => {
  let service: EndCustomersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EndCustomersService],
    }).compile();

    service = module.get<EndCustomersService>(EndCustomersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
