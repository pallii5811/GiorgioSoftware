import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const ALLOWED_STATUS = ["NEW", "CONTACTED", "CONVERTED", "LOST"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const region = url.searchParams.get("region");
    const q = (url.searchParams.get("q") ?? "").trim();
    const includePending = url.searchParams.get("includePending") === "1";
    const status = url.searchParams.get("status");

    const leads = await prisma.lead.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(region ? { region } : {}),
        ...(status ? { status } : {}),
        ...(includePending ? {} : { lastScannedAt: { not: null } }),
        ...(q
          ? {
              OR: [
                { companyName: { contains: q } },
                { website: { contains: q } },
                { city: { contains: q } },
                { email: { contains: q } },
                { pec: { contains: q } },
                { phone: { contains: q } },
                { piva: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ reminderAt: "asc" }, { updatedAt: "desc" }],
      take: 2000,
    });

    return NextResponse.json({ success: true, data: leads });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il recupero dei lead." }, { status: 500 });
  }
}

// Aggiorna stato commerciale, note e promemoria di un lead (workflow CRM).
export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string;
      status?: string;
      notes?: string | null;
      reminderAt?: string | null;
    };
    const { id } = body;
    if (!id) {
      return NextResponse.json({ success: false, error: "ID lead richiesto." }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (!ALLOWED_STATUS.includes(body.status)) {
        return NextResponse.json({ success: false, error: "Stato non valido." }, { status: 400 });
      }
      data.status = body.status;
    }
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.reminderAt !== undefined) {
      data.reminderAt = body.reminderAt ? new Date(body.reminderAt) : null;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ success: false, error: "Nessun campo da aggiornare." }, { status: 400 });
    }

    const lead = await prisma.lead.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: lead });
  } catch {
    return NextResponse.json(
      { success: false, error: "Errore durante l'aggiornamento del lead." },
      { status: 500 }
    );
  }
}
