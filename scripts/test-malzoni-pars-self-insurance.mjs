/**
 * Regression: PARS Malzoni Research Hospital 2026 p.6 → SELF_INSURANCE_VERIFIED.
 * Mai REVIEW_HUMAN / HOT / PUBLISHED (polizza) quando frase + first-party + identity.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectSelfInsuranceDeclaration,
  canEmitSelfInsurance,
  shouldPromoteSelfInsuranceVerified,
  isSelfInsuranceFirstPartyDocument,
  SELF_INSURANCE_VERIFIED,
} from "../src/lib/sanita/self-insurance.ts";
import { canEmitPublished, detectInsuranceSignals } from "../src/lib/sanita/can-emit-published.ts";
import { derivePublishedSubtype } from "../src/lib/sanita/published-subtype.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PDF = path.join(
  ROOT,
  "tests/fixtures/sanita/PARS_Malzoni-Research-Hospital_2026.pdf"
);
const FIXTURE_TXT = path.join(
  ROOT,
  "tests/fixtures/sanita/PARS_Malzoni-Research-Hospital_2026.page6.txt"
);
const PARS_URL =
  "https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf";
const EXPECTED_SHA256 =
  "21f6aba27c0b2963d7c12de16b86a997382e3d18c05dde08d71a6df85a4bf422";

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const page6 =
  (fs.existsSync(FIXTURE_TXT) && fs.readFileSync(FIXTURE_TXT, "utf8")) ||
  `3. Descrizione della posizione assicurativa
Attualmente, la struttura non ha sottoscritto alcuna polizza assicurativa, ma opera sotto il regime di autoassicurazione.
Malzoni Research Hospital PARS 2026`;

ok(fs.existsSync(FIXTURE_PDF), "fixture PDF presente");
if (fs.existsSync(FIXTURE_PDF)) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(fs.readFileSync(FIXTURE_PDF)).digest("hex");
  ok(hash === EXPECTED_SHA256, `hash documento ${hash.slice(0, 12)}…`);
}

ok(/opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(page6), "pagina 6: frase esplicita");
ok(/Pag\.?\s*6|posizione assicurativa/i.test(page6), "pagina 6 marker / sezione");

const det = detectSelfInsuranceDeclaration(page6);
ok(det.declared === true, "detectSelfInsuranceDeclaration declared");

const firstParty = isSelfInsuranceFirstPartyDocument({
  exactUrl: PARS_URL,
  facilityWebsite: "http://www.malzoni.it/",
  facilityName: "Casa Di Cura Malzoni Villa Platani Spa",
  documentText: page6,
});
ok(firstParty === true, "first-party intestato (malzoni.it + PARS)");

const gate = canEmitSelfInsurance({
  text: page6,
  entityAttributed: true,
  firstPartyUrl: firstParty,
  exactUrl: PARS_URL,
  identityConfirmed: true,
});
ok(gate.ok, `canEmitSelfInsurance (${gate.reasons.join("; ")})`);

const promo = shouldPromoteSelfInsuranceVerified({
  text: page6,
  entityAttributed: true,
  firstPartyUrl: firstParty,
  exactUrl: PARS_URL,
  identityConfirmed: true,
});
ok(promo.promote === true, "shouldPromoteSelfInsuranceVerified");

const sig = detectInsuranceSignals(page6);
const emit = canEmitPublished({
  identityStatus: "OFFICIAL_CONFIRMED",
  sourceClass: "FIRST_PARTY_FACILITY",
  exactUrl: PARS_URL,
  contentFetched: true,
  contentExcerpt: page6,
  entityAttributed: true,
  hasStrongInsuranceSignal: sig.strong,
  hasMediumInsuranceSignals: sig.mediumCount,
  selfInsurance: true,
  analogousMeasure: false,
  category: "Casa di cura",
});
ok(emit.ok === true, "canEmitPublished ok");
ok(emit.businessVerdict === "SELF_INSURANCE_VERIFIED", "businessVerdict SELF_INSURANCE_VERIFIED");
ok(emit.businessVerdict !== "REVIEW_HUMAN", "mai REVIEW_HUMAN");
ok(emit.businessVerdict !== "HOT_VERIFIED" && emit.businessVerdict !== "HOT", "mai HOT");
ok(!String(emit.businessVerdict || "").startsWith("PUBLISHED_") || emit.businessVerdict === "SELF_INSURANCE_VERIFIED", "mai PUBLISHED polizza");

const subtype = derivePublishedSubtype({ selfInsurance: true, evidenceBody: page6 });
ok(subtype === "SELF_INSURANCE_VERIFIED", "subtype SELF_INSURANCE_VERIFIED");
ok(SELF_INSURANCE_VERIFIED === "SELF_INSURANCE_VERIFIED", "constante SI");

console.log(
  JSON.stringify({
    suite: "malzoni-pars-self-insurance",
    exitCode: fail ? 1 : 0,
    pass,
    fail,
    url: PARS_URL,
    page: 6,
    excerpt: (det.citation || page6).replace(/\s+/g, " ").slice(0, 180),
  })
);
process.exit(fail ? 1 : 0);
