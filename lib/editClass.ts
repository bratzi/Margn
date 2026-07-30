// editClass.ts — Einstufung von Änderungen: WAS für eine Art Korrektur, mit welcher Absicht?
//
// Eine stille Änderung kann sehr verschiedene Gründe haben — eine Zahl war falsch, ein Name wurde
// getilgt, eine Wertung entschärft, nur die Überschrift fürs Schaufenster geschärft. Dieses Modul
// leitet die Absicht aus dem reinen Text ab (render-seitig, greift für alle vorhandenen Snapshots).
//
// GRUNDSATZ: jede Einstufung hat eine BEWEISSCHWELLE. Reicht die Evidenz nicht, wird nichts
// behauptet — die Änderung fällt still auf „Umformulierung" zurück. Lieber kein Label als ein
// falsches. Jede Einstufung trägt ihren `reason` mit, damit sie am Chip selbst nachprüfbar ist
// (z.B. „Zahl geändert: 12 → 14") — der Leser muss dem Label nicht glauben.
//
// Zwei Klassen: BELEGBAR (factual/typo/attribution/addition/deletion/showcase — am Text hart
// nachweisbar) und INTERPRETIEREND (tone/anonymization — brauchen Lexikon/Namensmuster und
// erscheinen NUR, wenn ihr enges Muster wirklich zündet).

export type EditTagKey =
  | "factual" | "typo" | "attribution" | "anonymization"
  | "sharpened" | "toned" | "addition" | "deletion" | "showcase" | "rephrase";

export type EditTag = { key: EditTagKey; label: string; reason: string; tone: "fact" | "hedge" | "heat" | "cool" | "grow" | "cut" | "neutral" };

// Anzeige-Reihenfolge = Beweiskraft: hartes zuerst, Deutung zuletzt, Struktur-Fallback ganz hinten.
const PRIO: Record<EditTagKey, number> = {
  factual: 0, anonymization: 1, attribution: 2, typo: 3,
  sharpened: 4, toned: 5, deletion: 6, addition: 7, showcase: 8, rephrase: 9,
};

export const TAG_META: Record<EditTagKey, { label: string; tone: EditTag["tone"] }> = {
  factual:       { label: "Faktenkorrektur", tone: "fact" },
  typo:          { label: "Schreibfehler",   tone: "neutral" },
  attribution:   { label: "Zuschreibung",    tone: "hedge" },
  anonymization: { label: "Anonymisierung",  tone: "cool" },
  sharpened:     { label: "Zugespitzt",      tone: "heat" },
  toned:         { label: "Entschärft",      tone: "cool" },
  addition:      { label: "Ergänzt",         tone: "grow" },
  deletion:      { label: "Gekürzt",         tone: "cut" },
  showcase:      { label: "Schaufenster",    tone: "neutral" },
  rephrase:      { label: "Umformuliert",    tone: "neutral" },
};

// --- Tokenisierung / Vergleich -----------------------------------------------------------
const stripPunct = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const norm = (w: string) => stripPunct(w).toLowerCase();
const words = (s: string) => s.split(/\s+/).map((w) => w.trim()).filter(Boolean);

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

// Zahlen (inkl. Datums-/Zeit-/Prozent-Formen) als Vergleichs-Multiset.
const NUM_RE = /\d[\d.,:]*/g;
function numbers(s: string): string[] { return (s.match(NUM_RE) ?? []).map((x) => x.replace(/[.,:]$/, "")); }

// Absicherungs-/Zuschreibungs-Marker (Konjunktiv, Quellenverweis, Vagheit).
const HEDGE = new Set([
  "soll", "sollen", "solle", "sollte", "angeblich", "mutmaßlich", "mutmasslich", "vermeintlich",
  "offenbar", "möglicherweise", "moeglicherweise", "wohl", "vermutlich", "sogenannte", "sogenannten",
  "sogenannter", "laut", "zufolge", "berichten", "demnach", "womöglich", "womoeglich", "angeben",
  "sei", "seien", "habe", "hätten", "haetten",
]);
const HEDGE_PHRASE = /\bnach angaben\b|\bBerichten zufolge\b|\bnach informationen\b/i;

