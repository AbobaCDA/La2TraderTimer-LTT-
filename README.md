# La2 Trader Timer — менеджер крафтеров

Windows x64-приложение для учёта персонажей и времени пересадки трейдеров.

## Что умеет приложение

- Добавлять и удалять персонажей.
- Учитывать торговую лицензию: 12 часов без неё, 24 часа с ней.
- Показывать время пересадки и обратный отсчёт; таймеры сохраняются после закрытия приложения и перезагрузки.
- Запускаться вместе с Windows.
- Проверять обновления через публичный GitHub Releases репозитория `AbobaCDA/La2TraderTimer-LTT-`.

Данные персонажей остаются локально: `%APPDATA%\ForgeCrafterManager\characters.json`.

## Первичная загрузка проекта в пустой GitHub-репозиторий

Распакуй архив проекта, открой терминал в папке `forge-crafter-app` и выполни:

```powershell
git init
git add .
git commit -m "Initial auto-update build 1.0.2"
git branch -M main
git remote add origin https://github.com/AbobaCDA/La2TraderTimer-LTT-.git
git push -u origin main
git tag v1.0.2
git push origin v1.0.2
```

Пуш тега запустит GitHub Actions из `.github/workflows/release.yml`. Workflow соберёт NSIS-установщик и опубликует GitHub Release. В GitHub Actions для workflow заданы права `contents: write`; личный GitHub-токен не требуется.

После завершения сборки открой репозиторий → **Releases** и скачай `Forge-Crafter-Manager-Setup-1.0.2.exe`. Версию 1.0.2 нужно установить вручную один раз: в версии 1.0.1 ещё нет механизма автообновления. Все будущие версии приложение сможет находить само.

## Как выпустить следующее обновление

После правок повысить версию в `package.json` и `package-lock.json`, например:

```powershell
npm version patch --no-git-tag-version
```

Затем отправить изменения и тег (пример для версии 1.0.3):

```powershell
git add .
git commit -m "Release 1.0.3"
git push origin main
git tag v1.0.3
git push origin v1.0.3
```

Дождись workflow в разделе **Actions**. Он соберёт и приложит к GitHub Release установщик, `.blockmap` и `latest.yml`. Установленное приложение проверяет релиз при запуске; кнопку ручной проверки тоже можно использовать внизу окна. Когда обновление скачано, нажми **«Перезапустить»**.

## Важно о подписи и безопасности обновлений

Эта ветка настроена для выбранного варианта **без платного Authenticode-сертификата**. В `build.win.verifyUpdateCodeSignature` стоит `false`: NSIS updater не проверяет сертификат издателя. Поэтому Windows может показывать предупреждение SmartScreen, а доверие к обновлению зависит от HTTPS, GitHub Release и доступа к репозиторию/Actions. Включи 2FA на GitHub и не давай лишним пользователям права на запись в репозиторий. Не публикуй секреты в коде.

Если позже появится сертификат Authenticode, его секреты можно хранить только в **Settings → Secrets and variables → Actions** под именами `WIN_CSC_LINK` и `WIN_CSC_KEY_PASSWORD`. После настройки подписи нужно убрать `verifyUpdateCodeSignature: false` и выпускать все следующие установщики с тем же издателем.

## Локальный запуск и сборка

Требуется Node.js 22 LTS (22.12 или новее):

```powershell
npm ci
npm start
npm run dist:win
```

Локальная сборка установщика появится в `release`. Команда `npm run release:win` публикует релиз, поэтому используй её только в доверенном CI с настроенными GitHub Actions permissions.
