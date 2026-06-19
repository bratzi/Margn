// Session-Signierung für das Passwort-Gate des Dashboards.
//
// Bewusst NUR Web-Crypto (crypto.subtle) + TextEncoder/btoa/atob: läuft damit
// identisch in der Edge-Middleware UND in den Node-Route-Handlern. Kein Node-only
// Modul, sonst bricht die Middleware (Edge-Runtime).
//
// Cookie-Inhalt: `<exp>.<hmac>` — exp = Unix-Sekunden, hmac = HMAC-SHA256(secret, exp),
// base64url. Der Server vertraut nur dem, was er selbst signiert hat; ein Angreifer
// kann ohne SESSION_SECRET kein gültiges Cookie fälschen.

const enc = new TextEncoder();

export const SESSION_COOKIE = "mg_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 Tage

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Frisches Session-Token (signiert, mit Ablauf). */
export async function signSession(secret: string, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = String(exp);
  const sig = b64urlEncode(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

/** Prüft Signatur UND Ablauf. Gibt nur bei beidem `true` zurück. */
export async function verifySession(secret: string | undefined, token: string | undefined): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  let got: Uint8Array;
  try {
    got = b64urlToBytes(sig);
  } catch {
    return false;
  }
  const expected = await hmac(secret, payload);
  return timingSafeEqual(expected, got);
}

/** Konstant-zeitiger Passwortvergleich (über HMAC, damit Länge/Inhalt nicht durchsickern). */
export async function passwordMatches(secret: string, provided: string, expected: string): Promise<boolean> {
  const a = await hmac(secret, provided);
  const b = await hmac(secret, expected);
  return timingSafeEqual(a, b);
}

/** `next`-Redirect gegen Open-Redirect absichern: nur seiteninterne, absolute Pfade. */
export function safeNext(next: string | null | undefined, fallback = "/articles"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
