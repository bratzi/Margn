import EchoTimeline from "@/components/EchoTimeline";

export const dynamic = "force-dynamic";

export default function EchoesPage() {
  return (
    <div className="wrap">
      <div className="title">Echo-Cluster</div>
      <div className="subtitle" style={{ marginBottom: 20, maxWidth: 720 }}>
        Wer hatte eine Geschichte zuerst — und wer zog mit welchem Zeitversatz und welcher
        Textähnlichkeit nach? Hohe Ähnlichkeit kurz nach der Erstmeldung deutet auf übernommene Inhalte.
      </div>
      <EchoTimeline />
    </div>
  );
}
