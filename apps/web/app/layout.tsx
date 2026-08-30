import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Sora } from "next/font/google";
import localFont from "next/font/local";

import "@braincrew-lab/langchain-canvas/styles.css";
import "./globals.css";
import { TopNav } from "../components/TopNav";

const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sora",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
});

const pretendard = localFont({
  src: "../public/fonts/PretendardVariable.woff2",
  variable: "--font-pretendard",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Deep Agent Builder / Canvas",
  description: "A live canvas for LangChain agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${ibmPlexMono.variable} ${pretendard.variable}`}
    >
      <body>
        <TopNav />
        <div className="approot">{children}</div>
      </body>
    </html>
  );
}
