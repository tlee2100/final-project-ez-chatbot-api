import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEnabledToSite1787285787885 implements MigrationInterface {
  name = 'AddEnabledToSite1787285787885';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "enabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "enabled"`);
  }
}
