# АнтиЧебурнет — сборка для Chromium и Firefox (Manifest V3)

### Требования к окружению:
* **Node.js**: `v22.x`+ (LTS)
* **NPM**: `v9.x` / `v10.x`+

---

### Установка зависимостей и сборка:

```bash
# 1. Установка зависимостей сборщика
npm install

# 2. Сборка обеих браузерных версий
npm run release:all
```

Готовые к установке сборки создаются в директориях:

- 📁 **`build/extension-chromium`** — Chromium;
- 📁 **`build/extension-firefox`** — Firefox.

`npm run release` сохранён как Chromium-only команда для обратной совместимости.

---

### Установка в Chromium (Chrome / Edge / Brave / Yandex / Opera)

1. Откройте страницу расширений `chrome://extensions/`
2. Включите переключатель **«Режим разработчика»** (Developer mode) в правом верхнем углу
3. Нажмите **«Загрузить распакованное расширение»** (Load unpacked)
4. Выберите папку `build/extension-chromium`

### Установка в Firefox Desktop 140+

1. Откройте `about:debugging#/runtime/this-firefox`
2. Нажмите **«Загрузить временное дополнение»**
3. Выберите `manifest.json` из `build/extension-firefox`
4. В `about:addons` разрешите дополнению **работу в приватных окнах** — Firefox требует это разрешение для изменения настроек прокси

Полезные команды:

```bash
npm run release:chrome   # сборка Chromium
npm run release:firefox  # сборка Firefox
npm run lint:firefox     # проверка Firefox через web-ext
npm run start:firefox    # сборка и запуск в тестовом профиле
npm run package:firefox  # ZIP в web-ext-artifacts
npm run sign:firefox     # подписанный Mozilla XPI в web-ext-signed-artifacts
```

ZIP от `web-ext build` предназначен для проверки и отправки на подпись. Для обычной установки в Firefox Release или Beta дополнение должно быть подписано Mozilla.

Релизный GitHub Actions workflow подписывает Firefox-сборку через AMO (`unlisted`) с Repository secrets `AMO_JWT_ISSUER` и `AMO_JWT_SECRET`. Эти API-реквизиты позволяют AMO выпустить подписанный пакет; секрет или закрытый ключ не должен храниться в Git. Готовый `.xpi` публикуется в GitHub Release; для каждой отправки требуется новая версия расширения.
