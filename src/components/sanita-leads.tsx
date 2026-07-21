"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Stethoscope, Search, Loader2, AlertTriangle, CheckCircle2, MapPin, Globe,
  Phone, HelpCircle, ShieldAlert, ShieldCheck, ShieldQuestion,
  Filter, X, RefreshCw, Download, Flame, FileSearch, ExternalLink,
  Info, Zap, RotateCcw, PauseCircle,
} from "lucide-react"
import { toast } from "sonner"
import {
  deriveVerdict, VERDICT_META, type Verdict,
} from "@/lib/sanita/verdict"
import { parseEvidenceSections, policyPdfUrlsForLead, isHotPublishedExpiredEvidence, expiredDaysFromEvidence, policyHtmlSourceForLead } from "@/lib/sanita/audit"
import {
  readPublishedSubtype,
  uxLabelForPublished,
} from "@/lib/sanita/published-subtype"
import { downloadCsv } from "@/lib/export-csv"
import { StatusSelect } from "@/components/status-select"
import { LeadDetail } from "@/components/lead-detail"
import { cn } from "@/lib/utils"
import { classifyGelliScope } from "@/lib/sanita/gelli-scope"
import { auditQueueBadge, AUDIT_BADGE_UI } from "@/lib/sanita/audit-queue-badge"
import { readProcessingState, readBusinessVerdict } from "@/lib/sanita/processing-state"
import { isInActionableSalesQueue } from "@/lib/sanita/actionable-queue"

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

type VerdictFilter = "ALL" | Verdict | "PENDING"
type ViewTab = "commercial" | "archive" | "status"

type ArchiveRevalidationStatus = {
  available?: boolean
  active?: boolean
  statusLabel?: string
  processed?: number
  targetTotal?: number
  percent?: number
  updatedAt?: string | null
  certifiedResults?: number
  checksNeeded?: number
  technicalPending?: number
  absenceFound?: number
  terminal?: number
  /** Current-state fields (authoritative) */
  recordsTouched?: number
  terminalCompleted?: number
  currentlyInProgress?: number
  currentRetryQueue?: number
  reviewCurrent?: number
  technicalBlockedFinal?: number
  certifiedCurrentRun?: number
  hot?: number
  published?: number
}

type ScanJob = {
  jobId: string
  mode: "single" | "city" | "region"
  status: "queued" | "running" | "completed" | "interrupted" | "cancelled" | "failed"
  region: "Veneto" | "Campania"
  city: string | null
  leadId: string | null
  updatedAt: string
  finishedAt: string | null
  lastUpdateLabel: string | null
  resumable: boolean
  progress: {
    structuresControlled: number
    totalStructures: number | null
    certifiedResults: number
    autoVerificationsPending: number
    manualChecksNeeded: number
    percent: number | null
    currentMessage: string | null
    currentStructure: string | null
  }
}

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

