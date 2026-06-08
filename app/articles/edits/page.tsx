import Link from "next/link";
import { ArrowLeft, Clock } from "@/components/icons";
import EditsDashboard from "@/components/EditsDashboard";

export const metadata = { title: "Silent Edits – margn" };

export default function EditsPage() {
  return (
    <>
      <div className="topbar">
        <Link href="/articles" className="back"><ArrowLeft size={15} /> Übersicht</Link>
        <h1>Silent Edits</h1>
        <span className="live"><Clock size={14} /> Stille Änderungen & Erweiterungen</span>
      </div>
      <EditsDashboard />
    </>
  );
}
