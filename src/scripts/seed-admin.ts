import 'dotenv/config';
import dataSource from '../data-source';
import { User } from '../user/entities/user.entity';
import { UserRole } from '../user/enums/user-role.enum';
import * as bcrypt from 'bcrypt';

async function run() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Administrator';

  if (!email || !password) {
    console.error(
      'Please set ADMIN_EMAIL and ADMIN_PASSWORD environment variables before running this script.',
    );
    process.exit(1);
  }

  try {
    await dataSource.initialize();
    const repo = dataSource.getRepository(User);

    const existing = await repo.findOne({ where: { email } });
    if (existing) {
      console.log('Admin user already exists, skipping.');
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const user = repo.create({
      email,
      password: hashed,
      name,
      role: UserRole.ADMIN,
    });

    await repo.save(user);

    console.log('Admin user created:', email);
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin user:', err);
    process.exit(1);
  }
}

void run();
