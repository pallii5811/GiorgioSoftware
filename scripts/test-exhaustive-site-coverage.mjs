import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";
process.env.CRAWL_RENDER_EVERY_HTML = "1";

const {
  discoverResourcesFromHtml,
  discoverResourcesFromText,
  isClearlyDecorativeImageUrl,
  isClearlyPatientConventionLogoUrl,
  isGeneratedRuntimeRequestUrl,
  originalImageUrlForThumbnail,
  resourceTypeForContentType,
} = await import("../src/lib/sanita/site-resource.ts");
const { extractOfficeDocumentText } = await import(
  "../src/lib/sanita/office-document.ts"
);
const { detectPolicyCandidate } = await import("../src/lib/sanita/detector.ts");
const { pickNextNodeForTest } = await import(
  "../src/lib/sanita/crawl-slice-runner.ts"
);
const { packEvidence, pickPolicyPdfUrl, pickPolicySourceUrl } = await import(
  "../src/lib/sanita/audit.ts"
);
const {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  persistNodeEvidence,
  setCrawlRunFlags,
  deriveExhaustiveSiteCoverage,
  deriveCrawlCompleteness,
  prepareFrontierForExhaustiveCoverage,
  listNodes,
  canonicalizeUrl,
} = await import("../src/lib/sanita/frontier-store.ts");

let pass = 0;
function ok(value, name) {
  assert.ok(value, name);
  pass++;
  console.log(`  ✓ ${name}`);
}

