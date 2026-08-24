import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPreviousRefreshTokenToUser1787305024707 implements MigrationInterface {
  name = 'AddPreviousRefreshTokenToUser1787305024707';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "previousRefreshToken" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "previousRefreshTokenExpiresAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "previousRefreshTokenExpiresAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "previousRefreshToken"`,
    );
  }
}
