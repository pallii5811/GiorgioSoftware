"use client"

import { useState } from "react"
import {
  X, Copy, Mail, Phone, Globe, Hash, MapPin, Building2, Save, ShieldCheck, ExternalLink,
} from "lucide-react"
import { toast } from "sonner"
import { StatusSelect } from "@/components/status-select"
import { parseEvidenceSections } from "@/lib/sanita/audit"
import { cn } from "@/lib/utils"

export type DetailLead = {
  id: string
  companyName: string
  category: string | null
  region: string
  city: string | null
  website: string | null
  phone: string | null
  email: string | null
  pec: string | null
  piva: string | null
  policyCompany: string | null
  policyMassimale: string | null
  policyNumber: string | null
  policyExpiry: string | null
  leadScore: number | null
  status: string
  notes: string | null
  reminderAt: string | null
  evidence: string | null
}

const copyText = async (text: string, label = "Copiato") => {
  try { await navigator.clipboard.writeText(text); toast.success(label) }
  catch { toast.error("Impossibile copiare") }
}

const fmt = (s: string | null) => (s ? new Intl.DateTimeFormat("it-IT").format(new Date(s)) : "—")

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}

export function LeadDetail({
  lead, callScript, onClose, onUpdated,
}: {
  lead: DetailLead
  callScript: string
  onClose: () => void
  onUpdated: (patch: Partial<DetailLead>) => void
}) {
  const [notes, setNotes] = useState(lead.notes ?? "")
  const [reminder, setReminder] = useState(lead.reminderAt ? lead.reminderAt.slice(0, 10) : "")
  const [saving, setSaving] = useState(false)
  const evidenceParts = parseEvidenceSections(lead.evidence)

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, notes, reminderAt: reminder || null }),
      })
      const json = await res.json()
      if (!json.success) throw new Error()
      onUpdated({ notes, reminderAt: reminder ? new Date(reminder).toISOString() : null })
      toast.success("Dettagli salvati")
    } catch {
      toast.error("Errore durante il salvataggio")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold leading-tight">{lead.companyName}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" />{lead.category || "Struttura"}</span>
              {lead.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{lead.city}</span>}
              <span className="rounded border border-border px-1.5 py-0.5">{lead.region}</span>
              {lead.leadScore != null && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">Priorità {lead.leadScore}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* CONTATTI */}
        <div className="mb-4 space-y-1 rounded-xl border border-border/60 bg-muted/30 p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contatti</div>
          {lead.website ? (
            <a href={lead.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline">
              <Globe className="h-4 w-4" /> {lead.website} <ExternalLink className="h-3 w-3" />
            </a>
          ) : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Globe className="h-4 w-4" /> nessun sito</div>}
          {lead.phone && <a href={`tel:${lead.phone}`} className="flex items-center gap-2 text-sm hover:text-primary"><Phone className="h-4 w-4" /> {lead.phone}</a>}
          {lead.email && <a href={`mailto:${lead.email}`} className="flex items-center gap-2 text-sm hover:text-primary"><Mail className="h-4 w-4" /> {lead.email}</a>}
          {lead.pec && <a href={`mailto:${lead.pec}`} className="flex items-center gap-2 text-sm text-violet-700 hover:underline"><Mail className="h-4 w-4" /> {lead.pec} <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold">PEC</span></a>}
          {lead.piva && (
            <button onClick={() => copyText(lead.piva!, "P.IVA copiata")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <Hash className="h-4 w-4" /> P.IVA {lead.piva} <Copy className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* VERIFICA / FONTI */}
        {(evidenceParts.body || evidenceParts.fonti) && (
          <div className="mb-4 rounded-xl border border-border/60 bg-slate-50/80 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Verifica automatica</div>
            {evidenceParts.body && (
              <p className="text-sm leading-relaxed text-foreground">{evidenceParts.body}</p>
            )}
            {evidenceParts.fonti && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-semibold text-slate-600">Fonti controllate: </span>
                {evidenceParts.fonti}
              </p>
            )}
          </div>
        )}

        {/* POLIZZA */}
        <div className="mb-4 rounded-xl border border-border/60 p-3">
          <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" /> Polizza RC
          </div>
          <Row label="Compagnia">{lead.policyCompany || "—"}</Row>
          <Row label="Massimale">{lead.policyMassimale || "—"}</Row>
          <Row label="N. polizza">{lead.policyNumber || "—"}</Row>
          <Row label="Scadenza">{fmt(lead.policyExpiry)}</Row>
        </div>

        {/* SCRIPT */}
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Script di chiamata</span>
            <button onClick={() => copyText(callScript, "Script copiato")} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <Copy className="h-3 w-3" /> Copia
            </button>
          </div>
          <p className="rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{callScript}</p>
        </div>

        {/* AZIONI CRM */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Stato</label>
            <StatusSelect id={lead.id} value={lead.status} onChanged={(s) => onUpdated({ status: s })} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Promemoria</label>
            <input
              type="date"
              value={reminder}
              onChange={(e) => setReminder(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Note</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Esito chiamata, referente, prossimi passi…"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <button
          onClick={save}
          disabled={saving}
          className={cn("brand-gradient mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white", saving && "opacity-70")}
        >
          <Save className="h-4 w-4" /> {saving ? "Salvataggio…" : "Salva note e promemoria"}
        </button>
      </div>
    </div>
  )
}
