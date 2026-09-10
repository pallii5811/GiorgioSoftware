#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const target = "/opt/leadsniper/src/lib/sanita/site-identity.ts";
const backup =
  process.env.IDENTITY_BACKUP_PATH ??
  `/opt/leadsniper/backups/site-identity-${new Date().toISOString().replaceAll(":", "-")}.ts`;

const constantsNeedleLf = `const HEALTH_CORPUS =
  /\\b(sanitar|rsa|riposo|assistenz|infermier|degent|pazient|visita\\s+medic|poliambulator|terapia|reparto)\\b/i;
`;

const constantsInsertionLf = `${constantsNeedleLf}
const STRONG_PRIVATE_HEALTH_CORPUS =
  /\\b(casa\\s+di\\s+cura|clinica|struttura\\s+sanitaria|ricover|pazient|reparto|ambulator|reumatolog|diagnos|chirurg|medic[oi]|infermier)\\b/i;

const RELIGIOUS_ENTITY_CORPUS =
  /\\b(santuario|apparizion|vergine\\s+immacolata|celebrazion|santa\\s+messa|sacerdot|diocesi|preghier|pellegrin|offert[ae]\\s+e\\s+donazion)\\b/i;
`;

const gateNeedleLf = `  if (isParkedOrForSalePage(corpus)) {
    return { ok: false, reason: "Dominio parcheggiato o in vendita — non è un sito istituzionale" };
  }
`;

const gateInsertionLf = `${gateNeedleLf}  if (
    isPrivateName &&
    !isPublicName &&
    RELIGIOUS_ENTITY_CORPUS.test(corpus) &&
    !STRONG_PRIVATE_HEALTH_CORPUS.test(corpus)
  ) {
    return {
      ok: false,
      reason:
        "Sito di santuario/ente religioso omonimo — non è la struttura sanitaria indicata",
    };
  }
`;

let source = readFileSync(target, "utf8");
const eol = source.includes("\r\n") ? "\r\n" : "\n";
const constantsNeedle = constantsNeedleLf.replaceAll("\n", eol);
const constantsInsertion = constantsInsertionLf.replaceAll("\n", eol);
const gateNeedle = gateNeedleLf.replaceAll("\n", eol);
const gateInsertion = gateInsertionLf.replaceAll("\n", eol);
if (
  source.includes("const RELIGIOUS_ENTITY_CORPUS") &&
  source.includes("Sito di santuario/ente religioso omonimo")
) {
  console.log("IDENTITY_GATE_ALREADY_PRESENT");
  process.exit(0);
}

if (!source.includes(constantsNeedle)) {
  throw new Error("HEALTH_CORPUS anchor not found; refusing unsafe patch");
}
if (!source.includes(gateNeedle)) {
  throw new Error("parked-domain gate anchor not found; refusing unsafe patch");
}

mkdirSync(dirname(backup), { recursive: true });
copyFileSync(target, backup);
source = source.replace(constantsNeedle, constantsInsertion);
source = source.replace(gateNeedle, gateInsertion);
writeFileSync(target, source, "utf8");

console.log(`IDENTITY_GATE_PATCHED ${backup}`);
