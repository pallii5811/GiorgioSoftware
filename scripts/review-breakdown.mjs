import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const region = process.argv[2] || "Campania";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
  select: { companyName: true, evidence: true, website: true },
});

const counts = { HOT: 0, PUB: 0, REV: 0 };
const revReasons = {};

for (const l of leads) {
  const ev = l.evidence ?? "";
  let v = "?";
  if (/^\[V:HOT\]/.test(ev)) v = "HOT";
  else if (/^\[V:PUB\]/.test(ev)) v = "PUB";
  else if (/^\[V:REV\]/.test(ev)) v = "REV";
  counts[v] = (counts[v] ?? 0) + 1;

  if (v !== "REV") continue;
  const body = ev.replace(/^\[V:REV\]\s*/, "");
  const gate = body.match(/Impossibile certificare assenza polizza: ([^.]+)/)?.[1]
    ?? body.match(/^([^—]+)/)?.[1]?.trim()
    ?? "altro";
  revReasons[gate] = (revReasons[gate] ?? 0) + 1;
}

console.log("Total scanned:", leads.length);
console.log("HOT:", counts.HOT, "PUB:", counts.PUB, "REV:", counts.REV);
console.log("\nREVIEW gate breakdown:");
for (const [k, n] of Object.entries(revReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}x  ${k.slice(0, 120)}`);
}

await prisma.$disconnect();
