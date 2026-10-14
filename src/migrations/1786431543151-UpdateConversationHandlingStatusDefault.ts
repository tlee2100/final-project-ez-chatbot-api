import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateConversationHandlingStatusDefault1786431543151 implements MigrationInterface {
  name = 'UpdateConversationHandlingStatusDefault1786431543151';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "handlingStatus" SET DEFAULT 'AI_HANDLING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "handlingStatus" SET DEFAULT 'WAITING_FOR_AGENT'`,
    );
  }
}
