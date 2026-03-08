import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ─── Queries ─────────────────────────────────────────

export async function getLeaderboard(period: string = "alltime", limit: number = 20) {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("*")
    .eq("period", period)
    .order("total_earnings", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function getPlayerStats(wallet: string) {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("wallet", wallet)
    .single();

  if (error) throw error;
  return data;
}

export async function getRecentMatches(wallet: string, limit: number = 10) {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("player_wallet", wallet)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}
