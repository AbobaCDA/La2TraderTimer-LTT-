import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const webhookSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
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

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function telegram(method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Do not include the API URL in logs/errors: it contains the bot token.
    throw new Error(`Telegram API ${method} returned HTTP ${response.status}`);
  }
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(`Telegram API ${method} rejected the request`);
  return result;
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

function safeText(value: string): string {
  // Telegram messages use plain text (not HTML), so only strip line breaks from user-controlled labels.
  return value.replace(/[\r\n\t]/g, " ").slice(0, 64);
}

function formatMoscow(timestamp: string | null): string {
  if (!timestamp) return "не запущен";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "не задано";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).format(date);
}

function parseMoscowTime(dateText: string, timeText: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeText);
  if (!dateMatch || !timeMatch) return null;
  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  // Europe/Moscow is UTC+03:00. Construct in UTC and subtract that offset.
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute) - 3 * 60 * 60 * 1000;
  const result = new Date(utcMillis);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(result);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (
    values.year !== yearText || values.month !== monthText || values.day !== dayText ||
    values.hour !== hourText || values.minute !== minuteText
  ) return null;
  return result;
}

type Character = {
  user_id: string;
  id: string;
  name: string;
  license: boolean;
  started_at: string | null;
  end_at: string | null;
  shift_hours: number | null;
  created_at: string;
};

type TelegramMessage = {
  message_id?: number;
  chat?: { id: number | string; type?: string };
  from?: { id: number | string; username?: string; first_name?: string };
  text?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

async function issuePairingCode(message: TelegramMessage, telegramUserId: string, chatId: string): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const retentionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error: cleanupError } = await db.from("telegram_pairing_requests")
    .delete()
    .lt("expires_at", retentionCutoff);
  if (cleanupError) throw new Error("Could not clean old pairing requests");

  const { data: latestRequest, error: latestError } = await db
    .from("telegram_pairing_requests")
    .select("created_at")
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error("Could not check recent pairing requests");
  if (latestRequest && now.getTime() - new Date(latestRequest.created_at).getTime() < 30_000) {
    await sendMessage(chatId, "Код уже был выдан недавно. Используй предыдущее сообщение; новый код можно запросить через 30 секунд.");
    return;
  }

  const code = makePairingCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

  const { error: expireError } = await db
    .from("telegram_pairing_requests")
    .update({ status: "expired" })
    .eq("telegram_user_id", telegramUserId)
    .in("status", ["pending", "approved"]);
  if (expireError) throw new Error("Could not expire old pairing requests");

  const { error } = await db.from("telegram_pairing_requests").insert({
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    telegram_username: message.from?.username ?? null,
    first_name: message.from?.first_name ?? "",
    code_hash: codeHash,
    status: "approved",
    expires_at: expiresAt,
    approved_at: nowIso,
  });
  if (error) throw new Error("Could not create pairing request");

  await sendMessage(
    chatId,
    `Код привязки к приложению: ${code}\n\n` +
      "Войди или создай аккаунт в приложении и введи этот код в разделе подключения Telegram. " +
      "Код одноразовый, действует 10 минут и активируется автоматически — подтверждение владельца не требуется.",
  );
}

