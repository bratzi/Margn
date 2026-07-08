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
# 2026-06-19 — Re-Run: Lauf #83 (push, c63a7e2) war von der Concurrency gecancelt; manueller
#              Neustart der Pipeline auf demselben diffRegion-Stand.
# 2026-06-25 — Body-Tracking aus Roh-HTML (chooseBody Roh vs. gerendert) + recent_flips-
#              Oszillationssperre live (fed27f6); Baselines resettet → frischer Lauf mit neuem
#              Code soll sauber re-baselinen (kein JS-Widget-Müll, keine Phantom-Versionen).
# 2026-06-26 — Frischer Lauf zum Beobachten: 90-Tage-Recency-Filter + uniforme Feed-Discovery
#              + n-tv-Teaser/Dedup + recentFirst-Fix (00a86a4). Prüfen: alte Artikel→archive,
#              breitere Feed-Abdeckung, keine fälschlich archivierten aktuellen Artikel.
# 2026-07-08 - Sichtungs-Protokoll live (sightings-Tabelle): recordSightings an allen Link-Bump-Stellen + flushSightings am Lauf-Ende; Dashboard-Achse Zuletzt-gesehen zeigt echte Crawl-Events.
