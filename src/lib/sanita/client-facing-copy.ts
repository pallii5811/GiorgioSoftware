/**
 * Client-facing Sanità copy — presentation only (no scoring/gates).
 */

export const CLIENT_VERDICT = {
  HOT: {
    label: "Polizza non trovata dopo verifica completa",
    subtitle: "Verifica completa sul sito — pubblicazione non trovata",
  },
  PUBLISHED: {
    label: "Polizza pubblicata",
    subtitle: "Documento assicurativo trovato online",
  },
  REVIEW: {
    label: "Controllo necessario",
    subtitle: "Esito non conclusivo — serve un controllo",
  },
} as const;

export const CLIENT_PUBLISHED = {
  PUBLISHED_CURRENT: "Polizza pubblicata e valida",
  PUBLISHED_EXPIRED: "Polizza pubblicata ma scaduta",
  PUBLISHED_DATE_UNKNOWN: "Polizza trovata — scadenza da verificare",
  PUBLISHED_INCOMPLETE: "Pubblicazione assicurativa incompleta",
  PUBLISHED_ANALOGOUS_MEASURE: "Misura analoga pubblicata",
  PUBLISHED_STALE_DOCUMENT: "Documento pubblicato ma non aggiornato",
  SELF_INSURANCE_VERIFIED: "Autoassicurazione dichiarata",
} as const;

export const CLIENT_QUEUE_BADGE = {
  LEGACY: { label: "Da rivalidare", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  IN_REVALIDATION: { label: "Da rivalidare", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  RETRY: { label: "Verifica tecnica da completare", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  REVIEW_IDENTITY: { label: "Controllo necessario", cls: "bg-amber-50 text-amber-900 border-amber-200" },
  TECHNICAL: { label: "Verifica tecnica da completare", cls: "bg-rose-50 text-rose-800 border-rose-200" },
} as const;
