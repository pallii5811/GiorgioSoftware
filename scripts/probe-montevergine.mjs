import { externalFetch } from "../src/lib/http.ts";
import { extractPageText } from "../src/lib/sanita/extract-embedded.ts";
import { analyzePolicy, isGelliComplianceReportText } from "../src/lib/sanita/detector.ts";
import { hasStrongRcPolicySignal, pageCountsAsPolicyRelevant } from "../src/lib/sanita/crawler.ts";

const url = "https://www.clinicamontevergine.com/cuore/q-service/gestione-del-rischio-clinico/";
const html = await (await externalFetch(url, { timeoutMs: 45000 })).text();
const text = extractPageText(html);
console.log("chars", text.length);
console.log("relevant", pageCountsAsPolicyRelevant(url, text));
console.log("strong", hasStrongRcPolicySignal(text));
console.log("compliance", isGelliComplianceReportText(text));
console.log("policy", JSON.stringify(analyzePolicy(text), null, 2));
const idx = text.search(/art\.?\s*10/i);
console.log("art10 idx", idx, "slice relevant", idx > 0 ? pageCountsAsPolicyRelevant(url, text.slice(idx)) : false);
