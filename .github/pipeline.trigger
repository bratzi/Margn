# pipeline-Auslöser
# Eine Änderung an dieser Datei (neue Zeile / Datum) startet den pipeline-Workflow
# (.github/workflows/analyze.yml: Entdeckung + Rendern) sofort — ohne UI/Token.
#
# Läufe:
# 2026-06-18 — Budget rauf (MAX_PAGES 2500, RESCAN_SHARE 0.6 → ~1500 Re-Scans/Lauf);
#              Fällig-Pool (809, u.a. Artikel 74876) in einem Lauf abräumen.
# 2026-06-18 — cleanBody: Bild-/n-tv-Kopf-Chrome aus dem Body-Tracking entfernen (saubere Re-Baseline).
# 2026-06-18 — Re-Baseline-Zyklus anstoßen (vor dem Chrome-Snapshot-Cleanup).
# 2026-06-19 — Re-Baseline-Schutz in trackChanges: alte Baseline (Bild/n-tv) vor Vergleich
#              identisch via cleanBody normalisieren → keine Chrome-Übergangs-Pseudo-Edits mehr.
# 2026-06-19 — pubdate-Vergleich gegen zuletzt gemeldeten Seitenwert (statt kanonische
#              published_at) → keine Geister-„Datums-Edits" mehr bei stabiler Quellen-Uneinigkeit
#              (alle Verlage); kein Body-Diff bei reinen Datums-/Meta-Edits. + Paywall-Diagnose-Log.
# 2026-06-19 — Liveblog/Timeline: bekannte Liveblogs bleiben „extension" (isTimeline erkennt
#              article_type=liveblog); append-only-Diff (nur Neuzugänge, removed=0) — alle Verlage.
# 2026-06-19 — buildChanges speichert die tatsächlich geänderte STELLE (diffRegion, Kontext)
#              statt der ersten 1500 Zeichen → keine scheinbar identischen „stillen Edits" mehr.
