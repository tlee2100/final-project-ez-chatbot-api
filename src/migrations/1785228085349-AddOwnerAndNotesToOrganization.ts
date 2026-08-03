import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOwnerAndNotesToOrganization1785228085349 implements MigrationInterface {
  name = 'AddOwnerAndNotesToOrganization1785228085349';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "notes" text`,
    );
    // The "ownerId" column + its foreign key are owned by migration
    // 1785216000000 (AddUserProfileAndOrganizationOwner). Re-adding the column
    // here is guarded with IF NOT EXISTS for ordering safety; the duplicate
    // foreign key that used to be added here has been removed to avoid a
    // redundant second FK on the same column.
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ownerId" uuid`,
    );
    // Enforce one-owner-per-organization (1:1 ownership).
    // NOTE: This UNIQUE constraint conflicts with the entity's many-to-one
    // owner mapping in organization.entity.ts. The 1:1-vs-N:1 ownership model
    // is an open business decision (see AUTH_FIX_PLAN.md, decision #5); left
    // as-is pending that decision.
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "UQ_cdf778d13ea7fe8095e013e34f0" UNIQUE ("ownerId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "UQ_cdf778d13ea7fe8095e013e34f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "notes"`,
    );
  }
}
