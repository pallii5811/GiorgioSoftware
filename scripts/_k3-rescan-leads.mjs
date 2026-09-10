// k3 2026-07-30 — targeted rescan di lead Perugia bloccati da PDF o sito errato.
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://167.233.209.13:3000";
const LOG_DIR = "./logs/rescan";
mkdirSync(LOG_DIR, { recursive: true });

const LEADS = [
  { id: "cms6gq4kb0000oqxbk6qcg5ob", name: "Casa di Cura Villa Fiorita", website: undefined },
  { id: "cms6gspam0006oqxbn1ewce99", name: "Casa di Cura Clinica Lami Spa", website: undefined },
  { id: "cms6gspb1000foqxbw0mhyddy", name: "Orthocare STP", website: undefined },
  { id: "cms6mhvzs0001upxsxrwubm8l", name: "Clinica Lami (sito errato)", website: "https://clinicalami.it/" },
  { id: "cms6gspaq0008oqxbp6ztfbzr", name: "Istituto Clinico Porta Sole Casa Di Cura", website: undefined },
  { id: "cms6gq4kb0000oqxbk6qcg5ob", name: "Casa Di Cura Liotti", website: undefined }, // duplicate id? placeholder; will be replaced
];

function rescanOne(lead, idx) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id: lead.id, ...(lead.website ? { website: lead.website } : {}) });
    const start = Date.now();
    const log = `${LOG_DIR}/${lead.id}.log`;
    appendFileSync(log, `\n--- rescan start ${new Date().toISOString()} ---\n${JSON.stringify(lead)}\n`);
    const child = spawn(
      "curl",
      ["-s", "-m", "900", "-X", "POST", "-H", "Content-Type: application/json", "-d", body, `${BASE}/api/sanita/rescan`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    child.stdout.on("data", (d) => { out += d; appendFileSync(log, d); });
    child.stderr.on("data", (d) => { appendFileSync(log, d); });
    child.on("close", (code) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      let result;
      try {
        const j = JSON.parse(out);
        const l = j.lead;
        result = `${l?.companyName ?? lead.name} | outcome:${l?.status ?? "?"} | website:${l?.website ?? "?"} | ${j.success ? "OK" : "FAIL"} ${j.error ?? ""}`;
      } catch (e) {
        result = `${lead.name} | parse-error | code ${code} | ${out.slice(0, 120)}`;
      }
      appendFileSync(log, `\n--- end ${duration}s code ${code} ---\n${result}\n`);
      resolve(result);
    });
  });
}

async function main() {
  // run sequentially to avoid server saturation; each rescan can take minutes
  for (const lead of LEADS) {
    console.log(`starting ${lead.name}...`);
    const r = await rescanOne(lead);
    console.log(r);
  }
}

main().then(() => process.exit(0));
