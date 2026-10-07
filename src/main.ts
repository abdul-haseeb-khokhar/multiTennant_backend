import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { JsonLogger } from './common/logging/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new JsonLogger());
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService).get<number>('PORT', 3000));
}
void bootstrap();
