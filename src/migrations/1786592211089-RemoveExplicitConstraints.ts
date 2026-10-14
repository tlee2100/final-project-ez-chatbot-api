import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveExplicitConstraints1786592211089 implements MigrationInterface {
  name = 'RemoveExplicitConstraints1786592211089';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop old explicit constraints
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" DROP CONSTRAINT IF EXISTS "FK_crawl_run_items_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" DROP CONSTRAINT IF EXISTS "FK_crawl_run_items_run"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" DROP CONSTRAINT IF EXISTS "FK_crawl_runs_config"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" DROP CONSTRAINT IF EXISTS "FK_crawl_runs_site"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawler_configs" DROP CONSTRAINT IF EXISTS "FK_crawler_configs_site"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "FK_documents_crawler_config"`,
    );

    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" DROP CONSTRAINT IF EXISTS "UQ_crawl_run_items_run_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawler_configs" DROP CONSTRAINT IF EXISTS "UQ_crawler_configs_siteId"`,
    );

    // 2. Drop old explicit indexes
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_chunks_embedding_hnsw"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_crawl_runs_active_site"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_documents_sourceKind"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_documents_site_normalized_url"`,
    );

    // 4. Create new TypeORM generated indexes
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_crawl_run_items_run_url" ON "crawl_run_items" ("runId", "normalizedUrl")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_crawler_configs_siteId" ON "crawler_configs" ("siteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1f91929a06f265230dc20fc9fb" ON "documents" ("sourceKind")`,
    );

    // 5. Create new TypeORM generated foreign keys
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" ADD CONSTRAINT "FK_14f4e1ab11a2fd840f3395bf492" FOREIGN KEY ("runId") REFERENCES "crawl_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" ADD CONSTRAINT "FK_33d53eb47cc97f73c3a4ce7adeb" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" ADD CONSTRAINT "FK_e56218f98e6cd6e8dc0eec62e81" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" ADD CONSTRAINT "FK_1bc64aeb03ba02607c21c8c1c60" FOREIGN KEY ("crawlerConfigId") REFERENCES "crawler_configs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawler_configs" ADD CONSTRAINT "FK_3d4f96d82681f8c9db743d0f4bf" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_ff4d9fed9284a41db1a741d6261" FOREIGN KEY ("crawlerConfigId") REFERENCES "crawler_configs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" DROP CONSTRAINT "FK_14f4e1ab11a2fd840f3395bf492"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_run_items" DROP CONSTRAINT "FK_33d53eb47cc97f73c3a4ce7adeb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" DROP CONSTRAINT "FK_e56218f98e6cd6e8dc0eec62e81"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawl_runs" DROP CONSTRAINT "FK_1bc64aeb03ba02607c21c8c1c60"`,
    );
    await queryRunner.query(
      `ALTER TABLE "crawler_configs" DROP CONSTRAINT "FK_3d4f96d82681f8c9db743d0f4bf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_ff4d9fed9284a41db1a741d6261"`,
    );

    await queryRunner.query(`DROP INDEX "public"."UQ_crawl_run_items_run_url"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_crawler_configs_siteId"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1f91929a06f265230dc20fc9fb"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_documents_site_normalized_url" ON "documents" USING btree ("siteId", "normalizedUrl") WHERE (("sourceKind" = 'url'::documents_sourcekind_enum) AND ("normalizedUrl" IS NOT NULL))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_crawl_runs_active_site" ON "crawl_runs" USING btree ("siteId") WHERE (status = ANY (ARRAY['queued'::crawl_runs_status_enum, 'discovering'::crawl_runs_status_enum, 'processing'::crawl_runs_status_enum]))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw ("embedding")`,
    );
  }
}
