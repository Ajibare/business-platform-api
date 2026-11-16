import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validationException } from './common/validation/validation-exception';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());
  // Invalid input is rejected before it reaches a service, and the client gets
  // one message per field instead of class-validator's raw text.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: validationException }),
  );

  // Credentials are required so the HttpOnly refresh cookie travels between the
  // web app and the API. Origins come from configuration, never from the request.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(process.env.PORT ?? 3001);
}

bootstrap().catch((error: NodeJS.ErrnoException) => {
  const port = process.env.PORT ?? 3001;
  if (error?.code === 'EADDRINUSE') {
    // The default stack trace does not say what to do about it.
    console.error(
      `Port ${port} is already in use. Stop the process listening on it, or set PORT to a free port and point NEXT_PUBLIC_API_URL at it (the web app runs on 3000 by default).`,
    );
  } else {
    console.error('The API failed to start.', error);
  }
  process.exit(1);
});
