/**
 * Описание: Минимальный конвейер Pick and Place 3.1.0 для словаря Dict/.
 * Версия: 3.1.1
 * Автор: Новожилов Артем
 */

const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_DICT_FILE = 'pnp_dict_v300.js';
const DEFAULT_STATE_FILE = 'pnp_state_v300.js';
const DEFAULT_EXPORT_STEM = 'pnp_export_v300';
const DEFAULT_IMPORT_START_DIR = 'C:\\settings\\Pick Place\\Test\\';

function createEmptyDict(sourceMeta = {}) {
  return {
    description: 'Корневой словарь P&P',
    version: '3.1.0',
    author: 'Новожилов Артем',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
      sourcePath: String(sourceMeta.sourcePath || ''),
      sourceFile: String(sourceMeta.sourceFile || ''),
      mode: String(sourceMeta.mode || 'dict')
    },
    rows: []
  };
}

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function normalizeHeaderName(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '');
}

function detectDelimiter(headerLine) {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;

  return semicolons >= commas ? ';' : ',';
}

function decodeSourceBuffer(buffer) {
  const utf8Text = buffer.toString('utf8');
  let cp1251Text = utf8Text;

  try {
    cp1251Text = new TextDecoder('windows-1251').decode(buffer);
  } catch {
    cp1251Text = utf8Text;
  }

  const scoreText = (text) => {
    const cyrillicMatches = text.match(/[А-Яа-яЁё]/g);
    const questionMarks = (text.match(/\uFFFD/g) || []).length;
    const centerScore = /Center-X\(mm\)|Center-Y\(mm\)|CENTER-X|CENTER-Y/i.test(text) ? 10 : 0;

    return (cyrillicMatches ? cyrillicMatches.length : 0) + centerScore - (questionMarks * 5);
  };

  return scoreText(cp1251Text) > scoreText(utf8Text) ? cp1251Text : utf8Text;
}

function deriveImportBaseName(filePath) {
  const fileName = path.basename(String(filePath || ''));
  let baseName = fileName.replace(path.extname(fileName), '');

  if (baseName.startsWith('Pick Place for ')) {
    baseName = baseName.slice('Pick Place for '.length);
  }

  return baseName;
}

function normalizeCsvHeaderForImport(value) {
  return normalizeHeaderName(value).replace(/[\s_-]+/g, '');
}

function findImportCenterColumnIndexes(headers) {
  const normalizedHeaders = headers.map(normalizeCsvHeaderForImport);
  let centerX = -1;
  let centerY = -1;

  normalizedHeaders.forEach((header, index) => {
    if (header === 'centerxmm' || header === 'centerx') {
      centerX = index;
    }
    if (header === 'centerymm' || header === 'centery') {
      centerY = index;
    }
  });

  return {
    centerX,
    centerY
  };
}

function getCsvCellAtLine(sourceText, lineNumber, cellIndex = 0) {
  const normalizedText = String(sourceText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const rawLines = normalizedText.split('\n');
  const targetLine = rawLines[lineNumber - 1];

  if (typeof targetLine !== 'string' || targetLine.trim() === '') {
    return '';
  }

  const delimiter = detectDelimiter(rawLines.find((line) => String(line || '').trim() !== '') || '');
  const cells = parseDelimitedLine(targetLine, delimiter);
  return normalizeText(cells[cellIndex]);
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += char;
  }

  cells.push(cell.trim());
  return cells;
}

function toNumberText(rawValue) {
  const normalized = normalizeText(rawValue).replace(',', '.');

  if (!normalized) {
    return '';
  }

  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) {
    return '';
  }

  const rounded = Math.round(numericValue * 1000) / 1000;
  return String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function normalizeRotationValue(rawValue) {
  const numericValue = Number(normalizeText(rawValue).replace(',', '.'));

  if (!Number.isFinite(numericValue)) {
    return '0';
  }

  let angle = numericValue % 360;
  if (angle < 0) {
    angle += 360;
  }

  return toNumberText(angle);
}

function normalizeSideValue(rawValue) {
  const text = normalizeText(rawValue).toLowerCase();

  if (!text) {
    return 'Top';
  }

  if (/(bottom|bottomside|bot|низ|b)/i.test(text)) {
    return 'Bottom';
  }

  return 'Top';
}

function normalizeStringValue(rawValue) {
  return normalizeText(rawValue);
}

