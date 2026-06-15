import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner"
import { SiteNav } from "@/components/site-nav"
import { Building2 } from "lucide-react"

export const metadata: Metadata = {
  title: "giorg.io · Intelligence Lead Assicurativi",
  description:
    "Motore di lead generation per assicurazioni: RC sanitaria (Legge Gelli) e cauzioni su gare pubbliche.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" suppressHydrationWarning>
      <body className="font-sans antialiased min-h-screen">
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 w-full border-b border-border/60 surface-card">
            <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
              <Link href="/" className="flex items-center gap-2.5">
                <span className="brand-gradient grid h-9 w-9 place-items-center rounded-xl text-white shadow-sm">
                  <Building2 className="h-5 w-5" />
                </span>
                <div className="flex flex-col leading-none">
                  <span className="text-[15px] font-bold tracking-tight">
                    giorg<span className="brand-gradient-text">.io</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Intelligence assicurativa
                  </span>
                </div>
              </Link>
              <SiteNav />
            </div>
          </header>

          <main className="flex-1">
            <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
              {children}
            </div>
          </main>

          <footer className="border-t border-border/60 py-5">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 text-xs text-muted-foreground">
              giorg.io · dati reali da fonti pubbliche (OpenStreetMap, portali di trasparenza).
              Nessun dato inventato.
            </div>
          </footer>
        </div>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
