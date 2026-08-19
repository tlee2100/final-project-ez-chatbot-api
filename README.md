# Chatbot API

Backend API for a multi-user chatbot management system. It is built with NestJS, TypeScript, TypeORM, PostgreSQL, Redis/Bull, JWT authentication, role-based authorization, reCAPTCHA, 2FA, AutoMapper, Socket.IO, Cloudinary document storage, and Swagger/OpenAPI.

## Features

- Email/password login with Google reCAPTCHA validation
- JWT authentication for protected REST APIs and Socket.IO connections
- TOTP-based 2FA setup, confirmation, login verification, and disabling
- Role-based access control for `ADMIN` and `AGENT`
- Admin user management with pagination, filtering, and sorting
- Current-user profile read/update endpoints
- Site creation and paginated site listing
- Site knowledge base status tracking: `pending`, `processing`, `ready`
- Document upload for site knowledge bases, with uploaded files stored on Cloudinary
- PDF/TXT upload validation with a 5 MB file size limit
- Cloudinary storage for uploaded document files; the database stores metadata and Cloudinary references
- Redis/Bull background processing for uploaded documents
- Authenticated Socket.IO chat gateway
- DTO validation with `class-validator` and global `ValidationPipe`
- Password hashing with bcrypt
- Swagger UI for API testing
- TypeORM migrations and super admin seeding script

## Tech Stack

- NestJS
- TypeScript
- PostgreSQL
- TypeORM
- Redis
- Bull
- Socket.IO
- Passport JWT
- bcrypt
- Google reCAPTCHA
- otplib / qrcode
- Cloudinary
- class-validator / class-transformer
- AutoMapper
- Swagger / OpenAPI

## Project Structure

```text
src/
|-- auth/
|   |-- decorators/
|   |-- dto/
|   |-- guards/
|   |-- strategies/
|   |-- types/
|   |-- auth.controller.ts
|   |-- auth.module.ts
|   |-- auth.service.ts
|   `-- recaptcha.service.ts
|-- chat/
|   |-- chat.gateway.ts
|   `-- chat.module.ts
|-- core/
|-- document/
|   |-- entities/
|   |-- enums/
|   |-- types/
|   |-- document-processing.worker.ts
|   |-- document-upload.options.ts
|   |-- document.controller.ts
|   |-- document.module.ts
|   `-- document.service.ts
|-- migrations/
|-- scripts/
|   `-- seed-super-admin.ts
|-- shared/
|-- site/
|   |-- dto/
|   |-- entities/
|   |-- enums/
|   |-- profile/
|   |-- site.controller.ts
|   |-- site.module.ts
|   `-- site.service.ts
|-- user/
|   |-- dto/
|   |-- entities/
|   |-- enums/
|   |-- profiles/
|   |-- user.controller.ts
|   |-- user.module.ts
|   `-- user.service.ts
|-- app.module.ts
|-- data-source.ts
`-- main.ts
```

## Start Server Guide

### 1. Install dependencies

```bash
cd chatbot-api
npm install
```

### 2. Create environment file

```bash
cp .env.example .env
```

Update `.env` with your local values. If you use the provided Docker Compose file, use these database values:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_NAME=chatbot_api_db
```

### 3. Start infrastructure services

The API needs PostgreSQL and Redis. You can start both with Docker:

```bash
docker compose up -d
```

### 4. Run database migrations

```bash
npm run migration:run
```

### 5. Seed the first super admin user

Set these variables in `.env` before running the seed:

```env
SUPER_ADMIN_EMAIL=superadmin@example.com
SUPER_ADMIN_PASSWORD=superAdminPassword123
SUPER_ADMIN_NAME=Super Administrator
```

Then run:

```bash
npm run seed:super-admin
```

### 6. Configure Cloudinary for document upload

Document upload is integrated with Cloudinary. When an admin uploads a PDF/TXT file, the API keeps the file in memory only long enough to stream it to Cloudinary. The physical file is stored on Cloudinary as a raw asset under the `documents` folder; the API does not save the uploaded file to the local server disk.

After Cloudinary accepts the upload, the API saves the document metadata in PostgreSQL. The `documents.filePath` column stores Cloudinary's `secure_url`, and `documents.cloudinaryPublicId` stores the Cloudinary asset id used for cleanup. A Redis/Bull processing job is then queued for the uploaded document.

Create or use an existing Cloudinary account, then copy these values from the Cloudinary dashboard into `.env`:

