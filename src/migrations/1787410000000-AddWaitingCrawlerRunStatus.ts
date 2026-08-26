import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaitingCrawlerRunStatus1787410000000 implements MigrationInterface {
  name = 'AddWaitingCrawlerRunStatus1787410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."crawl_runs_status_enum" ADD VALUE IF NOT EXISTS 'waiting' BEFORE 'queued'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "crawl_runs"
      SET
        "status" = 'failed',
        "errorMessage" = COALESCE("errorMessage", 'Waiting crawl cancelled by migration rollback'),
        "finishedAt" = COALESCE("finishedAt", now())
      WHERE "status" = 'waiting'
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_crawl_runs_active_site"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_crawl_runs_siteId_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."crawl_runs_status_enum_old" AS ENUM('queued', 'discovering', 'processing', 'completed', 'partial_failed', 'failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" ALTER COLUMN "status" TYPE "public"."crawl_runs_status_enum_old" USING "status"::"text"::"public"."crawl_runs_status_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."crawl_runs_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."crawl_runs_status_enum_old" RENAME TO "crawl_runs_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" ALTER COLUMN "status" SET DEFAULT 'queued'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_crawl_runs_siteId_status" ON "crawl_runs" ("siteId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_crawl_runs_active_site" ON "crawl_runs" ("siteId") WHERE "status" IN ('queued', 'discovering', 'processing')`,
    );
  }
}
