import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBehaviorFieldsToSite1785960000000 implements MigrationInterface {
  name = 'AddBehaviorFieldsToSite1785960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "maxTokensPerResponse" integer NOT NULL DEFAULT 1000`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "systemPromptOverride" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "useCurrentPageContent" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "memorySummarization" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "sentimentDetection" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "llmModel" character varying NOT NULL DEFAULT 'deepseek-v4-flash'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "maxTokensPerResponse"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "systemPromptOverride"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "useCurrentPageContent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "memorySummarization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "sentimentDetection"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "llmModel"`,
    );
  }
}
