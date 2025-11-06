# outage-data-ua

Публічне сховище та інструменти для автоматичного збирання, парсингу і публікації даних про планові відключення електроенергії в Україні.

Проєкт отримує дані з відкритих вебсторінок постачальників, нормалізує їх до машиночитного формату і зберігає у файлах JSON у директорії `data/`.

---

## Що всередині
- Скрипти Bash/Node.js для:
    - отримання HTML сторінок:
      - через Playwright (headless Chromium) — `scripts/fetch_regions_playwright.mjs` (основний спосіб у CI)
      - через `curl` з «браузероподібними» заголовками — `scripts/fetch_regions.sh` (швидкий локальний варіант)
    - парсингу значення `DisconSchedule.fact` зі сторінки і нормалізації у JSON (`scripts/parse_regions.sh`, `scripts/parse_fact.js`)
- Конвеєр GitHub Actions, що кожні 15 хвилин:
    1) за допомогою Playwright завантажує сторінки для кожного регіону
    2) парсить дані та оновлює `data/<region>.json`
    3) комітить і пушить зміни у `main` (якщо файли змінилися)

> Примітка: якщо сторінка захищена антибот‑механізмом і замість контенту віддається сторінка WAF (напр., Incapsula), парсер фіксує помилку, зберігаючи попередні коректні дані у JSON.

---

## Формат даних
Кожен регіон зберігається у файлі `data/<region>.json`. Базова структура (скорочено):

```json
{
  "regionId": "kyiv",
  "regionName": "Київ",
  "regionType": "city",
  "lastUpdated": "2025-11-06T08:30:00+02:00",
  "data": { "GPV1.1": [ { "startLocal": "...", "endLocal": "..." } ] },
  "lastUpdateStatus": { "status": "parsed", "ok": true, "code": 200, "at": "...", "attempt": 5 },
  "meta": {
    "schemaVersion": "1.0.0",
    "fileCreated": "...",
    "timezone": "Europe/Kyiv",
    "source": { "type": "proxy", "upstream": "https://.../ua/shutdowns" },
    "ttlSeconds": 300,
    "contentHash": "...",
    "dataEmpty": false,
    "dataEmptyReason": null
  }
}
```

- Поле `data` містить розклади по групах (наприклад, `GPV1.1`, `GPV4.1`, тощо). За можливості інтервали переводяться у ISO‑дату у часовому поясі `Europe/Kyiv` (`startLocal`, `endLocal`).
- Якщо структура джерела невідома, парсер зберігає сиру структуру та пояснює причину в `meta.dataEmptyReason`.
- У разі помилки `lastUpdateStatus.status = "error"`, при цьому попередні дані не стираються.

---

## Налаштування джерел
Посилання на сторінки задаються однією змінною оточення/секретом `REGION_SOURCES_JSON` у форматі JSON‑мапи `{"<regionId>": "<url>"}`.

Приклад для локального `.env` (не комітиться):

```bash
REGION_SOURCES_JSON='{
  "kyiv": "https://www.dtek-kem.com.ua/ua/shutdowns",
  "kyiv-region": "https://www.dtek-krem.com.ua/ua/shutdowns",
  "odesa": "https://www.dtek-oem.com.ua/ua/shutdowns",
  "dnipro": "https://www.dtek-dnem.com.ua/ua/shutdowns"
}'
```

У GitHub → Settings → Secrets and variables → Actions додайте секрет `REGION_SOURCES_JSON` зі «сирим» JSON (без зовнішніх лапок).

---

## Локальний запуск
Передумови: `Node.js 18+`, `jq`. Для варіанта з `curl` — ще й `curl`.

Варіант A — Playwright (рекомендовано, ідентична поведінка до CI):
```bash
# одноразово встановити npm-пакет Playwright та браузерні бінарники з залежностями
npm i --no-save playwright
npx playwright install --with-deps chromium

# завантажити всі регіони (використовує REGION_SOURCES_JSON з .env або змінних середовища)
node scripts/fetch_regions_playwright.mjs

# або лише один регіон
REGION=kyiv node scripts/fetch_regions_playwright.mjs
# або через аргумент командного рядка
node scripts/fetch_regions_playwright.mjs kyiv
```
HTML зʼявиться у `outputs/<region>.html`.

Варіант B — curl (швидко перевірити локально; може впиратися у WAF):
```bash
scripts/fetch_regions.sh           # усі регіони
scripts/fetch_regions.sh kyiv      # лише один регіон
REGION=kyiv scripts/fetch_regions.sh
```

Далі — парсинг у JSON:
```bash
scripts/parse_regions.sh               # усі наявні outputs/*.html
REGION=kyiv scripts/parse_regions.sh   # лише один регіон
```
Результат — `data/<region>.json`.

У випадку помилок парсер оновлює тільки статус у JSON, не стираючи попередні дані.

---

## Як працює CI
- Пайплайн (`.github/workflows/scheduled.yml`) запускається кожні 15 хв і за ручним тригером.
- Кроки: fetch → parse → commit&push (тільки зміни у `data/*.json`).
- Потрібні права `contents: write` для `GITHUB_TOKEN`. Якщо `main` захищена — дозвольте GitHub Actions пушити або перейдіть на PR‑потік.

---

## Обмеження та антибот
- У CI тепер використовується безголовий браузер (Playwright, Chromium), який виконує JS і встановлює cookies — це допомагає коректно проходити антибот‑перевірки та отримувати «справжній» HTML.
- Локально ви можете спробувати `scripts/fetch_regions.sh` (посилені заголовки, cookie‑jar, реферер). Якщо сторінка все одно повертає WAF‑HTML — використайте Playwright‑скрипт (див. нижче).
- Якщо замість сторінки приходить WAF‑HTML, парсер виставляє код помилки (напр., 422) і зберігає наявні дані.

---

## Ліцензія та юридичні застереження
- Дані збираються з публічно доступних джерел. Дотримуйтеся умов використання сайтів.
- Репозиторій не претендує на право власності на первинні дані; див. LICENSE (MIT).

---

## Внесок
Див. файл [CONTRIBUTING.md](CONTRIBUTING.md): як повідомляти про проблеми, запускати локально, стиль коду та правила для JSON.
