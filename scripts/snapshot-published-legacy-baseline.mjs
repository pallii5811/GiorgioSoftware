/**
 * Immutable snapshot of legacy Published / PUB-like healthcare leads from live DB (via Hetzner API or local).
 * Does NOT modify the DB. Writes JSON + CSV + checksum sidecar.
 *
 * Usage (from Hetzner or with DATABASE_URL):
 *   DATABASE_URL=file:/opt/leadsniper/prisma/dev.db node scripts/snapshot-published-legacy-baseline.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const OUT_ROOT =
  process.env.BASELINE_OUT ||
  path.join("data", "baseline", `published-legacy-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const prisma = new PrismaClient();

function recordHash(obj) {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function extractDocsUrl(evidence) {
  const m = (evidence || "").match(/\[DOCS:\s*([^\]]+)\]/i);
  return m ? m[1].trim() : null;
}

function extractVerdict(evidence) {
  const m = (evidence || "").match(/^\[V:(PUB|HOT|REV)\]/i);
  return m ? m[1].toUpperCase() : null;
}

function extractProcessingState(evidence) {
  const m = (evidence || "").match(/\[(?:PS|STATE):([^\]]+)\]/i);
  return m ? m[1].trim() : null;
}

function isPublishedLike(lead) {
  const ev = lead.evidence || "";
  if (/^\[V:PUB\]/i.test(ev)) return true;
  if (/\[(?:PS|STATE|BV):PUBLISHED_/i.test(ev)) return true;
  if (lead.policyFound === true && /\[DOCS:/i.test(ev)) return true;
  return false;
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const leads = await prisma.lead.findMany({
    where: { type: "HEALTHCARE" },
    select: {
      id: true,
      companyName: true,
      region: true,
      city: true,
      website: true,
      policyFound: true,
      policyCompany: true,
      policyNumber: true,
      policyExpiry: true,
      policyMassimale: true,
      evidence: true,
      lastScannedAt: true,
      status: true,
      notes: true,
      confidence: true,
    },
  });

  const published = leads.filter(isPublishedLike);
  const createdAt = new Date().toISOString();
  const records = published.map((l) => {
    const base = {
      leadId: l.id,
      struttura: l.companyName,
      regione: l.region,
      citta: l.city,
      website: l.website,
      vecchioVerdetto: extractVerdict(l.evidence),
      statoValidazione: extractProcessingState(l.evidence),
      policyFound: l.policyFound,
      compagnia: l.policyCompany,
      numeroPolizza: l.policyNumber,
      scadenza: l.policyExpiry,
      massimale: l.policyMassimale,
      evidenceCompleta: l.evidence,
      urlDocumentoOPagina: extractDocsUrl(l.evidence),
      lastScannedAt: l.lastScannedAt ? new Date(l.lastScannedAt).toISOString() : null,
      crmStatus: l.status,
      crmNotes: l.notes,
      confidence: l.confidence,
    };
    return { ...base, hashRecord: recordHash(base) };
  });

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const jsonPath = path.join(OUT_ROOT, "published-legacy-baseline.json");
  const csvPath = path.join(OUT_ROOT, "published-legacy-baseline.csv");
  const metaPath = path.join(OUT_ROOT, "MANIFEST.json");

  const payload = {
    schemaVersion: 1,
    immutable: true,
    createdAt,
    source: process.env.DATABASE_URL || "prisma",
    selectionRule:
      "[V:PUB] OR [STATE|PS|BV]:PUBLISHED_* OR (policyFound && [DOCS:])",
    count: records.length,
    records,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const headers = [
    "leadId",
    "struttura",
    "regione",
    "citta",
    "vecchioVerdetto",
    "statoValidazione",
    "compagnia",
    "numeroPolizza",
    "scadenza",
    "massimale",
    "urlDocumentoOPagina",
    "lastScannedAt",
    "crmStatus",
    "hashRecord",
    "evidenceCompleta",
  ];
  const lines = [headers.join(",")];
  for (const r of records) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  fs.writeFileSync(csvPath, lines.join("\n"), "utf8");

  const jsonSha = crypto.createHash("sha256").update(fs.readFileSync(jsonPath)).digest("hex");
  const csvSha = crypto.createHash("sha256").update(fs.readFileSync(csvPath)).digest("hex");
  const manifest = {
    createdAt,
    count: records.length,
    paths: { json: jsonPath, csv: csvPath },
    checksums: {
      "published-legacy-baseline.json": jsonSha,
      "published-legacy-baseline.csv": csvSha,
    },
    note: "Immutable baseline — revalidation must not overwrite this directory.",
  };
  fs.writeFileSync(metaPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_ROOT, "SHA256SUMS"), `${jsonSha}  published-legacy-baseline.json\n${csvSha}  published-legacy-baseline.csv\n`);

  console.log(JSON.stringify(manifest, null, 2));
  console.log(`BASELINE_OK count=${records.length} dir=${OUT_ROOT}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
