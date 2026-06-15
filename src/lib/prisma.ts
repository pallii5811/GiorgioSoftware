import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (!globalForPrisma.prisma) {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("file:")) {
    prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
    prisma.$executeRawUnsafe("PRAGMA busy_timeout=30000").catch(() => {});
  }
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
