import { Test } from '@nestjs/testing';
import { PrismaService } from './database/prisma.service';
import { AppModule } from './app.module';

/**
 * Guards the Nest dependency graph.
 *
 * A service that injects a provider its module does not import fails when the
 * application boots, not when it is compiled, so `nest build` and the unit
 * tests can both stay green while `npm run start:prod` crashes. Resolving the
 * whole module tree here turns that into a test failure.
 */
describe('AppModule', () => {
  it('resolves every provider in the dependency graph', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The database is not needed to resolve the graph.
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
