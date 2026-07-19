/**
 * Published fast-path unit test — local HTTP fixture (no external net).
 */
import http from "node:http";
import { runPublishedFastPath } from "../src/lib/sanita/published-fast-path.ts";

const start = Date.now();
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

const htmlBody = `<html><body>
<h1>Amministrazione Trasparente</h1>
<p>Polizza RC numero TEST-FP-001 Compagnia UnipolSai Massimale Euro 5000000
scadenza 31/12/2027 Contraente Clinica Test gestione responsabilità civile RCT RCO
Partita IVA 12345678903 Comune di Napoli Tel 0811234567</p>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url?.includes("polizza")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(htmlBody);
  } else {
    res.writeHead(404);
    res.end("no");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const docUrl = `http://127.0.0.1:${port}/polizza.html`;

const evidence = `[V:PUB] storico — [DOCS: ${docUrl}]`;
const result = await runPublishedFastPath({
  leadId: "fp1",
  companyName: "Clinica Test",
  website: `http://127.0.0.1:${port}/`,
  category: "Casa di cura",
  evidence,
  city: "Napoli",
  phone: "0811234567",
  piva: "12345678903",
  identityStatus: "OFFICIAL_CONFIRMED",
  facilityFingerprint: {
    facilityName: "Clinica Test",
    legalName: "Clinica Test SRL",
    municipality: "Napoli",
    phone: "0811234567",
    vatId: "12345678903",
    domain: "127.0.0.1",
  },
});

ok(result.contentAcquired, "content acquired from historical DOCS URL");
ok(result.exactUrl === docUrl, "exact URL preserved");
ok(Boolean(result.contentHash), "hash recorded");
ok(result.publishedOk, `canEmitPublished ok (${(result.reasons || []).join("; ")})`);
ok(!String(result.techError || "").includes("timeout_crawlSite_45000"), "no monolithic timeout");

// CCNL must NOT certify as PUBLISHED_CURRENT
const ccnlBody = `<html><body>CCNL ARIS RSA Contratto collettivo nazionale di lavoro personale</body></html>`;
const ccnlServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(ccnlBody);
});
await new Promise((r) => ccnlServer.listen(0, "127.0.0.1", r));
const cPort = ccnlServer.address().port;
const ccnlUrl = `http://127.0.0.1:${cPort}/docs/CCNLarisrsa.html`;
const ccnl = await runPublishedFastPath({
  leadId: "fp-ccnl",
  companyName: "Antoniano",
  website: `http://127.0.0.1:${cPort}/`,
  category: "Casa di cura",
  evidence: `[V:PUB] — [DOCS: ${ccnlUrl}]`,
  policyCompany: "UnipolSai",
  policyNumber: "HIST-OLD",
  identityStatus: "OFFICIAL_CONFIRMED",
});
ok(!ccnl.publishedOk, "ccnl_is_not_policy: publishedOk false");
ok(ccnl.validationStatus !== "CURRENT_VERIFIED", "ccnl not CURRENT_VERIFIED");
ok(
  ccnl.negativeKind === "CCNL" || /documento_negativo|CCNL/i.test((ccnl.reasons || []).join(" ")),
  `ccnl negative classified (kind=${ccnl.negativeKind} reasons=${(ccnl.reasons || []).join(";")})`
);
ccnlServer.close();

const tech = await runPublishedFastPath({
  leadId: "fp2",
  companyName: "Clinica Test",
  website: `http://127.0.0.1:${port}/`,
  category: "Casa di cura",
  evidence: `[V:PUB] x — [DOCS: http://127.0.0.1:${port}/missing.html]`,
  identityStatus: "OFFICIAL_CONFIRMED",
});
ok(tech.keepLegacyToken === "PUBLISHED", "tech fail keeps PUBLISHED token");
ok(
  tech.processingState === "RETRY_PENDING" || tech.processingState === "TECHNICAL_BLOCKED",
  "tech → RETRY_PENDING/TECHNICAL_BLOCKED"
);

server.close();

console.log(
  JSON.stringify(
    {
      suite: "published-fast-path",
      exitCode: fail === 0 ? 0 : 1,
      durationMs: Date.now() - start,
      pass,
      fail,
      skipped: 0,
    },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
