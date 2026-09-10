/**
 * Deterministic pdftoppm resolver + inheritance tests (stop-ship OCR).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  resolvePdftoppm,
  resetPdftoppmCache,
  rasterizePdfPages,
  extractPdfFullText,
  listPdftoppmCandidates,
} = await import("../src/lib/sanita/ocr.ts");

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

const linuxPpm = "/usr/bin/pdftoppm";
const hasLinuxPpm = process.platform !== "win32" && fs.existsSync(linuxPpm);
const stagingPpm = path.join(
  ROOT,
  "data/staging/poppler/poppler-24.08.0/Library/bin/pdftoppm.exe"
);
const hasStaging = fs.existsSync(stagingPpm);

function minimalPdf() {
  return Buffer.from(`%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 10 100 Td (Hello polizza OCR) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
trailer<< /Size 5 /Root 1 0 R >>
startxref
308
%%EOF`);
}

const prev = { ...process.env };

async function withEnv(patch, fn) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  resetPdftoppmCache();
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    resetPdftoppmCache();
  }
}

console.log("1. PDFTOPPM_PATH absolute valid");
if (hasLinuxPpm) {
  await withEnv({ PDFTOPPM_PATH: linuxPpm, PDFTOPPM_DISABLE_SYSTEM_FALLBACK: null }, async () => {
    const r = await resolvePdftoppm();
    ok(r.path === linuxPpm, `rendererFound=${r.path} ver=${r.version}`);
  });
} else if (hasStaging) {
  await withEnv({ PDFTOPPM_PATH: stagingPpm }, async () => {
    const r = await resolvePdftoppm();
    ok(Boolean(r.path), `rendererFound=${r.path}`);
  });
} else {
  ok(true, "skip (no pdftoppm on this host)");
}

console.log("2. PATH empty + absolute binary");
if (hasLinuxPpm) {
  await withEnv(
    { PDFTOPPM_PATH: linuxPpm, PATH: "", PDFTOPPM_DISABLE_SYSTEM_FALLBACK: null },
    async () => {
      const r = await resolvePdftoppm();
      ok(r.path === linuxPpm, `absolute works with empty PATH (${r.path})`);
    }
  );
} else ok(true, "skip");

console.log("3. bad PDFTOPPM_PATH + /usr/bin fallback");
if (hasLinuxPpm) {
  await withEnv(
    {
      PDFTOPPM_PATH: "/tmp/definitely-missing-pdftoppm",
      PATH: "",
      PDFTOPPM_DISABLE_SYSTEM_FALLBACK: null,
    },
    async () => {
      const r = await resolvePdftoppm();
      ok(r.path === linuxPpm, `fallback to /usr/bin (${r.path})`);
    }
  );
} else ok(true, "skip");

console.log("4. negative then env fix → PASS");
{
  await withEnv(
    {
      PDFTOPPM_PATH: path.join(ROOT, "missing-bin"),
      PATH: "",
      PDFTOPPM_DISABLE_SYSTEM_FALLBACK: "1",
    },
    async () => {
      const r1 = await resolvePdftoppm();
      ok(r1.path == null, `first probe missing (${r1.path})`);
    }
  );
  if (hasLinuxPpm) {
    await withEnv(
      { PDFTOPPM_PATH: linuxPpm, PDFTOPPM_DISABLE_SYSTEM_FALLBACK: null },
      async () => {
        const r2 = await resolvePdftoppm();
        ok(r2.path === linuxPpm, `second probe after env fix (${r2.path})`);
      }
    );
  } else ok(true, "skip second probe");
}

console.log("5. negative cache not permanent (TTL)");
if (hasLinuxPpm) {
  await withEnv(
    {
      PDFTOPPM_PATH: "/tmp/missing-x",
      PATH: "",
      PDFTOPPM_DISABLE_SYSTEM_FALLBACK: "1",
    },
    async () => {
      const r1 = await resolvePdftoppm();
      ok(r1.path == null, "cached negative");
      // flip env without reset — still negative until TTL, then with reset:
      process.env.PDFTOPPM_PATH = linuxPpm;
      delete process.env.PDFTOPPM_DISABLE_SYSTEM_FALLBACK;
      resetPdftoppmCache();
      const r2 = await resolvePdftoppm();
      ok(r2.path === linuxPpm, "after resetPdftoppmCache recovers");
    }
  );
} else ok(true, "skip");

console.log("6. child inherits PDFTOPPM_PATH");
{
  const childCode = `
    const p = process.env.PDFTOPPM_PATH || "";
    if (!p) { console.log("FAIL"); process.exit(1); }
    console.log("OK:"+p);
  `;
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", childCode], {
      env: { ...process.env, PDFTOPPM_PATH: hasLinuxPpm ? linuxPpm : "C:\\fake\\pdftoppm.exe" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
  ok(r.code === 0 && r.out.startsWith("OK:"), `child env ${r.out}`);
}

console.log("7. rasterize fixture → images>0");
if (hasLinuxPpm || hasStaging) {
  await withEnv(
    {
      PDFTOPPM_PATH: hasLinuxPpm ? linuxPpm : stagingPpm,
      PDFTOPPM_DISABLE_SYSTEM_FALLBACK: null,
      OCR_ENABLED: "1",
    },
    async () => {
      let fixture = path.join(ROOT, "tests/fixtures/sanita/scanned-policy-sample.pdf");
      if (!fs.existsSync(fixture)) fixture = path.join(ROOT, "data/staging/clotilde-assicurazione.pdf");
      if (!fs.existsSync(fixture)) {
        // synthesize via pdftoppm on minimal — may be empty pages; still check status not RENDERER_MISSING
        const rast = await rasterizePdfPages(minimalPdf(), 1);
        ok(rast.status !== "RENDERER_MISSING", `no RENDERER_MISSING (${rast.status})`);
        ok(Boolean(rast.rendererPath), `rendererPath=${rast.rendererPath}`);
      } else {
        const rast = await rasterizePdfPages(fs.readFileSync(fixture), 1);
        ok(rast.status === "OK", `rasterize ${rast.status}`);
        ok(rast.images.length > 0, `images=${rast.images.length}`);
        ok(Boolean(rast.rendererPath), `rendererPath=${rast.rendererPath}`);
      }
    }
  );
} else ok(true, "skip rasterize");

console.log("8. OCR fixture / digital text");
if (hasLinuxPpm || hasStaging) {
  await withEnv(
    {
      PDFTOPPM_PATH: hasLinuxPpm ? linuxPpm : stagingPpm,
      OCR_ENABLED: "1",
      OCR_MAX_PAGES: "1",
      OCR_JOB_TIMEOUT_MS: "120000",
    },
    async () => {
      const fixture = path.join(ROOT, "data/staging/clotilde-assicurazione.pdf");
      if (fs.existsSync(fixture)) {
        const ex = await extractPdfFullText(fs.readFileSync(fixture));
        ok(ex.status !== "OCR_RENDERER_MISSING", `status=${ex.status}`);
        ok((ex.text || "").length > 0, `textLen=${(ex.text || "").length}`);
      } else {
        const ex = await extractPdfFullText(minimalPdf());
        ok(ex.status !== "OCR_RENDERER_MISSING", `minimal status=${ex.status}`);
      }
    }
  );
} else ok(true, "skip OCR");

console.log("9. no OCR_RENDERER_MISSING when binary executable");
if (hasLinuxPpm) {
  await withEnv({ PDFTOPPM_PATH: linuxPpm, OCR_ENABLED: "1" }, async () => {
    const ex = await extractPdfFullText(minimalPdf());
    ok(ex.status !== "OCR_RENDERER_MISSING", `status=${ex.status}`);
  });
} else ok(true, "skip");

console.log("10. truly missing → technical, never commercial stamp here");
await withEnv(
  {
    PDFTOPPM_PATH: path.join(ROOT, "no-such-pdftoppm"),
    PATH: "",
    PDFTOPPM_DISABLE_SYSTEM_FALLBACK: "1",
    OCR_ENABLED: "1",
  },
  async () => {
    const ex = await extractPdfFullText(minimalPdf());
    ok(ex.status === "OCR_RENDERER_MISSING", `missing → ${ex.status}`);
  }
);

ok(listPdftoppmCandidates().length >= 1, "candidates non-empty");

console.log(`\nRESULT ${fail ? "FAIL" : "PASS"} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