const html = `
  <a href="/struttura">Struttura</a>
  <a href="https://cdn.example.net/polizza-rc.docx">Allegato</a>
  <script src="/_next/app.js"></script>
  <img data-src="/media/copertura.png">
  <img src="https://connect.facebook.net/tracker.png">
  <script>window.api = "/api/documenti.json";</script>
`;
const resources = discoverResourcesFromHtml(
  html,
  "https://clinic.example/",
  "https://clinic.example/"
);
const byUrl = new Map(resources.map((resource) => [resource.url, resource.resourceType]));
ok(byUrl.get("https://clinic.example/struttura") === "html", "discovers ordinary HTML");
ok(byUrl.get("https://clinic.example/_next/app.js") === "script", "discovers JavaScript");
ok(byUrl.get("https://clinic.example/media/copertura.png") === "image", "discovers lazy image");
ok(byUrl.get("https://clinic.example/api/documenti.json") === "json", "discovers inline API");
const minifiedBundleResources = discoverResourcesFromText(
  `const a="/Kc",b="/c",c="/t.params.url",d="/document.location",
   e="/self.location.href",f="/o.src",g="/assertThisInitialized.js",
   h="/classApplyDescriptorSet.js",api="/api/documenti.json",
   policy="/files/polizza-rct.pdf",i="/b.toString(",j="/c||0",
   k="/src",l="/e[0].src",m="/image/png",n="/var(--bookly-flags2x-url";`,
  "https://clinic.example/assets/app.js",
  "https://clinic.example/"
);
const minifiedBundleUrls = new Set(
  minifiedBundleResources.map((resource) => resource.url)
);
ok(
  ![
    "/Kc",
    "/c",
    "/t.params.url",
    "/document.location",
    "/self.location.href",
    "/o.src",
    "/assertThisInitialized.js",
    "/classApplyDescriptorSet.js",
    "/b.toString(",
    "/c||0",
    "/src",
    "/e[0].src",
    "/image/png",
    "/var(--bookly-flags2x-url",
  ].some((value) => minifiedBundleUrls.has(`https://clinic.example${value}`)),
  "does not turn minified JavaScript identifiers into site routes"
);
ok(
  minifiedBundleUrls.has("https://clinic.example/api/documenti.json") &&
    minifiedBundleUrls.has("https://clinic.example/files/polizza-rct.pdf"),
  "keeps real API and policy resources found inside JavaScript"
);
const baseAwareResources = discoverResourcesFromHtml(
  `<base href="/"><script src="components/table/index.js"></script>`,
  "https://clinic.example/servizi/procedimenti/u/ammcon/42",
  "https://clinic.example/"
);
ok(
  baseAwareResources.some(
    (resource) =>
      resource.url === "https://clinic.example/components/table/index.js"
  ) &&
    !baseAwareResources.some((resource) =>
      resource.url.includes("/servizi/procedimenti/u/ammcon/42/components/")
    ),
  "resolves relative assets against the document base href"
);
const exhaustedWidgetResources = discoverResourcesFromHtml(
  `<div data-start-page="189" data-max-pages="0" data-total="0"
        data-next-link="https://clinic.example/departments/page/190/"></div>
   <a href="/amministrazione-trasparente/">Trasparenza</a>`,
  "https://clinic.example/departments/page/189/",
  "https://clinic.example/"
);
ok(
  !exhaustedWidgetResources.some((resource) =>
    resource.url.includes("/departments/page/190")
  ),
  "stops contradictory exhausted-widget pagination"
);
ok(
  exhaustedWidgetResources.some((resource) =>
    resource.url.includes("/amministrazione-trasparente")
  ),
  "exhausted-widget filtering preserves real links"
);
ok(
  canonicalizeUrl("https://clinic.example/stemma.jpg?dummy=82392") ===
    "https://clinic.example/stemma.jpg",
  "removes random cache-busters from static assets"
);
ok(
  canonicalizeUrl(
    "https://clinic.example/it/about?nocache=1785216338&jet_blog_ajax=1"
  ) === "https://clinic.example/it/about?jet_blog_ajax=1",
  "collapses timestamped AJAX cache tokens into one stable resource"
);
ok(
  resourceTypeForContentType(
    "https://clinic.example/assets/openhand.cur",
    "application/octet-stream"
  ) === "other",
  "classifies browser cursor files as non-document media"
);
ok(
  resourceTypeForContentType(
    "https://clinic.example/wp-content/icons/brand.svg",
    ""
  ) === "xml",
  "classifies SVG assets without launching an HTML browser render"
);
ok(
  isGeneratedRuntimeRequestUrl(
    "https://clinic.example/about?nocache=1&jet_blog_ajax=1"
  ),
  "recognizes generated AJAX render requests before frontier insertion"
);
for (const generatedUrl of [
  "https://clinic.example/wp-json/oembed/1.0/embed?url=https%3A%2F%2Fclinic.example%2Fabout",
  "https://clinic.example/wp-json/wp/v2/pages/8978",
  "https://clinic.example/wp-json/wp/v2/posts/75",
  "https://clinic.example/wp-json/contact-form-7/v1/contact-forms/5715/refill",
  "https://clinic.example/wp-json/contact-form-7/v1/contact-forms/5715/feedback/schema",
  "https://clinic.example/wp-json/jet-blocks-api/v1/elementor-template",
  "https://clinic.example/embed-legal.json",
  "https://clinic.example/about/embed",
  "https://clinic.example/about/feed",
  "https://clinic.example/?p=7837",
]) {
  ok(
    isGeneratedRuntimeRequestUrl(generatedUrl),
    `recognizes duplicate WordPress representation ${generatedUrl}`
  );
}
ok(
  !isGeneratedRuntimeRequestUrl(
    "https://clinic.example/wp-json/wp/v2/pages/8978?document=polizza-rct.pdf"
  ),
  "policy-named CMS endpoint always overrides duplicate-representation filtering"
);
const malformedHostResource = discoverResourcesFromHtml(
  `<a href="www.google.it">Mappa</a>`,
  "https://clinic.example/",
  "https://clinic.example/"
);
ok(
  !malformedHostResource.some((resource) =>
    resource.url.includes("clinic.example/www.google.it")
  ),
  "bare external host cannot become a fake first-party route"
);
ok(
  byUrl.get("https://cdn.example.net/polizza-rc.docx") === "office",
  "keeps directly linked external policy document"
);
ok(
  !byUrl.has("https://connect.facebook.net/tracker.png"),
  "does not recursively crawl generic third-party widget media"
);

