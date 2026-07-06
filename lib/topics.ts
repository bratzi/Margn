// Kanonische Themen-Labels (Anzeige). Schlüssel = articles.topic (vom Scraper gesetzt).
export const TOPIC_LABEL: Record<string, string> = {
  politik: "Politik",
  wirtschaft: "Wirtschaft",
  sport: "Sport",
  kultur: "Kultur & Medien",
  wissen: "Wissen & Klima",
  digital: "Digital & Technik",
  panorama: "Panorama & Gesellschaft",
  regional: "Regional & Lokales",
  gesundheit: "Gesundheit",
  reise: "Reise",
  auto: "Mobilität",
  meinung: "Meinung",
  sonstiges: "Sonstiges",
};
export const topicLabel = (k: string) => TOPIC_LABEL[k] ?? k;

// Alle kanonischen Themen AUSSER Regional — für Server-RPCs mit positiver p_topics-Liste
// (keyword_opts_f/keyword_trends), wenn „Regional & Lokales" ausgeblendet ist. Die DB kennt
// exakt diese Schlüssel (verifiziert 2026-07-06; 3 NULL-Topic-Zeilen, vernachlässigbar).
export const TOPICS_SANS_REGIONAL = Object.keys(TOPIC_LABEL).filter((k) => k !== "regional");
