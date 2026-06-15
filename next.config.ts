const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // pdf-parse (e le sue dipendenze pdfjs-dist / canvas native) usano require
  // dinamici e binari: vanno lasciati esterni al bundle server.
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "tesseract.js",
    "playwright",
    "@prisma/client",
    "prisma",
  ],
};

export default nextConfig;
