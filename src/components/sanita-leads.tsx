"use client"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Stethoscope, Search, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion,
  RefreshCw, Download, FileSearch, ExternalLink, Clock, HelpCircle,
  Play, Pause, RotateCcw, Repeat,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { deriveVerdict } from "@/lib/sanita/verdict"
import {
  isHotPublishedExpiredEvidence,
  expiredDaysFromEvidence,
  policyPdfUrlsForLead,
  policyHtmlSourceForLead,
} from "@/lib/sanita/audit"
import { downloadCsv } from "@/lib/export-csv"
import { StatusSelect } from "@/components/status-select"
import { LeadDetail } from "@/components/lead-detail"
import { cn } from "@/lib/utils"
import { readProcessingState, readBusinessVerdict } from "@/lib/sanita/processing-state"
import { isInActionableSalesQueue } from "@/lib/sanita/actionable-queue"

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

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
  semantic?: {
    actionable?: boolean
    processingState?: string | null
    businessVerdict?: string | null
    queueStatus?: string
  } | null
  _actionable?: boolean
  _legacy?: boolean
  _queueStatus?: string
}

type ShadowResult = {
  leadId: string
  companyName: string | null
  city: string | null
  region: string | null
  processingState: string | null
  businessVerdict: string | null
  publishedSubtype: "policy_valid" | "policy_expired" | "date_unknown" | "self_insurance" | null
  policyCompany: string | null
  policyNumber: string | null
  policyExpiry: string | null
  policyFound: boolean | null
  evidence: string
  evidenceUrls: string[]
  pdfHash: string | null
  completedAt: string | null
  appliedLive: false
  frontierComplete: boolean | null
  unresolvedRelevantNodes: number | null
}

type ResultsMeta = {
  runStartedAt: string | null
  runLabel: string | null
  checkpointUpdatedAt: string | null
  total: number
  runTotal: number
}

type ArchiveRevalidationStatus = {
  available?: boolean
  active?: boolean
  statusLabel?: string
  targetTotal?: number
  percent?: number
  updatedAt?: string | null
  recordsTouched?: number
  terminalCompleted?: number
  currentlyInProgress?: number
  currentRetryQueue?: number
  reviewCurrent?: number
  certifiedCurrentRun?: number
  hot?: number
  published?: number
}

type SanitaApiMeta = {
  actionableCount?: number
  dbTotal?: number
}

type RevalidationControlState = {
  active?: boolean
  checkpointExists?: boolean
  retryQueueCount?: number
  job?: { status?: string; mode?: string; startedAt?: string | null } | null
}

// ---------------------------------------------------------------------------
// Stato filtri — UNICA sorgente di verità, persistita in URL.
// Nessun polling/hydrate/API può modificare questi valori (bug storico:
// setRegionFilter(job.region) forzava Campania a ogni poll — rimosso strutturalmente).
// ---------------------------------------------------------------------------

type TabKey = "run" | "live" | "review" | "archive"
type OutcomeKey = "ALL" | "policy_valid" | "policy_expired" | "date_unknown" | "self_insurance" | "hot" | "review"
type RegionKey = "ALL" | "Campania" | "Veneto"

type Filters = {
  tab: TabKey
  region: RegionKey
  city: string
  outcome: OutcomeKey
  query: string
}

const DEFAULT_FILTERS: Filters = { tab: "run", region: "ALL", city: "", outcome: "ALL", query: "" }

function readFiltersFromUrl(): Filters {
  if (typeof window === "undefined") return DEFAULT_FILTERS
  const sp = new URLSearchParams(window.location.search)
  const tab = sp.get("tab")
  const region = sp.get("region")
  const outcome = sp.get("outcome")
  return {
    tab: tab === "live" || tab === "review" || tab === "archive" || tab === "run" ? tab : "run",
    region: region === "Campania" || region === "Veneto" ? region : "ALL",
    city: sp.get("city") || "",
    outcome:
      outcome === "policy_valid" || outcome === "policy_expired" || outcome === "date_unknown" ||
      outcome === "self_insurance" || outcome === "hot" || outcome === "review"
        ? outcome
        : "ALL",
    query: sp.get("q") || "",
  }
}

