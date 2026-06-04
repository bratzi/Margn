import "./globals.css";

export const metadata = { title: "NewsScraper — Crawl-Fortschritt" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
