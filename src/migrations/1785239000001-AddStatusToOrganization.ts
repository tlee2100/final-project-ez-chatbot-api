import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStatusToOrganization1785239000000 implements MigrationInterface {
  name = 'AddStatusToOrganization1785239000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "status" character varying NOT NULL DEFAULT 'Active'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "status"`);
  }
}
