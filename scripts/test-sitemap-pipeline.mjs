/**
 * Sitemap pipeline unit tests (local HTTP fixtures).
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openFrontierStore,
  closeFrontierStore,
  createCrawlRun,
  listNodes,
  getCrawlRun,
} from "../src/lib/sanita/frontier-store.ts";
import { discoverAndProcessSitemaps } from "../src/lib/sanita/sitemap-pipeline.ts";

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

function server(handler) {
  const s = http.createServer(handler);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-"));
  const db = path.join(dir, "f.sqlite");
  openFrontierStore(db);
  try {
    await fn();
  } finally {
    closeFrontierStore();
  }
}

// --- single sitemap ---
await withDb(async () => {
  const srv = await server((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/robots.txt") {
      res.writeHead(200);
      res.end("User-agent: *\n");
      return;
    }
    if (u === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset><loc>http://127.0.0.1:${srv.address().port}/a</loc><loc>http://127.0.0.1:${srv.address().port}/doc.pdf</loc></urlset>`);
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L1", runId: "s1" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base);
  ok(r.status === "DISCOVERED_COMPLETE", `single sitemap COMPLETE (got ${r.status})`);
  ok(r.urlsEnqueued >= 2, `enqueued locs (${r.urlsEnqueued})`);
  ok(listNodes(crawlRunId).some((n) => /\.pdf/i.test(n.canonicalUrl)), "sitemap with PDF enqueued");
  srv.close();
});

// --- sitemap index ---
await withDb(async () => {
  const srv = await server((req, res) => {
    const u = req.url.split("?")[0];
    const port = srv.address().port;
    if (u === "/robots.txt") {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    if (u === "/sitemap.xml" || u === "/sitemap_index.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1:${port}/child.xml</loc></sitemap></sitemapindex>`);
      return;
    }
    if (u === "/child.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset><loc>http://127.0.0.1:${port}/page</loc></urlset>`);
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L2", runId: "s2" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base);
  ok(r.status === "DISCOVERED_COMPLETE", `index COMPLETE (got ${r.status})`);
  ok(r.urlsEnqueued >= 1, "child locs enqueued");
  srv.close();
});

// --- robots referenced ---
await withDb(async () => {
  const srv = await server((req, res) => {
    const port = srv.address().port;
    const u = req.url.split("?")[0];
    if (u === "/robots.txt") {
      res.writeHead(200);
      res.end(`Sitemap: http://127.0.0.1:${port}/custom-sm.xml\n`);
      return;
    }
    if (u === "/custom-sm.xml") {
      res.writeHead(200);
      res.end(`<?xml version="1.0"?><urlset><loc>http://127.0.0.1:${port}/r</loc></urlset>`);
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L3", runId: "s3" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base);
  ok(r.robotsReferenced === true, "robots referenced");
  ok(r.status === "ROBOTS_REFERENCED_COMPLETE", `robots COMPLETE (got ${r.status})`);
  srv.close();
});

// --- child failed ---
await withDb(async () => {
  const srv = await server((req, res) => {
    const port = srv.address().port;
    const u = req.url.split("?")[0];
    if (u === "/robots.txt") {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    if (u === "/sitemap.xml" || u === "/sitemap_index.xml" || u === "/wp-sitemap.xml" || u === "/sitemap-index.xml") {
      if (u === "/sitemap.xml") {
        res.writeHead(200);
        res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1:${port}/bad-child.xml</loc></sitemap></sitemapindex>`);
        return;
      }
      res.writeHead(404);
      res.end("nf");
      return;
    }
    if (u === "/bad-child.xml") {
      res.writeHead(500);
      res.end("err");
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L4", runId: "s4" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base);
  ok(
    r.status === "DISCOVERED_FAILED" || r.status === "DISCOVERED_PARTIAL",
    `child fail status (got ${r.status})`
  );
  srv.close();
});

// --- absent ---
await withDb(async () => {
  const srv = await server((req, res) => {
    res.writeHead(404);
    res.end("nf");
  });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L5", runId: "s5" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base);
  ok(r.status === "NOT_PRESENT", `absent NOT_PRESENT (got ${r.status})`);
  ok(getCrawlRun(crawlRunId)?.sitemapStatus === "NOT_PRESENT", "DB flag NOT_PRESENT");
  srv.close();
});

// --- cap ---
await withDb(async () => {
  const srv = await server((req, res) => {
    const port = srv.address().port;
    const u = req.url.split("?")[0];
    if (u === "/robots.txt") {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    if (u === "/sitemap.xml") {
      const locs = Array.from({ length: 30 }, (_, i) => `<loc>http://127.0.0.1:${port}/p${i}</loc>`).join("");
      res.writeHead(200);
      res.end(`<?xml version="1.0"?><urlset>${locs}</urlset>`);
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const { crawlRunId } = createCrawlRun({ leadId: "L6", runId: "s6" });
  const r = await discoverAndProcessSitemaps(crawlRunId, base, { urlCap: 5 });
  ok(r.urlCapReached === true, "url cap reached");
  ok(r.status !== "DISCOVERED_COMPLETE", `cap not COMPLETE (got ${r.status})`);
  srv.close();
});

console.log(`\nSitemap pipeline: ${pass} pass, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);
