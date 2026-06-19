import "./login.css";

export const metadata = {
  title: "margn — Anmeldung",
  robots: { index: false, follow: false },
};

// Reines Formular (POST → /api/login). Kein Client-JS nötig: funktioniert auch
// ohne Hydration. Fehlerzustand kommt per ?error=1 zurück.
export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const next = typeof searchParams.next === "string" ? searchParams.next : "/articles";
  const hasError = searchParams.error === "1";

  return (
    <div className="login-wrap">
      <form className="login-card" method="POST" action="/api/login">
        <div className="login-brand">
          <span className="login-mark">m</span>
          <span className="login-name">margn</span>
        </div>
        <h1 className="login-title">Geschützter Bereich</h1>
        <p className="login-sub">Das Observatorium-Dashboard ist nicht öffentlich. Bitte Zugangswort eingeben.</p>

        <input type="hidden" name="next" value={next} />
        <label className="login-field">
          <span>Zugangswort</span>
          <input
            type="password"
            name="password"
            autoFocus
            autoComplete="current-password"
            required
            aria-invalid={hasError}
          />
        </label>

        {hasError && <p className="login-error" role="alert">Falsches Zugangswort.</p>}

        <button type="submit" className="login-btn">Anmelden</button>
      </form>
    </div>
  );
}
