/**
 * Esportazione CSV compatibile con Excel italiano:
 * - separatore ";"
 * - BOM UTF-8 per accenti corretti
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])

  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v)
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const csv = [
    headers.join(";"),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(";")),
  ].join("\r\n")

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
