import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSiteBookingEntities1786357944699 implements MigrationInterface {
  name = 'AddSiteBookingEntities1786357944699';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" DROP CONSTRAINT "FK_document_chunks_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" DROP CONSTRAINT "UQ_document_chunks_document_chunk_index"`,
    );
    await queryRunner.query(
      `CREATE TABLE "site_booking_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "bookingTimezone" character varying(50), "bookingSlotDuration" integer NOT NULL DEFAULT '30', "bookingStartTime" character varying(5) NOT NULL DEFAULT '09:00', "bookingEndTime" character varying(5) NOT NULL DEFAULT '18:00', "bookingAvailableDays" integer array NOT NULL DEFAULT '{1,2,3,4,5}', CONSTRAINT "REL_19f340238a1c01edd7ac8fdd33" UNIQUE ("siteId"), CONSTRAINT "PK_082fe77b8d558f4522a3476ce3f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "booking_services" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "name" character varying(255) NOT NULL, CONSTRAINT "PK_8997bf4d0728c8740c87694d59a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "booking_staff" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "name" character varying(255) NOT NULL, CONSTRAINT "PK_906bc834a251136234359221639" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "bookingEnabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sites_industrytemplate_enum" AS ENUM('salon', 'general')`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "industryTemplate" "public"."sites_industrytemplate_enum" NOT NULL DEFAULT 'salon'`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_document_chunks_document_chunk_index" ON "document_chunks"  ("documentId", "chunkIndex") `,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ADD CONSTRAINT "FK_eaf9afaf30fb7e2ac25989db51b" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_booking_configs" ADD CONSTRAINT "FK_19f340238a1c01edd7ac8fdd335" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_services" ADD CONSTRAINT "FK_6cbfde6d7dfe8228fd3036ae34b" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_staff" ADD CONSTRAINT "FK_5ff634149f9da211e957f43d078" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "booking_staff" DROP CONSTRAINT "FK_5ff634149f9da211e957f43d078"`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_services" DROP CONSTRAINT "FK_6cbfde6d7dfe8228fd3036ae34b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_booking_configs" DROP CONSTRAINT "FK_19f340238a1c01edd7ac8fdd335"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" DROP CONSTRAINT "FK_eaf9afaf30fb7e2ac25989db51b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "industryTemplate"`,
    );
    await queryRunner.query(`DROP TYPE "public"."sites_industrytemplate_enum"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "bookingEnabled"`);
    await queryRunner.query(`DROP TABLE "booking_staff"`);
    await queryRunner.query(`DROP TABLE "booking_services"`);
    await queryRunner.query(`DROP TABLE "site_booking_configs"`);
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ADD CONSTRAINT "UQ_document_chunks_document_chunk_index" UNIQUE ("documentId", "chunkIndex")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw ("embedding") `,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ADD CONSTRAINT "FK_document_chunks_document" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
