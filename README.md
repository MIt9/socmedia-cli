# socmedia-cli

CLI для соціальних мереж (Instagram, Facebook, YouTube) через локальний Bun-сервіс і розширення Google Chrome MV3 (`extension/`). Замінює MCP-міст `soc-media-ex`, не змінюючи його. Усі заплановані та реалізовані команди — у [COMMANDS.md](COMMANDS.md).

```
socmedia (CLI)  --UNIX/HTTP+токен-->  локальний сервіс (Bun)  --WebSocket /extension-->  розширення Chrome  -->  Instagram / Facebook / YouTube
```

Сервіс — єдиний власник SQLite-черги (`~/.socmedia-cli/state.sqlite`), стану зупинки (`HALT`), відновлення завдань та сполучення з розширенням.

> **Статус реалізації (v0.17.0):**
> - **Повний цикл реалізовано:** життєвий цикл сервісу, SQLite-черга з ідемпотентним відновленням незавершених завдань, HMAC-SHA256 сполучення розширення з закріпленим ID (`ingpbbhdgldgomideaihffffiinjgifj`), керування вкладками (`tabs list|use|clear`), читання сторінки й snapshot (`page read|snapshot`), скриншоти (`screenshot`), пошук на Instagram і Facebook (`search`), читання профілів (`profile get`), списку постів (`profile posts`), повне завантаження профілю з медіа (`profile download`), деталі постів (`post get`), коментарі (`post comments`), інбокс та треди (`inbox list|read`), контакти (`contacts list|update|export|import`), кліки й скрол (`browser click|scroll`), самодіагностика (`doctor`), безпечне оновлення (`update`), та налаштування конфігурації порту (`config`). Відправка прямих повідомлень (`message send --confirm`) та завантаження на YouTube Studio (`youtube upload --confirm`) наразі не реалізовані (повертають `NOT_IMPLEMENTED`), підтримується лише preview без `--confirm`.
> - **Модульна архітектура:** кодова база декомпонована на ізольовані модулі: `src/output.ts` (форматування виводу, єдиний COMMAND_REGISTRY, TTY/JSON детекція), `src/media.ts` (захищене завантаження медіа без SSRF, magic-bytes, збереження профілів), `src/doctor.ts` (перевірка стану, прав, SQLite, порту з виявленням `PORT_IN_USE`), `src/update.ts` (безпечне оновлення з перевіркою черги, sha256 та відкатом через `.old`).
> - **Безпека оновлень (Update Safety):** `socmedia update` читає `latest.json` (база: GitHub Releases, перевизначення `SOCMEDIA_CLI_UPDATE_URL`), відмовляється працювати за наявності завдання `running`, спершу завантажує й звіряє sha256 бінарника та розширення (за розбіжності нічого не змінюється), потім атомарно підміняє бінарник (попередній лишається як `<binary>.old`), оновлює `~/.socmedia-cli/extension` (попередня папка — `extension.bak`) і лише після успіху перезапускає сервіс та просить розширення перезавантажитись (`{type:"reload"}`; старі розширення це ігнорують). `--check` лише порівнює версії.
> - **Автоматизація релізів:** `.githooks/pre-push` на пуш тегу `v*` перевіряє версії та чисте дерево, запускає тести й typecheck, будує (`bun scripts/build.ts`), звіряє sha256 з `dist/latest.json`, відмовляє, якщо реліз уже існує або `gh` відсутній, і публікує `gh release create <tag> --target <sha>` лише з файлами з `latest.json` (+ `latest.json`, `install.sh`). Див. розділ «Випуск релізу».
> - **Перевірка наживо:** у цьому зрізі (0.20.0) автоматичні тести не торкаються справжнього Chrome. Чого не перевірено — див. розділ «Що не перевірено наживо».
> - **Telegram за peer ID:** `CHAT` приймає peer ID (наприклад `-3913521119` із `https://web.telegram.org/k/#-3913521119`) у `messages read`, `message send`, `message pin`, `media send`, `media download`. Запрошення (`t.me/+...`) відхиляються. `dialogs list` повертає peer і назву, `channel create` повертає peer нового каналу. Перед записом у peer ID hash URL має точно збігатися (зі знаком), а назва відкритого чату має збігатися з назвою цього peer у списку діалогів; якщо не вдалося підтвердити, нічого не надсилається. `status` повертає `account` (або `null`, якщо імені немає в даних сторінки) і `accountId`.
> - **Приватність відео TikTok:** `tiktok studio list [--limit N]` повертає `id`, `caption`, `privacy` (`null`, якщо не вдалося прочитати), `reviewStatus`, `date`. `tiktok privacy VIDEO --set public|friends|private` без `--confirm` лише показує запит і не читає Studio. Із `--confirm` дія не виконується, якщо поточну приватність або рядок відео не підтверджено. Ліміт 20/день (`SOCMEDIA_MAX_TIKTOK_PRIVACY_PER_DAY`), `public` дозволено лише із `SOCMEDIA_TIKTOK_ALLOW_PUBLIC=1` в оточенні сервісу.
> - **Безпека та права Chrome MV3:** розширення використовує `host_permissions` для `instagram.com`, `facebook.com`, `fb.com`, `youtube.com`, `tiktok.com`, `web.telegram.org` та дозвіл `debugger` (виключно для надійного розгортання вкладених коментарів без блокувань сайтом).

