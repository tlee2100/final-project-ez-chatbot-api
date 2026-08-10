import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiColumnsToConversations1785748152195 implements MigrationInterface {
  name = 'AddAiColumnsToConversations1785748152195';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" ADD "summary" text`);
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "summarizedMessageCount" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "isAiActive" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."chat_messages_sendertype_enum" ADD VALUE 'AI'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."chat_messages_sendertype_enum_old" AS ENUM('VISITOR', 'AGENT', 'SYSTEM')`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ALTER COLUMN "senderType" TYPE "public"."chat_messages_sendertype_enum_old" USING "senderType"::"text"::"public"."chat_messages_sendertype_enum_old"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."chat_messages_sendertype_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."chat_messages_sendertype_enum_old" RENAME TO "chat_messages_sendertype_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "isAiActive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "summarizedMessageCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "summary"`,
    );
  }
}
