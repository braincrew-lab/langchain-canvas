"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_LINKS } from "../lib/ui-constants";

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="topnav">
      <Link href="/" className="topnav__brand">
        <b>Deep Canvas</b>
      </Link>
      <nav className="topnav__links">
        {NAV_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={pathname === l.href ? "is-active" : ""}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
