import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_RECORDED_LATENCY_MS = 5 * 60 * 1000;

interface TelemetryBody {
  query_id?: unknown;
  time_to_first_token_ms?: unknown;
  total_response_time_ms?: unknown;
}

function validLatency(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_RECORDED_LATENCY_MS;
}

export async function POST(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "Telemetry is not configured" }, { status: 503 });
  }

  const body = await request.json() as TelemetryBody;
  const queryId = typeof body.query_id === "string" ? body.query_id : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(queryId)) {
    return Response.json({ error: "Invalid query ID" }, { status: 400 });
  }

  if (!validLatency(body.total_response_time_ms) || !validLatency(body.time_to_first_token_ms)) {
    return Response.json({ error: "Invalid latency measurement" }, { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  for (const delayMs of [0, 150, 500, 1000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const { data, error } = await supabase
      .from("query_logs")
      .update({
        time_to_first_token_ms: body.time_to_first_token_ms,
        total_response_time_ms: body.total_response_time_ms,
      })
      .eq("id", queryId)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Failed to store chat telemetry:", error.message);
      return Response.json({ error: "Unable to store telemetry" }, { status: 500 });
    }

    if (data) return new Response(null, { status: 204 });
  }

  return Response.json({ error: "Query log was not found" }, { status: 404 });
}
