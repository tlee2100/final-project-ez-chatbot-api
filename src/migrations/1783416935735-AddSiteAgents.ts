import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSiteAgents1783416935735 implements MigrationInterface {
  name = 'AddSiteAgents1783416935735';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "site_agents" ("siteId" uuid NOT NULL, "agentId" uuid NOT NULL, CONSTRAINT "PK_5ca85e307f6a2ae9b8ccde4015b" PRIMARY KEY ("siteId", "agentId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6bf1be535f53be3406867ab3fb" ON "site_agents"  ("siteId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bb304282fa4c5addb4b27d78c0" ON "site_agents"  ("agentId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "site_agents" ADD CONSTRAINT "FK_6bf1be535f53be3406867ab3fb4" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_agents" ADD CONSTRAINT "FK_bb304282fa4c5addb4b27d78c0c" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "site_agents" DROP CONSTRAINT "FK_bb304282fa4c5addb4b27d78c0c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_agents" DROP CONSTRAINT "FK_6bf1be535f53be3406867ab3fb4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bb304282fa4c5addb4b27d78c0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6bf1be535f53be3406867ab3fb"`,
    );
    await queryRunner.query(`DROP TABLE "site_agents"`);
  }
}
