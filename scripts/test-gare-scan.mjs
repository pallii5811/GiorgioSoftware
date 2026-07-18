import { runGareScan } from "../src/lib/gare/engine.ts";
const region = process.argv[2] || "Veneto";
const r = await runGareScan({ region, max: 30 });
console.log(JSON.stringify({ message: r.message, stats: r.stats }, null, 2));
