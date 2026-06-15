import { prisma } from "@/lib/prisma";

let dbReady: Promise<void> | null = null;

function isSqliteUrl(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().startsWith("file:");
}

/** SQLite: WAL + busy_timeout. Postgres/Supabase: no-op. */
export function ensureSqliteWal(): Promise<void> {
  if (!dbReady) {
    dbReady = (async () => {
      if (!isSqliteUrl()) return;
      await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
      await prisma.$executeRawUnsafe("PRAGMA busy_timeout=60000").catch(() => {});
      await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL").catch(() => {});
    })();
  }
  return dbReady;
}

export const ensureDbReady = ensureSqliteWal;

export { prisma };
