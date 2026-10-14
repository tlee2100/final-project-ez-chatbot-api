import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateSiteStatusDefaultReady1785341685105 implements MigrationInterface {
  name = 'UpdateSiteStatusDefaultReady1785341685105';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "knowledgeBaseStatus" SET DEFAULT 'ready'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ALTER COLUMN "knowledgeBaseStatus" SET DEFAULT 'pending'`,
    );
  }
}
