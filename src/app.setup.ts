import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { requestContextMiddleware } from './common/request-context/request-context.middleware';

export const API_PREFIX = 'v1';

/**
 * Everything the HTTP layer needs beyond the modules. Shared by `main.ts` and the e2e tests so
 * the tests exercise the same prefix, pipes, filter and CORS rules as production.
 */
export function configureApp(app: INestApplication) {
  app.use(requestContextMiddleware);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    // Without FRONTEND_URL no browser origin is allowed ("origin: undefined" would mean "*").
    origin: app.get(ConfigService).get<string>('FRONTEND_URL') ?? false,
    exposedHeaders: ['X-Request-Id'],
  });
}

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Multi-tenant support platform: backend core')
    .setDescription(
      'Tenants, staff authentication and roles, end customers. Errors always have the shape ' +
        '`{ statusCode, code, message }`; lists are `{ data, total, skip, take }`.',
    )
    .setVersion('0.1')
    .addBearerAuth()
    .build();
}

/** OpenAPI document at `/docs` (UI) and `/docs-json` (for the frontend's client generator). */
export function setupSwagger(app: INestApplication) {
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, buildOpenApiConfig()),
    { jsonDocumentUrl: 'docs-json' },
  );
}
