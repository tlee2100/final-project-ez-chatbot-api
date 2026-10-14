import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddCustomBaseUrlAndKeyMaskToSite — Support custom provider endpoint (customBaseUrl)
 * and safe masked key display (keyMask) for Bring-Your-Own-Key (BYOK).
 */
export class AddCustomBaseUrlAndKeyMaskToSite1787310000000 implements MigrationInterface {
  name = 'AddCustomBaseUrlAndKeyMaskToSite1787310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "customBaseUrl" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "keyMask" varchar(60) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        DROP COLUMN IF EXISTS "customBaseUrl",
        DROP COLUMN IF EXISTS "keyMask"
    `);
  }
}
