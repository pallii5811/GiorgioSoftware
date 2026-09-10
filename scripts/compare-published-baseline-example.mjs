/**
 * Example old/new compare against immutable published baseline (read-only).
 * Usage: node scripts/compare-published-baseline-example.mjs
 */
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.env.BASELINE_DIR ||
  path.join("data", "baseline", "published-legacy-remote-sample");
const API = process.env.API_URL || "http://168.119.253.47:3000";
const LEAD_ID = process.env.LEAD_ID || "cmqkld5rt009n108es4nx3g1j";

function classify(oldRec, newLead) {
  const oldState = oldRec?.statoValidazione || null;
  const newEv = newLead?.evidence || "";
  const newState = (newEv.match(/\[(?:PS|STATE):([^\]]+)\]/i) || [])[1] || null;
  const oldDocs = oldRec?.urlDocumentoOPagina || null;
  const newDocs = (newEv.match(/\[DOCS:\s*([^\]]+)\]/i) || [])[1]?.trim() || null;
  if (!newLead) return "TECHNICAL_UNRESOLVED";
  if (oldState === newState && oldDocs === newDocs) return "CONFIRMED";
  if (/PUBLISHED_CURRENT/i.test(newState || "") && /EXPIRED|UNKNOWN|HOT|REV/i.test(oldState || ""))
    return "UPGRADED";
  if (/PUBLISHED/i.test(oldState || "") && !/PUBLISHED/i.test(newState || "")) return "REGRESSION";
  if (/PUBLISHED/i.test(oldState || "") && /PUBLISHED/i.test(newState || "") && oldState !== newState)
    return "UPDATED";
  if (/PUBLISHED/i.test(oldState || "") && !newDocs) return "FALSE_LEGACY";
  return "LEGACY_UNVERIFIED";
}

const remoteManifest = {
  path: "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z",
  count: 117,
  jsonSha256: "5e93be5d8dd71384f9773138b5b1392c40f5550535266f39671e11af60d22894",
};

const api = await fetch(`${API}/api/sanita?region=Campania&includeAll=1`);
const body = await api.json();
const lead = (body.data || []).find((l) => l.id === LEAD_ID);

// Fetch baseline record via SSH-less sample: embed from known backup fields if local missing
let oldRec = null;
const localJson = path.join(BASE, "published-legacy-baseline.json");
if (fs.existsSync(localJson)) {
  const d = JSON.parse(fs.readFileSync(localJson, "utf8"));
  oldRec = d.records.find((r) => r.leadId === LEAD_ID);
} else {
  oldRec = {
    leadId: LEAD_ID,
    struttura: "Casa Di Cura 'Villa Fiorita' S.p.A.",
    vecchioVerdetto: "PUB",
    statoValidazione: "PUBLISHED_CURRENT",
    urlDocumentoOPagina:
      "https://villafioritacapua.it/wp-content/uploads/2026/02/2026RCG00376_Villa-Fiorita_Polizza-Appendice-N.-01_signed-signed.pdf",
    crmStatus: "NEW",
    hashRecord: "7f3333d843d11bcea57e2352e8b96bc90b7334c5be01259f685a9907890461fc",
    source: remoteManifest.path,
  };
}

const status = classify(oldRec, lead);
const out = {
  baseline: remoteManifest,
  leadId: LEAD_ID,
  old: {
    verdetto: oldRec.vecchioVerdetto,
    stato: oldRec.statoValidazione,
    docs: oldRec.urlDocumentoOPagina,
    crm: oldRec.crmStatus,
    hashRecord: oldRec.hashRecord,
  },
  new: {
    verdetto: (lead?.evidence || "").match(/^\[V:(\w+)\]/)?.[1] || null,
    stato: (lead?.evidence || "").match(/\[(?:PS|STATE):([^\]]+)\]/)?.[1] || null,
    docs: (lead?.evidence || "").match(/\[DOCS:\s*([^\]]+)\]/i)?.[1]?.trim() || null,
    crm: lead?.status || null,
    actionable: !!lead?._actionable,
  },
  compareStatus: status,
  crmPreserved: oldRec.crmStatus === (lead?.status || null),
};
console.log(JSON.stringify(out, null, 2));
