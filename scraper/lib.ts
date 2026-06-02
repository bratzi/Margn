import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Service-Key NUR im Scraper verwenden, niemals im Frontend.
export const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// pgvector erwartet/liefert Vektoren über PostgREST als Text-Literal "[1,2,3]".
export const toPgVector = (a: number[]): string => `[${a.join(",")}]`;
export const fromPgVector = (v: unknown): number[] =>
  typeof v === "string" ? JSON.parse(v) : (v as number[]);
