import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHnswIndexToDocumentChunks1786600000001 implements MigrationInterface {
  name = 'AddHnswIndexToDocumentChunks1786600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_chunks_embedding_hnsw"`,
    );
  }
}
