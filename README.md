# socmedia-cli

CLI для соціальних мереж (Instagram, Facebook, YouTube) через локальний сервіс і розширення Chrome (`extension/`). Замінює MCP-міст `soc-media-ex`, не змінюючи його. Усі заплановані та реалізовані команди — у [COMMANDS.md](COMMANDS.md).

```
socmedia (CLI)  --HTTP+токен-->  локальний сервіс (Bun)  --WebSocket /extension-->  розширення Chrome  -->  Instagram / Facebook / YouTube
```

Сервіс — єдиний власник черги (SQLite), стану зупинки (HALT), відновлення завдань та з'єднання з розширенням.

> **Статус реалізації (v0.12.0):**
> - Реалізовано й перевірено автоматичними тестами: життєвий цикл сервісу, SQLite-черга з відновленням незавершених завдань після перезапуску та обриву WebSocket, сполучення розширення (HMAC-SHA256, фіксований ID), керування вкладками (`tabs list|use|clear`), читання сторінки й snapshot (`page read|snapshot`), скриншоти сторінки, постів, профілів та елементів (`screenshot`), пошук на Instagram і Facebook (`search`), читання профілів Instagram і Facebook (`profile get`), читання списку постів профілю (`profile posts`), завантаження повного профілю з медіа та markdown-звітом (`profile download`), деталі постів Instagram і Facebook із завантаженням медіа (`post get` з `--download`/`--slides`), локальні контакти (`contacts list|update|export`), коментарі до постів Instagram та Facebook (`post comments`), читання розмов та інбоксу (`inbox list|read`), прямі повідомлення із захисними рейками (`message send` з preview gate, добовим лімітом, захистом від дублікатів за 7 днів та інтервалами слотів), інтеграція YouTube Studio (`youtube channel`, `youtube studio status`, `youtube upload` з allowlist каналів та preview gate), збірка автономного бінарника (`bun run build`).
> - **Не перевірено наживо:** живий Chrome, реальні сайти Instagram, Facebook та YouTube ще не перевірялися.
> - **У розробці:** імпорт старих контактів та історії повідомлень зі старого проєкту (`contacts import`), прямі команди кліку та скролу браузера (`browser click|scroll`).

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

1. Встановіть розширення:
   ```sh
   socmedia extension install
   ```
2. Відкрийте `chrome://extensions` у Google Chrome, увімкніть **Developer mode** і натисніть **Load unpacked**, вказавши каталог `~/.socmedia-cli/extension`.
3. Згенеруйте сполучення:
   ```sh
   socmedia extension pair --id <EXTENSION_ID>
   ```
4. Запустіть сервіс:
   ```sh
   socmedia service start
   ```

## Основні команди

Докладний опис усіх прапорців і форматів дивіться через `--help` відповідної команди або у [COMMANDS.md](COMMANDS.md).

- `socmedia service <start|stop|status>` — керування локальним фоновим сервісом.
- `socmedia queue <list|get|cancel|enqueue>` — інспекція черги завдань.
- `socmedia extension <install|path|pair>` — керування Chrome-розширенням та сполученням.
- `socmedia tabs <list|use|clear>` — робоча група вкладок розширення.
- `socmedia page <read|snapshot>` — читання тексту та інтерактивних елементів поточної робочої вкладки.
- `socmedia profile get <url>` — читання профілю Instagram або Facebook та збереження у контакти.
- `socmedia profile posts <url> [--limit N]` — читання списку постів профілю Instagram або Facebook.
- `socmedia post comments <url> [--limit N]` — читання коментарів поста, відео або reel Instagram та Facebook (розгортання через Chrome debugger).
- `socmedia search <platform> <query> [options]` — пошук профілів, сторінок або хештегів на Instagram та Facebook.
- `socmedia screenshot [options]` — створення скриншота viewport, поста, профілю або довільного елемента.
- `socmedia inbox <list|read>` — перегляд списку розмов або читання повідомлень інбоксу Instagram/Facebook.
- `socmedia message send --to <URL> --text <TEXT> [--confirm]` — відправка прямого повідомлення з лімітами безпеки та dry-run preview.
- `socmedia youtube <channel|studio status|upload>` — робота з YouTube Studio, перевірка каналів проти allowlist та завантаження чернеток відео.
- `socmedia contacts <list|update|export>` — перегляд, оновлення нотаток/статусів та експорт контактів у CSV/JSON/JSONL.