function filtersToSearch(f: Filters): string {
  const sp = new URLSearchParams()
  if (f.tab !== "run") sp.set("tab", f.tab)
  if (f.region !== "ALL") sp.set("region", f.region)
  if (f.city) sp.set("city", f.city)
  if (f.outcome !== "ALL") sp.set("outcome", f.outcome)
  if (f.query) sp.set("q", f.query)
  const s = sp.toString()
  return s ? `?${s}` : ""
}

// ---------------------------------------------------------------------------
// Normalizzazione righe (live + shadow → stessa shape per tabella/filtri/CSV)
// ---------------------------------------------------------------------------

type UiOutcome = Exclude<OutcomeKey, "ALL"> | "pending"

type UiRow = {
  id: string
  companyName: string
  city: string | null
  region: string | null
  outcome: UiOutcome
  policyCompany: string | null
  policyNumber: string | null
  policyExpiry: string | null
  evidenceUrls: string[]
  completedAt: string | null
  processingState: string | null
  unresolvedRelevantNodes: number | null
  live?: Lead
  shadow?: ShadowResult
}

const OUTCOME_META: Record<UiOutcome, { label: string; cls: string; icon: typeof ShieldCheck }> = {
  policy_valid: { label: "Polizza valida", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: ShieldCheck },
  policy_expired: { label: "Polizza scaduta", cls: "bg-red-50 text-red-700 border-red-200", icon: ShieldAlert },
  date_unknown: { label: "Scadenza sconosciuta", cls: "bg-slate-100 text-slate-700 border-slate-200", icon: HelpCircle },
  self_insurance: { label: "Autoassicurazione dichiarata", cls: "bg-teal-50 text-teal-800 border-teal-200", icon: ShieldCheck },
  hot: { label: "HOT verificato", cls: "bg-sky-50 text-sky-800 border-sky-200", icon: ShieldAlert },
  review: { label: "Da controllare", cls: "bg-amber-50 text-amber-800 border-amber-200", icon: ShieldQuestion },
  pending: { label: "In lavorazione", cls: "bg-gray-50 text-gray-600 border-gray-200", icon: Clock },
}

function liveOutcome(l: Lead): UiOutcome {
  const ps = readProcessingState(l.evidence) || l.semantic?.processingState
  const bv = readBusinessVerdict(l.evidence) || l.semantic?.businessVerdict
  if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") return "policy_valid"
  if (ps === "SELF_INSURANCE_VERIFIED" || bv === "SELF_INSURANCE_VERIFIED") return "self_insurance"
  if (ps === "PUBLISHED_ANALOGOUS_MEASURE" || bv === "PUBLISHED_ANALOGOUS_MEASURE") return "policy_valid"
  if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") return "policy_expired"
  if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") return "date_unknown"
  if (ps === "HOT_VERIFIED" || bv === "HOT_VERIFIED") return "hot"
  if (ps === "REVIEW_HUMAN" || bv === "REVIEW_HUMAN") return "review"
  // legacy baseline: "pubblicata ma scaduta" si classifica come scaduta
  if (isHotPublishedExpiredEvidence(l.evidence)) return "policy_expired"
  const v = deriveVerdict({
    lastScannedAt: l.lastScannedAt,
    policyFound: l.policyFound,
    websiteReachable: l.websiteReachable,
    website: l.website,
    evidence: l.evidence,
  })
  if (v === "PUBLISHED") return "date_unknown"
  if (v === "HOT") return "hot"
  if (v === "REVIEW") return "review"
  return "pending"
}

