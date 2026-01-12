import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = app.get(ConfigService);
  const origin = config.get<string>('CORS_ORIGIN') ?? '*';
  app.enableCors({ origin });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
