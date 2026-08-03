/**
 * seed-super-admin.ts
 *
 * Seeds the database with a complete set of sample data for local development
 * and testing. Covers all tables that exist in the current migration set.
 *
 * Data seeded:
 *   - 1 Super Admin user
 *   - 1 Admin user (organization owner)
 *   - 2 Agent users
 *   - 1 Organization (owned by the admin)
 *   - 2 Sites (belonging to the organization)
 *   - Site-agent assignments (both agents assigned to site 1; agent-1 to site 2)
 *
 * Run: npm run seed:super-admin
 */

import 'dotenv/config';
import dataSource from '../data-source';
import { User, UserGender } from '../user/entities/user.entity';
import { UserRole } from '../user/enums/user-role.enum';
import { Organization } from '../organization/entities/organization.entity';
import { Site } from '../site/entities/site.entity';
import { KnowledgeBaseStatus } from '../site/enums/knowledge-base-status.enum';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';

// ── Credentials — override via .env ──────────────────────────────────────────
const SUPER_ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_DEMO_SUPER_ADMIN_EMAIL ?? 'superadmin@gmail.com';
const SUPER_ADMIN_PASS =
  process.env.NEXT_PUBLIC_DEMO_SUPER_ADMIN_PASSWORD ?? 'password123';

const ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_DEMO_ADMIN_EMAIL ?? 'admin@gmail.com';
const ADMIN_PASS = process.env.NEXT_PUBLIC_DEMO_ADMIN_PASSWORD ?? 'admin123';

const AGENT_EMAIL =
  process.env.NEXT_PUBLIC_DEMO_AGENT_EMAIL ?? 'agent@gmail.com';
const AGENT_PASS = process.env.NEXT_PUBLIC_DEMO_AGENT_PASSWORD ?? 'password123';

// ── Helpers ───────────────────────────────────────────────────────────────────
async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

