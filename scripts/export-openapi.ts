/**
 * Writes the OpenAPI document to docs/openapi.json without needing a database, so the frontend can
 * generate a client or a mock server from the file. Re-run it whenever a route or DTO changes:
 *
 *   npm run openapi:export
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Throwaway values (set before the app modules load: they validate the environment on import): the app is only built to read route metadata, nothing connects.
process.env.JWT_SECRET ??= 'openapi-export-secret-not-used';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';

async function main() {
  const { Test } = require('@nestjs/testing');
  const { SwaggerModule } = require('@nestjs/swagger');
  const { AppModule } = require('../src/app.module');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { buildOpenApiConfig, configureApp } = require('../src/app.setup');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  const target = join(__dirname, '..', 'docs', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`Wrote ${target}`);
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
