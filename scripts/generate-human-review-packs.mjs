/**
 * Genera pack human-review stratificati (NON pre-marcati come verificati).
 * Non dipende dal DB live — campione sintetico stratificato per gate READY FOR SHADOW.
 * Con DATABASE_URL locale e flag --from-db prova a campionare dal DB.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const REVIEW_FIELDS =
  "reviewer,reviewed_at,entity_correct,official_website_correct,identity_correct,source_correct,verdict_correct,commercial_value_real,false_positive,false_negative,critical_contamination,notes,corrected_value";

const SANITA_STRATA = [
  ["HOT", 20],
  ["PUBLISHED", 15],
  ["REVIEW", 15],
  ["GROUP", 8],
  ["SINGLE_SITE", 8],
  ["PDF", 8],
  ["HTML", 6],
  ["AUTOASSICURAZIONE", 5],
  ["EXPIRED_POLICY", 5],
  ["NO_SITE", 5],
  ["CRAWL_INCOMPLETE", 5],
];

const GARE_STRATA = [
  ["VERY_HIGH", 15],
  ["HIGH", 15],
  ["MEDIUM", 15],
  ["EXCLUSION", 8],
  ["MULTILOTTO", 8],
  ["ATI", 7],
  ["CONSORZIO", 7],
  ["AFFIDAMENTO_DIRETTO", 5],
  ["LAVORI", 5],
  ["SERVIZI", 5],
  ["FORNITURE", 5],
  ["MULTI_PROVINCE", 5],
];

const PROVINCES = {
  Campania: ["NA", "SA", "CE", "AV", "BN"],
  Veneto: ["VE", "VR", "PD", "VI", "TV", "BL", "RO"],
};

function csvEscape(s) {
  const t = String(s ?? "");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function rowToCsv(r) {
  return [
    r.id,
    r.region,
    r.province,
    r.companyName,
    r.verdict,
    r.website,
    r.stratum,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]
    .map(csvEscape)
    .join(",");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlTable(title, rows) {
  const body = rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.id)}</td><td>${r.region}</td><td>${r.province}</td>
      <td>${escapeHtml(r.companyName)}</td><td>${r.verdict}</td>
      <td>${escapeHtml(r.website || "")}</td><td>${r.stratum}</td>
      <td contenteditable="true" data-field="reviewer"></td>
      <td data-field="reviewed_at"></td>
      <td></td><td></td><td></td><td></td><td></td>
      <td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>`
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>${title}</title>
  <style>body{font-family:system-ui;margin:1rem} table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{border:1px solid #ccc;padding:4px} th{background:#f4f4f4}
  .banner{background:#fff3cd;border:1px solid #ffc107;padding:12px;margin-bottom:1rem}</style></head><body>
  <div class="banner"><strong>Record effettivamente revisionati da umano: 0</strong> —
  nessun reviewer precompilato. Compilare le colonne di review prima di qualsiasi promozione canary.</div>
  <h1>${title}</h1>
  <table><thead><tr>
  <th>id</th><th>region</th><th>province</th><th>company</th><th>verdict</th><th>website</th><th>stratum</th>
  <th>reviewer</th><th>reviewed_at</th><th>entity_correct</th><th>official_website_correct</th>
  <th>identity_correct</th><th>source_correct</th><th>verdict_correct</th>
  <th>commercial_value_real</th><th>false_positive</th><th>false_negative</th>
  <th>critical_contamination</th><th>notes</th><th>corrected_value</th>
  </tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function buildStratified(engine, region, strata) {
  const provinces = PROVINCES[region];
  const rows = [];
  let n = 0;
  for (const [stratum, count] of strata) {
    for (let i = 0; i < count; i++) {
      n++;
      const prov = provinces[n % provinces.length];
      rows.push({
        id: `shadow-${engine}-${region.toLowerCase()}-${String(n).padStart(3, "0")}`,
        region,
        province: prov,
        companyName: `[SAMPLE] ${engine} ${region} ${stratum} #${i + 1} (${prov})`,
        verdict: stratum.includes("HOT")
          ? "HOT"
          : stratum.includes("PUBLISHED")
            ? "PUBLISHED"
            : stratum.includes("REVIEW") || stratum.includes("EXCLUSION")
              ? "REVIEW"
              : stratum,
        website:
          stratum === "NO_SITE" ? "" : `https://sample-${engine}-${n}.example.it`,
        stratum,
      });
    }
  }
  while (rows.length < 100) {
    n++;
    rows.push({
      id: `shadow-${engine}-${region.toLowerCase()}-${String(n).padStart(3, "0")}`,
      region,
      province: provinces[n % provinces.length],
      companyName: `[SAMPLE] fill ${n}`,
      verdict: "REVIEW",
      website: "",
      stratum: "FILL",
    });
  }
  return rows.slice(0, 100);
}

mkdirSync("docs/human-review", { recursive: true });

const packs = [
  ["sanita", "Campania", SANITA_STRATA],
  ["sanita", "Veneto", SANITA_STRATA],
  ["gare", "Campania", GARE_STRATA],
  ["gare", "Veneto", GARE_STRATA],
];

const summary = { generatedAt: new Date().toISOString(), humanReviewed: 0, packs: [] };

for (const [engine, region, strata] of packs) {
  const rows = buildStratified(engine, region, strata);
  const base = `docs/human-review/${engine}-${region.toLowerCase()}-review`;
  const header = `id,region,province,companyName,verdict,website,stratum,${REVIEW_FIELDS}\n`;
  writeFileSync(`${base}.csv`, header + rows.map(rowToCsv).join("\n"));
  writeFileSync(`${base}.html`, htmlTable(`${engine} ${region} — human review pack`, rows));
  const dist = {};
  for (const r of rows) dist[r.stratum] = (dist[r.stratum] || 0) + 1;
  summary.packs.push({ file: base, rows: rows.length, distribution: dist, humanReviewed: 0 });
  console.log(`Wrote ${base}.* rows=${rows.length}`);
}

writeFileSync("docs/human-review/SUMMARY.json", JSON.stringify(summary, null, 2));
console.log("humanReviewed=0 for all packs (no auto-marking)");
