import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKnowledgeBaseSettings1786500000000 implements MigrationInterface {
  name = 'AddKnowledgeBaseSettings1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "kbChunkSize" integer NOT NULL DEFAULT 800`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "kbChunkOverlap" integer NOT NULL DEFAULT 100`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "kbRetrievalTopK" integer NOT NULL DEFAULT 4`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "kbSimilarityThreshold" double precision NOT NULL DEFAULT 0.5`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."documents_reindexstatus_enum" AS ENUM('idle', 'queued', 'processing', 'failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "indexedChunkSize" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "indexedChunkOverlap" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "reindexStatus" "public"."documents_reindexstatus_enum" NOT NULL DEFAULT 'idle'`,
    );
    await queryRunner.query(`ALTER TABLE "documents" ADD "reindexError" text`);
    await queryRunner.query(
      `UPDATE "documents" SET "indexedChunkSize" = 800, "indexedChunkOverlap" = 100 WHERE "status" = 'ready'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "reindexError"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "reindexStatus"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "indexedChunkOverlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "indexedChunkSize"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."documents_reindexstatus_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "kbSimilarityThreshold"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "kbRetrievalTopK"`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "kbChunkOverlap"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "kbChunkSize"`);
  }
}
