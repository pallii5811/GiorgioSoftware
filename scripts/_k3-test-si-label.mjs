import { detectSelfInsuranceDeclaration } from '../src/lib/sanita/self-insurance.ts'
let pass = 0, fail = 0
const check = (name, cond) => { cond ? (pass++, console.log('PASS', name)) : (fail++, console.log('FAIL', name)) }

// Caso reale Villa Fiorita (footer homepage, scaricato 30/07/2026)
const villa = 'Rappresentante legale, Amministratore Unico: Daniele Pironti P.Iva 15434171003 Codice fiscale: 00494160542 Casa di Cura Villa Fiorita s.r.l.: Autoassicurazione Sito web aggiornato al 07/06/2026 Dove trovarci Privacy Policy'
const d1 = detectSelfInsuranceDeclaration(villa)
check('Villa Fiorita footer → declared=true', d1.declared === true)
check('Villa Fiorita footer → blocksHotAbsence=true', d1.blocksHotAbsence === true)

// PARS tabellare classica
const pars = 'Posizione assicurativa. Copertura RC professionale: Autoassicurazione ex art. 10 L. 24/2017'
check('PARS "Copertura: Autoassicurazione" → declared', detectSelfInsuranceDeclaration(pars).declared === true)

// Negazioni / alternative ambigue NON devono dichiarare
check('negazione "nessuna autoassicurazione" → non declared', detectSelfInsuranceDeclaration('La struttura non opera con nessuna autoassicurazione').declared === false)
check('alternativa "polizza o autoassicurazione" → non declared', detectSelfInsuranceDeclaration('copertura assicurativa o, in alternativa, regime di autoassicurazione').declared === false)
// Menzione secca senza label non promuove (resta prudente)
check('menzione generica senza colon → non declared', detectSelfInsuranceDeclaration('si parla di autoassicurazione in generale').declared === false)

console.log(`=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail ? 1 : 0)
