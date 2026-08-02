/**
 * Описание: Главный файл Electron для запуска окна ASM Project Generator.
 * Версия: 2.4.0
 * Автор: Новожилов Артем
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const packageJson = require('./package.json');

const REQUIRED_TEMPLATE_FILES = ['template.PR1', 'template.ISD', 'template.pxf', 'pr1_known_map.json'];
const TEMPLATE_ASSETS_DIR = 'templates';
const SNAPSHOT_SUFFIX = '_project_snapshot.json';
const APP_META = {
  version: packageJson.version,
  versionDate: packageJson.versionDate || '2026-07-30'
};
const DEFAULT_PATHS = {
  local: 'C:\\settings\\Project_Printer_ASM\\',
  printer: '\\\\server\\common\\Novozhilov\\',
  aoi: '\\\\server\\common\\Любимова К.И.\\',
  placer: 'C:\\settings\\Placement\\'
};
const USER_SETTINGS_FILE = 'asm-user-settings.json';
const USER_SNAPSHOT_DIR = 'snapshots';
const TEMPLATE_GENERATION_FILES = [
  { templateName: 'template.PR1', outputExtension: '.PR1' },
  { templateName: 'template.ISD', outputExtension: '.ISD' },
  { templateName: 'template.pxf', outputExtension: '.pxf' }
];
const PRINT_DIRECTION_PAIR_SPECS = [
  { pairName: 'pair1', aId: 0x00DF, bId: 0x0310, validate: (value) => value >= 0 && value <= 1000 },
  { pairName: 'pair2', aId: 0x023B, bId: 0x001B, validate: (value) => value >= 0 && value <= 1000 },
  { pairName: 'pair3', aId: 0x0314, bId: 0x00E3, validate: (value) => value >= 0 && value <= 1000 }
];
const PR1_COMMENT_RECORD_PATTERN = Buffer.from([0x10, 0x27, 0x20, 0x00]);
const PR1_COMMENT_MAX_LENGTH = 32;
const TEMPLATE_NUMERIC_FIELD_SPECS = [
  { uiKey: 'boardXInput', id: 0x000B, validate: (value) => value > 0 && value < 2000 },
  { uiKey: 'boardYInput', id: 0x000A, validate: (value) => value > 0 && value < 2000 },
  { uiKey: 'boardThicknessInput', id: 0x000C, validate: (value) => value > 0.05 && value < 20 },
  { uiKey: 'frontPressure', id: 0x0010, validate: (value) => value >= 0 && value <= 50 },
  { uiKey: 'rearPressure', id: 0x0011, validate: (value) => value >= 0 && value <= 50 },
  { uiKey: 'squeegeePasses', id: 0x0015, validate: (value) => value >= 1 && value <= 10 },
  { uiKey: 'frontSqueegeeSpeed', id: 0x01C8, validate: (value) => value >= 0 && value <= 500 },
  { uiKey: 'rearSqueegeeSpeed', id: 0x01C7, validate: (value) => value >= 0 && value <= 500 },
  { uiKey: 'separationRate', id: 0x0013, validate: (value) => value >= 0 && value <= 500 },
  { uiKey: 'separationDistance', id: 0x2715, validate: (value) => value >= 0 && value <= 100 },
  { uiKey: 'pasteStirrings', id: 0x0023, validate: (value) => value >= 0 && value <= 100 },
  { uiKey: 'cleaningFrequency', id: 0x0028, validate: (value) => value >= 1 && value <= 10000 },
  { uiKey: 'mixingPressure', id: 0x766C, validate: (value) => value >= 0 && value <= 50 },
  { uiKey: 'mixingSpeed', id: 0x766D, validate: (value) => value >= 0 && value <= 200 },
  { uiKey: 'ref1x', id: 0x0033, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'ref1y', id: 0x0034, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'ref2x', id: 0x0035, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'ref2y', id: 0x0036, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'ref3x', id: 0x0037, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'ref3y', id: 0x0038, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'centerBoardX0', id: 0x0046, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'stopBoardY', id: 0x0047, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'centerBoardMinus', id: 0x0020, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'centerBoard3', id: 0x0021, validate: (value) => value > -10000 && value < 10000 },
  { uiKey: 'centerBoardCommon', id: 0x193E, validate: (value) => value > -10000 && value < 10000 }
];
const TEMPLATE_TOGGLE_FIELD_SPECS = [
  {
    key: 'refCount',
    id: 0x0032,
    validate: (value) => value === 0 || value === 1,
    mapValue: (value) => (value === 1 ? 3 : 2),
    toTemplateValue: (value) => (Number(value) === 3 ? 1 : 0)
  },
  {
    key: 'boardStopMode',
    id: 0x7613,
    validate: (value) => value === 0 || value === 1,
    mapValue: (value) => value,
    toTemplateValue: (value) => Number(value)
  },
  {
    key: 'boardSide',
    id: 0x765D,
    validate: (value) => value === 0 || value === 1,
    mapValue: (value) => value,
    toTemplateValue: (value) => Number(value)
  }
];
const DEFAULT_USER_SETTINGS = {
  paths: { ...DEFAULT_PATHS },
  showTooltips: true,
  autoUpdate: false,
  theme: 'dark'
};

let mainWindow = null;
let userSettings = { ...DEFAULT_USER_SETTINGS, paths: { ...DEFAULT_PATHS } };

function getUserSettingsPath() {
  return path.join(app.getPath('userData'), USER_SETTINGS_FILE);
}

function getUserSnapshotDir() {
  return path.join(app.getPath('userData'), USER_SNAPSHOT_DIR);
}

function normalizeUserSettings(rawSettings) {
  const incomingPaths = rawSettings && rawSettings.paths ? rawSettings.paths : {};

  return {
    paths: {
      local: String(incomingPaths.local || DEFAULT_PATHS.local),
      printer: String(incomingPaths.printer || DEFAULT_PATHS.printer),
      aoi: String(incomingPaths.aoi || DEFAULT_PATHS.aoi),
      placer: String(incomingPaths.placer || DEFAULT_PATHS.placer)
    },
    showTooltips: rawSettings && typeof rawSettings.showTooltips === 'boolean'
      ? rawSettings.showTooltips
      : DEFAULT_USER_SETTINGS.showTooltips,
    autoUpdate: rawSettings && typeof rawSettings.autoUpdate === 'boolean'
      ? rawSettings.autoUpdate
      : DEFAULT_USER_SETTINGS.autoUpdate,
    theme: rawSettings && typeof rawSettings.theme === 'string'
      ? rawSettings.theme
      : DEFAULT_USER_SETTINGS.theme
  };
}

async function loadUserSettings() {
  try {
    const raw = await fs.readFile(getUserSettingsPath(), 'utf8');
    userSettings = normalizeUserSettings(JSON.parse(raw));
  } catch {
    userSettings = { ...DEFAULT_USER_SETTINGS, paths: { ...DEFAULT_PATHS } };
  }

  return userSettings;
}

async function saveUserSettings(nextSettings) {
  userSettings = normalizeUserSettings({
    ...userSettings,
    ...nextSettings,
    paths: {
      ...userSettings.paths,
      ...(nextSettings && nextSettings.paths ? nextSettings.paths : {})
    }
  });

  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getUserSettingsPath(), JSON.stringify(userSettings, null, 2), 'utf8');
  return userSettings;
}

function getAppDataSnapshotPath(fileName) {
  return path.join(getUserSnapshotDir(), fileName);
}

// Нормализуем путь один раз, чтобы и окно, и операции с файлами работали одинаково.
function normalizeFolderPath(folderPath) {
  return path.resolve(folderPath || 'C:\\settings\\Project_Printer_ASM');
}

function findSppPlacementDataStart(lines) {
  const placementSectionIndex = lines.findIndex((line) => (
    /^\s*@\s*(?:component\s+)?(?:place(?:ment)?|размещени[ея])\b/i.test(line)
  ));

  if (placementSectionIndex >= 0) {
    const placementCountLineIndex = placementSectionIndex + 1;

    // В SPP после @Place идёт служебное количество элементов, которое AOI не использует.
    if (/^\s*\d+\s*$/.test(lines[placementCountLineIndex] || '')) {
      return placementCountLineIndex + 1;
    }

    return placementCountLineIndex;
  }

  const placementHeaderIndex = lines.findIndex((line) => (
    /\b(?:ref(?:erence)?|designator|component|позицион(?:ное)?\s*обозначени[ея])\b/i.test(line)
    && /\b(?:x|y|coord(?:inate)?|координат[аы])\b/i.test(line)
  ));

  if (placementHeaderIndex >= 0) {
    return placementHeaderIndex;
  }

  throw new Error(
    'Не найден блок данных размещения. В файле должна быть секция "@Place" или строка заголовков с обозначением компонента и координатами.'
  );
}

function findSppSolderBoundary(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!/^\s*\*{5,}\s*$/.test(lines[index])) {
      continue;
    }

    const nextContentIndex = lines.findIndex(
      (line, candidateIndex) => candidateIndex > index && line.trim() !== ''
    );

    if (nextContentIndex >= 0 && /^\s*@\s*solder\b/i.test(lines[nextContentIndex])) {
      return index;
    }
  }

  throw new Error(
    'Не найдена граница "@ Solder" после данных размещения. Исходный файл не был изменен.'
  );
}

function createAoiSppContent(sourceContent) {
  const lineEnding = sourceContent.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalLineEnding = sourceContent.endsWith('\r\n') || sourceContent.endsWith('\n');
  const lines = sourceContent.split(/\r?\n/);
  // Границы проверяются до преобразования, чтобы незнакомый формат не дал неполный AOI-файл.
  const placementStart = findSppPlacementDataStart(lines);
  const solderBoundary = findSppSolderBoundary(lines, placementStart);
  const placementContent = lines
    .slice(placementStart, solderBoundary)
    .join(lineEnding)
    .replace(/"/g, '')
    .replace(/;/g, '.');

  return hasFinalLineEnding ? `${placementContent}${lineEnding}` : placementContent;
}

async function createAoiProjectFromSpp(payload) {
  const sourceFolder = normalizeFolderPath(payload && payload.sourceFolder);
  const aoiTargetFolder = normalizeFolderPath(payload && payload.targetFolder);
  const localTargetFolder = normalizeFolderPath(payload && payload.localTargetFolder);
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите файл SPP расстановщика',
    defaultPath: sourceFolder,
    properties: ['openFile'],
    filters: [{ name: 'Файлы расстановщика SPP', extensions: ['spp'] }]
  });

  if (selection.canceled || !selection.filePaths.length) {
    return { canceled: true };
  }

  const sourcePath = selection.filePaths[0];
  if (path.extname(sourcePath).toLowerCase() !== '.spp') {
    throw new Error('Нужно выбрать файл с расширением .spp.');
  }

  const parsedSourcePath = path.parse(sourcePath);
  const sourceContent = await fs.readFile(sourcePath, 'utf8');
  const projectContent = createAoiSppContent(sourceContent);
  const targetFolders = dedupeFolderPaths([aoiTargetFolder, localTargetFolder]);
  const saved = [];

  for (const targetFolder of targetFolders) {
    const originalTargetPath = path.join(targetFolder, parsedSourcePath.base);
    const projectTargetPath = path.join(targetFolder, `${parsedSourcePath.name}_project.spp`);

    await ensureTargetFolder(targetFolder);

    if (path.resolve(sourcePath) !== path.resolve(originalTargetPath)) {
      await fs.copyFile(sourcePath, originalTargetPath);
    }
    await fs.writeFile(projectTargetPath, projectContent, 'utf8');
    saved.push({
      folder: targetFolder,
      originalPath: originalTargetPath,
      projectPath: projectTargetPath
    });
  }

  return {
    canceled: false,
    sourcePath,
    saved
  };
}

function getTemplateAssetsFolder() {
  return app.isPackaged
    ? path.join(process.resourcesPath, TEMPLATE_ASSETS_DIR)
    : path.join(app.getAppPath(), TEMPLATE_ASSETS_DIR);
}

function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('asm:update-event', payload);
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    sendUpdateEvent({
      type: 'available',
      currentVersion: APP_META.version,
      latestVersion: info && info.version ? info.version : '',
      info
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateEvent({
      type: 'not-available',
      currentVersion: APP_META.version,
      latestVersion: info && info.version ? info.version : APP_META.version,
      info
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent({
      type: 'download-progress',
      progress
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent({
      type: 'downloaded',
      currentVersion: APP_META.version,
      latestVersion: info && info.version ? info.version : '',
      info
    });
  });

  autoUpdater.on('error', (error) => {
    sendUpdateEvent({
      type: 'error',
      message: error && error.message ? error.message : 'Не удалось проверить обновления.'
    });
  });
}

async function checkForUpdates(autoDownload = false) {
  if (!app.isPackaged) {
    return {
      currentVersion: APP_META.version,
      latestVersion: APP_META.version,
      updateAvailable: false,
      skipped: true,
      message: 'Проверка обновлений доступна в собранной версии приложения.'
    };
  }

  const updateCheckResult = await autoUpdater.checkForUpdates();
  const updateInfo = updateCheckResult && updateCheckResult.updateInfo ? updateCheckResult.updateInfo : null;
  const latestVersion = updateInfo && updateInfo.version ? String(updateInfo.version) : APP_META.version;
  const updateAvailable = Boolean(updateInfo && updateInfo.version && updateInfo.version !== APP_META.version);

  if (updateAvailable && autoDownload) {
    await autoUpdater.downloadUpdate();
  }

  return {
    currentVersion: APP_META.version,
    latestVersion,
    updateAvailable,
    releaseName: updateInfo && updateInfo.releaseName ? updateInfo.releaseName : '',
    releaseNotes: updateInfo && updateInfo.releaseNotes ? updateInfo.releaseNotes : ''
  };
}

async function inspectFolder(folderPath) {
  const resolvedPath = normalizeFolderPath(folderPath);

  try {
    const stat = await fs.stat(resolvedPath);

    if (!stat.isDirectory()) {
      throw new Error('Указанный путь существует, но это не папка.');
    }

    const dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const fileNames = dirEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'ru'));

    const presentRequiredFiles = REQUIRED_TEMPLATE_FILES.filter((fileName) => fileNames.includes(fileName));
    const missingRequiredFiles = REQUIRED_TEMPLATE_FILES.filter((fileName) => !fileNames.includes(fileName));

    return {
      path: resolvedPath,
      exists: true,
      files: fileNames,
      presentRequiredFiles,
      missingRequiredFiles
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      files: [],
      presentRequiredFiles: [],
      missingRequiredFiles: [...REQUIRED_TEMPLATE_FILES],
      errorCode: error && error.code ? error.code : 'UNKNOWN',
      errorMessage: error && error.message ? error.message : 'Папка недоступна.'
    };
  }
}

function extractProjectNames(fileNames) {
  const projectNames = new Set();

  fileNames.forEach((fileName) => {
    const lowerName = fileName.toLowerCase();

    if (REQUIRED_TEMPLATE_FILES.some((requiredName) => requiredName.toLowerCase() === lowerName)) {
      return;
    }

    if (lowerName.endsWith(SNAPSHOT_SUFFIX)) {
      projectNames.add(fileName.slice(0, -SNAPSHOT_SUFFIX.length));
      return;
    }

    if (/\.(pr1|isd|pxf)$/i.test(fileName) && !/^template\./i.test(fileName)) {
      projectNames.add(fileName.replace(/\.(pr1|isd|pxf)$/i, ''));
    }
  });

  return Array.from(projectNames).sort((left, right) => left.localeCompare(right, 'ru'));
}

async function readKnownMapSummary(folderPath, fileNames) {
  if (!fileNames.includes('pr1_known_map.json')) {
    return {
      exists: false,
      totalEntries: 0,
      namedEntries: 0,
      groupCount: 0
    };
  }

  const knownMapPath = path.join(folderPath, 'pr1_known_map.json');
  const raw = await fs.readFile(knownMapPath, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Object.values(parsed);
  const namedEntries = entries.filter((entry) => entry && String(entry.name || '').trim() !== '').length;
  const groupCount = new Set(
    entries
      .map((entry) => String((entry && entry.group) || '').trim())
      .filter((groupName) => groupName !== '')
  ).size;

  return {
    exists: true,
    totalEntries: entries.length,
    namedEntries,
    groupCount
  };
}

function normalizeProjectFileStem(boardName) {
  const normalized = String(boardName || '').trim().replace(/[<>:"/\\|?*]+/g, '_');
  return normalized;
}

function findNumericCandidates(buffer, id) {
  const pattern = Buffer.from([id & 0xff, id >> 8, 0x08, 0x00]);
  const candidates = [];
  let offset = 0;

  while ((offset = buffer.indexOf(pattern, offset)) !== -1) {
    if (offset + 12 <= buffer.length) {
      const value = buffer.readDoubleLE(offset + 4);

      if (Number.isFinite(value)) {
        candidates.push({ offset, value });
      }
    }

    offset += 1;
  }

  return candidates;
}

function chooseNumericRecord(candidates, validate) {
  const plausible = candidates.find((candidate) => validate(candidate.value));

  if (plausible) {
    return plausible;
  }

  const nonTiny = candidates.find((candidate) => candidate.value === 0 || Math.abs(candidate.value) > 1e-9);
  return nonTiny || candidates[0] || null;
}

function chooseNumericCandidate(candidates, validate) {
  const candidate = chooseNumericRecord(candidates, validate);
  return candidate ? candidate.value : null;
}

function parseNumericInput(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  const normalized = String(rawValue).trim().replace(',', '.');

  if (normalized === '') {
    return null;
  }

  const numericValue = Number(normalized);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function readTemplateComment(buffer) {
  const offset = buffer.indexOf(PR1_COMMENT_RECORD_PATTERN);

  if (offset === -1) {
    return '';
  }

  const raw = buffer.subarray(offset + 4, Math.min(buffer.length, offset + 68));
  return raw.toString('latin1').split('\u0000')[0].trim();
}

function sanitizeCommentValue(commentValue) {
  return String(commentValue || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, PR1_COMMENT_MAX_LENGTH);
}

async function ensureTargetFolder(targetFolder) {
  if (!String(targetFolder || '').trim()) {
    throw new Error('Путь не заполнен.');
  }

  await fs.mkdir(targetFolder, { recursive: true });
  return targetFolder;
}

async function checkFolderWritable(folderPath) {
  const resolvedPath = normalizeFolderPath(folderPath);

  try {
    await fs.access(resolvedPath, fsConstants.W_OK);

    return {
      path: resolvedPath,
      writable: true
    };
  } catch (error) {
    return {
      path: resolvedPath,
      writable: false,
      errorMessage: error && error.message ? error.message : 'Папка недоступна для записи.'
    };
  }
}

function dedupeFolderPaths(folderPaths) {
  const uniquePaths = [];
  const seenPaths = new Set();

  folderPaths.forEach((folderPath) => {
    const normalizedPath = normalizeFolderPath(folderPath);

    if (!seenPaths.has(normalizedPath)) {
      seenPaths.add(normalizedPath);
      uniquePaths.push(normalizedPath);
    }
  });

  return uniquePaths;
}

function getFolderRoleLabel(folderPath, localTargetFolder, printerTargetFolder) {
  if (folderPath === localTargetFolder) {
    return 'Локальная папка';
  }

  if (folderPath === printerTargetFolder) {
    return 'Сетевая папка';
  }

  return 'Дополнительная папка';
}

function hasRequiredTemplates(fileNames) {
  return TEMPLATE_GENERATION_FILES.every((item) => fileNames.includes(item.templateName));
}

async function resolveTemplateSourceFolder(localTargetFolder, printerTargetFolder) {
  // Шаблоны берём из папки приложения, а старые пути оставляем только как запасной вариант для dev-режима.
  const sourceCandidates = dedupeFolderPaths([getTemplateAssetsFolder(), localTargetFolder, printerTargetFolder]);
  const inspectedCandidates = [];

  for (const candidateFolder of sourceCandidates) {
    const folderInfo = await inspectFolder(candidateFolder);
    inspectedCandidates.push(folderInfo);

    if (folderInfo.exists && hasRequiredTemplates(folderInfo.files)) {
      return {
        sourceFolder: candidateFolder,
        inspectedCandidates
      };
    }
  }

  const details = inspectedCandidates.map((item) => {
    const missingTemplates = TEMPLATE_GENERATION_FILES
      .map((template) => template.templateName)
      .filter((templateName) => !item.files.includes(templateName));
    const reason = item.exists
      ? `нет шаблонов: ${missingTemplates.join(', ')}`
      : item.errorMessage || 'папка недоступна';

    return `${item.path} — ${reason}`;
  });

  throw new Error(`Не найден доступный источник шаблонов.\n${details.join('\n')}`);
}

async function buildGeneratedArtifacts(sourceFolder, boardName, formValues) {
  const generatedArtifacts = [];
  let pr1PatchSummary = {
    patchedFields: [],
    skippedFields: []
  };

  for (const templateFile of TEMPLATE_GENERATION_FILES) {
    const sourcePath = path.join(sourceFolder, templateFile.templateName);
    const outputFileName = `${boardName}${templateFile.outputExtension}`;
    const fileBuffer = await fs.readFile(sourcePath);
    let patchSummary = null;

    // Для PR1 правим бинарник в памяти один раз, а потом раскладываем его по доступным адресам.
    if (templateFile.outputExtension === '.PR1') {
      patchSummary = patchPr1FieldValues(fileBuffer, formValues);
      pr1PatchSummary = patchSummary;
    }

    generatedArtifacts.push({
      template: templateFile.templateName,
      fileName: outputFileName,
      content: fileBuffer,
      patchSummary
    });
  }

  return {
    generatedArtifacts,
    pr1PatchSummary
  };
}

function readPrintDirectionTemplateData(buffer) {
  const pairs = PRINT_DIRECTION_PAIR_SPECS.map((pairSpec) => {
    const aRecord = chooseNumericRecord(findNumericCandidates(buffer, pairSpec.aId), pairSpec.validate);
    const bRecord = chooseNumericRecord(findNumericCandidates(buffer, pairSpec.bId), pairSpec.validate);

    return {
      pairName: pairSpec.pairName,
      aId: pairSpec.aId,
      bId: pairSpec.bId,
      aRecord,
      bRecord,
      aValue: aRecord ? aRecord.value : 0,
      bValue: bRecord ? bRecord.value : 0
    };
  });

  const totalA = pairs.reduce((sum, pair) => sum + Math.abs(pair.aValue || 0), 0);
  const totalB = pairs.reduce((sum, pair) => sum + Math.abs(pair.bValue || 0), 0);

  return {
    direction: totalA >= totalB ? 'A' : 'B',
    pairs
  };
}

function patchPrintDirectionSwapGroup(buffer, directionValue) {
  const templateDirection = readPrintDirectionTemplateData(buffer);
  const targetDirection = directionValue === 'A' ? 'A' : 'B';
  const patchedPairs = [];
  const skippedPairs = [];

  templateDirection.pairs.forEach((pair) => {
    if (!pair.aRecord || !pair.bRecord) {
      skippedPairs.push(pair.pairName);
      return;
    }

    const nextAValue = targetDirection === 'A' ? pair.aValue : pair.bValue;
    const nextBValue = targetDirection === 'A' ? pair.bValue : pair.aValue;

    buffer.writeDoubleLE(nextAValue, pair.aRecord.offset + 4);
    buffer.writeDoubleLE(nextBValue, pair.bRecord.offset + 4);
    patchedPairs.push(pair.pairName);
  });

  return {
    patchedPairs,
    skippedPairs,
    direction: targetDirection
  };
}

function patchPr1FieldValues(buffer, formValues) {
  const patchedFields = [];
  const skippedFields = [];

  TEMPLATE_NUMERIC_FIELD_SPECS.forEach((fieldSpec) => {
    const nextValue = parseNumericInput(formValues && formValues[fieldSpec.uiKey]);

    if (nextValue === null) {
      return;
    }

    const record = chooseNumericRecord(findNumericCandidates(buffer, fieldSpec.id), fieldSpec.validate);

    if (!record) {
      skippedFields.push(fieldSpec.uiKey);
      return;
    }

    buffer.writeDoubleLE(nextValue, record.offset + 4);
    patchedFields.push(fieldSpec.uiKey);
  });

  TEMPLATE_TOGGLE_FIELD_SPECS.forEach((fieldSpec) => {
    const templateValue = fieldSpec.toTemplateValue(formValues && formValues[fieldSpec.key]);

    if (!Number.isFinite(templateValue)) {
      return;
    }

    const record = chooseNumericRecord(findNumericCandidates(buffer, fieldSpec.id), fieldSpec.validate);

    if (!record) {
      skippedFields.push(fieldSpec.key);
      return;
    }

    buffer.writeDoubleLE(templateValue, record.offset + 4);
    patchedFields.push(fieldSpec.key);
  });

  if (formValues && Object.prototype.hasOwnProperty.call(formValues, 'comment')) {
    const commentOffset = buffer.indexOf(PR1_COMMENT_RECORD_PATTERN);

    if (commentOffset !== -1) {
      const commentBuffer = Buffer.alloc(PR1_COMMENT_MAX_LENGTH, 0x00);
      commentBuffer.write(sanitizeCommentValue(formValues.comment), 'ascii');
      commentBuffer.copy(buffer, commentOffset + 4);
      patchedFields.push('comment');
    } else {
      skippedFields.push('comment');
    }
  }

  if (formValues && Object.prototype.hasOwnProperty.call(formValues, 'printDirection')) {
    const printDirectionSummary = patchPrintDirectionSwapGroup(buffer, formValues.printDirection);

    if (printDirectionSummary.patchedPairs.length) {
      patchedFields.push('printDirection');
    }

    if (printDirectionSummary.skippedPairs.length) {
      skippedFields.push('printDirection');
    }
  }

  return {
    patchedFields,
    skippedFields
  };
}

async function readTemplateDefaults(folderPath, fileNames) {
  if (!fileNames.includes('template.PR1')) {
    return {
      exists: false,
      values: {},
      toggles: {},
      comment: ''
    };
  }

  const templatePath = path.join(folderPath, 'template.PR1');
  const buffer = await fs.readFile(templatePath);
  const values = {};
  const toggles = {};

  TEMPLATE_NUMERIC_FIELD_SPECS.forEach((fieldSpec) => {
    const value = chooseNumericCandidate(findNumericCandidates(buffer, fieldSpec.id), fieldSpec.validate);

    if (value !== null) {
      values[fieldSpec.uiKey] = String(value);
    }
  });

  TEMPLATE_TOGGLE_FIELD_SPECS.forEach((fieldSpec) => {
    const value = chooseNumericCandidate(findNumericCandidates(buffer, fieldSpec.id), fieldSpec.validate);

    if (value !== null) {
      toggles[fieldSpec.key] = fieldSpec.mapValue(value);
    }
  });

  toggles.printDirection = readPrintDirectionTemplateData(buffer).direction;

  return {
    exists: true,
    values,
    toggles,
    comment: readTemplateComment(buffer)
  };
}

if (ipcMain && typeof ipcMain.handle === 'function') {
  ipcMain.handle('asm:inspect-folder', async (_event, folderPath) => {
    return inspectFolder(folderPath);
  });

  ipcMain.handle('asm:check-folder-writable', async (_event, folderPath) => {
    return checkFolderWritable(folderPath);
  });

  ipcMain.handle('asm:get-app-meta', async () => {
    return APP_META;
  });

  ipcMain.handle('asm:get-user-settings', async () => {
    return loadUserSettings();
  });

  ipcMain.handle('asm:save-user-settings', async (_event, payload) => {
    return saveUserSettings(payload || {});
  });

  ipcMain.handle('asm:check-for-updates', async (_event, payload) => {
    return checkForUpdates(Boolean(payload && payload.autoDownload));
  });

  ipcMain.handle('asm:download-update', async () => {
    if (!app.isPackaged) {
      return {
        skipped: true,
        message: 'Загрузка обновлений доступна только в собранной версии приложения.'
      };
    }

    await autoUpdater.downloadUpdate();
    return {
      started: true
    };
  });

  ipcMain.handle('asm:install-update', async () => {
    if (!app.isPackaged) {
      return {
        skipped: true,
        message: 'Установка обновления доступна только в собранной версии приложения.'
      };
    }

    autoUpdater.quitAndInstall();
    return {
      started: true
    };
  });

  ipcMain.handle('asm:open-folder', async (_event, folderPath) => {
    const resolvedPath = normalizeFolderPath(folderPath);
    const result = await shell.openPath(resolvedPath);

    if (result) {
      throw new Error(result);
    }

    return { path: resolvedPath, opened: true };
  });

  ipcMain.handle('asm:save-project-json', async (_event, payload) => {
    // Snapshot предназначен только для локальной папки, чтобы не размножать служебный JSON на принтере.
    const targetFolders = dedupeFolderPaths([payload && payload.targetFolder]);
    const boardName = String((payload && payload.boardName) || 'project').trim() || 'project';
    const safeBoardName = boardName.replace(/[<>:"/\\|?*]+/g, '_');
    const fileName = `${safeBoardName}_project_snapshot.json`;
    const saved = [];
    const failed = [];
    const content = JSON.stringify(payload, null, 2);

    for (const targetFolder of targetFolders) {
      const targetPath = path.join(targetFolder, fileName);

      try {
        // Каждую папку проверяем отдельно, чтобы недоступный адрес не ломал сохранение в рабочий адрес.
        await fs.mkdir(targetFolder, { recursive: true });
        await fs.writeFile(targetPath, content, 'utf8');
        saved.push({
          folder: targetFolder,
          path: targetPath
        });
      } catch (error) {
        failed.push({
          folder: targetFolder,
          errorMessage: error && error.message ? error.message : 'Не удалось сохранить JSON.'
        });
      }
    }

    try {
      // Дублируем снимок в AppData, чтобы пользовательские данные не лежали рядом с программой.
      const snapshotDir = getUserSnapshotDir();
      const snapshotPath = getAppDataSnapshotPath(fileName);
      await fs.mkdir(snapshotDir, { recursive: true });
      await fs.writeFile(snapshotPath, content, 'utf8');
    } catch (error) {
      failed.push({
        folder: getUserSnapshotDir(),
        errorMessage: error && error.message ? error.message : 'Не удалось сохранить JSON в AppData.'
      });
    }

    if (!saved.length) {
      throw new Error(
        `Не удалось сохранить JSON ни в одну папку.\n${failed.map((item) => `${item.folder} — ${item.errorMessage}`).join('\n')}`
      );
    }

    return {
      path: saved[0].path,
      fileName,
      saved,
      failed
    };
  });

  ipcMain.handle('asm:save-aoi-file', async (_event, payload) => {
    const targetFolder = normalizeFolderPath(payload && payload.targetFolder);
    const boardName = normalizeProjectFileStem(payload && payload.boardName);
    const content = String((payload && payload.content) || '');

    if (!boardName) {
      throw new Error('Нужно заполнить поле "Название платы".');
    }

    await ensureTargetFolder(targetFolder);

    const fileName = `${boardName}.txt`;
    const targetPath = path.join(targetFolder, fileName);
    await fs.writeFile(targetPath, content, 'utf8');

    return {
      fileName,
      path: targetPath
    };
  });

  ipcMain.handle('asm:create-aoi-project-from-spp', async (_event, payload) => {
    return createAoiProjectFromSpp(payload || {});
  });

  ipcMain.handle('asm:load-workspace-data', async (_event, folderPath) => {
    const folder = await inspectFolder(folderPath);
    const projectNames = extractProjectNames(folder.files);
    const templateFolder = await inspectFolder(getTemplateAssetsFolder());
    const knownMapSummary = templateFolder.exists
      ? await readKnownMapSummary(templateFolder.path, templateFolder.files)
      : {
          exists: false,
          totalEntries: 0,
          namedEntries: 0,
          groupCount: 0
        };
    const templateDefaults = templateFolder.exists
      ? await readTemplateDefaults(templateFolder.path, templateFolder.files)
      : {
          exists: false,
          values: {},
          toggles: {},
          comment: ''
        };

    return {
      folder,
      projectNames,
      knownMapSummary,
      templateDefaults,
      templateFolder
    };
  });

  ipcMain.handle('asm:generate-project-files', async (_event, payload) => {
    const targetFolder = normalizeFolderPath(payload && payload.targetFolder);
    const printerTargetFolder = normalizeFolderPath(payload && payload.printerTargetFolder);
    const boardName = normalizeProjectFileStem(payload && payload.boardName);
    const formValues = (payload && payload.formValues) || {};

    if (!boardName) {
      throw new Error('Нужно заполнить поле "Название платы".');
    }

    const sourceResolution = await resolveTemplateSourceFolder(targetFolder, printerTargetFolder);
    const destinationFolders = dedupeFolderPaths([targetFolder, printerTargetFolder]);
    const { generatedArtifacts, pr1PatchSummary } = await buildGeneratedArtifacts(
      sourceResolution.sourceFolder,
      boardName,
      formValues
    );
    const saveReports = [];

    for (const destinationFolder of destinationFolders) {
      const savedFiles = [];

      try {
        await ensureTargetFolder(destinationFolder);

        for (const artifact of generatedArtifacts) {
          const targetPath = path.join(destinationFolder, artifact.fileName);
          await fs.writeFile(targetPath, artifact.content);
          savedFiles.push({
            template: artifact.template,
            fileName: artifact.fileName,
            path: targetPath,
            patchSummary: artifact.patchSummary
          });
        }

        saveReports.push({
          folder: destinationFolder,
          label: getFolderRoleLabel(destinationFolder, targetFolder, printerTargetFolder),
          status: 'saved',
          files: savedFiles
        });
      } catch (error) {
        saveReports.push({
          folder: destinationFolder,
          label: getFolderRoleLabel(destinationFolder, targetFolder, printerTargetFolder),
          status: 'failed',
          files: [],
          errorMessage: error && error.message ? error.message : 'Не удалось сохранить файлы проекта.'
        });
      }
    }

    if (!saveReports.some((item) => item.status === 'saved')) {
      throw new Error(
        `Не удалось сохранить файлы проекта ни в одну папку.\n${saveReports
          .map((item) => `${item.label}: ${item.folder} — ${item.errorMessage || 'неизвестная ошибка'}`)
          .join('\n')}`
      );
    }

    return {
      sourceFolder: sourceResolution.sourceFolder,
      targetFolder,
      printerTargetFolder,
      boardName,
      generatedFiles: saveReports.flatMap((item) => item.files),
      saveReports,
      pr1PatchSummary
    };
  });
}

// Создаем главное окно и загружаем в него текущую HTML-страницу формы.
function createWindow() {
  const windowRef = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1080,
    minHeight: 800,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'asm-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = windowRef;
  mainWindow.loadFile(path.join(__dirname, 'asm_generator_form_v9.html'));
  mainWindow.on('closed', () => {
    if (mainWindow === windowRef) {
      mainWindow = null;
    }
  });
}

if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    configureAutoUpdater();
    loadUserSettings().finally(() => {
      createWindow();
      if (mainWindow) {
        mainWindow.webContents.once('did-finish-load', () => {
          if (userSettings.autoUpdate) {
            checkForUpdates(true).catch((error) => {
              sendUpdateEvent({
                type: 'error',
                message: error && error.message ? error.message : 'Не удалось проверить обновления.'
              });
            });
          }
        });
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

module.exports = {
  findNumericCandidates,
  chooseNumericRecord,
  readTemplateComment,
  patchPr1FieldValues,
  sanitizeCommentValue,
  ensureTargetFolder
};
