/**
 * STOP-SHIP: TECHNICAL_BLOCKED is admin terminal in checkpoint (stops hot-loops),
 * but never a commercial client terminal (isTerminalState stays false).
 */
import {
  classifyResult,
  isTerminalState,
} from "./revalidate-checkpoint-v3.mjs";

const cases = [
  [{ processingState: "TECHNICAL_BLOCKED", reasonCode: "RETRY_EXHAUSTED_5" }, "terminal"],
  [{ processingState: "RETRY_PENDING", error: "LEAD_WALL_TIMEOUT_1800000ms" }, "retry"],
  [{ processingState: "HOT_VERIFIED", newVerdict: "HOT", crawlComplete: true }, "terminal"],
  [{ processingState: "PUBLISHED_CURRENT", newVerdict: "PUBLISHED" }, "terminal"],
  [{ processingState: "REVIEW_HUMAN" }, "terminal"],
];

let fail = 0;
for (const [row, expect] of cases) {
  const got = classifyResult(row).kind;
  const ok = got === expect;
  console.log(ok ? "PASS" : "FAIL", row.processingState || row.reasonCode, "→", got, "expected", expect);
  if (!ok) fail++;
}
console.log("isTerminalState(TECHNICAL_BLOCKED)=", isTerminalState("TECHNICAL_BLOCKED"));
if (isTerminalState("TECHNICAL_BLOCKED")) {
  console.log("FAIL commercial isTerminalState(TECHNICAL_BLOCKED) must stay false");
  fail++;
}
process.exit(fail ? 1 : 0);
