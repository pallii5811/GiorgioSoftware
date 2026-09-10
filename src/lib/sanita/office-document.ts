import { inflateRawSync } from "node:zlib";

export type OfficeExtractionStatus =
  | "SUCCESS"
  | "EMPTY"
  | "UNSUPPORTED"
  | "CORRUPT"
  | "TOO_LARGE";

export type OfficeExtractionResult = {
  text: string;
  status: OfficeExtractionStatus;
  entriesRead: number;
  embeddedImages: Buffer[];
};

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_TEXT = 500_000;

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:w:p|a:p|text:p|row|si)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10))
    )
    .replace(/\s+/g, " ")
    .trim();
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function shouldReadEntry(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "content.xml" ||
    n === "styles.xml" ||
    /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n) ||
    /^xl\/(?:sharedstrings|workbook)\.xml$/.test(n) ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n) ||
    /^ppt\/slides\/slide\d+\.xml$/.test(n) ||
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)
  );
}

function extractZipXml(buf: Buffer): OfficeExtractionResult {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) {
    return { text: "", status: "CORRUPT", entriesRead: 0, embeddedImages: [] };
  }
  const entries = Math.min(buf.readUInt16LE(eocd + 10), MAX_ARCHIVE_ENTRIES);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  let combined = "";
  let entriesRead = 0;
  const embeddedImages: Buffer[] = [];

  for (let i = 0; i < entries && cursor + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const compression = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    const mediaEntry =
      /^(?:word|xl|ppt)\/media\/[^/]+\.(?:png|jpe?g|webp|tiff?|bmp|gif)$/i.test(name) ||
      /^(?:pictures|media)\/[^/]+\.(?:png|jpe?g|webp|tiff?|bmp|gif)$/i.test(name);
    if (!shouldReadEntry(name) && !mediaEntry) continue;
    if (
      uncompressedSize > MAX_ENTRY_BYTES ||
      compressedSize > MAX_ENTRY_BYTES ||
      localOffset + 30 > buf.length ||
      buf.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      return { text: combined, status: "TOO_LARGE", entriesRead, embeddedImages };
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    try {
      if (compression === 0) data = compressed;
      else if (compression === 8) data = inflateRawSync(compressed);
      else continue;
    } catch {
      return { text: combined, status: "CORRUPT", entriesRead, embeddedImages };
    }
    if (mediaEntry) {
      if (embeddedImages.length < 40 && data.length >= 128 && data.length <= MAX_ENTRY_BYTES) {
        embeddedImages.push(Buffer.from(data));
      }
      continue;
    }
    const chunk = decodeXmlText(data.toString("utf8"));
    if (chunk) {
      combined = `${combined}\n${chunk}`.slice(0, MAX_TOTAL_TEXT);
      entriesRead++;
    }
    if (combined.length >= MAX_TOTAL_TEXT) break;
  }
  const text = combined.replace(/\s+/g, " ").trim();
  return {
    text,
    status: text || embeddedImages.length ? "SUCCESS" : "EMPTY",
    entriesRead,
    embeddedImages,
  };
}

function extractRtf(buf: Buffer): OfficeExtractionResult {
  const raw = buf.toString("latin1");
  const text = raw
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => {
      const code = Number.parseInt(value, 10);
      return String.fromCharCode(code < 0 ? code + 65_536 : code);
    })
    .replace(/\\'[0-9a-f]{2}/gi, (value) =>
      Buffer.from(value.slice(2), "hex").toString("latin1")
    )
    .replace(/\\(?:par|line)\b/g, "\n")
    .replace(/\\[a-z]+-?\d*\s?/gi, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text,
    status: text ? "SUCCESS" : "EMPTY",
    entriesRead: text ? 1 : 0,
    embeddedImages: [],
  };
}

function extractLegacyBinaryText(buf: Buffer): OfficeExtractionResult {
  const latin = (buf.toString("latin1").match(/[ -~À-ÿ]{5,}/g) || []).join(" ");
  const utf16 = (buf.toString("utf16le").match(/[ -~À-ÿ]{5,}/g) || []).join(" ");
  const text = `${latin} ${utf16}`.replace(/\s+/g, " ").trim().slice(0, MAX_TOTAL_TEXT);
  return {
    text,
    status: text.length >= 40 ? "SUCCESS" : "UNSUPPORTED",
    entriesRead: text ? 1 : 0,
    embeddedImages: [],
  };
}

export function extractOfficeDocumentText(
  buf: Buffer,
  url: string,
  contentType?: string | null
): OfficeExtractionResult {
  if (buf.length > 80 * 1024 * 1024) {
    return { text: "", status: "TOO_LARGE", entriesRead: 0, embeddedImages: [] };
  }
  const lowerUrl = url.toLowerCase();
  const lowerType = String(contentType || "").toLowerCase();
  if (
    /\.(?:docx|xlsx|pptx|odt|ods|odp)(?:$|[?#])/.test(lowerUrl) ||
    /officedocument|opendocument/.test(lowerType)
  ) {
    return extractZipXml(buf);
  }
  if (/\.rtf(?:$|[?#])/.test(lowerUrl) || /(?:application|text)\/rtf/.test(lowerType)) {
    return extractRtf(buf);
  }
  if (/\.csv(?:$|[?#])/.test(lowerUrl) || /text\/csv/.test(lowerType)) {
    const text = buf.toString("utf8").replace(/\s+/g, " ").trim();
    return {
      text,
      status: text ? "SUCCESS" : "EMPTY",
      entriesRead: text ? 1 : 0,
      embeddedImages: [],
    };
  }
  if (
    /\.(?:doc|xls|ppt)(?:$|[?#])/.test(lowerUrl) ||
    /msword|ms-excel|ms-powerpoint/.test(lowerType)
  ) {
    return extractLegacyBinaryText(buf);
  }
  return { text: "", status: "UNSUPPORTED", entriesRead: 0, embeddedImages: [] };
}
