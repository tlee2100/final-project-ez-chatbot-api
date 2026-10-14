import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRateLimitingToSite1785950000000 implements MigrationInterface {
  name = 'AddRateLimitingToSite1785950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "maxMessagesPerSession" integer NOT NULL DEFAULT 50`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "maxSessionsPerIp" integer NOT NULL DEFAULT 10`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "maxMessagesPerSession"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "maxSessionsPerIp"`,
    );
  }
}
