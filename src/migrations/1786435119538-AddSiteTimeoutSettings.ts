import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSiteTimeoutSettings1786435119538 implements MigrationInterface {
  name = 'AddSiteTimeoutSettings1786435119538';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "no_overlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "enableConversationTimeout" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "inactivityTimeoutMinutes" integer NOT NULL DEFAULT '15'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "warningTimeMinutes" integer NOT NULL DEFAULT '5'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "inactivityWarningMessage" text`,
    );
    await queryRunner.query(`ALTER TABLE "sites" ADD "timeoutMessage" text`);
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "resetTimerOnBotResponse" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "pauseTimerForAgentChats" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "sendEmailNotificationOnTimeout" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."conversations_closedreason_enum" AS ENUM('VISITOR', 'TIMEOUT', 'AGENT', 'ERROR')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "closedReason" "public"."conversations_closedreason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "closedReason"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."conversations_closedreason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "sendEmailNotificationOnTimeout"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "pauseTimerForAgentChats"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "resetTimerOnBotResponse"`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "timeoutMessage"`);
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "inactivityWarningMessage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "warningTimeMinutes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "inactivityTimeoutMinutes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "enableConversationTimeout"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist ("siteId" WITH =, COALESCE(("resourceId")::text, '___NULL___'::text) WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE ((status <> 'cancelled'::bookings_status_enum))`,
    );
  }
}
