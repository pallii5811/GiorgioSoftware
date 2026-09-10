import { externalFetch } from "../src/lib/http";

async function main() {
  const url = process.argv[2];
  try {
    const response = await externalFetch(url, {
      timeoutMs: 30_000,
      redirect: "follow",
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(
      JSON.stringify({
        ok: response.ok,
        status: response.status,
        size: buffer.length,
        type: response.headers.get("content-type"),
      })
    );
  } catch (error) {
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: { message?: string; code?: string } }).cause
        : undefined;
    console.log(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        cause: cause?.message || null,
        code: cause?.code || null,
      })
    );
  }
}

void main();