function readCsvHeadersAndRows(sourceText) {
  const normalizedText = String(sourceText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalizedText.split('\n').filter((line, index) => index === 0 || line.trim() !== '');

  if (!lines.length) {
    return {
      delimiter: ';',
      headers: [],
      rows: []
    };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeHeaderName);
  const rows = lines.slice(1).map((line) => parseDelimitedLine(line, delimiter)).filter((cells) => cells.some((cell) => normalizeText(cell) !== ''));

  return {
    delimiter,
    headers,
    rows
  };
}

function readImportedCsvTable(sourceText, skippedRows = 12) {
  const normalizedText = String(sourceText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalizedText.split('\n');
  const remainingLines = lines.slice(skippedRows).filter((line) => normalizeText(line) !== '');

  if (!remainingLines.length) {
    return {
      delimiter: ';',
      rawHeaders: [],
      headers: [],
      rows: []
    };
  }

  const delimiter = detectDelimiter(remainingLines[0]);
  const rawHeaders = parseDelimitedLine(remainingLines[0], delimiter);
  const headers = rawHeaders.map(normalizeHeaderName);
  const rows = remainingLines.slice(1).map((line) => parseDelimitedLine(line, delimiter)).filter((cells) => cells.some((cell) => normalizeText(cell) !== ''));

  return {
    delimiter,
    rawHeaders,
    headers,
    rows
  };
}

function parseImportedCsv(sourceText, sourceMeta = {}) {
  const parsed = readImportedCsvTable(sourceText, 12);
  const columnMap = buildColumnMap(parsed.headers);

  return {
    description: 'Импортированный CSV P&P',
    version: '3.1.0',
    author: 'Новожилов Артем',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
      sourcePath: String(sourceMeta.sourcePath || ''),
      sourceFile: String(sourceMeta.sourceFile || ''),
      mode: String(sourceMeta.mode || 'csv')
    },
    rows: parsed.rows.map((cells, index) => ({
      rowIndex: index + 1,
      sourceDesignator: getCellValue(cells, columnMap.designator),
      designator: getCellValue(cells, columnMap.designator),
      footprint: getCellValue(cells, columnMap.footprint),
      x: toNumberText(getCellValue(cells, columnMap.x)),
      y: toNumberText(getCellValue(cells, columnMap.y)),
      rotation: normalizeRotationValue(getCellValue(cells, columnMap.rotation)),
      side: normalizeSideValue(getCellValue(cells, columnMap.side)),
      comment: normalizeStringValue(getCellValue(cells, columnMap.comment))
    })),
    importInfo: {
      rawTable: parsed,
      headers: parsed.rawHeaders,
      delimiter: parsed.delimiter,
      rowCount: parsed.rows.length
    }
  };
}

function getColumnIndex(headers, aliases, fallbackIndex) {
  for (let index = 0; index < headers.length; index += 1) {
    if (aliases.includes(headers[index])) {
      return index;
    }
  }

  return Number.isInteger(fallbackIndex) ? fallbackIndex : -1;
}

function buildColumnMap(headers) {
  const normalizedHeaders = headers.map(normalizeHeaderName);
  const hasHeaderMatches = normalizedHeaders.some((header) => header !== '');

  if (!hasHeaderMatches) {
    return {
      designator: 0,
      footprint: 1,
      x: 2,
      y: 3,
      rotation: 4,
      side: 5,
      comment: 6
    };
  }

  return {
    designator: getColumnIndex(normalizedHeaders, ['designator', 'refdes', 'ref', 'обозначение', 'позиция'], 0),
    footprint: getColumnIndex(normalizedHeaders, ['footprint', 'package', 'component', 'part', 'корпус'], 1),
    x: getColumnIndex(normalizedHeaders, ['x', 'posx', 'centerx', 'xmm'], 2),
    y: getColumnIndex(normalizedHeaders, ['y', 'posy', 'centery', 'ymm'], 3),
    rotation: getColumnIndex(normalizedHeaders, ['rotation', 'rot', 'angle', 'угол'], 4),
    side: getColumnIndex(normalizedHeaders, ['side', 'layer', 'montageside', 'слой'], 5),
    comment: getColumnIndex(normalizedHeaders, ['comment', 'value', 'note', 'примечание'], 6)
  };
}

function getCellValue(cells, index) {
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
    return '';
  }

  return normalizeText(cells[index]);
}

