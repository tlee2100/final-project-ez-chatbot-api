import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatLocaleState1787135344859 implements MigrationInterface {
  name = 'AddChatLocaleState1787135344859';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD "locale" character varying(35)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD "components" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "currentLocale" character varying(35) NOT NULL DEFAULT 'en'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "activeFlow" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "activeFlowLocale" character varying(35)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "activeFlowLocale"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "activeFlow"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "currentLocale"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN "components"`,
    );
    await queryRunner.query(`ALTER TABLE "chat_messages" DROP COLUMN "locale"`);
  }
}
