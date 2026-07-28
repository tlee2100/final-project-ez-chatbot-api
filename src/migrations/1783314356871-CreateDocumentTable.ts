import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDocumentTable1783314356871 implements MigrationInterface {
  name = 'CreateDocumentTable1783314356871';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."documents_status_enum" AS ENUM('pending', 'processing', 'ready')`,
    );
    await queryRunner.query(
      `CREATE TABLE "documents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "filename" character varying NOT NULL, "filePath" character varying NOT NULL, "status" "public"."documents_status_enum" NOT NULL DEFAULT 'pending', "siteId" uuid NOT NULL, "uploadedAt" TIMESTAMP NOT NULL DEFAULT now(), "processedAt" TIMESTAMP, CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_3ef5cd59afa019c85b5dbf33d9a" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_3ef5cd59afa019c85b5dbf33d9a"`,
    );
    await queryRunner.query(`DROP TABLE "documents"`);
    await queryRunner.query(`DROP TYPE "public"."documents_status_enum"`);
  }
}
