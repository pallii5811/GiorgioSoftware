import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { isClearlyForeignMapsPlace } from "../src/lib/sanita/playwright-maps.ts";
import { stampProcessingMeta } from "../src/lib/sanita/processing-state.ts";

const region = process.argv[2];
const city = process.argv[3];
const frontierPath = resolve(process.argv[4] || "");
if (!region || !city || !process.argv[4]) {
  throw new Error(
    "usage: _codex-quarantine-foreign-maps-leads.mjs <region> <city> <frontier.sqlite>"
  );
}

const candidates = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    city,
    osmId: { startsWith: "gmaps/" },
  },
  select: { id: true, companyName: true, phone: true, website: true },
});
const foreign = candidates.filter((lead) =>
  isClearlyForeignMapsPlace({ address: null, phone: lead.phone })
);
const now = new Date();

for (const lead of foreign) {
  const evidence = stampProcessingMeta(
    `[V:OUT] Scheda Google Maps estera esclusa prima della classificazione commerciale. ` +
      `[IDENTITY:FOREIGN_MAPS_HOMONYM] [Verifica: ${now.toISOString()}]`,
    {
      state: "OUT_OF_SCOPE",
      businessVerdict: "OUT_OF_SCOPE",
      validationStatus: "CURRENT_VERIFIED",
    }
  );
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      evidence,
      lastScannedAt: now,
      policyFound: false,
      policyCompany: null,
      policyNumber: null,
      policyExpiry: null,
      confidence: null,
    },
  });
}

if (foreign.length > 0) {
  const db = new DatabaseSync(frontierPath);
  try {
    const placeholders = foreign.map(() => "?").join(", ");
    db.prepare(
      `UPDATE CrawlRun
          SET state = 'ABORTED', completedAt = ?, stopReason = 'FOREIGN_MAPS_HOMONYM',
              workerLock = NULL
        WHERE leadId IN (${placeholders})
          AND state IN ('CREATED', 'RUNNING', 'PAUSED', 'FAILED')`
    ).run(now.toISOString(), ...foreign.map((lead) => lead.id));
  } finally {
    db.close();
  }
}

console.log(JSON.stringify({
  region,
  city,
  quarantined: foreign.map((lead) => ({
    id: lead.id,
    companyName: lead.companyName,
    phone: lead.phone,
    website: lead.website,
  })),
}, null, 2));
await prisma.$disconnect();
