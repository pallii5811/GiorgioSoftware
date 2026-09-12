/**
 * Target commerciale giorg.io sanità: strutture private soggette all'art. 10
 * L. 24/2017 (Gelli-Bianco) — obbligo di pubblicare polizza RC sul sito.
 *
 * Fonte unica per discovery Maps, gate consegna e pulizia DB.
 */

/** Accreditati Ministero Salute — sempre in scope. */
export function isMinSaluteAccredited(osmId: string | null | undefined): boolean {
  return Boolean(osmId?.startsWith("min-salute/"));
}

/** Categoria Maps che identifica una struttura (non un professionista singolo). */
const GELLI_MAPS_CATEGORY =
  /casa di cura|clinica|ospedal|rsa|casa di riposo|residenza\s+(sanitaria|assistenz|per\s+anziani)|poliambulator|laboratorio\s+(analisi|di\s+analisi)|centro\s+di\s+riabilit|riabilitaz|fisioterap|diagnostic|day\s+hospital|hospice|nursing\s+home|lungodegen|dialisi|emodialisi|istituto\s+(di\s+)?cura/i;

/**
 * Nome che indica una struttura sanitaria privata soggetta a pubblicazione polizza.
 * Esclude studi individuali, enti pubblici, associazioni e attività non sanitarie.
 */
const GELLI_STRUCTURE_NAME =
  /casa\s+di\s+cura|clinica\b|ospedal|policlinic|rsa\b|casa\s+di\s+riposo|residenza\s+sanitaria|residenza\s+assistenz|residenza\s+per\s+anziani|casa\s+protetta|poliambulator|polidiagnostic|istituto\s+(di\s+)?cura|istituto\s+clinico|day\s+hospital|hospice\b|centro\s+riabilit|centro\s+di\s+riabilit|fisioterap|riabilitaz|centro\s+diagnostic|centro\s+medic|laboratorio\s+(analisi|di\s+analisi)|analisi\s+clinic|dialisi|emodialisi|lungodegen|radioterap|radiochirurg|radio\s*surgery|oncolog|cardiolog|neurochirurg|presidio\s+privat|nursing\s+home|sanitaria\s+assistenziale/i;

/** Professionista singolo / attività NON soggetta come struttura Gelli. */
const SOLO_PROFESSIONISTA_O_FUORI_SCOPE =
  /\bstudio\s+medico\b|\bstudio\s+dentistic|\bdentistico\b|odontoiatr|\bpsicolog|\blogoped|\bdietolog|\bnutrizion|\bpodolog|\binfermiere\s+profession|\bfarmacia\b|\bparafarmacia\b|\bottic[ao]\b|\bveterinar|\bmedico\s+di\s+base\b|\bmedico\s+generico\b|\bpediatra\s+libero\b|\bspecialista\s+ambulatoriale\b/i;

/** Enti pubblici, associazioni, settori non target. */
const HARD_EXCLUDE =
  /immobiliar|tecnocasa|tempocasa|remax|prestit|finanziament|compass|banca\b|assicurazion|agenzia\s+viagg|hotel\b|resort\b|b&b\b|bed\s+and\s+breakfast|affittacamere|vacanz|ristorant|pizzeri|trattoria|home\s+restaurant|caff[eè]\b|parrucchier|centro\s+estetic|istituto\s+di\s+bellezza|palestra\b|autofficin|carrozzeri|gommist|supermercat|onoranze|pompe\s+funebr|avvocat|notai\b|commercialist|geometr|architett|scuola\s+guida|autoscuol|tabacch|edicol|ferrament|agrari\b|on-? ?line|portale\s+web|abcsalute|\blilt\b|lega\s+italiana.*tumor|associazione\s+di\s+promozione|\baps\b|comitato\s+di\s+volontariato|fondazione\s+assistenza\s+e\s+preghiera|scuola\s+primaria|scuola\s+elementare|scuola\s+media|\bistituto\s+comprensivo\b|museo\b|chiesa\b|parrocch|basilic[aà]\b|comunit[aà]\s+alloggio\s+minori/i;

