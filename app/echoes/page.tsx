import EchoTimeline from "@/components/EchoTimeline";

export default function EchoesPage() {
  return (
    <main style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontWeight: 500 }}>Echo-Zeitleiste</h1>
      <p style={{ color: "var(--color-text-secondary)" }}>
        Wer hatte eine Geschichte zuerst – und wer zog mit welchem Zeitversatz und welcher
        Textähnlichkeit nach? Hohe Ähnlichkeit kurz nach der Erstmeldung deutet auf übernommene Inhalte.
      </p>
      <EchoTimeline />
    </main>
  );
}
