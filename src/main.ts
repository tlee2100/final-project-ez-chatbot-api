import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

import { DataSource } from 'typeorm';
import { seedDatabase } from './scripts/seed-super-admin';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security Headers via Helmet
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows cross-origin embedding for chat widget
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false, // Managed at frontend/widget level
    }),
  );

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('User API Site')
    .setDescription('API documentation for User, Auth, Site modules')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);
  const envOrigins = [
    ...(process.env.FRONTEND_URL?.split(',') || []),
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ]
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowedAdminOrigins = Array.from(new Set(envOrigins));

  type StaticOrigin = boolean | string | RegExp | (string | RegExp)[];
  const corsOriginHandler = (
    origin: string | undefined,
    callback: (err: Error | null, origin?: StaticOrigin) => void,
  ): void => {
    // 1. Cho phép requests không có origin (server-to-server, curl, internal MCP)
    if (!origin) {
      callback(null, true);
      return;
    }

    // 2. Cho phép các Admin Dashboard origins được cấu hình
    if (allowedAdminOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    // 3. Cho phép các origin nhúng widget công khai (SEC-002: DomainAllowlistGuard sẽ kiểm tra theo từng site.allowedDomains)
    callback(null, true);
  };

  app.enableCors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-visitor-token',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
  });

  const dataSource = app.get(DataSource);
  await seedDatabase(dataSource);

  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