```env
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

The document upload endpoint will return a server error if these variables are missing.

### 7. Start the API server

Development mode:

```bash
npm run start:dev
```

Production mode:

```bash
npm run build
npm run start:prod
```

If `PORT` is not set, the API runs at:

```text
http://localhost:3000
```

Swagger UI:

```text
http://localhost:3000/api
```

## Environment Variables

```env
PORT=3000
FRONTEND_URL=http://localhost:3001,http://localhost:5173

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_NAME=chatbot_api_db

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=1h

RECAPTCHA_SECRET_KEY=your_recaptcha_secret_key

CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret

SUPER_ADMIN_EMAIL=superadmin@example.com
SUPER_ADMIN_PASSWORD=superAdminPassword123
SUPER_ADMIN_NAME=Super Administrator
```

Notes:

- `FRONTEND_URL` is used by CORS for REST APIs and Socket.IO. Add each landing page origin, separated by commas.
- `RECAPTCHA_SECRET_KEY` is required for login.
- `JWT_SECRET` is required for API authentication and websocket authentication.
- Cloudinary variables are required for document upload. Uploaded files are stored in the `documents` folder on Cloudinary with `resource_type: raw`; PostgreSQL stores the Cloudinary URL/public id and document status, not the file bytes.
- Redis is required for the document-processing queue.

## Cloudinary Integration

Cloudinary is used by the document module only. The integration lives in `src/document/document.service.ts`.

Uploaded document files are stored on Cloudinary, not on the API server. Multer uses memory storage, so the incoming file is available as `file.buffer` during the request. `DocumentService` streams that buffer to Cloudinary with `cloudinary.uploader.upload_stream`, then persists only the returned Cloudinary information in the database.

When an admin uploads a document:

1. `DocumentController` accepts a `multipart/form-data` request at `POST /sites/:siteId/documents/upload`.
2. `documentUploadOptions` validates the file in memory. Only `application/pdf` and `text/plain` are accepted, up to 5 MB.
3. `DocumentService` checks that the target site exists.
4. The file buffer is uploaded with `cloudinary.uploader.upload_stream`.
5. Cloudinary stores the actual file under the `documents` folder as a raw asset.
6. PostgreSQL stores the document row: original filename, Cloudinary `secure_url` in `documents.filePath`, Cloudinary `public_id` in `documents.cloudinaryPublicId`, site id, and `pending` status.
7. A Bull job is added to the `document-processing` queue for background processing.
8. If saving metadata or queuing the job fails, the service deletes the uploaded Cloudinary asset to avoid leaving an orphaned file.

Required Cloudinary variables:

| Variable                | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name from the dashboard       |
| `CLOUDINARY_API_KEY`    | Cloudinary API key                             |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret used by server-side code |

Do not expose `CLOUDINARY_API_SECRET` in frontend code.

## Database Migrations

Generate a migration:

```bash
npm run migration:generate -- src/migrations/MigrationName
```

Run pending migrations:

```bash
npm run migration:run
```

Revert the latest migration:

```bash
npm run migration:revert
```

## Core Entities

### User

| Field              | Type               |
| ------------------ | ------------------ |
| `id`               | UUID               |
| `email`            | string             |
| `password`         | string             |
| `name`             | string             |
| `role`             | `ADMIN` or `AGENT` |
| `twoFactorEnabled` | boolean            |
| `twoFactorSecret`  | string or null     |

### Site

| Field                 | Type                                |
| --------------------- | ----------------------------------- |
| `id`                  | UUID                                |
| `name`                | string                              |
| `url`                 | string                              |
| `ownerId`             | UUID                                |
| `knowledgeBaseStatus` | `pending`, `processing`, or `ready` |

### Document

| Field                | Type                                |
| -------------------- | ----------------------------------- |
| `id`                 | UUID                                |
| `filename`           | string                              |
| `filePath`           | string, Cloudinary `secure_url`     |
| `cloudinaryPublicId` | string or null, Cloudinary asset id |
| `status`             | `pending`, `processing`, or `ready` |
| `siteId`             | UUID                                |
| `uploadedAt`         | Date                                |
| `processedAt`        | Date or null                        |

Relationships:

```text
User (1) -------- (*) Site
Site (1) -------- (*) Document
```

## Authentication APIs

### Login

```http
POST /auth/login
```

Request:

```json
{
  "email": "admin@example.com",
  "password": "adminPassword123",
  "recaptchaToken": "recaptcha_token"
}
```

Response when 2FA is not enabled:

```json
{
  "accessToken": "jwt_token"
}
```

Response when 2FA is enabled:

```json
{
  "requires2FA": true,
  "userId": "user_id",
  "message": "2FA required"
}
```

### Setup 2FA

Requires JWT.

```http
POST /auth/setup-2fa
Authorization: Bearer <accessToken>
```

### Confirm 2FA

Requires JWT.

```http
POST /auth/confirm-2fa
Authorization: Bearer <accessToken>
```

Request:

```json
{
  "token": "123456"
}
```

### Disable 2FA

Requires JWT.

```http
POST /auth/disable-2fa
Authorization: Bearer <accessToken>
```

Request:

```json
{
  "token": "123456"
}
```

### Verify 2FA Login

```http
POST /auth/verify-2fa-login
```

Request:

```json
{
  "userId": "user_id",
  "token": "123456"
}
```

## User APIs

Admin-only endpoints require JWT and `ADMIN` role.

| Method   | Path         | Access        | Description                          |
| -------- | ------------ | ------------- | ------------------------------------ |
| `GET`    | `/users`     | `ADMIN`       | List users with pagination/filtering |
| `POST`   | `/users`     | `ADMIN`       | Create user                          |
| `GET`    | `/users/me`  | Authenticated | Get current user                     |
| `PATCH`  | `/users/me`  | Authenticated | Update current user                  |
| `GET`    | `/users/:id` | `ADMIN`       | Get user by ID                       |
| `PATCH`  | `/users/:id` | `ADMIN`       | Update user by ID                    |
| `DELETE` | `/users/:id` | `ADMIN`       | Delete user                          |

Supported `/users` query params:

| Query    | Description                        |
| -------- | ---------------------------------- |
| `page`   | Page number, default `1`           |
| `limit`  | Items per page, default `10`       |
| `name`   | Filter by name                     |
| `email`  | Filter by email                    |
| `role`   | Filter by `ADMIN` or `AGENT`       |
| `sortBy` | Sort by `email`, `name`, or `role` |
| `order`  | `ASC` or `DESC`                    |

## Site APIs

### List Sites

Requires JWT. `ADMIN` users can see all sites. `AGENT` users can see their assigned sites.

```http
GET /sites?page=1&limit=10&search=zodinet&filter.knowledgeBaseStatus=pending
Authorization: Bearer <accessToken>
```

### Create Site

Requires JWT and `ADMIN` role.

```http
POST /sites
Authorization: Bearer <accessToken>
```

Request:

```json
{
  "name": "Zodinet",
  "url": "https://zodinet.com"
}
```

## Document APIs

### Upload Document

Requires JWT and `ADMIN` role.

```http
POST /sites/:siteId/documents/upload
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

