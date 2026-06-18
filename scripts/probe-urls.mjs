import { externalFetch } from "../src/lib/http.ts";

const urls = [
  "https://www.clinicamontevergine.com/",
  "https://clinicamontevergine.com/",
  "https://www.villadeiplatani.it/",
  "https://www.villadeiplatani.com/",
  "https://villadeiplatani.it/",
];

for (const u of urls) {
  try {
    const r = await externalFetch(u, { timeoutMs: 8000 });
    console.log(u, "->", r.status, r.url);
  } catch (e) {
    console.log(u, "-> ERR", e instanceof Error ? e.message : e);
  }
}
