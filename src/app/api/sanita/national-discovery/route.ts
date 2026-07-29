import { NextResponse } from "next/server";
import {
  cancelNationalDiscoveryJob,
  createNationalDiscoveryJob,
  findActiveNationalDiscoveryJob,
  listNationalDiscoveryJobs,
  readNationalDiscoveryJob,
  spawnNationalDiscoveryRunner,
  writeNationalDiscoveryJob,
} from "@/lib/sanita/national-discovery-jobs";
import {
  ITALIAN_REGIONS,
  isItalianRegion,
} from "@/lib/sanita/italy-regions";
import { getStoredRegionCities } from "@/lib/sanita/region-cities";
import {
  getScanEngineUrl,
  HETZNER_SCAN_ENGINE,
  isVercelUiHost,
} from "@/lib/sanita/scan-engine-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(req: Request, method: "GET" | "POST" | "DELETE") {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter(
    (value, index, values) => value && values.indexOf(value) === index
  );
  const requestUrl = new URL(req.url);
  const body = method === "GET" ? undefined : await req.text();
  for (const base of bases) {
    try {
      const upstream = await fetch(
        `${base}/api/sanita/national-discovery${requestUrl.search}`,
        {
          method,
          cache: "no-store",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body,
        }
      );
      const text = await upstream.text();
      return new NextResponse(text, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      /* prova il mirror successivo */
    }
  }
  return NextResponse.json(
    { success: false, error: "Motore discovery non raggiungibile" },
    { status: 503 }
  );
}

export async function GET(req: Request) {
  if (isVercelUiHost()) return proxy(req, "GET");

  const url = new URL(req.url);
  const requestedRegion = url.searchParams.get("region");
  const region = isItalianRegion(requestedRegion) ? requestedRegion : null;
  const municipalities = region ? getStoredRegionCities(region) : [];
  const jobs = listNationalDiscoveryJobs().slice(0, 10);
  return NextResponse.json({
    success: true,
    regions: ITALIAN_REGIONS,
    municipalities,
    municipalityCount: municipalities.length,
    jobs,
  });
}

export async function POST(req: Request) {
  if (isVercelUiHost()) return proxy(req, "POST");

  let body: { region?: unknown; municipality?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Richiesta non valida" }, { status: 400 });
  }
  if (!isItalianRegion(body.region)) {
    return NextResponse.json({ success: false, error: "Regione non valida" }, { status: 400 });
  }

  const municipality =
    typeof body.municipality === "string" && body.municipality.trim()
      ? body.municipality.trim()
      : null;
  const municipalities = getStoredRegionCities(body.region);
  if (municipality && !municipalities.includes(municipality)) {
    return NextResponse.json(
      { success: false, error: "Comune non presente nell'elenco ISTAT corrente" },
      { status: 400 }
    );
  }

  const sameTarget = findActiveNationalDiscoveryJob(body.region, municipality);
  if (sameTarget) {
    return NextResponse.json({ success: true, created: false, job: sameTarget });
  }
  const active = listNationalDiscoveryJobs().find(
    (job) =>
      ["queued", "waiting_for_archive", "running"].includes(job.status) &&
      !job.cancelRequested
  );
  if (active) {
    return NextResponse.json(
      {
        success: false,
        error: `È già attiva la discovery ${active.region}${
          active.municipality ? ` · ${active.municipality}` : ""
        }. Completala o annullala prima di avviarne un'altra.`,
        job: active,
      },
      { status: 409 }
    );
  }

  const job = createNationalDiscoveryJob({
    region: body.region,
    municipality,
    municipalitiesTotal: municipality ? 1 : municipalities.length,
  });
  writeNationalDiscoveryJob(job);
  try {
    const pid = spawnNationalDiscoveryRunner(job.jobId);
    const started = writeNationalDiscoveryJob({ ...job, pid });
    return NextResponse.json({ success: true, created: true, job: started });
  } catch (error) {
    const failed = writeNationalDiscoveryJob({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
      progress: {
        ...job.progress,
        message: "Impossibile avviare la discovery.",
      },
    });
    return NextResponse.json({ success: false, error: failed.errorMessage, job: failed }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (isVercelUiHost()) return proxy(req, "DELETE");

  let body: { jobId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Richiesta non valida" }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const job = readNationalDiscoveryJob(jobId);
  if (!job) return NextResponse.json({ success: false, error: "Job non trovato" }, { status: 404 });
  const cancelled = await cancelNationalDiscoveryJob(job);
  return NextResponse.json({ success: true, job: cancelled });
}
