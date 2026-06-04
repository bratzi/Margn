import "./globals.css";
import Nav from "@/components/Nav";

export const metadata = { title: "NewsScraper — Medienobservatorium" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
