"use client";

import { useState } from "react";
import { useFilters } from "@/components/FilterProvider";

const favicon = (base: string) => { try { return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(base).host}`; } catch { return ""; } };
const short = (n: string) => n.replace(" Online", "");

function Group({ label, value, opts, on }: { label: string; value: string; opts: [string, string][]; on: (v: string) => void }) {
  return (
    <div className="fgroup">
      <div className="fglabel">{label}</div>
      <div className="seg fseg">
        {opts.map(([k, l]) => <button key={k} className={value === k ? "on" : ""} onClick={() => on(k)}>{l}</button>)}
      </div>
    </div>
  );
}

export default function FilterControls() {
  const f = useFilters();
  // Welche Hauptthemen sind aufgeklappt (zeigen ihre Unterthemen)?
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExp = (t: string) =>
    setExpanded((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; });
  // Sind überhaupt Filter gesetzt? (steuert den globalen Reset-Button)
  const anyActive =
    f.activeArr.length !== f.sources.length || f.status !== "all" || f.paywall !== "all" ||
    f.author !== "all" || f.atype !== "all" || f.topics.length > 0 || f.subcats.length > 0 ||
    f.keyword !== "all" || f.lang !== "all" || f.changed !== "all" || f.depth !== "all" ||
    f.search.trim().length > 0 || f.searchTerms.length > 0 || !f.hideRegional;

  return (
    <div className="filters">
      {/* Volltextsuche über die Metadaten: Titel/URL/Teaser/Thema/Schlagwörter/Rubriken.
          (Artikelinhalt-Suche 2026-07-05 entfernt: 52-MB-Index + RPC-Timeout, s. search_articles.sql.)
          Schränkt Tabelle UND Analytik ein (UND-verknüpft mit den übrigen Filtern). */}
      <div className="fgroup">
        <div className="fglabel">Volltextsuche</div>
        <div className="fsearch">
          <svg className="fsearch-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input type="search" value={f.search} onChange={(e) => f.setSearch(e.target.value)} spellCheck={false}
            onKeyDown={(e) => {
              // Enter übernimmt den Begriff als eigenständigen Such-Chip und leert das Feld
              // für den nächsten — so lassen sich MEHRERE Suchen zugleich anwenden.
              if (e.key === "Enter" && f.search.trim().length >= 2) { e.preventDefault(); f.addSearchTerm(f.search); f.setSearch(""); }
            }}
            placeholder="Titel, Teaser, Schlagwort, URL …" aria-label="Volltextsuche" />
          {f.search && <button className="fsearch-x" onClick={() => f.setSearch("")} aria-label="Suche löschen" title="Suche löschen">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>}
        </div>
        {f.searchTerms.length > 0 && (
          <div className="fsearch-chips">
            {f.searchTerms.map((t) => {
              const n = f.termCounts.get(t);
              return (
                <button key={t} className="fchip" onClick={() => f.removeSearchTerm(t)} title={`Suche „${t}" entfernen`}>
                  <span className="fchip-q">{t}</span>
                  <span className="fchip-n">{n == null ? "…" : `${n.toLocaleString("de-DE")}${n >= 1200 ? "+" : ""}`}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              );
            })}
          </div>
        )}
        {f.search.trim().length >= 2 && (
          <div className="fsearch-hint">
            {f.searchPending ? "sucht …"
              : f.searchCount != null ? `${f.searchCount.toLocaleString("de-DE")}${f.searchCount >= 1200 ? "+" : ""} Treffer in Titel, Teaser, Schlagwörtern & Rubriken · ⏎ übernimmt als Filter`
              : ""}
          </div>
        )}
        {f.search.trim().length === 1 && <div className="fsearch-hint">mind. 2 Zeichen</div>}
        {f.searchTerms.length > 1 && !f.search.trim() && <div className="fsearch-hint">Mehrere Begriffe wirken ODER-verknüpft (Treffer zu irgendeinem Begriff).</div>}
      </div>

      {anyActive && (
        <button className="freset-all" onClick={f.resetAll} title="Alle Filter auf Ausgangszustand">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          Alle Filter zurücksetzen
        </button>
      )}
      <div className="fgroup">
        <div className="fglabel">Publizisten
          <span className="fg-actions"><button onClick={() => f.setAll(true)}>alle</button><button onClick={() => f.setAll(false)}>keine</button></span>
        </div>
        <div className="publist">
          {f.sources.map((s) => {
            const on = f.active.has(s.id);
            return (
              <button key={s.id} className={`pubrow ${on ? "on" : ""}`} onClick={() => f.toggle(s.id)} aria-pressed={on}>
                <img src={favicon(s.base_url)} alt="" width={18} height={18} />
                <span className="pn">{short(s.name)}</span>
                <span className="cc">{s.country}</span>
                <span className={`check ${on ? "on" : ""}`}>{on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Group label="Erfassung" value={f.status} on={f.setStatus} opts={[["all", "Alle"], ["new", "Neu"], ["rescanned", "Wiederholt"]]} />
      <Group label="Bezahlschranke" value={f.paywall} on={f.setPaywall} opts={[["all", "Alle"], ["no", "Frei"], ["yes", "Paywall"]]} />
      <Group label="Autor" value={f.author} on={f.setAuthor} opts={[["all", "Alle"], ["named", "Namentl."], ["anonymous", "Anonym"], ["none", "Ohne"]]} />
      {/* Stille Änderungen: das Alleinstellungsmerkmal des Observatoriums als Filter */}
      <Group label="Nachträgliche Änderungen" value={f.changed} on={f.setChanged} opts={[["all", "Alle"], ["yes", "Geändert"], ["no", "Unverändert"]]} />
      <Group label="Artikel-Tiefe" value={f.depth} on={f.setDepth} opts={[["all", "Alle"], ["kurz", "< 300 W."], ["mittel", "300–900"], ["lang", "> 900 W."]]} />

      <div className="fgroup">
        <div className="fglabel">Seitentyp</div>
        <select value={f.atype} onChange={(e) => f.setAtype(e.target.value)}>
          <option value="all">Alle Seiten</option>
          <option value="artikel">Artikel</option>
          <option value="paywall">Paywall-Seite</option>
          <option value="timeline">Timeline / Liveblog</option>
        </select>
      </div>

      {/* Regional & Lokales: ~24 % des Volumens, erschlägt jede Verteilung → Default AUS,
          zuschaltbar. Beim Ausblenden räumt der Provider eine Regional-Themenwahl mit ab. */}
      <div className="fgroup">
        <div className="fglabel">Regional &amp; Lokales</div>
        <div className="seg fseg">
          <button className={f.hideRegional ? "on" : ""} onClick={() => f.setHideRegional(true)} title="Regional-Meldungen aus allen Auswertungen ausblenden (Standard)">Ausgeblendet</button>
          <button className={!f.hideRegional ? "on" : ""} onClick={() => f.setHideRegional(false)} title="Regional-Meldungen einbeziehen — dominieren das Volumen (~24 %)">Einbezogen</button>
        </div>
        {!f.hideRegional && <div className="fsearch-hint">Regional-Meldungen dominieren das Volumen und verzerren Themen-Verteilungen.</div>}
      </div>

      {/* Themen als scrollbare Multiselect-Toggle-Liste */}
      <div className="fgroup">
        <div className="fglabel">Themen
          <span className="fg-actions">{f.topics.length > 0 && <button onClick={() => f.setTopics([])}>zurücksetzen</button>}</span>
        </div>
        <div className="topic-toggles">
          <button className={`tg ${f.topics.length === 0 ? "on" : ""}`} onClick={() => f.setTopics([])}>Alle Themen</button>
          {f.topicOpts.map((t) => {
            const on = f.topics.includes(t.key);
            const subs = f.catTree.get(t.key) ?? [];
            const exp = expanded.has(t.key);
            const selSubs = subs.filter((s) => f.subcats.includes(s.key)).length;
            return (
              <div key={t.key} className="tg-block">
                <div className="tg-row">
                  <button className={`tg ${on ? "on" : ""}`} onClick={() => f.toggleTopic(t.key)}>
                    <span className="tg-check">{on ? "✓" : ""}</span><span>{t.label}</span><span className="tg-n">{t.n}</span>
                  </button>
                  {subs.length > 0 && (
                    <button
                      className={`tg-exp ${exp ? "open" : ""} ${selSubs ? "has-sel" : ""}`}
                      onClick={() => toggleExp(t.key)}
                      title={`${subs.length} Unterthemen${selSubs ? ` · ${selSubs} aktiv` : ""}`}
                      aria-expanded={exp}
                    >
                      {selSubs > 0 && <i className="tg-exp-n">{selSubs}</i>}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                    </button>
                  )}
                </div>
                {exp && (
                  <div className="tg-subs">
                    {subs.map((s) => {
                      const son = f.subcats.includes(s.key);
                      return (
                        <button key={s.key} className={`tg-sub ${son ? "on" : ""}`} onClick={() => f.toggleSubcat(s.key)}
                          title={`${s.label} · ${s.n} Artikel · ${s.sources} ${s.sources === 1 ? "Quelle" : "Quellen"}`}>
                          <span className="tg-sub-arm">↳</span>
                          <span className="tg-sub-name">{s.label}</span>
                          <span className="tg-n">{s.n}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sprachfilter bewusst ausgebaut: der Korpus ist bisher rein deutschsprachig — eine
          Alle/DE/FR-Auswahl wäre eine leere Option. Der lang-State im FilterProvider bleibt
          (Default "all"), damit RPC-Signaturen stabil sind; UI kommt mit mehrsprachigen Quellen wieder. */}
      <p className="faint" style={{ fontSize: 10.5, lineHeight: 1.5, marginTop: 6 }}>Zeitraum wählst du unten am Zeitstrahl. Schlagwörter über der Tabelle.</p>
    </div>
  );
}
