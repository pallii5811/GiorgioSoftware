#!/usr/bin/env node
/**
 * Generate Batch 1 human-review packs from results.jsonl (human fields blank).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, "data/shadow/batch1/results.jsonl");
const OUT = path.join(ROOT, "docs/human-review/shadow-batch1");

const SANITA_FIELDS = [
  "id",
  "struttura",
  "sede",
  "categoria",
  "vecchio_verdict",
  "nuovo_verdict",
  "sito_precedente",
  "sito_nuovo",
  "identity_status",
  "prove_identita",
  "crawl_complete",
  "sitemap_status",
  "pagine_rilevanti",
  "documento",
  "evidenza_testuale",
  "compagnia",
  "numero_polizza",
  "date",
  "temporal_status",
  "motivazione",
  "score",
  "fonti",
  "errori",
  "costo",
  "reviewer",
  "reviewed_at",
  "entity_correct",
  "website_correct",
  "identity_correct",
  "document_belongs_to_entity",
  "verdict_correct",
  "commercial_value_real",
  "false_positive",
  "false_negative",
  "critical_contamination",
  "notes",
];

const GARE_FIELDS = [
  "id",
  "CIG",
  "lotto",
  "oggetto",
  "vincitore",
  "identita_vincitore",
  "piva_cf",
  "regione",
  "stazione_appaltante",
  "data",
  "importo",
  "stato",
  "fonte",
  "bisogno_assicurativo_verificato",
  "bisogno_assicurativo_inferito",
  "cauzione",
  "cauzione_tipo",
  "vecchio_score",
  "nuovo_score",
  "tier",
  "motivazione",
  "contatti",
  "reviewer",
  "reviewed_at",
  "winner_correct",
  "award_status_correct",
  "amount_correct",
  "commercial_value_real",
  "false_positive",
  "false_negative",
  "notes",
];

function esc(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(fields, rows) {
  return [fields.join(","), ...rows.map((r) => fields.map((f) => esc(r[f])).join(","))].join("\n");
}

function toHtml(title, fields, rows) {
  const th = fields.map((f) => `<th>${f}</th>`).join("");
  const body = rows
    .map((r) => {
      const tds = fields
        .map((f) => {
          let v = r[f] ?? "";
          if (typeof v === "string" && /^https?:\/\//i.test(v)) {
            v = `<a href="${v}" target="_blank" rel="noopener">${v}</a>`;
          } else {
            v = String(v)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
          }
          return `<td>${v}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>${title}</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:1rem;background:#fafafa;color:#111}
.banner{background:#fff3cd;border:1px solid #ffc107;padding:12px;margin-bottom:1rem}
table{border-collapse:collapse;width:100%;font-size:11px;background:#fff}
th,td{border:1px solid #ccc;padding:4px;vertical-align:top;max-width:220px;word-break:break-word}
th{background:#eee;position:sticky;top:0}
a{color:#0645ad}
</style></head><body>
<div class="banner"><strong>Record revisionati da umano: 0</strong> — campi reviewer/reviewed_at e checkbox umani non precompilati.</div>
<h1>${title}</h1>
<p>Batch: shadow-batch1-20260718-rerun · mode: gate-reeval+light-probe</p>
<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}

function sanitaRow(r) {
  return {
    id: r.id,
    struttura: r.companyName,
    sede: `${r.city || ""} (${r.region})`,
    categoria: r.category || "",
    vecchio_verdict: r.oldVerdict,
    nuovo_verdict: r.newVerdict,
    sito_precedente: r.oldWebsite || "",
    sito_nuovo: r.newWebsite || "",
    identity_status: r.identityStatus,
    prove_identita: r.identityBlock || "",
    crawl_complete: r.crawlComplete,
    sitemap_status: r.sitemapStatus,
    pagine_rilevanti: r.pagesVisited ?? "",
    documento: "",
    evidenza_testuale: r.evidenceHead || "",
    compagnia: r.policyCompany || "",
    numero_polizza: r.policyNumber || "",
    date: r.policyExpiry || "",
    temporal_status: /scaduta/i.test(r.evidenceHead || "") ? "EXPIRED" : "",
    motivazione: r.motivation || "",
    score: r.newScore,
    fonti: r.newWebsite || "",
    errori: (r.technicalFailures || []).join("; "),
    costo: r.cost ?? 0,
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
    notes: r.priorityReview ? "PRIORITY_REVIEW" : "",
  };
}

function gareRow(r) {
  return {
    id: r.id,
    CIG: r.cig || "",
    lotto: "",
    oggetto: r.object || "",
    vincitore: r.winner || "",
    identita_vincitore: r.winner || "",
    piva_cf: "",
    regione: r.region,
    stazione_appaltante: r.buyer || "",
    data: r.awardDate || "",
    importo: r.amount ?? "",
    stato: r.blocked || r.tier,
    fonte: r.officialSource ? "official" : "unknown",
    bisogno_assicurativo_verificato: "",
    bisogno_assicurativo_inferito: (r.inferences || []).join("; "),
    cauzione: r.cauzioneValue ?? "",
    cauzione_tipo: r.cauzioneKind || "",
    vecchio_score: r.oldScore ?? "",
    nuovo_score: r.newScore ?? "",
    tier: r.tier || "",
    motivazione: r.motivation || "",
    contatti: [r.phone ? "phone" : "", r.email ? "email" : ""].filter(Boolean).join(","),
    reviewer: "",
    reviewed_at: "",
    winner_correct: "",
    award_status_correct: "",
    amount_correct: "",
    commercial_value_real: "",
    false_positive: "",
    false_negative: "",
    notes: r.priorityReview ? "PRIORITY_REVIEW" : "",
  };
}

const lines = fs.readFileSync(RESULTS, "utf8").trim().split(/\n+/).filter(Boolean);
const rows = lines.map((l) => JSON.parse(l)).filter((r) => !r.stop || r.engine);

const packs = [
  ["sanita-campania", rows.filter((r) => r.engine === "sanita" && r.region === "Campania").map(sanitaRow), SANITA_FIELDS],
  ["sanita-veneto", rows.filter((r) => r.engine === "sanita" && r.region === "Veneto").map(sanitaRow), SANITA_FIELDS],
  ["gare-campania", rows.filter((r) => r.engine === "gare" && r.region === "Campania").map(gareRow), GARE_FIELDS],
  ["gare-veneto", rows.filter((r) => r.engine === "gare" && r.region === "Veneto").map(gareRow), GARE_FIELDS],
];

fs.mkdirSync(OUT, { recursive: true });
const meta = { humanReviewed: 0, packs: {} };
for (const [name, data, fields] of packs) {
  fs.writeFileSync(path.join(OUT, `${name}.csv`), toCsv(fields, data), "utf8");
  fs.writeFileSync(path.join(OUT, `${name}.html`), toHtml(`Shadow Batch1 — ${name}`, fields, data), "utf8");
  meta.packs[name] = { rows: data.length, csv: `${name}.csv`, html: `${name}.html` };
}
fs.writeFileSync(path.join(OUT, "SUMMARY.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