## Швидкий старт

### Встановлення (Curl)

Встановлення скомпільованого бінарника у `~/.local/bin` та розпакування Chrome-розширення у `~/.socmedia-cli/extension`:

```sh
curl -fsSL https://raw.githubusercontent.com/MIt9/socmedia-cli/main/scripts/install.sh | sh
```

Або локально з розробницької версії:
```sh
bun scripts/build.ts
sh scripts/install.sh
```

### Розширення та запуск сервісу

1. Встановіть розширення у стабільний каталог:
   ```sh
   socmedia extension install --open
   ```
2. У вкладці `chrome://extensions` увімкніть **Developer mode**, виберіть **Load unpacked** і вкажіть каталог `~/.socmedia-cli/extension`.
3. Запустіть діагностику:
   ```sh
   socmedia doctor
   ```
4. Запустіть сервіс:
   ```sh
   socmedia service start
   socmedia service status
   ```

## Статус, порт і коди виходу

- `socmedia service status` завжди показує `extensionUrl` (готова адреса для поля порту в popup розширення), `extensionId` (ID з ключа маніфесту), `extensionPinned` (чи збігається він із закріпленим `ingpbbhdgldgomideaihffffiinjgifj`) і `pinnedId`.
- Порт зайнятий чужим процесом: `PORT_IN_USE`, код виходу **8** (усі інші помилки — 1), у JSON-помилці `port`, `ownerPid` (best-effort через `lsof`) і `hint`; `service status` показує `portInUse`, `ownerPid`, `hint`. Змінити порт: `socmedia config set port <PORT>` і ввести той самий у popup.
- Сервіс старої версії без поля `identity` у привітанні вважається своїм, якщо процес — демон socmedia (`legacy: true` у `status`); `service stop` зупиняє його сигналом SIGTERM.

## Формати виводу для користувачів та агентів

- **Автовизначення TTY**: при запуску в інтерактивному терміналі виводиться зручний для читання текст. У пайпах, скриптах або викликах від AI-агентів (де немає TTY) вивід автоматично форматується у `JSON`.
- **Явні прапорці**: будь-яка команда підтримує `--json` та `--text`.
- **Змінна середовища**: `SOCMEDIA_CLI_FORMAT=json` або `SOCMEDIA_CLI_FORMAT=text`.
- **Структуровані помилки**: при помилці в `stderr` виводиться JSON об'єкт `{ "error": "...", "hint": "...", "code": "..." }` або префікси `Error:` / `Hint:` у текстовому режимі.

