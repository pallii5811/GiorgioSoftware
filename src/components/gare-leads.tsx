"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Building2, Search, Loader2, Euro, MapPin, FileText, Landmark,
  RefreshCw, Trash2, ShieldCheck, Download, Phone, Mail, Globe, Hash,
} from "lucide-react"
import { parseEvidenceSections } from "@/lib/sanita/audit"
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
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0)

export function GareLeads() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isScanning, setIsScanning] = useState(false)
  const [query, setQuery] = useState("")
  const [regionFilter, setRegionFilter] = useState<"ALL" | "Veneto" | "Campania">("ALL")

  const fetchLeads = async () => {
    try {
      const res = await fetch("/api/gare")
      const json = await res.json()
      if (json.success) setLeads(json.data)
    } catch {
      toast.error("Errore di connessione al database")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await fetch("/api/gare")
        const json = await res.json()
        if (active && json.success) setLeads(json.data)
      } catch {
        if (active) toast.error("Errore di connessione al database")
      } finally {
        if (active) setIsLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  const scan = async (region: "Veneto" | "Campania") => {
    setIsScanning(true)
    const toastId = toast.loading(`Ricerca aggiudicazioni reali in ${region}…`)
    try {
      const res = await fetch("/api/gare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      })
      const json = await res.json()
      if (json.success) {
        toast.success(json.message, { id: toastId, duration: 9000 })
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

  const exportCsv = () => {
    if (filtered.length === 0) { toast.info("Nessuna gara da esportare"); return }
    const rows = filtered.map((l) => ({
      Azienda: l.companyName,
      CIG: l.tenderCig,
      Oggetto: l.tenderObject,
      Importo: l.tenderAmount,
      Cauzione10: Math.round(l.tenderAmount * 0.1),
      Telefono: l.phone ?? "",
      Email: l.email ?? "",
      PEC: l.pec ?? "",
      Sito: l.website ?? "",
      Fonti: parseEvidenceSections(l.evidence).fonti ?? "",
      Regione: l.region,
      Stato: l.status,
    }))
    downloadCsv(`gare-${new Date().toISOString().slice(0, 10)}.csv`, rows)
    toast.success(`Esportate ${rows.length} gare in CSV`)
  }

  const q = query.trim().toLowerCase()
  const scope = leads.filter((l) => regionFilter === "ALL" || l.region === regionFilter)
  const filtered = scope.filter((l) => {
    if (q && !(`${l.companyName} ${l.tenderObject} ${l.tenderCig}`.toLowerCase().includes(q))) return false
    return true
  })
  const totalAmount = scope.reduce((s, l) => s + (l.tenderAmount || 0), 0)
  const cauzioni = totalAmount * 0.1

  const withPhone = scope.filter((l) => l.phone).length
  const withEmail = scope.filter((l) => l.email).length
  const withFonti = scope.filter((l) => l.evidence?.includes("[FONTI:")).length

  const KPIS = [
    { label: "Aggiudicazioni", value: scope.length.toLocaleString("it-IT"), icon: Landmark, cls: "" },
    { label: "Con telefono", value: `${withPhone}/${scope.length || 0}`, icon: Phone, cls: "" },
    { label: "Con email / PEC", value: `${withEmail}/${scope.length || 0}`, icon: Mail, cls: "" },
    { label: "Opportunità cauzioni", value: fmtMoney(cauzioni), icon: Euro, cls: "text-emerald-600" },
  ]

  return (
    <div className="space-y-6">
      {/* HEADER */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500 text-white">
              <Building2 className="h-5 w-5" />
            </span>
            Motore Gare Pubbliche · Cauzioni
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Aziende che hanno appena vinto un appalto e devono presentare la cauzione definitiva (10%).
            Solo dati validati da fonti ufficiali.
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

      {/* KPI */}
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

      {/* TOOLBAR */}
      <Card className="ring-soft border-border/60">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca azienda, oggetto o CIG…" className="pl-9" />
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
        </CardContent>
      </Card>

      {/* TABELLA */}
      <Card className="ring-soft border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div>
          ) : filtered.length === 0 ? (
            <div className="m-4 rounded-xl border-2 border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              {leads.length === 0
                ? "Nessuna gara. Avvia una scansione: i dati arrivano dal dataset ufficiale ANAC (OCDS), senza bisogno di chiavi API."
                : "Nessun risultato per i filtri selezionati."}
            </div>
          ) : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Azienda aggiudicataria</th>
                    <th className="px-4 py-3 font-medium">Appalto</th>
                    <th className="px-4 py-3 font-medium">Contatti</th>
                    <th className="px-4 py-3 font-medium">Importo</th>
                    <th className="px-4 py-3 font-medium">Cauzione 10%</th>
                    <th className="px-4 py-3 font-medium">Fonti</th>
                    <th className="px-4 py-3 font-medium">Regione</th>
                    <th className="px-4 py-3 font-medium">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => {
                    const fonti = parseEvidenceSections(l.evidence).fonti
                    return (
                    <tr key={l.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 align-top font-medium">{l.companyName}</td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-col">
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <FileText className="h-3 w-3" /> CIG: {l.tenderCig}
                          </span>
                          <span className="max-w-[260px] truncate" title={l.tenderObject}>{l.tenderObject}</span>
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
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top tabular-nums">{fmtMoney(l.tenderAmount)}</td>
                      <td className="px-4 py-3 align-top">
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 font-semibold text-emerald-700 tabular-nums">
                          <Euro className="h-3.5 w-3.5" /> {fmtMoney(l.tenderAmount * 0.1)}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top max-w-[200px]">
                        {fonti ? (
                          <span className="text-[10px] leading-snug text-muted-foreground" title={fonti}>{fonti}</span>
                        ) : (
                          <span className="text-xs text-amber-600">Riscansiona per fonti</span>
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
        Fonte gara: dataset ufficiale ANAC (BDNCP / OCDS). I contatti aziendali sono ricavati da fonti pubbliche verificabili — ogni scheda riporta le fonti consultate.
        {withFonti < scope.length && scope.length > 0 && (
          <span className="text-amber-600"> · {scope.length - withFonti} gare senza trail fonti: riscansiona la regione.</span>
        )}
      </p>
    </div>
  )
}
