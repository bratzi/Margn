"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Detail = {
  id: number; url: string; title: string | null; description: string | null; og_image: string | null;
  published_at: string | null; modified_at: string | null; paywalled: boolean | null;
  word_count: number | null; reading_min: number | null; article_type: string | null;
  lang_detected: string | null; first_seen: string | null; last_seen: string | null;
  outlet: string; country: string; base_url: string; depth: number | null;
};
type Author   = { authors:     { name: string } | null };
type Keyword  = { keywords:    { term: string } | null };
type Category = { categories:  { name: string } | null };

const FLAG: Record<string, string> = { DE: "🇩🇪", FR: "🇫🇷", GB: "🇬🇧", US: "🇺🇸" };
const LANG:  Record<string, string> = { de: "Deutsch", fr: "Français", en: "English" };
const TYPE_LABEL: Record<string, string> = {
  news: "Nachricht", opinion: "Meinung", analysis: "Analyse", liveblog: "Liveblog",
  review: "Rezension", reportage: "Reportage", interactive: "Interaktiv", interview: "Interview",
};
const TYPE_COLOR: Record<string, string> = {
  news: "#5b8cff", opinion: "#f0b429", analysis: "#3ecf8e", liveblog: "#f4607a",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDateShort(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric" });
}
function pathSegments(url: string, base: string) {
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    return path.split("/").filter(Boolean);
  } catch { return []; }
}

