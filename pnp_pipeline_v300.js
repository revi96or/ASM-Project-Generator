/**
 * Описание: Минимальный конвейер Pick and Place 3.1.0 для словаря Dict/.
 * Версия: 3.1.37
 * Автор: Новожилов Артем
 */

const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_DICT_FILE = 'pnp_dict_v300.js';
const DEFAULT_STATE_FILE = 'pnp_state_v300.js';
const DEFAULT_EXPORT_STEM = 'pnp_export_v300';
const DEFAULT_IMPORT_START_DIR = 'C:\\settings\\Pick Place\\Test\\';
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

function normalizeDecimalText(value) {
  return normalizeText(value).replace(',', '.');
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
  const numericValue = Number(normalizeDecimalText(rawValue));

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

function measureWorkbookColumnWidths(rows) {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 8);

  rows.forEach((row) => {
    row.forEach((value, index) => {
      const length = normalizeText(value).length;
      const nextWidth = Math.max(8, Math.min(60, length + 2));
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
  const nextImportInfo = {
   ...sourceImportInfo,
   infoD3: normalizeSetColumnValue(setValue).replace(/^SET/, ''),
   rawTable: nextRawTable,
   dataSetTable: {
     rawHeaders: Array.isArray(dataSetState.rawHeaders) ? dataSetState.rawHeaders.slice() : Array.isArray(nextRawTable.rawHeaders) ? nextRawTable.rawHeaders.slice() : [],
     rows: dataSetState.rows,
     worksheetRows: dataSetState.worksheetRows
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

        if (rowIndex === 0) {
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
  const rows = Array.from({ length: 15 }, () => ['', '', '', '']);

  rows[2][3] = d3Value;
  rows[4][3] = d5Value;
  rows[5][3] = d6Value;

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

function buildPnpXlsxBuffer(importInfo, sourcePath) {
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
  const dataSetSheetRows = [
    workbookHeaders
  ].concat((Array.isArray(dataSetTable.worksheetRows) && dataSetTable.worksheetRows.length
    ? dataSetTable.worksheetRows.map((row) => row)
    : (Array.isArray(dataSetTable.rows) ? dataSetTable.rows : []).map((row) => row.map((value) => String(value)))));
  const sheetNames = ['Лист1', 'Info', 'DataSet'];
  const tableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(listSheetRows.length, 1)}`;
  const dataSetTableRange = `A1:${columnIndexToLetters(Math.max(dataHeaders.length, 1) - 1)}${Math.max(dataSetSheetRows.length, 1)}`;
  const columnWidths = measureWorkbookColumnWidths(listSheetRows);
  const setState = importInfo && importInfo.setColumnState ? importInfo.setColumnState : null;
  const highlightColumnIndex = setState && setState.fillApplied && Number.isInteger(setState.columnIndex)
    ? setState.columnIndex
    : -1;

  return buildZipArchive([
    { path: '[Content_Types].xml', content: buildContentTypesXml(sheetNames.length, 2) },
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
    { path: 'xl/tables/table2.xml', content: buildTableXml('DataSetTable', dataSetTableRange, dataHeaders, 2) }
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
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
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
  <cellXfs count="10">
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
  const title = String(importInfo && importInfo.baseName ? importInfo.baseName : 'Pick and Place');
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

async function savePnpXlsxFile(targetFolder, baseName, importInfo, sourcePath) {
  const workbookName = `${String(baseName || 'pnp_export_v300').trim() || 'pnp_export_v300'}.xlsx`;
  const targetPath = path.join(targetFolder, workbookName);
  const workbookBuffer = buildPnpXlsxBuffer(importInfo || {}, sourcePath || '');

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
<title>Pick and Place 3.1.31 Preview</title>
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
    <h1>Pick and Place 3.1.31</h1>
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
    ' * Версия: 3.1.34',
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
  const deletePcbState = getDeletePcbRowsState(imported.importInfo.rawTable);
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
      dataSetTable: {
        ...imported.importInfo.rawTable,
        rows: deletePcbState.rows
      },
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
      importedTableName: 'ImportedCSVTable',
      deletedHeaderRows: 12,
      commentColumn: 3,
      footprintColumn: 5,
      textNumberFormatColumns: [2, 3, 5, 6, 7],
      sheetNames: ['Info', 'ImportedCSVTable', 'DataSet', 'DataSet2', 'Resist', 'Capacitor', 'Other', 'DataPredExit', 'DataExit'],
      tableName: 'ImportedCSVTable',
      activeSheet: 'ImportedCSVTable',
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      centerXColumnIndex: centerColumns.centerX,
      centerYColumnIndex: centerColumns.centerY,
      headers: parsed.rawHeaders,
      tableRange: `A1:${columnIndexToLetters(Math.max(parsed.rawHeaders.length, 1) - 1)}${Math.max(parsed.rows.length + 1, 1)}`
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
  const exportXlsxFolder = String(options.exportXlsxFolder || '').trim();
  const importInfo = options.importInfo || prepared.importInfo || null;
  const xlsxBaseName = String((importInfo && importInfo.baseName) || options.exportXlsxStem || exportStem).trim() || exportStem;
  let exportXlsxResult = null;

  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(exportDictPath, buildModuleSource(prepared, 'Экспортированный словарь P&P'), 'utf8');
  await fs.writeFile(exportCsvPath, buildCsv(prepared), 'utf8');
  await fs.writeFile(exportHtmlPath, buildPreviewHtml(prepared), 'utf8');

  if (exportXlsxFolder) {
    exportXlsxResult = await savePnpXlsxFile(exportXlsxFolder, xlsxBaseName, importInfo, options.sourcePath || '');
  }

  return {
    targetFolder,
    exportXlsxFolder,
    stats: getStats(prepared),
    files: [
      { fileName: path.basename(exportDictPath), path: exportDictPath, kind: 'dict' },
      { fileName: path.basename(exportCsvPath), path: exportCsvPath, kind: 'csv' },
      { fileName: path.basename(exportHtmlPath), path: exportHtmlPath, kind: 'html' },
      ...(exportXlsxResult ? [{ fileName: exportXlsxResult.fileName, path: exportXlsxResult.path, kind: 'xlsx' }] : [])
    ],
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
  buildModuleSource,
  buildDataSetTableState,
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
  applySetColumnFill
};
