#!/usr/bin/env bash
set -euo pipefail
cd /opt/leadsniper-revalidate/app
npx --yes tsx -e '
import { analyzePolicy } from "./src/lib/sanita/detector.ts";

const iatreion = `Polizza n. 747217409 Polizza di Assicurazione di Responsabilità civile verso terzi Descrizione Condizioni generali di assicurazione Oggetto dell assicurazione a) Assicurazione della responsabilità civile verso prestatori di lavoro`;
const galdiero = `Copertura assicurativa della responsabilità civile verso terzi e verso i prestatori d opera di Reale Mutua • Polizza 2022/03/2475660 Laboratorio di patologie cliniche Galdiero Srl`;

for (const [name, text] of [["iatreion", iatreion], ["galdiero", galdiero]] as const) {
  const a = analyzePolicy(text, "http://example/");
  console.log(JSON.stringify({ name, policyFound: a.policyFound, company: a.company, policyNumber: a.policyNumber, massimale: a.massimale, conf: a.confidence }, null, 2));
}
'
