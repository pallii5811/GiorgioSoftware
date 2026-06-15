import type { Verdict } from "./verdict";

/** Punteggio commerciale 0..100: priorità di lavorazione del lead. */
export function scoreLead(args: {
  verdict: Verdict;
  phone?: string | null;
  email?: string | null;
  pec?: string | null;
  expiry?: Date | string | null;
  obsoletePolicy?: boolean;
}): number {
  let s = 0;
  if (args.verdict === "HOT") s += 70;
  else if (args.verdict === "REVIEW") s += 35;
  else if (args.verdict === "PUBLISHED") s += 40;

  if (args.phone) s += 10;
  if (args.email) s += 8;
  if (args.pec) s += 7;

  if (args.obsoletePolicy) s += 25;

  if (args.verdict === "PUBLISHED" && args.expiry) {
    const days = (new Date(args.expiry).getTime() - Date.now()) / 86_400_000;
    if (days <= 90) s += 25;
    else if (days <= 180) s += 15;
    else if (days <= 365) s += 5;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}
