// Publizistenübergreifendes Themen-Schema. Mappt verlagseigene Rubriken (DE+FR) + URL-Pfad
// auf ein gemeinsames kanonisches Thema. Reihenfolge = Priorität (spezifisch → allgemein).

export const TOPICS: { key: string; label: string; rx: RegExp }[] = [
  { key: "meinung",   label: "Meinung",            rx: /(meinung|kommentar|kolumne|standpunkt|gastbeitrag|debatte|leitartikel|opinion|id´?e?es|tribune|chronique|editorial)/i },
  { key: "sport",     label: "Sport",              rx: /(sport|fussball|fußball|bundesliga|champions|tennis|olympia|formel ?1|football|rugby|cyclisme|basket|nba|wm-|em-|roland-garros)/i },
  { key: "wirtschaft",label: "Wirtschaft",         rx: /(wirtschaft|finanz|boerse|börse|aktie|economie|économie|geld|unternehmen|konjunktur|handel|arbeitsmarkt|immobilien|steuer|verbraucher)/i },
  { key: "digital",   label: "Digital & Technik",  rx: /(digital|netzwelt|netzpolitik|techn|pixels|\bki\b|k%C3%BCnstliche-intelligenz|kuenstliche-intelligenz|internet|computer|smartphone|games|gaming|cyber)/i },
  { key: "wissen",    label: "Wissen & Klima",     rx: /(wissen|wissenschaft|forschung|science|klima|umwelt|natur|energie|weltraum|raumfahrt|planete|planète|biolog|physik|gesund.{0,3}umwelt)/i },
  { key: "gesundheit",label: "Gesundheit",         rx: /(gesundheit|medizin|sant[eé]|pflege|krankheit|psycholog|ern[aä]hrung)/i },
  { key: "kultur",    label: "Kultur & Medien",    rx: /(kultur|culture|kino|film|musik|literatur|buch|b[uü]cher|kunst|theater|medien|fernsehen|\btv\b|serie|streaming|festival)/i },
  { key: "reise",     label: "Reise",              rx: /(reise|travel|tourism|voyage|urlaub)/i },
  { key: "auto",      label: "Mobilität",          rx: /(auto|mobilit|motor|verkehr|bahn|luftfahrt|e-auto)/i },
  { key: "panorama",  label: "Panorama & Gesellschaft", rx: /(panorama|gesellschaft|vermischt|leute|menschen|boulevard|unterhaltung|stars|royal|soci[eé]t[eé]|faits-divers|justiz|kriminal|regional|lokales|aus-aller-welt)/i },
  { key: "politik",   label: "Politik",            rx: /(politik|inland|ausland|international|europa|amerika|asien|afrika|ozeanien|nahost|naher-osten|ukraine|wahl|bundestag|politique|étranger|monde|gouvernement|election)/i },
];

export function topicOf(categories: string[], url: string): string {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = url.toLowerCase(); }
  const hay = (categories.join(" ") + " " + path).toLowerCase();
  for (const t of TOPICS) if (t.rx.test(hay)) return t.key;
  return "sonstiges";
}

export const TOPIC_LABEL: Record<string, string> =
  Object.fromEntries([...TOPICS.map((t) => [t.key, t.label]), ["sonstiges", "Sonstiges"]]);
