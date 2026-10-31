# socmedia-cli

CLI для соціальних мереж (Instagram, Facebook, YouTube) через локальний Bun-сервіс і розширення Google Chrome MV3 (`extension/`). Замінює MCP-міст `soc-media-ex`, не змінюючи його. Усі заплановані та реалізовані команди — у [COMMANDS.md](COMMANDS.md).

```
socmedia (CLI)  --UNIX/HTTP+токен-->  локальний сервіс (Bun)  --WebSocket /extension-->  розширення Chrome  -->  Instagram / Facebook / YouTube
```

Сервіс — єдиний власник SQLite-черги (`~/.socmedia-cli/state.sqlite`), стану зупинки (`HALT`), відновлення завдань та сполучення з розширенням.

> **Статус реалізації (v0.16.0):**
> - **Повний цикл реалізовано:** життєвий цикл сервісу, SQLite-черга з ідемпотентним відновленням незавершених завдань, HMAC-SHA256 сполучення розширення з закріпленим ID (`ingpbbhdgldgomideaihffffiinjgifj`), керування вкладками (`tabs list|use|clear`), читання сторінки й snapshot (`page read|snapshot`), скриншоти (`screenshot`), пошук на Instagram і Facebook (`search`), читання профілів (`profile get`), списку постів (`profile posts`), повне завантаження профілю з медіа (`profile download`), деталі постів (`post get`), коментарі (`post comments`), інбокс та треди (`inbox list|read`), прямі повідомлення з preview gate та лімітами (`message send`), YouTube Studio allowlist та завантаження (`youtube`), контакти (`contacts list|update|export|import`), кліки й скрол (`browser click|scroll`), самодіагностика (`doctor`), оновлення (`update`), та налаштування конфігурації порту (`config`).
> - **Перевірено наживо в Chrome:** успішно підтверджено роботу розширення в Chrome з реальними сторінками Instagram (авторизоване вилучення профілів, постів, збереження контактів, скрол, DOM snapshots).
> - **Безпека та права Chrome MV3:** розширення використовує `host_permissions` для `instagram.com`, `facebook.com`, `fb.com`, `youtube.com` та дозвіл `debugger` (виключно для надійного розгортання вкладених коментарів без блокувань сайтом).

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

## Формати виводу для користувачів та агентів

- **Автовизначення TTY**: при запуску в інтерактивному терміналі виводиться зручний для читання текст. У пайпах, скриптах або викликах від AI-агентів (де немає TTY) вивід автоматично форматується у `JSON`.
- **Явні прапорці**: будь-яка команда підтримує `--json` та `--text`.
- **Змінна середовища**: `SOCMEDIA_CLI_FORMAT=json` або `SOCMEDIA_CLI_FORMAT=text`.
- **Структуровані помилки**: при помилці в `stderr` виводиться JSON об'єкт `{ "error": "...", "hint": "...", "code": "..." }` або префікси `Error:` / `Hint:` у текстовому режимі.

## Захисні механізми (Safety Rails)

- **Preview Gate**: дії із побічними ефектами (`message send`, `youtube upload`) без прапорця `--confirm` повертають безпечний preview-звіт (`preview: {...}, sent: false`). Для виконання операції агент чи користувач має явно передати `--confirm`.
- **Захист від дублікатів та інтервали**: повідомлення захищені від повторної відправки одному отримувачу протягом 7 днів, діє ліміт `SOCMEDIA_MAX_MESSAGES_PER_DAY` (типово 20) та часові інтервали між слотами.
- **HALT захист**: при виявленні чекпоінту, капчі чи вимоги авторизації черга автоматично блокується. Після ручного проходження у Chrome виконайте:
  ```sh
  socmedia service resume
  ```

## Основні команди

Докладний опис усіх прапорців і форматів дивіться через `socmedia <command> --help` (або `socmedia --help --json`):

- `socmedia doctor` — повна діагностика середовища (Chrome, Bun, права каталогу 0700, SQLite integrity, порт, сервіс, розширення) з підказками `fix`.
- `socmedia update [--check]` — перевірка та встановлення оновлень бінарника з GitHub Releases.
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
- `socmedia contacts <list|update|export|import>` — керування базою контактів, зміна статусу/нотаток, імпорт зі спадку та експорт у CSV/JSON/JSONL.
- `socmedia browser <click|scroll>` — прямі взаємодії з сторінкою (клік по елементу чи скрол).
