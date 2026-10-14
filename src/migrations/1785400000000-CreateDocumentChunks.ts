import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDocumentChunks1785400000000 implements MigrationInterface {
  name = 'CreateDocumentChunks1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
    await queryRunner.query(`
      CREATE TABLE "document_chunks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "documentId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "chunkIndex" integer NOT NULL,
        "content" text NOT NULL,
        "tokenCount" integer NOT NULL,
        "sectionTitle" character varying(500),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "embedding" vector(1536) NOT NULL,
        "embeddingModel" character varying(100) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_chunks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_document_chunks_document_chunk_index" UNIQUE ("documentId", "chunkIndex"),
        CONSTRAINT "FK_document_chunks_document" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_documentId" ON "document_chunks" ("documentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_siteId" ON "document_chunks" ("siteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_chunks_embedding_hnsw"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_chunks_siteId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_chunks_documentId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "document_chunks"`);
  }
}