## Захисні механізми (Safety Rails)

- **Preview Gate**: дії із побічними ефектами (`message send`, `youtube upload`) без прапорця `--confirm` повертають безпечний preview-звіт (`preview: {...}, sent: false` або `{ preview: {...}, uploaded: false }`). Виконання `--confirm` для `message send` та `youtube upload` наразі не реалізовано (повертає `NOT_IMPLEMENTED`).
- **Захист від дублікатів та інтервали**: коли відправка активна, повідомлення захищені від повторної відправки одному отримувачу протягом 7 днів, діє ліміт `SOCMEDIA_MAX_MESSAGES_PER_DAY` (типово 20) та часові інтервали між слотами. Невдалі завдання (`failed`) у ліміти не зараховуються.
- **HALT захист**: при виявленні чекпоінту, капчі чи вимоги авторизації черга автоматично блокується. Після ручного проходження у Chrome виконайте:
  ```sh
  socmedia service resume
  ```

## Випуск релізу (два пуші)

Одноразово в клоні: `sh scripts/install-hooks.sh` (`git config core.hooksPath .githooks`). Піднімайте версію разом у `package.json` і `extension/manifest.json`.

1. `git push origin main` — коміт має бути на віддаленому репозиторії (`gh` створює реліз і тег на GitHub з цього коміту).
2. `git tag vX.Y.Z` (легкий тег, HEAD = позначений коміт) і `git push origin vX.Y.Z`. Хук збирає артефакти й створює реліз.

Після цього git може вивести `reference already exists` для тегу: **це очікувано**, тег уже створено релізом на GitHub, реліз не зламано.

Змінні: `SKIP_RELEASE=1` пропускає хук; `RELEASE_DRY_RUN=1` робить усе, крім публікації, і друкує команду `gh`; `RELEASE_TARGETS=host|all` (типово `host` — лише архітектура цієї машини, `all` додає x64 і потребує мережі); хук повідомляє, які архітектури зібрано. Без `gh` хук падає (не пропускає мовчки). Існуючий реліз ніколи не перезаписується. Перевірка хука: `tests/release.test.ts` (копія репозиторію, заглушка `gh`).

## Skill для Claude Code

`skills/socmedia-cli-usage/SKILL.md` — інструкція для агента (правила `--confirm`, HALT, формати). Встановлення копією:

```sh
mkdir -p ~/.claude/skills/socmedia-cli-usage && cp skills/socmedia-cli-usage/SKILL.md ~/.claude/skills/socmedia-cli-usage/
```

## Що не перевірено наживо