type SanitaApiMeta = {
  regions?: Record<string, RegionMeta>
  actionableCount?: number
  dbTotal?: number
  totalReturned?: number
  filteredDefault?: boolean
  includeAll?: boolean
  revalidationUiLock?: boolean
  kpis?: {
    total: number
    actionable: number
    HOT_VERIFIED: number
    PUBLISHED_CURRENT: number
    PUBLISHED_EXPIRED: number
    PUBLISHED_DATE_UNKNOWN: number
    RETRY_PENDING: number
    REVIEW_HUMAN: number
    TECHNICAL_BLOCKED: number
    OUT_OF_SCOPE: number
    inRevalidation: number
    notYetCertified?: number
    LEGACY: number
    commercial?: {
      policyValid: number
      policyExpired: number
      dateUnknown: number
      absenceCertified: number
    }
  }
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
  const [scanJob, setScanJob] = useState<ScanJob | null>(null)
  const [scanJobId, setScanJobId] = useState<string | null>(null)
  const [discoveryMeta, setDiscoveryMeta] = useState<Record<string, RegionDiscoveryMeta>>({})
  const [processingName, setProcessingName] = useState<string | null>(null)
  const [viewTab, setViewTab] = useState<ViewTab>("commercial")
  const [apiMeta, setApiMeta] = useState<SanitaApiMeta | null>(null)
  const [archiveStatus, setArchiveStatus] = useState<ArchiveRevalidationStatus | null>(null)
  const [techOpen, setTechOpen] = useState(false)
  const [archivePanelOpen, setArchivePanelOpen] = useState(true)

  const isLeadActionable = (l: Lead) =>
    Boolean(l.semantic?.actionable ?? l._actionable ?? isInActionableSalesQueue(l))

  /** Conteggi territoriali da meta.regions (DB), non dall'array filtrato UI. */
  const regionStats = useMemo(() => {
    const out: Record<string, { total: number; done: number; hot: number; pending: number }> = {}
    for (const r of ["Veneto", "Campania"] as const) {
      const m = apiMeta?.regions?.[r]
      const total = m?.total ?? 0
      const done = m?.done ?? 0
      // pending da meta; livePending ricalcolato sotto se scansione attiva
      const metaPending = m?.pending ?? Math.max(0, total - done)
      let hot = 0
      for (const l of leads) {
        if (l.region !== r) continue
        if (readProcessingState(l.evidence) === "HOT_VERIFIED") hot++
        else if (
          deriveVerdict({
            lastScannedAt: l.lastScannedAt,
            policyFound: l.policyFound,
            websiteReachable: l.websiteReachable,
            website: l.website,
            evidence: l.evidence,
          }) === "HOT" &&
          isLeadActionable(l)
        ) {
          hot++
        }
      }
      const liveTotal =
        isScanning && activeScan?.region === r
          ? Math.max(activeScan.total, activeScan.done, total)
          : total
      const liveDone =
        isScanning && activeScan?.region === r ? Math.max(activeScan.done, done) : done
      out[r] = {
        total: liveTotal,
        done: liveDone,
        hot,
        pending:
          isScanning && activeScan?.region === r
            ? Math.max(0, liveTotal - liveDone)
            : metaPending,
      }
    }
    return out
  }, [leads, apiMeta, isScanning, activeScan])

  const fetchLeads = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setIsLoading(true)
    try {
      const res = await fetch("/api/sanita?includePending=1&includeAll=1")
      const json = await res.json()
      if (json.success) {
        setLeads(json.data)
        const meta = (json.meta ?? {}) as SanitaApiMeta
        setApiMeta(meta)
        const regions = meta.regions
        if (regions) {
          const next: Record<string, RegionDiscoveryMeta> = {}
          for (const [r, m] of Object.entries(regions)) {
            if (m.discovery) next[r] = m.discovery
          }
          setDiscoveryMeta(next)
        }
        if (!opts?.silent) {
          const tot = meta.dbTotal ?? json.data.length
          const act = meta.actionableCount ?? 0
          toast.success(`DB ${tot} strutture · coda certificata ${act}`)
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

  const hydrateJobUi = (job: ScanJob | null) => {
    setScanJob(job)
    setScanJobId(job?.jobId ?? null)
    if (!job) {
      setIsScanning(false)
      setActiveScan(null)
      setScanProgress(null)
      setProcessingName(null)
      return
    }
    const active = job.status === "queued" || job.status === "running"
    setIsScanning(active)
    setRegionFilter(job.region)
    setActiveScan({
      region: job.region,
      done: job.progress.structuresControlled ?? 0,
      total: job.progress.totalStructures ?? 0,
      round: 1,
      phase: job.progress.currentMessage ?? job.lastUpdateLabel ?? "Verifica in corso",
    })
    setScanProgress(job.progress.currentMessage ?? job.lastUpdateLabel ?? null)
    setProcessingName(job.progress.currentStructure ?? null)
  }

  const fetchJob = async (jobId: string, opts?: { refreshLeads?: boolean }) => {
    const res = await fetch(`/api/sanita/jobs/${jobId}`, { cache: "no-store" })
    const json = await res.json() as { success?: boolean; job?: ScanJob }
    if (!res.ok || !json.success || !json.job) throw new Error("Impossibile leggere lo stato del job")
    hydrateJobUi(json.job)
    if (opts?.refreshLeads) {
      await fetchLeads({ silent: true })
    }
    return json.job
  }

  const fetchLatestJob = async () => {
    const res = await fetch("/api/sanita/jobs?limit=1", { cache: "no-store" })
    const json = await res.json() as { success?: boolean; jobs?: ScanJob[] }
    if (!res.ok || !json.success) return null
    const job = json.jobs?.[0] ?? null
    hydrateJobUi(job)
    return job
  }

  /** All'avvio carica i lead già salvati nel database condiviso. */
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchLeads({ silent: true });
      void fetchLatestJob().catch(() => {})
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!scanJobId) return
    const timer = window.setInterval(() => {
      void fetchJob(scanJobId, {
        refreshLeads: true,
      }).catch(() => {})
    }, 4000)
    return () => window.clearInterval(timer)
  }, [scanJobId])

  const rescanOneLead = async (l: Lead) => {
    return createScanJob({
      mode: "single",
      region: l.region as "Veneto" | "Campania",
      leadId: l.id,
      label: `Verifica struttura · ${l.companyName}`,
    })
  }

  const createScanJob = async (body: {
    mode: "single" | "city" | "region"
    region: "Veneto" | "Campania"
    city?: string
    leadId?: string
    label: string
  }) => {
    const toastId = toast.loading(body.label)
    try {
      const res = await fetch("/api/sanita/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json() as { success?: boolean; error?: string; created?: boolean; job?: ScanJob }
      if (!res.ok || !json.success || !json.job) {
        throw new Error(json.error ?? "Impossibile avviare il job")
      }
      hydrateJobUi(json.job)
      await fetchLeads({ silent: true })
      toast.success(
        json.created === false
          ? "Job gia' attivo: riprendo il monitoraggio."
          : "Job avviato. Il controllo continua anche se chiudi il browser.",
        { id: toastId }
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Errore avvio job", { id: toastId })
    }
  }

  const cancelScanJob = async () => {
    if (!scanJob?.jobId) return
    const toastId = toast.loading("Interruzione job in corso…")
    try {
      const res = await fetch(`/api/sanita/jobs/${scanJob.jobId}/cancel`, { method: "POST" })
      const json = await res.json() as { success?: boolean; error?: string; job?: ScanJob }
      if (!res.ok || !json.success || !json.job) {
        throw new Error(json.error ?? "Impossibile interrompere il job")
      }
      hydrateJobUi(json.job)
      toast.success("Interruzione richiesta inviata.", { id: toastId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Errore interruzione job", { id: toastId })
    }
  }

  const revalidationUiLock = Boolean(
    apiMeta?.revalidationUiLock ??
      ((apiMeta?.actionableCount ?? 0) === 0 && (apiMeta?.dbTotal ?? leads.length) > 0)
  )

  const guardScanAction = (label: string, run: () => void) => {
    if (revalidationUiLock) {
      const ok = confirm(
        `${label}\n\nRivalidazione archivio in corso: la coda commerciale mostra solo lead certificati.\n` +
          `La discovery territoriale è separata e non riparte la rivalidazione.\n\nContinuare?`
      )
      if (!ok) return
    }
    run()
  }

  const startRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Scansiona ${region}`, () => {
      void createScanJob({ mode: "region", region, label: `Scansione regione · ${region}` })
    })
  }

  const continueRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Continua ${region}`, () => {
      void createScanJob({ mode: "region", region, label: `Riprendi scansione · ${region}` })
    })
  }

  const resetRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Reset ${region}`, () => {
      toast.info("Per sicurezza il reset completo non e' esposto nella UI cliente.")
    })
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

  const isHotPublishedExpired = (l: Lead) =>
    verdictOf(l) === "HOT" && isHotPublishedExpiredEvidence(l.evidence)

  const policyRcCell = (l: Lead) => {
    const v = verdictOf(l)
    const hotExpired = isHotPublishedExpired(l)
    const hasPolicyMeta = Boolean(l.policyCompany || l.policyExpiry || l.policyMassimale)
    const show =
      (v === "PUBLISHED" && hasPolicyMeta) ||
      (hotExpired && (hasPolicyMeta || Boolean(l.evidence)))

    if (!show) return <span className="text-muted-foreground">—</span>

    const docs = policyDocLinks(l)
    const htmlSrc = policyHtmlSourceForLead(l.evidence)
    const daysFromEvidence = expiredDaysFromEvidence(l.evidence)

    return (
      <div className="space-y-1">
        {l.policyCompany ? (
          <div className="line-clamp-2 font-medium leading-snug">{l.policyCompany}</div>
        ) : hotExpired ? (
          <div className="text-[10px] italic text-muted-foreground">Compagnia nel documento</div>
        ) : null}
        {l.policyMassimale && (
          <div className="text-[10px] text-muted-foreground">Massimale {l.policyMassimale}</div>
        )}
        {l.policyExpiry ? (
          <div className="text-[10px]">{expiryCell(l)}</div>
        ) : daysFromEvidence != null ? (
          <div className="text-[10px] font-semibold text-red-600">Scaduta da {daysFromEvidence} gg</div>
        ) : null}
        {docs.map((u) => (
          <a
            key={u}
            href={u}
            target="_blank"
            rel="noreferrer"
            title={u}
            className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
          >
            <FileSearch className="h-3 w-3 shrink-0" />
            <span className="truncate">{docLabel(u)}</span>
            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
          </a>
        ))}
        {docs.length === 0 && htmlSrc && (
          <a
            href={htmlSrc}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-primary hover:underline"
          >
            <FileSearch className="h-3 w-3 shrink-0" />
            <span className="truncate">Fonte polizza (web)</span>
            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
          </a>
        )}
        {hotExpired && docs.length === 0 && !htmlSrc && (
          <button
            type="button"
            onClick={() => setDetail(l)}
            className="text-[10px] text-primary hover:underline"
          >
            Apri scheda per fonte
          </button>
        )}
      </div>
    )
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

  const visibleLeads = useMemo(() => {
    const base = leads.filter(
      (l) => l.lastScannedAt != null || l.evidence?.trim() || Boolean(l.website?.trim())
    )
    if (viewTab === "commercial") {
      return base.filter((l) => isLeadActionable(l))
    }
    if (viewTab === "status") {
      // Casi non conclusi / non ancora in coda commerciale
      return base.filter((l) => !isLeadActionable(l))
    }
    return base
  }, [leads, viewTab])

  const fetchArchiveStatus = async () => {
    try {
      const res = await fetch("/api/sanita/archive-revalidation", { cache: "no-store" })
      const json = (await res.json()) as ArchiveRevalidationStatus & { success?: boolean }
      setArchiveStatus(json)
    } catch {
      /* soft-fail: hero shows fallback */
    }
  }

  useEffect(() => {
    // Defer initial fetch so setState is not synchronous inside the effect body.
    const boot = setTimeout(() => {
      void fetchArchiveStatus()
    }, 0)
    const t = setInterval(() => void fetchArchiveStatus(), 30_000)
    return () => {
      clearTimeout(boot)
      clearInterval(t)
    }
  }, [])

  const auditKpis = useMemo(() => {
    const k = apiMeta?.kpis
    if (k) {
      return {
        total: k.total,
        actionable: k.actionable,
        HOT_VERIFIED: k.HOT_VERIFIED,
        PUBLISHED_CURRENT: k.PUBLISHED_CURRENT,
        PUBLISHED_EXPIRED: k.PUBLISHED_EXPIRED,
        PUBLISHED_DATE_UNKNOWN: k.PUBLISHED_DATE_UNKNOWN,
        inRevalidation: k.inRevalidation,
        notYetCertified: k.notYetCertified ?? Math.max(0, k.total - k.actionable),
        RETRY_PENDING: k.RETRY_PENDING,
        REVIEW_HUMAN: k.REVIEW_HUMAN,
        TECHNICAL_BLOCKED: k.TECHNICAL_BLOCKED,
        OUT_OF_SCOPE: k.OUT_OF_SCOPE,
        LEGACY: k.LEGACY ?? 0,
        commercial: k.commercial ?? {
          policyValid: 0,
          policyExpired: 0,
          dateUnknown: 0,
          absenceCertified: 0,
        },
      }
    }
    // fallback client se meta assente
    let HOT_VERIFIED = 0,
      PUBLISHED_CURRENT = 0,
      PUBLISHED_EXPIRED = 0,
      PUBLISHED_DATE_UNKNOWN = 0,
      RETRY_PENDING = 0,
      REVIEW_HUMAN = 0,
      TECHNICAL_BLOCKED = 0,
      OUT_OF_SCOPE = 0,
      LEGACY = 0,
      actionable = 0,
      inRevalidation = 0
    const commercial = {
      policyValid: 0,
      policyExpired: 0,
      dateUnknown: 0,
      absenceCertified: 0,
    }
    for (const l of leads) {
      const act = isLeadActionable(l)
      if (act) actionable++
      else inRevalidation++
      const ps = readProcessingState(l.evidence)
      const bv = readBusinessVerdict(l.evidence)
      if (ps === "HOT_VERIFIED") HOT_VERIFIED++
      else if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") PUBLISHED_CURRENT++
      else if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") PUBLISHED_EXPIRED++
      else if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") PUBLISHED_DATE_UNKNOWN++
      else if (ps === "RETRY_PENDING") RETRY_PENDING++
      else if (ps === "REVIEW_HUMAN" || bv === "REVIEW_HUMAN") REVIEW_HUMAN++
      else if (ps === "TECHNICAL_BLOCKED") TECHNICAL_BLOCKED++
      else if (ps === "OUT_OF_SCOPE" || bv === "OUT_OF_SCOPE") OUT_OF_SCOPE++
      if (l._legacy) LEGACY++
      if (act) {
        if (ps === "HOT_VERIFIED") commercial.absenceCertified++
        else if (ps === "PUBLISHED_CURRENT" || bv === "PUBLISHED_CURRENT") commercial.policyValid++
        else if (ps === "PUBLISHED_EXPIRED" || bv === "PUBLISHED_EXPIRED") commercial.policyExpired++
        else if (ps === "PUBLISHED_DATE_UNKNOWN" || bv === "PUBLISHED_DATE_UNKNOWN") commercial.dateUnknown++
        else if (/\[V:PUB\]/i.test(l.evidence || "")) commercial.dateUnknown++
        else commercial.absenceCertified++
      }
    }
    const total = apiMeta?.dbTotal ?? leads.length
    return {
      total,
      actionable: apiMeta?.actionableCount ?? actionable,
      HOT_VERIFIED,
      PUBLISHED_CURRENT,
      PUBLISHED_EXPIRED,
      PUBLISHED_DATE_UNKNOWN,
      inRevalidation,
      notYetCertified: Math.max(0, total - (apiMeta?.actionableCount ?? actionable)),
      RETRY_PENDING,
      REVIEW_HUMAN,
      TECHNICAL_BLOCKED,
      OUT_OF_SCOPE,
      LEGACY,
      commercial,
    }
  }, [leads, apiMeta])

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
    let hot = 0, pub = 0, review = 0
    for (const l of scope) {
      const v = verdictOf(l)
      if (v === "HOT") hot++
      else if (v === "PUBLISHED") pub++
      else if (v === "REVIEW") review++
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
    // CSV cliente: solo coda commerciale certificata (mai legacy/retry/review/tech)
    const commercial = leads.filter((l) => isLeadActionable(l))
    const exportRows =
      viewTab === "commercial"
        ? filtered.filter((l) => isLeadActionable(l))
        : commercial.filter((l) => {
            if (regionFilter !== "ALL" && l.region !== regionFilter) return false
            if (selectedCity && l.city !== selectedCity) return false
            return true
          })
    if (exportRows.length === 0) {
      toast.info("Nessun lead certificato da esportare (coda commerciale vuota o filtrata)")
      return
    }
    const rows = exportRows.map((l) => {
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
    downloadCsv(`lead-sanita-commerciale-${new Date().toISOString().slice(0, 10)}.csv`, rows)
    toast.success(`Esportati ${rows.length} lead certificati (CSV cliente)`)
  }

  const formatDate = (s: string | null) =>
    s ? new Intl.DateTimeFormat("it-IT").format(new Date(s)) : "—"
  const formatDateTime = (s: string | null) =>
    s
      ? new Intl.DateTimeFormat("it-IT", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(s))
      : "—"
  const jobStatusLabel = (job: ScanJob) => {
    if (job.status === "queued") return "In attesa"
    if (job.status === "running") return "Verifica in corso"
    if (job.status === "completed") return "Job completato"
    if (job.status === "interrupted") return "Job riprendibile"
    if (job.status === "cancelled") return "Job interrotto"
    return "Controllo da verificare"
  }
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
    const subtype = v === "PUBLISHED" ? readPublishedSubtype(l.evidence) : null
    const label = v === "PUBLISHED" ? uxLabelForPublished(subtype, m.label) : m.label
    const expiredTone =
      subtype === "PUBLISHED_EXPIRED" || isHotPublishedExpiredEvidence(l.evidence)
        ? "bg-orange-50 text-orange-800 border-orange-200"
        : m.cls
    return (
      <Badge className={cn("flex w-fit items-center gap-1 border text-[10px]", expiredTone)}>
        <Icon className="h-3 w-3 shrink-0" /> {label}
      </Badge>
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
      const daysSince = d != null ? -d : null
      const isObsolete = daysSince != null && daysSince > 365
      const publishedButExpired =
        isObsolete ||
        /polizza\s+rc\s+pubblicata|polizza\s+pubblicata|pubblicata\s+sul\s+sito/i.test(l.evidence ?? "")
      const exp = l.policyExpiry ? ` · scadenza ${formatDate(l.policyExpiry)}` : ""
      if (publishedButExpired) {
        return (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700"><Zap className="h-3 w-3" />Polizza pubblicata ma scaduta{exp}</span>
            <span className="block text-[10px] text-muted-foreground">Art. 10 — sito non aggiornato; lead prioritario rinnovo/adeguamento</span>
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

  /** Una riga per la tabella — dettaglio completo nella scheda lead. */
  const strategyLine = (l: Lead) => {
    const v = verdictOf(l)
    if (!v) return l.website ? "Sito presente — da analizzare" : "Nessun sito — verifica manuale"
    if (v === "PUBLISHED") {
      const d = l.policyExpiry ? daysUntil(l.policyExpiry) : null
      const daysSince = d != null ? -d : null
      const isObsolete = daysSince != null && daysSince > 365
      if (d != null && d < 0 && !isObsolete) return "Polizza scaduta — contatto urgente"
      if (isObsolete) return "Data polizza molto vecchia — verifica aggiornamento"
      return "Già coperta — opportunità rinnovo"
    }
    if (v === "HOT") {
      const d = l.policyExpiry ? daysUntil(l.policyExpiry) : null
      const daysSince = d != null ? -d : null
      const publishedButExpired =
        isHotPublishedExpired(l) &&
        ((daysSince != null && daysSince > 365) ||
          /polizza\s+rc\s+pubblicata|polizza\s+pubblicata\s+sul\s+sito/i.test(l.evidence ?? ""))
      if (publishedButExpired) return "Pubblicata ma scaduta — lead prioritario"
      if (/non\s+pubblicat|assenza\s+pubblicazione/i.test(l.evidence ?? ""))
        return "Polizza RC non trovata in Trasparenza — priorità commerciale"
      return "Irregolare Art. 10 — priorità commerciale"
    }
    if (/manutenzione/i.test(l.evidence ?? "")) return "Sito in manutenzione — verifica manuale"
    if (l.website && l.websiteReachable === false) return "Sito trovato — bloccato dal server, crawl via browser"
    if (l.website && l.websiteReachable !== false) return "Analisi non conclusiva — controllo manuale"
    return "Sito assente — ricerca Maps/Google in corso"
  }

  const contactExtras = (l: Lead) =>
    [l.email, l.pec, l.piva].filter(Boolean).length

  const commercialSum =
    (auditKpis.commercial?.policyValid ?? 0) +
    (auditKpis.commercial?.policyExpired ?? 0) +
    (auditKpis.commercial?.dateUnknown ?? 0) +
    (auditKpis.commercial?.absenceCertified ?? 0)

  const archiveTarget = archiveStatus?.targetTotal ?? 877
  const terminalCompleted = archiveStatus?.terminalCompleted ?? archiveStatus?.terminal ?? 0
  const recordsTouched = archiveStatus?.recordsTouched ?? archiveStatus?.processed ?? 0
  const currentRetryQueue = archiveStatus?.currentRetryQueue ?? 0
  const currentlyInProgress = archiveStatus?.currentlyInProgress ?? 0
  const reviewCurrent = archiveStatus?.reviewCurrent ?? archiveStatus?.checksNeeded ?? 0
  const technicalFinal =
    archiveStatus?.technicalBlockedFinal ?? archiveStatus?.technicalPending ?? 0
  const certifiedCurrentRun =
    archiveStatus?.certifiedCurrentRun ?? archiveStatus?.certifiedResults ?? 0
  const archivePct =
    archiveStatus?.percent ??
    (archiveTarget > 0 ? Math.round((terminalCompleted / archiveTarget) * 1000) / 10 : 0)
  const archiveActive = Boolean(archiveStatus?.active)

  return (
    <div className="space-y-8">
      {/* HEADER */}
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-900 text-white shadow-sm">
              <Stethoscope className="h-5 w-5" />
            </span>
            Motore Sanità · Legge Gelli
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
            Verifica la pubblicazione della polizza RC sulle strutture sanitarie e mostra solo i risultati
            utilizzabili commercialmente.
          </p>
        </div>

        {/* HERO — 3 KPI only */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Archivio strutture
              </p>
              <p className="mt-3 text-4xl font-bold tabular-nums text-slate-900">{auditKpis.total}</p>
              <p className="mt-2 text-sm text-slate-600">Strutture sanitarie presenti nel database</p>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Rivalidazione archivio
              </p>
              <p className="mt-3 text-4xl font-bold tabular-nums text-slate-900">
                {terminalCompleted}
                <span className="text-2xl font-semibold text-slate-400"> / {archiveTarget}</span>
              </p>
              <p className="mt-2 text-sm text-slate-600">
                {archiveActive ? "Verifiche concluse" : (archiveStatus?.statusLabel ?? "Stato verifica")}
              </p>
              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-900 transition-all duration-500"
                  style={{ width: `${Math.min(100, archivePct)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-slate-500">{archivePct}% concluse</p>
            </CardContent>
          </Card>

          <Card className="border-emerald-200 bg-emerald-50/50 shadow-sm">
            <CardContent className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800/80">
                Lead certificati
              </p>
              <p className="mt-3 text-4xl font-bold tabular-nums text-emerald-800">{auditKpis.actionable}</p>
              <p className="mt-2 text-sm text-emerald-900/70">Risultati utilizzabili commercialmente</p>
            </CardContent>
          </Card>
        </div>

        {/* Rivalidazione archivio — pannello unico */}
        <Card className="border-slate-200 shadow-sm" id="rivalidazione-archivio">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-base font-semibold text-slate-900">Rivalidazione archivio</p>
                <p className="mt-1 text-sm text-slate-600">
                  Stato: <span className="font-medium text-slate-900">{archiveActive ? "Verifica in corso" : (archiveStatus?.statusLabel ?? "—")}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled className="bg-slate-800 text-white hover:bg-slate-800">
                  {archiveActive ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Rivalidazione in corso
                    </>
                  ) : (
                    "Rivalidazione archivio"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setArchivePanelOpen(true)
                    setViewTab("status")
                    document.getElementById("rivalidazione-archivio")?.scrollIntoView({ behavior: "smooth" })
                  }}
                >
                  Visualizza avanzamento
                </Button>
              </div>
            </div>

            {archivePanelOpen && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                  <p className="text-xs text-slate-500">Verifiche concluse</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {terminalCompleted} / {archiveTarget}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                  <p className="text-xs text-slate-500">Avanzamento (concluse)</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{archivePct}%</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                  <p className="text-xs text-slate-500">Ultimo aggiornamento</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {formatDateTime(archiveStatus?.updatedAt ?? null)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Strutture prese in carico</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {recordsTouched}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">In verifica ora</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {currentlyInProgress}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Riprova automatica in corso</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {currentRetryQueue}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Risultati certificati (run corrente)</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {certifiedCurrentRun}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Controlli necessari</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {reviewCurrent}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Problemi tecnici definitivi</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                    {technicalFinal}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabs */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
          {(
            [
              ["commercial", "Coda commerciale"],
              ["archive", "Archivio completo"],
              ["status", "Stato verifiche"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setViewTab(key)}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium transition",
                viewTab === key
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Coda commerciale — sintesi 4 categorie */}
        {viewTab === "commercial" && (
          <Card className="border-emerald-200/70 bg-white shadow-sm">
            <CardContent className="p-5">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Coda commerciale</p>
                  <p className="text-xs text-slate-500">Solo lead certificati e utilizzabili</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={exportCsv} disabled={isScanning}>
                    <Download className="h-4 w-4" /> Esporta CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void fetchLeads()} disabled={isScanning}>
                    <RefreshCw className="h-4 w-4" /> Aggiorna
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Polizza valida</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700">
                    {auditKpis.commercial.policyValid}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Polizza scaduta</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700">
                    {auditKpis.commercial.policyExpired}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Scadenza da verificare</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-slate-800">
                    {auditKpis.commercial.dateUnknown}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Assenza certificata</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-red-700">
                    {auditKpis.commercial.absenceCertified}
                  </p>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                  <p className="text-xs text-emerald-800/80">Totale certificati</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-800">
                    {auditKpis.actionable}
                  </p>
                  {commercialSum !== auditKpis.actionable && (
                    <p className="mt-1 text-[10px] text-amber-700">
                      Sintesi categorie: {commercialSum} (allineamento in corso)
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Due sezioni distinte: rivalida esistenti vs trova nuove */}
        {(viewTab === "archive" || viewTab === "status") && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="space-y-3 p-5">
                <p className="text-sm font-semibold text-slate-900">Rivalida strutture esistenti</p>
                <p className="text-sm text-slate-600">
                  Job archivio: {terminalCompleted} / {archiveTarget} concluse ·{" "}
                  prese in carico {recordsTouched} ·{" "}
                  {archiveActive ? "in corso" : (archiveStatus?.statusLabel ?? "—")}
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-slate-900"
                    style={{ width: `${Math.min(100, archivePct)}%` }}
                  />
                </div>
                <Button type="button" disabled className="w-full bg-slate-800 text-white">
                  {archiveActive ? "Rivalidazione in corso" : "Rivalidazione archivio"}
                </Button>
                <p className="text-[11px] text-slate-500">
                  Non avvia un secondo processo. Pausa/ripresa solo da area amministrativa.
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardContent className="space-y-3 p-5">
                <p className="text-sm font-semibold text-slate-900">Trova nuove strutture</p>
                <p className="text-xs text-slate-500">Discovery territoriale (separata dalla rivalidazione)</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["Veneto", "Campania"] as const).map((region) => {
                    const d = discoveryMeta[region]
                    const mapsLabel =
                      d && d.citiesTotal > 0
                        ? `Comuni Maps ${d.mapsCityOffset}/${d.citiesTotal}`
                        : "Copertura Maps"
                    return (
                      <div key={region} className="rounded-lg border border-slate-200 p-3">
                        <p className="font-medium text-slate-900">{region}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {regionStats[region].done}/{regionStats[region].total} in archivio
                          {regionStats[region].pending > 0
                            ? ` · ${regionStats[region].pending} in coda`
                            : ""}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{mapsLabel}</p>
                        <Button
                          onClick={() => startRegionScan(region)}
                          disabled={isScanning}
                          className="mt-3 h-9 w-full bg-slate-900 text-white hover:bg-slate-800"
                        >
                          {isScanning && activeScan?.region === region ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Search className="h-4 w-4" />
                          )}
                          Cerca nuove strutture
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 h-8 w-full text-xs"
                          onClick={() => continueRegionScan(region)}
                          disabled={isScanning}
                        >
                          Continua copertura
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Area amministrativa collassabile */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/50">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            onClick={() => setTechOpen((v) => !v)}
          >
            <div>
              <p className="text-sm font-semibold text-slate-800">Dettagli tecnici e controlli</p>
              <p className="text-xs text-slate-500">Area amministrativa</p>
            </div>
            <span className="text-xs font-medium text-slate-500">{techOpen ? "Nascondi" : "Mostra"}</span>
          </button>
          {techOpen && (
            <div className="space-y-4 border-t border-slate-200 px-4 py-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs text-slate-500">Controllo identità</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">{auditKpis.REVIEW_HUMAN}</p>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs text-slate-500">Riprova automatica</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">{auditKpis.RETRY_PENDING}</p>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs text-slate-500">Blocco tecnico</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">{auditKpis.TECHNICAL_BLOCKED}</p>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs text-slate-500">Fuori ambito</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">{auditKpis.OUT_OF_SCOPE}</p>
                </div>
                <div className="rounded-lg border bg-white p-3">
                  <p className="text-xs text-slate-500">Non ancora certificati</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">{auditKpis.notYetCertified}</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    = archivio {auditKpis.total} − certificati {auditKpis.actionable}
                  </p>
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                <p className="text-xs font-semibold text-amber-900">Reset discovery (irreversibile)</p>
                <p className="mt-1 text-[11px] text-amber-800/80">
                  Non resetta la rivalidazione archivio. Richiede conferma esplicita.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(["Veneto", "Campania"] as const).map((region) => (
                    <Button
                      key={region}
                      variant="outline"
                      size="sm"
                      className="border-amber-300 text-amber-900"
                      disabled={isScanning}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Confermi il reset discovery per ${region}? Non interrompe la rivalidazione archivio.`
                          )
                        ) {
                          resetRegionScan(region)
                        }
                      }}
                    >
                      Reset {region}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live discovery job (se attivo) — fuori dal pannello rivalidazione */}
      {scanJob && (scanJob.status === "queued" || scanJob.status === "running" || scanJob.status === "interrupted") && (
        <Card className="border-slate-200 bg-slate-50/60">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">Ricerca nuove strutture in corso</p>
                <p className="text-xs text-slate-600">
                  {scanJob.lastUpdateLabel ?? "Verifica in corso"} · {formatDateTime(scanJob.updatedAt)}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void cancelScanJob()}>
                <PauseCircle className="h-4 w-4" /> Interrompi
              </Button>
            </div>
            <p className="text-sm text-slate-700">
              Controllate: {scanJob.progress.structuresControlled}
              {scanJob.progress.totalStructures ? ` / ${scanJob.progress.totalStructures}` : ""}
              {" · "}
              Certificati: {scanJob.progress.certifiedResults}
              {" · "}
              Controlli necessari: {scanJob.progress.manualChecksNeeded}
            </p>
          </CardContent>
        </Card>
      )}

      {/* TOOLBAR FILTRI */}
      <Card className="border-slate-200 shadow-sm">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:w-24">
            Filtra
          </p>
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

          <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5">
            {(
              [
                ["ALL", "Tutti"],
                ["HOT", "Assenza"],
                ["PUBLISHED", "Polizza"],
                ["REVIEW", "Controllo"],
                ["PENDING", "Da analizzare"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setVerdictFilter(key)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition",
                  verdictFilter === key
                    ? "bg-card shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
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
              guardScanAction(`Scansiona comune ${selectedCity}`, () => {
                void createScanJob({
                  mode: "city",
                  region,
                  city: selectedCity,
                  label: `Scansione comune · ${selectedCity} (${region})`,
                })
              })
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
                ? viewTab === "commercial"
                  ? "Coda commerciale vuota. I risultati certificati compariranno qui."
                  : viewTab === "status"
                    ? "Nessun caso in verifica pendente per i filtri selezionati."
                    : "Archivio vuoto. Usa «Trova nuove strutture» per avviare la discovery."
                : "Nessun risultato per i filtri selezionati."}
            </div>
          ) : (
            <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[18%]" />
                  <col className="w-[28%]" />
                  <col className="w-[16%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2.5 font-medium">Struttura</th>
                    <th className="px-3 py-2.5 font-medium">Contatti</th>
                    <th className="px-3 py-2.5 font-medium">Verdetto Gelli</th>
                    <th className="px-3 py-2.5 font-medium">Polizza RC</th>
                    <th className="px-3 py-2.5 font-medium">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {isScanning && processingName && (
                    <tr className="border-b border-indigo-200 bg-indigo-50/60">
                      <td colSpan={5} className="px-3 py-2.5">
                        <div className="flex items-center gap-2 text-xs text-indigo-900">
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                          <span>
                            <span className="font-medium">Analisi in corso — </span>
                            {processingName}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {filtered.map((l) => {
                    const docs = policyDocLinks(l)
                    const auditBadge =
                      viewTab === "archive" || viewTab === "status" ? auditQueueBadge(l) : null
                    const auditUi = auditBadge ? AUDIT_BADGE_UI[auditBadge] : null
                    const showScore = viewTab === "commercial" && (l.leadScore ?? 0) >= 80
                    return (
                    <tr
                      key={l.id}
                      className={cn(
                        "border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors duration-700",
                        auditBadge && "bg-slate-50/40"
                      )}
                    >
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex items-start gap-2">
                          {showScore && (
                            <span
                              className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums bg-red-50 text-red-700"
                              title="Priorità commerciale"
                            >
                              <Flame className="h-2.5 w-2.5" />
                              Alta
                            </span>
                          )}
                          <div className="min-w-0">
                            <button
                              onClick={() => setDetail(l)}
                              className="block w-full truncate text-left text-sm font-medium hover:text-primary hover:underline"
                              title={l.companyName}
                            >
                              {l.companyName}
                            </button>
                            {auditUi && (
                              <span
                                className={cn(
                                  "mt-1 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium",
                                  auditUi.cls
                                )}
                              >
                                {auditUi.label}
                              </span>
                            )}
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                              {l.city && (
                                <span className="inline-flex items-center gap-0.5">
                                  <MapPin className="h-2.5 w-2.5" />
                                  {l.city}
                                </span>
                              )}
                              <span className="text-slate-400">{l.region}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="space-y-0.5 text-[11px]">
                          {l.website ? (
                            <a
                              href={l.website}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 truncate text-primary hover:underline"
                              title={l.website}
                            >
                              <Globe className="h-3 w-3 shrink-0" />
                              <span className="truncate">{hostname(l.website)}</span>
                            </a>
                          ) : (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Globe className="h-3 w-3" /> nessun sito
                            </span>
                          )}
                          {l.phone && (
                            <a href={`tel:${l.phone}`} className="flex items-center gap-1 truncate hover:text-primary">
                              <Phone className="h-3 w-3 shrink-0" />
                              <span className="truncate">{l.phone}</span>
                            </a>
                          )}
                          {contactExtras(l) > 0 && (
                            <button
                              type="button"
                              onClick={() => setDetail(l)}
                              className="text-[10px] text-primary hover:underline"
                            >
                              +{contactExtras(l)} altri contatti
                            </button>
                          )}
                          {!l.website && !l.phone && contactExtras(l) === 0 && (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="space-y-1">
                          {verdictBadge(l)}
                          <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                            {strategyLine(l)}
                          </p>
                          {(!isHotPublishedExpired(l) && (docs.length > 0 || parseEvidenceSections(l.evidence).body)) && (
                            <button
                              type="button"
                              onClick={() => setDetail(l)}
                              className="text-[10px] text-primary hover:underline"
                            >
                              {docs.length > 0 ? `${docs.length} documento/i` : "Vedi evidenza"}
                            </button>
                          )}
                          {l.lastScannedAt && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground"
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
                      <td className="px-3 py-2.5 align-top text-[11px]">
                        {policyRcCell(l)}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <StatusSelect id={l.id} value={l.status} onChanged={(s) => updateStatus(l.id, s)} />
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
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
                <li><strong className="text-foreground">Archivio:</strong> strutture sanitarie già presenti nel database.</li>
                <li><strong className="text-foreground">Rivalidazione:</strong> verifica completa delle strutture esistenti (progresso reale nel pannello sopra).</li>
                <li><strong className="text-foreground">Coda commerciale:</strong> solo risultati certificati e utilizzabili.
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700">Assenza certificata</span>
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">Polizza pubblicata</span>
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700">Controllo necessario</span>
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
