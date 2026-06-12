import "./landing.css";
import LandingPage from "@/components/landing/LandingPage";

export const metadata = {
  title: "margn — Was Nachrichtenseiten ändern, nachdem sie publiziert haben",
  description:
    "Offenes Medienobservatorium: erfasst Artikel aus DE & FR stündlich, versioniert sie und macht stille Änderungen, Agenda-Profile und Paywall-Strategien sichtbar.",
};

export default function Landing() {
  return <LandingPage />;
}
