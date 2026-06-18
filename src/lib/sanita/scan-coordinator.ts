import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LIVE_SCAN_LOCK_PATH = path.join(process.cwd(), ".live-scan.lock");
const LIVE_SCAN_LOCK_TTL_MS = 6 * 60 * 60_000;

type LiveScanLock = { region: string; pid: number; startedAt: string };

/** Ferma solo la pipeline batch — NON killare Chromium (serve a Playwright della UI). */
export async function stopBatchPipeline(): Promise<void> {
  await execFileAsync("bash", ["-lc", "pkill -9 -f hetzner-full-pipeline 2>/dev/null || true"]).catch(
    () => {}
  );

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
  // Lock analisi legacy (rimossi) — pulizia per evitare REVIEW falsi dopo deploy/restart.
  await fsPromises.rm(path.join(process.cwd(), ".scan-locks"), { recursive: true, force: true }).catch(() => {});
  const payload: LiveScanLock = { region, pid: process.pid, startedAt: new Date().toISOString() };
  await fsPromises.writeFile(LIVE_SCAN_LOCK_PATH, JSON.stringify(payload), "utf8");
}

export async function releaseLiveScanLock(): Promise<void> {
  await fsPromises.unlink(LIVE_SCAN_LOCK_PATH).catch(() => {});
}
