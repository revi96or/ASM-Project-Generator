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

## Versioning

- app version: `2.6.0`
- UI version: `9.14.0`

## Update notes

The app is configured for GitHub Releases as the update source.
User settings, paths, snapshots, and cache live under Electron app data instead of the program folder.
Template files are bundled under `templates\` and copied into the installed app by the installer.
Tailwind styles, Lucide icons, and Cyrillic fonts are bundled under `assets\`, so the interface starts without an internet connection.
