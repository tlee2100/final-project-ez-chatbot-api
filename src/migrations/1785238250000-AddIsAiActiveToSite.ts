import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsAiActiveToSite1785238250000 implements MigrationInterface {
  name = 'AddIsAiActiveToSite1785238250000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "isAiActive" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "isAiActive"`,
    );
  }
}
