/**
 * Staging mode fail-closed guards.
 * Refuses live DB, live frontier paths, production conflicts, and active side-effects.
 */
import { resolve } from "node:path";
import { isLiveDatabaseUrl } from "@/lib/shadow/guard";

export type StagingGuardResult =
  | { ok: true; stagingId: string; databaseKind: "file" | "postgres" | "other" }
  | { ok: false; reason: string };

function norm(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function isLiveFrontierPath(p: string): boolean {
  const n = resolve(p).replace(/\\/g, "/").toLowerCase();
  return (
    n.includes("/opt/leadsniper/") ||
    n.includes("168.119.253.47") ||
    /\/prisma\/dev\.db/.test(n)
  );
}

export function assertStagingSafeOrThrow(env: NodeJS.ProcessEnv = process.env): StagingGuardResult {
  const staging = env.STAGING_MODE === "true" || env.STAGING_MODE === "1";
  if (!staging) {
    return { ok: false, reason: "STAGING_MODE must be true" };
  }

  if (env.SHADOW_MODE === "true" || env.SHADOW_MODE === "1") {
    return { ok: false, reason: "SHADOW_MODE must be false in staging acceptance" };
  }

  if (env.NODE_ENV === "production" && env.ALLOW_STAGING_IN_PRODUCTION !== "1") {
    return {
      ok: false,
      reason: "NODE_ENV=production conflicts with STAGING_MODE (set ALLOW_STAGING_IN_PRODUCTION=1 only for intentional staging hosts)",
    };
  }

  if (env.DISABLE_LIVE_DB !== "true" && env.DISABLE_LIVE_DB !== "1") {
    return { ok: false, reason: "DISABLE_LIVE_DB must be true" };
  }

  const stagingId = (env.STAGING_DATABASE_ID || "").trim();
  if (!stagingId) return { ok: false, reason: "STAGING_DATABASE_ID required" };

  const runId = (env.STAGING_RUN_ID || "").trim();
  if (!runId) return { ok: false, reason: "STAGING_RUN_ID required" };

  const url = norm(env.DATABASE_URL || "");
  if (!url) return { ok: false, reason: "DATABASE_URL required" };
  if (isLiveDatabaseUrl(url)) {
    return { ok: false, reason: "DATABASE_URL points to live/production — refused" };
  }

  const frontier = (env.FRONTIER_DB_PATH || "").trim();
  if (frontier && isLiveFrontierPath(frontier)) {
    return { ok: false, reason: "FRONTIER_DB_PATH points to live path — refused" };
  }

  const sideEffects = [
    ["DISABLE_EMAILS", env.DISABLE_EMAILS],
    ["DISABLE_WEBHOOKS", env.DISABLE_WEBHOOKS],
    ["DISABLE_CUSTOMER_NOTIFICATIONS", env.DISABLE_CUSTOMER_NOTIFICATIONS],
    ["DISABLE_PUBLIC_QUEUE_PUBLISH", env.DISABLE_PUBLIC_QUEUE_PUBLISH],
    ["DISABLE_PRODUCTION_CRON", env.DISABLE_PRODUCTION_CRON],
  ] as const;
  for (const [name, val] of sideEffects) {
    if (val !== "true" && val !== "1") {
      return { ok: false, reason: `${name} must be true in staging` };
    }
  }

  if (env.STAGING_ALLOW_DB_WRITE !== "true" && env.STAGING_ALLOW_DB_WRITE !== "1") {
    return { ok: false, reason: "STAGING_ALLOW_DB_WRITE must be true to mutate staging DB" };
  }

  const databaseKind = url.startsWith("file:")
    ? "file"
    : /^postgres/i.test(url)
      ? "postgres"
      : "other";

  return { ok: true, stagingId, databaseKind };
}

export function requireStagingIsolation(): void {
  const r = assertStagingSafeOrThrow();
  if (!r.ok) {
    console.error(`STAGING GUARD REFUSED: ${r.reason}`);
    process.exit(78);
  }
}
