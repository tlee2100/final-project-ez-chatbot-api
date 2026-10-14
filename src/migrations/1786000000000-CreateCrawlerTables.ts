import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCrawlerTables1786000000000 implements MigrationInterface {
  name = 'CreateCrawlerTables1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."documents_sourcekind_enum" AS ENUM('file', 'url')`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "filePath" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "sourceKind" "public"."documents_sourcekind_enum" NOT NULL DEFAULT 'file'`,
    );
    await queryRunner.query(`ALTER TABLE "documents" ADD "sourceUrl" text`);
    await queryRunner.query(`ALTER TABLE "documents" ADD "normalizedUrl" text`);
    await queryRunner.query(`ALTER TABLE "documents" ADD "canonicalUrl" text`);
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "contentHash" character varying(64)`,
    );
    await queryRunner.query(`ALTER TABLE "documents" ADD "etag" text`);
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "lastModified" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "isActive" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "crawlerConfigId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "consecutiveMissingRuns" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_sourceKind" ON "documents" ("sourceKind")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_documents_site_normalized_url" ON "documents" ("siteId", "normalizedUrl") WHERE "sourceKind" = 'url' AND "normalizedUrl" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "crawler_configs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "siteId" uuid NOT NULL,
        "sitemapUrl" text NOT NULL,
        "autoSyncEnabled" boolean NOT NULL DEFAULT false,
        "intervalDays" integer NOT NULL DEFAULT 7,
        "lastRunAt" TIMESTAMP WITH TIME ZONE,
        "nextRunAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crawler_configs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crawler_configs_siteId" UNIQUE ("siteId"),
        CONSTRAINT "FK_crawler_configs_site" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE TYPE "public"."crawl_runs_trigger_enum" AS ENUM('manual_sitemap', 'scheduled', 'manual_url', 'retry_failed', 'recrawl_page')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."crawl_runs_status_enum" AS ENUM('queued', 'discovering', 'processing', 'completed', 'partial_failed', 'failed')`,
    );
    await queryRunner.query(`
      CREATE TABLE "crawl_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "siteId" uuid NOT NULL,
        "crawlerConfigId" uuid,
        "requestedByUserId" uuid,
        "trigger" "public"."crawl_runs_trigger_enum" NOT NULL,
        "status" "public"."crawl_runs_status_enum" NOT NULL DEFAULT 'queued',
        "targetUrl" text NOT NULL,
        "totalPages" integer NOT NULL DEFAULT 0,
        "processedPages" integer NOT NULL DEFAULT 0,
        "indexedPages" integer NOT NULL DEFAULT 0,
        "unchangedPages" integer NOT NULL DEFAULT 0,
        "skippedPages" integer NOT NULL DEFAULT 0,
        "failedPages" integer NOT NULL DEFAULT 0,
        "quotaExceededPages" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crawl_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_crawl_runs_site" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_crawl_runs_config" FOREIGN KEY ("crawlerConfigId") REFERENCES "crawler_configs"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_crawl_runs_siteId_createdAt" ON "crawl_runs" ("siteId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_crawl_runs_siteId_status" ON "crawl_runs" ("siteId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_crawl_runs_active_site" ON "crawl_runs" ("siteId") WHERE "status" IN ('queued', 'discovering', 'processing')`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."crawl_run_items_status_enum" AS ENUM('discovered', 'queued', 'rendering', 'indexed', 'unchanged', 'skipped_robots', 'skipped_noindex', 'failed', 'quota_exceeded', 'retired')`,
    );
    await queryRunner.query(`
      CREATE TABLE "crawl_run_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "runId" uuid NOT NULL,
        "documentId" uuid,
        "url" text NOT NULL,
        "normalizedUrl" text NOT NULL,
        "canonicalUrl" text,
        "status" "public"."crawl_run_items_status_enum" NOT NULL,
        "httpStatus" integer,
        "etag" text,
        "lastModified" TIMESTAMP WITH TIME ZONE,
        "errorCode" character varying(100),
        "errorMessage" text,
        "sitemapLastModified" TIMESTAMP WITH TIME ZONE,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crawl_run_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crawl_run_items_run_url" UNIQUE ("runId", "normalizedUrl"),
        CONSTRAINT "FK_crawl_run_items_run" FOREIGN KEY ("runId") REFERENCES "crawl_runs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_crawl_run_items_document" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_crawl_run_items_runId_status" ON "crawl_run_items" ("runId", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_crawler_config" FOREIGN KEY ("crawlerConfigId") REFERENCES "crawler_configs"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_crawler_config"`,
    );
    await queryRunner.query(`DROP TABLE "crawl_run_items"`);
    await queryRunner.query(`DROP TYPE "public"."crawl_run_items_status_enum"`);
    await queryRunner.query(`DROP TABLE "crawl_runs"`);
    await queryRunner.query(`DROP TYPE "public"."crawl_runs_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."crawl_runs_trigger_enum"`);
    await queryRunner.query(`DROP TABLE "crawler_configs"`);
    await queryRunner.query(
      `DELETE FROM "document_chunks" WHERE "documentId" IN (SELECT "id" FROM "documents" WHERE "sourceKind" = 'url')`,
    );
    await queryRunner.query(
      `DELETE FROM "documents" WHERE "sourceKind" = 'url'`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_documents_site_normalized_url"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_documents_sourceKind"`);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "consecutiveMissingRuns"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "crawlerConfigId"`,
    );
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "isActive"`);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "lastModified"`,
    );
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "etag"`);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "contentHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "canonicalUrl"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "normalizedUrl"`,
    );
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "sourceUrl"`);
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "sourceKind"`);
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "filePath" SET NOT NULL`,
    );
    await queryRunner.query(`DROP TYPE "public"."documents_sourcekind_enum"`);
  }
}
