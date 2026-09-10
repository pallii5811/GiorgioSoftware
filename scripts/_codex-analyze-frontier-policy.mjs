import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = process.env.APP_DIR || path.resolve(import.meta.dirname, "..");
const frontier = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/frontier-store.ts")).href
);
const detector = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/detector.ts")).href
);
const schedaModule = await import(
  pathToFileURL(path.join(appDir, "src/lib/sanita/policy-scheda-extract.ts")).href
);

const [frontierPath, crawlRunId] = process.argv.slice(2);
if (!frontierPath || !crawlRunId) throw new Error("frontier path and crawl run id required");

frontier.openFrontierStore(frontierPath);
const aggregate = frontier.aggregatePersistedEvidence(crawlRunId);
frontier.closeFrontierStore();
const analysis = detector.analyzePolicy(aggregate.policyText, aggregate.policyUrl || undefined);
const scheda = schedaModule.extractSchedaPolizzaFields(aggregate.policyText);
console.log(JSON.stringify({
  policyUrl: aggregate.policyUrl,
  policyTextLength: aggregate.policyText.length,
  policyTextHead: aggregate.policyText.slice(0, 2600),
  analysis: {
    ...analysis,
    expiry: analysis.expiry?.toISOString() ?? null,
  },
  scheda: {
    ...scheda,
    decorrenza: scheda.decorrenza?.toISOString() ?? null,
    expiry: scheda.expiry?.toISOString() ?? null,
    nextPayment: scheda.nextPayment?.toISOString() ?? null,
  },
}, null, 2));