const jsResources = discoverResourcesFromText(
  `fetch("/api/polizze"); const pdf = "/files/RC_2026.pdf";`,
  "https://clinic.example/app.js",
  "https://clinic.example/"
);
ok(jsResources.some((resource) => /\/api\/polizze$/.test(resource.url)), "discovers fetch endpoint");
ok(jsResources.some((resource) => /RC_2026\.pdf$/.test(resource.url)), "discovers PDF in JS");
ok(
  resourceTypeForContentType("https://clinic.example/download?id=7", "application/pdf") ===
    "pdf",
  "uses response content type for extensionless PDF"
);
ok(
  resourceTypeForContentType(
    "https://clinic.example/utility/xlsviewer.exe",
    "application/octet-stream"
  ) === "other",
  "classifies executable utilities as non-document binary media"
);
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/wp-content/uploads/cropped-logo-192x192.jpg"
  ),
  "recognizes an explicitly named decorative logo after OCR"
);
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/wp-content/uploads/cropped-Clinica-Villa-Cinzia.png"
  ),
  "recognizes WordPress cropped site identity artwork without dimensions"
);
ok(
  isClearlyPatientConventionLogoUrl(
    "https://clinic.example/wp-content/uploads/2026/07/Allianz-e1784908906831.webp",
    "https://clinic.example/assicurazioni-e-convenzioni"
  ) &&
    !isClearlyPatientConventionLogoUrl(
      "https://clinic.example/wp-content/uploads/polizza-Allianz.jpg",
      "https://clinic.example/assicurazioni-e-convenzioni"
    ),
  "patient-convention insurer logos close only when the asset is not policy-named"
);
ok(
  !isClearlyDecorativeImageUrl(
    "https://clinic.example/wp-content/uploads/polizza-rct-192x192.jpg"
  ),
  "never exempts a policy-named image from strict OCR review"
);
for (const decorativeName of [
  "Header.jpg",
  "bg-mobile-header.jpg",
  "ico2.png",
  "partner-Villa-Fiorita-6.png",
  "orologio.jpg",
  "Iconaios120.png",
  "icons8-dieta-50.png",
  "ajax-loader@2x.gif",
  "feature_foto5.jpg",
  "ci-siamo.jpg",
  "foto-diabet.jpg",
  "pagamenti-dispo.png",
  "flags@2x.png",
  "globe.png",
  "Centro-di-Medicina-2.png",
  "arrow-left-light.png",
  "service_curves.png",
  "World-Map.png",
  "signature.png",
  "Telefono.png",
  "Paga-con-pos.png",
  "Copertina-news-1536x577-1.jpg",
]) {
  ok(
    isClearlyDecorativeImageUrl(
      `https://clinic.example/wp-content/uploads/${decorativeName}`
    ),
    `recognizes non-document site artwork ${decorativeName}`
  );
}
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/wp-content/themes/medcity/assets/images/arrow.png"
  ),
  "recognizes theme UI image assets after OCR"
);
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/images/tema/fotoOrganigramma/maricla.jpg"
  ),
  "recognizes staff portrait folders as non-document media"
);
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/images/gallery/1.jpg"
  ) &&
    isClearlyDecorativeImageUrl(
      "https://clinic.example/images/attrezzature-apparecchi/laser.jpeg"
    ),
  "recognizes explicit facility gallery and equipment-photo folders"
);
ok(
  isClearlyDecorativeImageUrl(
    "https://clinic.example/wp-content/uploads/elementor/thumbs/photo-hash.png"
  ),
  "recognizes Elementor-generated thumbnails after OCR"
);
ok(
  !isClearlyDecorativeImageUrl(
    "https://clinic.example/images/fotoOrganigramma/polizza-rct.jpg"
  ),
  "policy terms always override non-document path semantics"
);
ok(
  !discoverResourcesFromText(
    `const failed = b.blockedURI;`,
    "https://clinic.example/app.js",
    "https://clinic.example/"
  ).some((resource) => /blockedURI/i.test(resource.url)),
  "does not turn browser JavaScript properties into fake first-party routes"
);
ok(
  !discoverResourcesFromText(
    `const x = "/doctor_cat/i.old,c.bg?.image?.src";`,
    "https://clinic.example/app.js",
    "https://clinic.example/"
  ).some((resource) => /\?\.image/i.test(resource.url)),
  "does not turn optional-chaining expressions into fake routes"
);
ok(
  !discoverResourcesFromText(
    `const search = "https://clinic.example/?s={search_term_string}";`,
    "https://clinic.example/app.js",
    "https://clinic.example/"
  ).some((resource) => /search_term_string/i.test(resource.url)),
  "does not crawl Schema.org URL-template placeholders"
);
const minifiedNoise = discoverResourcesFromText(
  `const a=s.old,o.image.src; const b=window.location.href;
   const c="/real/documenti.json"; const d=\`\${e}\`;`,
  "https://clinic.example/assets/app.min.js",
  "https://clinic.example/"
);
ok(
  minifiedNoise.length === 1 &&
    minifiedNoise[0].url === "https://clinic.example/real/documenti.json",
  "extracts quoted runtime URLs without minified JavaScript expression noise"
);
ok(
  originalImageUrlForThumbnail(
    "https://clinic.example/wp-content/uploads/polizza-rct-725x1024.jpg"
  ) ===
    "https://clinic.example/wp-content/uploads/polizza-rct.jpg",
  "recovers the original full-resolution image behind a WordPress thumbnail"
);

