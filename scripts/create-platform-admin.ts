/**
 * Creates (or resets the password of) a platform admin. There is deliberately no HTTP route for
 * this: platform admins are our own staff and are created from a shell with database access.
 *
 *   PLATFORM_ADMIN_EMAIL=ops@example.com PLATFORM_ADMIN_PASSWORD='...' npm run platform-admin:create
 *
 * The password comes from the environment so it never lands in shell history as an argument.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  // Emails are stored trimmed and lower-cased (same rule as every other account).
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.platformAdmin.upsert({
      where: { email },
      create: { email, passwordHash },
      update: { passwordHash },
      select: { id: true, email: true },
    });
    console.log(`Platform admin ready: ${admin.email} (${admin.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
