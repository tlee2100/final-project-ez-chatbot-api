import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFeedbackToChatMessages1787200000000 implements MigrationInterface {
  name = 'AddFeedbackToChatMessages1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."chat_messages_feedbackrating_enum" AS ENUM('HELPFUL', 'UNHELPFUL')`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD "feedbackRating" "public"."chat_messages_feedbackrating_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD "feedbackAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN "feedbackAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN "feedbackRating"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."chat_messages_feedbackrating_enum"`,
    );
  }
}
