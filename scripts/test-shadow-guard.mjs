import assert from "node:assert/strict";
import {
  assertShadowSafeOrThrow,
  isLiveDatabaseUrl,
} from "../src/lib/shadow/guard.ts";

function baseEnv(over = {}) {
  return {
    SHADOW_MODE: "true",
    SHADOW_DATABASE_ID: "giorgio-shadow-20260718",
    SHADOW_ALLOW_DB_WRITE: "true",
    DISABLE_EMAILS: "true",
    DISABLE_WEBHOOKS: "true",
    DISABLE_CUSTOMER_NOTIFICATIONS: "true",
    DISABLE_PUBLIC_QUEUE_PUBLISH: "true",
    DISABLE_PRODUCTION_CRON: "true",
    DATABASE_URL: "file:./data/shadow/db/giorgio-shadow-20260718.db",
    ...over,
  };
}

assert.equal(isLiveDatabaseUrl("file:/opt/leadsniper/prisma/dev.db"), true);
assert.equal(isLiveDatabaseUrl("file:./data/shadow/db/giorgio-shadow-20260718.db"), false);

const liveRefuse = assertShadowSafeOrThrow(
  baseEnv({ DATABASE_URL: "file:/opt/leadsniper/prisma/dev.db" })
);
assert.equal(liveRefuse.ok, false);
assert.match(liveRefuse.reason, /live|production/i);

const ok = assertShadowSafeOrThrow(baseEnv());
assert.equal(ok.ok, true);

const noMode = assertShadowSafeOrThrow(baseEnv({ SHADOW_MODE: "false" }));
assert.equal(noMode.ok, false);

console.log("✓ shadow guard: live DB refused; shadow path allowed");
