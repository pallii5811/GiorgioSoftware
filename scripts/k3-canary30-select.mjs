/**
 * k3 — Selezione stratificata canary 30 (FASE 5). GIRA SUL SERVER.
 *
 * Legge il pool 877 (data/k3-stopship/canary30-pool.json), esclude i 12 del
 * corpus stop-ship e i lead già toccati dal checkpoint (frontier nuova per
 * mandato), sonda le homepage (HTTP leggero, solo lettura) per classificare
 * WordPress/JS/lenti/redirect, poi seleziona 30 lead stratificati REALI:
 * polizza nota valida/scaduta, senza polizza baseline, mai verificati,
 * categorie e regioni miste, siti difficili (lenti, redirect, WP, JS).
 * Il campione NON è scelto per essere facile.
 *
 * Output: /opt/leadsniper-revalidate/data/k3-stopship/canary30-selection.json
 *         /opt/leadsniper-revalidate/data/k3-stopship/canary30-probe.json
 *
 * Uso: npx tsx scripts/k3-canary30-select.mjs
 */
import fs from "node:fs";

const W = process.env.K3_WORKDIR || "/opt/leadsniper-revalidate";
const K3 = `${W}/data/k3-stopship`;
const POOL = JSON.parse(fs.readFileSync(`${K3}/canary30-pool.json`, "utf8"));
const CP = JSON.parse(fs.readFileSync(`${W}/data/revalidation/checkpoint.json`, "utf8"));

const CORPUS12 = new Set([
  "cmqkld5s700a8108eti0nofjv",
  "cmqkld5rx009p108edj6t9krw",
  "cmql46eia000ac9w78xh0rxdl",
  "cmqkld5t300av108e5rrr47s9",
  "cmqkld5s3009z108e1yj01zqy",
  "cmqkld5s0009u108eghihpoxi",
  "cmqkld5s300a0108e8p1p3xxg",
  "cmqklex5e00b3108e2zcdos1w",
  "cmqklex5g00b6108ejom1shk0",
  "cmqkn3ghj0002xnfpr553khla",
  "cmqkld5sa00af108epednu868",
  "cmqkld5t000ao108esg4xv094",
]);

const touched = new Set([
  ...Object.keys(CP.terminal || {}),
  ...Object.keys(CP.retryQueue || {}),
  ...Object.keys(CP.inProgress || {}),
]);

const eligible = POOL.leads.filter(
  (l) => !CORPUS12.has(l.id) && !touched.has(l.id) && l.website
);
console.log(`eligible: ${eligible.length}/${POOL.leads.length}`);

