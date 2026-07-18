#!/usr/bin/env node
/** Wrapper quarantine — delega ad audit; --apply bloccato senza SHADOW_ALLOW_APPLY=1 */
import { spawnSync } from "node:child_process";

if (process.argv.includes("--apply") && process.env.SHADOW_ALLOW_APPLY !== "1") {
  console.error("REFUSED: --apply richiede SHADOW_ALLOW_APPLY=1 (fase shadow locale). DB live vietato.");
  process.exit(2);
}

const r = spawnSync(
  "npx",
  ["tsx", "scripts/sanita-legacy-audit.mjs", ...process.argv.slice(2)],
  { stdio: "inherit", shell: true }
);
process.exit(r.status ?? 1);