const rtf = Buffer.from(
  String.raw`{\rtf1\ansi Polizza assicurativa RCT numero ABC-123456 con Generali}`,
  "latin1"
);
const office = extractOfficeDocumentText(rtf, "https://clinic.example/polizza.rtf");
ok(office.status === "SUCCESS" && /Polizza assicurativa RCT/i.test(office.text), "extracts RTF");

const variant = detectPolicyCandidate(
  "Certificato assicurativo per responsabilità professionale. Contratto ABX/991122.",
  "https://clinic.example/documenti/copertura"
);
ok(variant.candidate && !variant.resolved, "recall-first detector blocks ambiguous insurance variant");
ok(
  !detectPolicyCandidate(
    "Privacy Policy. Il contratto servizio comporta il trattamento dei dati personali.",
    "https://clinic.example/privacy-policy.pdf"
  ).candidate,
  "ordinary privacy-contract prose is not mistaken for a policy identifier"
);
ok(
  !detectPolicyCandidate(
    "Pagina richiesta non disponibile. Torna alla home.",
    "https://clinic.example/assicurazione-rct"
  ).candidate,
  "a policy-like URL without policy content is not an unresolved candidate"
);
ok(
  detectPolicyCandidate(
    "Contratto assicurativo identificato dal codice RC/ABCDEF.",
    "https://clinic.example/copertura"
  ).candidate,
  "separator-based policy identifiers without digits remain detectable"
);
ok(
  !detectPolicyCandidate(
    "Generali informazioni sulla struttura. " +
      "testo amministrativo ".repeat(300) +
      "Per lo straniero è richiesta una polizza assicurativa sanitaria. " +
      "Le convenzioni possono prevedere franchigie. Legge Gelli art. 10.",
    "https://clinic.example/carta-servizi.pdf"
  ).candidate,
  "unrelated insurance words on distant pages do not create a false candidate"
);
const generatedContactNoise = detectPolicyCandidate(
  "Pagina contatti AXA configurazione widget date disponibili 01/01/2022 - 05/03/2023",
  "https://clinic.example/contatti"
);
ok(
  !generatedContactNoise.policy.policyFound && !generatedContactNoise.candidate,
  "isolated insurer token plus unrelated date range is neither PUBLISHED nor a retry candidate"
);
const villaCinziaPolicy = detectPolicyCandidate(
  "contenuto tema ".repeat(7000) +
    " POLIZZA ASSICURATIVA VILLA CINZIA AMTRUST OSPEDALI PRIVATI " +
    "RCH00020000239 DATA STIPULA: 04/02/25 – SCAD. 04/11/2026 " +
    "LEGGE GELLI: relazione annuale sugli eventi avversi e risarcimenti erogati.",
  "https://www.clinicavillacinzia.com/amministrazione-trasparente/"
);
ok(
  villaCinziaPolicy.resolved &&
    villaCinziaPolicy.policy.policyFound &&
    villaCinziaPolicy.policy.company === "AmTrust" &&
    villaCinziaPolicy.policy.policyNumber === "RCH00020000239" &&
    villaCinziaPolicy.policy.expiry?.toISOString() === "2026-11-04T00:00:00.000Z",
  "detects Villa Cinzia policy after a long page prefix and reads abbreviated SCAD expiry"
);
const villaCinziaSource = {
  policyPdfUrl: null,
  policySourceUrl:
    "https://www.clinicavillacinzia.com/amministrazione-trasparente",
  pagesVisited: [
    "https://www.clinicavillacinzia.com/amministrazione-trasparente",
    "https://www.clinicavillacinzia.com/wp-content/uploads/PARM-2026.pdf",
  ],
};
ok(
  pickPolicySourceUrl(villaCinziaSource) === villaCinziaSource.policySourceUrl &&
    pickPolicyPdfUrl(villaCinziaSource) === null,
  "keeps a certified HTML policy source instead of misattributing a linked PARM PDF"
);
ok(
  packEvidence("PUBLISHED", "Polizza HTML certificata.", {
    policySourceUrl: villaCinziaSource.policySourceUrl,
  }).includes(`[DOCS: ${villaCinziaSource.policySourceUrl}]`),
  "published HTML evidence preserves the exact resource required by terminal certification"
);
const parmAlternativeTemplate = detectPolicyCandidate(
  "Piano Annuale Risk Management. Art. 10 Legge 24/2017. " +
    "Legge 8 marzo 2017 n.14. Sinistrosità e risarcimenti erogati. " +
    "Il dato si riferisce al periodo in cui la struttura " +
    "è in copertura assicurativa o in autoassicurazione/auto ritenzione. " +
    "Relazione sui risarcimenti ai sensi della Legge 24/2017.",
  "https://clinic.example/PARM-2024.pdf"
);
ok(
  !parmAlternativeTemplate.policy.policyFound && !parmAlternativeTemplate.candidate,
  "PARM insurance-or-self-insurance template is resolved as boilerplate"
);
const patientInsurancePartners = detectPolicyCandidate(
  "Assicurazioni e Convenzioni. Partnership con fondi sanitari e compagnie assicurative. " +
    "Visite ed esami con tariffe agevolate o rimborso diretto. UniSalute, Allianz e Generali Welion.",
  "https://clinic.example/assicurazioni-e-convenzioni"
);
ok(
  !patientInsurancePartners.policy.policyFound && !patientInsurancePartners.candidate,
  "patient insurance convention page is not the facility liability policy"
);
ok(
  !detectPolicyCandidate(
    "Convenzioni Assicurative e Welfare Aziendale. Se hai una polizza sanitaria puoi avere tariffe agevolate o la copertura totale dei trattamenti. Welion Generali: siamo un centro convenzionato.",
    "https://clinic.example/professionisti/medico"
  ).candidate,
  "shared patient-benefit content cannot block absence as a facility RC policy"
);
ok(
  detectPolicyCandidate(
    "Copertura assicurativa per responsabilità civile della struttura con Generali; " +
      "franchigia prevista dal contratto.",
    "https://clinic.example/trasparenza"
  ).candidate,
  "locally coherent insurer and RC terms remain a candidate"
);
ok(
  !detectPolicyCandidate(
    "Piano annuale di risk management e rendiconto dei risarcimenti erogati.",
    "https://clinic.example/parm-2025.pdf"
  ).candidate,
  "known PARM boilerplate alone does not create a false candidate"
);
const prosePublication = detectPolicyCandidate(
  "Adempimenti Legge 24/2017: pubblichiamo il testo della polizza assicurativa. " +
    "Dal 2019 è stata stipulata polizza assicurativa con AM TRUST ITALIA ed è in corso il rinnovo.",
  "https://clinic.example/legge-gelli"
);
ok(
  prosePublication.resolved && prosePublication.policy.policyFound,
  "explicit first-party prose publication is PUBLISHED without numeric fields"
);
const proseInsideParm = detectPolicyCandidate(
  "Relazione annuale PARM sulla gestione del rischio clinico e sugli eventi avversi. ".repeat(
    20
  ) +
    "Adempimenti Legge 24/2017: siamo a pubblicare il testo della polizza assicurativa in corso di validità. " +
    "È stata stipulata polizza assicurativa con AM TRUST ITALIA ed è in corso il rinnovo.",
  "https://clinic.example/legge-gelli"
);
ok(
  proseInsideParm.resolved && proseInsideParm.policy.policyFound,
  "explicit policy disclosure inside a long PARM page is not discarded as boilerplate"
);
const villaFioritaParm = detectPolicyCandidate(
  "PIANO DI RISK MANAGEMENT (PARM): GESTIONE DEL RISCHIO CLINICO. " +
    "3.4 DESCRIZIONE DEGLI EVENTI/SINISTRI E RISARCIMENTI EROGATI. " +
    "2019 1 0 2020 1 1 2021 4 2 2024 3 3 2025 2 2. " +
    "3.5 DESCRIZIONE DELLA POSIZIONE ASSICURATIVA " +
    "Validità Polizza Compagnia assicuratrice Brokeraggio " +
    "31/10/2019 al 31/12/2022 RCH00020000013 AM TRUST ASSICURAZIONI PROGRESS INSURANCE BROKER " +
    "31/12/2022 AL 31/12/2024 RCH00020000171 AM TRUST ASSICURAZIONI PROGRESS INSURANCE BROKER " +
    "31/12/2024 AL 31/12/2025 48480OO SARA ASSICURAZIONI A.O.N. " +
    "3.6 EVENTI SEGNALATI NEL 2025",
  "https://clinicavillafiorita.it/wp-content/uploads/2026/06/Parm-2026-Villa-Fiorita-Aversa.pdf"
);
ok(
  villaFioritaParm.resolved &&
    villaFioritaParm.policy.policyFound &&
    villaFioritaParm.policy.company === "Sara Assicurazioni" &&
    villaFioritaParm.policy.policyNumber === "48480OO" &&
    villaFioritaParm.policy.expiry?.toISOString() === "2025-12-31T00:00:00.000Z",
  "Villa Fiorita PARM insurance-position table resolves to its newest expired policy"
);

