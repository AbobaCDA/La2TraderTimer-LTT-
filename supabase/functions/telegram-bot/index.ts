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

async function sendMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await telegram("sendMessage", payload);
}

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text.slice(0, 180);
  try {
    await telegram("answerCallbackQuery", payload);
  } catch {
    // An expired or already-answered callback should not fail the webhook update.
  }
}

async function removeInlineKeyboard(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    await telegram("editMessageReplyMarkup", {
      chat_id: String(chatId),
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    // Telegram may already have removed or replaced the keyboard.
  }
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

function formatMoscowFull(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "не задано";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
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
  hidden: boolean;
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

type TelegramCallbackQuery = {
  id: string;
  from?: { id: number | string };
  message?: {
    message_id?: number;
    chat?: { id: number | string; type?: string };
  };
  data?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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
    .select("user_id,id,name,license,hidden,started_at,end_at,shift_hours,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load characters");
  return (data ?? []) as Character[];
}

type TelegramInlineButton = { text: string; callback_data: string };
type TelegramInlineKeyboard = { inline_keyboard: TelegramInlineButton[][] };

const CHARACTER_MENU_PAGE_SIZE = 8;

async function characterButtonToken(userId: string, characterId: string): Promise<string> {
  const input = new TextEncoder().encode(`${userId}\u0000${characterId}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveCharacterToken(
  characters: Character[],
  userId: string,
  token: string,
): Promise<Character | null> {
  const matches: Character[] = [];
  for (const character of characters) {
    if (await characterButtonToken(userId, character.id) === token) matches.push(character);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function buildCharacterKeyboard(
  characters: Character[],
  userId: string,
  requestedPage: number,
  warehouseCount = 0,
): Promise<{ keyboard: TelegramInlineKeyboard; page: number; pageCount: number }> {
  const pageCount = Math.max(1, Math.ceil(characters.length / CHARACTER_MENU_PAGE_SIZE));
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  const start = page * CHARACTER_MENU_PAGE_SIZE;
  const rows: TelegramInlineButton[][] = [];

  for (const character of characters.slice(start, start + CHARACTER_MENU_PAGE_SIZE)) {
    const token = await characterButtonToken(userId, character.id);
    const shiftHours = character.license ? 24 : 12;
    rows.push([{
      text: `${safeText(character.name)} · ${shiftHours} ч`,
      callback_data: `char:${token}`,
    }]);
  }

  const navigation: TelegramInlineButton[] = [];
  if (page > 0) navigation.push({ text: "← Назад", callback_data: `page:${page - 1}` });
  if (page < pageCount - 1) navigation.push({ text: "Дальше →", callback_data: `page:${page + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: `📦 Склад персонажей${warehouseCount ? ` · ${warehouseCount}` : ""}`, callback_data: "warehouse:0" }]);
  return { keyboard: { inline_keyboard: rows }, page, pageCount };
}

async function buildWarehouseKeyboard(
  characters: Character[],
  userId: string,
  requestedPage: number,
): Promise<{ keyboard: TelegramInlineKeyboard; page: number; pageCount: number }> {
  const pageCount = Math.max(1, Math.ceil(characters.length / CHARACTER_MENU_PAGE_SIZE));
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  const start = page * CHARACTER_MENU_PAGE_SIZE;
  const rows: TelegramInlineButton[][] = [];

  for (const character of characters.slice(start, start + CHARACTER_MENU_PAGE_SIZE)) {
    const token = await characterButtonToken(userId, character.id);
    rows.push([{ text: `↩ ${safeText(character.name)} · вернуть`, callback_data: `restore:${token}` }]);
  }

  const navigation: TelegramInlineButton[] = [];
  if (page > 0) navigation.push({ text: "← Назад", callback_data: `warehousepage:${page - 1}` });
  if (page < pageCount - 1) navigation.push({ text: "Дальше →", callback_data: `warehousepage:${page + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: "← К персонажам", callback_data: "menu:0" }]);
  return { keyboard: { inline_keyboard: rows }, page, pageCount };
}

async function sendCharacterMenu(chatId: string, userId: string, requestedPage = 0): Promise<void> {
  const allCharacters = await getCharacters(userId);
  const characters = allCharacters.filter(character => !character.hidden);
  const warehouseCount = allCharacters.filter(character => character.hidden).length;
  if (!characters.length) {
    if (warehouseCount) {
      await sendMessage(chatId, "Все персонажи сейчас на складе. Выбери персонажа, чтобы вернуть его и снова запускать таймер.", {
        inline_keyboard: [[{ text: `📦 Открыть склад · ${warehouseCount}`, callback_data: "warehouse:0" }]],
      });
    } else {
      await sendMessage(chatId, "В облаке пока нет персонажей. Добавь их в приложении или командой /add Имя.");
    }
    return;
  }
  const { keyboard, page, pageCount } = await buildCharacterKeyboard(characters, userId, requestedPage, warehouseCount);
  await sendMessage(chatId, `Выбери персонажа (${page + 1}/${pageCount}):`, keyboard);
}

async function sendWarehouseMenu(chatId: string, userId: string, requestedPage = 0): Promise<void> {
  const characters = (await getCharacters(userId)).filter(character => character.hidden);
  if (!characters.length) {
    await sendMessage(chatId, "Склад пуст.", {
      inline_keyboard: [[{ text: "← К персонажам", callback_data: "menu:0" }]],
    });
    return;
  }
  const { keyboard, page, pageCount } = await buildWarehouseKeyboard(characters, userId, requestedPage);
  await sendMessage(chatId, `Склад персонажей (${page + 1}/${pageCount}). Нажми на персонажа, чтобы вернуть его:`, keyboard);
}

function timerChoiceKeyboard(token: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "⏱ Пересадил сейчас", callback_data: `now:${token}` }],
      [{ text: "🕰 Пересадил раньше — указать время", callback_data: `past:${token}` }],
      [{ text: "📦 Остановить и отправить на склад", callback_data: `archive:${token}` }],
      [{ text: "← К персонажам", callback_data: "menu:0" }],
    ],
  };
}

async function persistCharacterTimer(userId: string, character: Character, startedAt: Date): Promise<{ shiftHours: number; endsAt: Date }> {
  const shiftHours = character.license ? 24 : 12;
  const endsAt = new Date(startedAt.getTime() + shiftHours * 60 * 60 * 1000);
  const { data, error } = await db.from("characters")
    .update({
      started_at: startedAt.toISOString(),
      end_at: endsAt.toISOString(),
      shift_hours: shiftHours,
    })
    .eq("user_id", userId)
    .eq("id", character.id)
    .eq("hidden", false)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("Could not update character timer");
  return { shiftHours, endsAt };
}

async function saveTimerInputSession(
  telegramUserId: string,
  chatId: string,
  userId: string,
  characterId: string,
): Promise<void> {
  const now = new Date();
  const { error: cleanupError } = await db.from("telegram_timer_input_sessions")
    .delete()
    .lt("expires_at", now.toISOString());
  if (cleanupError) throw new Error("Could not clean expired timer input sessions");

  const { error } = await db.from("telegram_timer_input_sessions").upsert({
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    user_id: userId,
    character_id: characterId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  }, { onConflict: "telegram_user_id" });
  if (error) throw new Error("Could not save timer input session");
}

async function clearTimerInputSession(telegramUserId: string, userId?: string): Promise<void> {
  let query = db.from("telegram_timer_input_sessions").delete().eq("telegram_user_id", telegramUserId);
  if (userId) query = query.eq("user_id", userId);
  const { error } = await query;
  if (error) throw new Error("Could not clear timer input session");
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
    "/menu — открыть кнопки персонажей и таймера",
    "/warehouse — открыть склад и вернуть персонажа",
    "/timer — выбрать персонажа кнопкой",
    "/list — список персонажей, время пересадки и статус склада",
    "/add Имя — добавить персонажа",
    "/license ID — переключить лицензию",
    "/timer ID — начать смену сейчас",
    "/settime ID YYYY-MM-DD HH:MM — задать время посадки (Москва)",
    "/archive ID — остановить таймер и отправить на склад",
    "/restore ID — вернуть персонажа со склада",
    "/delete ID — удалить персонажа",
    "/cancel — отменить ввод времени",
    "В командах можно указывать номер из /list или начало ID.",
  ].join("\n");
}

type TelegramTimerInputSession = {
  telegram_user_id: string;
  chat_id: string;
  user_id: string;
  character_id: string;
  expires_at: string;
};

async function handlePendingTimerInput(
  telegramUserId: string,
  chatId: string,
  userId: string,
  text: string,
): Promise<boolean> {
  const { data, error } = await db.from("telegram_timer_input_sessions")
    .select("telegram_user_id,chat_id,user_id,character_id,expires_at")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw new Error("Could not load timer input session");
  if (!data) return false;

  const session = data as TelegramTimerInputSession;
  if (session.chat_id !== chatId || session.user_id !== userId) {
    await clearTimerInputSession(telegramUserId);
    return false;
  }
  if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
    await clearTimerInputSession(telegramUserId, userId);
    await sendMessage(chatId, "Время ввода истекло. Отправь /menu и начни заново.");
    return true;
  }

  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/.exec(text.trim());
  if (!match) {
    await sendMessage(chatId, "Не понял дату. Отправь её в формате YYYY-MM-DD HH:MM по Москве. Например: 2026-10-06 19:30. Для отмены — /cancel.");
    return true;
  }
  const startedAt = parseMoscowTime(match[1], match[2]);
  if (!startedAt) {
    await sendMessage(chatId, "Такой даты или времени нет. Проверь значения и отправь YYYY-MM-DD HH:MM по Москве. Для отмены — /cancel.");
    return true;
  }
  if (startedAt.getTime() > Date.now()) {
    await sendMessage(chatId, "Время посадки не может быть в будущем. Отправь прошедшие дату и время по Москве или /cancel.");
    return true;
  }

  const { data: row, error: characterError } = await db.from("characters")
    .select("user_id,id,name,license,hidden,started_at,end_at,shift_hours,created_at")
    .eq("user_id", userId)
    .eq("id", session.character_id)
    .maybeSingle();
  if (characterError) throw new Error("Could not load selected character");
  if (!row) {
    await clearTimerInputSession(telegramUserId, userId);
    await sendMessage(chatId, "Этот персонаж больше не найден. Открой /menu и выбери другого.");
    return true;
  }

  const character = row as Character;
  if (character.hidden) {
    await clearTimerInputSession(telegramUserId, userId);
    await sendMessage(chatId, "Этот персонаж уже на складе. Верни его в приложении, чтобы установить таймер.");
    return true;
  }
  const { shiftHours, endsAt } = await persistCharacterTimer(userId, character, startedAt);
  await clearTimerInputSession(telegramUserId, userId);
  await sendMessage(
    chatId,
    `Готово — время посадки «${safeText(character.name)}» сохранено.\n` +
      `Посадка: ${formatMoscowFull(startedAt)} по Москве.\n` +
      `Пересадка: ${formatMoscowFull(endsAt)} по Москве (через ${shiftHours} ч).`,
  );
  return true;
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatValue = callback.message?.chat?.id;
  const telegramUserValue = callback.from?.id;
  if (chatValue === undefined || telegramUserValue === undefined) {
    await answerCallback(callback.id, "Не удалось определить чат. Открой личный диалог с ботом.");
    return;
  }
  const chatId = String(chatValue);
  const telegramUserId = String(telegramUserValue);
  if (callback.message?.chat?.type !== "private") {
    await answerCallback(callback.id, "Используй кнопки в личном чате с ботом.");
    return;
  }

  const userId = await getLinkedUserId(telegramUserId);
  if (!userId) {
    await answerCallback(callback.id, "Сначала привяжи Telegram в приложении.");
    await sendMessage(chatId, "Сначала создай аккаунт или войди в приложение, затем отправь /start для привязки Telegram.");
    return;
  }
  if (!(await isProfileActive(userId))) {
    await answerCallback(callback.id, "Аккаунт не активен.");
    await sendMessage(chatId, "Доступ к этому аккаунту приостановлен. Свяжись с владельцем.");
    return;
  }

  const data = callback.data ?? "";
  if (data === "menu:0") {
    await answerCallback(callback.id);
    await removeInlineKeyboard(callback);
    await sendCharacterMenu(chatId, userId, 0);
    return;
  }
  if (data === "warehouse:0") {
    await answerCallback(callback.id);
    await removeInlineKeyboard(callback);
    await sendWarehouseMenu(chatId, userId, 0);
    return;
  }
  if (data.startsWith("warehousepage:")) {
    const page = Number(data.slice("warehousepage:".length));
    if (!Number.isInteger(page) || page < 0) {
      await answerCallback(callback.id, "Эта кнопка устарела. Отправь /warehouse.");
      return;
    }
    const characters = (await getCharacters(userId)).filter(character => character.hidden);
    if (!characters.length) {
      await answerCallback(callback.id, "Склад уже пуст.");
      await sendWarehouseMenu(chatId, userId);
      return;
    }
    const built = await buildWarehouseKeyboard(characters, userId, page);
    await answerCallback(callback.id);
    const messageId = callback.message?.message_id;
    if (messageId === undefined) {
      await sendWarehouseMenu(chatId, userId, built.page);
      return;
    }
    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `Склад персонажей (${built.page + 1}/${built.pageCount}). Нажми на персонажа, чтобы вернуть его:`,
        reply_markup: built.keyboard,
        disable_web_page_preview: true,
      });
    } catch {
      await sendWarehouseMenu(chatId, userId, built.page);
    }
    return;
  }

  if (data.startsWith("page:")) {
    const page = Number(data.slice("page:".length));
    if (!Number.isInteger(page) || page < 0) {
      await answerCallback(callback.id, "Эта кнопка устарела. Отправь /menu.");
      return;
    }
    const allCharacters = await getCharacters(userId);
    const characters = allCharacters.filter(character => !character.hidden);
    if (!characters.length) {
      await answerCallback(callback.id, "Нет доступных персонажей.");
      await sendCharacterMenu(chatId, userId);
      return;
    }
    const warehouseCount = allCharacters.filter(character => character.hidden).length;
    const built = await buildCharacterKeyboard(characters, userId, page, warehouseCount);
    await answerCallback(callback.id);
    const messageId = callback.message?.message_id;
    if (messageId === undefined) {
      await sendCharacterMenu(chatId, userId, built.page);
      return;
    }
    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `Выбери персонажа (${built.page + 1}/${built.pageCount}):`,
        reply_markup: built.keyboard,
        disable_web_page_preview: true,
      });
    } catch {
      await sendCharacterMenu(chatId, userId, built.page);
    }
    return;
  }

  const actionMatch = /^(char|now|past|archive|restore):([0-9a-f]{24})$/.exec(data);
  if (!actionMatch) {
    await answerCallback(callback.id, "Эта кнопка устарела. Отправь /menu.");
    return;
  }

  const [, action, token] = actionMatch;
  const allCharacters = await getCharacters(userId);
  const eligibleCharacters = action === "restore"
    ? allCharacters.filter(character => character.hidden)
    : allCharacters.filter(character => !character.hidden);
  const character = await resolveCharacterToken(eligibleCharacters, userId, token);
  if (!character) {
    await answerCallback(callback.id, "Персонаж изменился или больше недоступен. Открой /menu или /warehouse.");
    await sendCharacterMenu(chatId, userId);
    return;
  }

  if (action === "restore") {
    const { data: restored, error } = await db.from("characters")
      .update({ hidden: false, started_at: null, end_at: null, shift_hours: null })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", true)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not restore character from warehouse");
    await answerCallback(callback.id, restored ? "Возвращён на главный экран" : "Персонаж уже возвращён");
    await removeInlineKeyboard(callback);
    await sendMessage(
      chatId,
      restored
        ? `Персонаж «${safeText(character.name)}» возвращён. Таймер можно запустить заново.`
        : `Персонаж «${safeText(character.name)}» уже не находится на складе.`,
      { inline_keyboard: [[{ text: "К персонажам", callback_data: "menu:0" }, { text: "Склад", callback_data: "warehouse:0" }]] },
    );
    return;
  }

  if (action === "archive") {
    const { data: archived, error } = await db.from("characters")
      .update({ hidden: true, started_at: null, end_at: null, shift_hours: null })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", false)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not archive character");
    await answerCallback(callback.id, archived ? "Таймер остановлен, персонаж на складе" : "Персонаж уже перемещён");
    await removeInlineKeyboard(callback);
    await sendMessage(
      chatId,
      archived
        ? `Таймер «${safeText(character.name)}» остановлен, персонаж отправлен на склад.`
        : `Персонаж «${safeText(character.name)}» уже отправлен на склад.`,
      { inline_keyboard: [[{ text: "Открыть склад", callback_data: "warehouse:0" }, { text: "К персонажам", callback_data: "menu:0" }]] },
    );
    return;
  }

  if (action === "char") {
    await answerCallback(callback.id);
    await removeInlineKeyboard(callback);
    const currentToken = await characterButtonToken(userId, character.id);
    const shiftHours = character.license ? 24 : 12;
    await sendMessage(
      chatId,
      `Персонаж: «${safeText(character.name)}»\nСмена: ${shiftHours} ч.\nКак отметить пересадку?`,
      timerChoiceKeyboard(currentToken),
    );
    return;
  }

  if (action === "now") {
    await answerCallback(callback.id, "Запускаю смену…");
    await removeInlineKeyboard(callback);
    const startedAt = new Date();
    const { shiftHours, endsAt } = await persistCharacterTimer(userId, character, startedAt);
    await sendMessage(
      chatId,
      `Готово — смена «${safeText(character.name)}» началась.\n` +
        `Посадка: ${formatMoscowFull(startedAt)} по Москве.\n` +
        `Пересадка: ${formatMoscowFull(endsAt)} по Москве (через ${shiftHours} ч).`,
    );
    return;
  }

  await saveTimerInputSession(telegramUserId, chatId, userId, character.id);
  await answerCallback(callback.id, "Жду дату и время.");
  await removeInlineKeyboard(callback);
  await sendMessage(
    chatId,
    `Для «${safeText(character.name)}» отправь дату и время посадки по Москве в формате YYYY-MM-DD HH:MM.\n` +
      `Например: 2026-10-06 19:30. Ввод действует 10 минут; для отмены отправь /cancel.`,
    { force_reply: true, input_field_placeholder: "YYYY-MM-DD HH:MM" },
  );
}

async function handleMemberCommand(command: string, args: string[], chatId: string, userId: string): Promise<void> {
  if (command === "/help" || command === "/start") {
    await sendMessage(chatId, helpText());
    return;
  }

  const characters = await getCharacters(userId);
  if (command === "/menu" || (command === "/timer" && !args[0])) {
    await sendCharacterMenu(chatId, userId);
    return;
  }
  if (command === "/warehouse") {
    await sendWarehouseMenu(chatId, userId);
    return;
  }
  if (command === "/list") {
    if (!characters.length) {
      await sendMessage(chatId, "Пока нет персонажей. Добавь первого командой /add Имя");
      return;
    }
    const now = Date.now();
    const lines = characters.map((character, index) => {
      const timer = character.end_at ? new Date(character.end_at).getTime() : NaN;
      const dueIn = character.hidden
        ? "на складе · таймер остановлен"
        : Number.isFinite(timer)
          ? timer <= now ? "смена завершилась" : `пересадка в ${formatMoscow(character.end_at)}`
          : "таймер не запущен";
      return `${index + 1}. ${safeText(character.name)}${character.license ? " · лицензия" : ""}${character.hidden ? " · СКЛАД" : ""}\n` +
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
  if (["/license", "/timer", "/settime", "/archive", "/restore", "/delete"].includes(command) && !reference) {
    await sendMessage(chatId, `Укажи номер персонажа или начало ID из /list.\nФормат: ${command} ID`);
    return;
  }
  const character = reference ? resolveCharacter(characters, reference) : null;
  if (["/license", "/timer", "/settime", "/archive", "/restore", "/delete"].includes(command) && !character) {
    await sendMessage(chatId, "Персонаж не найден или ID неоднозначен. Отправь /list и используй номер или более длинную часть ID.");
    return;
  }
  if (!character) {
    await sendMessage(chatId, `Не понял команду.\n\n${helpText()}`);
    return;
  }
  if (command === "/archive") {
    const { data, error } = await db.from("characters")
      .update({ hidden: true, started_at: null, end_at: null, shift_hours: null })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", false)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not archive character");
    await sendMessage(chatId, data
      ? `Таймер «${safeText(character.name)}» остановлен, персонаж отправлен на склад. Открой /warehouse, чтобы вернуть его.`
      : `«${safeText(character.name)}» уже находится на складе.`);
    return;
  }
  if (command === "/restore") {
    const { data, error } = await db.from("characters")
      .update({ hidden: false, started_at: null, end_at: null, shift_hours: null })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", true)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not restore character");
    await sendMessage(chatId, data
      ? `Персонаж «${safeText(character.name)}» возвращён. Таймер можно запустить заново.`
      : `«${safeText(character.name)}» уже находится на главном экране.`);
    return;
  }
  if (character.hidden && ["/license", "/timer", "/settime"].includes(command)) {
    await sendMessage(chatId, "Этот персонаж на складе. Верни его кнопкой через /warehouse или командой /restore ID, чтобы менять лицензию и запускать таймер.");
    return;
  }

  if (command === "/license") {
    const { data, error } = await db.from("characters")
      .update({ license: !character.license })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", false)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not change license");
    if (!data) {
      await sendMessage(chatId, "Персонаж уже на складе. Верни его на главный экран в приложении.");
      return;
    }
    await sendMessage(chatId, `Для «${safeText(character.name)}» лицензия ${!character.license ? "включена" : "выключена"}. Новая смена: ${!character.license ? 24 : 12} ч.`);
    return;
  }

  if (command === "/timer") {
    const started = new Date();
    const shiftHours = character.license ? 24 : 12;
    const ends = new Date(started.getTime() + shiftHours * 60 * 60 * 1000);
    const { data, error } = await db.from("characters")
      .update({ started_at: started.toISOString(), end_at: ends.toISOString(), shift_hours: shiftHours })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", false)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not start timer");
    if (!data) {
      await sendMessage(chatId, "Персонаж уже на складе. Верни его на главный экран в приложении.");
      return;
    }
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
    const { data, error } = await db.from("characters")
      .update({ started_at: started.toISOString(), end_at: ends.toISOString(), shift_hours: shiftHours })
      .eq("user_id", userId)
      .eq("id", character.id)
      .eq("hidden", false)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not set timer time");
    if (!data) {
      await sendMessage(chatId, "Персонаж уже на складе. Верни его на главный экран в приложении.");
      return;
    }
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
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
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
      await sendCharacterMenu(chatId, linkedUserId);
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
  if (commandToken === "/cancel") {
    await clearTimerInputSession(telegramUserId, linkedUserId);
    await sendMessage(chatId, "Ввод времени отменён.");
    return;
  }
  if (commandToken === "/menu" || (commandToken === "/timer" && !args[0])) {
    await clearTimerInputSession(telegramUserId, linkedUserId);
    await sendCharacterMenu(chatId, linkedUserId);
    return;
  }
  if (await handlePendingTimerInput(telegramUserId, chatId, linkedUserId, text)) return;
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
