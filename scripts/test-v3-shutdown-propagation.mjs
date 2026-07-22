/**
 * Regression test RC-06: SIGTERM al v3 deve raggiungere i worker attivi.
 * Verifica il meccanismo usato dalla patch: spawn detached (nuovo process
 * group) + process.kill(-pid, sig) colpisce TUTTA la catena del worker,
 * inclusi i suoi figli (chrome/pdftoppm), e SIGKILL di gruppo ferma chi
 * ignora SIGTERM. Linux-only (il runtime di produzione è Linux).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

if (process.platform === "win32") {
  console.log("SKIP: meccanismo process-group Linux-only (runtime produzione = Linux)");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc06-"));
const fakeWorker = path.join(dir, "fake-worker.mjs");
fs.writeFileSync(
  fakeWorker,
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const dir = process.argv[2];
const mode = process.argv[3] || "polite";
// figlio "chrome-like": dorme per sempre, deve morire col group kill
const chrome = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: false });
fs.writeFileSync(dir + "/ready", JSON.stringify({ pid: process.pid, chromePid: chrome.pid }));
process.on("SIGTERM", () => {
  if (mode === "ignore") return; // worker maleducato: ignora il segnale
  fs.writeFileSync(dir + "/got-sigterm", String(Date.now()));
  process.exit(0);
});
setInterval(() => {}, 1000);
`
);

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(mode) {
  const caseDir = path.join(dir, mode);
  fs.mkdirSync(caseDir, { recursive: true });
  // replica esatta della catena v3: stdio pipe + detached:true
  const child = spawn(process.execPath, [fakeWorker, caseDir + "/", mode], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const t0 = Date.now();
  let closed = null;
  child.on("close", (code, signal) => {
    closed = { code, signal, ms: Date.now() - t0 };
  });
  // attendi ready
  for (let i = 0; i < 100 && !fs.existsSync(path.join(caseDir, "ready")); i++) await sleep(100);
  const ready = JSON.parse(fs.readFileSync(path.join(caseDir, "ready"), "utf8"));
  check(`${mode}: worker pronto`, pidAlive(ready.pid) && pidAlive(ready.chromePid));
  // segnale di gruppo come initiateShutdown(RC-06)
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (e) {
    check(`${mode}: group SIGTERM inviato`, false, String(e));
    return;
  }
  if (mode === "ignore") {
    await sleep(1500);
    check("ignore: SIGTERM ignorato, worker ancora vivo", closed === null);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* */
    }
  }
  for (let i = 0; i < 100 && !closed; i++) await sleep(100);
  check(`${mode}: worker terminato entro 10s`, closed !== null, JSON.stringify(closed));
  await sleep(300);
  check(`${mode}: figlio (chrome-like) morto col group kill`, !pidAlive(ready.chromePid));
  if (mode === "polite") {
    check(
      "polite: handler SIGTERM eseguito (risultato operativo scritto)",
      fs.existsSync(path.join(caseDir, "got-sigterm"))
    );
  }
}

await runCase("polite");
await runCase("ignore");

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `ALL ${results.length} PASS` : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
