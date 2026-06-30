import Link from "next/link";
import { ArrowLeft, TrendingUp } from "@/components/icons";
import KeywordTrends from "@/components/KeywordTrends";

export const metadata = { title: "Keyword-Trends – margn" };

export default function KeywordsPage() {
  return (
    <>
      <div className="topbar">
        <Link href="/articles" className="back"><ArrowLeft size={15} /> Übersicht</Link>
        <h1>Keyword-Trends</h1>
        <span className="live"><TrendingUp size={14} /> Themen-Brisanz im Zeitverlauf</span>
      </div>
      <KeywordTrends />
    </>
  );
}
