import { chromium } from 'playwright'
const b = await chromium.launch()
const ctx = await b.newContext({ acceptDownloads: true })
const pg = await ctx.newPage()
await pg.goto('https://giorgio-software.vercel.app/sanita?tab=live&region=Umbria', { waitUntil: 'networkidle', timeout: 60000 })
await pg.waitForTimeout(9000)
const table = await pg.locator('table').first().innerText().catch(() => '')
let pass = 0, fail = 0
const check = (n, c) => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n)) }
check('Villa Fiorita → Autoassicurazione dichiarata in UI', table.includes('Autoassicurazione dichiarata') && table.includes('Villa Fiorita'))
check('Villa Fiorita NON più HOT', !/Villa Fiorita[\s\S]{0,200}HOT verificato/.test(table))
const [ dl ] = await Promise.all([
  pg.waitForEvent('download', { timeout: 30000 }),
  pg.getByRole('button', { name: /Esporta CSV/i }).click(),
])
const path = await dl.path()
const fs = await import('node:fs')
const csv = fs.readFileSync(path, 'utf8')
console.log('--- CSV (prime 4 righe) ---')
console.log(csv.split('\n').slice(0, 4).join('\n'))
check('CSV header colonne cliente', csv.includes('Struttura;Città;Regione;Esito;Compagnia assicurativa;Numero polizza;Scadenza polizza;Telefono;Email;PEC;Sito web;Verificato il'))
check('CSV contiene Autoassicurata', csv.includes('Autoassicurata'))
check('CSV niente gergo legacy/snapshot', !csv.includes('snapshot 18 luglio') && !csv.includes('da rivalidare'))
check('CSV date formattate (niente ISO T...Z)', !/T\d{2}:\d{2}:\d{2}/.test(csv))
check('CSV niente hash/colonne tecniche', !csv.includes('PdfHash') && !csv.includes('EvidenceURL'))
await b.close()
console.log(`=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail ? 1 : 0)
