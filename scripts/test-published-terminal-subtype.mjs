import assert from "node:assert/strict";
import { resolveTerminalProcessing } from "../src/lib/sanita/terminal-processing.ts";

const gatewayDecision = {
  allowed: true,
  legacyVerdict: "PUBLISHED",
  evidenceBody: "policy",
  businessVerdict: "PUBLISHED_CURRENT",
  validationStatus: "CURRENT_VERIFIED",
  processingState: "PUBLISHED_CURRENT",
};

const expired = resolveTerminalProcessing({
  legacyVerdict: "PUBLISHED",
  gatewayDecision,
  finProcessingHint: null,
  ocrTechReason: "",
  identityStatus: "OFFICIAL_CONFIRMED",
  finalComplete: false,
  crawlOk: true,
  humanConflict: false,
  publishedSubtype: "PUBLISHED_EXPIRED",
});

assert.equal(expired.processingState, "PUBLISHED_EXPIRED");
assert.equal(expired.businessVerdict, "PUBLISHED_EXPIRED");
assert.equal(expired.counterKind, "published");
assert.equal(expired.packAsRetry, false);
console.log("PASS published terminal metadata follows the certified subtype");
