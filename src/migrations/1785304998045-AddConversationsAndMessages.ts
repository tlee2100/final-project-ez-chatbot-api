import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConversationsAndMessages1785304998045 implements MigrationInterface {
  name = 'AddConversationsAndMessages1785304998045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_organizations_owner"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_cdf778d13ea7fe8095e013e34f0"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."conversations_status_enum" AS ENUM('OPEN', 'PAUSED', 'CLOSED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."conversations_handlingstatus_enum" AS ENUM('AI_HANDLING', 'WAITING_FOR_AGENT', 'AGENT_HANDLING')`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "siteId" uuid NOT NULL, "agentId" uuid, "visitorName" character varying NOT NULL, "visitorEmail" character varying NOT NULL, "status" "public"."conversations_status_enum" NOT NULL DEFAULT 'OPEN', "handlingStatus" "public"."conversations_handlingstatus_enum" NOT NULL DEFAULT 'WAITING_FOR_AGENT', "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."chat_messages_sendertype_enum" AS ENUM('VISITOR', 'AGENT', 'SYSTEM')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."chat_messages_status_enum" AS ENUM('SENT', 'DELIVERED', 'READ')`,
    );
    await queryRunner.query(
      `CREATE TABLE "chat_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "conversationId" uuid NOT NULL, "senderType" "public"."chat_messages_sendertype_enum" NOT NULL, "agentId" uuid, "content" text NOT NULL, "status" "public"."chat_messages_status_enum" NOT NULL DEFAULT 'SENT', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_40c55ee0e571e268b0d3cd37d10" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "UQ_cdf778d13ea7fe8095e013e34f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_cdf778d13ea7fe8095e013e34f0" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_99acf7e1bd2c25211aa7bda3477" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_6bc9cd21e9dad29f3de7b6da4d9" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD CONSTRAINT "FK_45745953065384cc9c4264c2a3d" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD CONSTRAINT "FK_9ca4bc1e292d114267270f916c2" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_9ca4bc1e292d114267270f916c2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_45745953065384cc9c4264c2a3d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_6bc9cd21e9dad29f3de7b6da4d9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_99acf7e1bd2c25211aa7bda3477"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_cdf778d13ea7fe8095e013e34f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "UQ_cdf778d13ea7fe8095e013e34f0" UNIQUE ("ownerId")`,
    );
    await queryRunner.query(`DROP TABLE "chat_messages"`);
    await queryRunner.query(`DROP TYPE "public"."chat_messages_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."chat_messages_sendertype_enum"`,
    );
    await queryRunner.query(`DROP TABLE "conversations"`);
    await queryRunner.query(
      `DROP TYPE "public"."conversations_handlingstatus_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."conversations_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_cdf778d13ea7fe8095e013e34f0" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_organizations_owner" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }
}
