import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConstrantBookingWithName1786438149947 implements MigrationInterface {
  name = 'AddConstrantBookingWithName1786438149947';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist ("siteId" WITH =, COALESCE("resourceId"::text, '___NULL___') WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE (status <> 'cancelled')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "no_overlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
  }
}
