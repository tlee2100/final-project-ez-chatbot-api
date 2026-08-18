import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppearanceToSite1786441127389 implements MigrationInterface {
  name = 'AddAppearanceToSite1786441127389';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "primaryColor" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "backgroundColor" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "sites" ADD "botAvatar" text`);
    await queryRunner.query(`ALTER TABLE "sites" ADD "launcherIcon" text`);
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "defaultGreetingMessage" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "chatButtonPosition" character varying NOT NULL DEFAULT 'Bottom Right'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "chatWindowTitle" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "chatButtonText" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD "showAvatar" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "showAvatar"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "chatButtonText"`);
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "chatWindowTitle"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "chatButtonPosition"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "defaultGreetingMessage"`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "launcherIcon"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "botAvatar"`);
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN "backgroundColor"`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "primaryColor"`);
  }
}