async function upsertUser(
  repo: Repository<User>,
  data: Partial<User>,
): Promise<User> {
  const existing = await repo.findOne({ where: { email: data.email } });
  if (existing) {
    console.log(`  ↩️  User already exists: ${data.email}`);
    return existing;
  }
  const user = repo.create(data);
  await repo.save(user);
  console.log(`  ✅ Created user: ${data.email} [${data.role}]`);
  return user;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function seedDatabase(ds?: DataSource): Promise<void> {
  const isExternal = !!ds;
  const db = ds || dataSource;

  if (!db.isInitialized) {
    await db.initialize();
  }

  const userRepo = db.getRepository(User);
  const orgRepo = db.getRepository(Organization);
  const siteRepo = db.getRepository(Site);

  // Check if seed already ran
  const existingSuperAdmin = await userRepo.findOne({
    where: { email: SUPER_ADMIN_EMAIL },
  });

  if (existingSuperAdmin) {
    console.log(
      '  ⏭️  Seed data already exists (Super Admin found). Skipping seed.',
    );
    if (!isExternal) await db.destroy();
    return;
  }

  console.log('\n🌱 Starting database seed...\n');

  // ── 1. Users ────────────────────────────────────────────────────────────────
  console.log('── Users ────────────────────────────────────────────────────');

  const superAdmin = await upsertUser(userRepo, {
    email: SUPER_ADMIN_EMAIL,
    password: await hashPassword(SUPER_ADMIN_PASS),
    name: 'Super Administrator',
    role: UserRole.SUPER_ADMIN,
    gender: UserGender.MALE,
    twoFactorEnabled: false,
    organizationId: null,
  });

  const admin = await upsertUser(userRepo, {
    email: ADMIN_EMAIL,
    password: await hashPassword(ADMIN_PASS),
    name: 'Demo Admin',
    role: UserRole.ADMIN,
    gender: UserGender.FEMALE,
    twoFactorEnabled: false,
    organizationId: null,
  });

  const agent1 = await upsertUser(userRepo, {
    email: AGENT_EMAIL,
    password: await hashPassword(AGENT_PASS),
    name: 'Demo Agent 1',
    role: UserRole.AGENT,
    gender: UserGender.MALE,
    twoFactorEnabled: false,
    organizationId: null,
  });

  const agent2 = await upsertUser(userRepo, {
    email: 'agent2@gmail.com',
    password: await hashPassword('password123'),
    name: 'Demo Agent 2',
    role: UserRole.AGENT,
    gender: UserGender.FEMALE,
    twoFactorEnabled: false,
    organizationId: null,
  });

  // Suppress unused-variable warning for superAdmin (available if needed later)
  void superAdmin;

  // ── 2. Organization ─────────────────────────────────────────────────────────
  console.log(
    '\n── Organization ─────────────────────────────────────────────',
  );

  let org = await orgRepo.findOne({ where: { slug: 'demo-org' } });
  if (org) {
    console.log('  ↩️  Organization already exists: demo-org');
  } else {
    org = orgRepo.create({
      name: 'Demo Organization',
      slug: 'demo-org',
      status: 'Active',
      ownerId: admin.id,
      notes:
        'Sample organization created by seed script for local development.',
    });
    await orgRepo.save(org);
    console.log('  ✅ Created organization: Demo Organization');
  }

  // Attach admin and agents to the organization
  await userRepo.update(admin.id, { organizationId: org.id });
  await userRepo.update(agent1.id, { organizationId: org.id });
  await userRepo.update(agent2.id, { organizationId: org.id });
  console.log('  ✅ Assigned admin + 2 agents to organization');

  // ── 3. Sites ─────────────────────────────────────────────────────────────────
  console.log(
    '\n── Sites ────────────────────────────────────────────────────',
  );

  const siteDefs = [
    {
      name: 'E-Commerce Demo Site',
      url: 'https://demo-shop.example.com',
      ownerId: admin.id,
      organizationId: org.id,
      isAiActive: true,
      knowledgeBaseStatus: KnowledgeBaseStatus.PENDING,
    },
    {
      name: 'Support Portal Demo',
      url: 'https://support.example.com',
      ownerId: admin.id,
      organizationId: org.id,
      isAiActive: false,
      knowledgeBaseStatus: KnowledgeBaseStatus.PENDING,
    },
  ];

  const sites: Site[] = [];
  for (const def of siteDefs) {
    let site = await siteRepo.findOne({ where: { url: def.url } });
    if (site) {
      console.log(`  ↩️  Site already exists: ${def.name}`);
    } else {
      site = siteRepo.create(def);
      await siteRepo.save(site);
      console.log(`  ✅ Created site: ${def.name}`);
    }
    sites.push(site);
  }

  // ── 4. Site-Agent Assignments ─────────────────────────────────────────────
  console.log(
    '\n── Site-Agent Assignments ───────────────────────────────────',
  );

  // Reload sites with their agents relation to use the ManyToMany helper
  const site1 = await siteRepo.findOne({
    where: { id: sites[0].id },
    relations: { agents: true },
  });
  const site2 = await siteRepo.findOne({
    where: { id: sites[1].id },
    relations: { agents: true },
  });

  if (site1) {
    const existingIds = site1.agents.map((a) => a.id);
    const toAdd = [agent1, agent2].filter((a) => !existingIds.includes(a.id));
    site1.agents = [...site1.agents, ...toAdd];
    await siteRepo.save(site1);
    console.log(`  ✅ Assigned agent1 + agent2 to "${site1.name}"`);
  }

  if (site2) {
    const existingIds = site2.agents.map((a) => a.id);
    const toAdd = [agent1].filter((a) => !existingIds.includes(a.id));
    site2.agents = [...site2.agents, ...toAdd];
    await siteRepo.save(site2);
    console.log(`  ✅ Assigned agent1 to "${site2.name}"`);
  }

  if (!isExternal) {
    await db.destroy();
  }

  console.log('\n🎉 Seed completed successfully!\n');
  console.log('Demo credentials:');
  console.log(`  Super Admin  →  ${SUPER_ADMIN_EMAIL}  /  ${SUPER_ADMIN_PASS}`);
  console.log(`  Admin        →  ${ADMIN_EMAIL}  /  ${ADMIN_PASS}`);
  console.log(`  Agent 1      →  ${AGENT_EMAIL}  /  ${AGENT_PASS}`);
  console.log('  Agent 2      →  agent2@gmail.com  /  password123\n');
}

// Run if executed directly
if (require.main === module) {
  void seedDatabase().catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
