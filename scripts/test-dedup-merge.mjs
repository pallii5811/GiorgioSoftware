/**
 * Regression: dedup non deve preferire scheda vuota su scheda già analizzata.
 * Run: node --experimental-strip-types scripts/test-dedup-merge.mjs
 */
import { pickCanonicalLead } from "../src/lib/sanita/lead-dedup.ts";

const group = [
  {
    id: "empty-maps",
    region: "Campania",
    companyName: "Poliambulatorio Ma-Re",
    city: "Avellino",
    website: "https://guarinolab.it/",
    osmId: "gmaps/abc",
    lastScannedAt: null,
    leadScore: 0,
    evidence: null,
    pagesVisited: 0,
  },
  {
    id: "scanned-hot",
    region: "Campania",
    companyName: "Guarino Lab Srl",
    city: "Avellino",
    website: "https://www.guarinolab.it/",
    osmId: "gmaps/xyz",
    lastScannedAt: new Date("2026-06-18T20:00:00Z"),
    leadScore: 80,
    evidence: "[V:HOT] Assenza polizza certificata",
    pagesVisited: 26,
  },
];

const scanned = group.filter((l) => l.lastScannedAt);
const keepOld = pickCanonicalLead(group);
const keepNew = scanned.length > 0 ? pickCanonicalLead(scanned) : pickCanonicalLead(group);

let failed = 0;
if (keepOld.id === "empty-maps") {
  console.error("FAIL: pickCanonicalLead(group) preferisce scheda vuota →", keepOld.id);
  failed++;
} else {
  console.log("OK: pickCanonicalLead(group) =", keepOld.id);
}

if (keepNew.id !== "scanned-hot") {
  console.error("FAIL: dedup scanned-first keep =", keepNew.id, "expected scanned-hot");
  failed++;
} else {
  console.log("OK: dedup scanned-first keep = scanned-hot");
}

process.exit(failed ? 1 : 0);