/** Uffici ASL/ULSS pubblici — non case di cura private. */
const PUBLIC_HEALTH_OFFICE =
  /\bdistretto\b|\bulss\b.*distretto|distretto\s+sanit|azienda\s+sanitaria\s+locale|presidio\s+ospedaliero(?!\s+privat)|presidio\s+ospedaliero\s+pubblic|ospedale\s+pubblico|ospedale\s+civile|guardia\s+medica|direzione\s+generale\s+asl|dipartimento\s+di\s+prevenzione|^asl\b|\basl\s+[a-z0-9]{1,4}\b|\basl\s*\(|ex\s+manicomio|aslnapoli|aslcaserta|aslbn\b|presidio\s+ospedaliero\s+san\s+|azienda\s+ospedaliera|\baorn\b|\baou\b|irccs\s+pubblic/i;

/** Terme wellness / consultori pubblici — fuori scope broker RC strutture private. */
const WELLNESS_NON_GELLI =
  /\bterme\b(?!\s+sanitar)|\bstabilimento\s+termale\b|\bconsultorio\s+familiare\b|\bconsultorio\b/i;

export type GelliScopeResult = {
  ok: boolean;
  reason: string;
};

const ASSISTENTIAL_ONLY =
  /casa\s+di\s+riposo|residenza\s+assistenz|residenza\s+per\s+anziani|casa\s+albergo|casa\s+alloggio|casa\s+protetta|\brsa\b|nursing\s+home|alloggio\s+per\s+anziani/i;

const CLINICAL_SIGNAL =
  /casa\s+di\s+cura|clinica\b|ospedal|policlinic|day\s+hospital|centro\s+medic|laboratorio|diagnostic|accreditat|riabilit|fisioterap|sanitaria\s+assistenziale|presidio\s+ospedalier/i;

/**
 * Il nome comincia con un odonimo: e' un indirizzo, non il nome di un ente.
 * Ancorato all'inizio, perche' "Villa Corso" o "Clinica Largo Augusto" sono
 * nomi legittimi e non devono cadere qui.
 */
const ODONIMO_INIZIALE =
  /^(via|viale|v\.le|vicolo|piazza|p\.zza|piazzale|largo|corso|c\.so|strada|str\.|localit[aà]|loc\.|contrada|c\.da|borgo|traversa|lungomare|lungotevere|circonvallazione|salita|discesa|rotonda)\b/i;

/**
 * Parole che, dentro il NOME, dicono che si tratta di una struttura.
 *
 * Elenco a parte, non CLINICAL_SIGNAL, per due ragioni misurate:
 *  - CLINICAL_SIGNAL non contiene "poliambulatorio", e "Via Roma
 *    Poliambulatorio" veniva scartata a torto;
 *  - CLINICAL_SIGNAL e' usato altrove con significati diversi, e allargarlo
 *    avrebbe cambiato comportamenti che qui non c'entrano.
 */
const SEGNALE_STRUTTURA_NEL_NOME =
  /casa\s+di\s+cura|clinic|ospedal|hospital|policlinic|poliambulator|ambulator|day\s+hospital|centro\s+(medic|diagnostic|sanitari|odontoiatr|fisioterap|riabilitat)|laboratorio\s+analisi|diagnostic|residenza\s+sanitaria|\brsa\b|istituto\s+(clinic|sanitari|ortopedic)|riabilit|fisioterap|odontoiatr|dentist|presidio|medical\s+center|villa\s+.*(cura|clinic|sanitari)/i;

/** Comuni, Province, Regioni e loro uffici: enti territoriali, non strutture. */
const ENTE_PUBBLICO_TERRITORIALE =
  /^(comune\s+di|citt[aà]\s+di|municipio|provincia\s+di|regione\s+[a-z])|^ufficio\s+(anagrafe|tecnico|protocollo)|anagrafe\s+comunal|servizi\s+demografic/i;

export function classifyGelliScope(
  companyName: string,
  category: string | null | undefined,
  osmId?: string | null
): GelliScopeResult {
  if (isMinSaluteAccredited(osmId)) {
    return { ok: true, reason: "Accreditato Ministero Salute" };
  }

  const name = (companyName || "").trim();
  const hay = `${name} ${category ?? ""}`;

  if (!name) return { ok: false, reason: "Nome vuoto" };

  // Un indirizzo non e' una struttura, e un Comune nemmeno.
  //
  // Google Maps restituisce anche schede il cui nome e' un odonimo o un ente
  // pubblico, e gli attribuisce una categoria sanitaria plausibile. Il
  // controllo sulla categoria, piu' sotto, le fa passare: "Via Guido Rossa
  // Acquapendente" e' entrata in archivio come "Casa di cura per lungodegenti",
  // col telefono e la PEC del Comune.
  //
  // Il rifiuto vale SOLO se nel nome non c'e' nessun segnale clinico: cosi'
  // "Corso Italia Medical Center" o "Via Roma Poliambulatorio" restano dentro,
  // perche' quelle sono strutture che si chiamano come la via dove stanno.
  // Si guarda il NOME, non "nome + categoria": la categoria e' proprio la
  // cosa inaffidabile — e' lei che ha fatto entrare "Via Guido Rossa
  // Acquapendente" etichettandola "Casa di cura per lungodegenti".
  if (ODONIMO_INIZIALE.test(name) && !SEGNALE_STRUTTURA_NEL_NOME.test(name)) {
    return { ok: false, reason: "Il nome e' un indirizzo, non una struttura" };
  }
  if (ENTE_PUBBLICO_TERRITORIALE.test(name)) {
    return { ok: false, reason: "Ente territoriale, non struttura sanitaria" };
  }

  if (HARD_EXCLUDE.test(hay)) return { ok: false, reason: "Attività non sanitaria" };
  if (PUBLIC_HEALTH_OFFICE.test(hay)) return { ok: false, reason: "Ufficio/distretto ASL pubblico" };
  if (WELLNESS_NON_GELLI.test(hay)) return { ok: false, reason: "Terme/consultorio fuori scope" };
  if (SOLO_PROFESSIONISTA_O_FUORI_SCOPE.test(hay)) {
    return { ok: false, reason: "Professionista singolo / farmacia — non struttura Gelli" };
  }
  if (
    !isMinSaluteAccredited(osmId) &&
    ASSISTENTIAL_ONLY.test(hay) &&
    !CLINICAL_SIGNAL.test(hay)
  ) {
    return { ok: false, reason: "RSA/residenza solo assistenziale — fuori target art. 10" };
  }

  const cat = category?.trim() ?? "";
  if (cat && GELLI_MAPS_CATEGORY.test(cat)) {
    return { ok: true, reason: `Categoria Maps: ${cat}` };
  }

  if (GELLI_STRUCTURE_NAME.test(name)) {
    return { ok: true, reason: "Nome struttura sanitaria privata" };
  }

  // "Centro Medico X" / ambulatori plausibili solo se categoria Maps conferma struttura
  if (/centro\s+medic|ambulator/i.test(name) && cat && /medic|sanit|clinic|poliambulator/i.test(cat)) {
    return { ok: true, reason: "Centro/ambulatorio con categoria struttura" };
  }

  return { ok: false, reason: "Non identificata come struttura soggetta art. 10 Gelli" };
}

/** True se il lead è una struttura che deve pubblicare la polizza RC (art. 10). */
export function isGelliSubjectStructure(
  companyName: string,
  category?: string | null,
  osmId?: string | null
): boolean {
  return classifyGelliScope(companyName, category, osmId).ok;
}

/**
 * RSA / residenza puramente assistenziale — non certificare HOT automatico:
 * l'obbligo art. 10 va verificato caso per caso (prestazioni sanitarie vs solo assistenza).
 */
export function isAssistentialOnlyStructure(
  companyName: string,
  category?: string | null,
  osmId?: string | null
): boolean {
  if (isMinSaluteAccredited(osmId)) return false;
  const hay = `${companyName} ${category ?? ""}`;
  return ASSISTENTIAL_ONLY.test(hay) && !CLINICAL_SIGNAL.test(hay);
}

/**
 * Ospedale / clinica accreditata di alto livello — mai HOT automatico se polizza non trovata.
 */
export function isHighValueHealthcareStructure(
  companyName: string,
  category?: string | null,
  osmId?: string | null
): boolean {
  if (isMinSaluteAccredited(osmId)) return true;
  const hay = `${companyName} ${category ?? ""}`;
  return /ospedal|hospital|policlinic|irccs|pronto\s+soccorso|casa\s+di\s+cura\s+accreditat/i.test(hay);
}
