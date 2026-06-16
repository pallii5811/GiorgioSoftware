import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();
let dbUrl = process.env.DATABASE_URL || "";

if (!dbUrl) {
  try {
    const envPath = path.join(root, ".env");
    const raw = fs.readFileSync(envPath, "utf8");
    const line = raw
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && l.toUpperCase().startsWith("DATABASE_URL="));
    if (line) {
      const v = line.split("=", 2)[1] ?? "";
      dbUrl = v.trim().replace(/^"|"$/g, "");
    }
  } catch {
    // ignore
  }
}

const isSqlite = /^file:/i.test(dbUrl);
const schema = isSqlite
  ? path.join(root, "prisma", "schema.sqlite.prisma")
  : path.join(root, "prisma", "schema.prisma");

console.log(`[prisma-smart] DATABASE_URL=${dbUrl ? dbUrl.split(":")[0] + ":" : "(missing)"}`);
console.log(`[prisma-smart] schema=${schema}`);

// Su Postgres (Supabase) `DIRECT_URL` può essere richiesto dallo schema:
// se manca, usiamo DATABASE_URL come fallback (non cambia runtime).
if (!isSqlite && !process.env.DIRECT_URL && dbUrl) {
  process.env.DIRECT_URL = dbUrl;
}

function run(cmd, args) {
  console.log(`[prisma-smart] run: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (r.error) {
    console.error(`[prisma-smart] error: ${r.error.message}`);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
run(npx, ["prisma", "generate", "--schema", schema]);
run(npx, ["prisma", "db", "push", "--schema", schema]);

