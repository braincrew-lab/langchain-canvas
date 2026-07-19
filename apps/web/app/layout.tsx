import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@braincrew-lab/langchain-canvas/styles.css";
import "./globals.css";
import { TopNav } from "../components/TopNav";

export const metadata: Metadata = {
  title: "langchain-canvas",
  description: "A live canvas for LangChain agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        <div className="approot">{children}</div>
      </body>
    </html>
  );
}
