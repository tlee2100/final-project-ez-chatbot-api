import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndustryTemplateTable1786420291978 implements MigrationInterface {
  name = 'AddIndustryTemplateTable1786420291978';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" RENAME COLUMN "industryTemplate" TO "industryTemplateId"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."sites_industrytemplate_enum" RENAME TO "sites_industrytemplateid_enum"`,
    );
    await queryRunner.query(
      `CREATE TABLE "industry_templates" ("id" character varying(50) NOT NULL, "config" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_8a0891ba1a0b1f47e921a859d13" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `INSERT INTO "industry_templates" ("id", "config") VALUES ('salon', '{}'), ('general', '{}')`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "industryTemplateId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "industryTemplateId" character varying(50) NOT NULL DEFAULT 'salon'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD CONSTRAINT "FK_8796cf41a57966d1ba0556b3c88" FOREIGN KEY ("industryTemplateId") REFERENCES "industry_templates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" DROP CONSTRAINT "FK_8796cf41a57966d1ba0556b3c88"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "industryTemplateId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "industryTemplateId" "public"."sites_industrytemplateid_enum" NOT NULL DEFAULT 'salon'`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(`DROP TABLE "industry_templates"`);
    await queryRunner.query(
      `ALTER TYPE "public"."sites_industrytemplateid_enum" RENAME TO "sites_industrytemplate_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" RENAME COLUMN "industryTemplateId" TO "industryTemplate"`,
    );
  }
}
