import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const publishableKey = getPublishableKey();
const adminKey = getSupabaseSecretKey();
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const ownerTelegramId = Deno.env.get("OWNER_TELEGRAM_ID") ?? "";
const admin: SupabaseClient = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getPublishableKey(): string {
  const keySet = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keySet) {
    try {
      const parsed = JSON.parse(keySet) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch {
      // Fall through to the legacy public key name.
    }
  }
  const legacyKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (legacyKey) return legacyKey;
  throw new Error("Supabase publishable key is not configured");
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

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function telegramSendMessage(chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error("Telegram API rejected the confirmation message");
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  try {
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    if (!bearer) return jsonResponse(401, { error: "sign_in_required" });

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(bearer);
    if (userError || !userData.user) return jsonResponse(401, { error: "invalid_session" });

    let body: { code?: unknown };
    try {
      body = await request.json() as { code?: unknown };
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) {
      return jsonResponse(400, { error: "invalid_code_format" });
    }
    const codeHash = await hashCode(code);

    const { data: requestRow, error: lookupError } = await admin
      .from("telegram_pairing_requests")
      .select("status,expires_at")
      .eq("code_hash", codeHash)
      .maybeSingle();
    if (lookupError) return jsonResponse(500, { error: "pairing_lookup_failed" });
    if (!requestRow) return jsonResponse(400, { error: "pairing_code_not_found" });
    if (new Date(requestRow.expires_at).getTime() <= Date.now()) {
      return jsonResponse(400, { error: "pairing_code_expired" });
    }
    if (requestRow.status === "pending") {
      return jsonResponse(409, { error: "waiting_for_owner_approval" });
    }
    if (requestRow.status !== "approved") {
      return jsonResponse(409, { error: "pairing_code_unavailable" });
    }

    const { data: linked, error: linkError } = await admin.rpc("consume_telegram_pairing_code", {
      p_code_hash: codeHash,
      p_user_id: userData.user.id,
      p_owner_telegram_id: ownerTelegramId || null,
    });
    if (linkError) {
      const message = linkError.message ?? "";
      if (message.includes("TELEGRAM_ACCOUNT_ALREADY_LINKED")) {
        return jsonResponse(409, { error: "account_or_telegram_already_linked" });
      }
      if (message.includes("ACCOUNT_NOT_AVAILABLE")) {
        return jsonResponse(403, { error: "account_not_available" });
      }
      if (message.includes("PAIRING_CODE_INVALID")) {
        return jsonResponse(409, { error: "pairing_code_already_used_or_unavailable" });
      }
      return jsonResponse(500, { error: "pairing_failed" });
    }

    const linkedAccount = Array.isArray(linked) ? linked[0] : linked;
    if (linkedAccount?.chat_id) {
      try {
        await telegramSendMessage(String(linkedAccount.chat_id), "Telegram успешно привязан к аккаунту. Бот готов к работе — отправь /help, чтобы увидеть команды.");
      } catch {
        // The link is committed; a temporary Telegram delivery error must not undo it.
      }
    }
    return jsonResponse(200, { ok: true, telegram_username: linkedAccount?.telegram_username ?? null });
  } catch {
    return jsonResponse(500, { error: "internal_error" });
  }
});
