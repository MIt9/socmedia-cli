# Відповідність операцій CLI

Це таблиця цільової відповідності, а не перелік уже реалізованих команд. `page read`, `page snapshot`, `profile get`, `profile posts` та `post comments` для Instagram і Facebook реалізовані й перевірені автоматично з імітованим розширенням; їх ще не перевірено наживо в Chrome. Джерела: `soc-media-ex/mcp-server/index.js` (32 реєстрації), `README.md` і `SPEC.md`. Форматування параметрів і результатів можна уточнити під час реалізації; `--json` передбачає структурований результат. Для запису `--confirm` означає явне підтвердження; без нього повертається preview.

## Instagram, Facebook, браузер і черга

| Поточна операція | Запланована команда | Основні параметри | Результат / поведінка |
|---|---|---|---|
| `social_status` | `socmedia status` | `--json` | Стан сервісу та розширення, версії, HALT, ліміти повідомлень, статистика сховища. |
| `social_get_profile` | `socmedia profile get URL` | `--json` | Instagram і Facebook: дані профілю й доступні показники, поля можуть бути `null`; успішне читання додає або оновлює контакт. Facebook URL: slug, `profile.php?id=<число>`, або `/people/<slug>/<id>` / `/pages/<slug>/<id>`. Redirect на інший профіль відхиляється. Наживо в Chrome не перевірено. |
| `social_get_posts` | `socmedia profile posts URL` | `--limit` | Реалізовано для Instagram і Facebook: список постів із посиланнями, типами, зображеннями та доступними метриками (ліміт 1-100, дефолт 12). Наживо в Chrome не перевірено. |
| `social_get_post` | `socmedia post get URL` | `--download` (`--slides` як сумісний alias) | Реалізовано для Instagram і Facebook: пост, автор, медіа, хештеги, згадки; при завантаженні (`--download`/`--slides`) файли зберігаються в `~/socmedia-data/<platform>/<author>/<postId>/` разом із `post.json` з перевіркою magic-bytes та захистом від SSRF. Наживо в Chrome не перевірено. |
| `social_get_comments` | `socmedia post comments URL` | `--limit` | Реалізовано для Instagram і Facebook: URL поста/рілса/відео, розгортання через Chrome debugger, коментарі, автори, посилання, текст, дати та вподобання. Наживо в Chrome не перевірено. |
| `social_search` | `socmedia search PLATFORM QUERY` | `--type users\|hashtag\|pages\|places`, `--limit` | Реалізовано для Instagram і Facebook: список знайдених профілів, сторінок або хештегів (ліміт 1–50, дефолт 20). Наживо в Chrome не перевірено. |
| `social_screenshot` | `socmedia screenshot` | `--url`, `--selector`, `--target viewport\|post\|profile`, `--path` | Реалізовано: шлях PNG, розміри, URL і `truncated` за потреби; файл зберігається всередині home або за замовчуванням у `~/socmedia-data/screenshots/`. Наживо в Chrome не перевірено. |
| `social_download_profile` | `socmedia profile download URL` | `--limit`, `--details`, `--max-media`, `--dir`, `--background` | Реалізовано: збирання профілю, скриншота, постів, деталей і медіафайлів (до `--max-media`, без дублікатів) у `~/socmedia-data/<platform>/<username>/` разом із `profile.json`, `posts.json`, `profile.md`; опція `--background` для виконання через чергу сервісу. Наживо в Chrome не перевірено. |
| `social_inbox` | `socmedia inbox list PLATFORM` | `--limit` | Реалізовано для Instagram і Facebook: список розмов, фрагмент повідомлення, час і стан непрочитаного (ліміт 1–100, дефолт 20). Наживо в Chrome не перевірено. |
| `social_read_thread` | `socmedia inbox read` | `--url URL` або `--to PROFILE`, `--limit` | Реалізовано для Instagram і Facebook: повідомлення розмови у хронологічному порядку, тип і доступні медіа (ліміт 1–100, дефолт 30). Наживо в Chrome не перевірено. |
| `social_send_message` | `socmedia message send` | `--to URL`, `--text TEXT`, `--confirm` | Реалізовано: dry-run preview без `--confirm`; із `--confirm` чергування повідомлення з лімітом на день (`SOCMEDIA_MAX_MESSAGES_PER_DAY`, дефолт 20), захистом від дублікатів за 7 днів та автоматичним інтервалом слотів (90с + 0..60с). Наживо в Chrome не перевірено. |
| `social_contacts` | `socmedia contacts list` / `socmedia contacts update ID` | `--status`, `--platform`; для update `--status`, `--note` | Список, фільтри й зміна статусу та нотаток реалізовані; імпорт старих контактів ще не реалізований. |
| `social_export` | `socmedia contacts export` | `--status`, `--platform`, `--format csv\|json\|jsonl`, `--path`, `--json` | Реалізовано: шлях і кількість експортованих контактів; файл лише всередині home, символічні посилання на шляху відхиляються. |
| `social_snapshot` | `socmedia page snapshot` | `--json` | Інтерактивні елементи вкладки з індексами; реалізовано, живий Chrome не перевірено. |
| `social_read_page` | `socmedia page read` | `--max-lines` (1–1000, типово 200), `--json` | URL і видимий текст сторінки; реалізовано, живий Chrome не перевірено. |
| `social_click` | `socmedia browser click` | один із `--index`, `--selector`, `--text` | Результат кліку; повторення при невизначеному результаті заборонено. |
| `social_scroll` | `socmedia browser scroll` | `--selector`, `--times` | Результат прокрутки. |
| `social_tabs` | `socmedia tabs list` | — | Вкладки робочої групи, поточна та вибрана вкладка. |
| `social_use_tab` | `socmedia tabs use ID` / `socmedia tabs clear` | ID вкладки або clear | Вибір вкладки або повернення до робочої групи. |
| `social_enqueue` | `socmedia queue enqueue ACTION` | `--args JSON`, `--not-before`, `--key` | ID і стан завдання; повідомлення, публікація коментарів і завантаження відео не обходять окремі перевірки. |
| `social_queue` | `socmedia queue list` / `get ID` / `cancel ID` | `--status`, `--limit` для list | Завдання й результати, або стан скасування; виконуване завдання не скасовується як звичайне queued. |

