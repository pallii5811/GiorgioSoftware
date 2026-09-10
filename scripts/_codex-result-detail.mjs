import fs from "node:fs";
import path from "node:path";

const id = process.argv[2];
if (!id) throw new Error("lead id required");
const resultsDir =
  process.env.REVALIDATE_RESULTS_DIR ||
  "/opt/leadsniper-revalidate/data/revalidation/results";
const row = JSON.parse(fs.readFileSync(path.join(resultsDir, `${id}.json`), "utf8"));
console.log(
  JSON.stringify({
    keys: Object.keys(row).sort(),
    row,
  })
);
