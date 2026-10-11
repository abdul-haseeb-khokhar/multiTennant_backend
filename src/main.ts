import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { JsonLogger } from './common/logging/json-logger';

async function bootstrap() {
  // rawBody: the engine's event deliveries are verified over the exact bytes it signed.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(new JsonLogger());
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService).get<number>('PORT', 3000));
}
void bootstrap();
