import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create admin user
  const hashedPassword = await bcrypt.hash('admin123', 10);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@mad.com' },
    update: {},
    create: {
      email: 'admin@mad.com',
      passwordHash: hashedPassword,
      role: 'ADMIN',
      active: true,
    },
  });

  console.log('✅ Admin user created:', adminUser.email);

  // Create viewer user
  const viewerPassword = await bcrypt.hash('viewer123', 10);

  const viewerUser = await prisma.user.upsert({
    where: { email: 'viewer@mad.com' },
    update: {},
    create: {
      email: 'viewer@mad.com',
      passwordHash: viewerPassword,
      role: 'VIEWER',
      active: true,
    },
  });

  console.log('✅ Viewer user created:', viewerUser.email);

  // Create reference genres (static reference data)
  const genres = ['Pop', 'Rock', 'Hip-Hop', 'Electronic', 'R&B', 'Country', 'Jazz', 'Classical'];
  for (const genreName of genres) {
    await prisma.genre.upsert({
      where: { name: genreName },
      update: {},
      create: { name: genreName },
    });
  }
  console.log('✅ Reference genres created');

  console.log('🎉 Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
