/**
 * Verifica server-side su Hetzner blue (audit apply, lock, SHA, zombie).
 */
import { execFileSync } from "node:child_process";

const HETZNER = process.env.HETZNER_HOST || "root@168.119.253.47";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
  })
);

function sshRunPython(pythonSource) {
  const b64 = Buffer.from(pythonSource).toString("base64");
  const cmd = `python3 -c "import base64; exec(base64.b64decode('${b64}').decode())"`;
  const out = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HETZNER, cmd], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(out.trim());
}

const jobId = args.jobId || "";
const leadId = args.leadId || "";
const targetKey = args.targetKey || (leadId ? `single:${leadId}` : "");
const expectLock = args.expectLock === "1";

const py = `
import json, os, base64
job_id=${JSON.stringify(jobId)}
lead_id=${JSON.stringify(leadId)}
target_key=${JSON.stringify(targetKey)}
APP="/opt/leadsniper"
out={"releaseSha": None, "auditExists": False, "audit": None, "lockExists": False, "lock": None, "zombieCount": 0}
try:
  out["releaseSha"]=open(f"{APP}/RELEASE_SHA").read().strip()
except Exception as e:
  out["releaseShaError"]=str(e)
if job_id and lead_id:
  audit=f"{APP}/data/sanita-jobs/{job_id}/certified-apply-{lead_id}.json"
  out["auditPath"]=audit
  if os.path.isfile(audit):
    out["auditExists"]=True
    out["audit"]=json.load(open(audit))
if target_key:
  safe=base64.urlsafe_b64encode(target_key.encode()).decode().rstrip("=")
  lock=f"{APP}/data/sanita-jobs/locks/{safe}.lock"
  out["lockPath"]=lock
  if os.path.isfile(lock):
    out["lockExists"]=True
    try:
      out["lock"]=json.load(open(lock))
    except Exception:
      pass
jobs_dir=f"{APP}/data/sanita-jobs"
z=0
if os.path.isdir(jobs_dir):
  for name in os.listdir(jobs_dir):
    if not name.endswith(".json"):
      continue
    try:
      j=json.load(open(os.path.join(jobs_dir,name)))
    except Exception:
      continue
    if j.get("status") in ("queued","running") and j.get("pid"):
      z+=1
out["zombieCount"]=z
print(json.dumps(out))
`;

const result = sshRunPython(py);
console.log(JSON.stringify(result, null, 2));

let ok = true;
const failOnError = args.failOnError === "1";
if (args.requireSha) {
  const want = args.requireSha;
  const got = result.releaseSha || "";
  if (got !== want && !got.startsWith(want.slice(0, 7))) {
    console.error(`RELEASE_SHA mismatch: ${got} != ${want}`);
    ok = false;
  }
}
if (jobId && leadId && args.requireAudit === "1" && !result.auditExists) {
  console.error("audit missing on server");
  ok = false;
}
if (targetKey && expectLock === false && result.lockExists) {
  console.error("lock still present:", result.lock);
  ok = false;
}
if (args.requireZombieZero === "1" && result.zombieCount > 0) {
  console.error(`zombieCount=${result.zombieCount}`);
  ok = false;
}
process.exit(failOnError && !ok ? 1 : 0);
