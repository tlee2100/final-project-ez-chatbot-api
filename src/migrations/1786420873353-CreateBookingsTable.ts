import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingsTable1786420873353 implements MigrationInterface {
  name = 'CreateBookingsTable1786420873353';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."bookings_status_enum" AS ENUM('draft', 'confirmed', 'completed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "bookings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(50) NOT NULL, "siteId" uuid NOT NULL, "resourceId" uuid, "serviceId" uuid, "startAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endAt" TIMESTAMP WITH TIME ZONE NOT NULL, "timezone" character varying(50) NOT NULL, "status" "public"."bookings_status_enum" NOT NULL DEFAULT 'confirmed', "customerName" character varying(255) NOT NULL, "phone" character varying(20) NOT NULL, "customerEmail" character varying(255), "notes" text, "templateFields" jsonb NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_bee6805982cc1e248e94ce94957" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bookings_site_status_start" ON "bookings"  ("siteId", "status", "startAt") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bookings_site_code" ON "bookings"  ("siteId", "code") `,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_6ab1de8b5d2af0b0cc9be2ae4ae" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_dbf1b4f12f0d01bd7fb2ff200df" FOREIGN KEY ("resourceId") REFERENCES "booking_resources"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_15a2431ec10d29dcd96c9563b65" FOREIGN KEY ("serviceId") REFERENCES "booking_services"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(`
            ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap"
            EXCLUDE USING gist (
                "siteId" WITH =,
                COALESCE("resourceId"::text, '___NULL___') WITH =,
                tstzrange("startAt", "endAt") WITH &&
            ) WHERE (status <> 'cancelled')
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "no_overlap"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_15a2431ec10d29dcd96c9563b65"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_dbf1b4f12f0d01bd7fb2ff200df"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_6ab1de8b5d2af0b0cc9be2ae4ae"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_bookings_site_code"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bookings_site_status_start"`,
    );
    await queryRunner.query(`DROP TABLE "bookings"`);
    await queryRunner.query(`DROP TYPE "public"."bookings_status_enum"`);
  }
}
