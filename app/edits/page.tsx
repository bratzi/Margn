import DiffViewer from "@/components/DiffViewer";

export const dynamic = "force-dynamic";

export default function EditsPage() {
  return (
    <div className="wrap">
      <div className="title">Stille Edits</div>
      <div className="subtitle" style={{ marginBottom: 20, maxWidth: 720 }}>
        Schlagzeilen, die nach Veröffentlichung still verändert wurden — mit hervorgehobenen
        Wortunterschieden und Zeitversatz zur Erstmeldung.
      </div>
      <DiffViewer />
    </div>
  );
}
