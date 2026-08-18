import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHasNegativeSentimentToConversations1786424338733 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "hasNegativeSentiment" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "hasNegativeSentiment"`,
    );
  }
}
