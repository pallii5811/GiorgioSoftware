import { validateSiteIdentity, companyNameOnSite } from "../src/lib/sanita/site-identity.ts";
import { crawlSite } from "../src/lib/sanita/crawler.ts";

process.env.OCR_ENABLED = "0";
process.env.SCAN_FAST = "1";

// Villa Fiorita Capua — sito giusto
const good = await crawlSite("https://www.villafioritacapua.it");
const idGood = validateSiteIdentity("Casa Di Cura 'Villa Fiorita' S.p.A.", "https://www.villafioritacapua.it", good);
console.log("Capua sito corretto:", idGood.ok ? "OK" : idGood.reason);

// Omonimo sbagliato
const wrong = await crawlSite("https://clinicavillafiorita.it");
const idWrong = validateSiteIdentity("Villa Fiorita", "https://clinicavillafiorita.it", wrong);
console.log("Omonimo clinicavillafiorita:", idWrong.ok ? "OK (unexpected)" : idWrong.reason);

console.log("companyNameOnSite test:", companyNameOnSite("ICS Maugeri", "Hermitage Maugeri napoli ics"));