async function getLinkedUserId(telegramUserId: string): Promise<string | null> {
  const { data, error } = await db
    .from("telegram_accounts")
    .select("user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw new Error("Could not load Telegram account link");
  return data?.user_id ?? null;
}

async function isProfileActive(userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("profiles")
    .select("access_status")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error("Could not load account status");
  return data?.access_status === "active";
}

async function getCharacters(userId: string): Promise<Character[]> {
  const { data, error } = await db
    .from("characters")
    .select("user_id,id,name,license,started_at,end_at,shift_hours,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load characters");
  return (data ?? []) as Character[];
}

function resolveCharacter(characters: Character[], reference: string): Character | null {
  const normalized = reference.trim();
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    if (index >= 0 && index < characters.length) return characters[index];
  }
  const matches = characters.filter((character) => character.id.toLowerCase().startsWith(normalized.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

function helpText(): string {
  return [
    "Команды бота:",
    "/list — список персонажей и время пересадки",
    "/add Имя — добавить персонажа",
    "/license ID — переключить лицензию",
    "/timer ID — начать/перезапустить смену сейчас",
    "/settime ID YYYY-MM-DD HH:MM — задать время посадки (Москва)",
    "/delete ID — удалить персонажа",
    "В командах можно указывать номер из /list или начало ID.",
  ].join("\n");
}

async function handleMemberCommand(command: string, args: string[], chatId: string, userId: string): Promise<void> {
  if (command === "/help" || command === "/start") {
    await sendMessage(chatId, helpText());
    return;
  }

  const characters = await getCharacters(userId);
  if (command === "/list") {
    if (!characters.length) {
      await sendMessage(chatId, "Пока нет персонажей. Добавь первого командой /add Имя");
      return;
    }
    const now = Date.now();
    const lines = characters.map((character, index) => {
      const timer = character.end_at ? new Date(character.end_at).getTime() : NaN;
      const dueIn = Number.isFinite(timer)
        ? timer <= now ? "смена завершилась" : `пересадка в ${formatMoscow(character.end_at)}`
        : "таймер не запущен";
      return `${index + 1}. ${safeText(character.name)}${character.license ? " · лицензия" : ""}\n` +
        `   ${dueIn} · ID ${character.id.slice(0, 8)}`;
    });
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (command === "/add") {
    const name = args.join(" ").trim().slice(0, 32);
    if (!name) {
      await sendMessage(chatId, "Формат: /add Имя персонажа");
      return;
    }
    const { error } = await db.from("characters").insert({
      user_id: userId,
      id: crypto.randomUUID(),
      name,
      license: false,
      started_at: null,
      end_at: null,
      shift_hours: null,
    });
    if (error) throw new Error("Could not add character");
    await sendMessage(chatId, `Персонаж «${safeText(name)}» добавлен.\n\n${helpText()}`);
    return;
  }

  const reference = args[0];
  if (["/license", "/timer", "/settime", "/delete"].includes(command) && !reference) {
    await sendMessage(chatId, `Укажи номер персонажа или начало ID из /list.\nФормат: ${command} ID`);
    return;
  }
  const character = reference ? resolveCharacter(characters, reference) : null;
  if (["/license", "/timer", "/settime", "/delete"].includes(command) && !character) {
    await sendMessage(chatId, "Персонаж не найден или ID неоднозначен. Отправь /list и используй номер или более длинную часть ID.");
    return;
  }
  if (!character) {
    await sendMessage(chatId, `Не понял команду.\n\n${helpText()}`);
    return;
  }

  if (command === "/license") {
    const { error } = await db.from("characters")
      .update({ license: !character.license })
      .eq("user_id", userId)
      .eq("id", character.id);
    if (error) throw new Error("Could not change license");
    await sendMessage(chatId, `Для «${safeText(character.name)}» лицензия ${!character.license ? "включена" : "выключена"}. Новая смена: ${!character.license ? 24 : 12} ч.`);
    return;
  }

  if (command === "/timer") {
    const started = new Date();
    const shiftHours = character.license ? 24 : 12;
    const ends = new Date(started.getTime() + shiftHours * 60 * 60 * 1000);
    const { error } = await db.from("characters")
      .update({ started_at: started.toISOString(), end_at: ends.toISOString(), shift_hours: shiftHours })
      .eq("user_id", userId)
      .eq("id", character.id);
    if (error) throw new Error("Could not start timer");
    await sendMessage(chatId, `Смена «${safeText(character.name)}» запущена на ${shiftHours} ч. Пересадка: ${formatMoscow(ends.toISOString())} по Москве.`);
    return;
  }

  if (command === "/settime") {
    const dateText = args[1];
    const timeText = args[2];
    if (!dateText || !timeText) {
      await sendMessage(chatId, "Формат: /settime ID YYYY-MM-DD HH:MM\nНапример: /settime 1 2026-10-05 18:30");
      return;
    }
    const started = parseMoscowTime(dateText, timeText);
    if (!started) {
      await sendMessage(chatId, "Не удалось разобрать дату. Используй YYYY-MM-DD HH:MM по Москве.");
      return;
    }
    if (started.getTime() > Date.now()) {
      await sendMessage(chatId, "Время посадки не может быть в будущем.");
      return;
    }
    const shiftHours = character.license ? 24 : 12;
    const ends = new Date(started.getTime() + shiftHours * 60 * 60 * 1000);
    const { error } = await db.from("characters")
      .update({ started_at: started.toISOString(), end_at: ends.toISOString(), shift_hours: shiftHours })
      .eq("user_id", userId)
      .eq("id", character.id);
    if (error) throw new Error("Could not set timer time");
    await sendMessage(chatId, `Время посадки «${safeText(character.name)}» сохранено. Пересадка: ${formatMoscow(ends.toISOString())} по Москве, через ${shiftHours} ч.`);
    return;
  }

  if (command === "/delete") {
    const { error } = await db.from("characters")
      .delete()
      .eq("user_id", userId)
      .eq("id", character.id);
    if (error) throw new Error("Could not delete character");
    await sendMessage(chatId, `Персонаж «${safeText(character.name)}» и его таймер удалены.`);
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const chatIdValue = message?.chat?.id;
  const telegramUserValue = message?.from?.id;
  const text = message?.text?.trim();
  if (!message || !chatIdValue || !telegramUserValue || !text) return;
  const chatId = String(chatIdValue);
  const telegramUserId = String(telegramUserValue);

  if (message.chat?.type !== "private") {
    await sendMessage(chatId, "Открой личный чат с ботом для работы с таймерами.");
    return;
  }

  const pieces = text.split(/\s+/);
  const commandToken = pieces[0].split("@")[0].toLowerCase();
  const args = pieces.slice(1);

  if (commandToken === "/myid") {
    await sendMessage(chatId, `Твой Telegram ID: ${telegramUserId}`);
    return;
  }

  if (commandToken === "/start") {
    const linkedUserId = await getLinkedUserId(telegramUserId);
    if (linkedUserId) {
      if (!(await isProfileActive(linkedUserId))) {
        await sendMessage(chatId, "Доступ к этому аккаунту приостановлен. Свяжись с владельцем.");
        return;
      }
      await sendMessage(chatId, `Бот уже подключён к твоему профилю.\n\n${helpText()}`);
      return;
    }
    await issuePairingCode(message, telegramUserId, chatId);
    return;
  }

  const linkedUserId = await getLinkedUserId(telegramUserId);
  if (!linkedUserId) {
    await sendMessage(chatId, "Сначала отправь /start, получи одноразовый код и введи его в приложении. Привязка активируется автоматически после ввода кода.");
    return;
  }
  if (!(await isProfileActive(linkedUserId))) {
    await sendMessage(chatId, "Доступ к этому аккаунту приостановлен. Свяжись с владельцем.");
    return;
  }
  await handleMemberCommand(commandToken, args, chatId, linkedUserId);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(suppliedSecret, webhookSecret)) return new Response("Unauthorized", { status: 401 });

  try {
    const update = await request.json() as TelegramUpdate;
    await handleUpdate(update);
    return new Response("ok", { status: 200 });
  } catch (_error) {
    // Do not log request bodies or credentials. Telegram may retry failed updates.
    return new Response("Temporary bot error", { status: 500 });
  }
});
