import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const cronSecret = requiredEnv("CRON_SECRET");
const adminKey = getSupabaseSecretKey();
const db: SupabaseClient = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getSupabaseSecretKey(): string {
  const keySet = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keySet) {
    try {
      const parsed = JSON.parse(keySet) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch {
      // Fall through to the legacy secret name for older projects.
    }
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacyKey) return legacyKey;
  throw new Error("Supabase server secret key is not configured");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function timeMoscow(timestamp: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error("Telegram API rejected the notification");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const suppliedSecret = request.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(suppliedSecret, cronSecret)) return new Response("Unauthorized", { status: 401 });

  try {
    const { data: jobs, error: claimError } = await db.rpc("claim_due_timer_notifications", { p_limit: 100 });
    if (claimError) throw new Error("Could not claim reminders");
    let sent = 0;
    let cancelled = 0;
    let deferred = 0;

    for (const job of jobs ?? []) {
      const { data: current, error: characterError } = await db
        .from("characters")
        .select("started_at,end_at")
        .eq("user_id", job.user_id)
        .eq("id", job.character_id)
        .maybeSingle();

      if (characterError) {
        await db.from("timer_notifications")
          .update({
            status: "pending",
            next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            lease_until: null,
            last_error: "Temporary database lookup error",
          })
          .eq("id", job.job_id)
          .eq("status", "sending");
        deferred += 1;
        continue;
      }

      const timerStillMatches = current &&
        new Date(current.started_at).getTime() === new Date(job.timer_started_at).getTime() &&
        new Date(current.end_at).getTime() === new Date(job.timer_ends_at).getTime();

      if (!timerStillMatches) {
        await db.from("timer_notifications")
          .update({ status: "cancelled", lease_until: null, updated_at: new Date().toISOString() })
          .eq("id", job.job_id)
          .eq("status", "sending");
        cancelled += 1;
        continue;
      }

      try {
        const reminder = Number(job.reminder_minutes);
        const message = `Напоминание: до пересадки персонажа «${String(job.character_name).replace(/[\r\n]/g, " ").slice(0, 64)}» осталось ${reminder} мин.\n` +
          `Время пересадки: ${timeMoscow(job.timer_ends_at)} (Москва).`;
        await sendTelegramMessage(String(job.telegram_chat_id), message);
        const { error: updateError } = await db.from("timer_notifications")
          .update({ status: "sent", sent_at: new Date().toISOString(), lease_until: null, last_error: null })
          .eq("id", job.job_id)
          .eq("status", "sending");
        if (updateError) throw new Error("Could not mark reminder as sent");
        sent += 1;
      } catch (_error) {
        const { data: attemptRow } = await db.from("timer_notifications")
          .select("attempts")
          .eq("id", job.job_id)
          .maybeSingle();
        const attempts = Number(attemptRow?.attempts ?? 1);
        const terminal = attempts >= 5;
        const retryDelayMinutes = Math.min(30, 2 ** Math.max(1, attempts));
        const { error: updateError } = await db.from("timer_notifications")
          .update({
            status: terminal ? "failed" : "pending",
            next_attempt_at: new Date(Date.now() + retryDelayMinutes * 60_000).toISOString(),
            lease_until: null,
            last_error: terminal ? "Telegram delivery failed after five attempts" : "Temporary Telegram delivery error",
          })
          .eq("id", job.job_id)
          .eq("status", "sending");
        if (updateError) deferred += 1;
        else deferred += 1;
      }
    }

    return Response.json({ ok: true, claimed: jobs?.length ?? 0, sent, cancelled, deferred });
  } catch {
    // Do not include request headers, secrets, or bot API URLs in logs/responses.
    return Response.json({ ok: false, error: "notification_processing_failed" }, { status: 500 });
  }
});
