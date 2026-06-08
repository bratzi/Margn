import "./globals.css";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import FilterProvider from "@/components/FilterProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb", display: "swap" });

export const metadata: Metadata = {
  title: "margn — Medienobservatorium",
  description: "Offenes Medienobservatorium: wie Nachrichtenseiten ihre Artikel veröffentlichen, strukturieren und über die Zeit verändern.",
};

const themeInit = `(function(){try{var t=localStorage.getItem('margn-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInit }} /></head>
      <body>
        <Suspense>
          <FilterProvider>
            <div className="app">
              <Sidebar />
              <main className="main">{children}</main>
            </div>
          </FilterProvider>
        </Suspense>
      </body>
    </html>
  );
}
