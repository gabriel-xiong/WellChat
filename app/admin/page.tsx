import { createClient } from "@supabase/supabase-js";
import AdminDashboard, { ChatEventRow, QueryLogRow } from "@/components/AdminDashboard";

export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function AdminPage() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Dashboard database access is not configured.");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  // This server-rendered page is deliberately dynamic and needs a moving analytics window.
  const generatedAt = new Date();
  const since = new Date(generatedAt.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const [queryResult, eventResult] = await Promise.all([
    supabase
      .from("query_logs")
      .select("id,question,retrieved_urls,retrieved_titles,similarity_scores,answer,fallback_triggered,category,cache_hit,time_to_first_token_ms,total_response_time_ms,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("chat_events")
      .select("id,event_type,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  if (queryResult.error) throw new Error(`Unable to load query analytics: ${queryResult.error.message}`);
  if (eventResult.error) throw new Error(`Unable to load chat events: ${eventResult.error.message}`);

  return (
    <AdminDashboard
      queries={(queryResult.data ?? []) as QueryLogRow[]}
      events={(eventResult.data ?? []) as ChatEventRow[]}
      generatedAt={generatedAt.toISOString()}
    />
  );
}