Form field:

| Field  | Description          |
| ------ | -------------------- |
| `file` | PDF or TXT, max 5 MB |

Upload flow:

1. The file is validated in memory. It is never written to local disk.
2. The file buffer is uploaded to Cloudinary as a raw asset in the `documents` folder.
3. Cloudinary returns a `secure_url` and `public_id`.
4. A `documents` row is created with `pending` status, the original filename, the Cloudinary URL in `filePath`, and the Cloudinary public id in `cloudinaryPublicId`.
5. A Bull job is queued in Redis.
6. The worker marks the document as `processing`, then `ready`.

## Web Crawler and Sitemap Sync

The crawler implements KB-006, KB-007, and KB-008. It discovers URLs from one
root sitemap per site (including nested sitemap indexes and gzip files), renders
each public page with Chromium, extracts the readable content, and reuses the
existing chunking, embedding, and pgvector pipeline. The configured sitemap,
nested sitemaps, and listed pages may use public hostnames that differ from the
site's primary URL.

Production deployment is feature-flagged. Set `CRAWLER_ENABLED=true` and provide
a Browserless WebSocket URL through `BROWSER_WS_ENDPOINT`. Keep the Browserless
token in deployment secrets; do not commit or log the endpoint. The API opens
one remote browser session per rendered page and closes it after use.

Crawler management endpoints require `ADMIN` or `SUPER_ADMIN` and tenant access
to `siteId`:

| Method | Endpoint                                               | Purpose                          |
| ------ | ------------------------------------------------------ | -------------------------------- |
| `GET`  | `/api/v1/sites/:siteId/kb/crawler`                     | Read config and active run       |
| `PUT`  | `/api/v1/sites/:siteId/kb/crawler`                     | Save sitemap and 7-day auto-sync |
| `POST` | `/api/v1/sites/:siteId/kb/crawl`                       | Start a full sitemap run         |
| `POST` | `/api/v1/sites/:siteId/kb/upload/url`                  | Ingest one public URL            |
| `GET`  | `/api/v1/sites/:siteId/kb/crawls`                      | List run history                 |
| `GET`  | `/api/v1/sites/:siteId/kb/crawls/:runId`               | Read progress and counters       |
| `GET`  | `/api/v1/sites/:siteId/kb/crawls/:runId/pages`         | Filter/search URL results        |
| `POST` | `/api/v1/sites/:siteId/kb/crawls/:runId/retry-failed`  | Retry failed URLs                |
| `POST` | `/api/v1/sites/:siteId/kb/sources/:documentId/recrawl` | Recrawl one web source           |

