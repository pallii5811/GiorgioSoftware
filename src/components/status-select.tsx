"use client"

import { useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const OPTIONS = [
  { value: "NEW", label: "Nuovo" },
  { value: "CONTACTED", label: "Contattato" },
  { value: "CONVERTED", label: "Convertito" },
  { value: "LOST", label: "Perso" },
]

const STYLE: Record<string, string> = {
  NEW: "bg-blue-50 text-blue-700 border-blue-200",
  CONTACTED: "bg-amber-50 text-amber-700 border-amber-200",
  CONVERTED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  LOST: "bg-muted text-muted-foreground border-border",
}

export function StatusSelect({
  id, value, onChanged,
}: {
  id: string
  value: string
  onChanged?: (status: string) => void
}) {
  const [status, setStatus] = useState(value || "NEW")
  const [saving, setSaving] = useState(false)

  const update = async (next: string) => {
    const prev = status
    setStatus(next)
    setSaving(true)
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: next }),
      })
      const json = await res.json()
      if (!json.success) throw new Error()
      onChanged?.(next)
    } catch {
      setStatus(prev)
      toast.error("Impossibile aggiornare lo stato")
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      value={status}
      disabled={saving}
      onChange={(e) => update(e.target.value)}
      className={cn(
        "cursor-pointer rounded-md border px-2 py-1 text-xs font-medium outline-none transition",
        STYLE[status] ?? STYLE.NEW
      )}
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value} className="bg-card text-foreground">
          {o.label}
        </option>
      ))}
    </select>
  )
}
