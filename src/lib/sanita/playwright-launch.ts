/**
 * Shared Playwright launch options — prefer system Chromium when bundled
 * headless_shell is missing (common on Hetzner root without `playwright install`).
 *
 * Never pass `/snap/bin/chromium` as executablePath: it resolves to `/usr/bin/snap`
 * (the snap launcher), which Playwright rejects → falls back to missing headless_shell.
 */
import fs from "node:fs";
import path from "node:path";

const SNAP_WRAPPER_BASENAMES = new Set(["snap"]);

function isUsableChromiumBinary(p: string): boolean {
  try {
    if (!p || !fs.existsSync(p)) return false;
    fs.accessSync(p, fs.constants.X_OK);
    const real = fs.realpathSync(p);
    const base = path.basename(real);
    if (SNAP_WRAPPER_BASENAMES.has(base)) return false;
    // Reject tiny wrappers / non-ELF launchers (< 1MB is almost never chrome).
    const st = fs.statSync(real);
    if (st.isFile() && st.size > 0 && st.size < 1_000_000 && !/chrome|chromium/i.test(base)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveChromiumExecutablePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    // Real snap package binary (Hetzner)
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/snap/chromium/current/usr/lib/chromium-browser/chromium",
    "/usr/lib/chromium-browser/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    // Last resort: snap symlink only if realpath is a real chrome binary
    "/snap/bin/chromium",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (isUsableChromiumBinary(p)) {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return undefined;
}

export function playwrightChromiumLaunchOptions(extraArgs: string[] = []): {
  headless: boolean;
  executablePath: string;
  args: string[];
} {
  const executablePath = resolveChromiumExecutablePath();
  if (!executablePath) {
    throw new Error(
      "PLAYWRIGHT_NO_CHROMIUM: no usable system Chromium (install snap chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the real chrome binary, not /snap/bin/chromium)"
    );
  }
  return {
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      ...extraArgs,
    ],
  };
}
