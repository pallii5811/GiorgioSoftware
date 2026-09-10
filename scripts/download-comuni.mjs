/**
 * Genera data/comuni.json dalla fonte ufficiale ISTAT corrente.
 * Richiede Python 3 + openpyxl.
 *
 * Uso: npx tsx scripts/download-comuni.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const source =
  "https://www.istat.it/storage/codici-unita-amministrative/Elenco-comuni-italiani.xlsx";
const workbook = join(tmpdir(), "istat-comuni-current.xlsx");
const response = await fetch(source, {
  headers: { "User-Agent": "giorgio-software/territorio-italia" },
});
if (!response.ok) throw new Error(`ISTAT ha risposto HTTP ${response.status}`);
writeFileSync(workbook, Buffer.from(await response.arrayBuffer()));

const candidates =
  process.platform === "win32"
    ? ["python", "py"]
    : ["python3", "python"];

let last = null;
for (const command of candidates) {
  const args =
    command === "py"
      ? ["-3", "scripts/download-comuni.py", workbook]
      : ["scripts/download-comuni.py", workbook];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  last = result;
  if (!result.error && result.status === 0) process.exit(0);
}

console.error("Impossibile eseguire Python 3 con openpyxl.");
process.exit(last?.status || 1);
