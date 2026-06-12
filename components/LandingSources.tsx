"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Abdeckungs-Sektion der Landingpage: welche Quellen, welche Länder.
// (Analog zur „Expansion"-Sektion klassischer Investor-Seiten — echte Namen statt Logos-Wand.)
type Src = { id: number; name: string; base_url: string; country: string };

const favicon = (base: string) => {
  try { return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(base).host}`; } catch { return ""; }
};
const COUNTRY: Record<string, string> = { DE: "Deutschland", FR: "Frankreich" };

export default function LandingSources() {
  const [sources, setSources] = useState<Src[]>([]);
  useEffect(() => {
    supabase.from("sources").select("id,name,base_url,country").eq("active", true).order("country")
      .then(({ data }) => setSources((data as Src[]) ?? []));
  }, []);
  if (!sources.length) return null;

  const byCountry = new Map<string, Src[]>();
  for (const s of sources) {
    const c = s.country ?? "—";
    if (!byCountry.has(c)) byCountry.set(c, []);
    byCountry.get(c)!.push(s);
  }

  return (
    <div className="ld-coverage">
      {[...byCountry.entries()].map(([country, list]) => (
        <div key={country} className="ld-coverage-col">
          <div className="ld-coverage-country">{COUNTRY[country] ?? country}<span>{list.length} Quellen</span></div>
          {list.map((s) => (
            <div key={s.id} className="ld-coverage-src">
              <img src={favicon(s.base_url)} alt="" width={20} height={20} loading="lazy" />
              <span>{s.name.replace(" Online", "")}</span>
              <i>{new URL(s.base_url).host.replace(/^www\./, "")}</i>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
