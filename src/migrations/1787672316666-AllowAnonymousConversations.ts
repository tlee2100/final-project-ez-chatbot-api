import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowAnonymousConversations1787672316666 implements MigrationInterface {
  name = 'AllowAnonymousConversations1787672316666';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "visitorName" SET DEFAULT 'Guest'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "visitorEmail" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "visitorEmail" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ALTER COLUMN "visitorName" DROP DEFAULT`,
    );
  }
}
