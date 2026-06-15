import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import {
  Building2, Stethoscope, ArrowRight, ShieldAlert, Landmark,
  Euro, Activity, CheckCircle2,
} from "lucide-react"

export const dynamic = "force-dynamic"

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)

async function getStats() {
  try {
    const [healthcare, scanned, hot, tenders, tenderAgg] = await Promise.all([
      prisma.lead.count({ where: { type: "HEALTHCARE" } }),
      prisma.lead.count({ where: { type: "HEALTHCARE", lastScannedAt: { not: null } } }),
      prisma.lead.count({ where: { type: "HEALTHCARE", lastScannedAt: { not: null }, policyFound: false } }),
      prisma.lead.count({ where: { type: "TENDER" } }),
      prisma.lead.aggregate({ where: { type: "TENDER" }, _sum: { tenderAmount: true } }),
    ])
    return {
      healthcare, scanned, hot, tenders,
      cauzioni: (tenderAgg._sum.tenderAmount ?? 0) * 0.1,
    }
  } catch {
    return { healthcare: 0, scanned: 0, hot: 0, tenders: 0, cauzioni: 0 }
  }
}

export default async function Home() {
  const s = await getStats()

  const kpis = [
    { label: "Strutture sanitarie", value: s.healthcare.toLocaleString("it-IT"), icon: Stethoscope, hint: `${s.scanned} analizzate` },
    { label: "Lead caldi (RC sanità)", value: s.hot.toLocaleString("it-IT"), icon: ShieldAlert, hint: "senza polizza verificata", accent: true },
    { label: "Gare intercettate", value: s.tenders.toLocaleString("it-IT"), icon: Landmark, hint: "aziende aggiudicatarie" },
    { label: "Valore cauzioni", value: fmtMoney(s.cauzioni), icon: Euro, hint: "potenziale 10%" },
  ]

  return (
    <div className="space-y-10">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-card ring-soft">
        <div className="brand-gradient absolute inset-0 opacity-[0.06]" />
        <div className="relative px-6 py-10 sm:px-10 sm:py-14">
          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Activity className="h-3.5 w-3.5 text-primary" /> Dati reali · Veneto & Campania
          </span>
          <h1 className="mt-4 max-w-2xl text-3xl font-bold leading-tight text-balance sm:text-4xl">
            Trova in anticipo chi ha bisogno della tua{" "}
            <span className="brand-gradient-text">polizza</span>.
          </h1>
          <p className="mt-3 max-w-xl text-[15px] text-muted-foreground">
            Identifica con certezza le case di cura che non hanno pubblicato la RC professionale
            (Legge Gelli) e le aziende che hanno appena vinto un appalto pubblico.
            Niente dati inventati: solo fonti ufficiali.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/sanita" className="brand-gradient inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95">
              <Stethoscope className="h-4 w-4" /> Apri Motore Sanità <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/gare" className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-5 py-3 text-sm font-semibold transition hover:bg-muted">
              <Building2 className="h-4 w-4" /> Apri Motore Gare
            </Link>
          </div>
        </div>
      </section>

      {/* KPI */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="ring-soft border-border/60">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${k.accent ? "bg-red-50 text-red-600" : "bg-accent text-primary"}`}>
                  <k.icon className="h-4 w-4" />
                </span>
              </div>
              <div className={`mt-3 text-2xl font-bold tabular-nums ${k.accent ? "text-red-600" : ""}`}>{k.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{k.hint}</div>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* PRODOTTI */}
      <section className="grid gap-5 lg:grid-cols-2">
        <ProductCard
          href="/sanita"
          icon={<Stethoscope className="h-6 w-6" />}
          title="Sanità · RSA & Case di Cura"
          desc="Verifica automatica della pubblicazione della polizza RC professionale (L. 24/2017) sui siti delle strutture e sui portali regionali."
          points={[
            "Discovery reale da OpenStreetMap per ogni comune",
            "Lettura della sezione Amministrazione Trasparente",
            "Verdetto certo: pubblicata · lead caldo · da verificare",
          ]}
          cta="Apri motore Sanità"
          tone="primary"
        />
        <ProductCard
          href="/gare"
          icon={<Building2 className="h-6 w-6" />}
          title="Gare Pubbliche · Cauzioni"
          desc="Intercetta le aziende che hanno appena vinto un appalto e devono presentare la cauzione definitiva del 10%."
          points={[
            "Esiti di gara da fonti ufficiali (ANAC / portali regionali)",
            "Validazione CIG e aggiudicatario, nessun dato inventato",
            "Calcolo automatico dell'opportunità di cauzione",
          ]}
          cta="Apri motore Gare"
          tone="amber"
        />
      </section>
    </div>
  )
}

function ProductCard({
  href, icon, title, desc, points, cta, tone,
}: {
  href: string; icon: React.ReactNode; title: string; desc: string
  points: string[]; cta: string; tone: "primary" | "amber"
}) {
  const toneCls = tone === "primary"
    ? "bg-accent text-primary"
    : "bg-amber-50 text-amber-600"
  return (
    <Card className="group flex flex-col ring-soft border-border/60 transition hover:-translate-y-0.5 hover:shadow-lg">
      <CardContent className="flex flex-1 flex-col p-6">
        <div className={`grid h-12 w-12 place-items-center rounded-2xl ${toneCls}`}>{icon}</div>
        <h3 className="mt-4 text-lg font-semibold">{title}</h3>
        <p className="mt-1.5 text-sm text-muted-foreground">{desc}</p>
        <ul className="mt-4 space-y-2">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span className="text-foreground/80">{p}</span>
            </li>
          ))}
        </ul>
        <Link
          href={href}
          className="mt-6 inline-flex w-fit items-center gap-2 text-sm font-semibold text-primary hover:gap-3 transition-all"
        >
          {cta} <ArrowRight className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  )
}

