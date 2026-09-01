/**
 * Описание: Минимальный конвейер Pick and Place 3.6.4 для словаря Dict/.
 * Версия: 3.6.4
 * Автор: Новожилов Артем
 * Изменения 3.6.4: сохранены исправления парсера XLSX (parseWorksheetXmlRows) —
 * самозакрывающиеся пустые ячейки <c r="F1" s="1"/> раньше "проглатывали"
 * значение следующей ячейки (лениво искали ближайший </c>, которым
 * оказывался закрывающий тег соседней ячейки). Из-за этого терялись
 * значения COMMENT_FR/ROTATION_DELTA и других колонок в словарях
 * Resist/Capacitor/Other, если перед ними была пустая ячейка
 * (пример: AM1LS-0505SH30-NZ — угол не пересчитывался, т.к. COMMENT_FR
 * читался как пустой из-за пустой ячейки "Столбец2" перед ним).
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const unzipper = require('unzipper');
const packageJson = require('./package.json');

const DEFAULT_DICT_FILE = 'pnp_dict_v300.js';
const DEFAULT_STATE_FILE = 'pnp_state_v300.js';
const DEFAULT_EXPORT_STEM = 'pnp_export_v300';
const DEFAULT_IMPORT_START_DIR = 'C:\\settings\\Pick Place\\Test\\';
// Источник версии один: пакетный манифест, чтобы экспорт и подписи не расходились.
const APP_VERSION = String(packageJson && packageJson.version ? packageJson.version : '3.6.4');
const INFO_LEGEND_ROWS = [
  { row: 10, fillStyleIndex: 4, text: 'Данные, которые заменились из словаря.' },
  { row: 11, fillStyleIndex: 5, text: 'Данные, которые совпали в словаре, но не по всем ячейкам. Требуется проверить, смотри еще красный цвет.' },
  { row: 12, fillStyleIndex: 6, text: 'Данные, которые не совпадают с данными в словаре.' },
  { row: 13, fillStyleIndex: 7, text: 'В столбце COMMENT есть русские буквы.' },
  { row: 14, fillStyleIndex: 8, text: 'Были замены COMMENT на R_COMMENT, DESIGNATOR на R_DESIGNATOR или TOL на R_TOL если в SET попали R.' },
  { row: 15, fillStyleIndex: 9, text: 'Значений в SET не было и по решению пользователя они заполнились 1.' }
];

function createEmptyDict(sourceMeta = {}) {
  return {
    description: 'Корневой словарь P&P',
    version: APP_VERSION,
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

function normalizeDecimalText(value) {
  return normalizeText(value).replace(',', '.');
}

function parseLooseNumericValue(value) {
  const text = normalizeDecimalText(value);
  const match = text.match(/[-+]?\d+(?:\.\d+)?/);

  return match ? Number(match[0]) : NaN;
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

function formatDateStamp(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}${month}${day}`;
}

function sanitizeVariantStemPart(value) {
  return normalizeText(value)
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBaseCodeFromText(inputText) {
  const text = sanitizeVariantStemPart(inputText);
  const posNSFT = text.indexOf('НСФТ');

  if (posNSFT < 0) {
    return '';
  }

  const afterNSFT = text.slice(posNSFT + 4).replace(/^\s+/, '');
  let extractedPart = '';

  for (let index = 0; index < afterNSFT.length; index += 1) {
    const char = afterNSFT[index];

    if (/[0-9.]/.test(char)) {
      extractedPart += char;
      if (extractedPart.length >= 10) {
        break;
      }
    } else {
      break;
    }
  }

  return extractedPart ? `НСФТ ${extractedPart}`.trim() : '';
}

function extractDateFromText(inputText) {
  const text = sanitizeVariantStemPart(inputText);

  if (text.length < 8) {
    return '';
  }

  const rightPart = text.slice(-8);
  if (/^\d{8}$/.test(rightPart)) {
    return rightPart;
  }

  let datePart = '';
  let digitCount = 0;

  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (/[0-9]/.test(char)) {
      datePart = char + datePart;
      digitCount += 1;
      if (digitCount === 8) {
        break;
      }
    } else if (digitCount > 0 && digitCount < 8) {
      datePart = '';
      digitCount = 0;
    }
  }

  return digitCount === 8 ? datePart : '';
}

function determineLayerSuffix(importInfo) {
  const table = importInfo && importInfo.dataOtherTable ? importInfo.dataOtherTable : importInfo;
  const rawHeaders = table && Array.isArray(table.rawHeaders) ? table.rawHeaders : [];
  const rows = table && Array.isArray(table.rows) ? table.rows : [];
  let colLayer = -1;
  let colDesignator = -1;

  for (let index = 0; index < rawHeaders.length; index += 1) {
    const headerValue = String(rawHeaders[index] || '').trim().toUpperCase();
    if (headerValue === 'LAYER') {
      colLayer = index;
    } else if (headerValue === 'DESIGNATOR') {
      colDesignator = index;
    }

    if (colLayer >= 0 && colDesignator >= 0) {
      break;
    }
  }

  if (colLayer < 0 || colDesignator < 0) {
    return '';
  }

  let hasTopLayer = false;
  let hasBottomLayer = false;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const designatorValue = String(row && row[colDesignator] !== undefined && row[colDesignator] !== null ? row[colDesignator] : '').trim().toUpperCase();

    if (designatorValue.indexOf('REF') === 0) {
      continue;
    }

    const layerValue = String(row && row[colLayer] !== undefined && row[colLayer] !== null ? row[colLayer] : '').trim().toUpperCase();
    if (layerValue === '') {
      continue;
    }

    if (layerValue === 'TOPLAYER' || layerValue === 'TOP' || layerValue === 'TOP LAYER') {
      hasTopLayer = true;
    } else if (layerValue === 'BOTTOMLAYER' || layerValue === 'BOTTOM' || layerValue === 'BOTTOM LAYER' || layerValue === 'BOT') {
      hasBottomLayer = true;
    }

    if (hasTopLayer && hasBottomLayer) {
      break;
    }
  }

  if (hasTopLayer && hasBottomLayer) {
    return '_R_';
  }
  if (hasTopLayer) {
    return '_T_';
  }
  if (hasBottomLayer) {
    return '_B_';
  }

  return '';
}

function generateFileNameFromVariant(infoD5, infoD6 = '', infoD3 = '', importInfo = null, fallbackStem = DEFAULT_EXPORT_STEM) {
  const variantText = sanitizeVariantStemPart(infoD5);
  const csvFileName = path.basename(String(infoD6 || '')).replace(path.extname(String(infoD6 || '')), '');
  const executionToken = Number(infoD3) > 0 ? `-0${String(Number(infoD3))}` : '';
  const layerSuffix = determineLayerSuffix(importInfo);
  const baseCode = variantText ? extractBaseCodeFromText(variantText) : (csvFileName ? extractBaseCodeFromText(csvFileName) || csvFileName : '');
  const dateToken = variantText ? extractDateFromText(variantText) : extractDateFromText(csvFileName);

  if (!baseCode) {
    return fallbackStem;
  }

  return `${baseCode}${executionToken}${layerSuffix}(${dateToken})`.replace(/[<>:"/\\|?*]+/g, '_');
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
  const normalized = normalizeDecimalText(rawValue);

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
  const numericValue = parseLooseNumericValue(rawValue);

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

function normalizeImportedTextValue(rawValue) {
  return normalizeText(rawValue);
}

function normalizeImportedCoordinateValue(rawValue) {
  return normalizeDecimalText(rawValue);
}

function normalizeImportedNumberValue(rawValue) {
  return toNumberText(rawValue);
}

function normalizeSetColumnValue(rawValue) {
  const numericValue = Number(normalizeDecimalText(rawValue));

  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 10) {
    return '';
  }

  return `SET${String(Math.trunc(numericValue)).padStart(2, '0')}`;
}

function normalizeImportedColumnKind(headerName) {
  const normalized = normalizeCsvHeaderForImport(headerName);

  if (
    normalized === 'rotation'
    || normalized === 'set0'
    || normalized === 'set'
    || normalized === 'count'
    || normalized === 'quantity'
    || normalized === 'qty'
  ) {
    return 'number';
  }

  return 'text';
}

function normalizeWorkbookHeaderText(value) {
  return normalizeText(value).toUpperCase();
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

function columnLettersToIndex(columnLetters) {
  const letters = String(columnLetters || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let index = 0;

  for (let charIndex = 0; charIndex < letters.length; charIndex += 1) {
    index = (index * 26) + (letters.charCodeAt(charIndex) - 64);
  }

  return index > 0 ? index - 1 : -1;
}

function extractXmlAttrValue(source, attrName) {
  const match = String(source || '').match(new RegExp(`${attrName}="([^"]*)"`));
  return match ? decodeXmlText(match[1]) : '';
}

function parseInlineXmlText(source) {
  return Array.from(String(source || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
    .map((match) => decodeXmlText(match[1]))
    .join('');
}

function parseSharedStringsXml(xmlText) {
  const sharedStrings = [];
  const content = String(xmlText || '');
  const stringMatches = content.matchAll(/<si\b[\s\S]*?<\/si>/g);

  for (const match of stringMatches) {
    sharedStrings.push(parseInlineXmlText(match[0]));
  }

  return sharedStrings;
}

function parseWorkbookSheetsXml(workbookXml, workbookRelsXml) {
  const relMap = new Map();
  const relMatches = String(workbookRelsXml || '').matchAll(/<Relationship\b([^>]*)\/>/g);

  for (const match of relMatches) {
    const relId = extractXmlAttrValue(match[1], 'Id');
    const target = extractXmlAttrValue(match[1], 'Target');

    if (relId && target) {
      relMap.set(relId, target.replace(/^\.\//, '').replace(/^\/+/, ''));
    }
  }

  const sheets = [];
  const sheetMatches = String(workbookXml || '').matchAll(/<sheet\b([^>]*)\/>/g);

  for (const match of sheetMatches) {
    const sheetName = extractXmlAttrValue(match[1], 'name');
    const relId = extractXmlAttrValue(match[1], 'r:id');
    const target = relMap.get(relId);

    if (sheetName && target) {
      sheets.push({
        name: sheetName,
        path: `xl/${target.replace(/^\/+/, '')}`
      });
    }
  }

  return sheets;
}

function parseWorksheetXmlRows(sheetXml, sharedStrings) {
  const rows = [];
  const rowMatches = String(sheetXml || '').matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g);

  for (const rowMatch of rowMatches) {
    const rowXml = rowMatch[2];
    const cells = [];
    let lastIndex = -1;
    // Важно: ячейка без значения Excel часто записывает как самозакрывающийся
    // тег <c r="F1" s="1"/> (без </c>). Старый regex /<c\b([^>]*)>([\s\S]*?)<\/c>/g
    // не распознавал такой тег отдельно: ленивая группа "проглатывала" всё
    // вперёд до ближайшего </c>, которым оказывался закрывающий тег СЛЕДУЮЩЕЙ
    // ячейки. Из-за этого значение соседней ячейки приписывалось пустой,
    // а сама следующая колонка терялась (пример: COMMENT_FR у AM1LS-0505SH30-NZ
    // в словаре Other пропадал из-за пустой ячейки Столбец2 перед ним).
    // Теперь самозакрывающиеся и обычные ячейки разбираются раздельно через |.
    const cellMatches = rowXml.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g);

    for (const cellMatch of cellMatches) {
      const isSelfClosed = cellMatch[1] !== undefined;
      const cellAttrs = isSelfClosed ? cellMatch[1] : cellMatch[2];
      const cellXml = isSelfClosed ? '' : cellMatch[3];
      const cellRef = extractXmlAttrValue(cellAttrs, 'r');
      const cellIndex = columnLettersToIndex(cellRef);
      const cellType = extractXmlAttrValue(cellAttrs, 't');
      const valueMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
      let cellValue = '';

      if (cellType === 'inlineStr') {
        cellValue = parseInlineXmlText(cellXml);
      } else if (cellType === 's') {
        const sharedIndex = Number(valueMatch ? valueMatch[1] : '');
        cellValue = Number.isFinite(sharedIndex) && sharedStrings[sharedIndex] !== undefined
          ? sharedStrings[sharedIndex]
          : '';
      } else if (cellType === 'b') {
        cellValue = valueMatch ? decodeXmlText(valueMatch[1]) : '';
      } else if (valueMatch) {
        cellValue = decodeXmlText(valueMatch[1]);
      }

      if (cellIndex >= 0) {
        cells[cellIndex] = cellValue;
        if (cellIndex > lastIndex) {
          lastIndex = cellIndex;
        }
      }
    }

    if (lastIndex >= 0) {
      for (let index = 0; index <= lastIndex; index += 1) {
        if (cells[index] === undefined) {
          cells[index] = '';
        }
      }
    }

    rows.push(cells);
  }

  return rows;
}

async function readZipEntryText(zipFile, entryPath) {
  const normalizedPath = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const entry = zipFile.files.find((item) => item.path === normalizedPath);

  if (!entry) {
    return '';
  }

  const buffer = await entry.buffer();
  return buffer.toString('utf8');
}

async function readXlsxSheetRows(filePath, sheetName) {
  const zipFile = await unzipper.Open.file(path.resolve(filePath));
  const workbookXml = await readZipEntryText(zipFile, 'xl/workbook.xml');
  const workbookRelsXml = await readZipEntryText(zipFile, 'xl/_rels/workbook.xml.rels');
  const sharedStringsXml = await readZipEntryText(zipFile, 'xl/sharedStrings.xml');
  const sharedStrings = parseSharedStringsXml(sharedStringsXml);
  const sheets = parseWorkbookSheetsXml(workbookXml, workbookRelsXml);
  const sheetInfo = sheets.find((sheet) => normalizeWorkbookHeaderText(sheet.name) === normalizeWorkbookHeaderText(sheetName));

  if (!sheetInfo) {
    throw new Error(`Лист ${sheetName} не найден в книге ${path.basename(filePath)}`);
  }

  const sheetXml = await readZipEntryText(zipFile, sheetInfo.path);

  if (!sheetXml) {
    throw new Error(`Лист ${sheetName} пустой или недоступен в книге ${path.basename(filePath)}`);
  }

  return {
    sheetName: sheetInfo.name,
    rows: parseWorksheetXmlRows(sheetXml, sharedStrings)
  };
}

function measureWorkbookColumnWidths(rows, options = {}) {
  const maxWidth = Number.isFinite(options.maxWidth) ? Number(options.maxWidth) : 60;
  const normalizedRows = Array.isArray(rows)
    ? rows.map((row) => (Array.isArray(row) ? row : Array.isArray(row && row.values) ? row.values : []))
    : [];
  const columnCount = normalizedRows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 8);

  normalizedRows.forEach((row) => {
    row.forEach((value, index) => {
      // Для Stats и других листов ячейка может быть объектом { value, styleIndex }.
      // Для автоширины учитываем именно текст, а не строку "[object Object]".
      const cellText = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
        ? value.value
        : value;
      const length = normalizeText(cellText).length;
      const nextWidth = Math.max(8, Math.min(maxWidth, length + 2));
      widths[index] = Math.max(widths[index], nextWidth);
    });
  });

  return widths;
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
    version: APP_VERSION,
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
      x: normalizeImportedCoordinateValue(getCellValue(cells, columnMap.x)),
      y: normalizeImportedCoordinateValue(getCellValue(cells, columnMap.y)),
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

function getSetColumnState(rawTable, setValue) {
  const setColumnName = normalizeSetColumnValue(setValue);
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];
  const columnIndex = rawHeaders.findIndex((header) => String(header || '').trim() === setColumnName);
  const headersList = rawHeaders.join(' | ');
  let hasValidValues = false;
  let lastRow = 0;

  rows.forEach((row, index) => {
    if (Array.isArray(row) && String(row[0] || '').trim() !== '') {
      lastRow = index + 1;
    }
    if (columnIndex >= 0 && Array.isArray(row)) {
      const cellValue = normalizeText(row[columnIndex]).toUpperCase();
      if (cellValue === '1' || cellValue === 'R') {
        hasValidValues = true;
      }
    }
  });

  return {
    setColumnName,
    columnIndex,
    lastRow,
    hasValidValues,
    headersList,
    found: columnIndex >= 0
  };
}

function applySetColumnFill(importInfo, setValue, fillValue = '1') {
  const sourceImportInfo = importInfo || {};
  const rawTable = sourceImportInfo.rawTable || {};
  const rows = Array.isArray(rawTable.rows) ? rawTable.rows : [];
  const nextState = getSetColumnState(rawTable, setValue);

  if (!nextState.found) {
    return {
      importInfo: sourceImportInfo,
      setColumnState: nextState,
      filledRowCount: 0
    };
  }

  const nextRows = rows.map((row, index) => {
    const nextRow = Array.isArray(row) ? row.slice() : [];
    const rowHasData = String(nextRow[0] || '').trim() !== '';

    if (rowHasData) {
      nextRow[nextState.columnIndex] = String(fillValue);
    }

    return nextRow;
  });

  const nextRawTable = {
    ...rawTable,
    rows: nextRows
  };
  const deletePcbState = getDeletePcbRowsState(nextRawTable);
  const dataSetState = buildDataSetTableState(
   {
     ...sourceImportInfo,
     rawTable: nextRawTable,
     dataSetTable: sourceImportInfo.dataSetTable || {
       rawHeaders: Array.isArray(nextRawTable.rawHeaders) ? nextRawTable.rawHeaders.slice() : [],
       rows: deletePcbState.rows
     }
   },
   {
     infoD3: normalizeSetColumnValue(setValue).replace(/^SET/, '')
   }
  );
  const dataSet2State = buildDataSet2TableState(dataSetState);
  const nextImportInfo = {
   ...sourceImportInfo,
   infoD3: normalizeSetColumnValue(setValue).replace(/^SET/, ''),
   rawTable: nextRawTable,
   dataSetTable: {
    rawHeaders: Array.isArray(dataSetState.rawHeaders) ? dataSetState.rawHeaders.slice() : Array.isArray(nextRawTable.rawHeaders) ? nextRawTable.rawHeaders.slice() : [],
    rows: dataSetState.rows,
    worksheetRows: dataSetState.worksheetRows
   },
   dataSet2Table: {
     rawHeaders: Array.isArray(dataSet2State.rawHeaders) ? dataSet2State.rawHeaders.slice() : Array.isArray(nextRawTable.rawHeaders) ? nextRawTable.rawHeaders.slice() : [],
     rows: dataSet2State.rows,
     worksheetRows: dataSet2State.worksheetRows
   },
   deletedPcbRowsCount: deletePcbState.deletedCount,
   deletePcbState,
   copyRowsState: dataSetState.copyRowsState,
   filterSetState: dataSetState.setColumnState,
   deleteNotFittedState: dataSetState.deleteNotFittedState,
   rReplacementState: dataSetState.rReplacementState,
   setColumnState: {
     ...nextState,
     filledRowCount: nextRows.filter((row) => String(row[0] || '').trim() !== '').length,
     fillApplied: true
   }
  };

  return {
    importInfo: nextImportInfo,
    setColumnState: nextImportInfo.setColumnState,
    filledRowCount: nextImportInfo.setColumnState.filledRowCount
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
    version: APP_VERSION,
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
      x: normalizeImportedCoordinateValue(getCellValue(cells, columnMap.x)),
      y: normalizeImportedCoordinateValue(getCellValue(cells, columnMap.y)),
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
    version: String((dictLike && dictLike.version) || APP_VERSION),
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
      x: normalizeImportedCoordinateValue(row && row.x),
      y: normalizeImportedCoordinateValue(row && row.y),
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
      const baseRotation = parseLooseNumericValue(row.rotation);
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

function escapeXml(value) {
  return normalizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnIndexToLetters(index) {
  let current = index + 1;
  let letters = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    current = Math.floor((current - 1) / 26);
  }

  return letters;
}

function buildInlineStringCellXml(ref, value) {
  const text = normalizeText(value);

  if (text === '') {
    return '';
  }

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function buildCellXml(ref, value, kind, styleIndex = 1, options = {}) {
  const text = normalizeText(value);

  if (text === '') {
    if (options && options.preserveEmpty) {
      return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve"></t></is></c>`;
    }

    return '';
  }

  if (kind === 'number') {
    const numericText = normalizeDecimalText(text);
    const numericValue = Number(numericText);

    if (!Number.isFinite(numericValue)) {
      return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }

    return `<c r="${ref}" s="${styleIndex === 3 ? 3 : 2}"><v>${normalizeImportedNumberValue(numericValue)}</v></c>`;
  }

  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function buildWorksheetColsXml(columnWidths) {
  if (!Array.isArray(columnWidths) || !columnWidths.length) {
    return '';
  }

  const cols = columnWidths.map((width, index) => (
    `<col min="${index + 1}" max="${index + 1}" width="${Math.max(8, Number(width) || 8)}" customWidth="1"/>`
  )).join('');

  return `<cols>${cols}</cols>`;
}

function buildWorksheetXml(rows, columnKinds = [], options = {}) {
  const tableRange = String(options.tableRange || '').trim();
  const columnWidths = Array.isArray(options.columnWidths) ? options.columnWidths : [];
  const highlightColumnIndex = Number.isInteger(options.highlightColumnIndex) ? options.highlightColumnIndex : -1;
  const firstRowAsHeaders = options.firstRowAsHeaders !== false;
  const hasTable = Boolean(tableRange);
  const rowXml = rows.map((rowValues, rowIndex) => {
    const rowModel = rowValues && typeof rowValues === 'object' && Array.isArray(rowValues.values)
      ? rowValues
      : { values: rowValues, hidden: false };
    const values = Array.isArray(rowModel.values) ? rowModel.values : [];
    const cellXml = rowValues
      ? values.map((value, cellIndex) => {
        const cellData = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
          ? value
          : { value };

        if (rowIndex === 0 && firstRowAsHeaders) {
          return buildInlineStringCellXml(`${columnIndexToLetters(cellIndex)}${rowIndex + 1}`, normalizeWorkbookHeaderText(cellData.value));
        }

        const kind = cellData.kind || columnKinds[cellIndex] || 'text';
        const styleIndex = Number.isInteger(cellData.styleIndex)
          ? cellData.styleIndex
          : (highlightColumnIndex >= 0 && cellIndex === highlightColumnIndex ? 3 : 1);
        return buildCellXml(
          `${columnIndexToLetters(cellIndex)}${rowIndex + 1}`,
          cellData.value,
          kind,
          styleIndex,
          { preserveEmpty: Boolean(cellData.preserveEmpty) }
        );
      })
      .filter((cell) => cell !== '')
      .join('')
      : '';

    return `<row r="${rowIndex + 1}"${rowModel.hidden ? ' hidden="1"' : ''}>${cellXml}</row>`;
  }).join('');

  const maxColumns = rows.reduce((max, rowValues) => Math.max(max, rowValues.length), 0);
  const lastColumn = maxColumns > 0 ? columnIndexToLetters(maxColumns - 1) : 'A';
  const lastRow = rows.length > 0 ? rows.length : 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr>
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews>
    <sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView>
  </sheetViews>
  <sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>
  ${buildWorksheetColsXml(columnWidths)}
  <sheetData>${rowXml}</sheetData>
  <pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>
  ${hasTable ? `<tableParts count="1"><tablePart r:id="rId1"/></tableParts>` : ''}
</worksheet>`;
}

function buildInfoSheetRows(importInfo, sourcePath) {
  const d3Value = String(importInfo && importInfo.infoD3 ? importInfo.infoD3 : '');
  const d5Value = String(importInfo && importInfo.infoD5 ? importInfo.infoD5 : '');
  const d6Value = String(importInfo && importInfo.infoD6 ? importInfo.infoD6 : sourcePath || '');
  const d7Value = String(importInfo && importInfo.infoD7 ? importInfo.infoD7 : '');
  const rows = Array.from({ length: 15 }, () => ['', '', '', '']);

  rows[2][3] = d3Value;
  rows[4][3] = d5Value;
  rows[5][3] = d6Value;
  rows[6][3] = d7Value;

  INFO_LEGEND_ROWS.forEach((entry) => {
    const rowIndex = entry.row - 1;
    rows[rowIndex][0] = { value: '', styleIndex: entry.fillStyleIndex, preserveEmpty: true };
    rows[rowIndex][1] = entry.text;
  });

  return rows;
}

function buildSetFillColumnRows(rawTable, setColumnName) {
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const columnIndex = rawHeaders.findIndex((header) => String(header || '').trim() === String(setColumnName || '').trim());

  if (columnIndex < 0) {
    return {
      rows,
      columnIndex
    };
  }

  return {
    rows,
    columnIndex
  };
}

function getDeletePcbRowsState(rawTable) {
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const commentColumnIndex = rawHeaders.findIndex((header) => normalizeWorkbookHeaderText(header) === 'COMMENT');

  if (commentColumnIndex < 0) {
    throw new Error("Столбец 'COMMENT' не найден на листе DataSet!");
  }

  if (rows.length <= 0) {
    return {
      found: true,
      commentColumnIndex,
      lastRow: rows.length,
      deletedCount: 0,
      rows: []
    };
  }

  // Идем как в VBA: удаляем только строки, где COMMENT начинается с "Плата печатная".
  let lastDataIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    if (normalizeText(row[commentColumnIndex]) !== '') {
      lastDataIndex = index;
    }
  }

  if (lastDataIndex < 0) {
    return {
      found: true,
      commentColumnIndex,
      lastRow: rows.length,
      deletedCount: 0,
      rows: rows.map((row) => (Array.isArray(row) ? row.slice() : []))
    };
  }

  const nextRows = [];
  let deletedCount = 0;

  for (let index = 0; index <= lastDataIndex; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index].slice() : [];
    const cellValue = normalizeText(row[commentColumnIndex]);

    if (cellValue && cellValue.toUpperCase().startsWith('ПЛАТА ПЕЧАТНАЯ')) {
      deletedCount += 1;
      continue;
    }

    nextRows.push(row);
  }

  for (let index = lastDataIndex + 1; index < rows.length; index += 1) {
    nextRows.push(Array.isArray(rows[index]) ? rows[index].slice() : []);
  }

  return {
    found: true,
    commentColumnIndex,
    lastRow: lastDataIndex + 1,
    deletedCount,
    rows: nextRows
  };
}

function clonePnpRawRow(row) {
  return Array.isArray(row) ? row.slice() : [];
}

function clonePnpCell(cell) {
  return cell && typeof cell === 'object' ? { ...cell } : cell;
}

function clonePnpCellValue(cell) {
  if (cell && typeof cell === 'object' && Object.prototype.hasOwnProperty.call(cell, 'value')) {
    return cell.value;
  }

  return cell;
}

function normalizePnpRowKey(row) {
  return JSON.stringify(Array.isArray(row) ? row.map(clonePnpCellValue) : []);
}

function findPnpRawHeaderIndex(rawHeaders, headerName) {
  const normalizedHeaderName = normalizeWorkbookHeaderText(headerName);
  return Array.isArray(rawHeaders)
    ? rawHeaders.findIndex((header) => normalizeWorkbookHeaderText(header) === normalizedHeaderName)
    : -1;
}

function collectPnpSetColumnIndices(rawHeaders) {
  return Array.isArray(rawHeaders)
    ? rawHeaders.reduce((indices, header, index) => {
        if (normalizeWorkbookHeaderText(header).indexOf('SET') >= 0) {
          indices.push(index);
        }
        return indices;
      }, [])
    : [];
}

function isPnpRefDesignator(value) {
  return normalizeText(value).toUpperCase().startsWith('REF');
}

function getCopyRowsWithRefState(sourceTable, destTable) {
  const sourceHeaders = Array.isArray(sourceTable && sourceTable.rawHeaders) ? sourceTable.rawHeaders : [];
  const sourceRows = Array.isArray(sourceTable && sourceTable.rows) ? sourceTable.rows : [];
  const destHeaders = Array.isArray(destTable && destTable.rawHeaders) ? destTable.rawHeaders : sourceHeaders;
  const destRows = Array.isArray(destTable && destTable.rows) ? destTable.rows.map(clonePnpRawRow) : [];
  const sourceDesignatorIndex = findPnpRawHeaderIndex(sourceHeaders, 'DESIGNATOR');
  const destDesignatorIndex = findPnpRawHeaderIndex(destHeaders, 'DESIGNATOR');
  const destVariationIndex = findPnpRawHeaderIndex(destHeaders, 'VARIATION');
  const destSetColumnIndices = collectPnpSetColumnIndices(destHeaders);

  if (sourceDesignatorIndex < 0) {
    throw new Error('Столбец DESIGNATOR не найден на Лист1 на этапе копирования REF');
  }

  if (destDesignatorIndex < 0) {
    throw new Error('Столбец DESIGNATOR не найден на DataSet');
  }

  if (destVariationIndex < 0) {
    throw new Error('Столбец VARIATION не найден на DataSet');
  }

  if (!destSetColumnIndices.length) {
    throw new Error('Столбцы SET не найдены на DataSet');
  }

  const sourceRefMap = new Map();
  const destRefSet = new Set();

  sourceRows.forEach((row, rowIndex) => {
    const rowData = Array.isArray(row) ? row : [];
    const designator = normalizeText(rowData[sourceDesignatorIndex]).toUpperCase();
    if (isPnpRefDesignator(designator) && !sourceRefMap.has(designator)) {
      sourceRefMap.set(designator, {
        rowIndex,
        row: clonePnpRawRow(rowData)
      });
    }
  });

  let existingRefCount = 0;
  let addedCount = 0;

  destRows.forEach((row) => {
    const rowDesignator = normalizeText(row[destDesignatorIndex]).toUpperCase();
    if (!isPnpRefDesignator(rowDesignator)) {
      return;
    }

    existingRefCount += 1;
    destRefSet.add(rowDesignator);

    destSetColumnIndices.forEach((setIndex) => {
      row[setIndex] = '1';
    });
    row[destVariationIndex] = 'Fitted';
  });

  sourceRefMap.forEach((entry, designator) => {
    if (destRefSet.has(designator)) {
      return;
    }

    const nextRow = clonePnpRawRow(entry.row);
    destSetColumnIndices.forEach((setIndex) => {
      nextRow[setIndex] = '1';
    });
    nextRow[destVariationIndex] = 'Fitted';
    destRows.push(nextRow);
    addedCount += 1;
  });

  return {
    rows: destRows,
    addedCount,
    existingRefCount,
    sourceRefCount: sourceRefMap.size,
    setColumnIndices: destSetColumnIndices,
    variationIndex: destVariationIndex,
    designatorIndex: destDesignatorIndex
  };
}

function getFilteredSetRowsState(rawTable, setColumnIndex) {
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];

  if (!Number.isInteger(setColumnIndex) || setColumnIndex < 0) {
    return {
      rows: rows.map(clonePnpRawRow),
      filteredCount: 0,
      setColumnIndex
    };
  }

  // В VBA здесь устанавливается автофильтр, а в UI мы показываем только видимые строки.
  const filteredRows = rows
    .map((row, index) => ({
      row: clonePnpRawRow(row),
      index,
      setValue: normalizeText(row[setColumnIndex]).toUpperCase()
    }))
    .filter((entry) => entry.setValue === '1' || entry.setValue === 'R')
    .sort((left, right) => {
      const priority = (value) => (value === '1' ? 0 : 1);
      const leftPriority = priority(left.setValue);
      const rightPriority = priority(right.setValue);

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      const leftDesignator = normalizeText(left.row[findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR')]).toUpperCase();
      const rightDesignator = normalizeText(right.row[findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR')]).toUpperCase();
      return leftDesignator.localeCompare(rightDesignator, 'ru');
    })
    .map((entry) => entry.row);

  return {
    rows: filteredRows,
    filteredCount: filteredRows.length,
    setColumnIndex
  };
}

function getDeleteNotFittedRowsState(rawTable, setColumnIndex) {
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];
  const variationIndex = findPnpRawHeaderIndex(rawHeaders, 'VARIATION');
  const designatorIndex = findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR');

  if (!Number.isInteger(setColumnIndex) || setColumnIndex < 0) {
    throw new Error('Ошибка: столбец SET не определен.  Удаление строк невозможно.');
  }

  if (variationIndex < 0) {
    throw new Error('Столбец VARIATION не найден на Лист3. Удаление строк невозможно.');
  }

  if (designatorIndex < 0) {
    throw new Error('Столбец DESIGNATOR не найден на Лист3. Удаление строк невозможно.');
  }

  const nextRows = [];
  const deletedDesignators = [];

  rows.forEach((row) => {
    const rowData = clonePnpRawRow(row);
    const setValue = normalizeText(rowData[setColumnIndex]);
    const variationValue = normalizeText(rowData[variationIndex]).toUpperCase();

    if (setValue === '1' && variationValue === 'NOT FITTED') {
      const designatorValue = normalizeText(rowData[designatorIndex]);
      if (designatorValue) {
        deletedDesignators.push(designatorValue);
      }
      return;
    }

    nextRows.push(rowData);
  });

  return {
    rows: nextRows,
    deletedCount: deletedDesignators.length,
    deletedDesignators,
    variationIndex,
    designatorIndex,
    setColumnIndex
  };
}

function getRColumnIndex(header, baseName) {
  const normalizedHeader = normalizeWorkbookHeaderText(header);
  const normalizedBase = normalizeWorkbookHeaderText(baseName);

  if (!normalizedHeader || normalizedHeader.indexOf(normalizedBase) !== 0) {
    return 0;
  }

  const suffix = normalizedHeader.slice(normalizedBase.length).replace(/_/g, '');
  if (suffix === '' || suffix === '0' || suffix === '00') {
    return 0;
  }
  if (suffix === '01') {
    return 1;
  }

  const numeric = Number(suffix);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function getRMatchingIndex(arrIdx, setIdx) {
  if (!Array.isArray(arrIdx) || !arrIdx.length) {
    return 0;
  }

  for (let index = 0; index < arrIdx.length; index += 1) {
    if (arrIdx[index] === setIdx) {
      return index + 1;
    }
  }

  return 0;
}

function selectRReplacementValue(row, arrCols, arrIdx, setIdx) {
  const primaryIndex = getRMatchingIndex(arrIdx, setIdx);
  if (primaryIndex > 0) {
    return normalizeText(row[arrCols[primaryIndex - 1]]);
  }

  const fallbackIndex = getRMatchingIndex(arrIdx, 0);
  if (fallbackIndex > 0) {
    return normalizeText(row[arrCols[fallbackIndex - 1]]);
  }

  return '';
}

function getRReplacementState(rawTable, setColumnIndex, setIdx) {
  const rawHeaders = Array.isArray(rawTable && rawTable.rawHeaders) ? rawTable.rawHeaders : [];
  const rows = Array.isArray(rawTable && rawTable.rows) ? rawTable.rows : [];
  const commentIndex = findPnpRawHeaderIndex(rawHeaders, 'COMMENT');
  const designatorIndex = findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR');
  const tolIndex = findPnpRawHeaderIndex(rawHeaders, 'TOL');
  const rCommentCols = [];
  const rCommentIdx = [];
  const rDesignatorCols = [];
  const rDesignatorIdx = [];
  const rTolCols = [];
  const rTolIdx = [];

  if (!Number.isInteger(setColumnIndex) || setColumnIndex < 0) {
    return {
      rows: rows.map(clonePnpRawRow),
      replacedRows: 0,
      commentReplacements: 0,
      designatorReplacements: 0,
      tolReplacements: 0,
      setColumnIndex,
      setIdx
    };
  }

  rawHeaders.forEach((header, index) => {
    const upperHeader = normalizeWorkbookHeaderText(header);
    if (upperHeader.indexOf('R_COMMENT') === 0) {
      rCommentCols.push(index);
      rCommentIdx.push(getRColumnIndex(header, 'R_COMMENT'));
    }
    if (upperHeader.indexOf('R_DESIGNATOR') === 0) {
      rDesignatorCols.push(index);
      rDesignatorIdx.push(getRColumnIndex(header, 'R_DESIGNATOR'));
    }
    if (upperHeader.indexOf('R_TOL') === 0) {
      rTolCols.push(index);
      rTolIdx.push(getRColumnIndex(header, 'R_TOL'));
    }
  });

  const nextRows = [];
  let replacedRows = 0;
  let commentReplacements = 0;
  let designatorReplacements = 0;
  let tolReplacements = 0;

  rows.forEach((row) => {
    const nextRow = clonePnpRawRow(row);
    const rowSetValue = normalizeText(nextRow[setColumnIndex]).toUpperCase();

    if (rowSetValue !== 'R') {
      nextRows.push(nextRow);
      return;
    }

    let rowChanged = false;

    if (commentIndex >= 0 && rCommentCols.length) {
      const nextComment = selectRReplacementValue(nextRow, rCommentCols, rCommentIdx, setIdx);
      if (nextComment !== '') {
        nextRow[commentIndex] = {
          value: nextComment,
          styleIndex: 8,
          className: 'pnp-fill-highlight'
        };
        commentReplacements += 1;
        rowChanged = true;
      }
    }

    if (designatorIndex >= 0 && rDesignatorCols.length) {
      const nextDesignator = selectRReplacementValue(nextRow, rDesignatorCols, rDesignatorIdx, setIdx);
      if (nextDesignator !== '') {
        nextRow[designatorIndex] = {
          value: nextDesignator,
          styleIndex: 8,
          className: 'pnp-fill-highlight'
        };
        designatorReplacements += 1;
        rowChanged = true;
      }
    }

    if (tolIndex >= 0 && rTolCols.length) {
      const nextTol = selectRReplacementValue(nextRow, rTolCols, rTolIdx, setIdx);
      if (nextTol !== '') {
        nextRow[tolIndex] = {
          value: nextTol,
          styleIndex: 8,
          className: 'pnp-fill-highlight'
        };
        tolReplacements += 1;
        rowChanged = true;
      }
    }

    if (rowChanged) {
      replacedRows += 1;
    }

    nextRows.push(nextRow);
  });

  return {
    rows: nextRows,
    replacedRows,
    commentReplacements,
    designatorReplacements,
    tolReplacements,
    setColumnIndex,
    setIdx
  };
}

function buildDataSetTableState(importInfo, options = {}) {
  const sourceTable = importInfo && importInfo.rawTable ? importInfo.rawTable : { rawHeaders: [], rows: [] };
  const rawHeaders = Array.isArray(sourceTable.rawHeaders) ? sourceTable.rawHeaders.slice() : [];
  const baseState = getDeletePcbRowsState(sourceTable);
  const copyRowsState = getCopyRowsWithRefState(sourceTable, baseState);
  const copiedTable = {
    rawHeaders: Array.isArray(baseState.rawHeaders) ? baseState.rawHeaders.slice() : rawHeaders,
    rows: copyRowsState.rows
  };
  const infoD3 = String(options.infoD3 || (importInfo && importInfo.infoD3 ? importInfo.infoD3 : ''));
  const setColumnState = getSetColumnState(copiedTable, infoD3);
  const filteredSetState = setColumnState.found
    ? getFilteredSetRowsState(copiedTable, setColumnState.columnIndex)
    : {
        rows: copiedTable.rows.map(clonePnpRawRow),
        filteredCount: copiedTable.rows.length,
        setColumnIndex: setColumnState.columnIndex
      };
  const deleteSet0Count = Math.max(0, copyRowsState.rows.length - normalizePnpStatsCount(filteredSetState.filteredCount));
  filteredSetState.deletedCount = deleteSet0Count;
  const deleteNotFittedState = setColumnState.found
    ? getDeleteNotFittedRowsState({
        rawHeaders: copiedTable.rawHeaders,
        rows: filteredSetState.rows
      }, setColumnState.columnIndex)
    : {
        rows: copiedTable.rows.map(clonePnpRawRow),
        deletedCount: 0,
        deletedDesignators: [],
        variationIndex: findPnpRawHeaderIndex(rawHeaders, 'VARIATION'),
        designatorIndex: findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR'),
        setColumnIndex: setColumnState.columnIndex
      };
  const setIdx = Number.isFinite(Number(infoD3)) ? Math.trunc(Number(infoD3)) : 0;
  const rReplacementState = setColumnState.found
    ? getRReplacementState({
        rawHeaders: copiedTable.rawHeaders,
        rows: deleteNotFittedState.rows
      }, setColumnState.columnIndex, setIdx)
    : {
        rows: deleteNotFittedState.rows.map(clonePnpRawRow),
        replacedRows: 0,
        commentReplacements: 0,
        designatorReplacements: 0,
        tolReplacements: 0,
        setColumnIndex: setColumnState.columnIndex,
        setIdx
      };
  const finalRows = Array.isArray(rReplacementState.rows) ? rReplacementState.rows : deleteNotFittedState.rows;
  const visibleRowKeys = new Set(finalRows.map((row) => normalizePnpRowKey(row)));
  const worksheetRows = finalRows.map((row) => ({
    values: clonePnpRawRow(row),
    hidden: false
  }));
  copyRowsState.rows.forEach((row) => {
    const rowKey = normalizePnpRowKey(row);
    if (!visibleRowKeys.has(rowKey)) {
      worksheetRows.push({
        values: clonePnpRawRow(row),
        hidden: true
      });
    }
  });

  return {
    rawHeaders,
    rows: finalRows,
    worksheetRows,
    copyRowsState,
    setColumnState,
    filteredSetState,
    deleteNotFittedState,
    rReplacementState,
    baseState
  };
}

function replaceRuToEnText(value) {
  let nextValue = normalizeText(value);

  // Сначала заменяем устойчивые сочетания, а затем одиночные буквы — как в VBA.
  nextValue = nextValue.replace(/Гц/gi, 'Hz');
  nextValue = nextValue.replace(/мк/gi, 'u');
  nextValue = nextValue.replace(/Гн/gi, 'H');
  nextValue = nextValue.replace(/М/gi, 'M');
  nextValue = nextValue.replace(/к/gi, 'k');
  nextValue = nextValue.replace(/К/gi, 'K');
  nextValue = nextValue.replace(/В/gi, 'V');
  nextValue = nextValue.replace(/х/gi, 'x');
  nextValue = nextValue.replace(/Г/gi, 'G');
  nextValue = nextValue.replace(/н/gi, 'n');

  return nextValue;
}

function cleanPnpTolText(value) {
  const text = normalizeText(value);
  const match = text.match(/[-+]?\d+(?:[.,]\d+)?/);

  if (!match) {
    return '';
  }

  return match[0].replace(',', '.').replace(/[+\-]/g, '');
}

function clonePnpWorksheetRow(rowModel) {
  if (Array.isArray(rowModel)) {
    return {
      values: rowModel.map(clonePnpCell),
      hidden: false
    };
  }

  return {
    values: Array.isArray(rowModel && rowModel.values)
      ? rowModel.values.map(clonePnpCell)
      : [],
    hidden: Boolean(rowModel && rowModel.hidden)
  };
}

function reorderPnpRowByHeaders(row, sourceHeaders, targetHeaders) {
  const sourceIndexes = {};
  const sourceRow = Array.isArray(row) ? row : [];

  targetHeaders.forEach((header) => {
    sourceIndexes[normalizeWorkbookHeaderText(header)] = findPnpRawHeaderIndex(sourceHeaders, header);
  });

  return targetHeaders.map((header) => {
    const sourceIndex = sourceIndexes[normalizeWorkbookHeaderText(header)];
    return sourceIndex >= 0 ? clonePnpCell(sourceRow[sourceIndex]) : '';
  });
}

function readVersionLineFromRoot() {
  try {
    const versionPath = path.join(__dirname, 'Version.md');
    const versionText = fsSync.readFileSync(versionPath, 'utf8');
    const firstLine = String(versionText || '').split(/\r?\n/)[0];
    return String(firstLine || '').trimEnd();
  } catch {
    return `Создано SMT Pro Gen ${APP_VERSION} | Обязательна внимательная проверка первой платы на ошибки!`;
  }
}

function buildDataPredExitTableState(dataOtherState) {
  const rawHeaders = Array.isArray(dataOtherState && dataOtherState.rawHeaders) ? dataOtherState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataOtherState && dataOtherState.rows) ? dataOtherState.rows : [];
  const worksheetRows = Array.isArray(dataOtherState && dataOtherState.worksheetRows) ? dataOtherState.worksheetRows : [];
  const targetHeaders = ['DESIGNATOR', 'FOOTPRINT', 'CENTER-X(MM)', 'CENTER-Y(MM)', 'LAYER', 'ROTATION', 'COMMENT'];
  const missingColumns = targetHeaders.filter((header) => findPnpRawHeaderIndex(rawHeaders, header) < 0);

  if (missingColumns.length) {
    throw new Error(`В DataOther не найдены столбцы для DataPredExit: ${missingColumns.join(', ')}`);
  }

  // Сначала сортируем вход по COMMENT, а потом переставляем колонки в финальный порядок VBA.
  const sortedEntries = rows.map((row, index) => {
    const sourceRow = clonePnpRawRow(row);
    const sourceWorksheetRow = worksheetRows[index] ? clonePnpWorksheetRow(worksheetRows[index]) : { values: clonePnpRawRow(row), hidden: false };
    return {
      row: sourceRow,
      worksheetRow: sourceWorksheetRow,
      comment: normalizeText(clonePnpCellValue(sourceRow[findPnpRawHeaderIndex(rawHeaders, 'COMMENT')])),
      index
    };
  }).sort((left, right) => {
    const compare = left.comment.localeCompare(right.comment, 'ru', { sensitivity: 'base' });
    return compare !== 0 ? compare : left.index - right.index;
  });

  const nextRows = sortedEntries.map((entry) => reorderPnpRowByHeaders(entry.row, rawHeaders, targetHeaders));
  const nextWorksheetRows = sortedEntries.map((entry) => ({
    values: reorderPnpRowByHeaders(entry.worksheetRow.values, rawHeaders, targetHeaders),
    hidden: Boolean(entry.worksheetRow.hidden)
  }));

  return {
    rawHeaders: targetHeaders.slice(),
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    sourceRowsCount: rows.length,
    visibleRowsCount: nextRows.length
  };
}

function buildDataExitTableState(dataPredExitState, importInfo = {}) {
  const rawHeaders = Array.isArray(dataPredExitState && dataPredExitState.rawHeaders) ? dataPredExitState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataPredExitState && dataPredExitState.rows) ? dataPredExitState.rows : [];
  const worksheetRows = Array.isArray(dataPredExitState && dataPredExitState.worksheetRows) ? dataPredExitState.worksheetRows : [];
  const versionLine = readVersionLineFromRoot();
  const sourceWorkbookName = String(
    importInfo && importInfo.workbookName
      ? importInfo.workbookName
      : (importInfo && importInfo.sourcePath ? path.basename(String(importInfo.sourcePath)) : '')
  ).trim();
  const fileName = String(
    importInfo && importInfo.infoD7
      ? importInfo.infoD7
      : sourceWorkbookName
  ).trim();
  const visibleRows = worksheetRows.filter((rowModel) => !rowModel.hidden);
  const dataRows = visibleRows.map((rowModel) => (
    clonePnpRawRow(Array.isArray(rowModel && rowModel.values) ? rowModel.values : [])
      .map((cell) => {
        const text = normalizeText(clonePnpCellValue(cell));
        return text === 'Fiducial' ? '0' : text;
      })
  ));

  return {
    rawHeaders,
    rows: [
      [versionLine],
      [fileName]
    ].concat(dataRows),
    worksheetRows: [
      { values: [versionLine], hidden: false },
      { values: [fileName], hidden: false }
    ].concat(dataRows.map((row) => ({
      values: clonePnpRawRow(row),
      hidden: false
    }))),
    sourceRowsCount: rows.length,
    visibleRowsCount: dataRows.length
  };
}

function buildDataSet2TableState(dataSetState) {
  const rawHeaders = Array.isArray(dataSetState && dataSetState.rawHeaders) ? dataSetState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataSetState && dataSetState.rows) ? dataSetState.rows : [];
  const worksheetRows = Array.isArray(dataSetState && dataSetState.worksheetRows) ? dataSetState.worksheetRows : [];
  const commentIndex = findPnpRawHeaderIndex(rawHeaders, 'COMMENT');
  const footprintIndex = findPnpRawHeaderIndex(rawHeaders, 'FOOTPRINT');
  const tolIndex = findPnpRawHeaderIndex(rawHeaders, 'TOL');
  const centerXIndex = findPnpRawHeaderIndex(rawHeaders, 'CENTER-X(MM)');
  const centerYIndex = findPnpRawHeaderIndex(rawHeaders, 'CENTER-Y(MM)');
  const cyrillicPattern = /[А-Яа-яЁё]/;

  const replaceRowValue = (row, isHeaderRow = false) => {
    const nextRow = clonePnpRawRow(row);
    let rowChanged = false;
    let highlightComment = false;

    for (let cellIndex = 0; cellIndex < nextRow.length; cellIndex += 1) {
      const originalCell = nextRow[cellIndex];
      const isObjectCell = originalCell && typeof originalCell === 'object' && Object.prototype.hasOwnProperty.call(originalCell, 'value');
      const sourceValue = isObjectCell ? originalCell.value : originalCell;
      let nextValue = normalizeText(sourceValue);

      if (!isHeaderRow) {
        if (cellIndex === tolIndex) {
          const cleanedTol = cleanPnpTolText(nextValue);
          if (cleanedTol !== nextValue) {
            rowChanged = true;
          }
          nextValue = cleanedTol;
        }

        if (cellIndex === commentIndex) {
          const replacedComment = replaceRuToEnText(nextValue).replace(/,/g, '.');
          if (replacedComment !== nextValue) {
            rowChanged = true;
          }
          highlightComment = cyrillicPattern.test(replacedComment);
          nextValue = replacedComment;
        }

        if (cellIndex === footprintIndex) {
          const footprintValue = nextValue.replace(/,/g, '.');
          if (footprintValue !== nextValue) {
            rowChanged = true;
          }
          nextValue = footprintValue;
        }

        if (cellIndex !== centerXIndex && cellIndex !== centerYIndex) {
          const compactValue = nextValue.replace(/ /g, '');
          if (compactValue !== nextValue) {
            rowChanged = true;
          }
          nextValue = compactValue;
        }
      }

      if (isObjectCell) {
        nextRow[cellIndex] = {
          ...originalCell,
          value: nextValue
        };
      } else {
        nextRow[cellIndex] = nextValue;
      }
    }

    if (!isHeaderRow && highlightComment && commentIndex >= 0 && nextRow[commentIndex] !== undefined) {
      const commentCell = nextRow[commentIndex];
      if (commentCell && typeof commentCell === 'object' && Object.prototype.hasOwnProperty.call(commentCell, 'value')) {
        nextRow[commentIndex] = {
          ...commentCell,
          styleIndex: 7,
          className: 'pnp-comment-highlight'
        };
      } else {
        nextRow[commentIndex] = {
          value: nextRow[commentIndex],
          styleIndex: 7,
          className: 'pnp-comment-highlight'
        };
      }
    }

    return nextRow;
  };

  const nextRows = rows.map((row) => replaceRowValue(row));
  const nextWorksheetRows = worksheetRows.map((rowModel) => {
    const nextValues = replaceRowValue(Array.isArray(rowModel && rowModel.values) ? rowModel.values : []);
    return {
      values: nextValues,
      hidden: Boolean(rowModel && rowModel.hidden)
    };
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    commentIndex,
    footprintIndex,
    tolIndex,
    centerXIndex,
    centerYIndex,
    commentReplacements: commentIndex >= 0
      ? nextRows.reduce((count, row, index) => {
          const sourceRow = rows[index] || [];
          return count + (clonePnpCellValue(sourceRow[commentIndex]) !== clonePnpCellValue(row[commentIndex]) ? 1 : 0);
        }, 0)
      : 0,
    tolNormalizedCount: tolIndex >= 0
      ? nextRows.reduce((count, row, index) => {
          const sourceRow = rows[index] || [];
          return count + (clonePnpCellValue(sourceRow[tolIndex]) !== clonePnpCellValue(row[tolIndex]) ? 1 : 0);
        }, 0)
      : 0,
    footprintCommaReplacements: footprintIndex >= 0
      ? nextRows.reduce((count, row, index) => {
          const sourceRow = rows[index] || [];
          return count + (clonePnpCellValue(sourceRow[footprintIndex]) !== clonePnpCellValue(row[footprintIndex]) ? 1 : 0);
        }, 0)
      : 0,
    spaceCleanedCount: nextRows.reduce((count, row, index) => {
      const sourceRow = rows[index] || [];
      return count + (JSON.stringify(sourceRow) !== JSON.stringify(row) ? 1 : 0);
    }, 0)
  };
}

function buildDataResistTableState(dataSet2State) {
  const rawHeaders = Array.isArray(dataSet2State && dataSet2State.rawHeaders) ? dataSet2State.rawHeaders.slice() : [];
  const rows = Array.isArray(dataSet2State && dataSet2State.rows) ? dataSet2State.rows : [];
  const worksheetRows = Array.isArray(dataSet2State && dataSet2State.worksheetRows) ? dataSet2State.worksheetRows : [];

  return {
    rawHeaders,
    rows: rows.map((row) => clonePnpRawRow(row)),
    worksheetRows: worksheetRows.map(clonePnpWorksheetRow)
  };
}

function normalizeResistorCellText(value, headerName) {
  const text = normalizeText(clonePnpCellValue(value));

  if (!text) {
    return '';
  }

  if (normalizeWorkbookHeaderText(headerName) === 'TOL' || normalizeWorkbookHeaderText(headerName) === 'PREF') {
    return normalizeDecimalText(text).toUpperCase();
  }

  return text.replace(/\s+/g, ' ').toUpperCase();
}

function isResistorFieldMatch(sourceValue, dictValue, columnName) {
  const normalizedColumn = normalizeWorkbookHeaderText(columnName);

  // Для TOL пустое значение в CSV и в словаре считается совпадением,
  // чтобы такие строки не проваливались в "частично совпавшие".
  if (normalizedColumn === 'TOL' && sourceValue === '' && dictValue === '') {
    return true;
  }

  return sourceValue !== '' && dictValue !== '' && sourceValue === dictValue;
}

function findResistorColumnIndex(rawHeaders, columnName) {
  return Array.isArray(rawHeaders)
    ? rawHeaders.findIndex((header) => normalizeWorkbookHeaderText(header) === normalizeWorkbookHeaderText(columnName))
    : -1;
}

function buildResistorCellValue(value, matchState, styleIndex) {
  const cellValue = normalizeText(value);

  return {
    value: cellValue,
    styleIndex,
    className: matchState === 'full'
      ? 'pnp-resist-full'
      : matchState === 'match'
        ? 'pnp-resist-match'
        : 'pnp-resist-miss'
  };
}

function buildResistorMatchDetail(sourceRowIndex, sourceRow, dictRowIndex, dictRow, matchCount, matchedFields, mismatchedFields, rawHeaders, dictHeaders) {
  return {
    sourceRowIndex: sourceRowIndex + 1,
    dictRowIndex: dictRowIndex + 1,
    matchCount,
    matchedFields: matchedFields.slice(),
    mismatchedFields: mismatchedFields.slice(),
    source: {
      comment: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'COMMENT')])),
      footprint: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'FOOTPRINT')])),
      tol: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'TOL')])),
      pref: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'PREF')]))
    },
    dict: {
      comment: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'COMMENT')])),
      footprint: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'FOOTPRINT')])),
      tol: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'TOL')])),
      pref: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'PREF')]))
    }
  };
}

function buildResistorMatchState(dataSet2State, resistorSheetState) {
  const rawHeaders = Array.isArray(dataSet2State && dataSet2State.rawHeaders) ? dataSet2State.rawHeaders.slice() : [];
  const rows = Array.isArray(dataSet2State && dataSet2State.rows) ? dataSet2State.rows : [];
  const worksheetRows = Array.isArray(dataSet2State && dataSet2State.worksheetRows) ? dataSet2State.worksheetRows : [];
  const dictRawHeaders = Array.isArray(resistorSheetState && resistorSheetState.rawHeaders) ? resistorSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(resistorSheetState && resistorSheetState.rows) ? resistorSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT', 'TOL', 'PREF'];
  const requiredDictColumns = ['COMMENT', 'FOOTPRINT', 'TOL', 'PREF', 'COMMENT_FR', 'FOOTPRINT_FR', 'TOL_FR'];
  const sourceIndexes = {};
  const dictIndexes = {};

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataResist не найдены столбцы: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Resist не найдены столбцы: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  const noMatchResistors = [];
  let totalCount = 0;
  let fullMatchCount = 0;
  let partialMatchCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const sourceValues = {
      COMMENT: normalizeResistorCellText(nextRow[sourceIndexes.COMMENT], 'COMMENT'),
      FOOTPRINT: normalizeResistorCellText(nextRow[sourceIndexes.FOOTPRINT], 'FOOTPRINT'),
      TOL: normalizeResistorCellText(nextRow[sourceIndexes.TOL], 'TOL'),
      PREF: normalizeResistorCellText(nextRow[sourceIndexes.PREF], 'PREF')
    };
    let bestMatch = null;

    dictRows.forEach((dictRow, dictRowIndex) => {
      const dictValues = {
        COMMENT: normalizeResistorCellText(dictRow[dictIndexes.COMMENT], 'COMMENT'),
        FOOTPRINT: normalizeResistorCellText(dictRow[dictIndexes.FOOTPRINT], 'FOOTPRINT'),
        TOL: normalizeResistorCellText(dictRow[dictIndexes.TOL], 'TOL'),
        PREF: normalizeResistorCellText(dictRow[dictIndexes.PREF], 'PREF')
      };
      const matchedFields = [];
      const mismatchedFields = [];

      requiredSourceColumns.forEach((columnName) => {
        const sourceValue = sourceValues[columnName];
        const dictValue = dictValues[columnName];

        if (isResistorFieldMatch(sourceValue, dictValue, columnName)) {
          matchedFields.push(columnName);
        } else if (sourceValue !== '' || dictValue !== '') {
          mismatchedFields.push(columnName);
        }
      });

      const matchCount = matchedFields.length;

      if (!bestMatch || matchCount > bestMatch.matchCount) {
        bestMatch = {
          dictRowIndex,
          dictRow,
          dictValues,
          matchCount,
          matchedFields,
          mismatchedFields
        };
      }

    });

    totalCount += 1;

    if (!bestMatch || bestMatch.matchCount < 3) {
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const isFullMatch = bestMatch.matchCount === requiredSourceColumns.length;
    const fullMatchStyle = 4; // Розовый, как в VBA при полном совпадении.
    const partialMatchStyle = 5; // Зеленый для совпавших полей.
    const partialMissStyle = 10; // Красный с белым шрифтом для несовпавших полей.

    requiredSourceColumns.forEach((columnName) => {
      const sourceIndex = sourceIndexes[columnName];
      const isMatched = bestMatch.matchedFields.includes(columnName);
      const currentValue = normalizeText(clonePnpCellValue(nextRow[sourceIndex]));

      nextRow[sourceIndex] = {
        value: currentValue,
        styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
        className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
      };

      if (Array.isArray(nextWorksheetRow.values)) {
        nextWorksheetRow.values[sourceIndex] = {
          value: currentValue,
          styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
          className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
        };
      }
    });

    if (isFullMatch) {
      const replacementComment = normalizeText(bestMatch.dictRow[dictIndexes.COMMENT_FR]);
      const replacementFootprint = normalizeText(bestMatch.dictRow[dictIndexes.FOOTPRINT_FR]);

      if (replacementComment) {
        nextRow[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        }
      }

      if (replacementFootprint) {
        nextRow[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        }
      }

      fullMatchCount += 1;
    } else {
      partialMatchCount += 1;
      noMatchResistors.push(buildResistorMatchDetail(sourceRowIndex, nextRow, bestMatch.dictRowIndex, bestMatch.dictRow, bestMatch.matchCount, bestMatch.matchedFields, bestMatch.mismatchedFields, rawHeaders, dictRawHeaders));
    }

    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    noMatchResistors,
    resistorStats: {
      Stats_Resistors_Total: totalCount,
      Stats_Resistors_Full: fullMatchCount,
      Stats_Resistors_Partial: partialMatchCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function computeResistorRotationValue(currentRotation, rotationDelta, layerValue) {
  const layerText = normalizeText(layerValue).toLowerCase();
  const currentValue = parseLooseNumericValue(currentRotation);
  const deltaValue = parseLooseNumericValue(rotationDelta);
  const safeCurrent = Number.isFinite(currentValue) ? currentValue : 0;
  const safeDelta = Number.isFinite(deltaValue) ? deltaValue : 0;
  let nextRotation = null;

  // Формулы повторяют VBA-макрос CalculateRotationForResist.
  if (layerText === 'toplayer' || layerText === 'top') {
    nextRotation = (safeCurrent - safeDelta) % 360;
    if (nextRotation < 0) {
      nextRotation += 360;
    }
  } else if (layerText === 'bottomlayer' || layerText === 'bottom') {
    if (safeCurrent <= 180) {
      nextRotation = 180 - safeCurrent - safeDelta;
    } else {
      nextRotation = 540 - safeCurrent - safeDelta;
    }

    nextRotation %= 360;
    if (nextRotation < 0) {
      nextRotation += 360;
    }
  }

  if (nextRotation === null || !Number.isFinite(nextRotation)) {
    return null;
  }

  return normalizeRotationValue(nextRotation);
}

function buildResistorRotationState(dataResistState, resistorSheetState) {
  const rawHeaders = Array.isArray(dataResistState && dataResistState.rawHeaders) ? dataResistState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataResistState && dataResistState.rows) ? dataResistState.rows : [];
  const worksheetRows = Array.isArray(dataResistState && dataResistState.worksheetRows) ? dataResistState.worksheetRows : [];
  const dictRawHeaders = Array.isArray(resistorSheetState && resistorSheetState.rawHeaders) ? resistorSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(resistorSheetState && resistorSheetState.rows) ? resistorSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT', 'ROTATION', 'LAYER'];
  const requiredDictColumns = ['COMMENT_FR', 'FOOTPRINT_FR', 'ROTATION_DELTA'];
  const sourceIndexes = {};
  const dictIndexes = {};

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataResist не найдены столбцы для расчета ROTATION: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Resist не найдены столбцы для расчета ROTATION: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  let totalCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  let changedCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const sourceComment = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.COMMENT]));
    const sourceFootprint = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.FOOTPRINT]));
    const sourceRotation = clonePnpCellValue(nextRow[sourceIndexes.ROTATION]);
    const sourceLayer = clonePnpCellValue(nextRow[sourceIndexes.LAYER]);
    const matchedDictRowIndex = dictRows.findIndex((dictRow) => (
      normalizeText(clonePnpCellValue(dictRow[dictIndexes.COMMENT_FR])) === sourceComment
      && normalizeText(clonePnpCellValue(dictRow[dictIndexes.FOOTPRINT_FR])) === sourceFootprint
    ));

    totalCount += 1;

    if (matchedDictRowIndex < 0) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const rotationDelta = clonePnpCellValue(dictRows[matchedDictRowIndex][dictIndexes.ROTATION_DELTA]);
    const nextRotation = computeResistorRotationValue(sourceRotation, rotationDelta, sourceLayer);

    if (nextRotation === null) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    nextRow[sourceIndexes.ROTATION] = nextRotation;

    if (Array.isArray(nextWorksheetRow.values)) {
      nextWorksheetRow.values[sourceIndexes.ROTATION] = nextRotation;
    }

    if (normalizeRotationValue(sourceRotation) !== normalizeRotationValue(nextRotation)) {
      changedCount += 1;
    }

    processedCount += 1;
    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    rotationStats: {
      Stats_Rotation_Total: totalCount,
      Stats_Rotation_Processed: processedCount,
      Stats_Rotation_Skipped: skippedCount,
      Stats_Rotation_Changed: changedCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function buildCapacitorMatchDetail(sourceRowIndex, sourceRow, dictRowIndex, dictRow, matchCount, matchedFields, mismatchedFields, rawHeaders, dictHeaders) {
  return {
    sourceRowIndex: sourceRowIndex + 1,
    dictRowIndex: dictRowIndex + 1,
    matchCount,
    matchedFields: matchedFields.slice(),
    mismatchedFields: mismatchedFields.slice(),
    source: {
      comment: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'COMMENT')])),
      footprint: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'FOOTPRINT')])),
      pref: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'PREF')]))
    },
    dict: {
      comment: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'COMMENT')])),
      footprint: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'FOOTPRINT')])),
      pref: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'PREF')]))
    }
  };
}

function buildCapacitorMatchState(dataCapacitorState, capacitorSheetState) {
  const rawHeaders = Array.isArray(dataCapacitorState && dataCapacitorState.rawHeaders) ? dataCapacitorState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataCapacitorState && dataCapacitorState.rows) ? dataCapacitorState.rows : [];
  const worksheetRows = Array.isArray(dataCapacitorState && dataCapacitorState.worksheetRows) ? dataCapacitorState.worksheetRows : [];
  const dictRawHeaders = Array.isArray(capacitorSheetState && capacitorSheetState.rawHeaders) ? capacitorSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(capacitorSheetState && capacitorSheetState.rows) ? capacitorSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT', 'PREF'];
  const requiredDictColumns = ['COMMENT', 'FOOTPRINT', 'PREF', 'COMMENT_FR', 'FOOTPRINT_FR'];
  const sourceIndexes = {};
  const dictIndexes = {};

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataCapacitor не найдены столбцы: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Capacitor не найдены столбцы: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  const noMatchCapacitors = [];
  let totalCount = 0;
  let fullMatchCount = 0;
  let partialMatchCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const sourceValues = {
      COMMENT: normalizeText(clonePnpCellValue(nextRow[sourceIndexes.COMMENT])),
      FOOTPRINT: normalizeText(clonePnpCellValue(nextRow[sourceIndexes.FOOTPRINT])),
      PREF: normalizeText(clonePnpCellValue(nextRow[sourceIndexes.PREF]))
    };
    let bestMatch = null;

    dictRows.forEach((dictRow, dictRowIndex) => {
      const dictValues = {
        COMMENT: normalizeText(clonePnpCellValue(dictRow[dictIndexes.COMMENT])),
        FOOTPRINT: normalizeText(clonePnpCellValue(dictRow[dictIndexes.FOOTPRINT])),
        PREF: normalizeText(clonePnpCellValue(dictRow[dictIndexes.PREF]))
      };
      const matchedFields = [];
      const mismatchedFields = [];

      requiredSourceColumns.forEach((columnName) => {
        const sourceValue = sourceValues[columnName];
        const dictValue = dictValues[columnName];

        if (sourceValue !== '' && dictValue !== '' && sourceValue === dictValue) {
          matchedFields.push(columnName);
        } else if (sourceValue !== '' || dictValue !== '') {
          mismatchedFields.push(columnName);
        }
      });

      const matchCount = matchedFields.length;

      if (!bestMatch || matchCount > bestMatch.matchCount) {
        bestMatch = {
          dictRowIndex,
          dictRow,
          dictValues,
          matchCount,
          matchedFields,
          mismatchedFields
        };
      }
    });

    totalCount += 1;

    if (!bestMatch || bestMatch.matchCount < 2) {
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const isFullMatch = bestMatch.matchCount === requiredSourceColumns.length;
    const fullMatchStyle = 4;
    const partialMatchStyle = 5;
    const partialMissStyle = 10;

    requiredSourceColumns.forEach((columnName) => {
      const sourceIndex = sourceIndexes[columnName];
      const isMatched = bestMatch.matchedFields.includes(columnName);
      const currentValue = normalizeText(clonePnpCellValue(nextRow[sourceIndex]));

      nextRow[sourceIndex] = {
        value: currentValue,
        styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
        className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
      };

      if (Array.isArray(nextWorksheetRow.values)) {
        nextWorksheetRow.values[sourceIndex] = {
          value: currentValue,
          styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
          className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
        };
      }
    });

    if (isFullMatch) {
      const replacementComment = normalizeText(bestMatch.dictRow[dictIndexes.COMMENT_FR]);
      const replacementFootprint = normalizeText(bestMatch.dictRow[dictIndexes.FOOTPRINT_FR]);

      if (replacementComment) {
        nextRow[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        }
      }

      if (replacementFootprint) {
        nextRow[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        }
      }

      fullMatchCount += 1;
    } else {
      partialMatchCount += 1;
      noMatchCapacitors.push(buildCapacitorMatchDetail(sourceRowIndex, nextRow, bestMatch.dictRowIndex, bestMatch.dictRow, bestMatch.matchCount, bestMatch.matchedFields, bestMatch.mismatchedFields, rawHeaders, dictRawHeaders));
    }

    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    noMatchCapacitors,
    capacitorStats: {
      Stats_Capacitors_Total: totalCount,
      Stats_Capacitors_Full: fullMatchCount,
      Stats_Capacitors_Partial: partialMatchCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function buildCapacitorRotationState(dataCapacitorState, capacitorSheetState) {
  const rawHeaders = Array.isArray(dataCapacitorState && dataCapacitorState.rawHeaders) ? dataCapacitorState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataCapacitorState && dataCapacitorState.rows) ? dataCapacitorState.rows : [];
  const worksheetRows = Array.isArray(dataCapacitorState && dataCapacitorState.worksheetRows) ? dataCapacitorState.worksheetRows : [];
  const dictRawHeaders = Array.isArray(capacitorSheetState && capacitorSheetState.rawHeaders) ? capacitorSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(capacitorSheetState && capacitorSheetState.rows) ? capacitorSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT', 'ROTATION', 'LAYER'];
  const requiredDictColumns = ['COMMENT_FR', 'FOOTPRINT_FR', 'ROTATION_DELTA'];
  const sourceIndexes = {};
  const dictIndexes = {};

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataCapacitor не найдены столбцы: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Capacitor не найдены столбцы: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  let totalCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  let changedCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const sourceComment = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.COMMENT]));
    const sourceFootprint = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.FOOTPRINT]));
    const sourceRotation = clonePnpCellValue(nextRow[sourceIndexes.ROTATION]);
    const sourceLayer = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.LAYER]));
    const matchedDictRowIndex = dictRows.findIndex((dictRow) => (
      normalizeText(clonePnpCellValue(dictRow[dictIndexes.COMMENT_FR])) === sourceComment
      && normalizeText(clonePnpCellValue(dictRow[dictIndexes.FOOTPRINT_FR])) === sourceFootprint
    ));

    totalCount += 1;

    if (matchedDictRowIndex < 0) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const rotationDelta = clonePnpCellValue(dictRows[matchedDictRowIndex][dictIndexes.ROTATION_DELTA]);
    const nextRotation = computeResistorRotationValue(sourceRotation, rotationDelta, sourceLayer);

    if (nextRotation === null) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const currentRotationText = normalizeRotationValue(sourceRotation);
    const nextRotationText = normalizeRotationValue(nextRotation);
    if (currentRotationText !== nextRotationText) {
      changedCount += 1;
    }

    nextRow[sourceIndexes.ROTATION] = nextRotation;
    if (Array.isArray(nextWorksheetRow.values)) {
      nextWorksheetRow.values[sourceIndexes.ROTATION] = nextRotation;
    }

    processedCount += 1;
    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    rotationStats: {
      Stats_Rotation_Total: totalCount,
      Stats_Rotation_Processed: processedCount,
      Stats_Rotation_Skipped: skippedCount,
      Stats_Rotation_Changed: changedCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function buildOtherMatchDetail(sourceRowIndex, sourceRow, dictRowIndex, dictRow, matchCount, matchedFields, mismatchedFields, rawHeaders, dictHeaders) {
  return {
    sourceRowIndex: sourceRowIndex + 1,
    dictRowIndex: dictRowIndex + 1,
    matchCount,
    matchedFields: matchedFields.slice(),
    mismatchedFields: mismatchedFields.slice(),
    source: {
      designator: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'DESIGNATOR')])),
      comment: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'COMMENT')])),
      footprint: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'FOOTPRINT')])),
      rotation: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'ROTATION')])),
      layer: normalizeText(clonePnpCellValue(sourceRow[findResistorColumnIndex(rawHeaders, 'LAYER')]))
    },
    dict: {
      commentFr: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'COMMENT_FR')])),
      footprintFr: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'FOOTPRINT_FR')])),
      rotationDelta: normalizeText(clonePnpCellValue(dictRow[findResistorColumnIndex(dictHeaders, 'ROTATION_DELTA')]))
    }
  };
}

function isPnpPinkCell(cellValue) {
  if (!cellValue || typeof cellValue !== 'object') {
    return false;
  }

  // В таблицах P&P розовая заливка приходит как стиль "полного совпадения".
  return Number(cellValue.styleIndex) === 4 || cellValue.className === 'pnp-resist-full';
}

function buildOtherMatchState(dataOtherState, otherSheetState) {
  const rawHeaders = Array.isArray(dataOtherState && dataOtherState.rawHeaders) ? dataOtherState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataOtherState && dataOtherState.rows) ? dataOtherState.rows : [];
  const worksheetRows = Array.isArray(dataOtherState && dataOtherState.worksheetRows) ? dataOtherState.worksheetRows : [];
  const dictRawHeaders = Array.isArray(otherSheetState && otherSheetState.rawHeaders) ? otherSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(otherSheetState && otherSheetState.rows) ? otherSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT'];
  const requiredDictColumns = ['COMMENT', 'FOOTPRINT', 'COMMENT_FR', 'FOOTPRINT_FR', 'ROTATION_DELTA'];
  const sourceIndexes = {};
  const dictIndexes = {};
  const designatorIndex = findResistorColumnIndex(rawHeaders, 'DESIGNATOR');

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataOther не найдены столбцы: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Other не найдены столбцы: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  const noMatchOthers = [];
  let totalCount = 0;
  let fullMatchCount = 0;
  let partialMatchCount = 0;
  let refMarksCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const designatorValue = designatorIndex >= 0 ? normalizeText(clonePnpCellValue(nextRow[designatorIndex])) : '';
    const sourceValues = {
      COMMENT: normalizeText(clonePnpCellValue(nextRow[sourceIndexes.COMMENT])),
      FOOTPRINT: normalizeText(clonePnpCellValue(nextRow[sourceIndexes.FOOTPRINT]))
    };
    let bestMatch = null;

  totalCount += 1;

  if (designatorValue && designatorValue.toUpperCase().indexOf('REF') === 0) {
    refMarksCount += 1;
  }

  // Уже обработанные строки в VBA помечаются розовым и больше не трогаются.
  if (isPnpPinkCell(nextRow[sourceIndexes.COMMENT]) && isPnpPinkCell(nextRow[sourceIndexes.FOOTPRINT])) {
    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
    return;
  }

  dictRows.forEach((dictRow, dictRowIndex) => {
    const dictValues = {
      COMMENT: normalizeText(clonePnpCellValue(dictRow[dictIndexes.COMMENT])),
      FOOTPRINT: normalizeText(clonePnpCellValue(dictRow[dictIndexes.FOOTPRINT]))
    };
    const matchedFields = [];
    const mismatchedFields = [];

      requiredSourceColumns.forEach((columnName) => {
        const sourceValue = sourceValues[columnName];
        const dictValue = dictValues[columnName];

        if (sourceValue !== '' && dictValue !== '' && sourceValue === dictValue) {
          matchedFields.push(columnName);
        } else if (sourceValue !== '' || dictValue !== '') {
          mismatchedFields.push(columnName);
        }
      });

      const matchCount = matchedFields.length;

      if (!bestMatch || matchCount > bestMatch.matchCount) {
        bestMatch = {
          dictRowIndex,
          dictRow,
          dictValues,
          matchCount,
          matchedFields,
          mismatchedFields
        };
      }
    });

    if (!bestMatch || bestMatch.matchCount < 1) {
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const isFullMatch = bestMatch.matchCount === requiredSourceColumns.length;
    const fullMatchStyle = 4;
    const partialMatchStyle = 5;
    const partialMissStyle = 10;

    requiredSourceColumns.forEach((columnName) => {
      const sourceIndex = sourceIndexes[columnName];
      const isMatched = bestMatch.matchedFields.includes(columnName);
      const currentValue = normalizeText(clonePnpCellValue(nextRow[sourceIndex]));

      nextRow[sourceIndex] = {
        value: currentValue,
        styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
        className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
      };

      if (Array.isArray(nextWorksheetRow.values)) {
        nextWorksheetRow.values[sourceIndex] = {
          value: currentValue,
          styleIndex: isFullMatch ? fullMatchStyle : (isMatched ? partialMatchStyle : partialMissStyle),
          className: isFullMatch ? 'pnp-resist-full' : (isMatched ? 'pnp-resist-match' : 'pnp-resist-miss')
        };
      }
    });

    if (isFullMatch) {
      const replacementComment = normalizeText(bestMatch.dictRow[dictIndexes.COMMENT_FR]);
      const replacementFootprint = normalizeText(bestMatch.dictRow[dictIndexes.FOOTPRINT_FR]);

      // Пустое значение в словаре (COMMENT_FR/FOOTPRINT_FR) означает "не менять",
      // поэтому затираем ячейку только если замена реально задана. Раньше здесь
      // не было такой проверки (в отличие от Resist/Capacitor), из-за чего
      // COMMENT терялся, если в словаре Other для этой строки FR-колонка пустая
      // (например AM1LS-0505SH30-NZ, где COMMENT_FR не задан, а FOOTPRINT_FR есть).
      if (replacementComment) {
        nextRow[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.COMMENT] = buildResistorCellValue(replacementComment, 'full', 4);
        }
      }

      if (replacementFootprint) {
        nextRow[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        if (Array.isArray(nextWorksheetRow.values)) {
          nextWorksheetRow.values[sourceIndexes.FOOTPRINT] = buildResistorCellValue(replacementFootprint, 'full', 4);
        }
      }

      fullMatchCount += 1;
    } else {
      partialMatchCount += 1;
      noMatchOthers.push(buildOtherMatchDetail(sourceRowIndex, nextRow, bestMatch.dictRowIndex, bestMatch.dictRow, bestMatch.matchCount, bestMatch.matchedFields, bestMatch.mismatchedFields, rawHeaders, dictRawHeaders));
    }

    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    noMatchOthers,
    otherStats: {
      Stats_Other_Total: totalCount,
      Stats_Other_Full: fullMatchCount,
      Stats_Other_Partial: partialMatchCount,
      Stats_RefMarks_Count: refMarksCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function buildOtherRotationState(dataOtherState, otherSheetState) {
  const rawHeaders = Array.isArray(dataOtherState && dataOtherState.rawHeaders) ? dataOtherState.rawHeaders.slice() : [];
  const rows = Array.isArray(dataOtherState && dataOtherState.rows) ? dataOtherState.rows : [];
  const worksheetRows = Array.isArray(dataOtherState && dataOtherState.worksheetRows) ? dataOtherState.worksheetRows : [];
  const dictRawHeaders = Array.isArray(otherSheetState && otherSheetState.rawHeaders) ? otherSheetState.rawHeaders.slice() : [];
  const dictRows = Array.isArray(otherSheetState && otherSheetState.rows) ? otherSheetState.rows : [];
  const requiredSourceColumns = ['COMMENT', 'FOOTPRINT', 'ROTATION', 'LAYER'];
  const requiredDictColumns = ['COMMENT_FR', 'FOOTPRINT_FR', 'ROTATION_DELTA'];
  const sourceIndexes = {};
  const dictIndexes = {};

  requiredSourceColumns.forEach((columnName) => {
    sourceIndexes[columnName] = findResistorColumnIndex(rawHeaders, columnName);
  });
  requiredDictColumns.forEach((columnName) => {
    dictIndexes[columnName] = findResistorColumnIndex(dictRawHeaders, columnName);
  });

  const missingSourceColumns = requiredSourceColumns.filter((columnName) => sourceIndexes[columnName] < 0);
  const missingDictColumns = requiredDictColumns.filter((columnName) => dictIndexes[columnName] < 0);

  if (missingSourceColumns.length) {
    throw new Error(`В DataOther не найдены столбцы для расчета ROTATION: ${missingSourceColumns.join(', ')}`);
  }

  if (missingDictColumns.length) {
    throw new Error(`В листе Other не найдены столбцы для расчета ROTATION: ${missingDictColumns.join(', ')}`);
  }

  const nextRows = [];
  const nextWorksheetRows = [];
  let totalCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  let changedCount = 0;

  rows.forEach((sourceRow, sourceRowIndex) => {
    const nextRow = clonePnpRawRow(sourceRow);
    const nextWorksheetRow = worksheetRows[sourceRowIndex]
      ? clonePnpWorksheetRow(worksheetRows[sourceRowIndex])
      : { values: clonePnpRawRow(sourceRow), hidden: false };
    const sourceComment = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.COMMENT]));
    const sourceFootprint = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.FOOTPRINT]));
    const sourceRotation = clonePnpCellValue(nextRow[sourceIndexes.ROTATION]);
    const sourceLayer = normalizeText(clonePnpCellValue(nextRow[sourceIndexes.LAYER]));
    const matchedDictRowIndex = dictRows.findIndex((dictRow) => (
      normalizeText(clonePnpCellValue(dictRow[dictIndexes.COMMENT_FR])) === sourceComment
      && normalizeText(clonePnpCellValue(dictRow[dictIndexes.FOOTPRINT_FR])) === sourceFootprint
    ));

    totalCount += 1;

    if (matchedDictRowIndex < 0) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const rotationDelta = clonePnpCellValue(dictRows[matchedDictRowIndex][dictIndexes.ROTATION_DELTA]);
    const nextRotation = computeResistorRotationValue(sourceRotation, rotationDelta, sourceLayer);

    if (nextRotation === null) {
      skippedCount += 1;
      nextRows.push(nextRow);
      nextWorksheetRows.push(nextWorksheetRow);
      return;
    }

    const currentRotationText = normalizeRotationValue(sourceRotation);
    const nextRotationText = normalizeRotationValue(nextRotation);
    if (currentRotationText !== nextRotationText) {
      changedCount += 1;
    }

    nextRow[sourceIndexes.ROTATION] = nextRotation;
    if (Array.isArray(nextWorksheetRow.values)) {
      nextWorksheetRow.values[sourceIndexes.ROTATION] = nextRotation;
    }

    processedCount += 1;
    nextRows.push(nextRow);
    nextWorksheetRows.push(nextWorksheetRow);
  });

  return {
    rawHeaders,
    rows: nextRows,
    worksheetRows: nextWorksheetRows,
    rotationStats: {
      Stats_Rotation_Total: totalCount,
      Stats_Rotation_Processed: processedCount,
      Stats_Rotation_Skipped: skippedCount,
      Stats_Rotation_Changed: changedCount
    },
    sourceColumnIndexes: sourceIndexes,
    dictColumnIndexes: dictIndexes,
    sourceRowsCount: rows.length,
    dictRowsCount: dictRows.length
  };
}

function buildTableColumnsXml(headers) {
  return headers.map((header, index) => (
    `<tableColumn id="${index + 1}" name="${escapeXml(String(header || `Column${index + 1}`))}"/>`
  )).join('');
}

function buildTableXml(tableName, tableRange, headers, tableId = 1) {
  const safeTableName = String(tableName || 'ImportedCSVTable').trim() || 'ImportedCSVTable';
  const safeTableRange = String(tableRange || 'A1:A1').trim() || 'A1:A1';
  const columns = Array.isArray(headers) && headers.length ? headers.map((header) => normalizeWorkbookHeaderText(header)) : ['COLUMN1'];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
 <table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableId}" name="${escapeXml(safeTableName)}" displayName="${escapeXml(safeTableName)}" ref="${escapeXml(safeTableRange)}" headerRowCount="1" totalsRowShown="false">
   <autoFilter ref="${escapeXml(safeTableRange)}"/>
   <tableColumns count="${columns.length}">
     ${buildTableColumnsXml(columns)}
   </tableColumns>
   <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
 </table>`;
}

function buildWorksheetRelsXml(targetTablePath = '/xl/tables/table1.xml') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="${escapeXml(targetTablePath)}"/>
</Relationships>`;
}

function normalizePnpStatsCount(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizePnpStatsText(value) {
  return normalizeText(value);
}

function normalizePnpStatsErrorText(value) {
  const text = normalizeText(value);

  if (!text) {
    return '';
  }

  return text
    .replace(/,\s*open\s+'[^']+'/ig, '')
    .replace(/\s*->\s*[^|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isPnpTopLayerValue(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/\s+/g, '');
  return normalized === 'toplayer' || normalized === 'top';
}

function isPnpBottomLayerValue(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/\s+/g, '');
  return normalized === 'bottomlayer' || normalized === 'bottom' || normalized === 'bot';
}

function countPnpStatsRows(tableLike, options = {}) {
  const rawHeaders = Array.isArray(tableLike && tableLike.rawHeaders) ? tableLike.rawHeaders : [];
  const rows = Array.isArray(tableLike && tableLike.rows) ? tableLike.rows : [];
  const designatorIndex = findPnpRawHeaderIndex(rawHeaders, 'DESIGNATOR');
  const layerIndex = findPnpRawHeaderIndex(rawHeaders, 'LAYER');
  const layerFilter = String(options.layer || '').trim().toLowerCase();
  const includeRefs = Boolean(options.includeRefs);

  return rows.reduce((count, row) => {
    const rowData = Array.isArray(row) ? row : [];
    const designatorValue = designatorIndex >= 0 ? normalizeText(clonePnpCellValue(rowData[designatorIndex])) : '';
    const isRef = designatorValue.toUpperCase().startsWith('REF');

    if (!includeRefs && isRef) {
      return count;
    }

    if (layerFilter === 'top' && !isPnpTopLayerValue(layerIndex >= 0 ? rowData[layerIndex] : '')) {
      return count;
    }

    if (layerFilter === 'bottom' && !isPnpBottomLayerValue(layerIndex >= 0 ? rowData[layerIndex] : '')) {
      return count;
    }

    return count + 1;
  }, 0);
}

function joinPnpStatsList(values, limit) {
  const items = Array.isArray(values) ? values : [];
  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : items.length;
  const shown = items.slice(0, maxItems).map((item) => normalizePnpStatsText(item)).filter((item) => item !== '');
  if (!shown.length) {
    return '—';
  }
  if (items.length > shown.length) {
    shown.push(`...еще ${items.length - shown.length}`);
  }
  return shown.join(', ');
}

function formatPnpStatsMatchDetail(prefix, item) {
  if (!item) {
    return `${prefix}: —`;
  }

  const source = item.source || {};
  const dict = item.dict || {};
  const sourceParts = [];
  const dictParts = [];
  const matchedFields = joinPnpStatsList(item.matchedFields);
  const mismatchedFields = joinPnpStatsList(item.mismatchedFields);

  Object.keys(source).forEach((key) => {
    const value = normalizePnpStatsText(source[key]);
    if (value !== '') {
      sourceParts.push(`${key}=${value}`);
    }
  });

  Object.keys(dict).forEach((key) => {
    const value = normalizePnpStatsText(dict[key]);
    if (value !== '') {
      dictParts.push(`${key}=${value}`);
    }
  });

  return `${prefix} #${normalizePnpStatsCount(item.sourceRowIndex)} -> #${normalizePnpStatsCount(item.dictRowIndex)} | ${normalizePnpStatsCount(item.matchCount)} | src: ${sourceParts.join(' ; ')} | dict: ${dictParts.join(' ; ')} | matched: ${matchedFields} | miss: ${mismatchedFields}`;
}

function buildPnpStatsSnapshot(importInfo, txtResult, xlsxResult) {
  const info = importInfo || {};
  const sourceTable = info.rawTable || {};
  const dataSet2Table = info.dataSet2Table || {};
  const dataPredExitTable = info.dataPredExitTable || {};
  const resistorStats = info.resistorStats || {};
  const capacitorStats = info.capacitorStats || {};
  const otherStats = info.otherStats || {};
  const resistorRotation = info.rotationStats || {};
  const capacitorRotation = info.rotationCapacitorStats || info.rotationCStats || {};
  const otherRotation = info.rotationOtherStats || info.rotationOStats || {};
  const noMatchResistors = Array.isArray(info.noMatchResistors) ? info.noMatchResistors : [];
  const noMatchCapacitors = Array.isArray(info.noMatchCapacitors) ? info.noMatchCapacitors : [];
  const noMatchOthers = Array.isArray(info.noMatchOthers) ? info.noMatchOthers : [];
  const inflowCount = countPnpStatsRows(sourceTable, { includeRefs: false });
  const inflowTopCount = countPnpStatsRows(sourceTable, { includeRefs: false, layer: 'top' });
  const inflowBottomCount = countPnpStatsRows(sourceTable, { includeRefs: false, layer: 'bottom' });
  const categoryTotal = countPnpStatsRows(dataSet2Table, { includeRefs: false });
  const exitTopCount = countPnpStatsRows(dataPredExitTable, { includeRefs: false, layer: 'top' });
  const exitBottomCount = countPnpStatsRows(dataPredExitTable, { includeRefs: false, layer: 'bottom' });
  const deleteSet0Count = normalizePnpStatsCount(
    (info.filteredSetState && info.filteredSetState.deletedCount) ||
    info.deletedSet0Count ||
    0
  );
  // Для отчёта берём именно удалённые строки Not Fitted + SET=1, а не общий счётчик удаления SET=0.
  const deletedNotFittedCount = normalizePnpStatsCount(
    (info.deleteNotFittedState && info.deleteNotFittedState.deletedCount) ||
    info.deletedNotFittedCount ||
    0
  );
  const resistorFull = normalizePnpStatsCount(resistorStats.Stats_Resistors_Full);
  const resistorPartial = normalizePnpStatsCount(resistorStats.Stats_Resistors_Partial);
  const resistorTotal = categoryTotal;
  const resistorNoMatch = Math.max(0, resistorTotal - resistorFull - resistorPartial);
  const capacitorFull = normalizePnpStatsCount(capacitorStats.Stats_Capacitors_Full);
  const capacitorPartial = normalizePnpStatsCount(capacitorStats.Stats_Capacitors_Partial);
  const capacitorTotal = categoryTotal;
  const capacitorNoMatch = Math.max(0, capacitorTotal - capacitorFull - capacitorPartial);
  const otherFull = normalizePnpStatsCount(otherStats.Stats_Other_Full);
  const otherPartial = normalizePnpStatsCount(otherStats.Stats_Other_Partial);
  const otherTotal = categoryTotal;
  const otherNoMatch = Math.max(0, otherTotal - otherFull - otherPartial);
  const totalFull = resistorFull + capacitorFull + otherFull;
  const totalPartial = resistorPartial + capacitorPartial + otherPartial;
  const totalNoMatch = Math.max(0, categoryTotal - (resistorFull + resistorPartial) - (capacitorFull + capacitorPartial) - (otherFull + otherPartial));
  const refMarksCount = normalizePnpStatsCount(otherStats.Stats_RefMarks_Count || info.refMarksCount || 0);
  const txtSaved = txtResult && Array.isArray(txtResult.saved) ? txtResult.saved : [];
  const txtErrors = txtResult && Array.isArray(txtResult.errors) ? txtResult.errors : [];
  const xlsxPath = xlsxResult && xlsxResult.path ? normalizePnpStatsText(xlsxResult.path) : '';
  const xlsxFileName = xlsxResult && xlsxResult.fileName ? normalizePnpStatsText(xlsxResult.fileName) : '';
  const nowText = new Date().toLocaleString('ru-RU');
  const formatPercent = (value, base) => (base > 0 ? (value / base * 100).toFixed(1) : '0.0');

  const summaryLines = [
    'ИТОГИ ОБРАБОТКИ КОМПОНЕНТОВ',
    `Дата: ${nowText}`,
    '',
    '[R] РЕЗИСТОРЫ:',
    `Всего: ${resistorTotal}`,
    `Полных совпадений (4/4): ${resistorFull}`,
    `Частичных (3/4): ${resistorPartial}`,
    `Без совпадений: ${resistorNoMatch}`,
    '',
    '[C] КОНДЕНСАТОРЫ:',
    `Всего: ${capacitorTotal}`,
    `Полных совпадений (3/3): ${capacitorFull}`,
    `Частичных (2/3): ${capacitorPartial}`,
    `Без совпадений: ${capacitorNoMatch}`,
    '',
    '[O] ПРОЧИЕ:',
    `Всего: ${otherTotal}`,
    `Полных совпадений (2/2): ${otherFull}`,
    `Частичных (1/2): ${otherPartial}`,
    `Без совпадений: ${otherNoMatch}`,
    '',
    '[=] ИТОГО:',
    `Входимость элементов: ${inflowCount}`,
    `Всего: ${categoryTotal}`,
    `Полных: ${totalFull} (${formatPercent(totalFull, categoryTotal)}%)`,
    `Частичных: ${totalPartial} (${formatPercent(totalPartial, categoryTotal)}%)`,
    `Без совпадений: ${totalNoMatch} (${formatPercent(totalNoMatch, categoryTotal)}%)`,
    '',
    `[*] В проекте ${refMarksCount} реперных знаков.`,
    '',
    `[*] Delete SET=0: ${deleteSet0Count} компонентов.`,
    `[*] Удалено Not Fitted + SET=1: ${deletedNotFittedCount} компонентов.`,
    '',
    '=== СТАТИСТИКА ПЕРЕИМЕНОВАНИЯ И ПОВОРОТА ===',
    `Входимость элементов: ${inflowCount}`,
    `Входимость компонентов TOP: ${inflowTopCount}`,
    `Входимость компонентов BOT: ${inflowBottomCount}`,
    `Выход компонентов TOP: ${exitTopCount}`,
    `Выход компонентов BOT: ${exitBottomCount}`,
    '',
    '=== Rotation ===',
    `Resistor: Changed ${normalizePnpStatsCount(resistorRotation.Stats_Rotation_Changed)}`,
    `Capacitor: Changed ${normalizePnpStatsCount(capacitorRotation.Stats_Rotation_Changed)}`,
    `Other: Changed ${normalizePnpStatsCount(otherRotation.Stats_Rotation_Changed)}`,
    '',
    '=== ЧАСТИЧНЫЕ И БЕЗ СОВПАДЕНИЙ ==='
  ];

  if (txtSaved.length) {
    txtSaved.forEach((entry) => {
      const targetLabel = entry && entry.label ? entry.label : (entry && entry.folder ? entry.folder : 'TXT');
      const targetPath = entry && entry.path ? normalizePnpStatsText(entry.path) : '';
      summaryLines.push(`${targetLabel}: УСПЕШНО${targetPath ? ` -> ${targetPath}` : ''}`);
    });
  }

  if (txtErrors.length) {
    summaryLines.push('Ошибки TXT:');
    txtErrors.forEach((entry) => {
      const targetLabel = entry && entry.label ? entry.label : (entry && entry.folder ? entry.folder : 'TXT');
      const message = entry && entry.message ? normalizePnpStatsErrorText(entry.message) : 'Неизвестная ошибка.';
      summaryLines.push(`${targetLabel}: ${message}`);
    });
  }

  if (xlsxResult && xlsxPath) {
    summaryLines.push(`Экспорт XLSX: УСПЕШНО${xlsxFileName ? ` (${xlsxFileName})` : ''} -> ${xlsxPath}`);
  } else if (xlsxResult && xlsxResult.errorMessage) {
    summaryLines.push(`Экспорт XLSX: ${normalizePnpStatsErrorText(xlsxResult.errorMessage)}`);
  } else {
    summaryLines.push('Экспорт XLSX: не сохранен.');
  }

  const sheetRows = [];
  const pushLine = (text, styleIndex) => {
    if (styleIndex) {
      sheetRows.push([{ value: text, styleIndex: styleIndex, preserveEmpty: true }]);
    } else {
      sheetRows.push([text]);
    }
  };
  const pushBlank = () => {
    sheetRows.push(['']);
  };

  pushLine('ИТОГИ ОБРАБОТКИ КОМПОНЕНТОВ', 3);
  pushLine(`Дата: ${nowText}`);
  pushBlank();
  pushLine('[R] РЕЗИСТОРЫ:', 4);
  pushLine(`Всего: ${resistorTotal}`);
  pushLine(`Полных совпадений (4/4): ${resistorFull}`);
  pushLine(`Частичных (3/4): ${resistorPartial}`);
  pushLine(`Без совпадений: ${resistorNoMatch}`);
  pushBlank();
  pushLine('[C] КОНДЕНСАТОРЫ:', 4);
  pushLine(`Всего: ${capacitorTotal}`);
  pushLine(`Полных совпадений (3/3): ${capacitorFull}`);
  pushLine(`Частичных (2/3): ${capacitorPartial}`);
  pushLine(`Без совпадений: ${capacitorNoMatch}`);
  pushBlank();
  pushLine('[O] ПРОЧИЕ:', 4);
  pushLine(`Всего: ${otherTotal}`);
  pushLine(`Полных совпадений (2/2): ${otherFull}`);
  pushLine(`Частичных (1/2): ${otherPartial}`);
  pushLine(`Без совпадений: ${otherNoMatch}`);
  pushBlank();
  pushLine('[=] ИТОГО:', 5);
  pushLine(`Входимость элементов: ${inflowCount}`);
  pushLine(`Всего: ${categoryTotal}`);
  pushLine(`Полных: ${totalFull} (${formatPercent(totalFull, categoryTotal)}%)`);
  pushLine(`Частичных: ${totalPartial} (${formatPercent(totalPartial, categoryTotal)}%)`);
  pushLine(`Без совпадений: ${totalNoMatch} (${formatPercent(totalNoMatch, categoryTotal)}%)`);
  pushBlank();
  pushLine(`[*] В проекте ${refMarksCount} реперных знаков.`, 5);
  pushBlank();
  pushLine(`[*] Delete SET=0: ${deleteSet0Count} компонентов.`, 4);
  pushLine(`[*] Удалено Not Fitted + SET=1: ${deletedNotFittedCount} компонентов.`, 4);
  pushBlank();
  pushLine('=== СТАТИСТИКА ПЕРЕИМЕНОВАНИЯ И ПОВОРОТА ===', 3);
  pushLine(`Входимость элементов: ${inflowCount}`);
  pushLine(`Входимость компонентов TOP: ${inflowTopCount}`);
  pushLine(`Входимость компонентов BOT: ${inflowBottomCount}`);
  pushLine(`Выход компонентов TOP: ${exitTopCount}`);
  pushLine(`Выход компонентов BOT: ${exitBottomCount}`);
  pushBlank();
  pushLine('=== Rotation ===', 3);
  pushLine(`Resistor: Changed ${normalizePnpStatsCount(resistorRotation.Stats_Rotation_Changed)}`);
  pushLine(`Capacitor: Changed ${normalizePnpStatsCount(capacitorRotation.Stats_Rotation_Changed)}`);
  pushLine(`Other: Changed ${normalizePnpStatsCount(otherRotation.Stats_Rotation_Changed)}`);
  pushBlank();
  pushLine('=== ЧАСТИЧНЫЕ И БЕЗ СОВПАДЕНИЙ ===', 3);
  if (noMatchResistors.length) {
    pushLine('[R] Резисторы:', 4);
    noMatchResistors.forEach((item) => {
      pushLine(formatPnpStatsMatchDetail('R', item));
    });
  } else {
    pushLine('[R] Резисторы: нет.', 4);
  }
  if (noMatchCapacitors.length) {
    pushLine('[C] Конденсаторы:', 4);
    noMatchCapacitors.forEach((item) => {
      pushLine(formatPnpStatsMatchDetail('C', item));
    });
  } else {
    pushLine('[C] Конденсаторы: нет.', 4);
  }
  if (noMatchOthers.length) {
    pushLine('[O] Прочие:', 4);
    noMatchOthers.forEach((item) => {
      pushLine(formatPnpStatsMatchDetail('O', item));
    });
  } else {
    pushLine('[O] Прочие: нет.', 4);
  }
  pushBlank();
  pushLine('=== РЕЗУЛЬТАТ СОХРАНЕНИЯ ФАЙЛОВ ===', 5);
  if (txtSaved.length) {
    txtSaved.forEach((entry) => {
      const targetLabel = entry && entry.label ? entry.label : (entry && entry.folder ? entry.folder : 'TXT');
      const targetPath = entry && entry.path ? normalizePnpStatsText(entry.path) : '';
      pushLine(`${targetLabel}: УСПЕШНО${targetPath ? ` -> ${targetPath}` : ''}`);
    });
  }
  if (txtErrors.length) {
    pushLine('Ошибки TXT:', 4);
    txtErrors.forEach((entry) => {
      const targetLabel = entry && entry.label ? entry.label : (entry && entry.folder ? entry.folder : 'TXT');
      const message = entry && entry.message ? normalizePnpStatsErrorText(entry.message) : 'Неизвестная ошибка.';
      pushLine(`${targetLabel}: ${message}`);
    });
  }
  if (xlsxResult && xlsxPath) {
    pushLine(`Экспорт XLSX: УСПЕШНО${xlsxFileName ? ` (${xlsxFileName})` : ''} -> ${xlsxPath}`);
  } else if (xlsxResult && xlsxResult.errorMessage) {
    pushLine(`Экспорт XLSX: ${normalizePnpStatsErrorText(xlsxResult.errorMessage)}`);
  } else {
    pushLine('Экспорт XLSX: не сохранен.');
  }

  return {
    summaryLines,
    sheetRows
  };
}

function buildPnpXlsxBuffer(importInfo, sourcePath, options = {}) {
  const tableInfo = importInfo && importInfo.rawTable ? importInfo.rawTable : null;
  const dataHeaders = Array.isArray(tableInfo && tableInfo.rawHeaders) ? tableInfo.rawHeaders : [];
  const dataRows = Array.isArray(tableInfo && tableInfo.rows) ? tableInfo.rows : [];
  const workbookHeaders = dataHeaders.map((header) => normalizeWorkbookHeaderText(header));
  const columnKinds = dataHeaders.map((header) => normalizeImportedColumnKind(header));
  // Лист 1 остается исходной таблицей, а DataSet — ее копией по VBA-логике.
  const listSheetRows = [
    workbookHeaders
  ].concat(dataRows.map((row) => row.map((value) => String(value))));
  const infoSheetRows = buildInfoSheetRows(importInfo || {}, sourcePath);
  const dataSetState = tableInfo
    ? buildDataSetTableState({
        ...importInfo,
        rawTable: tableInfo
      }, {
        infoD3: importInfo && importInfo.infoD3 ? importInfo.infoD3 : ''
      })
    : null;
  const dataSetTable = dataSetState
    ? {
        rawHeaders: Array.isArray(dataSetState.rawHeaders) ? dataSetState.rawHeaders : dataHeaders,
        rows: Array.isArray(dataSetState.rows) ? dataSetState.rows : [],
        worksheetRows: Array.isArray(dataSetState.worksheetRows) ? dataSetState.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataSet2State = dataSetState ? buildDataSet2TableState(dataSetState) : null;
  const dataSet2Table = dataSet2State
    ? {
        rawHeaders: Array.isArray(dataSet2State.rawHeaders) ? dataSet2State.rawHeaders : dataHeaders,
        rows: Array.isArray(dataSet2State.rows) ? dataSet2State.rows : [],
        worksheetRows: Array.isArray(dataSet2State.worksheetRows) ? dataSet2State.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataResistState = importInfo && importInfo.dataResistTable
    ? importInfo.dataResistTable
    : (dataSet2State ? buildDataResistTableState(dataSet2State) : null);
  const dataResistTable = dataResistState
    ? {
        rawHeaders: Array.isArray(dataResistState.rawHeaders) ? dataResistState.rawHeaders : dataHeaders,
        rows: Array.isArray(dataResistState.rows) ? dataResistState.rows : [],
        worksheetRows: Array.isArray(dataResistState.worksheetRows) ? dataResistState.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataCapacitorState = importInfo && importInfo.dataCapacitorTable ? importInfo.dataCapacitorTable : null;
  const dataCapacitorTable = dataCapacitorState
    ? {
        rawHeaders: Array.isArray(dataCapacitorState.rawHeaders) ? dataCapacitorState.rawHeaders : dataHeaders,
        rows: Array.isArray(dataCapacitorState.rows) ? dataCapacitorState.rows : [],
        worksheetRows: Array.isArray(dataCapacitorState.worksheetRows) ? dataCapacitorState.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataOtherState = importInfo && importInfo.dataOtherTable ? importInfo.dataOtherTable : null;
  const dataOtherTable = dataOtherState
    ? {
        rawHeaders: Array.isArray(dataOtherState.rawHeaders) ? dataOtherState.rawHeaders : dataHeaders,
        rows: Array.isArray(dataOtherState.rows) ? dataOtherState.rows : [],
        worksheetRows: Array.isArray(dataOtherState.worksheetRows) ? dataOtherState.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataPredExitState = importInfo && importInfo.dataPredExitTable
    ? importInfo.dataPredExitTable
    : (dataOtherState ? buildDataPredExitTableState(dataOtherState) : null);
  const dataPredExitTable = dataPredExitState
    ? {
        rawHeaders: Array.isArray(dataPredExitState.rawHeaders) ? dataPredExitState.rawHeaders : dataHeaders,
        rows: Array.isArray(dataPredExitState.rows) ? dataPredExitState.rows : [],
        worksheetRows: Array.isArray(dataPredExitState.worksheetRows) ? dataPredExitState.worksheetRows : []
      }
    : {
        rawHeaders: dataHeaders,
        rows: [],
        worksheetRows: []
      };
  const dataExitState = importInfo && importInfo.dataExitTable
    ? importInfo.dataExitTable
    : (dataPredExitState ? buildDataExitTableState(dataPredExitState, importInfo || {}) : null);
  const statsRows = Array.isArray(options && options.statsRows) ? options.statsRows : [];
  const buildSheetRows = (tableState) => ([
    Array.isArray(tableState && tableState.rawHeaders) && tableState.rawHeaders.length ? tableState.rawHeaders : workbookHeaders
  ].concat((Array.isArray(tableState.worksheetRows) && tableState.worksheetRows.length
    ? tableState.worksheetRows.map((row) => row)
    : (Array.isArray(tableState.rows) ? tableState.rows : []).map((row) => row.map((value) => String(value))))));
  const dataSetSheetRows = buildSheetRows(dataSetTable);
  const dataSet2SheetRows = buildSheetRows(dataSet2Table);
  const dataResistSheetRows = buildSheetRows(dataResistTable);
  const dataCapacitorSheetRows = buildSheetRows(dataCapacitorTable);
  const dataOtherSheetRows = buildSheetRows(dataOtherTable);
  const dataPredExitSheetRows = buildSheetRows(dataPredExitTable);
  const dataExitSheetRows = dataExitState
    ? dataExitState.rows
    : [];
  const tableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(listSheetRows.length, 1)}`;
  const dataSetTableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataSetSheetRows.length, 1)}`;
  const dataSet2TableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataSet2SheetRows.length, 1)}`;
  const dataResistTableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataResistSheetRows.length, 1)}`;
  const dataCapacitorTableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataCapacitorSheetRows.length, 1)}`;
  const dataOtherTableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataOtherSheetRows.length, 1)}`;
  const dataPredExitHeaders = Array.isArray(dataPredExitTable.rawHeaders) && dataPredExitTable.rawHeaders.length
    ? dataPredExitTable.rawHeaders
    : dataHeaders;
  const dataPredExitTableRange = `A1:${columnIndexToLetters(Math.max(dataPredExitHeaders.length, 1) - 1)}${Math.max(dataPredExitSheetRows.length, 1)}`;
  const dataPredExitColumnKinds = dataPredExitHeaders.map((header) => normalizeImportedColumnKind(header));
  const dataPredExitColumnWidths = measureWorkbookColumnWidths(dataPredExitSheetRows);
  const dataExitColumnKinds = [];
  const statsColumnWidths = measureWorkbookColumnWidths(statsRows, { maxWidth: 255 });
  const columnWidths = measureWorkbookColumnWidths(listSheetRows);
  const setState = importInfo && importInfo.setColumnState ? importInfo.setColumnState : null;
  const highlightColumnIndex = setState && setState.fillApplied && Number.isInteger(setState.columnIndex)
    ? setState.columnIndex
    : -1;
  const sheetNames = ['Лист1', 'Info', 'DataSet', 'DataSet2', 'DataResist', 'DataCapacitor', 'DataOther', 'DataPredExit', 'DataExit'];
  if (statsRows.length) {
    sheetNames.push('Stats');
  }

  return buildZipArchive([
    { path: '[Content_Types].xml', content: buildContentTypesXml(sheetNames.length, 7) },
    { path: '_rels/.rels', content: buildRelsXml() },
    { path: 'docProps/core.xml', content: buildCorePropsXml(importInfo, sourcePath) },
    { path: 'docProps/app.xml', content: buildAppPropsXml(sheetNames) },
    { path: 'xl/workbook.xml', content: buildWorkbookXml(sheetNames) },
    { path: 'xl/_rels/workbook.xml.rels', content: buildWorkbookRelsXml(sheetNames) },
    { path: 'xl/styles.xml', content: buildStylesXml() },
    { path: 'xl/worksheets/sheet1.xml', content: buildWorksheetXml(listSheetRows, columnKinds, { tableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet1.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table1.xml') },
    { path: 'xl/tables/table1.xml', content: buildTableXml('ImportedCSVTable', tableRange, dataHeaders, 1) },
    { path: 'xl/worksheets/sheet2.xml', content: buildWorksheetXml(infoSheetRows) },
    { path: 'xl/worksheets/sheet3.xml', content: buildWorksheetXml(dataSetSheetRows, columnKinds, { tableRange: dataSetTableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet3.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table2.xml') },
    { path: 'xl/tables/table2.xml', content: buildTableXml('DataSetTable', dataSetTableRange, dataHeaders, 2) },
    { path: 'xl/worksheets/sheet4.xml', content: buildWorksheetXml(dataSet2SheetRows, columnKinds, { tableRange: dataSet2TableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet4.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table3.xml') },
    { path: 'xl/tables/table3.xml', content: buildTableXml('DataSet2Table', dataSet2TableRange, dataHeaders, 3) },
    { path: 'xl/worksheets/sheet5.xml', content: buildWorksheetXml(dataResistSheetRows, columnKinds, { tableRange: dataResistTableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet5.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table4.xml') },
    { path: 'xl/tables/table4.xml', content: buildTableXml('DataResistTable', dataResistTableRange, dataHeaders, 4) },
    { path: 'xl/worksheets/sheet6.xml', content: buildWorksheetXml(dataCapacitorSheetRows, columnKinds, { tableRange: dataCapacitorTableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet6.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table5.xml') },
    { path: 'xl/tables/table5.xml', content: buildTableXml('DataCapacitorTable', dataCapacitorTableRange, dataHeaders, 5) },
    { path: 'xl/worksheets/sheet7.xml', content: buildWorksheetXml(dataOtherSheetRows, columnKinds, { tableRange: dataOtherTableRange, columnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet7.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table6.xml') },
    { path: 'xl/tables/table6.xml', content: buildTableXml('DataOtherTable', dataOtherTableRange, dataHeaders, 6) },
    { path: 'xl/worksheets/sheet8.xml', content: buildWorksheetXml(dataPredExitSheetRows, dataPredExitColumnKinds, { tableRange: dataPredExitTableRange, columnWidths: dataPredExitColumnWidths, highlightColumnIndex }) },
    { path: 'xl/worksheets/_rels/sheet8.xml.rels', content: buildWorksheetRelsXml('/xl/tables/table7.xml') },
    { path: 'xl/tables/table7.xml', content: buildTableXml('DataPredExitTable', dataPredExitTableRange, dataPredExitTable.rawHeaders, 7) },
    { path: 'xl/worksheets/sheet9.xml', content: buildWorksheetXml(dataExitSheetRows, dataExitColumnKinds, { firstRowAsHeaders: false, columnWidths: [], highlightColumnIndex: -1 }) },
    ...(statsRows.length ? [{ path: 'xl/worksheets/sheet10.xml', content: buildWorksheetXml(statsRows, [], { firstRowAsHeaders: false, columnWidths: statsColumnWidths, highlightColumnIndex: -1 }) }] : [])
  ]);
}

function buildContentTypesXml(sheetCount, tableCount = 1) {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');
  const tableOverrides = Array.from({ length: tableCount }, (_, index) => (
    `<Override PartName="/xl/tables/table${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${tableOverrides}
  ${worksheetOverrides}
</Types>`;
}

function buildRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildWorkbookXml(sheetNames) {
  const sheetsXml = sheetNames.map((sheetName, index) => (
    `<sheet name="${escapeXml(sheetName)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetsXml}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheetNames) {
  const sheetRels = sheetNames.map((_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheetNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
  </fonts>
  <fills count="9">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFC8"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFF1111"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFC8"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="11">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="8" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function buildAppPropsXml(sheetNames) {
  const headingPairs = sheetNames.map((sheetName, index) => (
    `<vt:lpstr>${escapeXml(sheetName)}</vt:lpstr>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>ASM Project Generator</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Листы</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="${sheetNames.length}" baseType="lpstr">
      ${headingPairs}
    </vt:vector>
  </TitlesOfParts>
</Properties>`;
}

function buildCorePropsXml(importInfo, sourcePath) {
  const title = String(importInfo && (importInfo.infoD7 || importInfo.baseName) ? (importInfo.infoD7 || importInfo.baseName) : 'Pick and Place');
  const created = new Date().toISOString();

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>Новожилов Артем</dc:creator>
  <cp:lastModifiedBy>Новожилов Артем</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
  <dc:description>${escapeXml(sourcePath || '')}</dc:description>
</cp:coreProperties>`;
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);

  return { dosTime, dosDate };
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let crc = index;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }

    table[index] = crc >>> 0;
  }

  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;

  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = toDosDateTime();

  entries.forEach((entry) => {
    const fileName = String(entry.path).replace(/\\/g, '/');
    const fileNameBuffer = Buffer.from(fileName, 'utf8');
    const contentBuffer = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content), 'utf8');
    const crc = crc32(contentBuffer);
    const localHeader = Buffer.alloc(30 + fileNameBuffer.length);
    const centralHeader = Buffer.alloc(46 + fileNameBuffer.length);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(timestamp.dosTime, 10);
    localHeader.writeUInt16LE(timestamp.dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileNameBuffer.copy(localHeader, 30);

    localParts.push(localHeader, contentBuffer);

    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(timestamp.dosTime, 12);
    centralHeader.writeUInt16LE(timestamp.dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    fileNameBuffer.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + contentBuffer.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const localFiles = Buffer.concat(localParts);
  const endRecord = Buffer.alloc(22);

  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localFiles.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localFiles, centralDirectory, endRecord]);
}

async function savePnpXlsxFile(targetFolder, baseName, importInfo, sourcePath, options = {}) {
  const workbookStem = String(baseName || (importInfo && importInfo.infoD7) || 'pnp_export_v300').trim() || 'pnp_export_v300';
  const workbookName = `${workbookStem}.xlsx`;
  const targetPath = path.join(targetFolder, workbookName);
  let nextImportInfo = importInfo || {};

  if (nextImportInfo && nextImportInfo.dataSet2Table) {
    const dictXlsxPath = String((options && options.dictXlsxPath) || nextImportInfo.dictXlsxPath || '').trim();

    if (dictXlsxPath) {
      // Для Excel-файла повторяем сравнение с Resist, чтобы стили ушли именно в книгу.
      const resistorDict = await loadResistDictXlsxFile(dictXlsxPath);
      const resistorState = buildResistorMatchState(nextImportInfo.dataSet2Table, resistorDict);
      const rotationState = buildResistorRotationState(resistorState, resistorDict);

      nextImportInfo = {
        ...nextImportInfo,
        dataResistTable: {
          rawHeaders: Array.isArray(rotationState.rawHeaders) ? rotationState.rawHeaders.slice() : [],
          rows: rotationState.rows,
          worksheetRows: rotationState.worksheetRows
        },
        noMatchResistors: resistorState.noMatchResistors,
        resistorStats: resistorState.resistorStats,
        rotationStats: rotationState.rotationStats,
        dictWorkbook: resistorDict.workbook
      };
    }
  }

  const workbookBuffer = buildPnpXlsxBuffer(nextImportInfo || {}, sourcePath || '', {
    statsRows: Array.isArray(options.statsRows) ? options.statsRows : []
  });

  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(targetPath, workbookBuffer);

  return {
    path: targetPath,
    fileName: workbookName
  };
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
<title>Pick and Place ${APP_VERSION} Preview</title>
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
    <h1>Pick and Place ${APP_VERSION}</h1>
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
    ` * Версия: ${APP_VERSION}`,
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

async function loadDictSheetXlsxFile(filePath, sheetName, description) {
  const resolvedPath = path.resolve(filePath);
  try {
    const fileStat = await fs.stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new Error(`Файл Dict.xlsx не найден по указанному пути: ${resolvedPath}\nУкажите точный путь, включая имя файла.`);
    }
  } catch {
    throw new Error(`Файл Dict.xlsx не найден по указанному пути: ${resolvedPath}\nУкажите точный путь, включая имя файла.`);
  }

  const sheetState = await readXlsxSheetRows(resolvedPath, sheetName);
  const rawHeaders = Array.isArray(sheetState.rows) && sheetState.rows.length ? sheetState.rows[0].slice() : [];
  const dataRows = Array.isArray(sheetState.rows) ? sheetState.rows.slice(1) : [];

  return {
    description: description || `Лист ${sheetName} из Dict.xlsx`,
    version: APP_VERSION,
    author: 'Новожилов Артем',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
      sourcePath: resolvedPath,
      sourceFile: path.basename(resolvedPath),
      mode: 'xlsx',
      sheetName: sheetName
    },
    sheetName: sheetName,
    rawHeaders,
    rows: dataRows,
    worksheetRows: dataRows.map((row) => ({
      values: clonePnpRawRow(row),
      hidden: false
    })),
    workbook: {
      sheetName: sheetState.sheetName,
      rowCount: dataRows.length
    }
  };
}

async function loadResistDictXlsxFile(filePath) {
  return loadDictSheetXlsxFile(filePath, 'Resist', 'Лист Resist из Dict.xlsx');
}

async function loadCapacitorDictXlsxFile(filePath) {
  return loadDictSheetXlsxFile(filePath, 'Capacitor', 'Лист Capacitor из Dict.xlsx');
}

async function loadOtherDictXlsxFile(filePath) {
  return loadDictSheetXlsxFile(filePath, 'Other', 'Лист Other из Dict.xlsx');
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
  const deletePcbState = getDeletePcbRowsState(imported.importInfo.rawTable);
  const dataSet2State = buildDataSet2TableState({
    rawHeaders: Array.isArray(imported.importInfo.rawTable.rawHeaders) ? imported.importInfo.rawTable.rawHeaders.slice() : [],
    rows: deletePcbState.rows,
    worksheetRows: deletePcbState.rows.map((row) => ({
      values: clonePnpRawRow(row),
      hidden: false
    }))
  });
  const dict = prepareDict(imported, {
    sourcePath: filePath,
    sourceFile: path.basename(filePath),
    mode: 'csv'
  });

  const baseName = deriveImportBaseName(filePath);
  const infoD7 = generateFileNameFromVariant(getCsvCellAtLine(sourceText, 10, 0), filePath, '', null, baseName);

  return {
    ...dict,
    importInfo: {
      ...imported.importInfo,
      dataSetTable: {
        ...imported.importInfo.rawTable,
        rows: deletePcbState.rows
      },
      dataSet2Table: dataSet2State,
      dataResistTable: buildDataResistTableState(dataSet2State),
      deletedPcbRowsCount: deletePcbState.deletedCount,
      deletePcbState,
      sourcePath: filePath,
      sourceFile: path.basename(filePath),
      baseName,
      workbookName: `${baseName}.xlsx`,
      infoSheetName: 'Info',
      infoD3: '',
      infoD5: getCsvCellAtLine(sourceText, 10, 0),
      infoD6: filePath,
      infoD7,
      importedTableName: 'ImportedCSVTable',
      deletedHeaderRows: 12,
      commentColumn: 3,
      footprintColumn: 5,
      textNumberFormatColumns: [2, 3, 5, 6, 7],
      sheetNames: ['Info', 'ImportedCSVTable', 'DataSet', 'DataSet2', 'DataResist', 'DataCapacitor', 'DataOther', 'DataPredExit', 'DataExit', 'Stats'],
      tableName: 'ImportedCSVTable',
      activeSheet: 'DataSet2',
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      centerXColumnIndex: centerColumns.centerX,
      centerYColumnIndex: centerColumns.centerY,
      headers: parsed.rawHeaders,
      tableRange: `A1:${columnIndexToLetters(Math.max(parsed.rawHeaders.length, 1) - 1)}${Math.max(parsed.rows.length + 1, 1)}`
    }
  };
}

function normalizePnpExportStem(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.txt$/i, '')
    .trim();
}

function buildDataExitTxtContent(dataExitTable) {
  const rows = Array.isArray(dataExitTable && dataExitTable.rows) ? dataExitTable.rows : [];
  const lines = [];

  // Первая и вторая строки идут без дополнительной обработки, а ниже уже повторяем VBA-логику Trim.
  rows.forEach((row, index) => {
    const cells = Array.isArray(row) ? row : [];
    const rawLine = cells.map((cell) => {
      const cellValue = clonePnpCellValue(cell);
      return String(cellValue === null || cellValue === undefined ? '' : cellValue);
    }).join(' ');

    if (index < 2) {
      lines.push(rawLine);
      return;
    }

    const trimmedCells = cells.map((cell) => normalizeText(clonePnpCellValue(cell)));
    if (!trimmedCells.some((cell) => cell !== '')) {
      return;
    }

    lines.push(trimmedCells.join(' ').trim());
  });

  return lines.join('\r\n');
}

async function saveDataExitTxtOutputs(targetFolders, dataExitTable, fileStem, sourcePath) {
  const txtStem = normalizePnpExportStem(fileStem) || 'pnp_export_v300';
  const fileName = txtStem.toLowerCase().endsWith('.txt') ? txtStem : `${txtStem}.txt`;
  const content = buildDataExitTxtContent(dataExitTable);
  const normalizedFolders = [];
  const seenFolders = new Set();

  for (const folder of Array.isArray(targetFolders) ? targetFolders : []) {
    const normalizedFolder = String(folder || '').trim();
    if (!normalizedFolder || seenFolders.has(normalizedFolder)) {
      continue;
    }
    seenFolders.add(normalizedFolder);
    normalizedFolders.push(normalizedFolder);
  }

  const result = {
    fileName,
    content,
    saved: [],
    errors: []
  };

  for (const targetFolder of normalizedFolders) {
    const targetPath = path.join(targetFolder, fileName);

    try {
      if (sourcePath && path.resolve(targetPath) === path.resolve(sourcePath)) {
        throw new Error(`Отказ от записи в исходный файл: ${targetPath}`);
      }

      await fs.writeFile(targetPath, content, 'utf8');
      result.saved.push({
        folder: targetFolder,
        path: targetPath,
        fileName
      });
    } catch (error) {
      result.errors.push({
        folder: targetFolder,
        path: targetPath,
        message: error && error.message ? error.message : String(error || 'Неизвестная ошибка записи TXT.')
      });
    }
  }

  return result;
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
  const exportXlsxFolder = String(options.exportXlsxFolder || '').trim();
  const txtFolders = Array.isArray(options.txtFolders) ? options.txtFolders : [];
  const importInfo = options.importInfo || prepared.importInfo || null;
  const xlsxBaseName = String((importInfo && (importInfo.infoD7 || importInfo.baseName)) || options.exportXlsxStem || exportStem).trim() || exportStem;
  let exportXlsxResult = null;
  let txtResult = null;

  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(exportDictPath, buildModuleSource(prepared, 'Экспортированный словарь P&P'), 'utf8');
  await fs.writeFile(exportCsvPath, buildCsv(prepared), 'utf8');
  await fs.writeFile(exportHtmlPath, buildPreviewHtml(prepared), 'utf8');

  if (exportXlsxFolder) {
    exportXlsxResult = await savePnpXlsxFile(exportXlsxFolder, xlsxBaseName, importInfo, options.sourcePath || '', {
      dictXlsxPath: options.dictXlsxPath || ''
    });
  }

  if (txtFolders.length && importInfo && importInfo.dataExitTable) {
    txtResult = await saveDataExitTxtOutputs(
      txtFolders,
      importInfo.dataExitTable,
      options.exportTxtStem || (importInfo && importInfo.infoD7 ? importInfo.infoD7 : exportStem),
      options.sourcePath || ''
    );
  }

  return {
    targetFolder,
    exportXlsxFolder,
    stats: getStats(prepared),
    files: [
      { fileName: path.basename(exportDictPath), path: exportDictPath, kind: 'dict' },
      { fileName: path.basename(exportCsvPath), path: exportCsvPath, kind: 'csv' },
      { fileName: path.basename(exportHtmlPath), path: exportHtmlPath, kind: 'html' },
      ...(exportXlsxResult ? [{ fileName: exportXlsxResult.fileName, path: exportXlsxResult.path, kind: 'xlsx' }] : []),
      ...(txtResult ? txtResult.saved.map((item) => ({
        fileName: item.fileName,
        path: item.path,
        kind: 'txt'
      })) : [])
    ],
    txt: txtResult,
    dict: prepared,
    importInfo,
    xlsx: exportXlsxResult
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
  buildPnpStatsSnapshot,
  normalizePnpExportStem,
  buildDataExitTxtContent,
  saveDataExitTxtOutputs,
  buildModuleSource,
  buildDataSetTableState,
  buildDataSet2TableState,
  buildDataResistTableState,
  loadResistDictXlsxFile,
  loadCapacitorDictXlsxFile,
  loadOtherDictXlsxFile,
  buildResistorMatchState,
  buildResistorRotationState,
  buildCapacitorMatchState,
  buildCapacitorRotationState,
  buildOtherMatchState,
  buildOtherRotationState,
  buildDataPredExitTableState,
  buildDataExitTableState,
  DEFAULT_IMPORT_START_DIR,
  decodeSourceBuffer,
  loadDictFile,
  loadStateFile,
  saveDictFile,
  saveStateFile,
  savePnpXlsxFile,
  importCsvFile,
  exportFiles,
  getSetColumnState,
  applySetColumnFill,
  generateFileNameFromVariant
};
