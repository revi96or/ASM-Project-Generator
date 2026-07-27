# ASM Project Generator

Windows desktop app for generating ASM printer project files.

## Stack

- HTML
- CSS
- JavaScript
- Electron

## What it does

- reads template data from `template.PR1`, `template.ISD`, `template.pxf`
- edits PR1 values from the form
- saves a project snapshot locally
- generates `.PR1`, `.ISD`, `.pxf`
- saves AOI `.txt`

## Project layout

- `asm_generator_form_v9.html` — UI
- `main.js` — Electron main process
- `preload.js` — renderer bridge
- `pr1_known_map.json` — PR1 map
- `assets\` — app icon files
- `Project\` — project data / working files

## Run

```bash
npm install
npm start
```

## Build

```bash
npm run dist:portable
```

## Versioning

- app version: `2.0.1`
- UI version: `9.9.15`

## Notes for future updates

The repository is prepared for future network update distribution.
When release publishing is added, the repo can be used as the source for build artifacts and update metadata.
