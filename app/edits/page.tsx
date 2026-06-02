import DiffViewer from "@/components/DiffViewer";

export default function EditsPage() {
  return (
    <main style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontWeight: 500 }}>Geänderte Überschriften</h1>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Schlagzeilen, die nach Veröffentlichung still verändert wurden – mit hervorgehobenen
        Wortunterschieden und Zeitversatz zur Erstmeldung.
      </p>
      <DiffViewer />
    </main>
  );
}