The crawler always enforces `robots.txt`, ports 80/443, redirect validation, and
public IPv4/IPv6 resolution. A sitemap may list pages and nested sitemaps on
different public hosts, but each individual HTTP request may only redirect
within its initial hostname and may not downgrade HTTPS to HTTP. The crawler
sends no backend cookies or authorization headers. ETag/Last-Modified and
extracted-content hashes avoid unnecessary Chromium and embedding work. A
failed recrawl keeps the last indexed chunks. Sitemap sources are retired from
retrieval only after they are absent from two consecutive successful full
syncs.

Reverting the crawler migration removes URL-source documents and their chunks
so the legacy non-null file-path constraint can be restored; back up crawler
content before a migration rollback.

Run `npm test -- --runInBand src/crawler` for the crawler unit suite. For the
Browserless smoke test, set `RUN_CRAWLER_INTEGRATION=true`,
`BROWSER_WS_ENDPOINT`, and `CRAWLER_INTEGRATION_URL` to a public test page, then
run `npm run test:crawler:integration`. Browserless cannot access a fixture on
the API process's localhost.

## WebSocket Chat

The Socket.IO gateway requires a valid JWT. The token can be sent through handshake auth, query string, or `Authorization` header.

Examples:

```ts
io('http://localhost:3000', {
  auth: {
    token: '<accessToken>',
  },
});
```

Supported event:

| Event     | Payload | Description                         |
| --------- | ------- | ----------------------------------- |
| `message` | string  | Broadcasts the message to all users |

## Validation Rules

| DTO                 | Rules                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `LoginDto`          | `email` valid email, `password` required, `recaptchaToken` required     |
| `TwoFactorCodeDto`  | `token` required, 6 characters                                          |
| `Verify2faLoginDto` | `userId` required, `token` required, 6 characters                       |
| `CreateUserDto`     | `name` required, `email` valid email, `password` min 8, `role` optional |
| `UpdateUserDto`     | profile fields optional depending on update use case                    |
| `CreateSiteDto`     | `name` required, `url` valid URL                                        |

## Security Notes

- Passwords are hashed with bcrypt before being saved.
- Protected endpoints require `Authorization: Bearer <accessToken>`.
- JWT payload includes user ID, email, and role.
- Global `ValidationPipe` enables whitelist, non-whitelisted field rejection, and transform.
- Admin-only routes are protected with `JwtAuthGuard`, `RolesGuard`, and `@Roles(UserRole.ADMIN)`.
- Login requires a valid reCAPTCHA token before email/password authentication completes.
- Document upload is restricted to PDF/TXT files up to 5 MB.

## Scripts

| Command                                             | Description                                   |
| --------------------------------------------------- | --------------------------------------------- |
| `npm run start`                                     | Start NestJS once                             |
| `npm run start:dev`                                 | Start in development watch mode               |
| `npm run start:debug`                               | Start in debug watch mode                     |
| `npm run build`                                     | Build the app                                 |
| `npm run start:prod`                                | Run the built app from `dist/main`            |
| `npm run lint`                                      | Run ESLint                                    |
| `npm run lint:fix`                                  | Run ESLint with auto-fix                      |
| `npm run format`                                    | Format the repository with Prettier           |
| `npm run format:check`                              | Check Prettier formatting                     |
| `npm run type-check`                                | Run TypeScript type checking                  |
| `npm run test`                                      | Run unit tests                                |
| `npm run test:e2e`                                  | Run e2e tests                                 |
| `npm run test:cov`                                  | Run tests with coverage                       |
| `npm run migration:run`                             | Run TypeORM migrations                        |
| `npm run migration:revert`                          | Revert the latest TypeORM migration           |
| `npm run migration:generate -- src/migrations/Name` | Generate a migration                          |
| `npm run seed:super-admin`                          | Create the first super admin user from `.env` |

## Development Notes

- Keep `synchronize` disabled and use migrations for schema changes.
- Run PostgreSQL and Redis before starting the API.
- Run migrations before seeding the super admin user.
- Keep Cloudinary credentials configured before testing document upload.
- Use Swagger at `/api` for manual REST API testing.
