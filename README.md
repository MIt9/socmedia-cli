# socmedia-cli

CLI для соціальних мереж (Instagram, Facebook, YouTube) через локальний сервіс і розширення Chrome (`extension/`). Замінює MCP-міст `soc-media-ex`, не змінюючи його. Усі заплановані та реалізовані команди — у [COMMANDS.md](COMMANDS.md).

```
socmedia (CLI)  --HTTP+токен-->  локальний сервіс (Bun)  --WebSocket /extension-->  розширення Chrome  -->  Instagram / Facebook / YouTube
```

Сервіс — єдиний власник черги (SQLite), стану зупинки (HALT), відновлення завдань та з'єднання з розширенням.

> **Статус реалізації (v0.5.0):**
> - Реалізовано й перевірено автоматичними тестами: життєвий цикл сервісу, SQLite-черга з відновленням незавершених завдань після перезапуску та обриву WebSocket, сполучення розширення (HMAC-SHA256, фіксований ID), керування вкладками (`tabs list|use|clear`), читання сторінки й snapshot (`page read|snapshot`), читання профілів Instagram і Facebook (`profile get`), локальні контакти (`contacts list|update|export`), коментарі до постів Instagram (`post comments`).
> - **Не перевірено наживо:** живий Chrome, реальні сайти Instagram, Facebook та YouTube ще не перевірялися.
> - **Ще не реалізовано:** коментарі Facebook (`post comments`), завантаження постів/медіа, скриншоти, повідомлення inbox, YouTube через Studio UI.

## Швидкий старт

### Розширення та запуск сервісу

1. Встановіть розширення у стабільний каталог стану:
   ```sh
   bun run src/cli.ts extension install
   ```
2. Відкрийте `chrome://extensions` у Google Chrome, увімкніть **Developer mode** і натисніть **Load unpacked**, вказавши каталог, надрукований командою `extension install`.
3. Згенеруйте сполучення:
   ```sh
   bun run src/cli.ts extension pair --id <EXTENSION_ID>
   ```
4. Запустіть сервіс:
   ```sh
   bun run src/cli.ts service start
   ```

## Основні команди

Докладний опис усіх прапорців і форматів дивіться через `--help` відповідної команди або у [COMMANDS.md](COMMANDS.md).

- `socmedia service <start|stop|status>` — керування локальним фоновим сервісом.
- `socmedia queue <list|get|cancel|enqueue>` — інспекція черги завдань.
- `socmedia extension <install|path|pair>` — керування Chrome-розширенням та сполученням.
- `socmedia tabs <list|use|clear>` — робоча група вкладок розширення.
- `socmedia page <read|snapshot>` — читання тексту та інтерактивних елементів поточної робочої вкладки.
- `socmedia profile get <url>` — читання профілю Instagram або Facebook та збереження у контакти.
- `socmedia post comments <url> [--limit N]` — читання коментарів поста або reel Instagram (розгортання через Chrome debugger).
- `socmedia contacts <list|update|export>` — перегляд, оновлення нотаток/статусів та експорт контактів у CSV/JSON/JSONL.
