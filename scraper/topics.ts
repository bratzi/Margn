// Publizistenübergreifendes Themen-Schema. Mappt verlagseigene Rubriken (DE+FR) + URL-Pfad
// auf ein gemeinsames kanonisches Thema. Reihenfolge = Priorität (spezifisch → allgemein).

export const TOPICS: { key: string; label: string; rx: RegExp }[] = [
  { key: "meinung",   label: "Meinung",            rx: /(meinung|kommentar|kolumne|standpunkt|gastbeitrag|debatte|leitartikel|opinion|id´?e?es|tribune|chronique|editorial|le-club|blogs?)/i },
  { key: "sport",     label: "Sport",              rx: /(sport|fussball|fußball|bundesliga|champions|tennis|olympia|formel ?1|football|rugby|cyclisme|basket|nba|wm-|em-|roland-garros|hooligan)/i },
  { key: "wirtschaft",label: "Wirtschaft",         rx: /(wirtschaft|finanz|boerse|börse|aktie|economie|économie|geld|unternehmen|konjunktur|handel|arbeitsmarkt|immobilien|steuer|verbraucher|emploi|argent|job|karriere|shopping-und-service)/i },
  { key: "digital",   label: "Digital & Technik",  rx: /(digital|netzwelt|netzpolitik|techn|pixels|\bki\b|k%C3%BCnstliche-intelligenz|kuenstliche-intelligenz|internet|computer|smartphone|games?|gaming|cyber)/i },
  { key: "wissen",    label: "Wissen & Klima",     rx: /(wissen|wissenschaft|forschung|science|sciences|klima|umwelt|natur|energie|weltraum|raumfahrt|planete|planète|biolog|physik|gesund.{0,3}umwelt|geschichte|histoire|campus|bildung|education|schule|universit)/i },
  { key: "gesundheit",label: "Gesundheit",         rx: /(gesundheit|medizin|sant[eé]|pflege|krankheit|psycholog|ern[aä]hrung|ratgeber.*gesund|tofu|dialyse|fitness|diaet|diät)/i },
  // Kultur inkl. Le-Monde-Rubriken (livres, cinema, arts, musiques) und Spiegel-Rezepte (effilee = Kultur/Genuss)
  { key: "kultur",    label: "Kultur & Medien",    rx: /(kultur|culture|kino|cinema|cinéma|film|musik|musiques?|literatur|livres?|buch|b[uü]cher|kunst|arts?|theater|medien|fernsehen|\btv\b|serie|streaming|festival|effilee|gastronom|le-gout|bande-dessinee)/i },
  { key: "reise",     label: "Reise",              rx: /(reise|travel|tourism|voyage|urlaub)/i },
  { key: "auto",      label: "Mobilität",          rx: /(auto|mobilit|motor|verkehr|bahn|luftfahrt|e-auto)/i },
  // Panorama inkl. Lokales (rhein-main, regional), Lifestyle (m-perso, vous, l-epoque), Tagesticker (der_tag), Produkt-/Ratgeber
  { key: "panorama",  label: "Panorama & Gesellschaft", rx: /(panorama|gesellschaft|vermischt|leute|menschen|boulevard|unterhaltung|stars|royal|soci[eé]t[eé]|faits-divers|justiz|kriminal|regional|lokales|aus-aller-welt|rhein-main|der[-_]tag|tagesthemen|produkt-check|ratgeber|m-perso|m-le-mag|\bvous\b|l-epoque|epoque|le-gout-du-monde|specials|disparitions|religions?|tagesschau|\bstil\b|familie|famille|lifestyle|deinspiegel|dein-spiegel|panorama)/i },
  // Politik inkl. Le-Monde-Faktencheck (les-decodeurs) + Tagesschau-Faktenfinder/Investigativ, Länder-Rubriken
  { key: "politik",   label: "Politik",            rx: /(politik|inland|ausland|international|europa|amerika|asien|afrika|ozeanien|nahost|naher-osten|ukraine|wahl|bundestag|politique|étranger|etranger|\bmonde\b|gouvernement|election|les-decodeurs|decodeurs|faktenfinder|faktencheck|investigativ|immigration|midterms|presidentielle|correspondents?)/i },
];

// Themen-Zuordnung. WICHTIG: Die URL-Rubrik hat VORRANG vor den Kategorien-Tags.
// Grund: Verlage (v.a. Le Monde) hängen lose Dossier-Tags an Artikel ("Livres",
// "Disparitions"), die NICHT das Hauptressort sind. Ein /international/-Artikel mit
// Kultur-Tag ist Politik, nicht Kultur. Darum erst die URL-Sektionen prüfen, erst
// danach (als Fallback) die Kategorien.
// Der Slug (letztes Pfad-Segment = Überschrift) wird NIE geprüft (enthält Zufallswörter).
export function topicOf(categories: string[], url: string): string {
  let segs: string[] = [];
  try {
    segs = new URL(url).pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean);
  } catch { segs = []; }
  // Slug weg, Datums-/Zahl-/Boilerplate-Segmente weg ("article", "articles" sind Le-Monde-Füllsel)
  const sections = segs
    .slice(0, Math.max(0, segs.length - 1))
    .filter((s) => !/^\d+$/.test(s) && !/-\d{4,}/.test(s) && !/^articles?$/.test(s));

  // 1) URL-Rubrik (verlässlichstes Signal)
  const urlHay = sections.join(" ");
  for (const t of TOPICS) if (t.rx.test(urlHay)) return t.key;

  // 2) Fallback: Kategorien-Tags
  const catHay = categories.join(" ").toLowerCase();
  for (const t of TOPICS) if (t.rx.test(catHay)) return t.key;

  return "sonstiges";
}

export const TOPIC_LABEL: Record<string, string> =
  Object.fromEntries([...TOPICS.map((t) => [t.key, t.label]), ["sonstiges", "Sonstiges"]]);