export default function ArticleDetail({ id }: { id: number }) {
  const [article, setArticle] = useState<Detail | null>(null);
  const [authors, setAuthors] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("article_detail")
        .select("*")
        .eq("id", id)
        .single();
      if (!data) { setLoading(false); return; }
      setArticle(data as Detail);

      const [au, kw, cat] = await Promise.all([
        supabase.from("article_authors").select("authors(name)").eq("article_id", id),
        supabase.from("article_keywords").select("keywords(term)").eq("article_id", id),
        supabase.from("article_categories").select("categories(name)").eq("article_id", id),
      ]);
      setAuthors(((au.data ?? []) as any[]).map((r) => r.authors?.name).filter(Boolean));
      setKeywords(((kw.data ?? []) as any[]).map((r) => r.keywords?.term).filter(Boolean));
      setCategories(((cat.data ?? []) as any[]).map((r) => r.categories?.name).filter(Boolean));
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="wrap"><p className="muted">Lade…</p></div>;
  if (!article) return <div className="wrap"><p className="muted">Artikel nicht gefunden.</p></div>;

  const segs = pathSegments(article.url, article.base_url);
  const typeColor = TYPE_COLOR[article.article_type ?? "news"] ?? "#5b8cff";

  return (
    <div className="wrap" style={{ maxWidth: 900 }}>
      {/* Back */}
      <Link href="/articles" className="muted" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 20 }}>
        ← Alle Artikel
      </Link>

      {/* Hero */}
      {article.og_image && (
        <div style={{ borderRadius: 12, overflow: "hidden", marginBottom: 24, maxHeight: 340, background: "var(--panel)" }}>
          <img src={article.og_image} alt="" style={{ width: "100%", objectFit: "cover", maxHeight: 340, display: "block" }} />
        </div>
      )}

      {/* Outlet + Type */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <a href={article.base_url} target="_blank" rel="noreferrer" style={{ fontWeight: 700, fontSize: 14, color: "var(--accent)" }}>
          {FLAG[article.country] ?? ""} {article.outlet}
        </a>
        <span className="badge" style={{ background: `${typeColor}22`, color: typeColor }}>
          {TYPE_LABEL[article.article_type ?? "news"] ?? article.article_type}
        </span>
        {article.paywalled === true && (
          <span className="badge" style={{ background: "rgba(244,96,122,.15)", color: "#f4607a" }}>🔒 Paywall</span>
        )}
        {article.paywalled === false && (
          <span className="badge" style={{ background: "rgba(62,207,142,.1)", color: "#3ecf8e" }}>🔓 Frei</span>
        )}
        {article.lang_detected && (
          <span className="badge" style={{ background: "var(--panel-2)", color: "var(--text-dim)" }}>
            {LANG[article.lang_detected] ?? article.lang_detected}
          </span>
        )}
      </div>

      {/* Titel */}
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.25, marginBottom: 12, color: "var(--text)" }}>
        {article.title ?? article.url.replace(/^https?:\/\/(www\.)?/, "")}
      </h1>

      {/* Beschreibung */}
      {article.description && (
        <p style={{ fontSize: 15, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 20, borderLeft: "3px solid var(--border)", paddingLeft: 14 }}>
          {article.description}
        </p>
      )}

      {/* Stats-Leiste */}
      <div className="panel pad" style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat label="Veröffentlicht" value={fmtDate(article.published_at)} />
        {article.modified_at && article.modified_at !== article.published_at && (
          <Stat label="Aktualisiert" value={fmtDate(article.modified_at)} accent="#f0b429" />
        )}
        {article.word_count && <Stat label="Wörter" value={article.word_count.toLocaleString("de-DE")} />}
        {article.reading_min && <Stat label="Lesezeit" value={`${article.reading_min} Min`} />}
        <Stat label="Entdeckt" value={fmtDateShort(article.first_seen)} />
      </div>

      {/* Autoren */}
      {authors.length > 0 && (
        <Section title="Autoren">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {authors.map((a) => <Tag key={a} text={a} color="var(--accent)" />)}
          </div>
        </Section>
      )}

      {/* Kategorien */}
      {categories.length > 0 && (
        <Section title="Ressort / Kategorie">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {categories.map((c) => <Tag key={c} text={c} color="#3ecf8e" />)}
          </div>
        </Section>
      )}

      {/* Keywords */}
      {keywords.length > 0 && (
        <Section title="Keywords">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {keywords.map((k) => <Tag key={k} text={k} />)}
          </div>
        </Section>
      )}

      {/* Pfad im Seitenbaum */}
      {segs.length > 0 && (
        <Section title="Position im Seitenbaum">
          <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 12.5 }}>
            <span className="muted">{article.base_url.replace(/^https?:\/\/(www\.)?/, "")}</span>
            {segs.map((seg, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center" }}>
                <span className="muted" style={{ margin: "0 4px" }}>/</span>
                <span style={{ color: i === segs.length - 1 ? "var(--accent)" : "var(--text-dim)", padding: "2px 6px", background: "var(--panel-2)", borderRadius: 5 }}>{seg}</span>
              </span>
            ))}
          </div>
          {article.depth != null && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Tiefe im Seitenbaum: {article.depth} Ebenen von der Startseite</p>
          )}
        </Section>
      )}

      {/* Ähnliche Artikel (Platzhalter) */}
      <Section title="Ähnliche Artikel anderer Verlage">
        <div className="muted" style={{ fontSize: 13, padding: "16px", background: "var(--panel-2)", borderRadius: 8, borderLeft: "3px solid var(--border)" }}>
          Dieses Feature wird aktiviert, sobald das Cluster-Feature reaktiviert wird. Es zeigt dann
          Artikel anderer Verlage, die dieselbe Story behandeln — mit Ähnlichkeitswert und Zeitversatz.
        </div>
      </Section>

      {/* Original öffnen */}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
        <a href={article.url} target="_blank" rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "var(--accent)", color: "#fff", padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: 14 }}>
          Originalartikel öffnen ↗
        </a>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: accent ?? "var(--text)" }}>{value}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel pad" style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}
function Tag({ text, color }: { text: string; color?: string }) {
  return (
    <span style={{ fontSize: 12.5, padding: "4px 10px", borderRadius: 99, background: color ? `${color}18` : "var(--panel-2)", color: color ?? "var(--text-dim)", border: `1px solid ${color ? `${color}33` : "var(--border)"}` }}>
      {text}
    </span>
  );
}