// Wertungs-/Emotions-Lexikon („Hitze"). Verstärkung/Abschwächung mit Richtung.
const HEAT = new Set([
  "skandal", "eklat", "empörung", "empoerung", "wut", "chaos", "debakel", "drama", "dramatisch",
  "schock", "schockierend", "brutal", "brisant", "explosiv", "alarm", "krise", "verheerend",
  "katastrophal", "katastrophe", "wirbel", "aufregung", "zoff", "knall", "attacke", "eskalation",
  "massiv", "heftig", "wütend", "wuetend", "entsetzt", "empört", "empoert", "hammer", "beben",
  "desaster", "fiasko", "schande", "wahnsinn", "horror", "panik",
]);

// Generische Rollen-Marker, die einen getilgten Eigennamen ersetzen.
const ROLE = new Set([
  "angeklagte", "angeklagten", "beschuldigte", "beschuldigten", "tatverdächtige", "tatverdaechtige",
  "verdächtige", "verdaechtige", "betroffene", "betroffenen", "opfer", "täter", "taeter",
  "mann", "frau", "jugendliche", "jugendlichen", "person", "familie", "mitarbeiter", "kläger",
  "klaeger", "patient", "patientin",
]);

const isNameToken = (w: string) => /^[A-ZÄÖÜ][\p{L}.-]+$/u.test(stripPunct(w)) && stripPunct(w).length > 1;

// --- Einstufung EINES Text-Paares (alt → neu, beide vorhanden) ---------------------------
export function classifyPair(oldS: string, newS: string): EditTag[] {
  const out: EditTag[] = [];
  const ow = words(oldS), nw = words(newS);
  const oNorm = ow.map(norm).filter(Boolean);
  const nNorm = nw.map(norm).filter(Boolean);
  const oSet = new Set(oNorm), nSet = new Set(nNorm);
  const removed = oNorm.filter((w) => !nSet.has(w));
  const added = nNorm.filter((w) => !oSet.has(w));
  const commonN = oNorm.filter((w) => nSet.has(w)).length;
  const totalN = new Set([...oNorm, ...nNorm]).size || 1;
  const jaccard = commonN / totalN; // Anteil geteilter Wörter → „Rest steht, Detail geändert"

  const push = (key: EditTagKey, reason: string) => out.push({ key, label: TAG_META[key].label, reason, tone: TAG_META[key].tone });
  const q = (w: string) => `„${w}"`;

  // (1) FAKTENKORREKTUR — Zahlen unterscheiden sich, Satzgerüst bleibt weitgehend stehen.
  const oNums = numbers(oldS), nNums = numbers(newS);
  if (jaccard >= 0.4 && (oNums.length || nNums.length)) {
    const nSetNum = new Set(nNums), oSetNum = new Set(oNums);
    const gone = oNums.find((x) => !nSetNum.has(x));
    const came = nNums.find((x) => !oSetNum.has(x));
    if (gone && came) push("factual", `Zahl geändert: ${gone} → ${came}`);
    else if (gone && !nNums.length) push("factual", `Zahl entfernt: ${gone}`);
    else if (came && !oNums.length) push("factual", `Zahl ergänzt: ${came}`);
  }

  // (2) SCHREIBFEHLER — genau ein Wort getauscht, kleine Zeichendistanz, gemeinsamer Wortstamm.
  //     Eng gehalten (Länge ≥ 5, Präfix ≥ 3), damit grammatische Swaps (der→die) NICHT als
  //     Tippfehler durchgehen.
  if (removed.length === 1 && added.length === 1 && !/\d/.test(removed[0] + added[0])) {
    const a = removed[0], b = added[0];
    const dist = levenshtein(a, b);
    if (dist > 0 && dist <= 2 && Math.max(a.length, b.length) >= 5 && commonPrefix(a, b) >= 3)
      push("typo", `Schreibweise: ${q(a)} → ${q(b)}`);
  }

  // (3) ZUSCHREIBUNG — Absicherungs-Marker treten hinzu oder fallen weg (mit Richtung).
  const hedgeGone = removed.filter((w) => HEDGE.has(w));
  const hedgeCame = added.filter((w) => HEDGE.has(w));
  const phraseOld = HEDGE_PHRASE.test(oldS), phraseNew = HEDGE_PHRASE.test(newS);
  if (hedgeCame.length || (phraseNew && !phraseOld)) push("attribution", `Absicherung eingefügt: ${q(hedgeCame[0] ?? "nach Angaben")}`);
  else if (hedgeGone.length || (phraseOld && !phraseNew)) push("attribution", `Absicherung entfernt: ${q(hedgeGone[0] ?? "nach Angaben")}`);

  // (4) ANONYMISIERUNG (interpretierend, hart gegated) — ein Name verschwindet UND im Neutext
  //     steht ein generischer Rollen-Marker, der ihn ersetzt.
  const nameGone = ow.filter((w) => isNameToken(w) && !nSet.has(norm(w)) && !HEDGE.has(norm(w)));
  const roleCame = added.some((w) => ROLE.has(w));
  if (nameGone.length && roleCame) push("anonymization", `Name entfernt: ${q(nameGone.slice(0, 2).map(stripPunct).join(" "))}`);

  // (5) ZUSPITZUNG / ENTSCHÄRFUNG (interpretierend, Lexikon) — Wertungswort kommt/geht.
  const heatCame = added.filter((w) => HEAT.has(w));
  const heatGone = removed.filter((w) => HEAT.has(w));
  if (heatCame.length && heatCame.length >= heatGone.length && !out.some((t) => t.key === "factual"))
    push("sharpened", `Wertung eingefügt: ${q(heatCame[0])}`);
  else if (heatGone.length && heatGone.length > heatCame.length && !out.some((t) => t.key === "factual"))
    push("toned", `Wertung entfernt: ${q(heatGone[0])}`);

  // (6) FALLBACK — Text hat sich geändert, aber keine der belegbaren Absichten zündet.
  if (!out.length) push("rephrase", "gleiche Aussage, neu formuliert");
  return out;
}

