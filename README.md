# ASM Project Generator

Electron desktop app for generating ASM printer project files.

## Stack

- HTML
- CSS
- JavaScript
- Electron

## What it does

- reads template data from `template.PR1`, `template.ISD`, `template.pxf`
- edits PR1 values from the form
- saves a project snapshot locally and backs it up to `%AppData%`
- generates `.PR1`, `.ISD`, `.pxf`
- saves AOI `.txt`
- checks GitHub Releases for updates

## Project layout

- `asm_generator_form_v9.html` — UI
- `main.js` — Electron main process
- `preload.js` — renderer bridge
- `pr1_known_map.json` — PR1 map
- `templates\` — bundled template files for installed builds
- `assets\` — app icon files

## Run

```bash
npm install
npm start
```

## Build

```bash
npm run dist:installer
```

## Catalog paths

Все адреса из **Дерева каталогов** хранятся в `asm-user-settings.json` в папке Electron app data. Если пользователь заполнил поле, приложение использует именно его значение. Если поле пустое, поведение зависит от конкретного адреса:

| Поле | Дефолт / поведение при пустом значении |
|---|---|
| Локальная папка принтера | `c:\SMT_Project_Generator\Printer_ASM\` |
| Адрес принтера | `d:\Product\` |
| Локальная папка АОИ | `c:\SMT_Project_Generator\AOI\` |
| Адрес АОИ | `\\server\common\Любимова\` |
| Адрес расстановщика | `d:\SaveTXT\` |
| Словарь P&P (`Dict.xlsx`) | без поля P&P не стартует; будет ошибка `Не задан путь к словарю P&P.` |
| Папка импорта CSV | если пусто, диалог выбора CSV стартует из `C:\settings\Pick Place\Test\` |
| Экспорт XLSX | пустое значение допустимо, но путь для автосохранения XLSX не задан |
| Экспорт P&P | если не задан, используется `%AppData%\asm_project_generator\pnp_exports_v300` |
| Файл состояния P&P | если не задан, используется `%AppData%\asm_project_generator\pnp_state_v300.js` |

`README.md` включается в сборку вместе с приложением, чтобы эти дефолты и правила были доступны и в установленной версии.

## Versioning

- app version: `3.6.6`
- UI version: `9.27.18`

## Update notes

The app is configured for GitHub Releases as the update source.
User settings, paths, snapshots, and cache live under Electron app data instead of the program folder.
Template files are bundled under `templates\` and copied into the installed app by the installer.
Tailwind styles, Lucide icons, and Cyrillic fonts are bundled under `assets\`, so the interface starts without an internet connection.
