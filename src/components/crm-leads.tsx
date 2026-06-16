"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusSelect } from "@/components/status-select";
import { LeadDetail } from "@/components/lead-detail";
import { Download, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/export-csv";

type Lead = {
  id: string;
  type: string;
  companyName: string;
  region: string;
  city: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  pec: string | null;
  piva: string | null;
  status: string;
  notes: string | null;
  reminderAt: string | null;
  policyCompany: string | null;
  policyMassimale: string | null;
  policyNumber: string | null;
  policyExpiry: string | null;
  evidence: string | null;
  lastScannedAt: string | null;
  leadScore: number | null;
  category: string | null;
};

export function CrmLeads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [type, setType] = useState<string>("ALL");
  const [region, setRegion] = useState<string>("ALL");

  const fetchAll = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("includePending", "1");
      if (q.trim()) params.set("q", q.trim());
      if (status !== "ALL") params.set("status", status);
      if (type !== "ALL") params.set("type", type);
      if (region !== "ALL") params.set("region", region);
      const res = await fetch(`/api/leads?${params.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error();
      setLeads(json.data as Lead[]);
    } catch {
      toast.error("Errore nel caricamento CRM");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) set.add(l.type);
    return [...set].sort();
  }, [leads]);

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) set.add(l.region);
    return [...set].sort((a, b) => a.localeCompare(b, "it"));
  }, [leads]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (status !== "ALL" && l.status !== status) return false;
      if (type !== "ALL" && l.type !== type) return false;
      if (region !== "ALL" && l.region !== region) return false;
      if (!qq) return true;
      return (
        `${l.companyName} ${l.city ?? ""} ${l.website ?? ""} ${l.email ?? ""} ${l.pec ?? ""} ${l.phone ?? ""} ${l.piva ?? ""}`
          .toLowerCase()
          .includes(qq)
      );
    });
  }, [leads, q, status, type, region]);

  const exportCsv = () => {
    const rows = filtered.map((l) => ({
      ID: l.id,
      Tipo: l.type,
      Regione: l.region,
      Città: l.city ?? "",
      Struttura: l.companyName,
      Stato: l.status,
      Sito: l.website ?? "",
      Tel: l.phone ?? "",
      Email: l.email ?? "",
      PEC: l.pec ?? "",
      PIVA: l.piva ?? "",
      Promemoria: l.reminderAt ?? "",
      Note: l.notes ?? "",
      "Polizza compagnia": l.policyCompany ?? "",
      "Polizza massimale": l.policyMassimale ?? "",
      "Polizza n.": l.policyNumber ?? "",
      "Polizza scadenza": l.policyExpiry ?? "",
    }));
    downloadCsv("crm-leads.csv", rows);
  };

  const applyPatch = (patch: Partial<Lead>) => {
    if (!detail) return;
    setDetail({ ...detail, ...patch });
    setLeads((prev) => prev.map((l) => (l.id === detail.id ? { ...l, ...patch } : l)));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">CRM Lead</h1>
          <p className="text-sm text-muted-foreground">Gestione stato, note e promemoria su tutti i lead.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCsv} className="h-10">
            <Download className="h-4 w-4" /> Esporta CSV
          </Button>
          <Button variant="outline" onClick={() => void fetchAll()} className="h-10" disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Ricarica
          </Button>
        </div>
      </div>

      <Card className="border-border/60">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca per nome, città, sito, contatti…" className="pl-9" />
              {q && (
                <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-md border bg-card px-2 text-sm">
              <option value="ALL">Tutti stati</option>
              <option value="NEW">Nuovo</option>
              <option value="CONTACTED">Contattato</option>
              <option value="CONVERTED">Convertito</option>
              <option value="LOST">Perso</option>
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)} className="h-10 rounded-md border bg-card px-2 text-sm">
              <option value="ALL">Tutti tipi</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select value={region} onChange={(e) => setRegion(e.target.value)} className="h-10 rounded-md border bg-card px-2 text-sm">
              <option value="ALL">Tutte regioni</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button onClick={() => void fetchAll()} disabled={loading} className="h-10">
              Ricarica lista
            </Button>
          </div>

          <div className="text-sm text-muted-foreground">{loading ? "Caricamento…" : `${filtered.length} lead`}</div>

          <div className="overflow-auto rounded-lg border">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Struttura</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Regione</th>
                  <th className="px-3 py-2 text-left">Contatti</th>
                  <th className="px-3 py-2 text-left">Stato</th>
                  <th className="px-3 py-2 text-left">Promemoria</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id} className="border-t hover:bg-muted/30 cursor-pointer" onClick={() => setDetail(l)}>
                    <td className="px-3 py-2 font-medium">{l.companyName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.type}</td>
                    <td className="px-3 py-2">
                      {l.region}
                      {l.city ? <span className="text-muted-foreground"> · {l.city}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {l.phone ?? "—"}
                      {l.email ? <span className="ml-2">{l.email}</span> : null}
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <StatusSelect
                        id={l.id}
                        value={l.status}
                        onChanged={(s) => setLeads((p) => p.map((x) => (x.id === l.id ? { ...x, status: s } : x)))}
                      />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {l.reminderAt ? new Intl.DateTimeFormat("it-IT").format(new Date(l.reminderAt)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {detail && (
        <LeadDetail
          lead={detail}
          callScript={null}
          onClose={() => setDetail(null)}
          onUpdated={applyPatch}
        />
      )}
    </div>
  );
}

