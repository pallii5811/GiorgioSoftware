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
import { deriveVerdict, readVerdictToken } from "@/lib/sanita/verdict"
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
    verdictToken?: string | null
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
  website?: string | null
  phone?: string | null
  email?: string | null
  pec?: string | null
  piva?: string | null
  category?: string | null
  crmStatus?: string | null
  notes?: string | null
  sourcePdfUrl?: string | null
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
  selfInsurance?: number
  otherNonCommercialTerminal?: number
  technicalBlockedFinal?: number
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

const DEFAULT_FILTERS: Filters = { tab: "archive", region: "ALL", city: "", outcome: "ALL", query: "" }

function readFiltersFromUrl(): Filters {
  if (typeof window === "undefined") return DEFAULT_FILTERS
  const sp = new URLSearchParams(window.location.search)
  const tab = sp.get("tab")
  const region = sp.get("region")
  const outcome = sp.get("outcome")
  return {
    // Sempre esplicito: default archivio legacy (non confondere con Nuovi risultati).
    tab: tab === "live" || tab === "review" || tab === "archive" || tab === "run" ? tab : "archive",
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
  // Tab sempre in URL → coerenza tab=… / dati / badge.
  sp.set("tab", f.tab)
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
  source: "SHADOW_RUN" | "LEGACY_LIVE"
  revalStatus?: "not_started" | "in_progress" | "completed" | "review" | "retry"
  live?: Lead
  shadow?: ShadowResult
  website?: string | null
  phone?: string | null
  email?: string | null
  pec?: string | null
  piva?: string | null
  category?: string | null
  crmStatus?: string | null
  notes?: string | null
  pdfHash?: string | null
  sourcePdfUrl?: string | null
  legacyEvidence?: string | null
}

const OUTCOME_META: Record<UiOutcome, { label: string; cls: string; icon: typeof ShieldCheck }> = {
  policy_valid: { label: "Polizza valida", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: ShieldCheck },
  policy_expired: { label: "Polizza scaduta", cls: "bg-red-50 text-red-700 border-red-200", icon: ShieldAlert },
  date_unknown: { label: "Scadenza da verificare", cls: "bg-slate-100 text-slate-700 border-slate-200", icon: HelpCircle },
  self_insurance: { label: "Autoassicurazione dichiarata", cls: "bg-teal-50 text-teal-800 border-teal-200", icon: ShieldCheck },
  hot: { label: "HOT verificato", cls: "bg-sky-50 text-sky-800 border-sky-200", icon: ShieldAlert },
  review: { label: "Da controllare", cls: "bg-amber-50 text-amber-800 border-amber-200", icon: ShieldQuestion },
  pending: { label: "In lavorazione", cls: "bg-gray-50 text-gray-600 border-gray-200", icon: Clock },
}

/** Scadenza ISO/DB verificabile e strettamente futura (UTC day). */
function expiryIsFuture(raw: string | Date | null | undefined): boolean | null {
  if (!raw) return null
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const b = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (a > b) return true
  if (a < b) return false
  return true // stessa giornata → ancora valida
}

function hasExplicitSelfInsuranceDeclaration(evidence: string | null | undefined): boolean {
  if (!evidence) return false
  return (
    /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(evidence) ||
    /adotta\s+un\s+sistema\s+di\s+autoassicurazione/i.test(evidence) ||
    /dichiar(?:a|azione)\s+di\s+autoassicurazione/i.test(evidence) ||
    /gestione\s+diretta\s+del\s+rischio/i.test(evidence) ||
    /autoritenzione/i.test(evidence) ||
    /fondo\s+interno\s+(?:di\s+)?(?:rischi|autoassicurazione)/i.test(evidence)
  )
}

/**
 * Classificazione LEGACY (snapshot pre-motore K3).
 * Non spacciare [V:PUB] grezzo come "Polizza valida" K3.
 */
function liveOutcome(l: Lead): UiOutcome {
  const ps = readProcessingState(l.evidence) || l.semantic?.processingState
  const bv = readBusinessVerdict(l.evidence) || l.semantic?.businessVerdict
  // Stati già rivalidati K3 (se presenti sull'evidence live)
  if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") return "policy_valid"
  if (ps === "SELF_INSURANCE_VERIFIED" || bv === "SELF_INSURANCE_VERIFIED") return "self_insurance"
  if (ps === "PUBLISHED_ANALOGOUS_MEASURE" || bv === "PUBLISHED_ANALOGOUS_MEASURE") return "policy_valid"
  if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") return "policy_expired"
  if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") return "date_unknown"
  if (ps === "HOT_VERIFIED" || bv === "HOT_VERIFIED") return "hot"
  if (ps === "REVIEW_HUMAN" || bv === "REVIEW_HUMAN") return "review"

  if (hasExplicitSelfInsuranceDeclaration(l.evidence)) return "self_insurance"
  if (isHotPublishedExpiredEvidence(l.evidence)) return "policy_expired"

  const token =
    readVerdictToken(l.evidence) ||
    deriveVerdict({
      lastScannedAt: l.lastScannedAt,
      policyFound: l.policyFound,
      websiteReachable: l.websiteReachable,
      website: l.website,
      evidence: l.evidence,
    })

  if (token === "HOT") return "hot"
  if (token === "REVIEW") return "review"
  if (token === "PUBLISHED") {
    const fut = expiryIsFuture(l.policyExpiry)
    if (fut === true) return "policy_valid"
    if (fut === false) return "policy_expired"
    return "date_unknown"
  }
  return "pending"
}

function isLegacyCommercialRow(l: Lead): boolean {
  const o = liveOutcome(l)
  return (
    o === "policy_valid" ||
    o === "policy_expired" ||
    o === "date_unknown" ||
    o === "self_insurance" ||
    o === "hot"
  )
}

function outcomeLabelForRow(r: UiRow): string {
  if (r.source === "LEGACY_LIVE" && r.outcome === "hot") return "HOT legacy — da rivalidare"
  if (r.source === "LEGACY_LIVE" && r.outcome === "date_unknown") return "Scadenza da verificare"
  return OUTCOME_META[r.outcome].label
}

function sourceLabelForRow(r: UiRow): string {
  return r.source === "SHADOW_RUN" ? "Nuovo motore" : "Legacy — snapshot 18 luglio"
}

/** @deprecated kept name for call sites — HOT/PUB legacy commercial-ish */
function isLegacyScannedCert(l: Lead): boolean {
  return isLegacyCommercialRow(l)
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
    source: "LEGACY_LIVE",
    revalStatus: "not_started",
    live: l,
    website: l.website,
    phone: l.phone,
    email: l.email,
    pec: l.pec,
    piva: l.piva,
    category: l.category,
    crmStatus: l.status,
    notes: l.notes,
    legacyEvidence: l.evidence,
  }
}

