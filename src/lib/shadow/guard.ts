/**
 * Shadow mode fail-closed guards.
 * SHADOW_MODE=true refuses to start against live DB paths/hosts.
 */
import { resolve } from "node:path";

const LIVE_SQLITE_MARKERS = [
  "/opt/leadsniper/prisma/dev.db",
  "\\opt\\leadsniper\\prisma\\dev.db",
];

const LIVE_HOST_MARKERS = [
  "168.119.253.47",
];

export type ShadowGuardResult =
  | { ok: true; databaseId: string; urlKind: "file" | "postgres" | "other" }
  | { ok: false; reason: string };

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

export function isLiveDatabaseUrl(databaseUrl: string): boolean {
  const u = normalizeUrl(databaseUrl);
  if (!u) return false;
  if (u.startsWith("file:")) {
    const path = u.replace(/^file:/, "");
    const abs = resolve(path);
    return LIVE_SQLITE_MARKERS.some((m) => path.includes(m) || abs.includes(m.replace(/\//g, "\\")));
  }
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (LIVE_HOST_MARKERS.includes(host)) return true;
    // Production Supabase used as shared live store — block in shadow unless explicitly allowlisted shadow id.
    if (/supabase\.co$/i.test(host) && process.env.SHADOW_ALLOW_SUPABASE !== "1") {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function assertShadowSafeOrThrow(env: NodeJS.ProcessEnv = process.env): ShadowGuardResult {
  const shadow = env.SHADOW_MODE === "true" || env.SHADOW_MODE === "1";
  if (!shadow) {
    return { ok: false, reason: "SHADOW_MODE must be true for shadow execution" };
  }

  const databaseId = (env.SHADOW_DATABASE_ID || "").trim();
  if (!databaseId) {
    return { ok: false, reason: "SHADOW_DATABASE_ID is required" };
  }

  const runId = (env.SHADOW_RUN_ID || "").trim();
  if (!runId) {
    return { ok: false, reason: "SHADOW_RUN_ID is required" };
  }

  const url = normalizeUrl(env.DATABASE_URL || "");
  if (!url) {
    return { ok: false, reason: "DATABASE_URL is required" };
  }

  if (isLiveDatabaseUrl(url)) {
    return {
      ok: false,
      reason: "DATABASE_URL points to a live/production database — refused in SHADOW_MODE",
    };
  }

  // Explicit shadow write gate
  if (env.SHADOW_ALLOW_DB_WRITE !== "true" && env.SHADOW_ALLOW_DB_WRITE !== "1") {
    return { ok: false, reason: "SHADOW_ALLOW_DB_WRITE must be true to mutate the shadow database" };
  }

  // Side-effect channels must be disabled
  const sideEffects = [
    ["DISABLE_EMAILS", env.DISABLE_EMAILS],
    ["DISABLE_WEBHOOKS", env.DISABLE_WEBHOOKS],
    ["DISABLE_CUSTOMER_NOTIFICATIONS", env.DISABLE_CUSTOMER_NOTIFICATIONS],
    ["DISABLE_PUBLIC_QUEUE_PUBLISH", env.DISABLE_PUBLIC_QUEUE_PUBLISH],
    ["DISABLE_PRODUCTION_CRON", env.DISABLE_PRODUCTION_CRON],
  ] as const;
  for (const [name, val] of sideEffects) {
    if (val !== "true" && val !== "1") {
      return { ok: false, reason: `${name} must be true in shadow mode` };
    }
  }

  const urlKind = url.startsWith("file:")
    ? "file"
    : /^postgres/i.test(url)
      ? "postgres"
      : "other";

  return { ok: true, databaseId, urlKind };
}

/** Call at process start for shadow scripts. */
export function requireShadowIsolation(): void {
  const r = assertShadowSafeOrThrow();
  if (!r.ok) {
    console.error(`SHADOW GUARD REFUSED: ${r.reason}`);
    process.exit(78); // EX_CONFIG
  }
}
