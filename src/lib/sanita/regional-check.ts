/**
 * Verifica polizza RC su portali regionali, ASL/ULSS e trasparenza istituzionale.
 */

import { analyzePolicy, type PolicyAnalysis } from "./detector";
import { parseContactsFromText } from "./contacts";
import { mapsPrimaryName } from "./maps-query";
import { isTavilyAvailable, tavilySearch } from "./tavily-client";

export interface RegionalCheckResult extends PolicyAnalysis {
  checked: boolean;
  checkedAt: Date;
  sourceUrls: string[];
  queryCount: number;
  contactsFromPortals: ReturnType<typeof parseContactsFromText>;
}

export function isRegionalCheckAvailable(): boolean {
  return isTavilyAvailable();
}

const CAMPANIA_ASL =
  "site:regione.campania.it OR site:soresa.it OR site:aslnapoli1centro.it OR site:aslnapoli2nord.it OR site:aslnapoli3sud.it OR site:aslcaserta.it OR site:aslsalerno.it OR site:aslavellino.it OR site:aslbenevento.it";

const VENETO_ASL =
  "site:regione.veneto.it OR site:aziendazero.it OR site:aulss1.veneto.it OR site:aulss2.veneto.it OR site:aulss3.veneto.it OR site:aulss4.veneto.it OR site:aulss5.veneto.it OR site:aulss6.veneto.it OR site:aulss7.veneto.it OR site:aulss8.veneto.it OR site:aulss9.veneto.it";

function buildQueries(name: string, city: string | null, region: string): string[] {
  const primary = mapsPrimaryName(name)
    .replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "")
    .trim();
  const cityPart = city ? ` ${city}` : "";
  const asl = region === "Veneto" ? VENETO_ASL : CAMPANIA_ASL;

  return [
    `"${primary}"${cityPart} polizza responsabilità civile professionale legge Gelli art 10`,
    `"${primary}"${cityPart} copertura assicurativa RC struttura accreditata amministrazione trasparente`,
    `"${primary}"${cityPart} polizza assicurativa ${asl}`,
    `"${primary}"${cityPart} estremi polizza RC ${region} portale trasparenza`,
    `"${primary}" ${region} polizza RC Gelli ${asl}`,
    `"${primary}" ${region} amministrazione trasparente assicurazione RC`,
    `"${primary}"${cityPart} ${asl} polizza`,
  ];
}

export async function checkRegionalPolicy(
  name: string,
  city: string | null,
  region: string
): Promise<RegionalCheckResult> {
  const empty: RegionalCheckResult = {
    policyFound: false,
    confidence: 0,
    company: null,
    massimale: null,
    expiry: null,
    policyNumber: null,
    evidence: null,
    checked: false,
    checkedAt: new Date(),
    sourceUrls: [],
    queryCount: 0,
    contactsFromPortals: { emails: [], pec: null, phones: [], website: null },
  };

  if (!isTavilyAvailable()) return empty;

  const queries = buildQueries(name, city, region);
  const allResults = (await Promise.all(queries.map((q) => tavilySearch(q, { maxResults: 8 })))).flat();
  const sourceUrls = [...new Set(allResults.map((r) => r.url).filter(Boolean))];

  if (allResults.length === 0) {
    return {
      ...empty,
      checked: true,
      evidence:
        "Ricerca su portali regionali/ASL eseguita: nessun documento trovato. Art. 10 Gelli: polizza non risulta pubblicata sulle fonti istituzionali consultate.",
      queryCount: queries.length,
    };
  }

  const combinedText = allResults.map((r) => `${r.content} ${r.url}`).join("\n\n");
  const analysis = analyzePolicy(combinedText);
  const contactsFromPortals = parseContactsFromText(combinedText);

  const topUrl = sourceUrls[0];
  let evidence = analysis.evidence;
  if (topUrl) {
    evidence = analysis.policyFound
      ? `[Portale istituzionale: ${topUrl}] ${evidence || ""}`
      : `Polizza non trovata su portali regionali/ASL consultati. [Riferimento: ${topUrl}]`;
  }

  return {
    ...analysis,
    evidence: evidence?.trim() || null,
    checked: true,
    checkedAt: new Date(),
    sourceUrls,
    queryCount: queries.length,
    contactsFromPortals,
  };
}
