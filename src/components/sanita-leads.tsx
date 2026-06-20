"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Stethoscope, Search, Loader2, AlertTriangle, CheckCircle2, MapPin, Globe,
  Phone, HelpCircle, Building2, ShieldAlert, ShieldCheck, ShieldQuestion,
  Filter, X, RefreshCw, Mail, ExternalLink, Download, Copy, Flame, Hash,
  Info, Zap, FileSearch, RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import {
  deriveVerdict, VERDICT_META, type Verdict,
} from "@/lib/sanita/verdict"
import { parseEvidenceSections, policyPdfUrlsForLead } from "@/lib/sanita/audit"
import { downloadCsv } from "@/lib/export-csv"
import { StatusSelect } from "@/components/status-select"
import { LeadDetail } from "@/components/lead-detail"
import { cn } from "@/lib/utils"
import { consumeSanitaScanStream } from "@/lib/sanita/scan-sse-client"
import { classifyGelliScope } from "@/lib/sanita/gelli-scope"

type Lead = {
  id: string
  osmId: string | null
  companyName: string
  region: string
  category: string | null
  website: string | null
  city: string | null
  phone: string | null
  email: string | null
  policyFound: boolean | null
  policyCompany: string | null
  policyMassimale: string | null
  policyNumber: string | null
  policyExpiry: string | null
  confidence: number | null
  websiteReachable: boolean | null
  lastScannedAt: string | null
  status: string
  evidence: string | null
  pec: string | null
  piva: string | null
  leadScore: number | null
  notes: string | null
  reminderAt: string | null
}

type VerdictFilter = "ALL" | Verdict | "PENDING"

type RegionDiscoveryMeta = {
  mapsCityOffset: number
  citiesTotal: number
  mapsDiscoveryComplete: boolean
}

type RegionMeta = {
  total: number
  done: number
  pending: number
  discovery?: RegionDiscoveryMeta
}

const VERDICT_UI: Record<Verdict, { label: string; subtitle: string; cls: string; icon: typeof CheckCircle2 }> = {
  PUBLISHED: { label: VERDICT_META.PUBLISHED.label, subtitle: VERDICT_META.PUBLISHED.subtitle, cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: ShieldCheck },
  HOT: { label: VERDICT_META.HOT.label, subtitle: VERDICT_META.HOT.subtitle, cls: "bg-red-50 text-red-700 border-red-200", icon: ShieldAlert },
  REVIEW: { label: VERDICT_META.REVIEW.label, subtitle: VERDICT_META.REVIEW.subtitle, cls: "bg-amber-50 text-amber-700 border-amber-200", icon: ShieldQuestion },
}

