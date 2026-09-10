import { chromium } from 'playwright'
const url = 'https://giorgio-software.vercel.app/sanita?tab=live&region=Umbria'
const b = await chromium.launch()
const pg = await b.newPage()
await pg.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await pg.waitForTimeout(9000) // lascia finire fetch + render
const text = await pg.locator('table').first().innerText().catch(() => '')
const body = await pg.locator('body').innerText()
let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }
check('6 righe HOT verificato', (text.match(/HOT verificato/g) || []).length === 6)
check('origine Scansione territorio x6', (text.match(/Scansione territorio/g) || []).length === 6)
check('NESSUN HOT legacy — da rivalidare', !text.includes('HOT legacy'))
check('NESSUN Legacy — snapshot 18 luglio', !text.includes('snapshot 18 luglio'))
// controllo incrociato: Veneto (legacy veri) deve restare legacy
await pg.goto('https://giorgio-software.vercel.app/sanita?tab=live&region=Veneto', { waitUntil: 'networkidle', timeout: 60000 })
await pg.waitForTimeout(9000)
const vt = await pg.locator('table').first().innerText().catch(() => '')
check('Veneto: legacy veri INVARIATI (HOT legacy presente)', vt.includes('HOT legacy') && vt.includes('snapshot 18 luglio'))
await b.close()
console.log(`=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail ? 1 : 0)
