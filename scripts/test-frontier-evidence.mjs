/**
 * Frontier evidence persistence across slices/resumes (no network).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  upsertFrontierNode,
  transitionFrontierNode,
  listNodes,
  persistNodeEvidence,
  aggregatePersistedEvidence,
  classifyTerminalMissingUrl,
} from "../src/lib/sanita/frontier-store.ts";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-ev-"));
const dbPath = path.join(dir, "evidence.sqlite");

function freshRun() {
  closeFrontierStore();
  openFrontierStore(dbPath);
  return createCrawlRun({
    leadId: "lead-ev",
    runId: `ev-${Date.now()}`,
    workerId: "test",
  });
}

// first_slice_identity_survives_final_slice
{
  const { crawlRunId } = freshRun();
  const home = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/",
    discoverySource: "seed",
    resourceType: "html",
    relevance: "critical",
  });
  const about = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/chi-siamo",
    discoverySource: "html-link",
    resourceType: "html",
    relevance: "relevant",
  });
  const homeText = "Casa di Cura Heidy — assistenza sanitaria";
  const hash1 = createHash("sha256").update(homeText).digest("hex");
  persistNodeEvidence({
    crawlRunId,
    nodeId: home.id,
    canonicalUrl: "https://clinic.example/",
    contentHash: hash1,
    resourceType: "html",
    normalizedText: homeText,
  });
  transitionFrontierNode(home.id, "QUEUED");
  transitionFrontierNode(home.id, "FETCHING");
  transitionFrontierNode(home.id, "FETCHED");
  transitionFrontierNode(home.id, "PARSED");
  transitionFrontierNode(home.id, "COMPLETED");
  // slice 2 only processes about — home evidence must remain
  const hash2 = createHash("sha256").update("Chi siamo page").digest("hex");
  persistNodeEvidence({
    crawlRunId,
    nodeId: about.id,
    canonicalUrl: "https://clinic.example/chi-siamo",
    contentHash: hash2,
    resourceType: "html",
    normalizedText: "Chi siamo page",
  });
  transitionFrontierNode(about.id, "QUEUED");
  transitionFrontierNode(about.id, "FETCHING");
  transitionFrontierNode(about.id, "FETCHED");
  transitionFrontierNode(about.id, "PARSED");
  transitionFrontierNode(about.id, "COMPLETED");
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(agg.pagesText.includes("Heidy"), "first_slice_identity_survives_final_slice");
}

// policy_signal_survives_restart
{
  const { crawlRunId } = freshRun();
  const pdf = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/polizza.pdf",
    discoverySource: "html-link",
    resourceType: "pdf",
    relevance: "critical",
  });
  const policyText = "Polizza RC UnipolSai massimale 5.000.000 scadenza 2025-12-31";
  const hash = createHash("sha256").update(policyText).digest("hex");
  persistNodeEvidence({
    crawlRunId,
    nodeId: pdf.id,
    canonicalUrl: "https://clinic.example/polizza.pdf",
    contentHash: hash,
    resourceType: "pdf",
    normalizedText: policyText,
    policyText,
    policyFound: true,
  });
  closeFrontierStore();
  openFrontierStore(dbPath);
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(agg.policyFound && /UnipolSai/i.test(agg.policyText), "policy_signal_survives_restart");
}

// aggregate_reads_persisted_evidence
{
  const { crawlRunId } = freshRun();
  const n = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://x.it/trasparenza",
    discoverySource: "seed_guess",
    resourceType: "html",
    relevance: "critical",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: n.id,
    canonicalUrl: "https://x.it/trasparenza",
    contentHash: createHash("sha256").update("trasparenza").digest("hex"),
    resourceType: "html",
    normalizedText: "Sezione trasparenza assicurazione",
  });
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(/trasparenza/i.test(agg.pagesText), "aggregate_reads_persisted_evidence");
}

// stale detector evidence must never contaminate the current node content
{
  const { crawlRunId } = freshRun();
  const node = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/contatti",
    discoverySource: "html-link",
    resourceType: "html",
    relevance: "low",
  });
  const staleHash = createHash("sha256").update("stale AXA").digest("hex");
  persistNodeEvidence({
    crawlRunId,
    nodeId: node.id,
    canonicalUrl: "https://clinic.example/contatti",
    contentHash: staleHash,
    resourceType: "html",
    normalizedText: "AXA 01/01/2022 - 05/03/2023",
    policyText: "AXA 01/01/2022 - 05/03/2023",
    policyFound: true,
    policySignalsJson: { company: "AXA", expiry: "2023-03-05T00:00:00.000Z" },
  });
  const currentHash = createHash("sha256").update("current contact").digest("hex");
  persistNodeEvidence({
    crawlRunId,
    nodeId: node.id,
    canonicalUrl: "https://clinic.example/contatti",
    contentHash: currentHash,
    resourceType: "html",
    normalizedText: "Contatti e orari della clinica",
    policyFound: false,
    policySignalsJson: { candidateDetectorVersion: "policy-candidate-v14" },
  });
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(
    !agg.policyFound && !/AXA/.test(agg.pagesText),
    "aggregate_ignores_stale_policy_evidence_for_previous_node_hash"
  );
}

// strongest concrete policy source wins over a weaker generic positive
{
  const { crawlRunId } = freshRun();
  const contact = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/contatti",
    discoverySource: "html-link",
    resourceType: "html",
    relevance: "low",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: contact.id,
    canonicalUrl: "https://clinic.example/contatti",
    contentHash: createHash("sha256").update("weak").digest("hex"),
    resourceType: "html",
    normalizedText: "Polizza assicurativa con AXA",
    policyText: "Polizza assicurativa con AXA",
    policyFound: true,
    policySignalsJson: { company: "AXA" },
  });
  const transparency = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://clinic.example/amministrazione-trasparente",
    discoverySource: "html-link",
    resourceType: "html",
    relevance: "critical",
  });
  const exact =
    "POLIZZA ASSICURATIVA VILLA CINZIA AMTRUST RCH00020000239 SCAD. 04/11/2026";
  persistNodeEvidence({
    crawlRunId,
    nodeId: transparency.id,
    canonicalUrl: "https://clinic.example/amministrazione-trasparente",
    contentHash: createHash("sha256").update(exact).digest("hex"),
    resourceType: "html",
    normalizedText: exact,
    policyText: exact,
    policyFound: true,
    policySignalsJson: {
      company: "AmTrust",
      policyNumber: "RCH00020000239",
      expiry: "2026-11-04T00:00:00.000Z",
    },
  });
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(
    agg.policyFound &&
      /amministrazione-trasparente/.test(agg.policyUrl || "") &&
      /RCH00020000239/.test(agg.policyText),
    "aggregate_selects_strongest_concrete_policy_source"
  );
}

// newest versioned policy wins even when an older policy was persisted first
{
  const { crawlRunId } = freshRun();
  for (const policy of [
    {
      year: 2023,
      company: "Reale Mutua",
      number: "OLD-2023",
      expiry: "2023-12-31T00:00:00.000Z",
    },
    {
      year: 2025,
      company: "Italian Assicurazioni",
      number: "2024/07/6328654",
      expiry: "2025-12-31T00:00:00.000Z",
    },
  ]) {
    const url = `https://clinic.example/Polizza-RCT-RCO-${policy.year}.pdf`;
    const text = `Polizza RCT RCO ${policy.company} ${policy.number} scadenza ${policy.expiry}`;
    const node = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: url,
      discoverySource: "html-link",
      resourceType: "pdf",
      relevance: "critical",
    });
    persistNodeEvidence({
      crawlRunId,
      nodeId: node.id,
      canonicalUrl: url,
      contentHash: createHash("sha256").update(text).digest("hex"),
      resourceType: "pdf",
      normalizedText: text,
      policyText: text,
      policyFound: true,
      policySignalsJson: {
        company: policy.company,
        policyNumber: policy.number,
        expiry: policy.expiry,
      },
    });
  }
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(
    agg.policyFound &&
      /2025\.pdf/.test(agg.policyUrl || "") &&
      /Italian Assicurazioni/.test(agg.policyText) &&
      /6328654/.test(agg.policyText),
    "aggregate_selects_newest_versioned_policy"
  );
}

// duplicate_content_hash_is_not_duplicated
{
  const { crawlRunId } = freshRun();
  const hash = createHash("sha256").update("same").digest("hex");
  for (let i = 0; i < 2; i++) {
    const n = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: `https://dup.example/p${i}`,
      discoverySource: "html-link",
      resourceType: "html",
      relevance: "low",
    });
    persistNodeEvidence({
      crawlRunId,
      nodeId: n.id,
      canonicalUrl: `https://dup.example/p${i}`,
      contentHash: hash,
      resourceType: "html",
      normalizedText: "same content body",
    });
  }
  const d = aggregatePersistedEvidence(crawlRunId);
  const count = (d.pagesText.match(/same content body/g) || []).length;
  ok(count <= 1, "duplicate_content_hash_is_not_duplicated");
}

// empty_final_slice_does_not_erase_corpus
{
  const { crawlRunId } = freshRun();
  const n = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://keep.example/",
    discoverySource: "seed",
    resourceType: "html",
    relevance: "critical",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: n.id,
    canonicalUrl: "https://keep.example/",
    contentHash: createHash("sha256").update("corpus").digest("hex"),
    resourceType: "html",
    normalizedText: "corpus preserved across empty slice",
  });
  const emptySlice = { pagesText: "", policyText: "", policyFound: false };
  const agg = aggregatePersistedEvidence(crawlRunId);
  const merged = agg.pagesText || emptySlice.pagesText;
  ok(/preserved/.test(merged), "empty_final_slice_does_not_erase_corpus");
}

// playwright_evidence_survives_resume
{
  const { crawlRunId } = freshRun();
  const n = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://pw.example/api/config.json",
    discoverySource: "playwright_xhr",
    resourceType: "json",
    relevance: "relevant",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: n.id,
    canonicalUrl: "https://pw.example/api/config.json",
    contentHash: createHash("sha256").update('{"policy":true}').digest("hex"),
    resourceType: "json",
    normalizedText: '{"assicurazione":"rc"}',
    playwrightSource: "adaptive",
  });
  closeFrontierStore();
  openFrontierStore(dbPath);
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(/assicurazione/.test(agg.pagesText), "playwright_evidence_survives_resume");
}

// pdf_evidence_survives_resume
{
  const { crawlRunId } = freshRun();
  const n = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://pdf.example/doc.pdf",
    discoverySource: "sitemap",
    resourceType: "pdf",
    relevance: "critical",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: n.id,
    canonicalUrl: "https://pdf.example/doc.pdf",
    contentHash: createHash("sha256").update("pdfbytes").digest("hex"),
    resourceType: "pdf",
    normalizedText: "Documento assicurativo PDF estratto",
    policyText: "RC professionale",
    policyFound: true,
  });
  closeFrontierStore();
  openFrontierStore(dbPath);
  const agg = aggregatePersistedEvidence(crawlRunId);
  ok(agg.policyFound && /RC professionale/.test(agg.policyText), "pdf_evidence_survives_resume");
}

// 404 classification
{
  const seed = classifyTerminalMissingUrl({ status: 404, discoverySource: "seed_guess", retryCount: 1 });
  ok(seed.state === "EXCLUDED" && seed.reasonCode === "SEED_NOT_PRESENT", "guessed_seed_404_is_excluded");
  const sm = classifyTerminalMissingUrl({ status: 404, discoverySource: "sitemap", retryCount: 1 });
  ok(sm.state === "EXCLUDED" && sm.reasonCode === "STALE_SITEMAP_URL", "sitemap_404_is_excluded");
  const link = classifyTerminalMissingUrl({ status: 410, discoverySource: "html-link", retryCount: 1 });
  ok(link.state === "EXCLUDED" && link.reasonCode === "BROKEN_INTERNAL_LINK", "broken_internal_link_is_excluded");
  const brief = classifyTerminalMissingUrl({ status: 404, discoverySource: "seed_guess", retryCount: 0 });
  ok(brief.state === "RETRY_PENDING", "404 brief retry before exclude");
}

// excluded_404_does_not_increment_failed
{
  const { crawlRunId } = freshRun();
  const n = upsertFrontierNode({
    crawlRunId,
    canonicalUrl: "https://ex.example/trasparenza",
    discoverySource: "seed_guess",
    resourceType: "html",
    relevance: "critical",
  });
  transitionFrontierNode(n.id, "QUEUED");
  transitionFrontierNode(n.id, "FETCHING");
  transitionFrontierNode(n.id, "FETCHED");
  transitionFrontierNode(n.id, "PARSED");
  transitionFrontierNode(n.id, "EXCLUDED", {
    httpStatus: 404,
    exclusionReason: "SEED_NOT_PRESENT",
    lastError: "SEED_NOT_PRESENT",
  });
  const nodes = listNodes(crawlRunId);
  ok(nodes.filter((x) => x.state === "TECHNICAL_BLOCKED").length === 0, "excluded_404_does_not_increment_failed");
  ok(nodes.filter((x) => x.state === "EXCLUDED").length === 1, "excluded terminal state");
}

closeFrontierStore();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* */
}

const elapsed = Date.now() - start;
console.log(
  JSON.stringify(
    { suite: "frontier-evidence", exitCode: fail === 0 ? 0 : 1, durationMs: elapsed, pass, fail, skipped: 0 },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
