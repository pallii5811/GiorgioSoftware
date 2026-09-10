import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CRAWL_REQUIRE_EXHAUSTIVE_SITE = "1";
process.env.CRAWL_RENDER_EVERY_HTML = "0";

const root = mkdtempSync(join(tmpdir(), "frontier-identity-finalization-"));
const file = join(root, "frontier.sqlite");
const frontier = await import("../src/lib/sanita/frontier-store.ts");

try {
  frontier.openFrontierStore(file);

  const makeExhaustedRun = (leadId) => {
    const { crawlRunId } = frontier.createCrawlRun({
      leadId,
      runId: `test-${leadId}`,
      workerId: "test-worker",
    });
    frontier.setCrawlRunFlags(crawlRunId, { sitemapStatus: "NOT_PRESENT" });
    const { id: nodeId } = frontier.upsertFrontierNode({
      crawlRunId,
      canonicalUrl: `https://${leadId}.example/`,
      discoverySource: "seed",
      resourceType: "html",
      relevance: "low",
    });
    const node = frontier.listNodes(crawlRunId).find((item) => item.id === nodeId);
    assert.ok(node);
    frontier.transitionFrontierNode(node.id, "QUEUED");
    frontier.transitionFrontierNode(node.id, "EXCLUDED", {
      lastError: "NON_DOCUMENT_MEDIA",
      exclusionReason: "NON_DOCUMENT_MEDIA",
    });
    return crawlRunId;
  };

  const verifiedRun = makeExhaustedRun("verified");
  frontier.completeCrawlRun(verifiedRun, "frontier_exhausted");
  assert.equal(frontier.getCrawlRun(verifiedRun)?.state, "FAILED");
  frontier.setCrawlRunFlags(verifiedRun, {
    identityVerified: true,
    scopeVerified: true,
  });
  const verified = frontier.finalizeExhaustedCrawlRunAfterIdentity(verifiedRun);
  assert.equal(verified.complete, true);
  assert.equal(frontier.getCrawlRun(verifiedRun)?.state, "COMPLETED");

  const unverifiedRun = makeExhaustedRun("unverified");
  const unverified = frontier.finalizeExhaustedCrawlRunAfterIdentity(unverifiedRun);
  assert.equal(unverified.complete, false);
  assert.equal(frontier.getCrawlRun(unverifiedRun)?.state, "FAILED");
  assert.equal(frontier.getCrawlRun(unverifiedRun)?.workerLock, null);

  console.log("frontier identity finalization: ok");
} finally {
  frontier.closeFrontierStore();
  rmSync(root, { recursive: true, force: true });
}
