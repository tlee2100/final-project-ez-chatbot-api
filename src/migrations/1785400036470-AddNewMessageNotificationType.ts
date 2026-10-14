import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewMessageNotificationType1785400036470 implements MigrationInterface {
  name = 'AddNewMessageNotificationType1785400036470';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_documents_fileType"`);
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE 'NEW_MESSAGE'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b027ee5c09b084347040a26fd4" ON "documents"  ("fileType") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b027ee5c09b084347040a26fd4"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_type_enum_old" AS ENUM('CONVERSATION_WAITING', 'CONVERSATION_CLOSED', 'AGENT_HANDOFF_REQUEST', 'DOCUMENT_PROCESSED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'SYSTEM')`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "public"."notifications_type_enum_old" USING "type"::"text"::"public"."notifications_type_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum_old" RENAME TO "notifications_type_enum"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_fileType" ON "documents" USING btree ("fileType") `,
    );
  }
}