- Справжній Chrome із розширенням 0.20.0, у тому числі обробник `{type:"reload"}` у `extension/background.js` (покрито лише тестом коду та мок-сокетом).
- Instagram, Facebook, YouTube Studio, TikTok (`www.tiktok.com`) та Telegram Web K (`web.telegram.org/k/`) на живих сторінках у цьому зрізі (включно з TikTok Studio upload, перевіркою публікацій, Telegram Web K сесією, читанням повідомлень, чанковим скачуванням медіа та створенням каналів).
- **Усі DOM-селектори для TikTok та Telegram Web K написані з пам'яті та специфікацій і є неперевіреними наживо (unverified live) у Chrome.**
- **`tiktok studio list` наживо знаходить рядки через `a[href*='/video/']`, проте спосіб редагування приватності опублікованого відео в Studio (`tiktok privacy --confirm`) наживо ще не встановлено.** Preview читає Studio за активного розширення; команди відмовляють за невпевненості замість вгадування, але `--confirm` для privacy потребує окремої перевірки.
- Telegram (0.20.0) наживо перевірено в приватному каналі за peer ID: `status`, `dialogs list`, `messages read`, `message send`, `message pin --id`, `media send` (відео з підписом). `channel create`, аватар і опис каналу наживо не запускалися.
- `tiktok upload --schedule` (0.20.0): валідація й preview покриті тестами; селектори перемикача Now/Schedule, календаря й годинника Studio НЕ перевірені наживо (вони з'являються лише після вибору файлу, а завантажувати файл для огляду не можна), тож перший справжній запуск треба робити під наглядом. Вікно 20 хв..10 днів узято з анонсу TikTok і сторонніх описів.
- TikTok inbox підтримує лише читання (відправка повідомлень відсутня / no send).
- Справжні `socmedia update` з GitHub і `gh release create` (усе перевірено на локальному http-сервері та заглушці `gh`).
- Збірка x64 (`RELEASE_TARGETS=all`) та запуск бінарників на інших машинах.
- Ліцензію не обрано; підпис і нотаризація відсутні (лише ad-hoc `codesign`).

## Основні команди

Докладний опис усіх прапорців і форматів дивіться через `socmedia <command> --help` (або `socmedia --help --json`):

- `socmedia doctor` — повна діагностика середовища (Chrome, Bun, права каталогу 0700, SQLite integrity, порт, сервіс, розширення) з підказками `fix`.
- `socmedia update [--check]` — перевірка та встановлення оновлень (бінарник + розширення) з GitHub Releases або з `SOCMEDIA_CLI_UPDATE_URL`.
- `socmedia service <start|stop|status|resume>` — керування фоновим сервісом та зняттям режиму HALT.
- `socmedia config <get|set|unset> port [value]` — налаштування порту сервісу.
- `socmedia queue <list|get|cancel|enqueue>` — інспекція та керування чергою завдань.
- `socmedia extension <install|path|pair>` — керування розширенням та безпечним HMAC-сполученням.
- `socmedia tabs <list|use|clear>` — робочі вкладки розширення в Chrome.
- `socmedia page <read|snapshot>` — читання тексту сторінки або отримання інтерактивних елементів DOM.
- `socmedia profile get <url>` — читання профілю Instagram/Facebook та збереження контакту.
- `socmedia profile posts <url> [--limit N]` — отримання списку постів профілю.
- `socmedia profile download <url> [options]` — повне завантаження постів, фото/відео та markdown-звіту.
- `socmedia post get <url> [--download]` — деталі поста Instagram/Facebook із завантаженням медіа.
- `socmedia post comments <url> [--limit N]` — вилучення коментарів поста з розгортанням через debugger.
- `socmedia search <platform> <query> [options]` — пошук профілів, сторінок або хештегів.
- `socmedia screenshot [options]` — створення скриншота сторінки, поста чи профілю.
- `socmedia inbox <list|read>` — перегляд діалогів або повідомлень інбоксу.
- `socmedia message send --to <URL> --text <TEXT> [--confirm]` — відправка повідомлення з preview gate.
- `socmedia youtube <channel|studio status|upload>` — робота з дозволеними каналами YouTube Studio.
- `socmedia tiktok <profile|posts|video|comments|search|inbox|upload>` — робота з TikTok через браузерне розширення (preview gate на завантаження, ліміти).
- `socmedia telegram <status|dialogs|messages|message|media|channel>` — робота з Telegram Web K через розширення (читання, завантаження медіа чанками, preview gate на відправку та канали).
- `socmedia contacts <list|update|export|import>` — керування базою контактів, зміна статусу/нотаток, імпорт зі спадку та експорт у CSV/JSON/JSONL.
- `socmedia browser <click|scroll>` — прямі взаємодії з сторінкою (клік по елементу чи скрол).

> **Попередження щодо умов використання:** автоматизація цих платформ (TikTok, Telegram, Instagram, Facebook, YouTube) може порушувати їхні умови надання послуг (Terms of Service); жодні операції наживо на справжніх акаунтах не перевірялися і надійність живого виконання не гарантується.

## Розробка

Як влаштовано диспетчер команд, як додати команду, платформу чи дію розширення (чекліст, генератор `bun scripts/new-command.ts <name>`) — у [CONTRIBUTING.md](CONTRIBUTING.md).