function liveToRow(l: Lead): UiRow {
  const urls = [...policyPdfUrlsForLead(l.evidence)]
  const html = policyHtmlSourceForLead(l.evidence)
  if (html && !urls.includes(html)) urls.push(html)
  return {
    id: l.id,
    companyName: l.companyName,
    city: l.city,
    region: l.region,
    outcome: liveOutcome(l),
    policyCompany: l.policyCompany,
    policyNumber: l.policyNumber,
    policyExpiry: l.policyExpiry,
    evidenceUrls: urls,
    completedAt: l.lastScannedAt,
    processingState: readProcessingState(l.evidence) || l.semantic?.processingState || null,
    unresolvedRelevantNodes: null,
    live: l,
  }
}

function shadowToRow(s: ShadowResult): UiRow {
  const outcome: UiOutcome =
    s.publishedSubtype ??
    (s.processingState === "SELF_INSURANCE_VERIFIED"
      ? "self_insurance"
      : s.processingState === "HOT_VERIFIED"
        ? "hot"
        : s.processingState === "REVIEW_HUMAN"
          ? "review"
          : "pending")
  return {
    id: s.leadId,
    companyName: s.companyName || s.leadId,
    city: s.city,
    region: s.region,
    outcome,
    policyCompany: s.policyCompany,
    policyNumber: s.policyNumber,
    policyExpiry: s.policyExpiry,
    evidenceUrls: s.evidenceUrls || [],
    completedAt: s.completedAt,
    processingState: s.processingState,
    unresolvedRelevantNodes: s.unresolvedRelevantNodes,
    shadow: s,
  }
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

const TABS: { key: TabKey; label: string; testid: string }[] = [
  { key: "run", label: "Nuovi risultati", testid: "tab-run-results" },
  { key: "live", label: "Tutti i certificati", testid: "tab-live-queue" },
  { key: "review", label: "In lavorazione", testid: "tab-review" },
  { key: "archive", label: "Archivio completo", testid: "tab-archive" },
]

const OUTCOME_OPTIONS: { key: OutcomeKey; label: string }[] = [
  { key: "ALL", label: "Tutti gli esiti" },
  { key: "policy_valid", label: "Polizza valida" },
  { key: "policy_expired", label: "Polizza scaduta" },
  { key: "date_unknown", label: "Scadenza sconosciuta" },
  { key: "self_insurance", label: "Autoassicurata" },
  { key: "hot", label: "HOT verificato" },
  { key: "review", label: "Da controllare" },
]

export function SanitaLeads() {
  const [filters, setFilters] = useState<Filters>(readFiltersFromUrl)
  const [liveLeads, setLiveLeads] = useState<Lead[]>([])
  const [apiMeta, setApiMeta] = useState<SanitaApiMeta | null>(null)
  const [archiveStatus, setArchiveStatus] = useState<ArchiveRevalidationStatus | null>(null)
  const [controlState, setControlState] = useState<RevalidationControlState | null>(null)
  const [controlBusy, setControlBusy] = useState<string | null>(null)
  const [runResults, setRunResults] = useState<ShadowResult[]>([])
  const [reviewResults, setReviewResults] = useState<ShadowResult[]>([])
  const [resultsMeta, setResultsMeta] = useState<ResultsMeta | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [detail, setDetail] = useState<Lead | null>(null)
  const [shadowDetail, setShadowDetail] = useState<ShadowResult | null>(null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  // ---- persistenza filtri in URL (replaceState, nessuna navigazione) ----
  useEffect(() => {
    const search = filtersToSearch(filters)
    const url = `${window.location.pathname}${search}`
    window.history.replaceState(null, "", url)
  }, [filters])

  const setFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  // ---- fetcher: aggiornano SOLO dati, mai i filtri ----
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch("/api/sanita?includePending=1&includeAll=1", { cache: "no-store" })
      const json = await res.json()
      if (json?.success) {
        setLiveLeads(json.data || [])
        setApiMeta(json.meta || null)
      }
    } catch {
      /* rete: conservo i dati esistenti */
    }
  }, [])

  const fetchArchiveStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sanita/archive-revalidation", { cache: "no-store" })
      const json = await res.json()
      if (json?.success) setArchiveStatus(json)
    } catch {
      /* conserva */
    }
  }, [])

  const fetchControlState = useCallback(async () => {
    try {
      const res = await fetch("/api/sanita/archive-revalidation/control", { cache: "no-store" })
      const json = await res.json()
      if (json?.success) setControlState(json)
    } catch {
      /* conserva */
    }
  }, [])

  const runControlAction = useCallback(
    async (action: "start" | "pause" | "resume" | "retry-incomplete") => {
      setControlBusy(action)
      try {
        await fetch("/api/sanita/archive-revalidation/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        })
      } catch {
        /* errore rete: il polling successivo riallinea lo stato */
      } finally {
        setControlBusy(null)
        fetchControlState()
        fetchArchiveStatus()
      }
    },
    [fetchControlState, fetchArchiveStatus]
  )

  const fetchRunResults = useCallback(async () => {
    try {
      const res = await fetch("/api/sanita/archive-revalidation/results?scope=run", { cache: "no-store" })
      const json = await res.json()
      if (json?.success) {
        setRunResults(json.results || [])
        setResultsMeta(json.meta || null)
      }
    } catch {
      /* conserva */
    }
  }, [])

  const fetchReviewResults = useCallback(async () => {
    try {
      const res = await fetch(
        "/api/sanita/archive-revalidation/results?scope=working&limit=500",
        { cache: "no-store" }
      )
      const json = await res.json()
      if (json?.success) setReviewResults(json.results || [])
    } catch {
      /* conserva */
    }
  }, [])

  // boot
  useEffect(() => {
    let alive = true
    ;(async () => {
      await Promise.all([fetchLive(), fetchArchiveStatus(), fetchControlState(), fetchRunResults()])
      if (alive) setIsLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [fetchLive, fetchArchiveStatus, fetchControlState, fetchRunResults])

  // polling 5s: card rivalidazione sempre; risultati run solo quando la tab li mostra
  useEffect(() => {
    const t = setInterval(() => {
      fetchArchiveStatus()
      fetchControlState()
      if (filtersRef.current.tab === "run") fetchRunResults()
    }, 5000)
    return () => clearInterval(t)
  }, [fetchArchiveStatus, fetchControlState, fetchRunResults])

  // fetch on-demand quando si entra nelle tab
  useEffect(() => {
    if (filters.tab === "run") fetchRunResults()
    else if (filters.tab === "review") fetchReviewResults()
    else fetchLive()
  }, [filters.tab, fetchRunResults, fetchReviewResults, fetchLive])

  const refreshActive = useCallback(() => {
    fetchArchiveStatus()
    if (filtersRef.current.tab === "run") return fetchRunResults()
    if (filtersRef.current.tab === "review") return fetchReviewResults()
    return fetchLive()
  }, [fetchArchiveStatus, fetchRunResults, fetchReviewResults, fetchLive])

  // ---- righe della tab attiva ----
  const isLeadActionable = (l: Lead) =>
    Boolean(l.semantic?.actionable ?? l._actionable ?? isInActionableSalesQueue(l))

  const tabRows = useMemo((): UiRow[] => {
    let rows: UiRow[]
    if (filters.tab === "run") rows = runResults.map(shadowToRow)
    else if (filters.tab === "review") rows = reviewResults.map(shadowToRow)
    else if (filters.tab === "live") rows = liveLeads.filter(isLeadActionable).map(liveToRow)
    else rows = liveLeads.map(liveToRow)

    return rows.filter((r) => {
      if (filters.region !== "ALL" && r.region !== filters.region) return false
      if (filters.outcome !== "ALL" && r.outcome !== filters.outcome) return false
      if (filters.city && !(r.city || "").toLowerCase().includes(filters.city.toLowerCase())) return false
      if (filters.query) {
        const q = filters.query.toLowerCase()
        if (
          !(r.companyName || "").toLowerCase().includes(q) &&
          !(r.city || "").toLowerCase().includes(q)
        )
          return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, runResults, reviewResults, liveLeads])

  const exportCsv = () => {
    const CERTIFIED = new Set(["policy_valid", "policy_expired", "date_unknown", "self_insurance", "hot"])
    const rows = tabRows.filter((r) => CERTIFIED.has(r.outcome))
    downloadCsv(
      `sanita-${filters.tab}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows.map((r) => ({
        Struttura: r.companyName,
        Città: r.city || "",
        Regione: r.region || "",
        Esito: OUTCOME_META[r.outcome].label,
        Compagnia: r.policyCompany || "",
        Numero: r.policyNumber || "",
        Scadenza: r.policyExpiry || "",
        Fonte: r.shadow ? "nuovo run (shadow)" : "live",
        CompletataIl: r.completedAt || "",
        EvidenceURL: r.evidenceUrls.join(" "),
      }))
    )
  }

  const docLabel = (url: string) => {
    try {
      const name = new URL(url).pathname.split("/").pop() || url
      const decoded = decodeURIComponent(name)
      return decoded.length > 40 ? `${decoded.slice(0, 37)}…` : decoded
    } catch {
      return url.length > 40 ? `${url.slice(0, 37)}…` : url
    }
  }

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—"
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return "—"
    return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  }

  const terminal = archiveStatus?.terminalCompleted ?? 0
  const target = archiveStatus?.targetTotal ?? 877
  const percent = target > 0 ? Math.min(100, Math.round((terminal / target) * 1000) / 10) : 0
  const engineRunning = Boolean(controlState?.active)
  const retryCount = controlState?.retryQueueCount ?? archiveStatus?.currentRetryQueue ?? 0

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Stethoscope className="h-5 w-5 text-primary" />
          Verifica polizze sanitarie
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="header-kpi">
          Archivio: {apiMeta?.dbTotal ?? "…"} · Verifiche concluse: {terminal} / {target} · Lead
          live: {apiMeta?.actionableCount ?? "…"} · Nuovi risultati del run:{" "}
          {resultsMeta?.runTotal ?? "…"}
        </p>
      </div>

      {/* UNA SOLA CARD rivalidazione */}
      <Card data-testid="revalidation-panel">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">
              {archiveStatus?.statusLabel || "Rivalidazione in corso"}
            </div>
            <div className="text-xs text-muted-foreground">
              {archiveStatus?.updatedAt ? `aggiornato ${fmtDate(archiveStatus.updatedAt)}` : ""}
            </div>
          </div>
          <div className="text-sm">
            {terminal} di {target} concluse
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
              data-testid="progress-bar"
            />
          </div>
          <div className="text-sm" data-testid="run-counters">
            Run corrente: {archiveStatus?.published ?? 0} Published · {archiveStatus?.hot ?? 0} HOT
            · {archiveStatus?.reviewCurrent ?? 0} da controllare ·{" "}
            {(archiveStatus?.currentlyInProgress ?? 0) + (archiveStatus?.currentRetryQueue ?? 0)}{" "}
            ancora in lavorazione
          </div>
          <div className="text-xs text-muted-foreground">
            prese in carico {archiveStatus?.recordsTouched ?? 0} · in corso{" "}
            {archiveStatus?.currentlyInProgress ?? 0} · retry {archiveStatus?.currentRetryQueue ?? 0}
          </div>
          <div className="flex flex-wrap gap-2 pt-1" data-testid="revalidation-controls">
            <Button
              variant="outline"
              size="sm"
              data-testid="btn-start"
              disabled={engineRunning || controlBusy !== null}
              onClick={() => runControlAction("start")}
            >
              {controlBusy === "start" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Avvia scansione
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="btn-pause"
              disabled={!engineRunning || controlBusy !== null}
              onClick={() => runControlAction("pause")}
            >
              {controlBusy === "pause" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Pause className="mr-1 h-4 w-4" />
              )}
              Pausa
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="btn-resume"
              disabled={engineRunning || controlBusy !== null || !controlState?.checkpointExists}
              onClick={() => runControlAction("resume")}
            >
              {controlBusy === "resume" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-1 h-4 w-4" />
              )}
              Riprendi
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="btn-retry-incomplete"
              disabled={engineRunning || controlBusy !== null || retryCount === 0}
              onClick={() => runControlAction("retry-incomplete")}
            >
              {controlBusy === "retry-incomplete" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Repeat className="mr-1 h-4 w-4" />
              )}
              Riprova incompleti
            </Button>
            <Button variant="outline" size="sm" data-testid="btn-export" onClick={exportCsv}>
              <Download className="mr-1 h-4 w-4" />
              Esporta
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* TAB */}
      <div className="flex flex-wrap gap-1 border-b" data-testid="main-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={filters.tab === t.key}
            data-testid={t.testid}
            onClick={() => setFilter("tab", t.key)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              filters.tab === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* FILTER BAR */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid="region-filter"
          value={filters.region}
          onChange={(e) => setFilter("region", e.target.value as RegionKey)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="ALL">Tutte le regioni</option>
          <option value="Campania">Campania</option>
          <option value="Veneto">Veneto</option>
        </select>
        <select
          data-testid="outcome-filter"
          value={filters.outcome}
          onChange={(e) => setFilter("outcome", e.target.value as OutcomeKey)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {OUTCOME_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <Input
          data-testid="city-filter"
          value={filters.city}
          onChange={(e) => setFilter("city", e.target.value)}
          placeholder="Città"
          className="h-9 w-36"
        />
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="search-input"
            value={filters.query}
            onChange={(e) => setFilter("query", e.target.value)}
            placeholder="Cerca struttura…"
            className="h-9 w-56 pl-8"
          />
        </div>
        <span className="text-sm text-muted-foreground" data-testid="results-count">
          {tabRows.length} risultati
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refreshActive()} data-testid="refresh-btn">
            <RefreshCw className="mr-1 h-4 w-4" />
            Aggiorna
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="export-csv-btn">
            <Download className="mr-1 h-4 w-4" />
            Esporta CSV
          </Button>
        </div>
      </div>

      {/* TABELLA */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Caricamento…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="leads-table">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Struttura</th>
                <th className="px-3 py-2 font-medium">Località</th>
                <th className="px-3 py-2 font-medium">Esito verifica</th>
                <th className="px-3 py-2 font-medium">Polizza</th>
                <th className="px-3 py-2 font-medium">Evidence</th>
                <th className="px-3 py-2 font-medium">Completata il</th>
                {filters.tab !== "run" && filters.tab !== "review" && (
                  <th className="px-3 py-2 font-medium">Stato CRM</th>
                )}
              </tr>
            </thead>
            <tbody>
              {tabRows.map((r) => {
                const meta = OUTCOME_META[r.outcome]
                const Icon = meta.icon
                return (
                  <tr
                    key={`${r.shadow ? "s" : "l"}-${r.id}`}
                    data-testid="lead-row"
                    data-region={r.region || ""}
                    data-outcome={r.outcome}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                    onClick={() => (r.live ? setDetail(r.live) : r.shadow ? setShadowDetail(r.shadow) : null)}
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <div className="truncate font-medium" title={r.companyName}>
                        {r.companyName}
                      </div>
                      {r.shadow && (
                        <div className="text-[10px] text-muted-foreground">nuovo run · shadow</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="row-locality">
                      {r.city || "—"}
                      {r.region ? <span className="text-muted-foreground"> · {r.region}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn("gap-1", meta.cls)} data-testid="outcome-badge">
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </Badge>
                      {r.unresolvedRelevantNodes != null && r.unresolvedRelevantNodes > 0 && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {r.unresolvedRelevantNodes} nodi da risolvere
                        </div>
                      )}
                    </td>
                    <td className="max-w-[220px] px-3 py-2 text-xs">
                      {r.policyCompany ? (
                        <div className="truncate font-medium" title={r.policyCompany}>
                          {r.policyCompany}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.policyNumber && (
                        <div className="text-[10px] text-muted-foreground">N. {r.policyNumber}</div>
                      )}
                      {r.policyExpiry && <div className="text-[10px]">Scad. {r.policyExpiry}</div>}
                    </td>
                    <td className="max-w-[180px] px-3 py-2">
                      {r.evidenceUrls.length ? (
                        <div className="space-y-0.5">
                          {r.evidenceUrls.slice(0, 2).map((u) => (
                            <a
                              key={u}
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              title={u}
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                            >
                              <FileSearch className="h-3 w-3 shrink-0" />
                              <span className="truncate">{docLabel(u)}</span>
                              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.completedAt)}</td>
                    {filters.tab !== "run" && filters.tab !== "review" && r.live && (
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <StatusSelect
                          id={r.live.id}
                          value={r.live.status}
                          onChanged={(s) =>
                            setLiveLeads((prev) =>
                              prev.map((x) => (x.id === r.live!.id ? { ...x, status: s } : x))
                            )
                          }
                        />
                      </td>
                    )}
                    {filters.tab !== "run" && filters.tab !== "review" && !r.live && <td />}
                  </tr>
                )
              })}
              {tabRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    Nessun risultato con i filtri correnti.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Dettaglio lead live (drawer esistente) */}
      {detail && (
        <LeadDetail
          lead={detail}
          callScript={null}
          onClose={() => setDetail(null)}
          onUpdated={(patch) => {
            setLiveLeads((prev) => prev.map((x) => (x.id === detail.id ? { ...x, ...patch } : x)))
            setDetail((d) => (d ? { ...d, ...patch } : d))
          }}
        />
      )}

      {/* Dettaglio risultato shadow (read-only) */}
      <Dialog open={Boolean(shadowDetail)} onOpenChange={(o) => !o && setShadowDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{shadowDetail?.companyName || shadowDetail?.leadId}</DialogTitle>
          </DialogHeader>
          {shadowDetail && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className={cn("gap-1", OUTCOME_META[shadowToRow(shadowDetail).outcome].cls)}>
                  {OUTCOME_META[shadowToRow(shadowDetail).outcome].label}
                </Badge>
                {shadowDetail.processingState === "SELF_INSURANCE_VERIFIED" && (
                  <span className="text-xs text-muted-foreground">
                    Gestione diretta del rischio — documento ufficiale
                  </span>
                )}
                <Badge variant="outline">{shadowDetail.processingState || "—"}</Badge>
                {shadowDetail.pdfHash && (
                  <Badge variant="outline" title={shadowDetail.pdfHash}>
                    PDF sha256 {shadowDetail.pdfHash.slice(0, 12)}…
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div>Città: {shadowDetail.city || "—"}</div>
                <div>Regione: {shadowDetail.region || "—"}</div>
                <div>Compagnia: {shadowDetail.policyCompany || "—"}</div>
                <div>Numero: {shadowDetail.policyNumber || "—"}</div>
                <div>Scadenza: {shadowDetail.policyExpiry || "—"}</div>
                <div>Completata: {fmtDate(shadowDetail.completedAt)}</div>
                <div>
                  Frontier:{" "}
                  {shadowDetail.frontierComplete == null
                    ? "—"
                    : shadowDetail.frontierComplete
                      ? "completa"
                      : `incompleta (${shadowDetail.unresolvedRelevantNodes ?? "?"} nodi)`}
                </div>
                <div>Applicato al live: {shadowDetail.appliedLive ? "sì" : "no (shadow)"}</div>
              </div>
              {shadowDetail.evidenceUrls.length > 0 && (
                <div className="space-y-1">
                  {shadowDetail.evidenceUrls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <FileSearch className="h-3 w-3" /> {docLabel(u)}
                      <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                    </a>
                  ))}
                </div>
              )}
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-[11px] leading-snug">
                {shadowDetail.evidence || "Nessuna evidence testuale."}
              </pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
