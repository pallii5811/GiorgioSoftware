/**
 * Adaptive Playwright trigger — only when HTTP crawl cannot acquire enough content.
 */
export type PlaywrightMode = boolean | "adaptive";

export function shouldActivatePlaywright(opts: {
  mode: PlaywrightMode;
  pagesText: string;
  htmlSamples?: string[];
  completedHtml: number;
  policyFound: boolean;
  linksDiscovered?: number;
}): { activate: boolean; reason: string | null } {
  if (opts.mode === false) return { activate: false, reason: null };
  if (opts.mode === true) return { activate: true, reason: "forced" };
  if (opts.policyFound) return { activate: false, reason: null };

  const text = opts.pagesText || "";
  const samples = (opts.htmlSamples || []).join("\n").slice(0, 50_000);
  const hay = `${text}\n${samples}`;

  if (text.replace(/\s+/g, " ").trim().length < 400) {
    return { activate: true, reason: "insufficient_text" };
  }
  if (/id=["'](?:root|__next|app|__nuxt)["']/i.test(hay) || /data-reactroot|ng-version|data-v-/i.test(hay)) {
    return { activate: true, reason: "app_shell" };
  }
  if (
    /<(?:script)[^>]+src=/i.test(hay) &&
    (opts.linksDiscovered ?? 0) < 3 &&
    opts.completedHtml <= 2
  ) {
    return { activate: true, reason: "bundle_few_links" };
  }
  if (/__NEXT_DATA__|webpackJsonp|vue\.runtime|angular\.core|react-dom/i.test(hay)) {
    return { activate: true, reason: "spa_framework" };
  }
  if (/trasparen|amministraz/i.test(hay) && text.length < 800) {
    return { activate: true, reason: "empty_transparency" };
  }
  if (opts.completedHtml > 0 && opts.completedHtml < 3 && text.length < 1200) {
    return { activate: true, reason: "frontier_thin" };
  }
  return { activate: false, reason: null };
}
