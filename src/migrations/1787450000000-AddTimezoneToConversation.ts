import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimezoneToConversation1787450000000 implements MigrationInterface {
  name = 'AddTimezoneToConversation1787450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "timezone" character varying(64) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "timezone"`,
    );
  }
}
