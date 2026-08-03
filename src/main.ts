import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

import { DataSource } from 'typeorm';
import { seedDatabase } from './scripts/seed-super-admin';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const frontendOrigins = process.env.FRONTEND_URL?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // transformOptions
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('User API Site')
    .setDescription('API documentation for User, Auth, Site modules')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  app.enableCors({
    origin: frontendOrigins,
    credentials: true,
  });

  const dataSource = app.get(DataSource);
  await seedDatabase(dataSource);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
