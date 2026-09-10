import { prisma } from "@/lib/prisma";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const publicHospitalEvidence = stampProcessingMeta(
  [
    "Struttura pubblica fuori target commerciale.",
    "Presidio di Crotone — Ospedale San Giovanni di Dio, appartenente all'Azienda Sanitaria Provinciale di Crotone.",
    "Fonte ufficiale: https://asp.crotone.it/?page_id=1484",
    "Il dominio giovanni.com associato automaticamente è stato scartato perché non istituzionale.",
  ].join(" "),
  {
    state: "OUT_OF_SCOPE",
    businessVerdict: "OUT_OF_SCOPE",
    validationStatus: "CURRENT_VERIFIED",
  }
);

const hospital = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    city: "Crotone",
    companyName: "Ospedale San Giovanni di Dio",
  },
  data: {
    website: "https://asp.crotone.it/?page_id=1484",
    websiteReachable: true,
    policyFound: false,
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    evidence: publicHospitalEvidence,
    lastScannedAt: new Date(),
  },
});

const igea = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    city: "Crotone",
    companyName: "IGEA Centro Medico Diagnostico Polispecialistico",
  },
  data: {
    website: "https://www.igeacrotone.com/",
    websiteReachable: null,
    policyFound: false,
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    evidence: stampProcessingMeta("Nuovo crawl HTTPS richiesto sul sito ufficiale IGEA Crotone.", {
      state: "CRAWL_RUNNING",
      businessVerdict: "NONE",
      validationStatus: "REVALIDATION_PENDING",
    }),
    lastScannedAt: null,
  },
});

console.log(JSON.stringify({ hospital: hospital.count, igea: igea.count }));
await prisma.$disconnect();
