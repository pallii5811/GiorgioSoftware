/** Errore infrastruttura (lock, browser, rete) — non è un verdetto Gelli. */
export function isTransientAnalysisFailure(msg: string): boolean {
  return (
    /Timeout lock analisi/i.test(msg) ||
    /Analisi oltre \d+ min/i.test(msg) ||
    /Target (page|context|browser).*closed/i.test(msg) ||
    /Browser has been closed/i.test(msg) ||
    /Execution context was destroyed/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE/i.test(msg) ||
    /interrupted|aborted/i.test(msg)
  );
}
