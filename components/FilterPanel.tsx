"use client";

export type Src = { id: number; name: string; country: string; base_url: string };

const favicon = (base: string) => {
  try { return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(base).host}`; }
  catch { return ""; }
};
const short = (n: string) => n.replace(" Online", "");

type Props = {
  open: boolean; setOpen: (b: boolean) => void;
  sources: Src[];
  active: Set<number>; toggle: (id: number) => void; setAll: (on: boolean) => void;
  status: string; setStatus: (v: any) => void;
  paywall: string; setPaywall: (v: any) => void;
  atype: string; setAtype: (v: any) => void;
  author: string; setAuthor: (v: any) => void;
  topic: string; setTopic: (v: any) => void;
  topics: { key: string; label: string; n: number }[];
  lang: string; setLang: (v: any) => void;
  period: string; setPeriod: (v: any) => void;
};

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

export default function FilterPanel(p: Props) {
  if (!p.open) {
    // Eingeklappt: schmale Leiste nur mit Publizisten-Icons + Aufklapp-Button
    return (
      <aside className="rail rail-mini">
        <button className="rail-toggle" onClick={() => p.setOpen(true)} title="Filter aufklappen" aria-label="Filter aufklappen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18M6 12h12M10 20h4" /></svg>
        </button>
        <div className="mini-icons">
          {p.sources.map((s) => {
            const on = p.active.has(s.id);
            return (
              <button key={s.id} className={`pubicon ${on ? "" : "off"}`} onClick={() => p.toggle(s.id)} title={short(s.name)} aria-pressed={on}>
                <img src={favicon(s.base_url)} alt="" width={20} height={20} />
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="rail rail-open">
      <div className="rail-head">
        <span className="rail-title">Filter</span>
        <button className="rail-toggle" onClick={() => p.setOpen(false)} title="Einklappen" aria-label="Filter einklappen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>

      <div className="fgroup">
        <div className="fglabel">
          Publizisten
          <span className="fg-actions">
            <button onClick={() => p.setAll(true)}>alle</button>
            <button onClick={() => p.setAll(false)}>keine</button>
          </span>
        </div>
        <div className="publist">
          {p.sources.map((s) => {
            const on = p.active.has(s.id);
            return (
              <button key={s.id} className={`pubrow ${on ? "on" : ""}`} onClick={() => p.toggle(s.id)} aria-pressed={on}>
                <img src={favicon(s.base_url)} alt="" width={18} height={18} />
                <span className="pn">{short(s.name)}</span>
                <span className="cc">{s.country}</span>
                <span className={`check ${on ? "on" : ""}`}>
                  {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Group label="Status" value={p.status} on={p.setStatus} opts={[["all", "Alle"], ["analyzed", "Analysiert"], ["backlog", "Backlog"]]} />
      <Group label="Bezahlschranke" value={p.paywall} on={p.setPaywall} opts={[["all", "Alle"], ["no", "Frei"], ["yes", "Paywall"]]} />
      <Group label="Typ" value={p.atype} on={p.setAtype} opts={[["all", "Alle"], ["news", "News"], ["liveblog", "Liveblog"], ["opinion", "Meinung"], ["analysis", "Analyse"], ["timeline", "Timeline"]]} />
      <Group label="Autor" value={p.author} on={p.setAuthor} opts={[["all", "Alle"], ["named", "Namentlich"], ["anonymous", "Anonym"], ["none", "Ohne"]]} />

      <div className="fgroup">
        <div className="fglabel">Thema</div>
        <select value={p.topic} onChange={(e) => p.setTopic(e.target.value)} style={{ width: "100%" }}>
          <option value="all">Alle Themen</option>
          {p.topics.map((t) => <option key={t.key} value={t.key}>{t.label} ({t.n.toLocaleString("de-DE")})</option>)}
        </select>
      </div>
      <Group label="Sprache" value={p.lang} on={p.setLang} opts={[["all", "Alle"], ["de", "DE"], ["fr", "FR"]]} />
      <Group label="Veröffentlicht" value={p.period} on={p.setPeriod} opts={[["all", "Alle"], ["24h", "24 h"], ["7d", "7 Tage"], ["30d", "30 Tage"]]} />
    </aside>
  );
}