function pickContact(shadowVal: string | null | undefined, liveVal: string | null | undefined) {
  const clean = (v: string | null | undefined) => {
    if (!v) return null
    let s = v.trim()
    if (s.startsWith("//")) s = s.slice(2)
    return s || null
  }
  return clean(shadowVal) || clean(liveVal) || null
}

function shadowToRow(s: ShadowResult, live?: Lead | null): UiRow {
  const outcome: UiOutcome =
    s.publishedSubtype ??
    (s.processingState === "SELF_INSURANCE_VERIFIED"
      ? "self_insurance"
      : s.processingState === "HOT_VERIFIED"
        ? "hot"
        : s.processingState === "REVIEW_HUMAN"
          ? "review"
          : "pending")
  const revalStatus: UiRow["revalStatus"] =
    s.processingState === "REVIEW_HUMAN"
      ? "review"
      : s.processingState === "RETRY_PENDING"
        ? "retry"
        : s.completedAt
          ? "completed"
          : "in_progress"
  const website = pickContact(s.website, live?.website)
  const phone = pickContact(s.phone, live?.phone)
  const email = pickContact(s.email, live?.email)
  const pec = pickContact(s.pec, live?.pec)
  const piva = pickContact(s.piva, live?.piva)
  return {
    id: s.leadId,
    companyName: s.companyName || live?.companyName || s.leadId,
    city: s.city || live?.city || null,
    region: s.region || live?.region || null,
    outcome,
    policyCompany: s.policyCompany ?? live?.policyCompany ?? null,
    policyNumber: s.policyNumber ?? live?.policyNumber ?? null,
    policyExpiry: s.policyExpiry ?? live?.policyExpiry ?? null,
    evidenceUrls: s.evidenceUrls || [],
    completedAt: s.completedAt,
    processingState: s.processingState,
    unresolvedRelevantNodes: s.unresolvedRelevantNodes,
    source: "SHADOW_RUN",
    revalStatus,
    shadow: s,
    live: live || undefined,
    website,
    phone,
    email,
    pec,
    piva,
    category: s.category || live?.category || null,
    crmStatus: s.crmStatus || live?.status || null,
    notes: s.notes || live?.notes || null,
    pdfHash: s.pdfHash,
    sourcePdfUrl: s.sourcePdfUrl || s.evidenceUrls?.[0] || null,
    legacyEvidence: live?.evidence || null,
  }
}

