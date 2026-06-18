/** Test gare ANAC: fetch + validazione CIG + arricchimento contatti. */
import { fetchAnacAwards } from "../src/lib/gare/anac.ts";

const region = process.argv[2] ?? "Campania";
console.log(`\n═══ TEST GARE ANAC — ${region} ═══\n`);

const { awards, year, years, scanned } = await fetchAnacAwards(region, { max: 15 });
console.log(`Anni dataset: ${(years.length ? years.join("+") : year) ?? "N/A"} | righe regione scansionate: ${scanned}`);
console.log(`Aggiudicazioni valide: ${awards.length}\n`);

let ok = 0;
for (const a of awards.slice(0, 10)) {
  const cigOk = /^[A-Z0-9]{10}$/.test(a.cig);
  const nameOk = a.companyName.length >= 3;
  const amountOk = a.amount > 0;
  const pass = cigOk && nameOk && amountOk;
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${a.companyName.slice(0, 50)}`);
  const when = a.awardDate ? a.awardDate.toISOString().slice(0, 10) : "n/d";
  console.log(`    CIG=${a.cig} €${Math.round(a.amount).toLocaleString("it-IT")} | ${when} | ${a.object.slice(0, 60)}…`);
}
console.log(`\n${ok}/${Math.min(10, awards.length)} record ANAC validi al 100% (CIG+nome+importo)`);
process.exit(awards.length > 0 && ok === Math.min(10, awards.length) ? 0 : 1);
