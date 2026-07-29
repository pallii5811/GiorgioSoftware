// k3 — verifica live su giorgio-software.vercel.app:
// 1) il filtro regione NON deve resettarsi dopo click esito + cicli di polling
// 2) visibilità risultati territorio (Umbria) nella tab Nuovi risultati
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://giorgio-software.vercel.app";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 120)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 120)));

await page.goto(`${BASE}/sanita`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector('[data-testid="tab-run-results"]', { timeout: 30000 });
await page.waitForTimeout(2500); // idratazione React prima di interagire

// --- select regione dei FILTRI (testid dedicato) ---
const regionSelect = page.locator('[data-testid="region-filter"]');
await regionSelect.selectOption("Calabria");
await page.waitForTimeout(1000);
const urlAfterRegion = page.url();
check("URL contiene region=Calabria dopo selezione", urlAfterRegion.includes("region=Calabria"), urlAfterRegion.split("/sanita")[1] || "");

// --- click card "Polizza scaduta" ---
const card = page.locator("button", { hasText: "Polizza scaduta" }).first();
await card.click();
await page.waitForTimeout(800);
check("URL contiene outcome=policy_expired", page.url().includes("policy_expired"), page.url().split("/sanita")[1] || "");

// --- osserva 4 cicli di polling (~16s): la regione deve restare Calabria ---
let resetDetected = false;
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(4000);
  const v = await regionSelect.inputValue();
  const u = page.url();
  if (v !== "Calabria" || !u.includes("region=Calabria")) {
    resetDetected = true;
    check(`polling ciclo ${i + 1}: regione resta Calabria`, false, `select=${v} url=${u.split("/sanita")[1]}`);
    break;
  }
}
if (!resetDetected) check("regione resta Calabria dopo 4 cicli polling (~16s)", true);

// --- reset esito a ALL, torna a Tutte le regioni, poi Umbria: conta righe ---
await page.locator('[data-testid="outcome-filter"]').selectOption("ALL");
await page.waitForTimeout(600);
await regionSelect.selectOption("ALL");
await page.waitForTimeout(600);
const allCount = await page.locator("table tbody tr").count();
await regionSelect.selectOption("Umbria");
await page.waitForTimeout(1500);
const umbriaCount = await page.locator("table tbody tr").count();
const umbriaText = await page.locator("table").innerText().catch(() => "");
check("Tab run con Tutte mostra righe", allCount > 0, `${allCount} righe`);
check("Tab run con Umbria: lead territorio visibili (In lavorazione)", umbriaCount > 0, `${umbriaCount} righe`);
console.log("INFO umbria table snippet:", umbriaText.slice(0, 300).replace(/\n/g, " | "));

check("nessun errore console", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ; "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
