import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { websiteHostKey } from "@/lib/sanita/lead-dedup";

const execFileAsync = promisify(execFile);

export const LIVE_SCAN_LOCK_PATH = path.join(process.cwd(), ".live-scan.lock");
export const SCAN_LOCK_DIR = path.join(process.cwd(), ".scan-locks");
const LIVE_SCAN_LOCK_TTL_MS = 6 * 60 * 60_000;

type LiveScanLock = { region: string; pid: number; startedAt: string };

function lockPathFor(key: string): string {
  return path.join(SCAN_LOCK_DIR, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

/** Lock file presente (analisi in corso su questo lead o host). */
export function isAnalysisLockHeld(key: string): boolean {
  try {
    const p = lockPathFor(key);
    if (!fs.existsSync(p)) return false;
    const stat = fs.statSync(p);
    // Lock stantio > 2h: considerato abbandonato.
    if (Date.now() - stat.mtimeMs > 2 * 60 * 60_000) {
      fs.unlinkSync(p);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isLeadUnderAnalysis(leadId: string, website?: string | null): boolean {
  if (isAnalysisLockHeld(leadId)) return true;
  const host = websiteHostKey(website);
  return host ? isAnalysisLockHeld(`host:${host}`) : false;
}

async function acquireLock(key: string, maxWaitMs = 60_000): Promise<() => Promise<void>> {
  await fsPromises.mkdir(SCAN_LOCK_DIR, { recursive: true });
  const p = lockPathFor(key);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await fsPromises.writeFile(p, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
      return async () => {
        await fsPromises.unlink(p).catch(() => {});
      };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Timeout lock analisi (${key})`);
}

/** Serializza analisi per lead + host (evita dedup che cancella record in crawl). */
export async function withLeadAnalysisLock<T>(
  leadId: string,
  website: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const keys = [leadId];
  const host = websiteHostKey(website);
  if (host) keys.push(`host:${host}`);

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const key of keys) {
      releases.push(await acquireLock(key));
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) {
      await release();
    }
  }
}

/** Ferma la pipeline batch — evita doppio motore sullo stesso SQLite. */
export async function stopBatchPipeline(): Promise<void> {
  await execFileAsync("bash", ["-lc", "pkill -TERM -f hetzner-full-pipeline 2>/dev/null || true"]).catch(
    () => {}
  );
  await execFileAsync("bash", [
    "-lc",
    "pkill -TERM -f chrome-headless-shell 2>/dev/null || true; pkill -TERM -f chromium 2>/dev/null || true",
  ]).catch(() => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("bash", ["-lc", "pgrep -f hetzner-full-pipeline || true"]);
      if (!stdout.trim()) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function isLiveScanLockActive(): Promise<boolean> {
  try {
    const raw = await fsPromises.readFile(LIVE_SCAN_LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LiveScanLock>;
    const started = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    if (!Number.isFinite(started) || Date.now() - started > LIVE_SCAN_LOCK_TTL_MS) {
      await fsPromises.unlink(LIVE_SCAN_LOCK_PATH).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Blocca il watchdog batch finché la UI esegue scansione live. */
export async function acquireLiveScanLock(region: string): Promise<void> {
  await stopBatchPipeline();
  const payload: LiveScanLock = { region, pid: process.pid, startedAt: new Date().toISOString() };
  await fsPromises.writeFile(LIVE_SCAN_LOCK_PATH, JSON.stringify(payload), "utf8");
}

export async function releaseLiveScanLock(): Promise<void> {
  await fsPromises.unlink(LIVE_SCAN_LOCK_PATH).catch(() => {});
}
