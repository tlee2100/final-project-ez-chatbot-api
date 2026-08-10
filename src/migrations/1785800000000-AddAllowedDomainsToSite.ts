import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAllowedDomainsToSite1785800000000 implements MigrationInterface {
  name = 'AddAllowedDomainsToSite1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "allowedDomains" text[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "allowedDomains"`,
    );
  }
}
