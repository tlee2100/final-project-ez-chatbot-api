import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateBookingNoOverlapConstraint1787271563774 implements MigrationInterface {
  name = 'UpdateBookingNoOverlapConstraint1787271563774';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "llmModel" SET DEFAULT 'qwen3.7-flash'`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "no_overlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist ("siteId" WITH =, COALESCE("resourceId"::text, '___NULL___') WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE (status = 'confirmed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "no_overlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist ("siteId" WITH =, COALESCE("resourceId"::text, '___NULL___') WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE (status <> 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "llmModel" SET DEFAULT 'deepseek-v4-flash'`,
    );
  }
}