function parseCsv(sourceText, sourceMeta = {}) {
  const parsed = readCsvHeadersAndRows(sourceText);
  const columnMap = buildColumnMap(parsed.headers);

  return {
    description: 'Импортированный словарь P&P',
    version: '3.1.0',
    author: 'Новожилов Артем',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
      sourcePath: String(sourceMeta.sourcePath || ''),
      sourceFile: String(sourceMeta.sourceFile || ''),
      mode: String(sourceMeta.mode || 'csv')
    },
    rows: parsed.rows.map((cells, index) => ({
      rowIndex: index + 1,
      sourceDesignator: getCellValue(cells, columnMap.designator),
      designator: getCellValue(cells, columnMap.designator),
      footprint: getCellValue(cells, columnMap.footprint),
      x: toNumberText(getCellValue(cells, columnMap.x)),
      y: toNumberText(getCellValue(cells, columnMap.y)),
      rotation: normalizeRotationValue(getCellValue(cells, columnMap.rotation)),
      side: normalizeSideValue(getCellValue(cells, columnMap.side)),
      comment: normalizeStringValue(getCellValue(cells, columnMap.comment))
    }))
  };
}

function normalizeDict(dictLike, sourceMeta = {}) {
  const sourceRows = Array.isArray(dictLike)
    ? dictLike
    : Array.isArray(dictLike && dictLike.rows)
      ? dictLike.rows
      : [];
  const meta = dictLike && dictLike.meta ? dictLike.meta : {};

  return {
    description: String((dictLike && dictLike.description) || 'Корневой словарь P&P'),
    version: String((dictLike && dictLike.version) || '3.1.0'),
    author: String((dictLike && dictLike.author) || 'Новожилов Артем'),
    createdAt: String((dictLike && dictLike.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    meta: {
      sourcePath: String(sourceMeta.sourcePath || meta.sourcePath || ''),
      sourceFile: String(sourceMeta.sourceFile || meta.sourceFile || ''),
      mode: String(sourceMeta.mode || meta.mode || 'dict')
    },
    rows: sourceRows.map((row, index) => ({
      rowIndex: Number.isFinite(Number(row && row.rowIndex)) ? Number(row.rowIndex) : index + 1,
      sourceDesignator: normalizeStringValue(row && (row.sourceDesignator || row.designator)),
      designator: normalizeStringValue(row && (row.designator || row.sourceDesignator)) || `PNP${String(index + 1).padStart(3, '0')}`,
      footprint: normalizeStringValue(row && row.footprint),
      x: toNumberText(row && row.x),
      y: toNumberText(row && row.y),
      rotation: normalizeRotationValue(row && row.rotation),
      side: normalizeSideValue(row && row.side),
      comment: normalizeStringValue(row && row.comment)
    }))
  };
}

function renameDict(dictLike) {
  const dict = normalizeDict(dictLike);
  const usedNames = new Map();

  return {
    ...dict,
    rows: dict.rows.map((row) => {
      const baseName = normalizeStringValue(row.designator) || row.sourceDesignator || 'PNP';
      const nextCount = (usedNames.get(baseName) || 0) + 1;
      usedNames.set(baseName, nextCount);
      const nextDesignator = nextCount === 1 ? baseName : `${baseName}_${nextCount}`;

      return {
        ...row,
        baseDesignator: baseName,
        designator: nextDesignator,
        renamed: nextDesignator !== baseName
      };
    })
  };
}

function rotationDict(dictLike) {
  const sourceRows = Array.isArray(dictLike && dictLike.rows) ? dictLike.rows : [];

  return {
    ...dictLike,
    rows: sourceRows.map((row) => {
      const baseRotation = Number(row.rotation);
      const nextRotation = Number.isFinite(baseRotation) ? baseRotation : 0;
      // Нижнюю сторону больше не поворачиваем автоматически — сохраняем исходный угол как есть.
      let normalizedRotation = nextRotation % 360;

      if (normalizedRotation < 0) {
        normalizedRotation += 360;
      }

      return {
        ...row,
        rotation: toNumberText(normalizedRotation),
        sourceRotation: toNumberText(nextRotation),
        rotationOffset: 0
      };
    })
  };
}

function prepareDict(dictLike, sourceMeta = {}) {
  const normalized = normalizeDict(dictLike, sourceMeta);
  const renamed = renameDict(normalized);
  const rotated = rotationDict(renamed);

  return {
    ...rotated,
    stats: getStats(rotated)
  };
}

function getStats(dictLike) {
  const rows = Array.isArray(dictLike && dictLike.rows) ? dictLike.rows : [];
  const renamedRows = rows.filter((row) => normalizeStringValue(row.sourceDesignator) !== normalizeStringValue(row.designator)).length;
  const bottomRows = rows.filter((row) => row.side === 'Bottom').length;
  const topRows = rows.length - bottomRows;
  const rotatedRows = rows.filter((row) => Number(row.rotationOffset) === 180).length;
  const commentedRows = rows.filter((row) => normalizeStringValue(row.comment) !== '').length;

  return {
    totalRows: rows.length,
    topRows,
    bottomRows,
    rotatedRows,
    renamedRows,
    commentedRows
  };
}

function escapeCsvCell(value) {
  const text = normalizeText(value);

  if (text === '') {
    return '';
  }

  if (/[;"\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildCsv(dictLike) {
  const dict = normalizeDict(dictLike);
  const header = ['Designator', 'Footprint', 'X', 'Y', 'Rotation', 'Side', 'Comment'];
  const lines = [header.join(';')];

  dict.rows.forEach((row) => {
    lines.push([
      escapeCsvCell(row.designator),
      escapeCsvCell(row.footprint),
      escapeCsvCell(row.x),
      escapeCsvCell(row.y),
      escapeCsvCell(row.rotation),
      escapeCsvCell(row.side),
      escapeCsvCell(row.comment)
    ].join(';'));
  });

  return lines.join('\r\n');
}

function buildPreviewHtml(dictLike) {
  const dict = normalizeDict(dictLike);
  const stats = getStats(dict);
  const previewRows = dict.rows.slice(0, 500).map((row) => `
      <tr>
        <td>${escapeHtml(row.designator)}</td>
        <td>${escapeHtml(row.footprint)}</td>
        <td>${escapeHtml(row.x)}</td>
        <td>${escapeHtml(row.y)}</td>
        <td>${escapeHtml(row.rotation)}</td>
        <td>${escapeHtml(row.side)}</td>
        <td>${escapeHtml(row.comment)}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Pick and Place 3.1.0 Preview</title>
<style>
  body{font-family:Inter,sans-serif;background:#0A0E18;color:#F2F5FA;margin:0;padding:24px}
  .card{background:#121A2C;border:1px solid rgba(148,178,220,.14);border-radius:14px;padding:16px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid rgba(148,178,220,.14);padding:8px;text-align:left;vertical-align:top}
  th{color:#95A2B8;text-transform:uppercase;letter-spacing:.08em;font-size:11px}
</style>
</head>
<body>
  <div class="card">
    <h1>Pick and Place 3.1.0</h1>
    <div>Всего: ${stats.totalRows} | Top: ${stats.topRows} | Bottom: ${stats.bottomRows} | Переименовано: ${stats.renamedRows}</div>
  </div>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Designator</th>
          <th>Footprint</th>
          <th>X</th>
          <th>Y</th>
          <th>Rotation</th>
          <th>Side</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>${previewRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return normalizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildModuleSource(value, description) {
  const header = [
    '/**',
    ` * Описание: ${description}`,
    ' * Версия: 3.1.0',
    ' * Автор: Новожилов Артем',
    ' */',
    ''
  ].join('\n');

  return `${header}module.exports = ${JSON.stringify(value, null, 2)};\n`;
}

async function loadModuleExport(filePath) {
  const resolvedPath = path.resolve(filePath);

  try {
    const moduleId = require.resolve(resolvedPath);
    delete require.cache[moduleId];
    return require(moduleId);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      return null;
    }

    throw error;
  }
}

async function loadDictFile(filePath) {
  const loaded = await loadModuleExport(filePath);

  if (!loaded) {
    return createEmptyDict({
      sourcePath: filePath,
      sourceFile: path.basename(filePath || DEFAULT_DICT_FILE),
      mode: 'dict'
    });
  }

  return prepareDict(loaded, {
    sourcePath: filePath,
    sourceFile: path.basename(filePath || DEFAULT_DICT_FILE),
    mode: 'dict'
  });
}

async function loadStateFile(filePath) {
  const loaded = await loadModuleExport(filePath);

  if (!loaded) {
    return null;
  }

  return loaded;
}

async function saveModuleFile(filePath, dictLike, description) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buildModuleSource(dictLike, description), 'utf8');

  return {
    path: filePath,
    dict: prepareDict(dictLike, {
      sourcePath: filePath,
      sourceFile: path.basename(filePath),
      mode: 'saved'
    })
  };
}

async function saveDictFile(filePath, dictLike) {
  return saveModuleFile(filePath, dictLike, 'Корневой словарь P&P');
}

async function saveStateFile(filePath, dictLike) {
  return saveModuleFile(filePath, dictLike, 'Состояние P&P');
}

async function importCsvFile(filePath) {
  const sourceBuffer = await fs.readFile(filePath);
  const sourceText = decodeSourceBuffer(sourceBuffer);
  const parsed = readImportedCsvTable(sourceText, 12);
  const centerColumns = findImportCenterColumnIndexes(parsed.headers);

  if (centerColumns.centerX < 0 || centerColumns.centerY < 0) {
    const headersList = parsed.headers.join(' | ');
    throw new Error(`В CSV не найдены Center-X(mm) и Center-Y(mm). Текущий набор заголовков: ${headersList}`);
  }

  const imported = parseImportedCsv(sourceText, {
    sourcePath: filePath,
    sourceFile: path.basename(filePath)
  });
  const dict = prepareDict(imported, {
    sourcePath: filePath,
    sourceFile: path.basename(filePath),
    mode: 'csv'
  });

  const baseName = deriveImportBaseName(filePath);

  return {
    ...dict,
    importInfo: {
      ...imported.importInfo,
      sourcePath: filePath,
      sourceFile: path.basename(filePath),
      baseName,
      workbookName: `${baseName}.xlsx`,
      infoSheetName: 'Info',
      infoD5: getCsvCellAtLine(sourceText, 10, 0),
      infoD6: filePath,
      importedTableName: 'ImportedCSVTable',
      deletedHeaderRows: 12,
      commentColumn: 3,
      footprintColumn: 5,
      textNumberFormatColumns: [2, 3, 5, 6, 7],
      sheetNames: ['Info', 'ImportedCSVTable', 'DataSet', 'DataSet2', 'Resist', 'Capacitor', 'Other', 'DataPredExit', 'DataExit'],
      activeSheet: 'ImportedCSVTable',
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      centerXColumnIndex: centerColumns.centerX,
      centerYColumnIndex: centerColumns.centerY,
      headers: parsed.rawHeaders
    }
  };
}

async function exportFiles(dictLike, targetFolder, options = {}) {
  const prepared = prepareDict(dictLike, {
    sourcePath: options.sourcePath || '',
    sourceFile: options.sourceFile || '',
    mode: 'export'
  });
  const exportStem = String(options.exportStem || DEFAULT_EXPORT_STEM);
  const exportDictPath = path.join(targetFolder, `${exportStem}.js`);
  const exportCsvPath = path.join(targetFolder, `${exportStem}.csv`);
  const exportHtmlPath = path.join(targetFolder, `${exportStem}.html`);

  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(exportDictPath, buildModuleSource(prepared, 'Экспортированный словарь P&P'), 'utf8');
  await fs.writeFile(exportCsvPath, buildCsv(prepared), 'utf8');
  await fs.writeFile(exportHtmlPath, buildPreviewHtml(prepared), 'utf8');

  return {
    targetFolder,
    stats: getStats(prepared),
    files: [
      { fileName: path.basename(exportDictPath), path: exportDictPath, kind: 'dict' },
      { fileName: path.basename(exportCsvPath), path: exportCsvPath, kind: 'csv' },
      { fileName: path.basename(exportHtmlPath), path: exportHtmlPath, kind: 'html' }
    ],
    dict: prepared
  };
}

module.exports = {
  DEFAULT_DICT_FILE,
  DEFAULT_STATE_FILE,
  DEFAULT_EXPORT_STEM,
  createEmptyDict,
  parseCsv,
  normalizeDict,
  renameDict,
  rotationDict,
  prepareDict,
  getStats,
  buildCsv,
  buildPreviewHtml,
  buildModuleSource,
  DEFAULT_IMPORT_START_DIR,
  decodeSourceBuffer,
  loadDictFile,
  loadStateFile,
  saveDictFile,
  saveStateFile,
  importCsvFile,
  exportFiles
};
