import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const ALLOWED_STATUS = ["NEW", "CONTACTED", "CONVERTED", "LOST"];

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
