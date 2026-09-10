/**
 * Build priority queue of legacy PUBLISHED HEALTHCARE leads from LIVE sqlite (read-only).
 * Criteria: token/verdict PUBLISHED OR policyFound + first-party doc/page URL + extracted fields.
 *
 * Usage:
 *   LIVE_DB=/opt/leadsniper/prisma/dev.db node scripts/build-published-priority-queue.mjs
 *   OUT=... optional
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIVE_DB =
  process.env.LIVE_DB ||
  process.env.LIVE_DATABASE_URL?.replace(/^file:/, "") ||
  path.resolve("prisma/dev.db");
const OUT =
  process.env.OUT ||
  path.resolve("data/revalidation-published-priority/priority-queue.json");

function hasPubToken(ev) {
  const e = ev || "";
  return (
    /^\[V:PUB\]/im.test(e) ||
    /\[BV:PUBLISHED_/i.test(e) ||
    /\[STATE:PUBLISHED_/i.test(e) ||
    /\bPUBLISHED\b/i.test(e.slice(0, 200))
  );
}

function extractDocs(ev) {
  const e = ev || "";
  const docs = [];
  const m = e.match(/\[DOCS:\s*([^\]]+)\]/i);
  if (m) {
    for (const part of m[1].split(/[\s,;]+/)) {
      const u = part.trim();
      if (/^https?:\/\//i.test(u)) docs.push(u);
    }
  }
  for (const u of e.match(/https?:\/\/[^\s\]|>]+\.pdf/gi) || []) docs.push(u);
  return [...new Set(docs)];
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function firstPartyHint(website, docs) {
  const wh = website ? hostOf(website) : null;
  if (!wh) return { ok: false, reason: "no_website" };
  for (const d of docs) {
    const dh = hostOf(d);
    if (!dh) continue;
    if (dh === wh || dh.endsWith(`.${wh}`) || wh.endsWith(`.${dh}`)) {
      return { ok: true, url: d, host: dh };
    }
  }
  // HTML page first-party in evidence (non-PDF)
  const pages = (arguments[2] || "").match(/https?:\/\/[^\s\]|>]+/gi) || [];
  for (const p of pages) {
    const ph = hostOf(p);
    if (ph && (ph === wh || ph.endsWith(`.${wh}`))) return { ok: true, url: p, host: ph };
  }
  return { ok: false, reason: "no_first_party_url" };
}

if (!fs.existsSync(LIVE_DB)) {
  console.error(JSON.stringify({ error: "live_db_missing", LIVE_DB }));
  process.exit(2);
}

const db = new DatabaseSync(LIVE_DB, { readOnly: true });
const rows = db
  .prepare(
    `SELECT id, companyName, region, city, category, website, evidence,
            policyFound, policyCompany, policyNumber, policyExpiry, policyMassimale,
            status, notes, phone, email, pec, piva
     FROM Lead WHERE type = 'HEALTHCARE'`
  )
  .all();

const queue = [];
const rejected = [];

for (const r of rows) {
  const ev = r.evidence || "";
  const docs = extractDocs(ev);
  const pub = hasPubToken(ev);
  const pf = r.policyFound === 1 || r.policyFound === true;
  const hasField =
    Boolean(r.policyCompany?.trim()) ||
    Boolean(r.policyNumber?.trim()) ||
    Boolean(r.policyExpiry) ||
    Boolean(r.policyMassimale?.trim());

  const fp = (() => {
    const wh = r.website ? hostOf(r.website) : null;
    if (!wh) return { ok: false, reason: "no_website" };
    for (const d of docs) {
      const dh = hostOf(d);
      if (dh && (dh === wh || dh.endsWith(`.${wh}`) || wh.endsWith(`.${dh}`))) {
        return { ok: true, url: d, host: dh };
      }
    }
    for (const p of ev.match(/https?:\/\/[^\s\]|>]+/gi) || []) {
      const ph = hostOf(p);
      if (ph && (ph === wh || ph.endsWith(`.${wh}`) || wh.endsWith(`.${ph}`))) {
        return { ok: true, url: p, host: ph };
      }
    }
    return { ok: false, reason: "no_first_party_url" };
  })();

  // Priority set: historical PUBLISHED-like with usable proof hints
  const eligible =
    (pub || pf) &&
    (docs.length > 0 || fp.ok) &&
    (hasField || docs.length > 0);

  if (!eligible) {
    if (pub || pf) {
      rejected.push({
        id: r.id,
        companyName: r.companyName,
        reason: !docs.length && !fp.ok ? "no_doc_or_page_url" : "insufficient_fields",
        pub,
        policyFound: pf,
      });
    }
    continue;
  }

  queue.push({
    id: r.id,
    companyName: r.companyName,
    region: r.region,
    city: r.city,
    category: r.category,
    website: r.website,
    policyFound: pf,
    policyCompany: r.policyCompany,
    policyNumber: r.policyNumber,
    policyExpiry: r.policyExpiry,
    policyMassimale: r.policyMassimale,
    docs,
    firstPartyUrl: fp.ok ? fp.url : docs[0] || null,
    domain: fp.ok ? fp.host : hostOf(r.website),
    legacyPublished: pub,
    crmStatus: r.status,
    notes: r.notes,
  });
}

queue.sort((a, b) => {
  // Prefer those with PDF docs + expiry/company already present
  const sa =
    (a.docs.some((d) => /\.pdf/i.test(d)) ? 2 : 0) +
    (a.policyExpiry ? 1 : 0) +
    (a.policyCompany ? 1 : 0);
  const sb =
    (b.docs.some((d) => /\.pdf/i.test(d)) ? 2 : 0) +
    (b.policyExpiry ? 1 : 0) +
    (b.policyCompany ? 1 : 0);
  return sb - sa;
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const payload = {
  builtAt: new Date().toISOString(),
  liveDb: LIVE_DB,
  totalHealthcare: rows.length,
  queueCount: queue.length,
  rejectedCount: rejected.length,
  queue,
  rejectedSample: rejected.slice(0, 30),
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(
  JSON.stringify(
    {
      event: "published_priority_queue_built",
      queueCount: queue.length,
      rejectedCount: rejected.length,
      out: OUT,
      withPdf: queue.filter((q) => q.docs.some((d) => /\.pdf/i.test(d))).length,
      withExpiry: queue.filter((q) => q.policyExpiry).length,
    },
    null,
    2
  )
);