// ---------------- sonda HTTP leggera (read-only) ----------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function probeOne(lead) {
  const out = {
    id: lead.id,
    status: 0,
    timeMs: 0,
    redirected: false,
    crossDomain: false,
    finalHost: "",
    wordpress: false,
    jsHeavy: false,
    pdfHints: 0,
    error: null,
  };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(lead.website, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html" },
    });
    clearTimeout(timer);
    out.timeMs = Date.now() - t0;
    out.status = res.status;
    const finalUrl = new URL(res.url);
    const origHost = new URL(lead.website).hostname.replace(/^www\./, "");
    out.finalHost = finalUrl.hostname;
    out.redirected = res.url !== lead.website;
    out.crossDomain = finalUrl.hostname.replace(/^www\./, "") !== origHost;
    const html = (await res.text()).slice(0, 300_000);
    out.wordpress = /wp-content|wp-includes|generator[^>]*wordpress/i.test(html);
    out.jsHeavy = /__NEXT_DATA__|ng-app|data-reactroot|__NUXT__|window\.__VUE__|elementor/i.test(html);
    out.pdfHints = (html.match(/\.pdf["'\s?]/gi) || []).length;
  } catch (e) {
    out.timeMs = Date.now() - t0;
    out.error = String(e?.name === "AbortError" ? "timeout9s" : e).slice(0, 80);
  }
  return out;
}

async function probeAll(leads) {
  const results = {};
  const queue = [...leads];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const l = queue.shift();
      if (!l) break;
      results[l.id] = await probeOne(l);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------- pre-filtro candidati da sondare ----------------
const now = Date.now();
const policyValid = eligible.filter(
  (l) => l.policyFound && l.policyExpiry && new Date(l.policyExpiry).getTime() > now
);
const policyExpired = eligible.filter(
  (l) => l.policyFound && l.policyExpiry && new Date(l.policyExpiry).getTime() <= now
);
const policyUnknown = eligible.filter((l) => l.policyFound && !l.policyExpiry);
const baselineHot = eligible.filter(
  (l) => l.policyFound === false && /\[V:HOT\]|HOT_VERIFIED/i.test(l.evidenceHead || "")
);
const neverVerified = eligible.filter((l) => !(l.evidenceHead || "").trim());
const byCat = {};
for (const l of eligible) {
  const c = (l.category || "?").split("(")[0].trim();
  (byCat[c] = byCat[c] || []).push(l);
}

// campionamento deterministico: prendi fino a N per classe + mix categorie/regioni
const pick = (arr, n) => arr.slice(0, n);
const candidatesMap = new Map();
const addCands = (arr, why) => {
  for (const l of arr) if (!candidatesMap.has(l.id)) candidatesMap.set(l.id, { lead: l, why });
};
addCands(pick(policyValid, 8), "polizza_valida");
addCands(pick(policyExpired, 8), "polizza_scaduta");
addCands(pick(policyUnknown, 4), "polizza_data_sconosciuta");
addCands(pick(baselineHot, 8), "senza_polizza_baseline");
addCands(pick(neverVerified, 20), "mai_verificato");
for (const [cat, arr] of Object.entries(byCat)) addCands(pick(arr, 4), `categoria:${cat}`);
// mix regioni forzato
const campania = eligible.filter((l) => l.region === "Campania");
const veneto = eligible.filter((l) => l.region === "Veneto");
addCands(pick(campania, 20), "mix_campania");
addCands(pick(veneto, 20), "mix_veneto");

const candidates = [...candidatesMap.values()];
console.log(`candidati da sondare: ${candidates.length}`);

// ---------------- sonda ----------------
const probe = await probeAll(candidates.map((c) => c.lead));
fs.writeFileSync(
  `${K3}/canary30-probe.json`,
  JSON.stringify({ at: new Date().toISOString(), probe }, null, 1)
);
console.log("sonda completata");

// ---------------- selezione finale 30 ----------------
const scored = candidates.map(({ lead, why }) => {
  const p = probe[lead.id] || {};
  const hard =
    (p.timeMs > 3000 ? 1 : 0) +
    (p.crossDomain ? 1 : 0) +
    (p.wordpress ? 1 : 0) +
    (p.jsHeavy ? 1 : 0) +
    (p.error ? 1 : 0) +
    (p.pdfHints > 3 ? 1 : 0);
  return { lead, why, probe: p, hard };
});

const selection = [];
const used = new Set();
const take = (arr, n, label) => {
  let c = 0;
  for (const s of arr) {
    if (c >= n) break;
    if (used.has(s.lead.id)) continue;
    used.add(s.lead.id);
    selection.push({ ...s, stratum: label });
    c++;
  }
};

// classi obbligatorie mandato
take(scored.filter((s) => s.why === "polizza_valida"), 4, "polizza_nota_valida");
take(scored.filter((s) => s.why === "polizza_scaduta"), 4, "polizza_nota_scaduta");
take(scored.filter((s) => s.why === "polizza_data_sconosciuta"), 2, "polizza_data_sconosciuta");
take(scored.filter((s) => s.why === "senza_polizza_baseline"), 4, "senza_polizza_baseline");
// siti difficili: ordinati per durezza
const hardSorted = scored
  .filter((s) => !used.has(s.lead.id))
  .sort((a, b) => b.hard - a.hard);
take(hardSorted.filter((s) => s.wordpress), 3, "wordpress");
take(hardSorted.filter((s) => s.jsHeavy), 3, "js_heavy");
take(hardSorted.filter((s) => s.probe.timeMs > 3000), 3, "sito_lento");
take(hardSorted.filter((s) => s.crossDomain), 2, "redirect_crossdomain");
take(hardSorted.filter((s) => s.probe.pdfHints > 3), 3, "molti_pdf");
take(hardSorted.filter((s) => s.probe.error), 2, "sonda_fallita_difficile");
// mai verificati + riempimento bilanciato per regione
take(scored.filter((s) => s.why === "mai_verificato" && !used.has(s.lead.id)), 4, "mai_verificato");
let guard = 0;
while (selection.length < 30 && guard < 500) {
  guard++;
  const need = { Campania: 15, Veneto: 15 };
  const have = selection.reduce((m, s) => ((m[s.lead.region] = (m[s.lead.region] || 0) + 1), m), {});
  const wantRegion = (have.Campania || 0) < need.Campania ? "Campania" : "Veneto";
  const next = scored.find((s) => !used.has(s.lead.id) && s.lead.region === wantRegion);
  if (!next) break;
  used.add(next.lead.id);
  selection.push({ ...next, stratum: "riempimento_bilanciato" });
}

const out = {
  generatedAt: new Date().toISOString(),
  total: selection.length,
  gate: "stratificato reale — non scelto facile",
  byStratum: selection.reduce((m, s) => ((m[s.stratum] = (m[s.stratum] || 0) + 1), m), {}),
  byRegion: selection.reduce((m, s) => ((m[s.lead.region] = (m[s.lead.region] || 0) + 1), m), {}),
  selection: selection.map((s) => ({
    id: s.lead.id,
    companyName: s.lead.companyName,
    city: s.lead.city,
    region: s.lead.region,
    category: s.lead.category,
    website: s.lead.website,
    stratum: s.stratum,
    expectedHint: s.why,
    probe: s.probe,
  })),
};
fs.writeFileSync(`${K3}/canary30-selection.json`, JSON.stringify(out, null, 1));
console.log(`selezionati: ${out.total}`);
console.log("strati:", JSON.stringify(out.byStratum));
console.log("regioni:", JSON.stringify(out.byRegion));
