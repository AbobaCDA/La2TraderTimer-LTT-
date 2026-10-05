# Служебное развёртывание cloud sync и Telegram

Этот файл предназначен владельцу проекта; он не является пользовательской инструкцией. Ключи и токены храните только в Supabase Secrets/Vault и настройках Telegram. Не помещайте их в приложение, SQL-файлы, GitHub или переписку.

## 1. База данных

Примените миграцию `supabase/migrations/202610050001_cloud_sync.sql` к проекту `pomjfoknqoitmblprshz`. Она создаёт профили, личные списки персонажей, RLS, pairing и очередь напоминаний. Клиентам разрешён доступ только к собственным записям; роль владельца не даёт доступа к спискам других пользователей.

## 2. Auth, Edge Functions и секреты

В Authentication включите провайдер Email/Password и проверьте отправку письма подтверждения. Приложение умеет показывать подтверждение email перед первым входом.

Разверните функции из `supabase/functions/`:

- `telegram-bot` — webhook Telegram;
- `link-telegram` — проверка одноразового кода из приложения;
- `send-reminders` — доставка напоминаний.

В Supabase Edge Function Secrets настройте:

- `TELEGRAM_BOT_TOKEN` — токен, выданный BotFather;
- `TELEGRAM_WEBHOOK_SECRET` — случайная строка для проверки Telegram webhook;
- `OWNER_TELEGRAM_ID` — числовой Telegram ID владельца;
- `CRON_SECRET` — отдельная случайная строка для вызова `send-reminders` по расписанию.

Чтобы назначить владельца, отправьте боту `/myid` и сохраните полученный ID как `OWNER_TELEGRAM_ID` до привязки аккаунта владельца. Этот secret используется функцией `link-telegram`. Не используйте токен бота как webhook- или cron-секрет.

Функции также используют штатные переменные Supabase URL и серверного secret key. Серверный ключ нужен только Supabase Functions и не должен попадать в desktop-клиент. Клиентское приложение содержит только publishable key; доступ к таблицам ограничен RLS.

## 3. Telegram webhook

После развёртывания `telegram-bot` установите webhook на URL функции:

`https://pomjfoknqoitmblprshz.supabase.co/functions/v1/telegram-bot`

При установке передайте тот же `TELEGRAM_WEBHOOK_SECRET`, который сохранён в Edge Function Secrets, как Telegram `secret_token`. Не публикуйте полный URL запроса к Bot API: в нём находится токен бота.

Новые пользователи получают одноразовый код командой `/start`; ввод кода активирует привязку автоматически, подтверждение владельца не требуется. Код действует 10 минут. Данные каждого пользователя остаются изолированы политиками RLS; владелец не получает доступ к чужим спискам.

## 4. Расписание напоминаний

В Supabase включите расширения `pg_cron`, `pg_net` и Vault. Сохраните значение `CRON_SECRET` в Vault с именем `forge_reminder_cron_secret` (то же значение должно быть установлено как Edge Function Secret). Затем выполните в SQL Editor:

```sql
select cron.schedule(
  'forge-send-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://pomjfoknqoitmblprshz.supabase.co/functions/v1/send-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'forge_reminder_cron_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb
    );
  $$
);
```

Перед повторным запуском SQL удалите старое задание с тем же именем:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname = 'forge-send-reminders';
```

Задание проверяет очередь раз в минуту. Уведомления планируются на 60, 30 и 10 минут до конца смены по `Europe/Moscow`; если таймер изменён, старые несработавшие уведомления отменяются.

## 5. Проверка перед публикацией

1. Привяжите Telegram владельца первым и убедитесь, что профиль получил роль `owner`.
2. Создайте тестовый аккаунт, запросите `/start`, затем проверьте вход и автоматическую активацию после ввода кода.
3. Проверьте, что два аккаунта видят только собственные списки, а владелец не видит чужие записи.
4. Проверьте локальный перенос, повторную синхронизацию, выход/вход и напоминания в тестовом таймере.
5. Убедитесь, что webhook отвечает на `/start`, а cron-задание включено и `send-reminders` возвращает успешный результат.

Миграция и функции пока являются подготовленными файлами проекта и требуют применения/развёртывания в Supabase. Это не выполнено из приложения автоматически.