## YouTube через розширення

У старій реалізації завантаження файлу через Studio поєднане з API-перевіркою та API-оновленням метаданих. Новий проєкт має замінити ці кроки UI-операціями з перевіркою стану. Нижче наведено цільову поведінку, а не твердження, що її вже підтримує розширення.

| Поточна операція | Запланована команда | Основні параметри | Результат / поведінка |
|---|---|---|---|
| `yt_auth_status` | `socmedia youtube status` | `--channel` | Стан розширення, сесії та перевірки дозволеного каналу; OAuth-токен і квота API не потрібні. |
| `yt_auth_start` | Немає прямої команди | — | OAuth API усувається; користувач входить у YouTube через Chrome. |
| `yt_channel` | `socmedia youtube channel` | `--channel` | Реалізовано: читання та перевірка каналу з локального allowlist `~/.socmedia-cli/youtube.json`. |
| `yt_upload` | `socmedia youtube upload FILE` | `--title`, `--description`, `--privacy`, `--channel`, `--confirm` | Реалізовано preview gate: без `--confirm` повертає dry-run preview з деталями чернетки; вимагає `write: true` у allowlist. |
| `yt_studio_upload` | `socmedia youtube upload FILE` | Також `--thumbnail` | Той самий UI-потік; перевірка каналу, збереження та метаданих через UI. Не повторювати сліпо при невизначеному результаті. |
| `yt_update_video` | `socmedia youtube video update VIDEO` | `--title`, `--description`, `--privacy`, `--publish-at`, `--thumbnail`, `--channel`, `--confirm` | Preview змін або перевірений результат редагування. |
| `yt_set_thumbnail` | `socmedia youtube video thumbnail VIDEO FILE` | `--channel`, `--confirm` | Preview або результат встановлення обкладинки. |
| `yt_playlists` | `socmedia youtube playlists list` / `create` / `add` | `--title`, `--description`, `--privacy`, `--playlist`, `--video`, `--limit`, `--channel`, `--confirm` | Список плейлистів або preview/результат створення чи додавання. |
| `yt_comments_list` | `socmedia youtube comments list VIDEO` | `--limit`, `--order`, `--page-token`, `--channel` | Коментарі та доступна інформація для наступної сторінки; механізм пагінації UI потребує перевірки. |
| `yt_pin_comment` | `socmedia youtube comment pin VIDEO` | `--text`, `--channel`, `--confirm` | Preview або результат публікації й закріплення; невизначений результат не повторюється автоматично. |
| `yt_studio_read` | `socmedia youtube studio status` | `--open`, `--channel` | Реалізовано: перевірка поточної вкладки Studio проти дозволеного channelId, читання розділу та облікового запису. |

**Невизначеність UI:** старий код реалізує прикріплення файлу та проходження Studio, але специфікація підтверджує живу перевірку лише для кнопки завантаження й поля файлу. Користувач повідомив, що повний сценарій працював; це потрібно повторно перевірити. Назва, опис, обкладинка й фінальна приватність у старому Studio-потоці встановлювалися API. Канал, редагування, плейлисти, коментарі, пагінація та API-еквівалентні поля через UI потребують реалізації і живої перевірки; відсутність надійного read-back має повертати явну невизначеність.
