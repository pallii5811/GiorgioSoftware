/**
 * Shared Playwright launch options — prefer system Chromium when bundled
 * headless_shell is missing (common on Hetzner root without `playwright install`).
 */
import fs from "node:fs";

export function resolveChromiumExecutablePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export function playwrightChromiumLaunchOptions(extraArgs: string[] = []): {
  headless: boolean;
  executablePath?: string;
  args: string[];
} {
  const executablePath = resolveChromiumExecutablePath();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      ...extraArgs,
    ],
  };
}
