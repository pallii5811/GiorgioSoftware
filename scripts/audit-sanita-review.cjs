const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function tok(ev) {
  const m = (ev || "").match(/^\[V:(PUB|HOT|REV)\]/);
  return m ? m[1] : "?";
}

function reasonBucket(ev) {
  const e = ev || "";
  if (/non individuato automaticamente/i.test(e)) return "NO_WEBSITE";
  if (/Timeout analisi/i.test(e)) return "TIMEOUT";
  if (/portali regionali non disponibile/i.test(e)) return "NO_TAVILY";
  if (/PDF polizza RC non individuato/i.test(e)) return "POLICY_HINT_NO_PDF";
  if (/Polizza RC rilevata/i.test(e) && /\[V:REV\]/.test(e)) return "POLICY_UNCERTAIN";
  if (/non pubblicata in Trasparenza/i.test(e) && /\[V:REV\]/.test(e)) return "SITE_OK_REVIEW";
  if (/websiteReachable|non raggiungibile/i.test(e)) return "UNREACHABLE";
  return "OTHER";
}

(async () => {
  const leads = await p.lead.findMany({
    where: { type: "HEALTHCARE", region: "Campania", lastScannedAt: { not: null } },
    select: {
      companyName: true,
      city: true,
      website: true,
      websiteReachable: true,
      policyFound: true,
      evidence: true,
      pagesVisited: true,
      osmId: true,
    },
  });

  const c = { PUB: 0, HOT: 0, REV: 0, "?": 0 };
  for (const l of leads) c[tok(l.evidence)]++;

  console.log("\n=== CAMPANIA", leads.length, "analizzati ===");
  console.log("PUBLISHED:", c.PUB, "HOT:", c.HOT, "REVIEW:", c.REV);

  const rev = leads.filter((l) => tok(l.evidence) === "REV");
  const buckets = {};
  for (const l of rev) {
    const b = reasonBucket(l.evidence);
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log("\nREVIEW per motivo:", buckets);

  const noWeb = rev.filter((l) => !l.website);
  console.log("\n--- NO SITO (", noWeb.length, ") sample ---");
  for (const l of noWeb.slice(0, 10)) {
    console.log("•", l.companyName, "|", l.city, "|", (l.evidence || "").slice(0, 100));
  }

  const hot = leads.filter((l) => tok(l.evidence) === "HOT");
  const hotNoPdf = hot.filter((l) => /PDF polizza letti (\d+)\/(\d+)/.test(l.evidence || ""));
  let hotPdfRead = 0;
  for (const l of hot) {
    const m = (l.evidence || "").match(/PDF polizza letti (\d+)\/(\d+)/);
    if (m && Number(m[1]) > 0) hotPdfRead++;
  }
  console.log("\nHOT audit:", hot.length, "total |", hotPdfRead, "con PDF letti |", hot.filter((l) => !l.website).length, "senza sito");

  const pub = leads.filter((l) => tok(l.evidence) === "PUB");
  console.log("\n--- PUBLISHED ---");
  for (const l of pub) {
    const docs = (l.evidence || "").match(/\[DOCS:\s*([^\]]+)/);
    console.log("•", l.companyName, "|", l.city, "|", docs ? docs[1].slice(0, 80) : "?");
  }

  console.log("\n--- HOT sample (trasparenza letta) ---");
  for (const l of hot.filter((l) => /Trasparenza letta/.test(l.evidence || "")).slice(0, 5)) {
    console.log("•", l.companyName);
    console.log("  ", (l.evidence || "").slice(0, 200));
  }

  await p.$disconnect();
})();