const migrationTmp = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-v3-migration-"));
try {
  const legacyPath = path.join(migrationTmp, "frontier.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE CrawlNodeEvidence (
      id TEXT PRIMARY KEY,
      crawlRunId TEXT NOT NULL,
      nodeId TEXT NOT NULL,
      canonicalUrl TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      resourceType TEXT NOT NULL,
      normalizedText TEXT NOT NULL DEFAULT '',
      policyText TEXT NOT NULL DEFAULT '',
      policyFound INTEGER NOT NULL DEFAULT 0,
      policyCandidate INTEGER NOT NULL DEFAULT 0,
      policySignalsJson TEXT,
      extractedEntityJson TEXT,
      ocrStatus TEXT,
      playwrightSource TEXT,
      extractedAt TEXT NOT NULL,
      UNIQUE(crawlRunId, contentHash)
    );
  `);
  legacy.close();
  const migrated = openFrontierStore(legacyPath);
  const migratedSchema = migrated
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'CrawlNodeEvidence'`
    )
    .get();
  ok(
    /UNIQUE\s*\(\s*crawlRunId\s*,\s*nodeId\s*,\s*contentHash\s*\)/i.test(
      String(migratedSchema?.sql || "")
    ),
    "migrates legacy hash-only evidence uniqueness losslessly"
  );
  closeFrontierStore();
} finally {
  closeFrontierStore();
  fs.rmSync(migrationTmp, { recursive: true, force: true });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-v3-"));
try {
  const coveragePath = path.join(tmp, "frontier.sqlite");
  openFrontierStore(coveragePath);
  const priorityRun = createCrawlRun({
    leadId: "lead-priority",
    runId: "run-priority",
  }).crawlRunId;
  upsertFrontierNode({
    crawlRunId: priorityRun,
    canonicalUrl: "https://clinic.example/blog/ordinary",
    resourceType: "html",
    relevance: "low",
  });
  const criticalNode = upsertFrontierNode({
    crawlRunId: priorityRun,
    canonicalUrl: "https://clinic.example/struttura",
    resourceType: "html",
    relevance: "critical",
  });
  ok(
    pickNextNodeForTest(priorityRun, Date.now())?.id === criticalNode.id,
    "drains critical/relevant pages before generic low-value frontier breadth"
  );

  const { crawlRunId } = createCrawlRun({ leadId: "lead-1", runId: "run-1" });
  const node = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/",
    resourceType: "html",
    relevance: "relevant",
  });
  transitionFrontierNode(node.id, "QUEUED");
  transitionFrontierNode(node.id, "FETCHING");
  transitionFrontierNode(node.id, "FETCHED", {
    contentHash: "a".repeat(64),
    contentType: "text/html",
  });
  transitionFrontierNode(node.id, "RENDERED");
  persistNodeEvidence({
    crawlRunId,
    nodeId: node.id,
    canonicalUrl: "https://clinic.example/",
    contentHash: "a".repeat(64),
    resourceType: "html",
    normalizedText: "Casa di cura privata",
    policyFound: false,
    policyCandidate: false,
    playwrightSource: "rendered",
  });
  transitionFrontierNode(node.id, "PARSED");
  transitionFrontierNode(node.id, "COMPLETED");
  setCrawlRunFlags(crawlRunId, {
    identityVerified: true,
    scopeVerified: true,
    sitemapStatus: "NOT_PRESENT",
  });
  ok(deriveExhaustiveSiteCoverage(crawlRunId).ok, "certifies fully evidenced rendered frontier");
  ok(deriveCrawlCompleteness(crawlRunId).complete, "strict completeness derives true");
  const stateProbe = new DatabaseSync(coveragePath);
  stateProbe.prepare(`UPDATE CrawlRun SET state = 'FAILED' WHERE id = ?`).run(crawlRunId);
  stateProbe.close();
  ok(
    !deriveExhaustiveSiteCoverage(crawlRunId).ok &&
      !deriveCrawlCompleteness(crawlRunId).complete,
    "persisted FAILED crawl run can never certify HOT"
  );
  const stateRestore = new DatabaseSync(coveragePath);
  stateRestore.prepare(`UPDATE CrawlRun SET state = 'RUNNING' WHERE id = ?`).run(crawlRunId);
  stateRestore.close();

  const duplicateHashNode = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/mirrored-shell",
    resourceType: "html",
    relevance: "low",
  });
  transitionFrontierNode(duplicateHashNode.id, "QUEUED");
  transitionFrontierNode(duplicateHashNode.id, "FETCHING");
  transitionFrontierNode(duplicateHashNode.id, "FETCHED", {
    contentHash: "a".repeat(64),
    contentType: "text/html",
  });
  transitionFrontierNode(duplicateHashNode.id, "RENDERED");
  persistNodeEvidence({
    crawlRunId,
    nodeId: duplicateHashNode.id,
    canonicalUrl: "https://clinic.example/mirrored-shell",
    contentHash: "a".repeat(64),
    resourceType: "html",
    normalizedText: "Casa di cura privata, route SPA renderizzata",
    policyFound: false,
    policyCandidate: false,
    playwrightSource: "rendered",
  });
  transitionFrontierNode(duplicateHashNode.id, "PARSED");
  transitionFrontierNode(duplicateHashNode.id, "COMPLETED");
  ok(
    deriveExhaustiveSiteCoverage(crawlRunId).ok,
    "identical response bytes retain per-node rendered evidence"
  );

  const candidateNode = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/copertura",
    resourceType: "html",
    relevance: "relevant",
  });
  transitionFrontierNode(candidateNode.id, "QUEUED");
  transitionFrontierNode(candidateNode.id, "FETCHING");
  transitionFrontierNode(candidateNode.id, "FETCHED", {
    contentHash: "b".repeat(64),
    contentType: "text/html",
  });
  transitionFrontierNode(candidateNode.id, "RENDERED");
  persistNodeEvidence({
    crawlRunId,
    nodeId: candidateNode.id,
    canonicalUrl: "https://clinic.example/copertura",
    contentHash: "b".repeat(64),
    resourceType: "html",
    normalizedText: "Contratto assicurativo responsabilità civile ABX/991122",
    policyFound: false,
    policyCandidate: true,
    playwrightSource: "rendered",
  });
  transitionFrontierNode(candidateNode.id, "PARSED");
  transitionFrontierNode(candidateNode.id, "COMPLETED");
  const blocked = deriveExhaustiveSiteCoverage(crawlRunId);
  ok(
    !blocked.ok && blocked.unresolvedCandidates === 1,
    "unresolved insurance candidate blocks HOT coverage"
  );
  ok(!deriveCrawlCompleteness(crawlRunId).complete, "candidate keeps strict crawl non-terminal");

  transitionFrontierNode(candidateNode.id, "QUEUED");
  transitionFrontierNode(candidateNode.id, "FETCHING");
  transitionFrontierNode(candidateNode.id, "FETCHED", {
    contentHash: "c".repeat(64),
    contentType: "text/html",
  });
  transitionFrontierNode(candidateNode.id, "RENDERED");
  persistNodeEvidence({
    crawlRunId,
    nodeId: candidateNode.id,
    canonicalUrl: "https://clinic.example/copertura",
    contentHash: "c".repeat(64),
    resourceType: "html",
    normalizedText: "Pagina informativa senza dati assicurativi.",
    policyFound: false,
    policyCandidate: false,
    playwrightSource: "rendered",
  });
  transitionFrontierNode(candidateNode.id, "PARSED");
  transitionFrontierNode(candidateNode.id, "COMPLETED");
  ok(
    deriveExhaustiveSiteCoverage(crawlRunId).unresolvedCandidates === 0,
    "historical candidate evidence cannot block a recertified current resource"
  );

  const legacyFalsePublished = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/contatti",
    resourceType: "html",
    relevance: "relevant",
  });
  transitionFrontierNode(legacyFalsePublished.id, "QUEUED");
  transitionFrontierNode(legacyFalsePublished.id, "FETCHING");
  transitionFrontierNode(legacyFalsePublished.id, "FETCHED", {
    contentHash: "d".repeat(64),
    contentType: "text/html",
  });
  transitionFrontierNode(legacyFalsePublished.id, "RENDERED");
  persistNodeEvidence({
    crawlRunId,
    nodeId: legacyFalsePublished.id,
    canonicalUrl: "https://clinic.example/contatti",
    contentHash: "d".repeat(64),
    resourceType: "html",
    normalizedText: "Pagina contatti AXA date 01/01/2022 - 05/03/2023",
    policyFound: true,
    policyCandidate: false,
    policySignalsJson: { candidateDetectorVersion: "policy-candidate-v6" },
    playwrightSource: "rendered",
  });
  transitionFrontierNode(legacyFalsePublished.id, "PARSED");
  transitionFrontierNode(legacyFalsePublished.id, "COMPLETED");
  prepareFrontierForExhaustiveCoverage(crawlRunId);
  ok(
    listNodes(crawlRunId).find((item) => item.id === legacyFalsePublished.id)?.state ===
      "QUEUED",
    "detector-version upgrade reopens legacy positives even before candidate tracking"
  );

  const scriptArtifact = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/doctor_cat/i.old,c.bg?.image?.src",
    resourceType: "html",
    relevance: "low",
    discoverySource: "embedded-resource",
  });
  transitionFrontierNode(scriptArtifact.id, "QUEUED");
  prepareFrontierForExhaustiveCoverage(crawlRunId);
  const excludedArtifact = listNodes(crawlRunId).find(
    (item) => item.id === scriptArtifact.id
  );
  ok(
    excludedArtifact?.state === "EXCLUDED" &&
      excludedArtifact.exclusionReason === "SCRIPT_EXPRESSION_ARTIFACT",
    "recertification safely removes historical JavaScript-expression routes"
  );
  const minifiedExpressionArtifact = upsertFrontierNode({
    crawlRunId,
    canonicalUrl:
      "https://clinic.example/c.substring(0,1024/+o.slides[g]+",
    resourceType: "html",
    relevance: "low",
    discoverySource: "embedded-resource",
  });
  transitionFrontierNode(minifiedExpressionArtifact.id, "QUEUED");
  prepareFrontierForExhaustiveCoverage(crawlRunId);
  ok(
    listNodes(crawlRunId).find(
      (item) => item.id === minifiedExpressionArtifact.id
    )?.exclusionReason === "SCRIPT_EXPRESSION_ARTIFACT",
    "recertification removes substring and array-index minified-code URLs"
  );
  const shortIdentifierArtifact = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/Kc",
    resourceType: "html",
    relevance: "low",
    discoverySource: "embedded-resource",
  });
  transitionFrontierNode(shortIdentifierArtifact.id, "QUEUED");
  const artifactChild = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/Kc/generated-child",
    resourceType: "html",
    relevance: "low",
    discoverySource: "html-resource",
    parentUrl: "https://clinic.example/Kc",
  });
  transitionFrontierNode(artifactChild.id, "QUEUED");
  prepareFrontierForExhaustiveCoverage(crawlRunId);
  const artifactBranch = listNodes(crawlRunId).filter(
    (item) =>
      item.id === shortIdentifierArtifact.id || item.id === artifactChild.id
  );
  ok(
    artifactBranch.every(
      (item) =>
        item.state === "EXCLUDED" &&
        item.exclusionReason === "SCRIPT_EXPRESSION_ARTIFACT"
    ),
    "recertification removes short identifiers and their synthetic descendants"
  );

  const executableUtility = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/utility/download/viewer/xlsviewer.exe",
    resourceType: "html",
    relevance: "low",
    discoverySource: "html-link",
  });
  transitionFrontierNode(executableUtility.id, "QUEUED");
  prepareFrontierForExhaustiveCoverage(crawlRunId);
  const excludedExecutable = listNodes(crawlRunId).find(
    (item) => item.id === executableUtility.id
  );
  ok(
    excludedExecutable?.state === "EXCLUDED" &&
      excludedExecutable.exclusionReason === "NON_DOCUMENT_MEDIA",
    "recertification excludes executable viewer utilities without fetching them"
  );

  const cacheBustedAssets = ["82392", "57832"].map((dummy) =>
    upsertFrontierNode({
      crawlRunId,
      canonicalUrl: `https://clinic.example/config/stemma.jpg?dummy=${dummy}`,
      resourceType: "image",
      relevance: "low",
      discoverySource: "html-resource-inline",
    })
  );
  ok(
    cacheBustedAssets[0].id === cacheBustedAssets[1].id,
    "frontier canonicalization collapses duplicate random cache-buster assets"
  );
} finally {
  closeFrontierStore();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: "exhaustive-site-coverage", pass, fail: 0, exitCode: 0 }));
