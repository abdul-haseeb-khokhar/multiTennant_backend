import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { NoNullBytesPipe } from './common/validation/no-null-bytes.pipe';
import { requestContextMiddleware } from './common/request-context/request-context.middleware';
import { parseTrustProxy } from './config/trust-proxy';
import { WidgetCorsService, isWidgetPath } from './widget/widget-cors.service';

export const API_PREFIX = 'v1';

/**
 * Everything the HTTP layer needs beyond the modules. Shared by `main.ts` and the e2e tests so
 * the tests exercise the same prefix, pipes, filter and CORS rules as production.
 */
export function configureApp(app: INestApplication) {
  // Behind a reverse proxy `req.ip` must be the real client (audit log, rate limits): see TRUST_PROXY.
  const trustProxy = parseTrustProxy(
    app.get(ConfigService).get<string>('TRUST_PROXY'),
  );
  if (trustProxy !== false) {
    (
      app.getHttpAdapter().getInstance() as {
        set(name: string, value: unknown): void;
      }
    ).set('trust proxy', trustProxy);
  }
  app.use(requestContextMiddleware);
  // The only routes outside /v1: the unversioned health checks, and the service-to-service event
  // receiver the AI engine calls on the private network (not part of the public API).
  app.setGlobalPrefix(API_PREFIX, {
    exclude: ['health', 'health/ready', 'internal/events'],
  });
  app.useGlobalPipes(
    new NoNullBytesPipe(),
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  // D8: two CORS policies. Dashboard routes allow the one FRONTEND_URL origin; the widget routes
  // (/v1/widget/*) allow only origins listed on a widget key, decided per request.
  // Without FRONTEND_URL no browser origin is allowed ("origin: undefined" would mean "*").
  const dashboardOrigin =
    app.get(ConfigService).get<string>('FRONTEND_URL') ?? false;
  const widgetCors = app.get(WidgetCorsService, { strict: false });
  const cors: CorsOptionsDelegate<Request> = (request, callback) => {
    if (isWidgetPath(request.url, API_PREFIX)) {
      widgetCors.optionsFor(request).then(
        (options) => callback(null, options),
        () => callback(null, { origin: false }),
      );
      return;
    }
    callback(null, {
      origin: dashboardOrigin,
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
    });
  };
  app.enableCors(cors);
}

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Multi-tenant support platform: backend core')
    .setDescription(
      'Tenants, staff authentication, invitations and roles, audit log, translations, end customers. Errors always have the shape ' +
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
