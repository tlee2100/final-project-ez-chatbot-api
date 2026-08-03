import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileSizeToDocument1785239000000 implements MigrationInterface {
  name = 'AddFileSizeToDocument1785239000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "fileSizeBytes" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "fileSizeBytes"`,
    );
  }
}
