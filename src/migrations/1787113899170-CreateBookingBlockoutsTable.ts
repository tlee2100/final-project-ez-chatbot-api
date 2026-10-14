import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingBlockoutsTable1787113899170 implements MigrationInterface {
  name = 'CreateBookingBlockoutsTable1787113899170';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "booking_blockouts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "resourceId" uuid, "startAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endAt" TIMESTAMP WITH TIME ZONE NOT NULL, "reason" character varying(255), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_dd272bd66410d3aa262274decd0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_booking_blockouts_resource" ON "booking_blockouts"  ("resourceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_booking_blockouts_site_start_end" ON "booking_blockouts"  ("siteId", "startAt", "endAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_blockouts" ADD CONSTRAINT "FK_db6f016e126a0f74914144ca7d7" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_blockouts" ADD CONSTRAINT "FK_a19ef1af1e8e56aa95513e29bc4" FOREIGN KEY ("resourceId") REFERENCES "booking_resources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "booking_blockouts" DROP CONSTRAINT "FK_a19ef1af1e8e56aa95513e29bc4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_blockouts" DROP CONSTRAINT "FK_db6f016e126a0f74914144ca7d7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_booking_blockouts_site_start_end"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_booking_blockouts_resource"`,
    );
    await queryRunner.query(`DROP TABLE "booking_blockouts"`);
  }
}
