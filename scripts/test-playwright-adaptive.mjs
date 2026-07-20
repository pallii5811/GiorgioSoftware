/**
 * Adaptive Playwright activation rules (offline).
 */
import { shouldActivatePlaywright } from "../src/lib/sanita/playwright-adaptive.ts";

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

const off = shouldActivatePlaywright({
  mode: false,
  pagesText: "<div id=root></div>",
  htmlSamples: ["<div id=root></div>"],
  completedHtml: 1,
  policyFound: false,
  linksDiscovered: 0,
});
ok(off.activate === false, "mode false → never activate");

const rich = shouldActivatePlaywright({
  mode: "adaptive",
  pagesText: "a".repeat(5000) + " polizza assicurativa RC professionale compagnia Generali",
  htmlSamples: [
    `<html><body>${"link ".repeat(40)}<a href="/a">a</a><a href="/b">b</a> polizza assicurativa</body></html>`,
  ],
  completedHtml: 5,
  policyFound: false,
  linksDiscovered: 40,
});
ok(rich.activate === false, "rich HTTP HTML → no Playwright");

const spa = shouldActivatePlaywright({
  mode: "adaptive",
  pagesText: " ",
  htmlSamples: [
    '<html><body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script></body></html>',
  ],
  completedHtml: 1,
  policyFound: false,
  linksDiscovered: 1,
});
ok(spa.activate === true, `SPA/Next shell → activate (${spa.reason})`);

const thin = shouldActivatePlaywright({
  mode: "adaptive",
  pagesText: "ok",
  htmlSamples: ["<html><body><div id=root></div></body></html>"],
  completedHtml: 2,
  policyFound: false,
  linksDiscovered: 0,
});
ok(thin.activate === true, `thin text + app shell → activate (${thin.reason})`);

const forced = shouldActivatePlaywright({
  mode: true,
  pagesText: "a".repeat(10000),
  htmlSamples: ["rich"],
  completedHtml: 10,
  policyFound: false,
  linksDiscovered: 100,
});
ok(forced.activate === true, "mode true → always activate");

const withPolicy = shouldActivatePlaywright({
  mode: "adaptive",
  pagesText: "x",
  htmlSamples: ['<div id="__next"></div>'],
  completedHtml: 1,
  policyFound: true,
  linksDiscovered: 0,
});
ok(withPolicy.activate === false, "policy already found → skip PW");

console.log(JSON.stringify({ suite: "playwright-adaptive", pass, fail, exitCode: fail ? 1 : 0 }, null, 2));
process.exit(fail > 0 ? 1 : 0);
