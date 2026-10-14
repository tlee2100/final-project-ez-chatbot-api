import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddCustomKeyStatusToSite — Track validation and operational status of custom API keys (BYOK).
 *
 * Adds column `customKeyStatus` with default 'unknown'.
 * Possible values: 'unknown', 'valid', 'invalid'.
 */
export class AddCustomKeyStatusToSite1787300000000 implements MigrationInterface {
  name = 'AddCustomKeyStatusToSite1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "customKeyStatus" varchar(20) NOT NULL DEFAULT 'unknown'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        DROP COLUMN IF EXISTS "customKeyStatus"
    `);
  }
}
