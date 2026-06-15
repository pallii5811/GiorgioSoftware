/**
 * Promuove REVIEW → HOT quando i portali regionali hanno già confermato assenza polizza
 * ma il sito era irraggiungibile (bug precedente in scan-engine).
 */
import { prisma } from "../src/lib/prisma.ts";
import { encodeEvidence, readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { scoreLead } from "../src/lib/sanita/score.ts";

const REGION = process.argv[2] || null;

const where = {
  type: "HEALTHCARE",
  lastScannedAt: { not: null },
  websiteReachable: false,
  ...(REGION ? { region: REGION } : {}),
};

const leads = await prisma.lead.findMany({
  where,
  select: {
    id: true,
    companyName: true,
    region: true,
    evidence: true,
    phone: true,
    email: true,
    pec: true,
    policyFound: true,
  },
});

let fixed = 0;
for (const l of leads) {
  const v = readVerdictToken(l.evidence);
  if (v !== "REVIEW") continue;
  const ev = (l.evidence || "").toLowerCase();
  const regionalOk =
    ev.includes("portali asl") ||
    ev.includes("portale regionale") ||
    ev.includes("portali regionali") ||
    ev.includes("consultati:") ||
    ev.includes("art. 10 gelli");
  if (!regionalOk) continue;

  const body = (l.evidence || "")
    .replace(/^\[V:REV\]\s*/i, "")
    .replace(
      /impossibile certificare assenza polizza sul sito istituzionale/gi,
      "assenza polizza confermata su portali ASL/regionali (sito irraggiungibile)"
    )
    .replace(
      /impossibile verificare la pubblicazione art\. 10 gelli sul sito istituzionale/gi,
      "assenza polizza confermata su portali ASL/regionali (sito irraggiungibile)"
    );

  await prisma.lead.update({
    where: { id: l.id },
    data: {
      evidence: encodeEvidence("HOT", body),
      leadScore: scoreLead({
        verdict: "HOT",
        phone: l.phone,
        email: l.email,
        pec: l.pec,
      }),
    },
  });
  fixed++;
}

const all = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null }, ...(REGION ? { region: REGION } : {}) },
  select: { evidence: true },
});
const counts = { HOT: 0, PUB: 0, REV: 0 };
for (const l of all) {
  const v = readVerdictToken(l.evidence);
  if (v === "HOT") counts.HOT++;
  else if (v === "PUBLISHED") counts.PUB++;
  else counts.REV++;
}

console.log(`Corretti ${fixed} lead (sito giù + portali ok)${REGION ? ` — ${REGION}` : ""}`);
console.log(`Totale analizzati: ${all.length} → HOT ${counts.HOT} | PUB ${counts.PUB} | REVIEW ${counts.REV}`);

await prisma.$disconnect();
