#!/usr/bin/env node

import assert from "node:assert/strict";
import { validateSiteIdentity } from "../src/lib/sanita/site-identity.ts";

function crawl(text, pages = 6) {
  return {
    ok: true,
    text,
    policyText: "",
    pagesVisited: Array.from({ length: pages }, (_, index) => `/pagina-${index + 1}`),
    foundRelevantPage: false,
    policyPdfUrl: null,
    policyPdfsRead: 0,
    policyPdfsQueued: 0,
  };
}

const sanctuary = validateSiteIdentity(
  "Casa di Cura Madonna dello Scoglio",
  "https://www.madonnadelloscoglio.com/",
  crawl(
    "Santuario Madonna dello Scoglio. Apparizioni, preghiere, pellegrinaggi, " +
      "celebrazioni e santa messa. Assistenza spirituale, sacerdoti e diocesi."
  ),
  "Crotone"
);

assert.equal(
  sanctuary.ok,
  false,
  "Un santuario omonimo non deve essere accettato come struttura sanitaria"
);
assert.match(
  sanctuary.reason,
  /santuario|ente religioso/i,
  `Motivo inatteso: ${sanctuary.reason}`
);

const clinic = validateSiteIdentity(
  "Casa di Cura Madonna dello Scoglio",
  "https://www.sadelmadonnadelloscoglio.com/",
  crawl(
    "Casa di Cura Madonna dello Scoglio, struttura sanitaria privata. " +
      "Ricovero, pazienti, reparti, attività medica e infermieristica. Sede a Crotone."
  ),
  "Crotone"
);

assert.equal(
  clinic.ok,
  true,
  `Il sito sanitario ufficiale deve essere accettato: ${clinic.reason}`
);

console.log("OK religious namesake identity gate");
