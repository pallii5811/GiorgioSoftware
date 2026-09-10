import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  aggregatePersistedEvidence,
  closeFrontierStore,
  createCrawlRun,
  openFrontierStore,
  persistNodeEvidence,
  upsertFrontierNode,
} from "../src/lib/sanita/frontier-store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-version-frontier-"));
const dbPath = path.join(dir, "frontier.sqlite");
openFrontierStore(dbPath);
const { crawlRunId } = createCrawlRun({ leadId: "villa-verde", runId: "version-test", workerId: "test" });

for (const policy of [
  { year: 2023, company: "Reale Mutua", number: "OLD-2023" },
  { year: 2025, company: "Italian Assicurazioni", number: "2024/07/6328654" },
]) {
  const canonicalUrl = `https://clinic.example/Polizza-RCT-RCO-${policy.year}.pdf`;
  const policyText = `Polizza ${policy.company} ${policy.number}`;
  const node = upsertFrontierNode({
    crawlRunId,
    canonicalUrl,
    discoverySource: "html-link",
    resourceType: "pdf",
    relevance: "critical",
  });
  persistNodeEvidence({
    crawlRunId,
    nodeId: node.id,
    canonicalUrl,
    contentHash: createHash("sha256").update(policyText).digest("hex"),
    resourceType: "pdf",
    normalizedText: policyText,
    policyText,
    policyFound: true,
  });
}

const aggregate = aggregatePersistedEvidence(crawlRunId);
closeFrontierStore();
fs.rmSync(dir, { recursive: true, force: true });

if (
  !/2025\.pdf/.test(aggregate.policyUrl || "") ||
  !/Italian Assicurazioni/.test(aggregate.policyText) ||
  !/6328654/.test(aggregate.policyText)
) {
  console.error("FAIL newest policy was not selected", aggregate);
  process.exit(1);
}

console.log("PASS newest versioned policy is selected from persisted frontier evidence");
