import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = process.env.APP_DIR;
const frontier = await import(pathToFileURL(path.join(appDir, "src/lib/sanita/frontier-store.ts")).href);
frontier.openFrontierStore(process.argv[2]);
const aggregate = frontier.aggregatePersistedEvidence(process.argv[3]);
frontier.closeFrontierStore();
const text = aggregate.policyText;
const block = text.match(/decorrenza[\s\S]{0,60}?scadenza[\s\S]{0,360}/i)?.[0] || "";
const matches = [...block.matchAll(
  /\bg[.\s|]*(\d{1,2})\s*[|/]?\s*m\s*(\d{1,2})\s*[|/]?\s*a\s*(\d{4})/gi
)].map((match) => match.slice(0, 4));
console.log(JSON.stringify({ block, matches }, null, 2));
