import fs from "node:fs";
import path from "node:path";
import { getSanitaJobsDir } from "@/lib/sanita/jobs";

export type JobTargetLock = {
  jobId: string;
  targetKey: string;
  pid: number | null;
  acquiredAt: string;
};

function locksDir() {
  const dir = path.join(getSanitaJobsDir(), "locks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(targetKey: string) {
  const safe = Buffer.from(targetKey).toString("base64url");
  return path.join(locksDir(), `${safe}.lock`);
}

export function readJobTargetLock(targetKey: string): JobTargetLock | null {
  const file = lockPath(targetKey);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as JobTargetLock;
  } catch {
    return null;
  }
}

export function acquireJobTargetLock(
  targetKey: string,
  jobId: string,
  pid: number | null
): JobTargetLock {
  const payload: JobTargetLock = {
    jobId,
    targetKey,
    pid,
    acquiredAt: new Date().toISOString(),
  };
  const file = lockPath(targetKey);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return payload;
}

/** Rilascia solo se il lock appartiene a jobId. */
export function releaseJobTargetLock(targetKey: string, jobId: string): boolean {
  const file = lockPath(targetKey);
  if (!fs.existsSync(file)) return false;
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as JobTargetLock;
    if (current.jobId !== jobId) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
