<!--
Описание: Справочник версионных точек проекта ASM Project Generator.
Версия: 1.0
Автор: Новожилов Артем
-->

# Справочник по обновлению версии

Этот файл нужен как быстрый чеклист перед bump версии, чтобы не искать вручную все зеркала по репозиторию.

## Источник истины

1. `package.json`
   - `version`
   - `versionDate`
   - Это главный файл, от которого читается версия в runtime.

## Файлы, которые обычно нужно править вместе с `package.json`

| Файл | Что менять |
|---|---|
| `package-lock.json` | `version` в корне и в `packages[""].version` |
| `main.js` | Заголовок файла, `APP_META.versionDate`, дефолтные fallback-значения версии |
| `preload.js` | Заголовок файла |
| `tailwind.config.js` | Заголовок файла |
| `asm_generator_form_v9.html` | `version`, `versionDate`, `currentVersion`, `latestVersion`, `footerVersionInfo`, любые fallback-литералы в `asmBridge` и `state.appMeta` |
| `pnp_pipeline_v300.js` | Заголовок файла, `APP_VERSION`, текст изменения в шапке |
| `Dict\pnp_dict_v300.js` | Заголовок файла и экспортируемая `version` |
| `README.md` | Строка с версией приложения |
| `PROJECT_CONTEXT.md` | Блоки с версией проекта и `date/versionDate` |
| `Version.md` | Короткая строка с названием/версией сборки |

## Что проверять после bump

- `rg -n "3\.\d+\.\d+|versionDate|currentVersion|latestVersion" .`
- Убедиться, что в `asm_generator_form_v9.html` нет старых fallback-значений версии.
- Убедиться, что `main.js` и `package.json` согласованы по `versionDate`.
- Проверить, что `package-lock.json` не остался на старом номере.

## Что обычно не трогаем

- `Dict\Dict.xlsx` как бинарный файл не является обычной текстовой точкой версионирования.
- Внутренние временные или архивные файлы с версией меняются только если их реально используют в runtime.
