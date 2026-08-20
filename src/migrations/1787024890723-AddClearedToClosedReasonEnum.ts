import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClearedToClosedReasonEnum1787024890723 implements MigrationInterface {
  name = 'AddClearedToClosedReasonEnum1787024890723';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "kbSimilarityThreshold" SET DEFAULT '0.5'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."conversations_closedreason_enum" ADD VALUE 'CLEARED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."conversations_closedreason_enum_old" AS ENUM('VISITOR', 'TIMEOUT', 'AGENT', 'ERROR')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "closedReason" TYPE "public"."conversations_closedreason_enum_old" USING "closedReason"::"text"::"public"."conversations_closedreason_enum_old"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."conversations_closedreason_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."conversations_closedreason_enum_old" RENAME TO "conversations_closedreason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "kbSimilarityThreshold" SET DEFAULT 0.5`,
    );
  }
}
