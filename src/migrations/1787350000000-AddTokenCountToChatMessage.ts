import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenCountToChatMessage1787350000000 implements MigrationInterface {
  name = 'AddTokenCountToChatMessage1787350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "tokenCount" integer DEFAULT 0`,
    );
    // 1. Backfill ONLY AI messages with estimated token counts if not set
    await queryRunner.query(
      `UPDATE "chat_messages" SET "tokenCount" = GREATEST(1, CEIL(LENGTH("content") / 4)) WHERE "senderType" = 'AI' AND ("tokenCount" IS NULL OR "tokenCount" = 0)`,
    );
    // 2. Ensure all non-AI messages (Visitor, Agent, System) are strictly 0
    await queryRunner.query(
      `UPDATE "chat_messages" SET "tokenCount" = 0 WHERE "senderType" != 'AI'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "tokenCount"`,
    );
  }
}
