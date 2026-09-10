const { prisma } = await import("@/lib/prisma");

const candidates = [
  {
    key: "codex-pn-official-sanisystem",
    companyName: "Sanisystem S.r.l. - Pordenone",
    website: "https://www.sanisystemgroup.it/it",
    phone: "0434 208215",
  },
  {
    key: "codex-pn-official-centro-medicina-ferriera",
    companyName: "Centro di medicina Pordenone - Via della Ferriera",
    website: "https://centrodimedicina.com/pordenone-via-della-ferriera/",
    phone: "0434 554130",
  },
  {
    key: "codex-pn-official-gymnasium",
    companyName: "Gymnasium - Centro di Fisioterapia e Riabilitazione Pordenone",
    website: "https://www.gymnasiumriabilitazione.it/",
    phone: "0434 363993",
  },
  {
    key: "codex-pn-official-friuli-riabilitazione",
    companyName: "Friuli Riabilitazione S.r.l. - Pordenone",
    website: "https://www.friuliriabilitazione.it/",
  },
  {
    key: "codex-pn-official-raymed",
    companyName: "Raymed S.r.l. - Pordenone",
    website: "https://raymedsrl.com/",
  },
  {
    key: "codex-pn-official-uildm-poliambulatorio",
    companyName: "UILDM Pordenone ODV - Poliambulatorio",
    website: "https://uildmpordenone.org/",
    phone: "0434 569888",
  },
];

const results = [];
try {
  for (const candidate of candidates) {
    const existing = await prisma.lead.findFirst({
      where: {
        type: "HEALTHCARE",
        region: "Friuli-Venezia Giulia",
        city: "Pordenone",
        OR: [
          { osmId: candidate.key },
          { website: candidate.website },
          { companyName: candidate.companyName },
        ],
      },
      select: { id: true },
    });

    const lead = existing
      ? await prisma.lead.update({
          where: { id: existing.id },
          data: {
            website: candidate.website,
            phone: candidate.phone,
            category: "POLIAMBULATORIO",
          },
          select: { id: true, companyName: true, website: true },
        })
      : await prisma.lead.create({
          data: {
            type: "HEALTHCARE",
            osmId: candidate.key,
            companyName: candidate.companyName,
            region: "Friuli-Venezia Giulia",
            city: "Pordenone",
            website: candidate.website,
            phone: candidate.phone,
            category: "POLIAMBULATORIO",
          },
          select: { id: true, companyName: true, website: true },
        });
    results.push(lead);
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await prisma.$disconnect();
}
