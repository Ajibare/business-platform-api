import { Test } from '@nestjs/testing';
import { AppService } from './app.service';

describe('AppService', () => {
  let service: AppService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AppService],
    }).compile();
    service = moduleRef.get(AppService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
