import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateConversationHandlingStatusDefault1754350000000 implements MigrationInterface {
  name = 'UpdateConversationHandlingStatusDefault1754350000000';

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