export function SanitaLeads() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [detail, setDetail] = useState<Lead | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isScanning, setIsScanning] = useState(false)
  const [query, setQuery] = useState("")
  const [regionFilter, setRegionFilter] = useState<"ALL" | "Veneto" | "Campania">("ALL")
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("ALL")
  const [selectedCity, setSelectedCity] = useState<string | null>(null)
  const [cityOpen, setCityOpen] = useState(false)
  const [cityQuery, setCityQuery] = useState("")
  const [refDate] = useState(() => new Date())
  const [scanProgress, setScanProgress] = useState<string | null>(null)
  const [activeScan, setActiveScan] = useState<{
    region: "Veneto" | "Campania"
    done: number
    total: number
    round: number
    phase: string
    mapsCityOffset?: number
    citiesTotal?: number
    mapsDiscoveryComplete?: boolean
  } | null>(null)
  const [discoveryMeta, setDiscoveryMeta] = useState<Record<string, RegionDiscoveryMeta>>({})
  const [processingName, setProcessingName] = useState<string | null>(null)
  const [freshLeadIds, setFreshLeadIds] = useState<Set<string>>(new Set())

  /** Conteggi per regione — solo lead visibili in questa sessione + progresso live. */
  const regionStats = useMemo(() => {
    const out: Record<string, { total: number; done: number; hot: number; pending: number }> = {}
    for (const r of ["Veneto", "Campania"] as const) {
      const list = leads.filter((l) => l.region === r && l.lastScannedAt)
      let hot = 0
      for (const l of list) {
        const v = deriveVerdict({
          lastScannedAt: l.lastScannedAt,
          policyFound: l.policyFound,
          websiteReachable: l.websiteReachable,
          website: l.website,
          evidence: l.evidence,
        })
        if (v === "HOT") hot++
      }
      const liveTotal =
        isScanning && activeScan?.region === r
          ? Math.max(activeScan.total, activeScan.done)
          : list.length
      const liveDone =
        isScanning && activeScan?.region === r ? activeScan.done : list.length
      out[r] = {
        total: liveTotal,
        done: liveDone,
        hot,
        pending: Math.max(0, liveTotal - liveDone),
      }
    }
    return out
  }, [leads, isScanning, activeScan])

  const fetchLeads = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setIsLoading(true)
    try {
      const res = await fetch("/api/sanita?includePending=1")
      const json = await res.json()
      if (json.success) {
        setLeads(json.data)
        const regions = json.meta?.regions as Record<string, RegionMeta> | undefined
        if (regions) {
          const next: Record<string, RegionDiscoveryMeta> = {}
          for (const [r, m] of Object.entries(regions)) {
            if (m.discovery) next[r] = m.discovery
          }
          setDiscoveryMeta(next)
        }
        if (!opts?.silent) {
          toast.success(`${json.data.length} strutture caricate dal database`)
        }
      } else if (!opts?.silent) {
        toast.error(json.error ?? "Errore nel caricamento")
      }
    } catch {
      if (!opts?.silent) toast.error("Errore di connessione al database")
    } finally {
      setIsLoading(false)
    }
  }

  /** All'avvio carica i lead già salvati nel database condiviso. */
  useEffect(() => {
    void fetchLeads({ silent: true })
  }, [])

  const upsertLiveLead = (lead: Lead) => {
    const host = (() => {
      if (!lead.website) return null
      try {
        return new URL(lead.website).hostname.replace(/^www\./i, "").toLowerCase()
      } catch {
        return null
      }
    })()
    setLeads((prev) => {
      let rest = prev.filter((l) => l.id !== lead.id)
      if (host) rest = rest.filter((l) => {
        if (!l.website) return true
        try {
          return new URL(l.website).hostname.replace(/^www\./i, "").toLowerCase() !== host
        } catch {
          return true
        }
      })
      return [lead, ...rest]
    })
    setFreshLeadIds((prev) => new Set(prev).add(lead.id))
    window.setTimeout(() => {
      setFreshLeadIds((prev) => {
        const next = new Set(prev)
        next.delete(lead.id)
        return next
      })
    }, 4000)
  }

  const rescanOneLead = async (l: Lead) => {
    const toastId = toast.loading(`Riscansione ${l.companyName}…`)
    try {
      const res = await fetch("/api/sanita/rescan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: l.id }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string; lead?: Lead }
      if (!res.ok || !json.success || !json.lead) {
        throw new Error(json.error ?? "Riscansione fallita")
      }
      upsertLiveLead(json.lead)
      toast.success("Riscansione completata", { id: toastId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Errore riscansione", { id: toastId })
    }
  }

  /** Scansione regionale: ogni struttura compare in tabella appena analizzata. */
  const runFullScan = async (body: {
    region: "Veneto" | "Campania"
    city?: string
    continueAnalysis?: boolean
    liveRescan?: boolean
    reset?: boolean
  }) => {
    const live = body.liveRescan ?? false
    const reset = body.reset ?? false
    const label = body.city
      ? `Scansione live · ${body.city} (${body.region})`
      : `Scansione live · ${body.region}`
    setRegionFilter(body.region)
    setIsScanning(true)
    setScanProgress("Connessione al motore live…")
    setProcessingName(null)
    if (reset) {
      setLeads((prev) => prev.filter((l) => l.region !== body.region))
      setFreshLeadIds(new Set())
    }
    setActiveScan({
      region: body.region,
      done: 0,
      total: 0,
      round: 1,
      phase: live ? "Avvio scansione…" : "Preparazione…",
    })
    const toastId = toast.loading(label)
    let round = 0
    // Campania: ~550 comuni Maps → molte riconnessioni SSE automatiche.
    const maxRounds = body.region === "Campania" ? 280 : 80

    try {
      await fetchLeads({ silent: true })
      const scanKey = `sanita.scan.${body.region}`
      const savedOffset = (() => {
        try {
          const raw = window.localStorage.getItem(scanKey)
          if (!raw) return 0
          const v = JSON.parse(raw) as { mapsCityOffset?: number } | null
          return Number(v?.mapsCityOffset ?? 0) || 0
        } catch {
          return 0
        }
      })()
      const serverOffset = discoveryMeta[body.region]?.mapsCityOffset ?? 0

      let payload: Record<string, unknown> = {
        region: body.region,
        city: body.city,
        liveRescan: live,
        freshScan: reset,
        forceDiscovery: reset || live || !body.continueAnalysis,
        continueAnalysis: reset ? false : (body.continueAnalysis ?? false),
        mapsCityOffset: reset ? 0 : Math.max(savedOffset, serverOffset),
      }

      while (round < maxRounds) {
        round++
        let mapsCityOffset = Number(payload.mapsCityOffset ?? 0)
        let sessionStats: Record<string, unknown> = {}

        let outcome: "complete" | "paused" | "error" = "paused"
        try {
          outcome = await consumeSanitaScanStream(payload, (event, data) => {
          if (event === "progress") {
            const done = Number(data.done ?? 0)
            const total = Number(data.total ?? 0)
            const phase =
              data.phase === "discovery"
                ? String(data.message ?? "Scoperta strutture…")
                : String(data.message ?? "Analisi in corso…")
            setProcessingName(
              typeof data.processingName === "string" ? data.processingName : null
            )
            setActiveScan({
              region: body.region,
              done,
              total,
              round,
              phase,
              mapsCityOffset: Number(data.mapsCityOffset ?? mapsCityOffset),
              citiesTotal: Number(data.citiesTotal ?? discoveryMeta[body.region]?.citiesTotal ?? 0),
              mapsDiscoveryComplete: Boolean(data.mapsDiscoveryComplete),
            })
            setScanProgress(
              total > 0 ? `${body.region}: ${done}/${total} completati` : phase
            )
            toast.loading(
              total > 0 ? `${label} — ${done}/${total}` : `${label} — ${phase}`,
              { id: toastId }
            )
            // Allinea tabella/KPI al DB se il contatore server è avanti allo stato locale.
            setLeads((prev) => {
              const localDone = prev.filter(
                (l) => l.region === body.region && l.lastScannedAt
              ).length
              if (done !== localDone) {
                queueMicrotask(() => void fetchLeads({ silent: true }))
              }
              return prev
            })
          }
          if (event === "lead" && data.lead && typeof data.lead === "object") {
            upsertLiveLead(data.lead as Lead)
            setProcessingName(null)
          }
          if (event === "paused" || event === "complete") {
            sessionStats = (data.stats as Record<string, unknown>) ?? {}
            mapsCityOffset = Number(sessionStats?.mapsCityOffset ?? 0)
            const citiesTotal = Number(sessionStats?.citiesTotal ?? 0)
            const mapsDiscoveryComplete = Boolean(sessionStats?.mapsDiscoveryComplete)
            setDiscoveryMeta((prev) => ({
              ...prev,
              [body.region]: {
                mapsCityOffset,
                citiesTotal,
                mapsDiscoveryComplete,
              },
            }))
            setActiveScan((prev) =>
              prev
                ? {
                    ...prev,
                    mapsCityOffset,
                    citiesTotal,
                    mapsDiscoveryComplete,
                  }
                : prev
            )
            try {
              window.localStorage.setItem(scanKey, JSON.stringify({ mapsCityOffset }))
            } catch {
              /* ignore */
            }
          }
          if (event === "error") {
            toast.error(String(data.message ?? "Errore scansione"), { id: toastId })
          }
        })
        } catch {
          outcome = "paused"
        }

        if (outcome === "paused" && round < maxRounds) {
          toast.loading(`${label} — riconnessione automatica (round ${round})…`, { id: toastId })
          payload = {
            region: body.region,
            city: body.city,
            continueAnalysis: true,
            liveRescan: false,
            forceDiscovery: false,
            mapsCityOffset,
          }
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }

        if (outcome === "error") return

        const stats = sessionStats
        const total = Number(stats.discovered ?? stats.total ?? 0)
        const rem = Number(stats.remainingUnscanned ?? 0)
        const doneCount = Number(stats.done ?? total - rem)
        const mapsDone = Boolean(stats.mapsDiscoveryComplete)
        const fullyComplete = Boolean(stats.complete)

        if (outcome === "complete" && fullyComplete) {
          setActiveScan({
            region: body.region,
            done: doneCount,
            total,
            round,
            phase: "Completato ✓",
            mapsCityOffset: Number(stats.mapsCityOffset ?? 0),
            citiesTotal: Number(stats.citiesTotal ?? 0),
            mapsDiscoveryComplete: true,
          })
          setProcessingName(null)
          toast.success(
            String(stats.message ?? `${body.region} completata: ${total} strutture, tutti i comuni Maps`),
            { id: toastId, duration: 12000 }
          )
          void fetchLeads({ silent: true })
          return
        }

        if (!mapsDone && rem === 0 && total > 0 && outcome === "paused") {
          toast.info(
            `${body.region}: ${total} strutture analizzate — comuni Maps ${Number(stats.mapsCityOffset ?? 0)}/${Number(stats.citiesTotal ?? "?")}. Clicca «Continua ${body.region}».`,
            { id: toastId, duration: 14000 }
          )
        }

        payload = {
          region: body.region,
          city: body.city,
          continueAnalysis: true,
          liveRescan: false,
          forceDiscovery: false,
          mapsCityOffset,
        }
      }

      toast.warning("Sessione terminata — clicca di nuovo Scansiona per continuare i round automatici.", { id: toastId })
    } catch {
      toast.error("Errore di connessione — riprova Scansiona", { id: toastId })
    } finally {
      setIsScanning(false)
      setProcessingName(null)
      setScanProgress(null)
      // dopo reset: ricarica dal DB per non mostrare lead “vecchi” rimasti in memoria
      if (reset) {
        try { await fetchLeads({ silent: true }) } catch {}
      }
      setTimeout(() => setActiveScan(null), 8000)
    }
  }

  const startRegionScan = (region: "Veneto" | "Campania") => {
    void runFullScan({ region, continueAnalysis: false })
  }

  const continueRegionScan = (region: "Veneto" | "Campania") => {
    void runFullScan({ region, continueAnalysis: true })
  }

  const resetRegionScan = (region: "Veneto" | "Campania") => {
    if (!confirm(`Reset ${region}: cancella i lead e riparte da zero. Confermi?`)) return
    try { window.localStorage.removeItem(`sanita.scan.${region}`) } catch {}
    void runFullScan({ region, reset: true })
  }

  const verdictOf = (l: Lead): Verdict | null =>
    deriveVerdict({
      lastScannedAt: l.lastScannedAt,
      policyFound: l.policyFound,
      websiteReachable: l.websiteReachable,
      website: l.website,
      evidence: l.evidence,
    })

  const policyDocLinks = (l: Lead) => policyPdfUrlsForLead(l.evidence)

  const policyHtmlSource = (l: Lead): string | null => {
    const { fonti } = parseEvidenceSections(l.evidence)
    const m = fonti?.match(/fonte polizza HTML:\s*(https?:\/\/\S+)/i)
    return m?.[1] ?? null
  }

  const docLabel = (url: string) => {
    try {
      const name = new URL(url).pathname.split("/").pop() || url
      const decoded = decodeURIComponent(name)
      return decoded.length > 44 ? `${decoded.slice(0, 41)}…` : decoded
    } catch {
      return url.length > 44 ? `${url.slice(0, 41)}…` : url
    }
  }

  const visibleLeads = useMemo(
    () => leads.filter((l) => l.lastScannedAt != null || l.evidence?.trim() || Boolean(l.website?.trim())),
    [leads]
  )

  // Città disponibili (nel set filtrato per regione), ordinate
  const cities = useMemo(() => {
    const set = new Map<string, number>()
    for (const l of visibleLeads) {
      if (regionFilter !== "ALL" && l.region !== regionFilter) continue
      const c = l.city?.trim()
      if (c) set.set(c, (set.get(c) ?? 0) + 1)
    }
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0], "it"))
  }, [visibleLeads, regionFilter])

  const filteredCities = useMemo(() => {
    const q = cityQuery.trim().toLowerCase()
    return q ? cities.filter(([c]) => c.toLowerCase().includes(q)) : cities
  }, [cities, cityQuery])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visibleLeads.filter((l) => {
      if (regionFilter !== "ALL" && l.region !== regionFilter) return false
      if (selectedCity && l.city !== selectedCity) return false
      if (q && !(`${l.companyName} ${l.city ?? ""}`.toLowerCase().includes(q))) return false
      if (verdictFilter !== "ALL") {
        const v = verdictOf(l)
        if (verdictFilter === "PENDING") { if (v !== null) return false }
        else if (v !== verdictFilter) return false
      }
      return true
    })
  }, [visibleLeads, query, regionFilter, selectedCity, verdictFilter])

  // KPI sul set corrente (regione + città), indipendenti dal filtro verdetto
  const scope = useMemo(
    () => visibleLeads.filter((l) =>
      (regionFilter === "ALL" || l.region === regionFilter) &&
      (!selectedCity || l.city === selectedCity)),
    [visibleLeads, regionFilter, selectedCity]
  )
  const kpi = useMemo(() => {
    let hot = 0, pub = 0, review = 0, pending = 0
    for (const l of scope) {
      const v = verdictOf(l)
      if (v === "HOT") hot++
      else if (v === "PUBLISHED") pub++
      else if (v === "REVIEW") review++
      else pending++
    }
    const scanned = scope.filter((l) => l.lastScannedAt != null).length
    const queueTotal =
      isScanning && activeScan && regionFilter === activeScan.region
        ? Math.max(activeScan.total, scanned)
        : scope.length
  const pendingInQueue =
      isScanning && activeScan && regionFilter === activeScan.region
        ? Math.max(0, queueTotal - scanned)
        : scope.filter((l) => !l.lastScannedAt).length
    return { total: scanned, queueTotal, hot, pub, review, pending: pendingInQueue }
  }, [scope, isScanning, activeScan, regionFilter])

  const updateStatus = (id: string, status: string) =>
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)))

  const applyPatch = (patch: Partial<Lead>) => {
    setDetail((prev) => {
      if (!prev) return prev
      setLeads((list) => list.map((l) => (l.id === prev.id ? { ...l, ...patch } : l)))
      return { ...prev, ...patch }
    })
  }

  const exportCsv = () => {
    if (filtered.length === 0) { toast.info("Nessun lead da esportare"); return }
    const rows = filtered.map((l) => {
      const v = verdictOf(l)
      const { body, fonti } = parseEvidenceSections(l.evidence)
      return {
        Struttura: l.companyName,
        Categoria: l.category ?? "",
        Citta: l.city ?? "",
        Regione: l.region,
        Verdetto: v ? VERDICT_META[v].label : "Da analizzare",
        AzioneCommerciale: v ? VERDICT_META[v].commercial : "",
        Sito: l.website ?? "",
        Telefono: l.phone ?? "",
        Email: l.email ?? "",
        PEC: l.pec ?? "",
        PartitaIVA: l.piva ?? "",
        Compagnia: l.policyCompany ?? "",
        Massimale: l.policyMassimale ?? "",
        Scadenza: l.policyExpiry ? new Intl.DateTimeFormat("it-IT").format(new Date(l.policyExpiry)) : "",
        Priorita: l.leadScore ?? 0,
        Stato: l.status,
        Evidenza: body ?? "",
        FontiControllate: fonti ?? "",
      }
    })
    downloadCsv(`lead-sanita-${new Date().toISOString().slice(0, 10)}.csv`, rows)
    toast.success(`Esportati ${rows.length} lead in CSV`)
  }

  const formatDate = (s: string | null) =>
    s ? new Intl.DateTimeFormat("it-IT").format(new Date(s)) : "—"
  const hostname = (url: string | null) => {
    if (!url) return null
    try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
  }

  const verdictBadge = (l: Lead) => {
    const v = verdictOf(l)
    if (!v) {
      return (
        <Badge variant="outline" className="flex w-fit items-center gap-1 text-muted-foreground">
          <HelpCircle className="h-3 w-3" /> Da analizzare
        </Badge>
      )
    }
    const m = VERDICT_UI[v]
    const Icon = m.icon
    return (
      <div className="space-y-0.5">
        <Badge className={cn("flex w-fit items-center gap-1 border", m.cls)}>
          <Icon className="h-3 w-3" /> {m.label}
        </Badge>
        <p className="max-w-[220px] text-[10px] leading-snug text-muted-foreground">{m.subtitle}</p>
      </div>
    )
  }

  const strategy = (l: Lead) => {
    const v = verdictOf(l)
    if (!v) {
      // Nessuna analisi ancora: distinguiamo se c'è un sito o meno
      if (l.website) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs text-slate-600"><FileSearch className="h-3 w-3" />Sito presente — da analizzare</span>
            <span className="block text-[10px] text-muted-foreground">Clicca il bottone Veneto/Campania per avviare</span>
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 text-xs text-slate-600"><FileSearch className="h-3 w-3" />Nessun sito web</span>
          <span className="block text-[10px] text-muted-foreground">Verifica manuale su portale regionale</span>
        </div>
      )
    }
    if (v === "PUBLISHED") {
      const d = l.policyExpiry ? daysUntil(l.policyExpiry) : null
      const daysSince = d != null ? -d : null
      const isObsolete = daysSince != null && daysSince > 365
      const exp = l.policyExpiry ? ` · scadenza ${formatDate(l.policyExpiry)}` : ""
      // Se la scadenza è passata (anche < 365gg), non dire "Già coperta".
      // Operativamente è un contatto urgente (continuità copertura / rinnovo).
      if (d != null && d < 0 && !isObsolete) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700"><Zap className="h-3 w-3" />Polizza scaduta sul sito{exp}</span>
            <span className="block text-[10px] text-muted-foreground">URGENTE — chiamare oggi per rinnovo/continuità copertura</span>
          </div>
        )
      }
      if (isObsolete) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"><CheckCircle2 className="h-3 w-3" />Polizza trovata sul sito{exp}</span>
            <span className="block text-[10px] text-amber-700">⚠️ Data molto vecchia — il sito potrebbe non essere aggiornato. Verifica stato attuale.</span>
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"><CheckCircle2 className="h-3 w-3" />Già coperta{exp}</span>
          <span className="block text-[10px] text-muted-foreground">Ricontatta 60-90 gg prima del rinnovo</span>
        </div>
      )
    }
    if (v === "HOT") {
      const d = l.policyExpiry ? daysUntil(l.policyExpiry) : null
      const isObsolete = d != null && d < -365
      if (isObsolete) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700"><Zap className="h-3 w-3" />Polizza scaduta sul sito — irregolarità certa</span>
            <span className="block text-[10px] text-muted-foreground">Art. 10 Legge Gelli violato — lead prioritario assoluto</span>
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700"><Zap className="h-3 w-3" />Irregolare Art. 10 Gelli</span>
          <span className="block text-[10px] text-muted-foreground">{VERDICT_META.HOT.commercial}</span>
        </div>
      )
    }
    // REVIEW: due sottocasi per chiarezza
    if (l.website && l.websiteReachable !== false) {
      if (/manutenzione/i.test(l.evidence ?? "")) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs text-amber-700"><ShieldQuestion className="h-3 w-3" />Sito in manutenzione</span>
            <span className="block text-[10px] text-muted-foreground">Impossibile leggere Trasparenza online — verifica manuale</span>
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 text-xs text-amber-700"><ShieldQuestion className="h-3 w-3" />Sito analizzato — non conclusivo</span>
          <span className="block text-[10px] text-muted-foreground">Cerca assicurazione RC nella pagina Trasparenza</span>
        </div>
      )
    }
    return (
      <div className="space-y-1">
        <span className="inline-flex items-center gap-1 text-xs text-amber-700"><ShieldQuestion className="h-3 w-3" />Nessun sito / sito non raggiungibile</span>
        <span className="block text-[10px] text-muted-foreground">Cerca la struttura sul portale regionale</span>
      </div>
    )
  }

  const scoreMeta = (score: number | null) => {
    const s = score ?? 0
    if (s >= 80) return { cls: "bg-red-600 text-white", label: "Caldissimo" }
    if (s >= 60) return { cls: "bg-orange-500 text-white", label: "Caldo" }
    if (s >= 40) return { cls: "bg-amber-400 text-amber-950", label: "Tiepido" }
    if (s > 0) return { cls: "bg-slate-200 text-slate-700", label: "Freddo" }
    return { cls: "bg-muted text-muted-foreground", label: "—" }
  }

  const daysUntil = (s: string | null) =>
    s ? Math.ceil((new Date(s).getTime() - refDate.getTime()) / 86_400_000) : null

  const expiryCell = (l: Lead) => {
    if (!l.policyExpiry) return <span className="text-muted-foreground">—</span>
    const d = daysUntil(l.policyExpiry)
    const daysSince = d != null ? -d : null
    const isObsolete = daysSince != null && daysSince > 365

    let label = ""
    let cls = ""
    if (d == null) {
      label = ""; cls = ""
    } else if (isObsolete) {
      label = "data obsoleta sul sito"; cls = "text-slate-500"
    } else if (d < 0) {
      if (daysSince! <= 90) {
        label = `scaduta da ${daysSince} gg — possibile lead`; cls = "text-red-600"
      } else {
        label = `scaduta da ${daysSince} gg`; cls = "text-amber-600"
      }
    } else if (d <= 90) {
      label = `rinnovo tra ${d} gg`; cls = "text-red-600"
    } else if (d <= 180) {
      label = `rinnovo tra ${d} gg`; cls = "text-amber-600"
    } else {
      label = `rinnovo tra ${d} gg`; cls = "text-emerald-600"
    }

    return (
      <div>
        <div className="font-medium">{formatDate(l.policyExpiry)}</div>
        {d != null && <div className={cn("text-[10px] font-semibold", cls)}>{label}</div>}
      </div>
    )
  }

  const copyText = async (text: string, label = "Copiato negli appunti") => {
    try { await navigator.clipboard.writeText(text); toast.success(label) }
    catch { toast.error("Impossibile copiare") }
  }

  const callScript = (l: Lead) => {
    const v = verdictOf(l)
    if (v === "PUBLISHED") {
      const exp = l.policyExpiry ? ` Risulta una polizza in scadenza il ${formatDate(l.policyExpiry)}.` : ""
      return `Buongiorno, parlo con ${l.companyName}? Sono [Nome] di [Agenzia], mi occupo di RC sanitaria ai sensi della Legge Gelli.${exp} Posso proporvi un confronto sulle condizioni di rinnovo: spesso otteniamo massimali migliori a parità di premio. Ha due minuti?`
    }
    return `Buongiorno, parlo con ${l.companyName}? Sono [Nome] di [Agenzia]. Ho verificato che sul vostro sito non risulta pubblicata la copertura RC professionale come richiede l'art. 10 della Legge Gelli (L. 24/2017). Posso aiutarvi a mettervi in regola e verificare che massimali e condizioni siano adeguati. Ha due minuti?`
  }

  const scopeReason = (l: Lead) => {
    const r = classifyGelliScope(l.companyName, l.category, l.osmId)
    return r.ok ? r.reason : `Fuori scope: ${r.reason}`
  }

  const KPIS = [
    {
      key: "total",
      label: "Strutture",
      value:
        isScanning && activeScan && regionFilter === activeScan.region && kpi.queueTotal > 0
          ? `${kpi.total} / ${kpi.queueTotal}`
          : kpi.total,
      cls: "",
      icon: Building2,
    },
    { key: "hot", label: "Prioritari Gelli", value: kpi.hot, cls: "text-red-600", icon: ShieldAlert, filter: "HOT" as const },
    { key: "review", label: "Da verificare", value: kpi.review, cls: "text-amber-600", icon: ShieldQuestion, filter: "REVIEW" as const },
    { key: "pub", label: "Polizza pubblicata", value: kpi.pub, cls: "text-emerald-600", icon: ShieldCheck, filter: "PUBLISHED" as const },
  ]

  return (
    <div className="space-y-6">
      {/* HEADER */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span className="brand-gradient grid h-9 w-9 place-items-center rounded-xl text-white">
              <Stethoscope className="h-5 w-5" />
            </span>
            Motore Sanità · Legge Gelli
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Identifica le strutture sanitarie private soggette alla Legge Gelli (art. 10) e verifica
            la pubblicazione della polizza RC sul sito istituzionale.
            Usa <strong>Scansiona</strong> per avviare l&apos;analisi regionale o <strong>Carica salvati</strong> per i risultati già presenti.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={isScanning} className="h-10">
            <Download className="h-4 w-4" /> Esporta CSV
          </Button>
          <Button variant="outline" onClick={() => void fetchLeads()} disabled={isScanning} className="h-10">
            <RefreshCw className="h-4 w-4" /> Carica salvati
          </Button>
          <Button
            onClick={() => startRegionScan("Veneto")}
            disabled={isScanning}
            className="h-10 bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-700 hover:to-violet-700 shadow-md"
          >
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <><Search className="h-4 w-4" /> Scansiona <span className="ml-1 font-bold">Veneto</span></>
            )}
          </Button>
          <Button variant="outline" onClick={() => continueRegionScan("Veneto")} disabled={isScanning} className="h-10">
            Continua Veneto
          </Button>
          <Button variant="outline" onClick={() => resetRegionScan("Veneto")} disabled={isScanning} className="h-10">
            Reset Veneto
          </Button>
          <Button
            onClick={() => startRegionScan("Campania")}
            disabled={isScanning}
            className="h-10 bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-700 hover:to-violet-700 shadow-md"
          >
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <><Search className="h-4 w-4" /> Scansiona <span className="ml-1 font-bold">Campania</span></>
            )}
          </Button>
          <Button variant="outline" onClick={() => continueRegionScan("Campania")} disabled={isScanning} className="h-10">
            Continua Campania
          </Button>
          <Button variant="outline" onClick={() => resetRegionScan("Campania")} disabled={isScanning} className="h-10">
            Reset Campania
          </Button>
        </div>
      </div>

      {/* Stato scansione — sempre chiaro quale regione e quanto manca */}
      {(() => {
        const focusRegion =
          activeScan?.region ??
          (regionFilter !== "ALL" ? regionFilter : null)

        const focus =
          activeScan ??
          (focusRegion
            ? {
                region: focusRegion,
                done: regionStats[focusRegion].done,
                total: regionStats[focusRegion].total,
                round: 0,
                phase: "",
                mapsCityOffset: discoveryMeta[focusRegion]?.mapsCityOffset,
                citiesTotal: discoveryMeta[focusRegion]?.citiesTotal,
                mapsDiscoveryComplete: discoveryMeta[focusRegion]?.mapsDiscoveryComplete,
              }
            : null)

        if (!focus && kpi.total === 0) return null

        const structuresDone = focus ? focus.done >= focus.total && focus.total > 0 : kpi.pending === 0
        const mapsTotal = focus?.citiesTotal ?? discoveryMeta[focus?.region ?? ""]?.citiesTotal ?? 0
        const mapsOffset =
          focus?.mapsCityOffset ?? discoveryMeta[focus?.region ?? ""]?.mapsCityOffset ?? 0
        const mapsDone =
          focus?.mapsDiscoveryComplete ??
          discoveryMeta[focus?.region ?? ""]?.mapsDiscoveryComplete ??
          (mapsTotal > 0 && mapsOffset >= mapsTotal)
        const fullyComplete = structuresDone && (mapsTotal === 0 || mapsDone)
        const structuresOnlyDone = structuresDone && mapsTotal > 0 && !mapsDone

        const structPct = focus && focus.total > 0 ? Math.round((focus.done / focus.total) * 100) : 0
        const mapsPct = mapsTotal > 0 ? Math.round((mapsOffset / mapsTotal) * 100) : 0

        const statusTitle = isScanning
          ? `Scansione ${focus?.region} in corso`
          : fullyComplete
            ? `${focus?.region ?? "Regione"} — scansione territoriale completata`
            : structuresOnlyDone
              ? `${focus?.region} — strutture OK, comuni Maps incompleti`
              : "Stato analisi"

        return (
          <Card
            className={cn(
              "border-border/60",
              isScanning && "border-indigo-300 ring-1 ring-indigo-200",
              structuresOnlyDone && !isScanning && "border-amber-300 ring-1 ring-amber-100"
            )}
          >
            <CardContent className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "rounded-full p-2",
                      isScanning
                        ? "bg-indigo-100"
                        : fullyComplete
                          ? "bg-emerald-100"
                          : structuresOnlyDone
                            ? "bg-amber-100"
                            : "bg-primary/10"
                    )}
                  >
                    {isScanning ? (
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                    ) : fullyComplete ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : structuresOnlyDone ? (
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                    ) : (
                      <FileSearch className="h-4 w-4 text-primary" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{statusTitle}</p>
                    <p className="text-xs text-muted-foreground">
                      {isScanning && focus
                        ? focus.phase
                        : scanProgress ??
                          (focus
                            ? `${focus.region}: ${focus.done}/${focus.total} strutture analizzate`
                            : `${scope.filter((l) => l.lastScannedAt).length}/${scope.length} nel filtro attuale`)}
                    </p>
                    {structuresOnlyDone && !isScanning && focus && (
                      <p className="mt-1 text-[11px] font-medium text-amber-800">
                        Comuni Maps {mapsOffset}/{mapsTotal} — clicca «Continua {focus.region}» per scoprire altre
                        strutture.
                      </p>
                    )}
                    {isScanning && processingName && (
                      <p className="mt-1 text-[10px] font-medium text-indigo-700 animate-pulse">
                        In analisi ora: {processingName}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {focus && focus.total > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                      <span>Strutture analizzate</span>
                      <span>
                        {focus.done} / {focus.total}
                        {structuresDone && !isScanning ? " ✓" : ""}
                      </span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          structuresDone && !isScanning
                            ? "bg-emerald-500"
                            : "bg-gradient-to-r from-indigo-500 to-violet-500"
                        )}
                        style={{ width: `${structPct}%` }}
                      />
                    </div>
                  </div>
                  {mapsTotal > 0 && (
                    <div>
                      <div className="mb-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                        <span>Comuni Maps ({focus.region})</span>
                        <span className={cn(mapsDone && !isScanning && "font-semibold text-emerald-600")}>
                          {mapsOffset} / {mapsTotal}
                          {mapsDone && !isScanning ? " ✓" : ` · ${mapsPct}%`}
                        </span>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            mapsDone && !isScanning
                              ? "bg-emerald-500"
                              : "bg-gradient-to-r from-sky-500 to-blue-600"
                          )}
                          style={{ width: `${mapsPct}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })()}

      {/* Avanzamento regione */}
      {(regionStats.Campania.total > 0 || regionStats.Veneto.total > 0 || isScanning) && (
      <Card className="border-blue-200/60 bg-blue-50/40">
        <CardContent className="p-4 text-sm">
          <p className="font-semibold text-blue-900">Avanzamento per regione</p>
          <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
            {(["Campania", "Veneto"] as const).map((r) => {
              const d = discoveryMeta[r]
              const mapsLabel =
                d && d.citiesTotal > 0
                  ? ` · comuni Maps ${d.mapsCityOffset}/${d.citiesTotal}${d.mapsDiscoveryComplete ? " ✓" : ""}`
                  : ""
              return (
                <span
                  key={r}
                  className="rounded-md border border-emerald-200 bg-white px-2 py-1"
                >
                  {r}: {regionStats[r].done}/{regionStats[r].total}
                  {regionStats[r].pending === 0 && regionStats[r].total > 0
                    ? " strutture ✓"
                    : regionStats[r].total > 0
                      ? ` (${regionStats[r].pending} in coda)`
                      : ""}
                  {mapsLabel}
                </span>
              )
            })}
          </div>
        </CardContent>
      </Card>
      )}

      {/* KPI cliccabili */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {KPIS.map((k) => {
          const active = "filter" in k && verdictFilter === k.filter
          return (
            <button
              key={k.key}
              onClick={() => "filter" in k && setVerdictFilter(active ? "ALL" : k.filter!)}
              className={cn(
                "text-left transition",
                "filter" in k ? "cursor-pointer" : "cursor-default"
              )}
            >
              <Card className={cn("ring-soft border-border/60", active && "ring-2 ring-primary")}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                    <k.icon className={cn("h-4 w-4", k.cls || "text-muted-foreground")} />
                  </div>
                  <div className={cn("mt-2 text-2xl font-bold tabular-nums", k.cls)}>{k.value}</div>
                </CardContent>
              </Card>
            </button>
          )
        })}
      </div>

      {/* TOOLBAR FILTRI */}
      <Card className="ring-soft border-border/60">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca per nome struttura o comune…"
              className="pl-9"
            />
          </div>

          {/* Region segmented */}
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["ALL", "Veneto", "Campania"] as const).map((r) => (
              <button
                key={r}
                onClick={() => { setRegionFilter(r); setSelectedCity(null) }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  regionFilter === r ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r === "ALL" ? "Tutte" : r}
              </button>
            ))}
          </div>

          {/* City combobox */}
          <div className="relative">
            <button
              onClick={() => setCityOpen((o) => !o)}
              className="flex h-9 min-w-[200px] items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 text-sm"
            >
              <span className="flex items-center gap-2 truncate">
                <MapPin className="h-4 w-4 text-primary" />
                {selectedCity ?? "Tutti i comuni"}
              </span>
              {selectedCity && (
                <X
                  className="h-4 w-4 text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); setSelectedCity(null) }}
                />
              )}
            </button>
            {cityOpen && (
              <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-border bg-popover p-2 shadow-lg">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={cityQuery}
                    onChange={(e) => setCityQuery(e.target.value)}
                    placeholder="Filtra comune…"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                <div className="scrollbar-thin max-h-60 overflow-y-auto">
                  {filteredCities.length === 0 ? (
                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">Nessun comune</div>
                  ) : (
                    filteredCities.map(([c, n]) => (
                      <button
                        key={c}
                        onClick={() => { setSelectedCity(c); setCityOpen(false); setCityQuery("") }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                          selectedCity === c && "bg-accent"
                        )}
                      >
                        <span className="truncate">{c}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{n}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Scan città selezionata */}
          <Button
            onClick={() => {
              const region = regionFilter === "ALL"
                ? (scope[0]?.region as "Veneto" | "Campania" | undefined)
                : regionFilter
              if (!selectedCity || !region) {
                toast.info("Seleziona un comune e una regione (Veneto o Campania)")
                return
              }
              void runFullScan({ region, city: selectedCity, continueAnalysis: false })
            }}
            disabled={isScanning || !selectedCity}
            className="h-9"
            variant="secondary"
          >
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Filter className="h-4 w-4" />}
            Scansiona comune
          </Button>
        </CardContent>
      </Card>

      {/* TABELLA */}
      <Card className="ring-soft border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
          ) : filtered.length === 0 ? (
            <div className="m-4 rounded-xl border-2 border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              {isScanning ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
                  <p className="font-medium text-foreground">Scansione in corso</p>
                  <p>I lead compaiono <strong>uno alla volta</strong>, già analizzati (sito, Ministero, portali ASL).</p>
                  {processingName && (
                    <p className="text-xs text-indigo-700">In analisi ora: {processingName}</p>
                  )}
                </div>
              ) : visibleLeads.length === 0
                ? "Tabella vuota. Clicca Scansiona Veneto o Campania — i lead compariranno uno alla volta, in tempo reale."
                : "Nessun risultato per i filtri selezionati."}
            </div>
          ) : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Priorità</th>
                    <th className="px-4 py-3 font-medium">Struttura</th>
                    <th className="px-4 py-3 font-medium">Motivo in lista</th>
                    <th className="px-4 py-3 font-medium">Contatti</th>
                    <th className="px-4 py-3 font-medium">Verdetto Gelli</th>
                    <th className="px-4 py-3 font-medium">Compagnia / Massimale</th>
                    <th className="px-4 py-3 font-medium">Scadenza</th>
                    <th className="px-4 py-3 font-medium">Strategia</th>
                    <th className="px-4 py-3 font-medium">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {isScanning && processingName && (
                    <tr className="border-b border-indigo-200 bg-indigo-50/60">
                      <td colSpan={9} className="px-4 py-3">
                        <div className="flex items-center gap-3 text-sm text-indigo-900">
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                          <div>
                            <span className="font-medium">Analisi in corso — </span>
                            {processingName}
                            <p className="text-[10px] text-indigo-700/80">
                              Maps · sito web · sezione Trasparenza · portali ASL/Ministero
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {filtered.map((l) => (
                    <tr
                      key={l.id}
                      className={cn(
                        "border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors duration-700",
                        freshLeadIds.has(l.id) && "bg-emerald-50/80 ring-1 ring-inset ring-emerald-200"
                      )}
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-col items-start gap-1">
                          <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold tabular-nums", scoreMeta(l.leadScore).cls)}>
                            <Flame className="h-3 w-3" /> {l.leadScore ?? 0}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{scoreMeta(l.leadScore).label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <button onClick={() => setDetail(l)} className="text-left font-medium hover:text-primary hover:underline">{l.companyName}</button>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" />{l.category || "Struttura"}</span>
                          {l.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{l.city}</span>}
                          <Badge variant="outline" className="text-[10px]">{l.region}</Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="max-w-[220px] text-xs text-muted-foreground" title={scopeReason(l)}>
                          {scopeReason(l)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-col gap-1 text-xs">
                          {l.website ? (
                            <a href={l.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <Globe className="h-3 w-3" /> {hostname(l.website)} <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-muted-foreground"><Globe className="h-3 w-3" /> nessun sito</span>
                          )}
                          {l.phone && <a href={`tel:${l.phone}`} className="inline-flex w-fit items-center gap-1 text-foreground hover:text-primary"><Phone className="h-3 w-3" /> {l.phone}</a>}
                          {l.email && <a href={`mailto:${l.email}`} className="inline-flex w-fit items-center gap-1 text-foreground hover:text-primary"><Mail className="h-3 w-3" /> {l.email}</a>}
                          {l.pec && <a href={`mailto:${l.pec}`} title="PEC - posta certificata" className="inline-flex w-fit items-center gap-1 text-violet-700 hover:underline"><Mail className="h-3 w-3" /> {l.pec}<span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700">PEC</span></a>}
                          {l.piva && <button onClick={() => copyText(l.piva!, "P.IVA copiata")} className="inline-flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"><Hash className="h-3 w-3" /> P.IVA {l.piva}<Copy className="h-3 w-3" /></button>}
                          {!l.website && !l.phone && !l.email && !l.pec && <span className="text-muted-foreground">nessun contatto</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                        {verdictBadge(l)}
                        {verdictOf(l) === "REVIEW" && l.lastScannedAt && (
                          <div className="mt-1.5">
                            <button
                              type="button"
                              onClick={() => void rescanOneLead(l)}
                              disabled={isScanning}
                              title={isScanning ? "Disponibile quando finisce la scansione live" : "Rianalizza questa struttura"}
                              className="inline-flex items-center gap-1 rounded-md border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Rianalizza
                            </button>
                            {isScanning && (
                              <div className="mt-0.5 text-[10px] text-amber-800">Attendi fine scansione live</div>
                            )}
                          </div>
                        )}
                        {l.lastScannedAt && verdictOf(l) === "PUBLISHED" && (
                          <div className="mt-1 text-[10px] text-emerald-700">Polizza certificata sul sito</div>
                        )}
                        {parseEvidenceSections(l.evidence).body && (
                          <div className="mt-1 max-w-[260px] truncate text-[10px] text-muted-foreground" title={parseEvidenceSections(l.evidence).body ?? ""}>
                            {parseEvidenceSections(l.evidence).body}
                          </div>
                        )}
                        {verdictOf(l) === "PUBLISHED" && policyDocLinks(l).length === 0 && (
                          <div className="mt-1 text-[10px] font-medium text-amber-700">
                            PDF polizza RC mancante —{" "}
                            <button
                              type="button"
                              onClick={() => void rescanOneLead(l)}
                              disabled={isScanning}
                              className="font-semibold text-primary underline hover:no-underline"
                            >
                              riscansiona
                            </button>
                          </div>
                        )}
                        {verdictOf(l) === "PUBLISHED" && policyDocLinks(l).length === 0 && policyHtmlSource(l) && (
                          <div className="mt-1.5">
                            <a
                              href={policyHtmlSource(l)!}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="flex max-w-[260px] items-center gap-1 text-[10px] text-primary hover:underline"
                            >
                              <FileSearch className="h-3 w-3 shrink-0" />
                              <span className="truncate">Fonte polizza (pagina web)</span>
                              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                            </a>
                          </div>
                        )}
                        {policyDocLinks(l).length > 0 && (
                          <div className="mt-1.5 space-y-0.5">
                            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                              {verdictOf(l) === "PUBLISHED" ? "Fonte polizza" : "Documenti analizzati"}
                            </div>
                            {policyDocLinks(l).slice(0, 3).map((u) => (
                              <a
                                key={u}
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                                title={u}
                                onClick={(e) => e.stopPropagation()}
                                className="flex max-w-[260px] items-center gap-1 text-[10px] text-primary hover:underline"
                              >
                                <FileSearch className="h-3 w-3 shrink-0" />
                                <span className="truncate">{docLabel(u)}</span>
                                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                              </a>
                            ))}
                          </div>
                        )}
                        {parseEvidenceSections(l.evidence).fonti && (
                          <div className="mt-0.5 max-w-[260px] truncate text-[9px] text-slate-500" title={parseEvidenceSections(l.evidence).fonti ?? ""}>
                            {parseEvidenceSections(l.evidence).fonti}
                          </div>
                        )}
                          </div>
                          {l.lastScannedAt && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 shrink-0 gap-1 px-2 text-[10px] font-semibold"
                              title={isScanning ? "Disponibile quando finisce la scansione live" : "Riscansiona questa struttura"}
                              disabled={isScanning}
                              onClick={() => void rescanOneLead(l)}
                            >
                              <RotateCcw className="h-3 w-3" />
                              Rianalizza
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div>
                          {verdictOf(l) === "PUBLISHED" && l.policyCompany ? (
                            l.policyCompany
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                        {verdictOf(l) === "PUBLISHED" && l.policyMassimale && (
                          <div className="text-xs text-muted-foreground">Massimale {l.policyMassimale}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">{expiryCell(l)}</td>
                      <td className="px-4 py-3 align-top">
                        {strategy(l)}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <StatusSelect id={l.id} value={l.status} onChanged={(s) => updateStatus(l.id, s)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* GUIDA RAPIDA */}
      <Card className="border-border/60 bg-gradient-to-br from-blue-50/60 to-indigo-50/40">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-1.5">
              <Info className="h-4 w-4 text-primary" />
            </div>
            <div className="space-y-2 text-sm">
              <p className="font-medium text-foreground">Guida al motore Sanità</p>
              <ol className="ml-4 list-decimal space-y-1.5 text-muted-foreground">
                <li><strong className="text-foreground">Scoperta:</strong> individua case di cura, RSA e poliambulatori su tutto il territorio regionale, integrando l&apos;elenco ufficiale del Ministero della Salute.</li>
                <li><strong className="text-foreground">Verifica:</strong> analizza il sito web di ogni struttura, con focus sulla sezione Trasparenza e sui documenti PDF allegati.</li>
                <li><strong className="text-foreground">Classificazione:</strong>
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700"><ShieldAlert className="h-3 w-3" />Irregolare Gelli</span> — polizza RC non pubblicata sulle fonti verificate; priorità commerciale
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700"><ShieldCheck className="h-3 w-3" />In regola</span> — polizza trovata; opportunità rinnovo o confronto
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700"><ShieldQuestion className="h-3 w-3" />Da verificare</span> — esito non conclusivo; controllo manuale consigliato
                </li>
              </ol>
              <p className="text-xs text-muted-foreground">Clicca il nome della struttura per aprire la scheda con contatti, note e promemoria.</p>
              <p className="text-xs text-amber-700">I risultati si basano sui siti web ufficiali delle strutture. In caso di sito non aggiornato o documentazione incompleta, lo stato &quot;Da verificare&quot; segnala la necessità di un controllo diretto.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        I lead prioritari sono strutture verificate su sito (sezione Trasparenza) e/o portali ASL/regionali senza pubblicazione polizza. Ogni scheda riporta le fonti controllate. Non sostituisce il registro imprese né ogni possibile canale legale.
      </p>

      {detail && (
        <LeadDetail
          lead={detail}
          callScript={null}
          onClose={() => setDetail(null)}
          onUpdated={applyPatch}
        />
      )}
    </div>
  )
}
