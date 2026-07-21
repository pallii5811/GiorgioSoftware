/**
 * Fresh region-canary on Hetzner blue: 3 pinned leads, forceRescan, noResume.
 * Does NOT touch giorgio-revalidate or checkpoint 877.
 */
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const HETZNER = process.env.HETZNER_HOST || "root@168.119.253.47";
const API = process.env.HETZNER_API || "http://168.119.253.47:3000";
const PINNED = [
  { id: "cmrukbcco0002126387vm7gse", companyName: "Casa di Cura Santa Rita - NefroCenter", city: "Atripalda" },
  { id: "cmqktyimz000i111hygme29nh", companyName: "Casa Di Cura Malzoni Villa Platani Spa", city: "Villanova del Battista" },
  { id: "cmqklex5q00bh108eq9blm01k", companyName: "Villa Dei Pini Casa di Cura Privata S.p.a.", city: "Villamaina" },
];

function api(path, init) {
  return fetch(`${API}${path}`, init).then(async (res) => ({
    ok: res.ok,
    json: await res.json().catch(() => null),
  }));
}

function snapLeads() {
  return api("/api/sanita?region=Campania&includeAll=1").then((r) => {
    const data = r.json?.data || [];
    return Object.fromEntries(
      PINNED.map((p) => {
        const l = data.find((x) => x.id === p.id);
        return [
          p.id,
          {
            companyName: l?.companyName,
            lastScannedAt: l?.lastScannedAt || null,
            evidence: l?.evidence || "",
          },
        ];
      })
    );
  });
}

function ssh(cmd) {
  return execSync(`ssh -o BatchMode=yes ${HETZNER} ${JSON.stringify(cmd)}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main() {
  const before = await snapLeads();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    mode: "region-canary",
    status: "queued",
    targetKey: `region-canary:${jobId}`,
    region: "Campania",
    city: null,
    leadId: null,
    targetTotal: 3,
    processed: 0,
    resumedFrom: null,
    noResume: true,
    namespace: `data/sanita-jobs/${jobId}`,
    canaryLeadIds: PINNED.map((p) => p.id),
    canaryLeads: PINNED,
    forceRescan: true,
    skipExistingEvidence: false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: now,
    lastUpdateLabel: "In attesa",
    resumable: true,
    cancelRequested: false,
    pid: null,
    progress: {
      structuresControlled: 0,
      totalStructures: 3,
      certifiedResults: 0,
      autoVerificationsPending: 0,
      manualChecksNeeded: 0,
      percent: 0,
      currentMessage: "Job in coda.",
      currentStructure: null,
    },
    errorMessage: null,
  };

  const jobJson = JSON.stringify(job);
  const checkpoint = JSON.stringify({
    jobId,
    mode: "region-canary",
    targetTotal: 3,
    processed: 0,
    resumedFrom: null,
    noResume: true,
    region: "Campania",
    leadIds: PINNED.map((p) => p.id),
    leads: PINNED,
    createdAt: now,
  });

  ssh(
    `set -euo pipefail; APP=/opt/leadsniper; JID=${jobId}; mkdir -p "$APP/data/sanita-jobs/$JID"; ` +
      `printf '%s' '${jobJson.replace(/'/g, "'\\''")}' > "$APP/data/sanita-jobs/$JID.json"; ` +
      `printf '%s' '${checkpoint.replace(/'/g, "'\\''")}' > "$APP/data/sanita-jobs/$JID/checkpoint.json"`
  );

  ssh(
    `cd /opt/leadsniper && nohup node node_modules/tsx/dist/cli.mjs scripts/sanita-job-runner.mjs ${jobId} > /tmp/sanita-job-${jobId}.log 2>&1 &`
  );

  const t0 = Date.now();
  let final = null;
  while (Date.now() - t0 < 600_000) {
    const j = await api(`/api/sanita/jobs/${jobId}`);
    final = j.json?.job;
    if (final?.status === "completed" || final?.status === "failed" || final?.status === "cancelled") break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const after = await snapLeads();
  const perLead = PINNED.map((p) => {
    const b = before[p.id];
    const a = after[p.id];
    const rescanned =
      Boolean(a?.lastScannedAt) &&
      (!b?.lastScannedAt || Date.parse(a.lastScannedAt) > Date.parse(b.lastScannedAt));
    const evidenceChanged = (b?.evidence || "") !== (a?.evidence || "");
    return {
      id: p.id,
      companyName: p.companyName,
      beforeLastScannedAt: b?.lastScannedAt || null,
      afterLastScannedAt: a?.lastScannedAt || null,
      evidenceChanged,
      rescanned,
    };
  });

  const report = {
    jobId,
    finalStatus: final?.status,
    processed: final?.processed,
    structuresControlled: final?.progress?.structuresControlled,
    perLead,
    pass:
      final?.status === "completed" &&
      final?.progress?.structuresControlled === 3 &&
      perLead.every((l) => l.rescanned),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
