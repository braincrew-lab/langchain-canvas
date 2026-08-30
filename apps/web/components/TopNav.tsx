"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandLogo } from "./BrandLogo";
import { NAV_LINKS } from "../lib/ui-constants";

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="topnav">
      <Link href="/" className="topnav__brand">
        <span className="topnav__logo">
          <BrandLogo size={16} />
        </span>
        <b>Deep Agent Builder</b>
        <span className="topnav__sep">/</span>
        <span className="topnav__module">Canvas</span>
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
