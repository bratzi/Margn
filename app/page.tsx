import "./landing.css";
import LandingPage from "@/components/landing/LandingPage";

export const metadata = {
  title: "margn — Was Nachrichtenseiten ändern, nachdem sie publiziert haben",
  description:
    "Medienobservatorium im Aufbau: erfasst Artikel führender deutscher Leitmedien, versioniert sie und macht stille Änderungen, umdatierte Artikel, Agenda-Profile und Paywall-Strategien sichtbar. Zugang derzeit beschränkt.",
};

export default function Landing() {
  return <LandingPage />;
}
