"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Stethoscope, Building2, LayoutDashboard, Users } from "lucide-react"
import { cn } from "@/lib/utils"

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/sanita", label: "Sanità · RSA", icon: Stethoscope },
  { href: "/gare", label: "Gare Pubbliche", icon: Building2 },
  { href: "/crm", label: "CRM", icon: Users },
]

export function SiteNav() {
  const pathname = usePathname()

  return (
    <nav className="flex items-center gap-1">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
