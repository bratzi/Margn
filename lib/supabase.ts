import { createClient } from "@supabase/supabase-js";

// Frontend-Client: nutzt den öffentlichen anon-Key + RLS (nur lesend).
// NIEMALS den service_role-Key hier verwenden.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
