import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookingAssignedServices1787205907738 implements MigrationInterface {
  name = 'AddBookingAssignedServices1787205907738';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "booking_assigned_services" ("bookingId" uuid NOT NULL, "serviceId" uuid NOT NULL, CONSTRAINT "PK_d5e4e104447bfeedb92711d4094" PRIMARY KEY ("bookingId", "serviceId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0f2ad2922962f0c5abcca67bd0" ON "booking_assigned_services"  ("bookingId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edcbecc30783a07d6999162063" ON "booking_assigned_services"  ("serviceId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_assigned_services" ADD CONSTRAINT "FK_0f2ad2922962f0c5abcca67bd02" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_assigned_services" ADD CONSTRAINT "FK_edcbecc30783a07d69991620637" FOREIGN KEY ("serviceId") REFERENCES "booking_services"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "booking_assigned_services" DROP CONSTRAINT "FK_edcbecc30783a07d69991620637"`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_assigned_services" DROP CONSTRAINT "FK_0f2ad2922962f0c5abcca67bd02"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_edcbecc30783a07d6999162063"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0f2ad2922962f0c5abcca67bd0"`,
    );
    await queryRunner.query(`DROP TABLE "booking_assigned_services"`);
  }
}
