/**
 * Resolution waterfall — no terminal HOT/PUB.
 */
import { runResolutionWaterfall, waterfallStepOrder } from "../src/lib/sanita/resolution-waterfall.ts";

const start = Date.now();
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

const order = waterfallStepOrder();
ok(order[0] === "http_fetch", "first step http_fetch");
ok(order.includes("institutional_domain_resolve"), "has institutional resolve");
ok(order.length >= 15, `>=15 site steps (got ${order.length})`);

const out = await runResolutionWaterfall({
  stopOnFirstSuccess: true,
  probe: async (step) => {
    if (step === "http_fetch") return { success: false, error: "403" };
    if (step === "retry_backoff") return { success: false, error: "403" };
    if (step === "www_variant") return { success: true, evidenceAdded: ["https://www.example.it"] };
    return { success: false, error: "skip" };
  },
});
ok(out.terminalVerdictEmitted === false, "waterfall never emits terminal verdict");
ok(out.technicalStatus === "RESOLVED_CANDIDATE", `status=${out.technicalStatus}`);
ok(out.steps.some((s) => s.step === "www_variant" && s.success), "www step success recorded");

const exhausted = await runResolutionWaterfall({
  probe: async () => ({ success: false, error: "timeout" }),
});
ok(exhausted.terminalVerdictEmitted === false, "exhausted still no verdict");
ok(exhausted.technicalStatus !== "RESOLVED_CANDIDATE", "exhausted not resolved");

console.log(
  JSON.stringify(
    { suite: "resolution-waterfall", exitCode: fail === 0 ? 0 : 1, durationMs: Date.now() - start, pass, fail },
    null,
    2
  )
);
process.exit(fail === 0 ? 0 : 1);
