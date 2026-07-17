"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandLogo } from "./BrandLogo";

const LINKS = [
  { href: "/", label: "Docs" },
  { href: "/chat", label: "Chat demo" },
  { href: "/replay", label: "Replay" },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="topnav">
      <Link href="/" className="topnav__brand">
        <span className="topnav__logo">
          <BrandLogo />
        </span>
        <b>langchain-canvas</b>
      </Link>
      <nav className="topnav__links">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={pathname === l.href ? "is-active" : ""}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
