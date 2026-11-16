import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppService } from './app.service';
import { PrismaService } from './database/prisma.service';

describe('AppService', () => {
  let service: AppService;
  const prisma = { $queryRaw: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [AppService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AppService);
  });

  it('reports liveness without touching the database', () => {
    expect(service.getHealth()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports readiness when the database answers', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const readiness = await service.getReadiness();

    expect(readiness.status).toBe('ok');
    expect(readiness.database.status).toBe('up');
    expect(readiness.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers 503 with a database code when the connection is refused', async () => {
    prisma.$queryRaw.mockRejectedValue(
      new Error('Authentication failed against database server at `localhost`.'),
    );

    const error = await service.getReadiness().catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      details: { database: 'down' },
    });
    // The driver message belongs in the log, not the payload.
    expect(JSON.stringify(error.getResponse())).not.toContain('Authentication failed');
  });

  it('gives up instead of hanging when the database never answers', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));

    const pending = service.getReadiness().catch((thrown) => thrown);
    await jest.advanceTimersByTimeAsync(3000);

    expect(await pending).toBeInstanceOf(ServiceUnavailableException);
    jest.useRealTimers();
  });
});
