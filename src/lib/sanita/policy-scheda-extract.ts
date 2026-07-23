/**
 * Estrazione campi da "Scheda di Polizza" (tabelle PDF / OCR disordinato).
 * Generico: non dipende da struttura, URL o numero hardcodati.
 *
 * Priorità scadenza:
 * 1) "Scade alle ore 24 del …"
 * 2) Periodo di assicurazione (decorrenza → scadenza = 2ª data)
 * 3) Altri pattern scadenza espliciti
 *
 * Mai usare "Prossima quietanza" / date in "Dati di pagamento" come expiry.
 */
export type SchedaPolizzaFields = {
  policyNumber: string | null;
  decorrenza: Date | null;
  expiry: Date | null;
  nextPayment: Date | null;
  contraente: string | null;
};

function parseItalianDate(raw: string): Date | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

const DATE_RE = /(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/g;

/** Rimuove/neutralizza date di quietanza così non diventano expiry. */
export function stripQuietanzaDates(text: string): string {
  let t = text;
  // Prossima quietanza: … DATE
  t = t.replace(
    /prossima\s+quietanza[^\n\d]{0,80}\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}/gi,
    " "
  );
  // Blocco "Dati di pagamento" … fino a Premio: azzera le date lì dentro
  t = t.replace(
    /dati\s+di\s+pagamento[\s\S]{0,400}?(?=premio|scheda\s+di\s+polizza|$)/gi,
    (block) => block.replace(DATE_RE, " __QUIETANZA__ ")
  );
  // "quietanza … DATE" generico
  t = t.replace(
    /quietanza[^\n\d]{0,60}\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}/gi,
    " "
  );
  return t;
}

function findNextPayment(text: string): Date | null {
  const m =
    text.match(
      /prossima\s+quietanza[^\n\d]{0,80}(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i
    ) ||
    text.match(
      /dati\s+di\s+pagamento[\s\S]{0,220}?(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i
    );
  return m?.[1] ? parseItalianDate(m[1]) : null;
}

function findScadeAlleOre24(text: string): Date | null {
  const patterns = [
    /scade\s+alle\s+ore\s+24(?:[:.]?00)?\s+del\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
    /fino\s+alle\s+ore\s+24(?:[:.]?00)?\s+del\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
    /alle\s+ore\s+24(?:[:.]?00)?\s+del\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const d = parseItalianDate(m[1]);
      if (d) return d;
    }
  }
  return null;
}

/** Periodo di assicurazione: due date → decorrenza + scadenza. */
function findPeriodoAssicurazione(text: string): {
  decorrenza: Date | null;
  expiry: Date | null;
} {
  const block =
    text.match(
      /periodo\s+di\s+assicurazione[\s\S]{0,280}/i
    )?.[0] ||
    text.match(/periodo\s+assicurativ[oa][\s\S]{0,280}/i)?.[0] ||
    text.match(
      /decorrenza[\s\S]{0,40}?scadenza[\s\S]{0,120}/i
    )?.[0] ||
    "";
  if (!block) return { decorrenza: null, expiry: null };
  // Non usare quietanza residue nel blocco
  const cleaned = stripQuietanzaDates(block);
  const dates = [...cleaned.matchAll(DATE_RE)]
    .map((m) => parseItalianDate(m[1]))
    .filter((d): d is Date => Boolean(d));
  if (dates.length >= 2) {
    // Ordina cronologicamente: prima = decorrenza, ultima = scadenza
    dates.sort((a, b) => a.getTime() - b.getTime());
    return { decorrenza: dates[0], expiry: dates[dates.length - 1] };
  }
  if (dates.length === 1) return { decorrenza: null, expiry: dates[0] };
  return { decorrenza: null, expiry: null };
}

function findSchedaPolicyNumber(text: string): string | null {
  const patterns = [
    /polizza\s*n[°ºo.]?\s*[:\-]?\s*(RCI[0-9]{6,})/i,
    /\b(RCI[0-9]{8,})\b/i,
    /n[°º.]?\s*polizza\s*[:\-]?\s*([A-Z]{2,5}[0-9]{6,})/i,
    /numero\s+polizza\s*[:\-]?\s*([A-Z0-9][A-Z0-9_./-]{5,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = m[1].trim().toUpperCase().replace(/\s+/g, "");
      if (n.length >= 5) return n;
    }
  }
  return null;
}

function findContraente(text: string): string | null {
  const m = text.match(
    /(?:dati\s+del\s+)?contraente(?:\s*\/\s*assicurato)?[\s:\-]*([A-Z0-9][A-Z0-9\s.&'\/\-]{8,80}?)(?:\s+\d{11}|\s+VIA\b|\s+P\.?\s*IVA|$)/i
  );
  if (!m?.[1]) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

/**
 * Estrae campi scheda. Preferire sempre Scade-alle-ore-24 rispetto a quietanza.
 */
export function extractSchedaPolizzaFields(text: string): SchedaPolizzaFields {
  const raw = (text || "").replace(/\u00a0/g, " ");
  const nextPayment = findNextPayment(raw);
  const withoutQuietanza = stripQuietanzaDates(raw);

  const scade24 = findScadeAlleOre24(withoutQuietanza) || findScadeAlleOre24(raw);
  const periodo = findPeriodoAssicurazione(withoutQuietanza);

  let expiry = scade24 || periodo.expiry;
  // Guard: se expiry coincide con quietanza → scarta (mai quietanza come scadenza)
  if (
    expiry &&
    nextPayment &&
    expiry.getUTCFullYear() === nextPayment.getUTCFullYear() &&
    expiry.getUTCMonth() === nextPayment.getUTCMonth() &&
    expiry.getUTCDate() === nextPayment.getUTCDate()
  ) {
    expiry = periodo.expiry && periodo.expiry.getTime() !== nextPayment.getTime()
      ? periodo.expiry
      : null;
  }

  return {
    policyNumber: findSchedaPolicyNumber(raw),
    decorrenza: periodo.decorrenza,
    expiry,
    nextPayment,
    contraente: findContraente(raw),
  };
}
