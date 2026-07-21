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
  Info, Zap, RotateCcw,
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
import { consumeSanitaScanStream } from "@/lib/sanita/scan-sse-client"
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
type ViewTab = "audit" | "commercial"

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
    LEGACY: number
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
  const [discoveryMeta, setDiscoveryMeta] = useState<Record<string, RegionDiscoveryMeta>>({})
  const [processingName, setProcessingName] = useState<string | null>(null)
  const [freshLeadIds, setFreshLeadIds] = useState<Set<string>>(new Set())
  const [viewTab, setViewTab] = useState<ViewTab>("audit")
  const [apiMeta, setApiMeta] = useState<SanitaApiMeta | null>(null)

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

  /** All'avvio carica i lead già salvati nel database condiviso. */
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchLeads({ silent: true });
    }, 0);
    return () => clearTimeout(t);
  }, []);

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

  const revalidationUiLock = Boolean(
    apiMeta?.revalidationUiLock ??
      ((apiMeta?.actionableCount ?? 0) === 0 && (apiMeta?.dbTotal ?? leads.length) > 0)
  )

  const guardScanAction = (label: string, run: () => void) => {
    if (revalidationUiLock) {
      const ok = confirm(
        `${label}\n\nRivalidazione completa in corso (coda commerciale fail-closed).\n` +
          `Avviare comunque una scansione regionale rischia conflitti con giorgio-revalidate.\n\nConfermi esplicitamente?`
      )
      if (!ok) return
    }
    run()
  }

  const startRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Scansiona ${region}`, () => {
      void runFullScan({ region, continueAnalysis: false })
    })
  }

  const continueRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Continua ${region}`, () => {
      void runFullScan({ region, continueAnalysis: true })
    })
  }

  const resetRegionScan = (region: "Veneto" | "Campania") => {
    guardScanAction(`Reset ${region}`, () => {
      if (!confirm(`Reset ${region}: cancella i lead e riparte da zero. Confermi?`)) return
      try {
        window.localStorage.removeItem(`sanita.scan.${region}`)
      } catch {
        /* */
      }
      void runFullScan({ region, reset: true })
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
    return base
  }, [leads, viewTab])

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
        RETRY_PENDING: k.RETRY_PENDING,
        REVIEW_HUMAN: k.REVIEW_HUMAN,
        TECHNICAL_BLOCKED: k.TECHNICAL_BLOCKED,
        OUT_OF_SCOPE: k.OUT_OF_SCOPE,
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
      actionable = 0,
      inRevalidation = 0
    for (const l of leads) {
      if (isLeadActionable(l)) actionable++
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
    }
    return {
      total: apiMeta?.dbTotal ?? leads.length,
      actionable: apiMeta?.actionableCount ?? actionable,
      HOT_VERIFIED,
      PUBLISHED_CURRENT,
      PUBLISHED_EXPIRED,
      PUBLISHED_DATE_UNKNOWN,
      inRevalidation: apiMeta?.kpis?.inRevalidation ?? inRevalidation,
      RETRY_PENDING,
      REVIEW_HUMAN,
      TECHNICAL_BLOCKED,
      OUT_OF_SCOPE,
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

  const AUDIT_KPIS: Array<{ key: string; label: string; value: number; cls?: string }> = [
    { key: "total", label: "Strutture totali", value: auditKpis.total },
    { key: "actionable", label: "Certificati vendibili", value: auditKpis.actionable, cls: "text-emerald-700" },
    { key: "HOT_VERIFIED", label: "HOT_VERIFIED", value: auditKpis.HOT_VERIFIED, cls: "text-red-600" },
    { key: "PUBLISHED_CURRENT", label: "PUBLISHED_CURRENT", value: auditKpis.PUBLISHED_CURRENT, cls: "text-emerald-600" },
    { key: "PUBLISHED_EXPIRED", label: "PUBLISHED_EXPIRED", value: auditKpis.PUBLISHED_EXPIRED, cls: "text-amber-700" },
    { key: "PUBLISHED_DATE_UNKNOWN", label: "PUBLISHED_DATE_UNKNOWN", value: auditKpis.PUBLISHED_DATE_UNKNOWN, cls: "text-amber-600" },
    { key: "inRevalidation", label: "In rivalidazione", value: auditKpis.inRevalidation, cls: "text-indigo-700" },
    { key: "RETRY_PENDING", label: "RETRY_PENDING", value: auditKpis.RETRY_PENDING, cls: "text-sky-700" },
    { key: "REVIEW_HUMAN", label: "REVIEW_HUMAN", value: auditKpis.REVIEW_HUMAN, cls: "text-amber-700" },
    { key: "TECHNICAL_BLOCKED", label: "TECHNICAL_BLOCKED", value: auditKpis.TECHNICAL_BLOCKED, cls: "text-rose-700" },
    { key: "OUT_OF_SCOPE", label: "OUT_OF_SCOPE", value: auditKpis.OUT_OF_SCOPE, cls: "text-slate-600" },
  ]

  return (
    <div className="space-y-6">
      {/* HEADER — gerarchia: titolo → dati → scansioni per regione */}
      <div className="space-y-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <span className="brand-gradient grid h-9 w-9 place-items-center rounded-xl text-white shadow-sm">
              <Stethoscope className="h-5 w-5" />
            </span>
            Motore Sanità · Legge Gelli
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Trova strutture private, verifica se la polizza RC è pubblicata online (Art.&nbsp;10) e classifica i lead per priorità commerciale.
          </p>
        </div>

        {revalidationUiLock && (
          <div className="rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-3 text-sm text-indigo-950">
            <p className="font-semibold">Rivalidazione completa in corso</p>
            <p className="mt-1 text-[13px] leading-relaxed text-indigo-900/90">
              I record non certificati sono visibili soltanto per audit e non fanno parte della coda commerciale.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">A · Totale database</p>
              <p className="mt-2 text-3xl font-bold tabular-nums">{auditKpis.total}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Tutte le strutture HEALTHCARE in DB</p>
            </CardContent>
          </Card>
          <Card className="border-emerald-200/80 bg-emerald-50/40 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800/80">B · Coda commerciale certificata</p>
              <p className="mt-2 text-3xl font-bold tabular-nums text-emerald-800">{auditKpis.actionable}</p>
              <p className="mt-1 text-[11px] text-emerald-900/70">Fail-closed · solo evidence corrente vendibile</p>
            </CardContent>
          </Card>
        </div>

        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setViewTab("audit")}
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition",
              viewTab === "audit" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Tutte le strutture / Audit
          </button>
          <button
            type="button"
            onClick={() => setViewTab("commercial")}
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition",
              viewTab === "commercial" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Coda commerciale certificata
          </button>
        </div>

        <Card className="border-border/60 shadow-sm">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dati</p>
                <p className="text-[11px] text-muted-foreground">
                  CSV cliente = solo certificati · vista {viewTab === "audit" ? "audit" : "commerciale"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={isScanning}>
                  <Download className="h-4 w-4" /> Esporta CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => void fetchLeads()} disabled={isScanning}>
                  <RefreshCw className="h-4 w-4" /> Carica salvati
                </Button>
              </div>
            </div>

            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Scansione territoriale
                {revalidationUiLock ? " · protetta (rivalidazione attiva)" : ""}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["Veneto", "Campania"] as const).map((region) => (
                  <div
                    key={region}
                    className="rounded-xl border border-border/70 bg-gradient-to-b from-card to-muted/20 p-4"
                  >
                    <p className="text-sm font-semibold text-foreground">{region}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {regionStats[region].done}/{regionStats[region].total} strutture analizzate
                      {regionStats[region].pending > 0
                        ? ` · ${regionStats[region].pending} pending`
                        : ""}
                    </p>
                    <Button
                      onClick={() => startRegionScan(region)}
                      disabled={isScanning}
                      title={
                        revalidationUiLock
                          ? "Richiede conferma: rivalidazione in corso"
                          : undefined
                      }
                      className={cn(
                        "mt-3 h-10 w-full text-white shadow-sm",
                        revalidationUiLock
                          ? "bg-amber-600 hover:bg-amber-700"
                          : "bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700"
                      )}
                    >
                      {isScanning && activeScan?.region === region ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="h-4 w-4" />
                      )}
                      Scansiona {region}
                    </Button>
                    <div className="mt-2 flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 flex-1 text-xs"
                        onClick={() => continueRegionScan(region)}
                        disabled={isScanning}
                        title={
                          revalidationUiLock
                            ? "Richiede conferma: rivalidazione in corso"
                            : undefined
                        }
                      >
                        Continua
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 flex-1 text-xs text-muted-foreground"
                        onClick={() => resetRegionScan(region)}
                        disabled={isScanning}
                        title={
                          revalidationUiLock
                            ? "Richiede conferma: rivalidazione in corso"
                            : undefined
                        }
                      >
                        Reset
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
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

      {/* KPI audit (meta.kpis) — non calcolati solo dall'array filtrato */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {AUDIT_KPIS.map((k) => (
          <Card key={k.key} className="ring-soft border-border/60">
            <CardContent className="p-3">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {k.label}
              </span>
              <div className={cn("mt-1 text-xl font-bold tabular-nums", k.cls)}>{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* TOOLBAR FILTRI */}
      <Card className="ring-soft border-border/60">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground lg:w-24">
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
                ["HOT", "HOT"],
                ["PUBLISHED", "PUB"],
                ["REVIEW", "Review"],
                ["PENDING", "Pending"],
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
                void runFullScan({ region, city: selectedCity, continueAnalysis: false })
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
                  ? "Coda commerciale vuota (fail-closed). I record in DB restano nella tab Audit."
                  : "Tabella vuota. Clicca Scansiona Veneto o Campania — i lead compariranno uno alla volta, in tempo reale."
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
                    const auditBadge = viewTab === "audit" ? auditQueueBadge(l) : null
                    const auditUi = auditBadge ? AUDIT_BADGE_UI[auditBadge] : null
                    return (
                    <tr
                      key={l.id}
                      className={cn(
                        "border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors duration-700",
                        freshLeadIds.has(l.id) && "bg-emerald-50/80 ring-1 ring-inset ring-emerald-200",
                        auditBadge && "bg-slate-50/50"
                      )}
                    >
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex items-start gap-2">
                          <span
                            className={cn(
                              "mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                              scoreMeta(l.leadScore).cls
                            )}
                            title={scoreMeta(l.leadScore).label}
                          >
                            <Flame className="h-2.5 w-2.5" />
                            {l.leadScore ?? 0}
                          </span>
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
                                  "mt-1 inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wide",
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
                              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                {l.region}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground" title={scopeReason(l)}>
                              {scopeReason(l)}
                            </p>
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
                <li><strong className="text-foreground">Scoperta:</strong> individua case di cura, RSA e poliambulatori su tutto il territorio regionale, integrando l&apos;elenco ufficiale del Ministero della Salute.</li>
                <li><strong className="text-foreground">Verifica:</strong> analizza il sito web di ogni struttura, con focus sulla sezione Trasparenza e sui documenti PDF allegati.</li>
                <li><strong className="text-foreground">Classificazione:</strong>
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700"><ShieldAlert className="h-3 w-3" />Assenza certificata</span> — crawl completo, polizza non trovata; priorità commerciale
                  <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700"><ShieldCheck className="h-3 w-3" />Polizza pubblicata</span> — verifica validità/scadenza (non assume conformità)
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
