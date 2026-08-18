import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateBookingEntity1786435682782 implements MigrationInterface {
  name = 'UpdateBookingEntity1786435682782';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ALTER COLUMN "metadata" SET DEFAULT '{}'`,
    );
  }
}
