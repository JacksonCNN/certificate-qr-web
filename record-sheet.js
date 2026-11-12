// record-sheet.js — turns saved records into the document that
// database.js shares: one PDF, in which each record has its details at
// the top, its tables of readings one after another as actual tables
// (each kept whole on one page where it fits), then the remarks, and
// last — starting on a page of its own — an attachment of the photos of
// its readings, each labelled with the table and row it belongs to.
//
// Why a document, and why one file: a record sent as chat text can't
// have columns that line up, and sent as a handful of separate pictures
// it depends on the receiving app to keep them together — handed a
// caption and several files at once, some apps keep only the caption. A
// single PDF arrives whole everywhere, isn't recompressed into
// illegibility the way a tall picture is, and prints.
//
// Loaded after history.js and photos.js on database.html; plain globals,
// no bundler — same pattern as the rest of this app. Always dark on
// white, whatever the app's theme: it's a document that leaves the app.
//
// How it's made, with no PDF library: the record is laid out on a
// 1080-pixel-wide page (two passes — measure everything, then draw),
// cut into A4-shaped pages at points that don't split a row, a table
// that fits on a page, or a photo, and always where the attachment
// begins; each page drawn to a canvas and stored in the PDF as one JPEG. The
// text is therefore a picture of text, which is fine for reading and
// printing, and is the price of not carrying a font engine.

const SHEET_WIDTH = 1080;
// A4's proportions at that width.
const SHEET_PAGE_HEIGHT = 1527;
const SHEET_MARGIN = 44;
// The most of the column a page after the first can hold.
const SHEET_PAGE_ROOM = SHEET_PAGE_HEIGHT - SHEET_MARGIN * 2;
const SHEET_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SHEET_COLOURS = {
  paper: '#ffffff',
  text: '#201e1d',
  muted: '#6f6a69',
  line: '#cfcac9',
  rule: '#201e1d',
  headFill: '#f1efee',
  failFill: '#fdecef',
  failText: '#aa0b56',
  passFill: '#e6f6ee',
  passText: '#1a7f4b',
  before: { fill: '#f6ecd6', text: '#8a5a00' },
  after: { fill: '#e2f4fb', text: '#0077a0' },
};
const SHEET_JPEG_QUALITY = 0.92;
// Two photos to a line, and none taller than this however it was held.
const SHEET_PHOTO_MAX_HEIGHT = 560;

function sheetFont(size, weight) {
  return `${weight || 400} ${size}px ${SHEET_FONT}`;
}

// Breaks `text` into lines no wider than maxWidth in ctx's current font.
// Words stay whole where they fit; one that's wider than the whole
// column (a long serial number, an error message in a narrow cell) is
// cut across lines rather than left to overflow.
function wrapSheetText(ctx, text, maxWidth) {
  const lines = [];
  String(text == null ? '' : text).split('\n').forEach((paragraph) => {
    let line = '';
    paragraph.split(' ').forEach((word) => {
      let piece = word;
      while (piece.length > 1 && ctx.measureText(piece).width > maxWidth) {
        let cut = piece.length - 1;
        while (cut > 1 && ctx.measureText(piece.slice(0, cut)).width > maxWidth) cut -= 1;
        if (line) lines.push(line);
        line = '';
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      const candidate = line ? `${line} ${piece}` : piece;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = piece;
      }
    });
    lines.push(line);
  });
  return lines;
}

function loadSheetImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Lays the record out as one long column and returns { steps, height,
// breaks, pageBreaks }: what to draw (each step draws at its place in
// that column), how long the column is, the heights at which it may be
// cut into pages — between rows, between photos, before a heading — so
// that a cut never goes through one, and the heights at which it must
// be (where the photo attachment starts).
//   details.customer — the customer folder's name, or '' if unfiled.
//   details.calibrationFields / uutFields / referenceFields — [[label,
//     key], …], the same lists database.js shows in its detail view.
//   details.values — { key: text } for the fields that are shown
//     differently from how they're stored.
//   details.result — 'pass', 'fail' or '' for the record as a whole.
//   photos — Map of photo id → loaded <img>, for the photos that could
//     be found.
function layoutRecordSheet(record, details, photos) {
  const colours = SHEET_COLOURS;
  const inner = SHEET_WIDTH - SHEET_MARGIN * 2;
  const measure = document.createElement('canvas').getContext('2d');
  const steps = [];
  const breaks = [];
  const pageBreaks = [];
  let y = SHEET_MARGIN;

  function queueText(text, x, top, font, colour) {
    steps.push((ctx) => {
      ctx.font = font;
      ctx.fillStyle = colour;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(text, x, top);
    });
  }

  function queueRect(x, top, w, h, fill) {
    steps.push((ctx) => {
      ctx.fillStyle = fill;
      ctx.fillRect(x, top, w, h);
    });
  }

  // Wrapped text at the left margin (or at x, within width); moves y on.
  function paragraph(text, size, weight, colour, options) {
    const { x = SHEET_MARGIN, width = inner, lineHeight = Math.round(size * 1.32), breakable = false } = options || {};
    const font = sheetFont(size, weight);
    measure.font = font;
    wrapSheetText(measure, text, width).forEach((line) => {
      queueText(line, x, y, font, colour);
      y += lineHeight;
      if (breakable) breaks.push(y);
    });
  }

  // A heading stays with what follows it: the page may be cut above it,
  // not below.
  function sectionHeading(text) {
    breaks.push(y);
    y += 30;
    paragraph(text, 24, 700, colours.muted);
    y += 6;
  }

  // --- Title ---
  paragraph('WORKSHEET', 20, 700, colours.muted);
  y += 2;
  paragraph(formatUutLabel(record.uutModel, record.uutSerial) || '(unnamed)', 44, 700, colours.text);
  y += 6;
  paragraph([details.customer, `Saved ${formatSavedAt(record.savedAt)}`].filter(Boolean).join('  ·  '), 23, 400, colours.muted);
  // The overall result, as a tag under the title: the first thing
  // anyone opening the document wants to know.
  if (details.result === 'pass' || details.result === 'fail') {
    const tag = details.result === 'pass' ? { text: 'PASS', fill: colours.passFill, colour: colours.passText } : { text: 'FAIL', fill: colours.failText, colour: colours.paper };
    const tagFont = sheetFont(22, 700);
    measure.font = tagFont;
    const tagWidth = measure.measureText(tag.text).width + 28;
    y += 10;
    queueRect(SHEET_MARGIN, y, tagWidth, 38, tag.fill);
    queueText(tag.text, SHEET_MARGIN + 14, y + 8, tagFont, tag.colour);
    y += 38;
  }
  y += 16;
  queueRect(SHEET_MARGIN, y, inner, 4, colours.rule);
  y += 4;

  // --- Label / value lists ---
  // A list with nothing filled in is left out; so is an empty line of one.
  // A value comes from details.values where there is one — what's shown
  // isn't always what's stored (a temperature gets its unit, the
  // result its word) — and straight off the record otherwise.
  const valueOf = (key) => (details.values && details.values[key] != null ? details.values[key] : record[key]);

  function infoList(title, fields) {
    const filled = fields.filter(([, key]) => valueOf(key));
    if (filled.length === 0) return;
    sectionHeading(title);
    const labelWidth = 330;
    filled.forEach(([label, key]) => {
      const top = y + 10;
      const labelFont = sheetFont(20, 700);
      measure.font = labelFont;
      const labelLines = wrapSheetText(measure, label.toUpperCase(), labelWidth - 16);
      labelLines.forEach((line, index) => queueText(line, SHEET_MARGIN, top + 3 + index * 26, labelFont, colours.muted));
      y = top;
      paragraph(valueOf(key), 26, 400, colours.text, { x: SHEET_MARGIN + labelWidth, width: inner - labelWidth });
      y = Math.max(y, top + 3 + labelLines.length * 26) + 10;
      queueRect(SHEET_MARGIN, y, inner, 1, colours.line);
      breaks.push(y + 1);
    });
  }
  infoList('Calibration', details.calibrationFields || []);
  infoList('UUT Info', details.uutFields);
  infoList('Reference Info', details.referenceFields);

  // --- Tables of readings ---
  const tables = worksheetTables(record);
  if (tables.length === 0) {
    sectionHeading('Readings');
    paragraph('No readings were entered when this record was saved.', 26, 400, colours.muted);
  }

  // The photos of every table's readings, gathered as the tables are
  // laid out and put together at the end, as the attachment.
  const attachments = [];

  tables.forEach((table, tableIndex) => {
    // Heading: which table, what it was read against, and — as a
    // coloured tag — whether that was before or after adjustment.
    breaks.push(y);
    const tableStart = y;
    const tableBreaksFrom = breaks.length;
    y += 34;
    const headingFont = sheetFont(28, 700);
    const title = [tables.length > 1 ? `Table ${tableIndex + 1}` : 'Readings', table.scopeUnitLabel].filter(Boolean).join(' — ');
    const stageLabel = ADJUST_STAGES[table.stage];
    const tagFont = sheetFont(19, 700);
    measure.font = tagFont;
    const tagWidth = stageLabel ? measure.measureText(stageLabel.toUpperCase()).width + 24 : 0;
    measure.font = headingFont;
    const titleLines = wrapSheetText(measure, title, inner - (stageLabel ? tagWidth + 16 : 0));
    titleLines.forEach((line, index) => {
      queueText(line, SHEET_MARGIN, y, headingFont, colours.text);
      if (stageLabel && index === titleLines.length - 1) {
        measure.font = headingFont;
        const tagX = SHEET_MARGIN + measure.measureText(line).width + 16;
        const tag = colours[table.stage];
        queueRect(tagX, y + 2, tagWidth, 32, tag.fill);
        queueText(stageLabel.toUpperCase(), tagX + 12, y + 8, tagFont, tag.text);
      }
      y += 38;
    });
    const formLine = table.form ? [table.form.name, table.fn && `Function: ${table.fn}`].filter(Boolean).join('  ·  ') : '';
    if (formLine) paragraph(formLine, 23, 400, colours.muted);
    const certificate = tableCertificateLine(table, tables);
    if (certificate) paragraph(certificate, 23, 400, colours.muted);
    const accuracy = formatAccuracy(table);
    if (accuracy) paragraph(`Accuracy: ${accuracy}`, 23, 400, colours.muted);
    y += 8;

    // Columns: the row number, the five values, and — only in a table
    // that has one — a column that says which rows are out of tolerance
    // in words as well as in red.
    const rows = Array.isArray(table.rows) ? table.rows : [];
    // A table in an official worksheet's layout is drawn from what the
    // record kept of it: its heading rows, cells spanning as they do on
    // the page, then its rows. Each column is as wide as what is in it
    // needs — its widest figure, or the widest word of a heading that
    // is over it alone (a heading wraps between words) — and the type
    // is the largest at which all of them fit across the page.
    function formTable(form) {
      const count = form.head[form.head.length - 1].reduce((sum, cell) => sum + cell.c, 0);
      const pad = 5;
      // Units without their spaces — "(bar)" — so they don't wrap.
      const head = form.head.map((cells) => cells.map((cell) => ({ ...cell, t: String(cell.t || '').replace(/^\( (.*) \)$/, '($1)') })));
      // Which column each heading cell starts at.
      const starts = [];
      const taken = Array.from({ length: head.length }, () => Array(count).fill(false));
      head.forEach((cells, rowIndex) => {
        let col = 0;
        cells.forEach((cell) => {
          while (taken[rowIndex][col]) col += 1;
          for (let dr = 0; dr < cell.r; dr += 1) for (let dc = 0; dc < cell.c; dc += 1) taken[rowIndex + dr][col + dc] = true;
          starts.push({ row: rowIndex, col, cell });
          col += cell.c;
        });
      });
      const cellText = (cells, col) => (cells[col] == null || cells[col] === '' ? '—' : String(cells[col]));
      let size = 17;
      let natural = [];
      for (; size >= 11; size -= 1) {
        const needs = Array(count).fill(0);
        measure.font = sheetFont(size, 700);
        form.rows.forEach((cells) => {
          for (let col = 0; col < count; col += 1) needs[col] = Math.max(needs[col], measure.measureText(cellText(cells, col)).width);
        });
        measure.font = sheetFont(size - 3, 700);
        starts.filter((p) => p.cell.c === 1).forEach((p) => {
          p.cell.t.split(/\s+/).forEach((word) => { needs[p.col] = Math.max(needs[p.col], measure.measureText(word).width); });
        });
        natural = needs.map((need) => need + pad * 2 + 4);
        if (natural.reduce((sum, width) => sum + width, 0) <= inner) break;
      }
      // What is left over is shared out; what doesn't fit even in the
      // smallest type is squeezed, and wraps.
      const naturalTotal = natural.reduce((sum, width) => sum + width, 0);
      const widths = naturalTotal <= inner ? natural.map((width) => width + (inner - naturalTotal) / count) : natural.map((width) => (width / naturalTotal) * inner);      const left = (col) => SHEET_MARGIN + widths.slice(0, col).reduce((sum, width) => sum + width, 0);
      const span = (col, cols) => widths.slice(col, col + cols).reduce((sum, width) => sum + width, 0);

      function cellBox(x, top, width, height, lines, font, lineHeight, colour, fill) {
        if (fill) queueRect(x, top, width, height, fill);
        queueRect(x, top, width, 1, colours.line);
        queueRect(x, top, 1, height, colours.line);
        queueRect(x + width - 1, top, 1, height, colours.line);
        queueRect(x, top + height - 1, width, 1, colours.line);
        measure.font = font;
        const firstLine = top + (height - lines.length * lineHeight) / 2 + 2;
        lines.forEach((line, index) => queueText(line, x + (width - measure.measureText(line).width) / 2, firstLine + index * lineHeight, font, colour));
      }

      // Headings: where each cell sits is worked out row by row, past
      // the columns a taller cell above is still covering.
      const headFont = sheetFont(size - 3, 700);
      const headLine = size + 1;
      measure.font = headFont;
      const placed = starts.map((p) => ({ ...p, lines: wrapSheetText(measure, p.cell.t || ' ', span(p.col, p.cell.c) - pad * 2) }));
      const headHeights = head.map((cells, rowIndex) => Math.max(26, ...placed.filter((p) => p.row === rowIndex && p.cell.r === 1).map((p) => p.lines.length * headLine + 10)));
      // A heading that runs down several rows needs their heights
      // together to hold it; the last of them is let out if they don't.
      placed.filter((p) => p.cell.r > 1).forEach((p) => {
        const have = headHeights.slice(p.row, p.row + p.cell.r).reduce((sum, h) => sum + h, 0);
        const need = p.lines.length * headLine + 10;
        if (need > have) headHeights[p.row + p.cell.r - 1] += need - have;
      });
      const headTop = (rowIndex) => y + headHeights.slice(0, rowIndex).reduce((sum, height) => sum + height, 0);
      placed.forEach((p) => {
        const height = headHeights.slice(p.row, p.row + p.cell.r).reduce((sum, h) => sum + h, 0);
        cellBox(left(p.col), headTop(p.row), span(p.col, p.cell.c), height, p.lines, headFont, headLine, colours.muted, colours.headFill);
      });
      y += headHeights.reduce((sum, height) => sum + height, 0);
      queueRect(SHEET_MARGIN, y - 1, inner, 3, colours.rule);
      y += 2;

      const cellFont = sheetFont(size, 400);
      const failFont = sheetFont(size, 700);
      const cellLine = size + 5;
      form.rows.forEach((cells, rowIndex) => {
        const fails = (form.fails && form.fails[rowIndex]) || [];
        measure.font = cellFont;
        const wrapped = Array.from({ length: count }, (unused, col) => wrapSheetText(measure, cellText(cells, col), widths[col] - pad * 2));
        const height = Math.max(...wrapped.map((lines) => lines.length)) * cellLine + 12;
        wrapped.forEach((lines, col) => {
          const failed = fails.includes(col);
          cellBox(left(col), y, widths[col], height, lines, failed ? failFont : cellFont, cellLine, failed ? colours.failText : colours.text, failed ? colours.failFill : null);
        });
        y += height;
        breaks.push(y + 1);
      });
    }

    if (table.form) {
      formTable(table.form);
    } else {
      const showVerdict = rows.some((row) => row.outOfTolerance);
      const numberWidth = 62;
      const verdictWidth = showVerdict ? 150 : 0;
      const valueWidth = (inner - numberWidth - verdictWidth) / 5;
      const columns = [
        { title: '#', width: numberWidth, value: (row, index) => String(index + 1).padStart(2, '0') },
        { title: table.labRdgHeader || 'Lab Rdg', width: valueWidth, value: (row) => row.labRdg },
        { title: 'Lab Correction', width: valueWidth, value: (row) => row.labCorrectionRdg },
        { title: 'Act Lab Rdg', width: valueWidth, value: (row) => row.actLabRdg },
        { title: table.uutRdgHeader || 'UUT Rdg', width: valueWidth, value: (row) => row.uutRdg },
        { title: 'Correction', width: valueWidth, value: (row) => row.correctionRdg },
      ];
      if (showVerdict) columns.push({ title: 'Tolerance', width: verdictWidth, value: (row) => (row.outOfTolerance ? 'OUT' : '') });

      const padX = 10;
      const padY = 10;

      // One row of cells: every cell wrapped to its column, the row as
      // tall as its tallest cell, boxed in on all sides (each row draws
      // its own uprights, so the grid is whole on whichever page a row
      // lands).
      function tableRow(cells, font, lineHeight, colour, fill) {
        measure.font = font;
        const wrapped = cells.map((cell, index) => wrapSheetText(measure, cell == null || cell === '' ? '—' : cell, columns[index].width - padX * 2));
        const height = Math.max(...wrapped.map((lines) => lines.length)) * lineHeight + padY * 2;
        if (fill) queueRect(SHEET_MARGIN, y, inner, height, fill);
        queueRect(SHEET_MARGIN, y, inner, 1, colours.line);
        let x = SHEET_MARGIN;
        wrapped.forEach((lines, index) => {
          queueRect(x, y, 1, height, colours.line);
          lines.forEach((line, lineIndex) => queueText(line, x + padX, y + padY + lineIndex * lineHeight, font, colour));
          x += columns[index].width;
        });
        queueRect(SHEET_MARGIN + inner - 1, y, 1, height, colours.line);
        y += height;
        queueRect(SHEET_MARGIN, y, inner, 1, colours.line);
      }

      tableRow(columns.map((column) => column.title), sheetFont(19, 700), 25, colours.muted, colours.headFill);
      queueRect(SHEET_MARGIN, y - 1, inner, 3, colours.rule);
      y += 2;
      rows.forEach((row, index) => {
        const cells = columns.map((column) => column.value(row, index));
        if (row.outOfTolerance) tableRow(cells, sheetFont(25, 700), 32, colours.failText, colours.failFill);
        else tableRow(cells, sheetFont(25, 400), 32, colours.text, null);
        breaks.push(y + 1);
      });
    }

    // --- The table's photos, for the attachment ---
    // Each labelled with the reading it's a photo of, in the row's own
    // words: its table (when there's more than one), its number there,
    // and its two readings. Under the table, a line says where they are.
    const shots = [];
    rows.forEach((row, index) => {
      rowPhotoIds([row]).forEach((id) => {
        const img = photos.get(id);
        if (!img) return;
        const caption = [
          tables.length > 1 && `Table ${tableIndex + 1}`,
          `Row ${String(index + 1).padStart(2, '0')}`,
          row.labRdg && `Lab ${row.labRdg}`,
          row.uutRdg && `UUT ${row.uutRdg}`,
        ].filter(Boolean).join('  ·  ');
        shots.push({ img, caption, fail: Boolean(row.outOfTolerance) });
      });
    });
    if (shots.length > 0) {
      attachments.push({ title, stageLabel, shots });
      y += 12;
      paragraph(`${shots.length} photo${shots.length === 1 ? '' : 's'} of these readings — see Attachment`, 21, 400, colours.muted);
    }

    // A table that fits on a page is kept on one: the cuts between its
    // rows are taken back, so the page is cut above its heading instead.
    // One taller than a page still has to be cut, between rows.
    if (y - tableStart <= SHEET_PAGE_ROOM) {
      for (let i = breaks.length - 1; i >= tableBreaksFrom; i -= 1) {
        if (breaks[i] <= y) breaks.splice(i, 1);
      }
    }
  });

  // --- Remarks ---
  if (record.remarks) {
    sectionHeading('Remarks');
    paragraph(record.remarks, 26, 400, colours.text, { breakable: true });
  }

  // --- Attachment: the photos ---
  // On a page of its own after everything else, grouped by table, two
  // to a line, each with its label right under it.
  if (attachments.length > 0) {
    pageBreaks.push(y);
    paragraph('ATTACHMENT', 20, 700, colours.muted);
    y += 2;
    paragraph('Photos of readings', 36, 700, colours.text);
    y += 4;
    paragraph(formatUutLabel(record.uutModel, record.uutSerial) || '(unnamed)', 23, 400, colours.muted);
    y += 12;
    queueRect(SHEET_MARGIN, y, inner, 4, colours.rule);
    y += 4;

    const gap = 24;
    const cellWidth = (inner - gap) / 2;
    const captionFont = sheetFont(21, 700);
    attachments.forEach((group) => {
      sectionHeading([group.title, group.stageLabel && `(${group.stageLabel})`].filter(Boolean).join(' '));
      y += 4;
      for (let i = 0; i < group.shots.length; i += 2) {
        const pair = group.shots.slice(i, i + 2);
        measure.font = captionFont;
        const sized = pair.map((shot) => {
          const scale = Math.min(cellWidth / shot.img.naturalWidth, SHEET_PHOTO_MAX_HEIGHT / shot.img.naturalHeight);
          return {
            ...shot,
            width: Math.round(shot.img.naturalWidth * scale),
            height: Math.round(shot.img.naturalHeight * scale),
            lines: wrapSheetText(measure, shot.caption, cellWidth),
          };
        });
        const top = y;
        sized.forEach((shot, column) => {
          const x = SHEET_MARGIN + column * (cellWidth + gap);
          steps.push((ctx) => ctx.drawImage(shot.img, x, top, shot.width, shot.height));
          queueRect(x, top, shot.width, 1, colours.line);
          queueRect(x, top + shot.height - 1, shot.width, 1, colours.line);
          queueRect(x, top, 1, shot.height, colours.line);
          queueRect(x + shot.width - 1, top, 1, shot.height, colours.line);
          shot.lines.forEach((line, lineIndex) => {
            queueText(line, x, top + shot.height + 10 + lineIndex * 27, captionFont, shot.fail ? colours.failText : colours.text);
          });
        });
        // Each label sits right under its own photo; the line is as
        // tall as the taller of the two with its label.
        y = top + Math.max(...sized.map((shot) => shot.height + 10 + shot.lines.length * 27)) + 20;
        breaks.push(y);
      }
    });
  }

  return { steps, height: y, breaks, pageBreaks };
}

// Where to cut the column into pages: each page takes as much as fits
// up to the last allowed break, or — for something taller than a whole
// page, which has no break inside it — exactly a page's worth; and a
// page always ends at a forced break (pageBreaks), so what follows one
// starts a new page. Returns [{ start, end, top }]: the stretch of the
// column, and how far down the page it's drawn (the first page's
// stretch carries its own top margin).
function paginateSheet(height, breaks, pageBreaks) {
  const pages = [];
  let start = 0;
  while (start < height) {
    const top = pages.length === 0 ? 0 : SHEET_MARGIN;
    const room = SHEET_PAGE_HEIGHT - SHEET_MARGIN - top;
    const forced = (pageBreaks || []).filter((b) => b > start && b < height);
    let end = forced.length > 0 ? Math.min(...forced) : height;
    if (end - start > room) {
      const fitting = breaks.filter((b) => b > start && b <= start + room);
      end = fitting.length > 0 ? Math.max(...fitting) : start + room;
    }
    pages.push({ start, end, top });
    start = end;
  }
  return pages;
}

function drawSheetPage(layout, page, pageNumber, pageCount, footer) {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_PAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = SHEET_COLOURS.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Only this page's stretch of the column, slid up into place.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, page.top, SHEET_WIDTH, page.end - page.start);
  ctx.clip();
  ctx.translate(0, page.top - page.start);
  layout.steps.forEach((step) => step(ctx));
  ctx.restore();

  ctx.font = sheetFont(17, 400);
  ctx.fillStyle = SHEET_COLOURS.muted;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(footer, SHEET_MARGIN, SHEET_PAGE_HEIGHT - 16);
  ctx.textAlign = 'right';
  ctx.fillText(`Page ${pageNumber} of ${pageCount}`, SHEET_WIDTH - SHEET_MARGIN, SHEET_PAGE_HEIGHT - 16);
  return canvas;
}

// --- The PDF file ---
// As small as a PDF gets: a page tree, and per page an image (the JPEG,
// stored as it is — PDF reads JPEG natively as /DCTDecode) and a
// one-line content stream that paints it across an A4 page. Returns the
// file's bytes.
function buildImagePdf(jpegPages, title) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObject = (number) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
  };

  const pageWidth = 595.28; // A4, in points
  const pageHeight = 841.89;
  // Objects: 1 catalog, 2 page tree, 3 info, then three per page.
  const pageObject = (index) => 4 + index * 3;
  // PDF text strings are bracketed by ( ) and escape them and "\"; what
  // isn't plain ASCII is dropped rather than encoded — it's only the
  // document's title in a viewer's window bar.
  const pdfText = (text) => String(text).replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, (c) => `\\${c}`);

  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObject(2);
  push(`<< /Type /Pages /Count ${jpegPages.length} /Kids [${jpegPages.map((page, index) => `${pageObject(index)} 0 R`).join(' ')}] >>\nendobj\n`);
  beginObject(3);
  push(`<< /Title (${pdfText(title)}) /Producer (Certificate QR) >>\nendobj\n`);

  jpegPages.forEach((page, index) => {
    const pageNumber = pageObject(index);
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    beginObject(pageNumber);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>\nendobj\n`);
    beginObject(imageNumber);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
    push(page.bytes);
    push('\nendstream\nendobj\n');
    const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
    beginObject(contentNumber);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const objectCount = 3 + jpegPages.length * 3;
  const xrefAt = length;
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let number = 1; number <= objectCount; number += 1) push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const file = new Uint8Array(length);
  let at = 0;
  chunks.forEach((chunk) => {
    file.set(chunk, at);
    at += chunk.length;
  });
  return file;
}

function dataUrlBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// buildRecordsPdf(items, title, onProgress) resolves to { bytes,
// pageCount, photoCount, missingPhotos }: one PDF of every record in
// `items` ([{ record, details }], details as for layoutRecordSheet), each
// starting on a page of its own; how many pages that came to; and how
// many of the records' photos are in it, and couldn't be found to put in
// it. `title` is the document's own. onProgress(done, total) is called
// as records are laid out and drawn — a long selection takes a moment.
async function buildRecordsPdf(items, title, onProgress) {
  // Everything is measured before anything is drawn: the footer's "Page
  // n of N" needs the total, and that's only known once every record
  // has been laid out.
  const sheets = [];
  let photoCount = 0;
  let missingPhotos = 0;
  for (const { record, details } of items) {
    const photoIds = worksheetPhotoIds(record);
    const photos = new Map();
    await Promise.all(photoIds.map(async (id) => {
      const dataUrl = await loadPhoto(id);
      const img = dataUrl ? await loadSheetImage(dataUrl) : null;
      if (img && img.naturalWidth > 0) photos.set(id, img);
    }));
    photoCount += photos.size;
    missingPhotos += photoIds.length - photos.size;
    const layout = layoutRecordSheet(record, details, photos);
    sheets.push({
      layout,
      pages: paginateSheet(layout.height, layout.breaks, layout.pageBreaks),
      footer: `Worksheet — ${formatUutLabel(record.uutModel, record.uutSerial) || '(unnamed)'}`,
    });
  }

  const pageCount = sheets.reduce((total, sheet) => total + sheet.pages.length, 0);
  const jpegPages = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    if (onProgress) onProgress(index, sheets.length);
    // A breath between records, so the page can show that progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
    sheet.pages.forEach((page) => {
      const canvas = drawSheetPage(sheet.layout, page, jpegPages.length + 1, pageCount, sheet.footer);
      jpegPages.push({ width: canvas.width, height: canvas.height, bytes: dataUrlBytes(canvas.toDataURL('image/jpeg', SHEET_JPEG_QUALITY)) });
    });
  }
  if (onProgress) onProgress(sheets.length, sheets.length);

  return { bytes: buildImagePdf(jpegPages, title), pageCount, photoCount, missingPhotos };
}