// --- Einstufung eines ganzen Snapshots ---------------------------------------------------
// items = abgeglichene Changes (reconcileChanges), title = Überschrift-Paar falls geändert,
// bodyChanged = ob am Fließtext etwas geschah. Liefert bis zu `max` dedupte, nach Beweiskraft
// sortierte Chips.
export function classifySnapshot(
  opts: { items: { old?: string; new?: string }[]; titleOld?: string | null; titleNew?: string | null; bodyChanged: boolean },
  max = 3,
): EditTag[] {
  const bag: EditTag[] = [];

  for (const c of opts.items) {
    if (c.old && c.new) bag.push(...classifyPair(c.old, c.new));
    else if (c.new && !c.old) bag.push({ key: "addition", ...pick("addition"), reason: "Absatz hinzugefügt" });
    else if (c.old && !c.new) bag.push({ key: "deletion", ...pick("deletion"), reason: "Absatz entfernt" });
  }

  const titleChanged = !!(opts.titleOld && opts.titleNew);
  if (titleChanged) {
    // Nur-Überschrift-Änderung ohne Textänderung = Schaufenster (Klick-Optimierung).
    if (!opts.bodyChanged && !opts.items.length) bag.push({ key: "showcase", ...pick("showcase"), reason: "nur die Überschrift, Text unverändert" });
    else bag.push(...classifyPair(opts.titleOld!, opts.titleNew!));
  }

  // Dedupe je Schlüssel (stärksten/ersten Grund behalten), nach Beweiskraft sortieren.
  const byKey = new Map<EditTagKey, EditTag>();
  for (const t of bag) if (!byKey.has(t.key)) byKey.set(t.key, t);
  // „rephrase" nur zeigen, wenn es sonst NICHTS gibt — sonst ist es Rauschen neben echten Labels.
  const tags = [...byKey.values()].filter((t) => t.key !== "rephrase" || byKey.size === 1);
  return tags.sort((a, b) => PRIO[a.key] - PRIO[b.key]).slice(0, max);
}

function pick(key: EditTagKey) { return { label: TAG_META[key].label, tone: TAG_META[key].tone }; }
