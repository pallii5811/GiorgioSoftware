/**
 * State machine: technical → RETRY_PENDING (not REVIEW_HUMAN); preserve PUB BV.
 */
import {
  isTechnicalTransientError,
  resolveAfterTechnicalFailure,
  isCommercialUiVisible,
  stampProcessingMeta,
  readProcessingState,
  readBusinessVerdict,
  readValidationStatus,
} from "../src/lib/sanita/processing-state.ts";

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

ok(isTechnicalTransientError("timeout 5000"), "timeout is technical");
ok(isTechnicalTransientError("HTTP 403 WAF"), "403 is technical");
ok(isTechnicalTransientError("429 Too Many"), "429 is technical");
ok(!isTechnicalTransientError("two entities plausible"), "ambiguity not technical");

const hist = "[V:PUB] Polizza storica Unipol RC-1 [BV:PUBLISHED_EXPIRED]";
const r1 = resolveAfterTechnicalFailure({
  previousEvidence: hist,
  error: "timeout",
  retriesExhausted: false,
});
ok(r1.keepLegacyToken === "PUBLISHED", "preserve PUB token");
ok(r1.state === "RETRY_PENDING", "tech → RETRY_PENDING");
ok(r1.validationStatus === "REVALIDATION_PENDING", "VS revalidation");
ok(r1.businessVerdict === "PUBLISHED_EXPIRED", "BV preserved expired");
ok(!isCommercialUiVisible("RETRY_PENDING"), "RETRY hidden from commercial UI");
ok(isCommercialUiVisible("HOT_VERIFIED"), "HOT visible");
ok(isCommercialUiVisible("REVIEW_HUMAN"), "REVIEW_HUMAN visible as separate queue");

const r2 = resolveAfterTechnicalFailure({
  previousEvidence: hist,
  error: "timeout",
  retriesExhausted: true,
});
ok(r2.state === "TECHNICAL_BLOCKED", "exhausted → TECHNICAL_BLOCKED");
ok(r2.keepLegacyToken === "PUBLISHED", "still keep PUB business");

const stamped = stampProcessingMeta("body", {
  state: "RETRY_PENDING",
  businessVerdict: "PUBLISHED_CURRENT",
  validationStatus: "REVALIDATION_PENDING",
});
ok(readProcessingState(stamped) === "RETRY_PENDING", "read STATE");
ok(readBusinessVerdict(stamped) === "PUBLISHED_CURRENT", "read BV");
ok(readValidationStatus(stamped) === "REVALIDATION_PENDING", "read VS");

const amb = resolveAfterTechnicalFailure({
  previousEvidence: "[V:REV] ambiguous entities",
  error: "timeout",
  retriesExhausted: false,
});
ok(amb.state === "RETRY_PENDING", "non-PUB tech still RETRY first");
ok(amb.businessVerdict !== "REVIEW_HUMAN" || amb.state === "RETRY_PENDING", "not human review on first tech fail");

console.log(
  JSON.stringify(
    { suite: "state-machine", exitCode: fail === 0 ? 0 : 1, durationMs: Date.now() - start, pass, fail },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
