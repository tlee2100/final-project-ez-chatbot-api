import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentStatusTrigger1783314356872 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_site_knowledge_base_status()
      RETURNS TRIGGER AS $$
      DECLARE
        target_site_id uuid;
        total_count integer;
        pending_count integer;
        processing_count integer;
        ready_count integer;
      BEGIN
        target_site_id := COALESCE(NEW."siteId", OLD."siteId");

        SELECT
          COUNT(*),
          COUNT(*) FILTER (WHERE status = 'pending'),
          COUNT(*) FILTER (WHERE status = 'processing'),
          COUNT(*) FILTER (WHERE status = 'ready')
        INTO
          total_count,
          pending_count,
          processing_count,
          ready_count
        FROM documents
        WHERE "siteId" = target_site_id;

        IF total_count = 0 THEN
          UPDATE sites
          SET "knowledgeBaseStatus" = 'pending'
          WHERE id = target_site_id;

        ELSIF processing_count > 0 THEN
          UPDATE sites
          SET "knowledgeBaseStatus" = 'processing'
          WHERE id = target_site_id;

        ELSIF ready_count = total_count THEN
          UPDATE sites
          SET "knowledgeBaseStatus" = 'ready'
          WHERE id = target_site_id;

        ELSIF pending_count = total_count THEN
          UPDATE sites
          SET "knowledgeBaseStatus" = 'pending'
          WHERE id = target_site_id;

        ELSE
          UPDATE sites
          SET "knowledgeBaseStatus" = 'processing'
          WHERE id = target_site_id;
        END IF;

        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_update_site_knowledge_base_status ON documents;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_update_site_knowledge_base_status
      AFTER INSERT OR UPDATE OF status OR DELETE
      ON documents
      FOR EACH ROW
      EXECUTE FUNCTION update_site_knowledge_base_status();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_update_site_knowledge_base_status ON documents;
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS update_site_knowledge_base_status();
    `);
  }
}