/** Dettaglio commerciale completo (LeadDetail) da join live + esito shadow. */
function rowToDetailLead(r: UiRow): Lead {
  const live = r.live
  const shadowEv = r.shadow?.evidence || ""
  const legacyEv = r.legacyEvidence || live?.evidence || ""
  const combinedEvidence = [
    shadowEv ? `[NUOVO MOTORE]\n${shadowEv}` : "",
    legacyEv ? `[LEGACY]\n${legacyEv}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  return {
    id: r.id,
    osmId: live?.osmId ?? null,
    companyName: r.companyName,
    region: r.region || live?.region || "",
    category: r.category ?? live?.category ?? null,
    website: r.website ?? null,
    city: r.city ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    policyFound: r.shadow?.policyFound ?? live?.policyFound ?? null,
    policyCompany: r.policyCompany,
    policyMassimale: live?.policyMassimale ?? null,
    policyNumber: r.policyNumber,
    policyExpiry: r.policyExpiry,
    confidence: live?.confidence ?? null,
    websiteReachable: live?.websiteReachable ?? null,
    lastScannedAt: r.completedAt ?? live?.lastScannedAt ?? null,
    status: r.crmStatus || live?.status || "NEW",
    evidence: combinedEvidence || live?.evidence || null,
    pec: r.pec ?? null,
    piva: r.piva ?? null,
    leadScore: live?.leadScore ?? null,
    notes: r.notes ?? live?.notes ?? null,
    reminderAt: live?.reminderAt ?? null,
    semantic: live?.semantic,
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
  { key: "date_unknown", label: "Scadenza da verificare" },
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
    else if (filters.tab === "review") {
      fetchReviewResults()
      fetchRunResults()
    } else if (filters.tab === "live" || filters.tab === "archive") {
      fetchLive()
      fetchRunResults()
      if (filters.tab === "archive") fetchReviewResults()
    }
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

  const isShadowCertified = (r: ShadowResult) => {
    const o = shadowToRow(r).outcome
    return (
      o === "policy_valid" ||
      o === "policy_expired" ||
      o === "date_unknown" ||
      o === "self_insurance" ||
      o === "hot"
    )
  }

  const liveById = useMemo(() => {
    const m = new Map<string, Lead>()
    for (const l of liveLeads) m.set(l.id, l)
    return m
  }, [liveLeads])

  const tabRows = useMemo((): UiRow[] => {
    let rows: UiRow[]
    if (filters.tab === "run") {
      // SOLO nuovo motore (shadow run). Mai fallback legacy. Join contatti live read-only.
      rows = runResults.map((s) => shadowToRow(s, liveById.get(s.leadId)))
    } else if (filters.tab === "review") {
      rows = reviewResults.map((s) => shadowToRow(s, liveById.get(s.leadId)))
    } else if (filters.tab === "live") {
      // Certificati: nuovo motore + legacy commerciali, badge distinti.
      const shadowCert = runResults
        .filter(isShadowCertified)
        .map((s) => shadowToRow(s, liveById.get(s.leadId)))
      const shadowIds = new Set(shadowCert.map((r) => r.id))
      const legacyLive = liveLeads
        .filter((l) => isLeadActionable(l) || isLegacyCommercialRow(l))
        .map(liveToRow)
        .filter((r) => !shadowIds.has(r.id))
      rows = [...shadowCert, ...legacyLive]
    } else {
      // Archivio completo = tutti i 877 legacy.
      rows = liveLeads.map((l) => liveToRow(l))
    }

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
  }, [filters, runResults, reviewResults, liveLeads, liveById])

  const runOutcomeCounts = useMemo(() => {
    const c: Record<OutcomeKey | "pending", number> = {
      ALL: runResults.length,
      policy_valid: 0,
      policy_expired: 0,
      date_unknown: 0,
      self_insurance: 0,
      hot: 0,
      review: 0,
      pending: 0,
    }
    for (const r of runResults) {
      const o = shadowToRow(r).outcome
      if (o in c) c[o as OutcomeKey]++
    }
    return c
  }, [runResults])

  const openCompletedRun = () => {
    setFilters({ tab: "run", region: "ALL", city: "", outcome: "ALL", query: "" })
  }

  const applyOutcomeCard = (outcome: OutcomeKey) => {
    setFilters({
      tab: "run",
      outcome,
      region: "ALL",
      city: "",
      query: "",
    })
  }

  const REVAL_STATUS_LABEL: Record<NonNullable<UiRow["revalStatus"]>, string> = {
    not_started: "Non ancora rivalidata",
    in_progress: "In corso",
    completed: "Completata",
    review: "Da controllare",
    retry: "Retry",
  }

  const exportCsv = () => {
    const CERTIFIED = new Set(["policy_valid", "policy_expired", "date_unknown", "self_insurance", "hot"])
    const rows = tabRows.filter((r) => CERTIFIED.has(r.outcome))
    downloadCsv(
      `sanita-${filters.tab}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows.map((r) => ({
        Struttura: r.companyName,
        Città: r.city || "",
        Regione: r.region || "",
        Esito: outcomeLabelForRow(r),
        Compagnia: r.policyCompany || "",
        Numero: r.policyNumber || "",
        Scadenza: r.policyExpiry || "",
        Sito: r.website || "",
        Telefono: r.phone || "",
        Email: r.email || "",
        PEC: r.pec || "",
        PIVA: r.piva || "",
        Categoria: r.category || "",
        Fonte: r.source === "SHADOW_RUN" ? "nuovo motore" : "legacy snapshot 18 luglio",
        CompletataIl: r.completedAt || "",
        EvidenceURL: r.evidenceUrls.join(" "),
        PdfHash: r.pdfHash || "",
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
  const certifiedRun = archiveStatus?.certifiedCurrentRun ?? 0
  const reviewCount = archiveStatus?.reviewCurrent ?? 0
  const inProgress = archiveStatus?.currentlyInProgress ?? 0
  const otherTerminal = archiveStatus?.otherNonCommercialTerminal ?? 0
  const technicalFinal = archiveStatus?.technicalBlockedFinal ?? 0
  const selfIns = archiveStatus?.selfInsurance ?? 0
  const legacyBreakdown = useMemo(() => {
    const c = {
      publishedValid: 0,
      publishedExpired: 0,
      dateUnknown: 0,
      hot: 0,
      selfInsurance: 0,
      commercial: 0,
    }
    for (const l of liveLeads) {
      const o = liveOutcome(l)
      if (o === "policy_valid") c.publishedValid++
      else if (o === "policy_expired") c.publishedExpired++
      else if (o === "date_unknown") c.dateUnknown++
      else if (o === "hot") c.hot++
      else if (o === "self_insurance") c.selfInsurance++
      if (isLegacyCommercialRow(l)) c.commercial++
    }
    return c
  }, [liveLeads])
  const archiveTotal = apiMeta?.dbTotal ?? liveLeads.length ?? 0
  const counterSum = certifiedRun + reviewCount + otherTerminal + technicalFinal

  const kpiCards: { label: string; value: string | number; testid: string; onClick?: () => void }[] = [
    {
      label: "Archivio legacy",
      value: archiveTotal,
      testid: "kpi-archive-total",
      onClick: () => setFilters({ tab: "archive", region: "ALL", city: "", outcome: "ALL", query: "" }),
    },
    {
      label: "Conclusi nuovo run",
      value: `${terminal} / ${target}`,
      testid: "kpi-terminal-completed",
      onClick: openCompletedRun,
    },
    { label: "Certificati nuovo motore", value: certifiedRun, testid: "kpi-certified-run" },
    { label: "Da controllare", value: reviewCount, testid: "kpi-review" },
    { label: "In lavorazione", value: inProgress, testid: "kpi-in-progress" },
    { label: "Retry", value: retryCount, testid: "kpi-retry" },
    {
      label: "Legacy commerciali",
      value: legacyBreakdown.commercial,
      testid: "kpi-legacy-certified",
      onClick: () => setFilters({ tab: "live", region: "ALL", city: "", outcome: "ALL", query: "" }),
    },
  ]

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Stethoscope className="h-5 w-5 text-primary" />
          Verifica polizze sanitarie
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="header-kpi">
          Archivio legacy {archiveTotal} · Conclusi nuovo run {terminal}/{target} · Certificati
          nuovo motore {certifiedRun} · Legacy commerciali {legacyBreakdown.commercial}
          {" · "}Published legacy {legacyBreakdown.publishedValid}
          {" · "}HOT legacy {legacyBreakdown.hot}
          {" · "}scaduti legacy {legacyBreakdown.publishedExpired}
          {" · "}data ignota legacy {legacyBreakdown.dateUnknown}
          {counterSum !== terminal ? (
            <span className="ml-2 text-amber-700">
              (riconciliazione run: {certifiedRun}+{reviewCount}+{otherTerminal}+{technicalFinal}=
              {counterSum}, terminal={terminal}
              {selfIns ? `, SI=${selfIns}` : ""})
            </span>
          ) : null}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" data-testid="kpi-cards">
        {kpiCards.map((k) => (
          <button
            key={k.testid}
            type="button"
            data-testid={k.testid}
            onClick={k.onClick}
            disabled={!k.onClick}
            className={cn(
              "rounded-md border bg-card px-3 py-2 text-left",
              k.onClick && "cursor-pointer hover:border-primary hover:bg-muted/40"
            )}
          >
            <div className="text-[11px] text-muted-foreground">{k.label}</div>
            <div className="text-lg font-semibold tabular-nums">{k.value}</div>
          </button>
        ))}
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
          <button
            type="button"
            data-testid="completed-progress-link"
            onClick={openCompletedRun}
            className="text-left text-sm font-medium text-primary hover:underline"
          >
            {terminal} di {target} concluse — apri Nuovi risultati
          </button>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
              data-testid="progress-bar"
            />
          </div>
          <div className="text-sm" data-testid="run-counters">
            Certificati {certifiedRun} (Published {archiveStatus?.published ?? 0} · HOT{" "}
            {archiveStatus?.hot ?? 0} · Autoassicurata {selfIns}) · da controllare {reviewCount} ·
            altri terminali {otherTerminal} · tecnici {technicalFinal} · in lavorazione {inProgress}{" "}
            · retry {retryCount}
          </div>
          <div className="text-xs text-muted-foreground">
            prese in carico {archiveStatus?.recordsTouched ?? 0} · somma terminali {counterSum}/
            {terminal}
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

      {/* Categoria — pulsanti reali (URL + tabella) */}
      <div className="flex flex-wrap gap-2" data-testid="outcome-category-buttons">
        {(
          [
            ["policy_valid", "Polizza valida"],
            ["policy_expired", "Polizza scaduta"],
            ["date_unknown", "Scadenza sconosciuta"],
            ["self_insurance", "Autoassicurata"],
            ["hot", "HOT verificato"],
            ["review", "Da controllare"],
          ] as const
        ).map(([key, label]) => {
          const count = runOutcomeCounts[key] ?? 0
          const active = filters.outcome === key
          return (
            <button
              key={key}
              type="button"
              data-testid={`outcome-card-${key}`}
              data-outcome={key}
              onClick={() => applyOutcomeCard(key)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "bg-card hover:border-primary/50"
              )}
            >
              <span className="font-medium">{label}</span>
              <span className="ml-2 tabular-nums text-muted-foreground">{count}</span>
            </button>
          )
        })}
        {filters.outcome !== "ALL" && (
          <button
            type="button"
            data-testid="outcome-card-clear"
            className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => applyOutcomeCard("ALL")}
          >
            Tutti gli esiti
          </button>
        )}
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
                <th className="px-3 py-2 font-medium">Origine</th>
                <th className="px-3 py-2 font-medium">Contatti</th>
                <th className="px-3 py-2 font-medium">Polizza</th>
                <th className="px-3 py-2 font-medium">Evidence</th>
                <th className="px-3 py-2 font-medium">Completata il</th>
                {filters.tab === "archive" && (
                  <th className="px-3 py-2 font-medium">Stato rivalidazione</th>
                )}
                {filters.tab !== "run" && filters.tab !== "review" && filters.tab !== "archive" && (
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
                    key={`${r.source}-${r.id}`}
                    data-testid="lead-row"
                    data-region={r.region || ""}
                    data-outcome={r.outcome}
                    data-source={r.source}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                    onClick={() => setDetail(rowToDetailLead(r))}
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <div className="truncate font-medium" title={r.companyName}>
                        {r.companyName}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="row-locality">
                      {r.city || "—"}
                      {r.region ? <span className="text-muted-foreground"> · {r.region}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn("gap-1", meta.cls)} data-testid="outcome-badge">
                        <Icon className="h-3 w-3" />
                        {outcomeLabelForRow(r)}
                      </Badge>
                      {r.unresolvedRelevantNodes != null && r.unresolvedRelevantNodes > 0 && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {r.unresolvedRelevantNodes} nodi da risolvere
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        data-testid="source-badge"
                        className={
                          r.source === "SHADOW_RUN"
                            ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                            : "border-slate-200 bg-slate-50 text-slate-700"
                        }
                      >
                        {sourceLabelForRow(r)}
                      </Badge>
                    </td>
                    <td
                      className="max-w-[220px] px-3 py-2 text-[11px] leading-snug"
                      data-testid="row-contacts"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.website ? (
                        <a
                          href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-primary hover:underline"
                          title={r.website}
                        >
                          {r.website.replace(/^https?:\/\//, "")}
                        </a>
                      ) : null}
                      {r.phone ? (
                        <a href={`tel:${r.phone}`} className="block truncate hover:text-primary">
                          {r.phone}
                        </a>
                      ) : null}
                      {r.email ? (
                        <a href={`mailto:${r.email}`} className="block truncate hover:text-primary">
                          {r.email}
                        </a>
                      ) : null}
                      {r.pec ? (
                        <div className="truncate text-violet-700" title={r.pec}>
                          PEC {r.pec}
                        </div>
                      ) : null}
                      {(r.piva || r.category || r.notes) && (
                        <div className="text-[10px] text-muted-foreground">altri dati</div>
                      )}
                      {!r.website && !r.phone && !r.email && !r.pec && (
                        <span className="text-muted-foreground">—</span>
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
                      {r.evidenceUrls.length || r.pdfHash ? (
                        <div className="space-y-0.5" onClick={(e) => e.stopPropagation()}>
                          {r.evidenceUrls.slice(0, 2).map((u) => (
                            <a
                              key={u}
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              title={`URL originale: ${u}`}
                              className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                            >
                              <FileSearch className="h-3 w-3 shrink-0" />
                              <span className="truncate">{docLabel(u)}</span>
                              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                            </a>
                          ))}
                          {r.pdfHash && (
                            <a
                              href={`/api/sanita/archive-revalidation/evidence-file?sha=${r.pdfHash}`}
                              target="_blank"
                              rel="noreferrer"
                              title={`Copia locale SHA256 ${r.pdfHash}`}
                              className="flex items-center gap-1 text-[10px] text-emerald-700 hover:underline"
                            >
                              <FileSearch className="h-3 w-3 shrink-0" />
                              cache {r.pdfHash.slice(0, 10)}…
                            </a>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.completedAt)}</td>
                    {filters.tab === "archive" && (
                      <td className="px-3 py-2 text-xs" data-testid="reval-status">
                        {REVAL_STATUS_LABEL[r.revalStatus || "not_started"]}
                      </td>
                    )}
                    {filters.tab === "live" && r.live && (
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
                    {filters.tab === "live" && !r.live && <td />}
                  </tr>
                )
              })}
              {tabRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted-foreground">
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
