"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Building2, Search, Loader2, Euro, MapPin, FileText, Landmark,
  RefreshCw, Trash2, ShieldCheck, Download, Phone, Mail, Globe, Hash,
  Calendar, Target,
} from "lucide-react"
import { parseEvidenceSections } from "@/lib/sanita/audit"
import {
  categoryToRelevance,
  GARE_RELEVANCE_META,
  parseTenderAwardDate,
  parseTenderBuyer,
  parseTenderBuyerCity,
  parseTenderDatasetYear,
  parseTenderOpportunity,
  awardMonthsAgo,
  isFreshTenderLead,
} from "@/lib/gare/display"
import { claimKindLabel, estimateCauzione } from "@/lib/gare/commercial"
import { toast } from "sonner"
import { downloadCsv } from "@/lib/export-csv"
import { StatusSelect } from "@/components/status-select"
import { cn } from "@/lib/utils"

type Lead = {
  id: string
  companyName: string
  region: string
  tenderCig: string
  tenderAmount: number
  tenderObject: string
  status: string
  createdAt: string
  phone: string | null
  email: string | null
  pec: string | null
  website: string | null
  leadScore: number | null
  evidence: string | null
  category: string | null
  city: string | null
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0)

export function GareLeads() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isScanning, setIsScanning] = useState(false)
  const [query, setQuery] = useState("")
  const [regionFilter, setRegionFilter] = useState<"ALL" | "Veneto" | "Campania">("ALL")
  const [priorityOnly, setPriorityOnly] = useState(true)
  const [hiddenStale, setHiddenStale] = useState(0)

  const fetchLeads = async () => {
    try {
      const qs = priorityOnly ? "?priority=1" : ""
      const res = await fetch(`/api/gare${qs}`)
      const json = await res.json().catch(() => null)
      if (!json) {
        toast.error("Risposta non valida dal server gare")
        return
      }
      if (json.success) {
        setLeads(json.data)
        setHiddenStale(typeof json.hiddenStale === "number" ? json.hiddenStale : 0)
      }
      else toast.error(json.error ?? "Errore caricamento gare")
    } catch {
      toast.error("Motore gare non raggiungibile — verifica che Hetzner sia online")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const qs = priorityOnly ? "?priority=1" : ""
        const res = await fetch(`/api/gare${qs}`)
        const json = await res.json().catch(() => null)
        if (!active) return
        if (!json) {
          toast.error("Risposta non valida dal server gare")
          return
        }
        if (json.success) {
        setLeads(json.data)
        setHiddenStale(typeof json.hiddenStale === "number" ? json.hiddenStale : 0)
      }
        else toast.error(json.error ?? "Errore caricamento gare")
      } catch {
        if (active) toast.error("Motore gare non raggiungibile — verifica che Hetzner sia online")
      } finally {
        if (active) setIsLoading(false)
      }
    })()
    return () => { active = false }
  }, [priorityOnly])

  const scan = async (region: "Veneto" | "Campania") => {
    setIsScanning(true)
    const toastId = toast.loading(`Import ANAC + contatti in ${region}…`)
    try {
      const res = await fetch("/api/gare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, commercialOnly: true, max: 200 }),
      })
      const json = await res.json()
      if (json.success) {
        toast.success(json.message, { id: toastId, duration: 12000 })
        fetchLeads()
      } else {
        toast.error(json.error, { id: toastId, duration: 9000 })
      }
    } catch {
      toast.error("Errore fatale del motore gare", { id: toastId })
    } finally {
      setIsScanning(false)
    }
  }

  const cleanup = async () => {
    const toastId = toast.loading("Rimozione dati simulati…")
    try {
      const res = await fetch("/api/gare", { method: "DELETE" })
      const json = await res.json()
      if (json.success) {
        toast.success(json.message, { id: toastId })
        fetchLeads()
      } else toast.error(json.error, { id: toastId })
    } catch {
      toast.error("Errore durante la pulizia", { id: toastId })
    }
  }

  const updateStatus = (id: string, status: string) =>
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)))

  const q = query.trim().toLowerCase()
  const scope = useMemo(
    () =>
      leads
        .filter((l) => isFreshTenderLead(l.evidence))
        .filter((l) => regionFilter === "ALL" || l.region === regionFilter),
    [leads, regionFilter]
  )
  const filtered = useMemo(() => {
    const rows = scope.filter((l) => {
      if (
        q &&
        !`${l.companyName} ${l.tenderObject} ${l.tenderCig} ${l.city ?? ""} ${parseTenderBuyer(l.evidence) ?? ""}`
          .toLowerCase()
          .includes(q)
      ) {
        return false
      }
      return true
    })
    return [...rows].sort((a, b) => {
      const da = parseTenderAwardDate(a.evidence) ?? ""
      const db = parseTenderAwardDate(b.evidence) ?? ""
      if (db !== da) return db.localeCompare(da)
      return (b.leadScore ?? 0) - (a.leadScore ?? 0)
    })
  }, [scope, q])

  const priorityCount = scope.filter((l) => {
    const r = categoryToRelevance(l.category)
    return r === "HIGH" || r === "MEDIUM"
  }).length

  const totalAmount = filtered.reduce((s, l) => s + (l.tenderAmount || 0), 0)
  const cauzioni = totalAmount * 0.1
  const withPhone = filtered.filter((l) => l.phone).length
  const withEmail = filtered.filter((l) => l.email || l.pec).length
  const withFonti = filtered.filter((l) => l.evidence?.includes("[FONTI:")).length

  const exportCsv = () => {
    if (filtered.length === 0) { toast.info("Nessuna gara da esportare"); return }
    const rows = filtered.map((l) => {
      const rel = categoryToRelevance(l.category)
      return {
        Azienda: l.companyName,
        Priorità: rel ?? "",
        Score: l.leadScore ?? "",
        CIG: l.tenderCig,
        Oggetto: l.tenderObject,
        Opportunità: parseTenderOpportunity(l.evidence) ?? (rel ? GARE_RELEVANCE_META[rel].opportunity : ""),
        Importo: l.tenderAmount,
        CauzioneStimata10pct: Math.round(l.tenderAmount * 0.1),
        CauzioneTipo: "STIMA (non documentata)",
        AnnoDataset: parseTenderDatasetYear(l.evidence) ?? "",
        DataAggiudicazione: parseTenderAwardDate(l.evidence) ?? "",
        StazioneAppaltante: parseTenderBuyer(l.evidence) ?? "",
        Comune: l.city ?? "",
        Telefono: l.phone ?? "",
        Email: l.email ?? "",
        PEC: l.pec ?? "",
        Sito: l.website ?? "",
        Fonti: parseEvidenceSections(l.evidence).fonti ?? "",
        Regione: l.region,
        Stato: l.status,
      }
    })
    downloadCsv(`gare-${new Date().toISOString().slice(0, 10)}.csv`, rows)
    toast.success(`Esportate ${rows.length} gare in CSV`)
  }

  const KPIS = [
    { label: "Gare prioritarie", value: priorityCount.toLocaleString("it-IT"), icon: Target, cls: "text-amber-600" },
    { label: "In tabella", value: filtered.length.toLocaleString("it-IT"), icon: Landmark, cls: "" },
    { label: "Con telefono", value: `${withPhone}/${filtered.length || 0}`, icon: Phone, cls: "" },
    { label: "Cauzioni stimate (10%)", value: fmtMoney(cauzioni), icon: Euro, cls: "text-emerald-600" },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500 text-white">
              <Building2 className="h-5 w-5" />
            </span>
            Motore Gare Pubbliche · Cauzioni
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Aggiudicazioni ANAC verificate (CIG, importo, vincitore, stazione appaltante). Solo gare dal 2024 in poi — opportunità cauzione e RC.
            {hiddenStale > 0 && (
              <span className="text-amber-700"> · {hiddenStale} gare storiche (pre-2024) nascoste.</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={cleanup} disabled={isScanning} className="h-10 text-muted-foreground">
            <Trash2 className="h-4 w-4" /> Pulisci simulati
          </Button>
          <Button variant="outline" onClick={exportCsv} disabled={isScanning} className="h-10">
            <Download className="h-4 w-4" /> Esporta CSV
          </Button>
          <Button variant="outline" onClick={fetchLeads} disabled={isScanning} className="h-10">
            <RefreshCw className="h-4 w-4" /> Aggiorna
          </Button>
          <Button onClick={() => scan("Veneto")} disabled={isScanning} className="h-10 bg-amber-500 text-white hover:bg-amber-600">
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Veneto
          </Button>
          <Button onClick={() => scan("Campania")} disabled={isScanning} className="h-10 bg-amber-500 text-white hover:bg-amber-600">
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Campania
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {KPIS.map((k) => (
          <Card key={k.label} className="ring-soft border-border/60">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className={cn("h-4 w-4", k.cls || "text-muted-foreground")} />
              </div>
              <div className={cn("mt-2 text-2xl font-bold tabular-nums", k.cls)}>{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="ring-soft border-border/60">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca azienda, CIG, oggetto, comune…" className="pl-9" />
          </div>
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["ALL", "Veneto", "Campania"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRegionFilter(r)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  regionFilter === r ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r === "ALL" ? "Tutte" : r}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPriorityOnly((v) => !v)}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm font-medium transition",
              priorityOnly
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {priorityOnly ? "Solo prioritarie" : "Mostra anche rumore"}
          </button>
        </CardContent>
      </Card>

      <Card className="ring-soft border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div>
          ) : filtered.length === 0 ? (
            <div className="m-4 rounded-xl border-2 border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              {leads.length === 0
                ? "Nessuna gara. Avvia una scansione: dati ufficiali ANAC (OCDS), filtrati per valore commerciale broker."
                : "Nessun risultato per i filtri selezionati."}
            </div>
          ) : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Aggiudicataria</th>
                    <th className="px-4 py-3 font-medium min-w-[300px]">Gara vinta</th>
                    <th className="px-4 py-3 font-medium">Contatti</th>
                    <th className="px-4 py-3 font-medium">Importo</th>
                    <th className="px-4 py-3 font-medium">Cauzione (stima)</th>
                    <th className="px-4 py-3 font-medium">Opportunità</th>
                    <th className="px-4 py-3 font-medium">Regione</th>
                    <th className="px-4 py-3 font-medium">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => {
                    const rel = categoryToRelevance(l.category)
                    const meta = rel ? GARE_RELEVANCE_META[rel] : null
                    const awardDate = parseTenderAwardDate(l.evidence)
                    const monthsAgo = awardMonthsAgo(l.evidence)
                    const datasetYear = parseTenderDatasetYear(l.evidence)
                    const buyer = parseTenderBuyer(l.evidence)
                    const buyerCity = parseTenderBuyerCity(l.evidence) ?? l.city
                    const opportunity = parseTenderOpportunity(l.evidence) ?? meta?.opportunity
                    const fonti = parseEvidenceSections(l.evidence).fonti
                    return (
                    <tr key={l.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 align-top">
                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Vincitore</div>
                        <div className="font-medium">{l.companyName}</div>
                        {l.leadScore != null && (
                          <span className="text-[10px] text-muted-foreground">Score broker {l.leadScore}</span>
                        )}
                        {buyerCity && (
                          <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                            <MapPin className="h-3 w-3" /> {buyerCity}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-col gap-1.5 max-w-[360px]">
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                            <FileText className="h-3 w-3 shrink-0" /> CIG {l.tenderCig}
                          </span>
                          <p className="text-sm leading-snug line-clamp-4" title={l.tenderObject}>
                            {l.tenderObject}
                          </p>
                          {buyer && (
                            <div>
                              <span className="text-[10px] font-medium uppercase text-muted-foreground">Stazione appaltante</span>
                              <p className="text-xs text-foreground" title={buyer}>{buyer}</p>
                            </div>
                          )}
                          {awardDate && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                              <Calendar className="h-3 w-3" />
                              Aggiudicata il {awardDate}
                              {monthsAgo != null && monthsAgo <= 24 && (
                                <span className="text-[10px] font-normal text-muted-foreground">({monthsAgo} mesi fa)</span>
                              )}
                            </span>
                          )}
                          {datasetYear && (
                            <span className="text-[10px] text-muted-foreground">
                              Fonte dataset ANAC {datasetYear}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-xs">
                        <div className="flex flex-col gap-1">
                          {l.phone ? (
                            <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{l.phone}</span>
                          ) : (
                            <span className="text-muted-foreground">— tel</span>
                          )}
                          {l.email ? (
                            <span className="inline-flex items-center gap-1 truncate max-w-[180px]" title={l.email}>
                              <Mail className="h-3 w-3 shrink-0" />{l.email}
                            </span>
                          ) : l.pec ? (
                            <span className="inline-flex items-center gap-1 truncate max-w-[180px]" title={l.pec}>
                              <Hash className="h-3 w-3 shrink-0" />{l.pec}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">— email</span>
                          )}
                          {l.website && (
                            <a href={l.website.startsWith("http") ? l.website : `https://${l.website}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline truncate max-w-[180px]">
                              <Globe className="h-3 w-3 shrink-0" /> sito
                            </a>
                          )}
                          {fonti && (
                            <span className="text-[10px] text-muted-foreground line-clamp-2" title={fonti}>{fonti}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top tabular-nums">{fmtMoney(l.tenderAmount)}</td>
                      <td className="px-4 py-3 align-top">
                        {(() => {
                          const est = estimateCauzione(l.tenderAmount)
                          return (
                            <>
                              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 font-semibold text-emerald-700 tabular-nums">
                                <Euro className="h-3.5 w-3.5" /> {fmtMoney(est.value)}
                              </span>
                              <div className="mt-1 text-[10px] text-amber-700">
                                {claimKindLabel(est.kind)} · 10% tipico, non documentato
                              </div>
                            </>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {meta && rel ? (
                          <div className="flex flex-col gap-1">
                            <Badge
                              variant="outline"
                              className={cn(
                                "w-fit text-[10px] font-medium",
                                rel === "HIGH" && "border-emerald-300 bg-emerald-50 text-emerald-800",
                                rel === "MEDIUM" && "border-amber-300 bg-amber-50 text-amber-800",
                                rel === "LOW" && "border-slate-300 bg-slate-50 text-slate-600"
                              )}
                            >
                              {meta.label}
                            </Badge>
                            {opportunity && (
                              <span className="text-[10px] text-muted-foreground max-w-[140px]">{opportunity}</span>
                            )}
                            <span className="text-[10px] text-muted-foreground">{meta.subtitle}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <Badge variant="outline" className="flex w-fit items-center gap-1">
                          <MapPin className="h-3 w-3" /> {l.region}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <StatusSelect id={l.id} value={l.status} onChanged={(s) => updateStatus(l.id, s)} />
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
        Fonte gara: ANAC BDNCP (OCDS). Contatti da fonti pubbliche tracciate. Import esclude automaticamente gare a bassa priorità (utilities, pulizie generiche).
        {withFonti < filtered.length && filtered.length > 0 && (
          <span className="text-amber-600"> · {filtered.length - withFonti} senza trail fonti: riscansiona.</span>
        )}
      </p>
    </div>
  )
}
