import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddByokToSite — P1-6 SEC-001/CE-004
 *
 * Adds two columns to the `sites` table to support Bring-Your-Own-Key (BYOK):
 *  - useCustomOpenAiKey: boolean flag (default false)
 *  - encryptedOpenAiKey: AES-256-GCM encrypted API key (nullable text)
 *
 * The key is NEVER stored in plaintext. Encryption/decryption is handled
 * by src/shared/utils/encryption.util.ts using OPENAI_KEY_ENCRYPTION_SECRET.
 */
export class AddByokToSite1787250000000 implements MigrationInterface {
  name = 'AddByokToSite1787250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "useCustomOpenAiKey" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "encryptedOpenAiKey" text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sites"
        DROP COLUMN IF EXISTS "useCustomOpenAiKey",
        DROP COLUMN IF EXISTS "encryptedOpenAiKey"
    `);
  }
}
