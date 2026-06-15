import { externalFetch } from "../src/lib/http.ts";

const CSV_URL =
  "https://www.dati.salute.gov.it/sites/default/files/2024-05/Case_di_Cura_Accreditate_presenti_nel_territorio_della_ASL.csv";

const res = await externalFetch(CSV_URL, {
  timeoutMs: 60_000,
  headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Accept: "text/csv,*/*" },
});
const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
const lines = text.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
const iRegion = header.indexOf("regione");
const counts = {};
for (let i = 1; i < lines.length; i++) {
  const r = (lines[i].split(";")[iRegion] || "").trim().toUpperCase();
  if (!r) continue;
  counts[r] = (counts[r] ?? 0) + 1;
}
const campania = counts["CAMPANIA"] ?? 0;
const veneto = counts["VENETO"] ?? 0;
console.log(JSON.stringify({ campania, veneto, totale: campania + veneto, topRegioni: Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8) }, null, 2));
