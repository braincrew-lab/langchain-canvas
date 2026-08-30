import type { LucideIcon } from "lucide-react";
import { BarChart3, Braces, Code, FileText, LayoutTemplate, Table } from "lucide-react";

export const NAV_LINKS = [
  { href: "/chat", label: "Chat" },
  { href: "/replay", label: "Replay" },
  { href: "/", label: "Schema" },
] as const;

/**
 * Schema Explorer tab labels, keyed by scenario id. Values are the wire `type`
 * name shown on each tab — "json" is the design label for the `versions`
 * scenario, whose wire type is actually `html` (see docs/frontend/ui-guideline.pen TypeTabs).
 */
export const TYPE_LABELS: Record<string, string> = {
  "html-page": "html",
  document: "document",
  chart: "chart",
  table: "table",
  slides: "slides",
  versions: "json",
};

/** Sidebar icon per scenario id, keyed the same way as `TYPE_LABELS`. */
export const SCENARIO_ICONS: Record<string, LucideIcon> = {
  "html-page": Code,
  document: FileText,
  chart: BarChart3,
  table: Table,
  slides: LayoutTemplate,
  versions: Braces,
};

/** Icon used when a scenario id has no entry in `SCENARIO_ICONS`. */
export const FALLBACK_SCENARIO_ICON = FileText;
