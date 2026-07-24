#!/usr/bin/env node
/**
 * Playwright system Chromium smoke: launch → local HTML → close.
 * Exit 0 only if browser works with resolved executablePath.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  playwrightChromiumLaunchOptions,
  resolveChromiumExecutablePath,
} from "../src/lib/sanita/playwright-launch.ts";

const exe = resolveChromiumExecutablePath();
const opts = playwrightChromiumLaunchOptions();
const htmlBody = "<!doctype html><title>ok</title><h1>playwright-smoke</h1>";
const dataUrl = "data:text/html," + encodeURIComponent(htmlBody);

let browser;
try {
  if (!exe) {
    console.error(JSON.stringify({ ok: false, error: "no_executable", candidatesTried: true }));
    process.exit(2);
  }
  browser = await chromium.launch(opts);
  const page = await browser.newPage();
  await page.goto(dataUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  const text = await page.locator("h1").innerText();
  await page.close();
  await browser.close();
  browser = null;
  const ok = text.includes("playwright-smoke");
  console.log(JSON.stringify({ ok, executablePath: exe, args: opts.args, text }));
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(
    JSON.stringify({
      ok: false,
      executablePath: exe || null,
      error: String(e),
      stack: e?.stack?.split("\n").slice(0, 8),
    })
  );
  process.exit(1);
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* */
  }
}
