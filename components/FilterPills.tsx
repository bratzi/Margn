"use client";

import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

const X = () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ marginLeft: 3 }}><path d="M18 6 6 18M6 6 18 18" /></svg>;
const fmtDay = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

export default function FilterPills() {
  const f = useFilters();
  const nameById = new Map(f.sources.map((s) => [s.id, s.name.replace(" Online", "")]));
  const pills: { id: string; label: string; on: () => void }[] = [];

  if (f.activeArr.length !== f.sources.length) for (const id of f.activeArr) pills.push({ id: `pub-${id}`, label: nameById.get(id) || "?", on: () => f.toggle(id) });
  if (f.paywall !== "all") pills.push({ id: "pw", label: f.paywall === "yes" ? "🔒 Paywall" : "🔓 Frei", on: () => f.setPaywall("all") });
  if (f.status === "new") pills.push({ id: "scan", label: "🆕 Neu erfasst", on: () => f.setStatus("all") });
  else if (f.status === "rescanned") pills.push({ id: "scan", label: "🔁 Wiederholt gescannt", on: () => f.setStatus("all") });
  if (f.atype !== "all") { const AT: Record<string, string> = { artikel: "Artikel", paywall: "Paywall-Seite", video: "Video", werbung: "Werbung", hub: "Hub", blog: "Timeline", timeline: "Timeline" }; pills.push({ id: "at", label: AT[f.atype] ?? f.atype, on: () => f.setAtype("all") }); }
  if (f.author !== "all") pills.push({ id: "au", label: f.author === "named" ? "Namentlich" : f.author === "anonymous" ? "Anonym" : "Ohne Autor", on: () => f.setAuthor("all") });
  for (const t of f.topics) pills.push({ id: `tp-${t}`, label: `📁 ${topicLabel(t)}`, on: () => f.toggleTopic(t) });
  if (f.keyword !== "all") pills.push({ id: "kw", label: `#${f.keyword}`, on: () => f.setKeyword("all") });
  if (f.lang !== "all") pills.push({ id: "lg", label: f.lang === "de" ? "🇩🇪 DE" : "🇫🇷 FR", on: () => f.setLang("all") });
  const fullRange = f.rangeIdx.from === 0 && f.rangeIdx.to === f.days.length - 1;
  if (!fullRange) pills.push({ id: "range", label: `📅 ${fmtDay(f.days[f.rangeIdx.from])} – ${fmtDay(f.days[f.rangeIdx.to])}`, on: () => f.setRangeIdx({ from: 0, to: f.days.length - 1 }) });

  if (!pills.length) return null;
  return (
    <div className="filter-pills">
      <span className="pills-label">Aktiv:</span>
      <div className="pills-list">
        {pills.map((p) => <button key={p.id} className="pill" onClick={p.on} title="Entfernen">{p.label}<X /></button>)}
      </div>
    </div>
  );
}
