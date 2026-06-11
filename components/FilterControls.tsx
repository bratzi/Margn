"use client";

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
  return (
    <div className="filters">
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

      <div className="fgroup">
        <div className="fglabel">Seitentyp</div>
        <select value={f.atype} onChange={(e) => f.setAtype(e.target.value)}>
          <option value="all">Alle Seiten</option>
          <option value="artikel">Artikel</option>
          <option value="paywall">Paywall-Seite</option>
          <option value="timeline">Timeline / Liveblog</option>
        </select>
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
            return (
              <button key={t.key} className={`tg ${on ? "on" : ""}`} onClick={() => f.toggleTopic(t.key)}>
                <span className="tg-check">{on ? "✓" : ""}</span><span>{t.label}</span><span className="tg-n">{t.n}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Group label="Sprache" value={f.lang} on={f.setLang} opts={[["all", "Alle"], ["de", "DE"], ["fr", "FR"]]} />
      <p className="faint" style={{ fontSize: 10.5, lineHeight: 1.5, marginTop: 6 }}>Zeitraum wählst du unten am Zeitstrahl. Schlagwörter über der Tabelle.</p>
    </div>
  );
}
