import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileTypeToDocument1785315000000 implements MigrationInterface {
  name = 'AddFileTypeToDocument1785315000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."documents_filetype_enum" AS ENUM('pdf', 'docx', 'html', 'txt', 'md', 'url')`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD "fileType" "public"."documents_filetype_enum" NOT NULL DEFAULT 'txt'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_fileType" ON "documents" ("fileType")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_documents_fileType"`);
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "fileType"`);
    await queryRunner.query(`DROP TYPE "public"."documents_filetype_enum"`);
  }
}
