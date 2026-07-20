#!/usr/bin/env node
/**
 * Batch1 V2 review packs — 25+25+25+25 from fullcrawl + Veneto ingest + Campania reclass.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "docs/human-review/shadow-batch1-v2");
const CRAWL = path.join(ROOT, "data/shadow/crawl/fullcrawl-results-deduped.jsonl");
const CRAWL_FALLBACK = path.join(ROOT, "data/shadow/crawl/fullcrawl-results.jsonl");
const VENETO = path.join(ROOT, "data/shadow/ingest/veneto-g1-selected.json");
const PRELIM = path.join(ROOT, "docs/shadow/batch1/run-summary.json");

fs.mkdirSync(OUT, { recursive: true });

const SANITA_FIELDS = [
  "id","struttura","sede","categoria","vecchio_verdict","preliminary_verdict","nuovo_verdict",
  "sito","identity_status","crawl_complete","pagine","documento","compagnia","numero_polizza",
  "motivazione","score","errori","legacy_class","origin","reviewer","reviewed_at",
  "entity_correct","website_correct","identity_correct","document_belongs_to_entity",
  "verdict_correct","commercial_value_real","false_positive","false_negative",
  "critical_contamination","notes",
];

const GARE_FIELDS = [
  "id","CIG","oggetto","vincitore","regione","stazione_appaltante","data","importo",
  "contract_type","category","tier","score","cauzione","cauzione_tipo","insurance_need_status",
  "origin","region_match_via","motivazione","reviewer","reviewed_at",
  "winner_correct","award_status_correct","amount_correct","commercial_value_real",
  "false_positive","false_negative","notes",
];

function esc(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csv(fields, rows) {
  return [fields.join(","), ...rows.map((r) => fields.map((f) => esc(r[f])).join(","))].join("\n");
}
function html(title, fields, rows) {
  const th = fields.map((f) => `<th>${f}</th>`).join("");
  const body = rows
    .map((r) => {
      const tds = fields
        .map((f) => {
          let v = r[f] ?? "";
          if (typeof v === "string" && /^https?:\/\//i.test(v)) {
            v = `<a href="${v.replace(/"/g, "")}" target="_blank" rel="noopener">${v}</a>`;
          } else {
            v = String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }
          return `<td>${v}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>${title}</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;margin:1rem}.b{background:#fff3cd;border:1px solid #ffc107;padding:12px;margin-bottom:1rem}
table{border-collapse:collapse;width:100%;font-size:11px}th,td{border:1px solid #ccc;padding:4px;max-width:220px;word-break:break-word}
th{background:#eee;position:sticky;top:0}a{color:#0645ad}</style></head><body>
<div class="b"><strong>Record revisionati da umano: 0</strong> — pack V2 post full-crawl / ingest ufficiale.</div>
<h1>${title}</h1>
<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function prioritySanita(r) {
  let p = 50;
  if (r.nuovo_verdict === "HOT") p = 1;
  else if (r.nuovo_verdict === "PUBLISHED") p = 2;
  else if (r.vecchio_verdict === "HOT" || r.vecchio_verdict === "PUBLISHED") p = 4;
  if (/MISMATCH|conflict/i.test(r.identity_status || "")) p = Math.min(p, 5);
  if (/scaduta/i.test(r.motivazione || "")) p = Math.min(p, 8);
  return p;
}

const crawlRows = fs.existsSync(CRAWL)
  ? fs.readFileSync(CRAWL, "utf8").split(/\n+/).filter(Boolean).map((l) => JSON.parse(l))
  : fs.existsSync(CRAWL_FALLBACK)
    ? fs.readFileSync(CRAWL_FALLBACK, "utf8").split(/\n+/).filter(Boolean).map((l) => JSON.parse(l))
    : [];

function sanitaPack(region) {
  const rows = crawlRows
    .filter((r) => r.region === region)
    .map((r) => ({
      id: r.id,
      struttura: r.companyName || "",
      sede: `${r.city || ""} (${region})`,
      categoria: "",
      vecchio_verdict: r.oldVerdict,
      preliminary_verdict: r.preliminaryVerdict || "REVIEW",
      nuovo_verdict: r.newVerdict,
      sito: r.website || "",
      identity_status: r.identityStatus,
      crawl_complete: r.crawlComplete,
      pagine: r.pagesVisited ?? "",
      documento: r.policyFound ? "policy_signal" : "",
      compagnia: r.policyCompany || "",
      numero_polizza: r.policyNumber || "",
      motivazione: r.evidenceHead || r.error || "",
      score: "",
      errori: r.error || "",
      legacy_class: r.legacyClass || "",
      origin: "IMMUTABLE_PRODUCTION_SNAPSHOT",
      reviewer: "",
      reviewed_at: "",
      entity_correct: "",
      website_correct: "",
      identity_correct: "",
      document_belongs_to_entity: "",
      verdict_correct: "",
      commercial_value_real: "",
      false_positive: "",
      false_negative: "",
      critical_contamination: "",
      notes: r.technicalFailure ? "TECH_FAILURE" : "",
    }))
    .sort((a, b) => prioritySanita(a) - prioritySanita(b));
  return rows;
}

const campSel = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/shadow/batch1/gare-selection-campania.json"), "utf8")
);
const campScoredPath = path.join(ROOT, "data/shadow/batch1/gare-campania-scored.json");
const campFull = path.join(ROOT, "data/shadow/batch1/gare-campania-full.json");
let campaniaGare = [];
if (fs.existsSync(campScoredPath)) {
  campaniaGare = JSON.parse(fs.readFileSync(campScoredPath, "utf8"));
} else if (fs.existsSync(campFull)) {
  campaniaGare = JSON.parse(fs.readFileSync(campFull, "utf8"));
} else {
  campaniaGare = campSel.ids.map((id) => ({ id, origin: "IMMUTABLE_PRODUCTION_SNAPSHOT" }));
}

const gareCampaniaRows = campaniaGare.slice(0, 25).map((r) => ({
  id: r.id,
  CIG: r.cig || r.tenderCig || "",
  oggetto: (r.object || r.tenderObject || "").slice(0, 160),
  vincitore: r.winner || r.tenderWinner || r.companyName || "",
  regione: "Campania",
  stazione_appaltante: r.buyer || "",
  data: "",
  importo: r.amount ?? r.tenderAmount ?? "",
  contract_type: r.contractType || "",
  category: r.category || "",
  tier: r.tier || "",
  score: r.commercialScore ?? r.leadScore ?? "",
  cauzione: r.cauzioneValue ?? "",
  cauzione_tipo: r.cauzioneKind || "ESTIMATE",
  insurance_need_status: r.insuranceNeed?.status || "WEAKLY_INFERRED",
  origin: "IMMUTABLE_PRODUCTION_SNAPSHOT",
  region_match_via: "buyer_sa",
  motivazione: (r.lowReasons || []).join(";") || "snapshot_reclassified",
  reviewer: "",
  reviewed_at: "",
  winner_correct: "",
  award_status_correct: "",
  amount_correct: "",
  commercial_value_real: "",
  false_positive: "",
  false_negative: "",
  notes: "",
}));
const venetoSel = JSON.parse(fs.readFileSync(VENETO, "utf8"));
const gareVenetoRows = (venetoSel.selected || []).slice(0, 25).map((r) => ({
  id: r.id,
  CIG: r.cig,
  oggetto: (r.object || "").slice(0, 160),
  vincitore: r.winner,
  regione: "Veneto",
  stazione_appaltante: r.buyer || "",
  data: r.awardDate || "",
  importo: r.amount ?? "",
  contract_type: r.contractType,
  category: r.category,
  tier: r.commercialTier,
  score: r.commercialScore ?? r.leadScore,
  cauzione: r.cauzioneValue ?? "",
  cauzione_tipo: r.cauzioneKind || "ESTIMATE",
  insurance_need_status: r.insuranceNeed?.status || "WEAKLY_INFERRED",
  origin: "OFFICIAL_SHADOW_INGEST",
  region_match_via: r.regionMatchVia || "buyer_sa",
  motivazione: (r.evidence || "").slice(0, 200),
  reviewer: "",
  reviewed_at: "",
  winner_correct: "",
  award_status_correct: "",
  amount_correct: "",
  commercial_value_real: "",
  false_positive: "",
  false_negative: "",
  notes: "",
}));

const packs = [
  ["sanita-campania", sanitaPack("Campania"), SANITA_FIELDS],
  ["sanita-veneto", sanitaPack("Veneto"), SANITA_FIELDS],
  ["gare-campania", gareCampaniaRows, GARE_FIELDS],
  ["gare-veneto", gareVenetoRows, GARE_FIELDS],
];

const meta = { humanReviewed: 0, packs: {}, selectionHash: createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 12) };
for (const [name, rows, fields] of packs) {
  fs.writeFileSync(path.join(OUT, `${name}.csv`), csv(fields, rows));
  fs.writeFileSync(path.join(OUT, `${name}.html`), html(`Shadow Batch1 V2 — ${name}`, fields, rows));
  meta.packs[name] = { rows: rows.length, incomplete: rows.length < 25 };
}
meta.totalRows = Object.values(meta.packs).reduce((a, p) => a + p.rows, 0);
meta.preliminaryRef = fs.existsSync(PRELIM);
fs.writeFileSync(path.join(OUT, "SUMMARY.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
process.exit(meta.totalRows === 100 && packs.every(([, r]) => r.length === 25) ? 0 : 3);
