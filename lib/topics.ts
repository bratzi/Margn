// Kanonische Themen-Labels (Anzeige). Schlüssel = articles.topic (vom Scraper gesetzt).
export const TOPIC_LABEL: Record<string, string> = {
  politik: "Politik",
  wirtschaft: "Wirtschaft",
  sport: "Sport",
  kultur: "Kultur & Medien",
  wissen: "Wissen & Klima",
  digital: "Digital & Technik",
  panorama: "Panorama & Gesellschaft",
  gesundheit: "Gesundheit",
  reise: "Reise",
  auto: "Mobilität",
  meinung: "Meinung",
  sonstiges: "Sonstiges",
};
export const topicLabel = (k: string) => TOPIC_LABEL[k] ?? k;
