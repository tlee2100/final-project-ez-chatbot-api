import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationEntity1785311785840 implements MigrationInterface {
  name = 'CreateNotificationEntity1785311785840';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_type_enum" AS ENUM('CONVERSATION_WAITING', 'CONVERSATION_CLOSED', 'AGENT_HANDOFF_REQUEST', 'DOCUMENT_PROCESSED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'SYSTEM')`,
    );
    await queryRunner.query(
      `CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "recipientId" uuid NOT NULL, "type" "public"."notifications_type_enum" NOT NULL, "title" character varying(120) NOT NULL, "message" character varying(500) NOT NULL, "siteId" uuid, "conversationId" uuid, "readAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_conversation" ON "notifications"  ("conversationId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_recipient_readAt" ON "notifications"  ("recipientId", "readAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_db873ba9a123711a4bff527ccd5" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_ada055d3ed9e85ad74071b4b0a5" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_cc7d3a957c3fe287fcdc289a12b" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_cc7d3a957c3fe287fcdc289a12b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_ada055d3ed9e85ad74071b4b0a5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_db873ba9a123711a4bff527ccd5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notifications_recipient_readAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notifications_conversation"`,
    );
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
  }
}
