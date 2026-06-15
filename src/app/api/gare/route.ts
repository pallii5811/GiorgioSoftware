import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchAnacAwards } from "@/lib/gare/anac";
import { enrichTenderBatch } from "@/lib/gare/enrich";

// MOTORE GARE: usa i dati AUTORITATIVI ANAC (BDNCP in formato OCDS) come fonte
// primaria. Estrae solo gare realmente aggiudicate (CIG + aggiudicatario +
// importo), senza bisogno di OpenAI/Tavily e senza rischio di dati inventati.

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  try {
    const leads = await prisma.lead.findMany({
      where: { type: "TENDER" },
      orderBy: { createdAt: "desc" }
    });
    return NextResponse.json({ success: true, data: leads });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il recupero delle gare" }, { status: 500 });
  }
}

// Rimuove i lead gara "simulati" generati in passato (firma del vecchio mock:
// CIG che inizia per "Z" + ragione sociale "Edilizia Costruzioni ...").
export async function DELETE() {
  try {
    const res = await prisma.lead.deleteMany({
      where: {
        type: "TENDER",
        OR: [
          { companyName: { startsWith: "Edilizia Costruzioni" } },
          { tenderCig: { startsWith: "Z" } },
        ],
      },
    });
    return NextResponse.json({ success: true, message: `Rimossi ${res.count} lead simulati.`, removed: res.count });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante la pulizia." }, { status: 500 });
  }
}

// Valida un CIG italiano: codice alfanumerico (tipicamente 10 caratteri).
function isValidCig(cig: unknown): cig is string {
  return typeof cig === "string" && /^[A-Z0-9]{8,12}$/i.test(cig.trim());
}

// Scarta nomi-aggiudicatario generici / placeholder.
function isValidWinner(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 3) return false;
  return !/non\s+specificat|sconosciut|n\/?d|da\s+definire/i.test(n);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { region?: string; max?: number | "all" };
    const { region } = body;

    if (!region || !["Veneto", "Campania"].includes(region)) {
      return NextResponse.json({ success: false, error: "Regione non supportata." }, { status: 400 });
    }

    const newLeads: unknown[] = [];
    const toEnrich: {
      id: string;
      companyName: string;
      region: string;
      meta: { year: number; cig: string; object: string; buyer: string | null; amount: number };
    }[] = [];
    let skipped = 0;

    // Fonte autoritativa ANAC (OCDS): nessuna chiave API necessaria.
    const max = body.max === "all" || body.max === 0 ? 0 : typeof body.max === "number" ? body.max : 0;
    const { awards, year, scanned } = await fetchAnacAwards(region, { max });

    if (year === null) {
      return NextResponse.json({
        success: true,
        message:
          "Dataset ANAC non raggiungibile in questo momento (possibile blocco di rete/proxy). Riprova più tardi.",
        stats: { found: 0, inserted: 0, skipped: 0, year: null },
        data: [],
      });
    }

    for (const a of awards) {
      // Doppia validazione: CIG valido + aggiudicatario reale + importo positivo.
      if (!isValidCig(a.cig) || !isValidWinner(a.companyName) || !(a.amount > 0)) {
        skipped++;
        continue;
      }
      const cig = a.cig.trim().toUpperCase();
      const lead = await prisma.lead.upsert({
        where: { tenderCig: cig },
        update: {},
        create: {
          type: "TENDER",
          companyName: a.companyName.trim(),
          region,
          tenderCig: cig,
          tenderAmount: a.amount,
          tenderObject: a.object || "Appalto pubblico",
          tenderWinner: a.companyName.trim(),
          status: "NEW",
        },
      });
      newLeads.push(lead);
      if (year !== null) {
        toEnrich.push({
          id: lead.id,
          companyName: lead.companyName,
          region,
          meta: {
            year,
            cig,
            object: a.object || "Appalto pubblico",
            buyer: a.buyer,
            amount: a.amount,
          },
        });
      }
    }

    let contactStats = { enriched: 0, withPhone: 0, withEmail: 0 };
    if (toEnrich.length > 0) {
      contactStats = await enrichTenderBatch(toEnrich, 6);
    }

    return NextResponse.json({
      success: true,
      message:
        `ANAC ${year} · ${region}: ${awards.length} aggiudicazioni, ${newLeads.length} in anagrafica` +
        (skipped > 0 ? `, ${skipped} scartate` : "") +
        ` · contatti: ${contactStats.withPhone} tel, ${contactStats.withEmail} email (fonti tracciate).`,
      stats: {
        found: awards.length,
        inserted: newLeads.length,
        skipped,
        year,
        scanned,
        contacts: contactStats,
      },
      data: newLeads,
    });
  } catch (error) {
    console.error("Errore nel motore Gare:", error);
    return NextResponse.json(
      { success: false, error: "Errore nel motore gare ANAC. Riprova; se persiste, potrebbe essere un blocco di rete." },
      { status: 500 }
    );
  }
}

