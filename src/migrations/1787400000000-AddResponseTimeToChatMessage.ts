import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResponseTimeToChatMessage1787400000000 implements MigrationInterface {
  name = 'AddResponseTimeToChatMessage1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add nullable responseTimeSec column
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "responseTimeSec" integer DEFAULT null`,
    );

    // 2. Create partial index for super-fast analytics aggregation
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_chat_messages_response_time" 
       ON "chat_messages" ("senderType", "responseTimeSec") 
       WHERE "responseTimeSec" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_messages_response_time"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "responseTimeSec"`,
    );
  }
}
