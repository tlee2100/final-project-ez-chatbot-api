import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds NEGATIVE_SENTIMENT value to the notifications_type_enum in PostgreSQL.
 * Note: PostgreSQL does not support removing enum values easily,
 * so the down() migration is intentionally left as a no-op.
 */
export class AddNegativeSentimentNotificationType1786424400000 implements MigrationInterface {
  name = 'AddNegativeSentimentNotificationType1786424400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS 'NEGATIVE_SENTIMENT'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing individual enum values easily.
    await Promise.resolve(queryRunner);
  }
}
