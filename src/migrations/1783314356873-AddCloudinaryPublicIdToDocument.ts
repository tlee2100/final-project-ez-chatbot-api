import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCloudinaryPublicIdToDocument1783314356873 implements MigrationInterface {
  name = 'AddCloudinaryPublicIdToDocument1783314356873';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "cloudinaryPublicId" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN "cloudinaryPublicId"`,
    );
  }
}
