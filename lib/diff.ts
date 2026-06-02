// Wort-Level-Diff für Überschriften-Vergleich.
// Bewusst simpel (Mengen-basiert) – reicht für kurze Titel. Für lange Texte
// ließe sich später ein echtes LCS-Diff (z. B. "diff-match-patch") einsetzen.

export type DiffToken = { text: string; changed: boolean };

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function wordDiff(a: string, b: string): { before: DiffToken[]; after: DiffToken[] } {
  const aw = a.split(/\s+/).filter(Boolean);
  const bw = b.split(/\s+/).filter(Boolean);
  const setA = new Set(aw.map(norm));
  const setB = new Set(bw.map(norm));
  return {
    before: aw.map((w) => ({ text: w, changed: !setB.has(norm(w)) })),
    after: bw.map((w) => ({ text: w, changed: !setA.has(norm(w)) })),
  };
}

export type EditKind = "toned_down" | "sharpened" | "factual" | "other";

// Platzhalter-Heuristik. In Stufe 2 ersetzt ein LLM diese Einordnung
// (Feld z. B. version_analysis.diff_note / .edit_kind) und schreibt sie in die DB.
const TONE_DOWN = /(skandal|empörung|rücktritt|massiv|schock|attacke|covering up|accused)/i;
const SHARPEN = /(attacke|massiv|skandal|despido|recorta|großeinsatz)/i;

export function classifyEdit(before: string, after: string): EditKind {
  const lostHeat = TONE_DOWN.test(before) && !TONE_DOWN.test(after);
  const gainedHeat = SHARPEN.test(after) && !SHARPEN.test(before);
  if (lostHeat && !gainedHeat) return "toned_down";
  if (gainedHeat && !lostHeat) return "sharpened";
  // grobe Zahl-Änderung -> Faktenkorrektur
  const numsBefore = (before.match(/\d+[.,]?\d*/g) ?? []).join();
  const numsAfter = (after.match(/\d+[.,]?\d*/g) ?? []).join();
  if (numsBefore && numsAfter && numsBefore !== numsAfter) return "factual";
  return "other";
}

export const KIND_META: Record<EditKind, { label: string; bg: string; fg: string; accent: string }> = {
  toned_down: { label: "entschärft", bg: "#E6F1FB", fg: "#0C447C", accent: "#378ADD" },
  sharpened:  { label: "zugespitzt", bg: "#FAECE7", fg: "#712B13", accent: "#D85A30" },
  factual:    { label: "faktenkorrektur", bg: "#F1EFE8", fg: "#444441", accent: "#888780" },
  other:      { label: "geändert", bg: "#F1EFE8", fg: "#444441", accent: "#888780" },
};
