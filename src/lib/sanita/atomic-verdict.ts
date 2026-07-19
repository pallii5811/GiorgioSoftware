/**
 * Persistenza atomica fail-closed per HOT.
 * Tentare HOT con complete=false → errore + stop condition (mai write-then-fix).
 */
import { canEmitHot, explainCanEmitHot, type HotEmitEvidence } from "@/lib/sanita/can-emit-hot";
import type { Verdict } from "@/lib/sanita/verdict";

export const HOT_INCOMPLETE_STOP = "HOT_INCOMPLETE_CRAWL";

export class HotIncompleteStopError extends Error {
  readonly stopCondition = HOT_INCOMPLETE_STOP;
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`STOP ${HOT_INCOMPLETE_STOP}: ${reasons.join("; ")}`);
    this.name = "HotIncompleteStopError";
    this.reasons = reasons;
  }
}

let lastStopCondition: string | null = null;
let workerStopped = false;

export function getLastStopCondition(): string | null {
  return lastStopCondition;
}

export function isWorkerStoppedForHot(): boolean {
  return workerStopped;
}

export function resetHotWorkerStopForTests(): void {
  lastStopCondition = null;
  workerStopped = false;
}

/**
 * Gate pre-persistenza. Se verdict=HOT e canEmitHot=false → throw + stop worker.
 * Non degrada silenziosamente: il caller non deve scrivere il record terminale.
 */
export function assertAtomicHotPersist(
  verdict: Verdict,
  evidence: HotEmitEvidence
): void {
  if (verdict !== "HOT") return;
  const explained = explainCanEmitHot(evidence);
  if (explained.ok && canEmitHot(evidence)) return;
  lastStopCondition = HOT_INCOMPLETE_STOP;
  workerStopped = true;
  throw new HotIncompleteStopError(explained.reasons);
}
