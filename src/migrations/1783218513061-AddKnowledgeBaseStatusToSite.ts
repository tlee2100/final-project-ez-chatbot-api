import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKnowledgeBaseStatusToSite1783218513061 implements MigrationInterface {
  name = 'AddKnowledgeBaseStatusToSite1783218513061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."sites_knowledgebasestatus_enum" AS ENUM('pending', 'processing', 'ready')`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "knowledgeBaseStatus" "public"."sites_knowledgebasestatus_enum" NOT NULL DEFAULT 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "knowledgeBaseStatus"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."sites_knowledgebasestatus_enum"`,
    );
  }
}
