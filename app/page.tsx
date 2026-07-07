import "./landing.css";
import LandingPage from "@/components/landing/LandingPage";

export const metadata = {
  title: "margn — Was Nachrichtenseiten ändern, nachdem sie publiziert haben",
  description:
    "Offenes Medienobservatorium: erfasst Artikel führender deutscher Leitmedien stündlich, versioniert sie und macht stille Änderungen, umdatierte Artikel, Agenda-Profile und Paywall-Strategien sichtbar.",
};

export default function Landing() {
  return <LandingPage />;
}
