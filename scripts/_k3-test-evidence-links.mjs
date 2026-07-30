import { policyPdfUrlsForLead, policyHtmlSourceForLead } from '../src/lib/sanita/audit.ts'
let pass = 0, fail = 0
const check = (n, c) => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n)) }

// Evidence REALE Madonna dello Scoglio (dal DB produzione, 30/07/2026)
const madonna = '[PS:PUBLISHED_EXPIRED] [V:PUB]  Polizza RC certificata da PDF: https://www.sadelmadonnadelloscoglio.com/_files/ugd/638d82_35f6dc79a3ea461d8f3aeb59f4ce178e.pdf DATI ASSICURATIVI RCT Amtrust [EV_V:2 VD_V:2 LEGACY:CURRENT] — [DOCS: https://www.sadelmadonnadelloscoglio.com/_files/ugd/638d82_35f6dc79a3ea461d8f3aeb59f4ce178e.pdf] [FONTI: sito web (4 pagine: /, /chi-siamo) · fonte polizza PDF: https://www.sadelmadonnadelloscoglio.com/_files/ugd/638d82_35f6dc79a3ea461d8f3aeb59f4ce178e.pdf] [Verifica: 2026-07-29 17:25]'
const urlsM = policyPdfUrlsForLead(madonna)
check('Madonna [PS]+[V:PUB] → PDF polizza estratto', urlsM.length === 1 && urlsM[0].endsWith('.pdf'))

// Evidence REALE Turano (HOT)
const turano = '[V:HOT] Portali ASL/regionali consultati: assenza pubblicazione confermata. [STATE:HOT_VERIFIED] [BV:HOT_VERIFIED] — [FONTI: sito web (193 pagine, sezione Trasparenza letta: /, /amministrazione-trasparente) · fonte polizza PDF: http://www.centrosaluteturano.it/amministrazione-trasparente · portali regionali/ASL (7 ricerche)] [Verifica: 2026-07-29 20:28]'
const urlsT = policyPdfUrlsForLead(turano)
check('Turano [V:HOT] → pagina Trasparenza controllata mostrata', urlsT.length === 1 && urlsT[0] === 'http://www.centrosaluteturano.it/amministrazione-trasparente')

// REV / pending → niente evidence
check('REVIEW → nessun link', policyPdfUrlsForLead('[V:REV] qualcosa').length === 0)
check('null → nessun link', policyPdfUrlsForLead(null).length === 0)
console.log(`=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail ? 1 : 0)
