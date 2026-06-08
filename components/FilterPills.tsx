"use client";

import { topicLabel } from "@/lib/topics";

type Pill = { id: string; label: string; onRemove: () => void };

export default function FilterPills({
  sources, activeSources, toggleSource,
  status, setStatus, paywall, setPaywall,
  atype, setAtype, author, setAuthor,
  topic, setTopic, keyword, setKeyword, lang, setLang,
}: {
  sources: { id: number; name: string }[];
  activeSources: number[]; toggleSource: (id: number) => void;
  status: string; setStatus: (v: string) => void;
  paywall: string; setPaywall: (v: string) => void;
  atype: string; setAtype: (v: string) => void;
  author: string; setAuthor: (v: string) => void;
  topic: string; setTopic: (v: string) => void;
  keyword: string; setKeyword: (v: string) => void;
  lang: string; setLang: (v: string) => void;
}) {
  const nameById = new Map(sources.map((s) => [s.id, s.name.replace(" Online", "")]));
  const pills: Pill[] = [];

  // Publizisten
  for (const id of activeSources) {
    if (activeSources.length !== sources.length) { // nur wenn nicht alle
      pills.push({
        id: `pub-${id}`,
        label: nameById.get(id) || "?",
        onRemove: () => toggleSource(id),
      });
    }
  }

  if (status !== "all") pills.push({ id: "status", label: status === "analyzed" ? "✓ Analysiert" : "⏱ Backlog", onRemove: () => setStatus("all") });
  if (paywall !== "all") pills.push({ id: "paywall", label: paywall === "yes" ? "🔒 Paywall" : "🔓 Frei", onRemove: () => setPaywall("all") });
  if (atype !== "all") {
    const labels: Record<string, string> = {
      artikel: "Artikel", paywall: "Paywall-Seite", video: "Video", werbung: "Werbung",
      hub: "Hub", blog: "Blog", timeline: "Timeline",
    };
    pills.push({ id: "atype", label: labels[atype] || atype, onRemove: () => setAtype("all") });
  }
  if (author !== "all") {
    const labels: Record<string, string> = {
      named: "Namentlich", anonymous: "Anonym", none: "Ohne Autor",
    };
    pills.push({ id: "author", label: labels[author] || author, onRemove: () => setAuthor("all") });
  }
  if (topic !== "all") pills.push({ id: "topic", label: `📁 ${topicLabel(topic)}`, onRemove: () => setTopic("all") });
  if (keyword !== "all") pills.push({ id: "keyword", label: `#${keyword}`, onRemove: () => setKeyword("all") });
  if (lang !== "all") pills.push({ id: "lang", label: lang === "de" ? "🇩🇪 Deutsch" : "🇫🇷 Français", onRemove: () => setLang("all") });

  if (!pills.length) return null;

  return (
    <div className="filter-pills">
      <span className="pills-label">Filter:</span>
      <div className="pills-list">
        {pills.map((p) => (
          <button key={p.id} className="pill" onClick={p.onRemove} title="Entfernen">
            {p.label}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ marginLeft: 4 }}>
              <path d="M18 6 6 18M6 6 18 18" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
