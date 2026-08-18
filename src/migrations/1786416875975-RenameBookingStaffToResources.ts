import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameBookingStaffToResources1786416875975 implements MigrationInterface {
  name = 'RenameBookingStaffToResources1786416875975';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "booking_resources" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "name" character varying(255) NOT NULL, CONSTRAINT "PK_82c13beafcc169e4c572894724a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "booking_resources" ADD CONSTRAINT "FK_338d3faede342fdfbf1eae3591e" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "booking_resources" DROP CONSTRAINT "FK_338d3faede342fdfbf1eae3591e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(`DROP TABLE "booking_resources"`);
  }
}
