// worksheet-templates.js — worksheets made from templates. A template is
// a form designed in Digital Worksheet Designer, exported there as a
// .calfrm file and imported here by an admin (Settings → Worksheet
// templates). The list of them is history.js's loadWorksheetTemplates,
// kept on the shared server so every phone has the same ones, and a copy
// on each phone for working offline. Loaded by interpolate.html ahead of
// interpolate.js, which builds a worksheet from one: every question and
// section of the form, in order, around its own sections (Calibration
// info, UUT info, …). docs/CALFRM.md describes the format.
//
// Three parts, all under one global, WorksheetTemplates:
//   - The maths of a calibration table, from calc-core.js (the engine
//     shared with Digital Worksheet Designer), plus what's this app's
//     own: a column's unit, answers in words, the app's own sections.
//     No DOM — Node's tests load this file too.
//   - A question that isn't a table: createQuestion.
//   - A calibration table's rows inside one of interpolate.js's reading
//     tables: createTemplateRows, which gives back what the old official
//     worksheets' rows did (setHead, addRow, collect, record).

(function (global) {
  'use strict';

  // ---------- the maths: calc-core.js ----------
  // Formulas, the reference certificate's correction, tolerances and
  // Pass / Fail are the calculation engine shared with Digital Worksheet
  // Designer (www/calc-core.js, loaded ahead of this file), so a table
  // works out exactly the same figures in both apps.
  const C = global.CalcCore;
  const {
    toNum, formatNum, displayNum, colLetter, parseFormula, evalFormula, evalCert, parseTol, encodeTol,
    toleranceLimit, tolSpecText, evalResult, isComputed, isPresetCell, isCellEditable, evaluateRow,
  } = C;

  const columnHeading = (c) => (c.name || 'Untitled') + (c.unit ? ` (${c.unit})` : '');

  // A table's unit is typed once for the whole table (table.unit). Older
  // templates have one on each column instead: those are used as they are.
  // The table's unit goes under the columns that hold readings.
  const MEASURED = ['number', 'calc', 'cert', 'tol'];
  function columnUnit(table, c) {
    if (typeof c.unit === 'string' && c.unit.trim()) return c.unit.trim();
    if (table && typeof table.unit === 'string' && !table.columns.some((x) => typeof x.unit === 'string' && x.unit.trim())) {
      return MEASURED.includes(c.type) ? table.unit.trim() : '';
    }
    return '';
  }

  // ---------- answers to questions that aren't tables ----------

  const blank = (v) => v === null || v === undefined || String(v).trim() === '';

  function isAnswerEmpty(item, v) {
    switch (item.type) {
      case 'checkbox':
        return !Array.isArray(v) || v.length === 0;
      case 'grid_radio':
        return !v || typeof v !== 'object' || ((item.grid && item.grid.rows) || []).some((r) => blank(v[r]));
      case 'grid_checkbox':
        return !v || typeof v !== 'object' || ((item.grid && item.grid.rows) || []).some((r) => !Array.isArray(v[r]) || v[r].length === 0);
      case 'budget': {
        // Required = every value typed into it.
        const need = ((item.budget && item.budget.sources) || []).filter((s) => s.from === 'respondent' || s.from === 'uut-sr');
        return need.length > 0 && (!v || typeof v !== 'object' || need.some((s) => blank(v.typed && v.typed[s.id])));
      }
      default:
        return blank(v);
    }
  }

  // An answer in words, for a saved record and its printed sheet.
  function answerText(item, v) {
    if (v === null || v === undefined) return '';
    if (item && item.type === 'budget') return budgetText(v);
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') {
      return ((item.grid && item.grid.rows) || [])
        .filter((r) => (Array.isArray(v[r]) ? v[r].length : !blank(v[r])))
        .map((r) => `${r}: ${Array.isArray(v[r]) ? v[r].join(', ') : v[r]}`)
        .join('; ');
    }
    return String(v);
  }

  const QUESTION_TYPES = ['short', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'grid_radio', 'grid_checkbox', 'date', 'time'];

  // ---------- the worksheet's own sections ----------
  // A section of the template with the same name as one of the
  // worksheet's own sections (only UUT info so far) adds to that section
  // instead of being a section of its own: its questions are shown as
  // more fields of it. Names match whatever their case, spaces and
  // punctuation ("UUT Info", "UUT INFO", "uut-info"). A calibration table
  // in such a section stays with the template's other tables, so the
  // section's card is still shown when it has one.
  const APP_SECTIONS = { uut: ['UUT info', 'UUT information'] };
  const sameName = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function appSectionOf(title) {
    const key = sameName(title);
    if (!key) return null;
    return Object.keys(APP_SECTIONS).find((k) => APP_SECTIONS[k].some((n) => sameName(n) === key)) || null;
  }

  // -> { fields: { [question id]: app section key }, merged: [section ids not shown on their own] }
  function placeInAppSections(items) {
    const fields = {};
    const merged = [];
    let current = null;
    let sectionId = null;
    let hasTable = false;
    const close = () => { if (current && !hasTable) merged.push(sectionId); };
    (Array.isArray(items) ? items : []).forEach((it) => {
      if (!it) return;
      if (it.type === 'section') {
        close();
        current = appSectionOf(it.title);
        sectionId = it.id;
        hasTable = false;
      } else if (current && it.type === 'calibration') {
        hasTable = true;
      } else if (current && QUESTION_TYPES.includes(it.type)) {
        fields[it.id] = current;
      }
    });
    close();
    return { fields, merged };
  }

  // ---------- the page ----------

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  let nameCounter = 0;
  const uniqueName = (prefix) => `${prefix}-${Date.now().toString(36)}-${(nameCounter += 1)}`;

  // Only pictures that came in with the template (data: URLs, checked on
  // import) and links to a video: nothing is fetched from elsewhere.
  function mediaView(item) {
    const parts = [];
    const image = item.image;
    if (image && typeof image.src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(image.src)) {
      const figure = mk('figure', 'tpl-media');
      const img = mk('img');
      img.src = image.src;
      img.alt = image.caption || '';
      img.loading = 'lazy';
      figure.appendChild(img);
      if (image.caption) figure.appendChild(mk('figcaption', null, image.caption));
      parts.push(figure);
    }
    const video = item.video;
    if (video && typeof video.url === 'string' && /^https?:\/\//i.test(video.url)) {
      const link = mk('a', 'tpl-video-link', 'Watch the video');
      link.href = video.url;
      link.target = '_blank';
      link.rel = 'noopener';
      parts.push(link);
    }
    if (parts.length === 0) return null;
    const box = mk('div', 'tpl-media-box');
    parts.forEach((part) => box.appendChild(part));
    return box;
  }

  // A section of the form: its title, description and picture.
  function createSectionCard(item) {
    const card = mk('section', 'input-panel tpl-section');
    card.appendChild(mk('h2', 'tpl-section-title', item.title || 'Untitled section'));
    if (item.description) card.appendChild(mk('p', 'tpl-section-desc', item.description));
    const media = mediaView(item);
    if (media) card.appendChild(media);
    return card;
  }

  // One question: its card, with the answer kept in it. `onChange` is
  // called on every change. getValue() gives the answer in the form the
  // record keeps (the same as Digital Worksheet Designer's responses).
  // With { field: true } it is a labelled field instead of a card, like
  // the ones in the worksheet's own sections (see placeInAppSections).
  function createQuestion(item, initial, onChange, opts) {
    const field = Boolean(opts && opts.field);
    const card = mk(field ? 'div' : 'section', field ? 'entry-form-row tpl-field' : 'input-panel tpl-question');
    card.dataset.itemId = item.id;
    const title = mk(field ? 'label' : 'h3', field ? null : 'tpl-q-title', item.title || 'Untitled question');
    if (item.required) {
      const star = mk('span', 'tpl-req', ' *');
      star.title = 'Required';
      title.appendChild(star);
    }
    card.appendChild(title);
    if (item.description) card.appendChild(mk('p', 'tpl-q-desc', item.description));
    const media = mediaView(item);
    if (media) card.appendChild(media);
    const error = mk('p', 'tpl-q-error');
    error.setAttribute('role', 'alert');

    let value = initial === undefined ? null : JSON.parse(JSON.stringify(initial));
    function set(next) {
      value = next;
      error.textContent = '';
      card.classList.remove('tpl-has-error');
      onChange();
    }
    const label = item.title || 'Question';
    const name = uniqueName('tpl');
    const options = Array.isArray(item.options) ? item.options : [];
    let body;

    if (item.type === 'short' || item.type === 'date' || item.type === 'time') {
      body = mk('input', 'tpl-input');
      body.type = item.type === 'short' ? 'text' : item.type;
      body.value = typeof value === 'string' ? value : '';
      body.setAttribute('aria-label', label);
      body.addEventListener('input', () => set(body.value));
    } else if (item.type === 'paragraph') {
      body = mk('textarea', 'tpl-input');
      body.rows = 3;
      body.value = typeof value === 'string' ? value : '';
      body.setAttribute('aria-label', label);
      body.addEventListener('input', () => set(body.value));
    } else if (item.type === 'dropdown') {
      body = mk('select', 'tpl-input');
      body.setAttribute('aria-label', label);
      body.appendChild(mk('option', null, 'Choose')).value = '';
      options.forEach((o) => { body.appendChild(mk('option', null, o)).value = o; });
      body.value = options.includes(value) ? value : '';
      body.addEventListener('change', () => set(body.value));
    } else if (item.type === 'radio' || item.type === 'checkbox') {
      const multi = item.type === 'checkbox';
      body = mk('div', 'tpl-choices');
      body.setAttribute('role', multi ? 'group' : 'radiogroup');
      body.setAttribute('aria-label', label);
      const chosen = new Set(multi ? (Array.isArray(value) ? value : []) : (blank(value) ? [] : [value]));
      // An "Other" answer is kept as "Other: what was typed".
      const otherValue = [...chosen].find((v) => !options.includes(v) && /^Other:/.test(String(v)));
      let otherText = otherValue ? String(otherValue).replace(/^Other:\s*/, '') : '';
      const boxes = [];
      const read = () => {
        const picked = boxes.filter((b) => b.input.checked).map((b) => (b.other ? (otherText.trim() ? `Other: ${otherText.trim()}` : '') : b.value)).filter(Boolean);
        set(multi ? picked : picked[0] || '');
      };
      options.forEach((o) => {
        const row = mk('label', 'tpl-choice');
        const input = mk('input');
        input.type = multi ? 'checkbox' : 'radio';
        input.name = name;
        input.checked = chosen.has(o);
        input.addEventListener('change', read);
        row.append(input, mk('span', null, o));
        boxes.push({ input, value: o, other: false });
        body.appendChild(row);
      });
      if (item.allowOther) {
        const row = mk('label', 'tpl-choice tpl-choice-other');
        const input = mk('input');
        input.type = multi ? 'checkbox' : 'radio';
        input.name = name;
        input.checked = Boolean(otherValue);
        input.addEventListener('change', read);
        const text = mk('input', 'tpl-input');
        text.type = 'text';
        text.value = otherText;
        text.setAttribute('aria-label', 'Other answer');
        text.addEventListener('input', () => {
          otherText = text.value;
          if (text.value.trim()) input.checked = true;
          read();
        });
        row.append(input, mk('span', null, 'Other:'), text);
        boxes.push({ input, other: true });
        body.appendChild(row);
      }
    } else if (item.type === 'scale') {
      const scale = item.scale || {};
      const min = Number.isFinite(scale.min) ? scale.min : 1;
      const max = Number.isFinite(scale.max) ? scale.max : 5;
      body = mk('div', 'tpl-scale');
      body.setAttribute('role', 'radiogroup');
      body.setAttribute('aria-label', label);
      if (scale.minLabel) body.appendChild(mk('span', 'tpl-scale-end', scale.minLabel));
      for (let n = min; n <= max; n += 1) {
        const opt = mk('label', 'tpl-scale-opt');
        const input = mk('input');
        input.type = 'radio';
        input.name = name;
        input.checked = String(value) === String(n);
        input.addEventListener('change', () => set(n));
        opt.append(mk('span', null, String(n)), input);
        body.appendChild(opt);
      }
      if (scale.maxLabel) body.appendChild(mk('span', 'tpl-scale-end', scale.maxLabel));
    } else if (item.type === 'grid_radio' || item.type === 'grid_checkbox') {
      const multi = item.type === 'grid_checkbox';
      const grid = item.grid || { rows: [], cols: [] };
      const current = () => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      body = mk('div', 'interp-table-wrap');
      const table = mk('table', 'data-table tpl-grid');
      const head = mk('tr');
      head.appendChild(mk('th'));
      grid.cols.forEach((c) => head.appendChild(mk('th', null, c)));
      table.appendChild(mk('thead')).appendChild(head);
      const tbody = table.appendChild(mk('tbody'));
      grid.rows.forEach((row, ri) => {
        const tr = mk('tr');
        tr.appendChild(mk('th', null, row));
        grid.cols.forEach((col) => {
          const td = mk('td');
          const input = mk('input');
          input.type = multi ? 'checkbox' : 'radio';
          input.name = `${name}-${ri}`;
          const was = current()[row];
          input.checked = multi ? Array.isArray(was) && was.includes(col) : was === col;
          input.setAttribute('aria-label', `${row}: ${col}`);
          input.addEventListener('change', () => {
            const next = { ...current() };
            if (multi) {
              const picked = new Set(Array.isArray(next[row]) ? next[row] : []);
              if (input.checked) picked.add(col); else picked.delete(col);
              next[row] = grid.cols.filter((c) => picked.has(c));
            } else {
              next[row] = col;
            }
            set(next);
          });
          td.appendChild(input);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      body.appendChild(table);
    } else {
      body = mk('p', 'camera-note', 'This kind of question isn\'t supported by this version of the app.');
    }
    if (field) {
      if (body.tagName === 'INPUT' || body.tagName === 'SELECT' || body.tagName === 'TEXTAREA') {
        body.id = name;
        title.htmlFor = name;
      }
      // a paragraph, choices or a grid takes the whole width
      if (body.tagName !== 'INPUT' && body.tagName !== 'SELECT') card.classList.add('tpl-field-wide');
    }
    card.append(body, error);

    return {
      el: card,
      item,
      getValue: () => value,
      isEmpty: () => isAnswerEmpty(item, value),
      showError(message) {
        error.textContent = message || '';
        card.classList.toggle('tpl-has-error', Boolean(message));
      },
    };
  }

  // ---------- a calibration table's rows ----------
  // createTemplateRows({ item, table, env, tol }) fills `table` (a <table>
  // inside a reading table) for the calibration-table question `item`.
  //   env.cf(x)       the reference certificate's correction at x — { value, error }
  //   env.onChange()  something was typed, added or removed
  // `tol` is the table's tolerance entries, by column id ("pct|fixed"),
  // typed once for the table above it. Rows are <tr>s with _recompute
  // and _photos like the simple table's, marked row-tol-pass /
  // row-tol-fail from their Pass / Fail columns.

  const PHOTO_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const REMOVE_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';

  function createTemplateRows({ item, table: tableEl, env, tol }) {
    const t = item.table;
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const thead = tableEl.querySelector('thead');
    const tbody = tableEl.querySelector('tbody');
    tableEl.classList.remove('interp-table');
    tableEl.classList.add('form-table', 'tpl-table');
    const tolState = { ...(tol || {}) };

    // A line above the table for each tolerance column: ± [ ] % rdg + [ ].
    const tolCols = cols.filter((c) => c.type === 'tol');
    if (tolCols.length > 0) {
      const bar = mk('div', 'tpl-tol-bar');
      tolCols.forEach((c) => {
        const current = parseTol(tolState[c.id]);
        const line = mk('div', 'tpl-tol-line');
        const pct = mk('input');
        const fixed = mk('input');
        [pct, fixed].forEach((input) => {
          input.type = 'text';
          input.inputMode = 'decimal';
          input.placeholder = '0';
          if (typeof restrictInput === 'function') restrictInput(input, (text) => cleanNumberText(text, false));
        });
        pct.value = current.pct;
        fixed.value = current.fixed;
        pct.setAttribute('aria-label', `${c.name || 'Tolerance'}: % of reading`);
        fixed.setAttribute('aria-label', `${c.name || 'Tolerance'}: fixed value`);
        const update = () => {
          tolState[c.id] = encodeTol(pct.value, fixed.value);
          recomputeAll();
          env.onChange();
        };
        pct.addEventListener('input', update);
        fixed.addEventListener('input', update);
        line.append(mk('span', 'tpl-tol-name', c.name || 'Tolerance'), mk('span', null, '±'), pct, mk('span', null, '% rdg +'), fixed);
        if (columnUnit(t, c)) line.appendChild(mk('span', null, columnUnit(t, c)));
        bar.appendChild(line);
      });
      const wrap = tableEl.closest('.interp-table-wrap') || tableEl;
      wrap.parentNode.insertBefore(bar, wrap);
    }

    function head() {
      return [
        [{ t: 'No.', c: 1, r: 1 }, ...cols.map((c) => ({ t: c.name || 'Untitled', c: 1, r: 1 }))],
        [{ t: '', c: 1, r: 1 }, ...cols.map((c) => ({ t: columnUnit(t, c) ? `( ${columnUnit(t, c)} )` : '', c: 1, r: 1 }))],
      ];
    }

    function setHead() {
      thead.innerHTML = '';
      head().forEach((cells, rowIndex, all) => {
        const tr = mk('tr', rowIndex === all.length - 1 ? 'form-units' : null);
        cells.forEach((cell) => tr.appendChild(mk('th', null, cell.t)));
        if (rowIndex === 0) tr.appendChild(mk('th', 'form-head-actions')).rowSpan = all.length;
        thead.appendChild(tr);
      });
      renumber();
    }

    function renumber() {
      Array.from(tbody.children).forEach((tr, index) => {
        tr.firstElementChild.textContent = String(index + 1).padStart(2, '0');
      });
    }

    const rowIndexOf = (tr) => Array.prototype.indexOf.call(tbody.children, tr);

    // The column a row is known by elsewhere (a photo's name, whether a
    // row is blank): the one the certificate is read at, else the first
    // number column.
    const certCol = cols.find((c) => c.type === 'cert');
    const labCol = (certCol && cols.find((c) => c.id === certCol.certOf)) || cols.find((c) => c.type === 'number');

    // On a phone (style.css, .tpl-split), a card whose table has two sets
    // of readings (the standard's, then the UUT's, as the paper worksheet
    // has them) puts the first set down the left and the second down the
    // right, each with the figures worked out from it under it. A set is
    // a run of typed readings and what follows it up to the next run.
    // What comes before the first set (the test point) is two to a line
    // above; tolerances and Pass / Fail go across the foot. Any other
    // shape (one set, three) keeps the ordinary layout.
    const phoneLayout = (() => {
      const isReading = (c) => c.type === 'number' && !c.preset;
      const isFoot = (c) => c.type === 'tol' || c.type === 'result' || c.type === 'passfail';
      const sides = [];
      const pre = [];
      const foot = [];
      cols.forEach((c, j) => {
        if (isFoot(c)) foot.push(c);
        else if (isReading(c) && (j === 0 || !isReading(cols[j - 1]) || isFoot(cols[j - 1]))) sides.push([c]);
        else if (sides.length) sides[sides.length - 1].push(c);
        else pre.push(c);
      });
      if (sides.length !== 2) return null;
      const place = {};
      let row = 2; // row 1 is "No. 01" and the buttons
      pre.forEach((c, i) => { place[c.id] = { row: row + Math.floor(i / 2), cls: i % 2 ? 'tpl-r' : 'tpl-l' }; });
      row += Math.ceil(pre.length / 2);
      sides[0].forEach((c, i) => { place[c.id] = { row: row + i, cls: 'tpl-l' }; });
      sides[1].forEach((c, i) => { place[c.id] = { row: row + i, cls: 'tpl-r' }; });
      row += Math.max(sides[0].length, sides[1].length);
      foot.forEach((c) => { place[c.id] = { row: row++, cls: 'tpl-full' }; });
      return { place, photosRow: row };
    })();
    // A figure added up from readings (the reference's actual reading,
    // a correction: a certificate column, or a formula of only + and −
    // over columns) is shown to the resolution the readings it comes from
    // were typed at: the most decimals among them, in that row. Anything
    // else (averages, spreads, ratios, percentages) keeps the usual
    // 4 significant figures. Only what's shown is rounded; calculation
    // carries on with the full value.
    const resolutionFrom = (() => {
      const treeOf = (c) => { try { return parseFormula(c.formula); } catch (e) { return null; } };
      const typedUnder = (j, seen) => {
        const c = cols[j];
        if (!c || seen.has(j)) return [];
        seen.add(j);
        if (c.type === 'number') return [j];
        if (c.type === 'cert') return typedUnder(cols.findIndex((x) => x.id === c.certOf), seen);
        if (c.type !== 'calc') return [];
        const tree = treeOf(c);
        const found = [];
        const walk = (n) => {
          if (!n) return;
          if (n.op === 'ref') found.push(...typedUnder(n.col, seen));
          if (n.op === 'range') for (let k = n.from; k <= n.to; k += 1) found.push(...typedUnder(k, seen));
          walk(n.a);
          walk(n.b);
          (n.args || []).forEach(walk);
        };
        walk(tree);
        return found;
      };
      const onlyAddSubtract = (n) => Boolean(n) && (n.op === 'ref'
        || ((n.op === '+' || n.op === '-') && onlyAddSubtract(n.a) && onlyAddSubtract(n.b))
        || (n.op === 'neg' && onlyAddSubtract(n.a)));
      return cols.map((c, j) => {
        if (c.type === 'cert' || (c.type === 'calc' && onlyAddSubtract(treeOf(c)))) {
          const from = typedUnder(j, new Set());
          return from.length ? from : null;
        }
        return null;
      });
    })();
    const decimalsOf = (text) => {
      const s = String(text == null ? '' : text).trim();
      if (!s || /e/i.test(s) || !Number.isFinite(Number(s))) return -1;
      const dot = s.indexOf('.');
      return dot < 0 ? 0 : s.length - dot - 1;
    };
    const atResolution = (value, from, raw) => {
      if (!from || !Number.isFinite(value)) return null;
      const dp = Math.max(-1, ...from.map((k) => decimalsOf(raw[k])));
      if (dp < 0) return null; // nothing typed yet to take it from
      const text = value.toFixed(Math.min(dp, 10));
      return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
    };

    const placeCell = (td, at) => {
      td.classList.add(at.cls);
      td.style.setProperty('--tpl-row', String(at.row));
    };

    function addRow(state) {
      const values = { ...((state && state.v) || {}) };
      if (state && labCol && !values[labCol.id] && state.labRdg) values[labCol.id] = state.labRdg;
      const rowIdx = tbody.children.length;

      const tr = mk('tr', phoneLayout ? 'form-row tpl-split' : 'form-row');
      tr.appendChild(mk('td', 'form-no')).dataset.label = 'No.';
      const inputs = {};
      const cells = {};
      cols.forEach((c) => {
        const td = mk('td', 'form-cell form-w2');
        td.dataset.label = columnHeading(c);
        if (phoneLayout) placeCell(td, phoneLayout.place[c.id]);
        cells[c.id] = td;
        if (isComputed(c) || c.type === 'tol') {
          td.classList.add('form-calc');
          td.textContent = '—';
        } else if (isPresetCell(c, rowIdx, t.rows)) {
          td.classList.add('form-calc', 'tpl-preset');
          td.textContent = String(c.values[rowIdx]);
        } else if (c.type === 'passfail') {
          const select = mk('select');
          ['', 'Pass', 'Fail'].forEach((o) => { select.appendChild(mk('option', null, o || '—')).value = o; });
          select.value = values[c.id] || '';
          select.setAttribute('aria-label', columnHeading(c));
          inputs[c.id] = select;
          td.appendChild(select);
        } else {
          const input = mk('input');
          input.type = 'text';
          input.setAttribute('aria-label', columnHeading(c));
          if (c.type === 'number') {
            input.inputMode = 'decimal';
            if (typeof restrictInput === 'function') restrictInput(input, (text) => cleanNumberText(text, true));
          }
          if (values[c.id]) input.value = values[c.id];
          inputs[c.id] = input;
          td.appendChild(input);
        }
        tr.appendChild(td);
      });

      const photoBtn = mk('button', 'interp-row-photo');
      photoBtn.type = 'button';
      photoBtn.title = 'Add a photo of this reading';
      photoBtn.setAttribute('aria-label', 'Add a photo of this reading');
      photoBtn.innerHTML = PHOTO_ICON;
      const actionsTd = mk('td', 'interp-row-actions form-actions');
      actionsTd.appendChild(photoBtn);
      // The template's own rows stay (their test points are by row);
      // rows added beyond them can go again.
      if (rowIdx >= t.rows) {
        const removeBtn = mk('button', 'interp-row-remove');
        removeBtn.type = 'button';
        removeBtn.title = 'Remove row';
        removeBtn.setAttribute('aria-label', 'Remove row');
        removeBtn.innerHTML = REMOVE_ICON;
        removeBtn.addEventListener('click', () => {
          const rowPhotos = tr._photos.slice();
          tr.remove();
          renumber();
          env.onChange();
          if (typeof deleteUnusedPhotos === 'function') deleteUnusedPhotos(rowPhotos);
        });
        actionsTd.appendChild(removeBtn);
      }
      const photosTd = mk('td', 'interp-row-photos');
      if (phoneLayout) placeCell(photosTd, { row: phoneLayout.photosRow, cls: 'tpl-full' });
      tr.append(actionsTd, photosTd);

      tr._photos = [];
      function addRowPhoto(photoId, dataUrl) {
        tr._photos.push(photoId);
        const thumb = buildPhotoThumb(photoId, () => {
          tr._photos = tr._photos.filter((p) => p !== photoId);
          thumb.remove();
          env.onChange();
          deleteUnusedPhotos([photoId]);
        }, dataUrl);
        photosTd.appendChild(thumb);
      }
      (state && Array.isArray(state.photos) ? state.photos : []).forEach((photoId) => addRowPhoto(photoId));
      photoBtn.addEventListener('click', () => {
        capturePhoto((photoId, dataUrl) => {
          if (!tr.isConnected) {
            deletePhoto(photoId);
            return;
          }
          addRowPhoto(photoId, dataUrl);
          env.onChange();
        });
      });

      let texts = cols.map(() => '');
      function recompute() {
        const idx = rowIndexOf(tr);
        const raw = cols.map((c) => (c.type === 'tol' ? tolState[c.id] || '' : inputs[c.id] ? inputs[c.id].value : ''));
        const { out, nums, errors } = evaluateRow(t, raw, idx, { cf: env.cf });
        tr._eval = { out, nums, idx };
        let judged = false;
        let failed = false;
        cols.forEach((c) => cells[c.id].classList.remove('tol-pass', 'tol-fail', 'cell-error'));
        texts = cols.map((c, j) => {
          const td = cells[c.id];
          if (c.type === 'tol') {
            const text = Number.isFinite(nums[j]) ? `±${displayNum(nums[j])}` : '';
            td.textContent = text || '—';
            const spec = tolSpecText(out[j]);
            return text && spec ? `${text} (${spec})` : text || spec;
          }
          if (c.type === 'passfail') {
            if (out[j]) {
              judged = true;
              if (out[j] === 'Fail') failed = true;
              td.classList.add(out[j] === 'Pass' ? 'tol-pass' : 'tol-fail');
            }
            return out[j];
          }
          if (!isComputed(c)) return out[j];
          if (errors[j]) {
            td.textContent = errors[j];
            td.classList.add('cell-error');
            return errors[j];
          }
          if (c.type === 'result') {
            td.textContent = out[j] === 'Pass' ? '✓ Pass' : out[j] === 'Fail' ? '✗ Fail' : '—';
            if (out[j]) {
              judged = true;
              td.classList.add(out[j] === 'Pass' ? 'tol-pass' : 'tol-fail');
              if (out[j] === 'Fail') {
                failed = true;
                if (cells[c.resultOf]) cells[c.resultOf].classList.add('tol-fail');
              }
            }
            return out[j];
          }
          const shown = out[j] === '' ? '' : atResolution(nums[j], resolutionFrom[j], raw) ?? out[j];
          td.textContent = shown === '' ? '—' : shown;
          return shown;
        });
        tr.classList.toggle('row-tol-fail', failed);
        tr.classList.toggle('row-tol-pass', judged && !failed);
      }

      Object.keys(inputs).forEach((id) => {
        const input = inputs[id];
        input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
          recompute();
          env.onChange();
        });
      });

      tr._recompute = recompute;
      tr._values = () => {
        const typed = {};
        Object.keys(inputs).forEach((id) => {
          if (inputs[id].value !== '') typed[id] = inputs[id].value;
        });
        return typed;
      };
      tr._texts = () => texts.slice();
      // Where a failure shows, as positions in the record's row (0 is the number).
      tr._fails = () => cols.map((c, j) => (cells[c.id].classList.contains('tol-fail') ? j + 1 : -1)).filter((j) => j > 0);
      // Required: every cell the template leaves to be typed in its own rows.
      tr._missing = () => {
        const idx = rowIndexOf(tr);
        if (idx >= t.rows) return false;
        return cols.some((c) => (c.type === 'tol' ? !tolState[c.id] : isCellEditable(c, idx, t.rows) && !String(inputs[c.id] ? inputs[c.id].value : '').trim()));
      };
      tbody.appendChild(tr);
      renumber();
      recompute();
    }

    function recomputeAll() {
      Array.from(tbody.children).forEach((tr) => tr._recompute());
    }

    function rowState(tr) {
      const v = tr._values();
      const lab = labCol ? v[labCol.id] || '' : '';
      return {
        labRdg: lab,
        uutRdg: cols.filter((c) => c !== labCol && v[c.id]).map((c) => v[c.id]).join(', '),
        photos: tr._photos.slice(),
        v,
      };
    }

    setHead();
    return {
      setHead,
      addRow,
      recompute: recomputeAll,
      collect() {
        return Array.from(tbody.children).map(rowState);
      },
      getTol() {
        return { ...tolState };
      },
      // The rows as a budget works from them, worked out: [{ out, nums }].
      // The template's own rows, and any added row with something in it.
      evaluated() {
        return Array.from(tbody.children)
          .filter((tr) => tr._eval && (tr._eval.idx < t.rows || Object.keys(tr._values()).length > 0))
          .map((tr) => ({ out: tr._eval.out, nums: tr._eval.nums }));
      },
      // Something the template needs is still blank.
      isMissingRequired() {
        return Array.from(tbody.children).some((tr) => tr._missing());
      },
      // The table as a saved record keeps it: headings and every cell as
      // it reads now, with where it's out of tolerance — so the Records
      // page and the printed sheet show it without the template. Rows
      // with nothing typed in them are left out.
      record() {
        const kept = Array.from(tbody.children).filter((tr) => Object.keys(tr._values()).length > 0 || tr._photos.length > 0);
        const firstResult = cols.find((c) => c.type === 'result');
        const at = (tr, id) => { const j = cols.findIndex((c) => c.id === id); return j < 0 ? '' : tr._texts()[j]; };
        return {
          form: {
            id: item.id,
            name: item.title || 'Calibration table',
            head: head(),
            rows: kept.map((tr, index) => [String(index + 1).padStart(2, '0'), ...tr._texts()]),
            fails: kept.map((tr) => tr._fails()),
          },
          rows: kept.map((tr) => ({
            ...rowState(tr),
            labCorrectionRdg: '',
            actLabRdg: certCol ? at(tr, certCol.id) : '',
            correctionRdg: firstResult ? at(tr, firstResult.resultOf) : '',
            outOfTolerance: tr.classList.contains('row-tol-fail'),
          })),
        };
      },
    };
  }

  // A template as an open worksheet keeps a copy of it (in case it's
  // removed before the worksheet is saved): without its pictures, which
  // would make every worksheet's saved state heavy.
  function withoutMedia(template) {
    if (!template) return null;
    const form = JSON.parse(JSON.stringify(template.form || {}));
    (form.items || []).forEach((it) => { delete it.image; });
    return { id: template.id, name: template.name, form };
  }

  const hasCertColumn = (item) => Boolean(item && item.table && Array.isArray(item.table.columns) && item.table.columns.some((c) => c.type === 'cert'));

  // ---------- uncertainty budget ----------
  // A template item of type 'budget' (Digital Worksheet Designer 0.6.0):
  // worked out for every test point (row) of one of the template's
  // calibration tables — the maths is calc-core.js's evaluateBudget, the
  // same as Designer's. docs/CALFRM.md describes the item.

  const { evaluateBudget, dofText, isTypeA } = C;

  // The calibration table a budget is worked out from: the one it names,
  // else the nearest one before it, else the first.
  function budgetTableOf(form, item) {
    const items = (form && form.items) || [];
    const tables = items.filter((it) => it && it.type === 'calibration' && it.table);
    const named = tables.find((it) => item && item.budget && it.id === item.budget.tableId);
    if (named) return named;
    const at = items.indexOf(item);
    return items.slice(0, at < 0 ? items.length : at).reverse().find((it) => it && it.type === 'calibration' && it.table) || tables[0] || null;
  }

  // Does this calibration table need its reference certificate (for its
  // own correction columns, or a budget reading the certificate's
  // uncertainty)?
  function usesReference(form, tableItem) {
    if (!tableItem || tableItem.type !== 'calibration' || !tableItem.table) return false;
    if (hasCertColumn(tableItem)) return true;
    return ((form && form.items) || []).some((b) => b && b.type === 'budget' && budgetTableOf(form, b) === tableItem
      && ((b.budget && b.budget.sources) || []).some((s) => s.from === 'cert'));
  }

  // The table's one unit (older templates: the first column unit).
  function tableUnitOf(t) {
    if (!t) return '';
    if (typeof t.unit === 'string') return t.unit.trim();
    const c = (t.columns || []).find((x) => typeof x.unit === 'string' && x.unit.trim());
    return c ? c.unit.trim() : '';
  }

  // What a test point is called: the row's first pre-filled value (the
  // test point), else its first value, else "Row n".
  function budgetPointLabel(t, out, i) {
    const j = t.columns.findIndex((c) => c.preset && !isComputed(c));
    const v = String((out && out[j >= 0 ? j : 0]) ?? '').trim();
    return v || `Row ${i + 1}`;
  }

  // A number as a worksheet keeps it: null for blank, "inf" for infinite.
  const keepNum = (n) => (n === Infinity ? 'inf' : Number.isFinite(n) ? n : null);
  const keptNum = (v) => (v === 'inf' ? Infinity : typeof v === 'number' ? v : NaN);

  const kText = (k) => (Number.isFinite(k) ? k.toFixed(2) : '—');
  const fig = (n) => displayNum(n) || '—';
  // The reported expanded uncertainty: 2 significant figures ("1.2",
  // "0.034", "120"), rounded to the nearest. The budget's own figures
  // (uc, each source) keep 4.
  function figU(n) {
    if (n === Infinity) return '∞';
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    const r = Number(n.toPrecision(2));
    return Math.abs(r) >= 100 ? String(r) : r.toPrecision(2);
  }

  // A kept budget in words, for the Records page and the printed sheet:
  // "30: U = 1.2 %rh (k = 2.00); 50: …".
  function budgetText(v) {
    const unit = v && v.unit ? ` ${v.unit}` : '';
    return ((v && Array.isArray(v.points)) ? v.points : [])
      .filter((p) => Number.isFinite(keptNum(p.U)))
      .map((p) => `${p.label}: U = ${figU(keptNum(p.U))}${unit} (k = ${kText(keptNum(p.k))})`)
      .join('; ');
  }

  const DIST_NAME = { A: 'Normal', normal: 'Normal', rect: 'Rectangular', res: 'Rectangular', tri: 'Triangular', u: 'U-shaped' };
  function divisorText(src) {
    switch (src.dist) {
      case 'A': return `√${Math.floor(Number(src.n)) || 'n'}`;
      case 'normal': return String(Number(src.k) > 0 ? Number(src.k) : 2);
      case 'res': return '2√3';
      case 'tri': return '√6';
      case 'u': return '√2';
      default: return '√3';
    }
  }

  function tableOf(headCells, rows, className) {
    const wrap = mk('div', 'interp-table-wrap');
    const table = mk('table', `data-table tpl-budget-table ${className || ''}`);
    const tr = mk('tr');
    headCells.forEach((cell) => {
      const th = mk('th', null, cell.text);
      if (cell.sub) th.appendChild(mk('span', 'tpl-budget-sub', cell.sub));
      tr.appendChild(th);
    });
    table.appendChild(mk('thead')).appendChild(tr);
    const tbody = table.appendChild(mk('tbody'));
    rows.forEach((cells) => {
      const row = mk('tr', cells.className || null);
      (cells.cells || cells).forEach((cell) => {
        const td = mk(cell.th ? 'th' : 'td', cell.cls || null, cell.text);
        if (cell.span) td.colSpan = cell.span;
        if (cell.title) td.title = cell.title;
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    wrap.appendChild(table);
    return wrap;
  }

  // One budget's card. `opts.getTable()` → { item, rows: [{ out, nums }],
  // uf } of the table it's worked out from (uf: the reference
  // certificate's uncertainty at a reading), or null.
  // `opts.getUutResolution()` → the worksheet's SR (Scale Resolution): a
  // 'uut-sr' source (the UUT's resolution) is that, not typed in the
  // budget — so it's typed once, in UUT info. refresh() draws it
  // again; getValue() works it out now, as the worksheet keeps it:
  // { typed, unit, points: [{ label, sources: [{ value, u, cu, dof }], uc, veff, k, U }] }.
  function createBudget(item, initial, onChange, opts) {
    const b = item.budget || { sources: [] };
    const sources = Array.isArray(b.sources) ? b.sources : [];
    const card = mk('section', 'input-panel tpl-question tpl-budget');
    card.dataset.itemId = item.id;
    const title = mk('h3', 'tpl-q-title', item.title || 'Uncertainty budget');
    if (item.required) {
      const star = mk('span', 'tpl-req', ' *');
      star.title = 'Required';
      title.appendChild(star);
    }
    card.appendChild(title);
    if (item.description) card.appendChild(mk('p', 'tpl-q-desc', item.description));
    const media = mediaView(item);
    if (media) card.appendChild(media);
    const note = mk('p', 'tpl-q-desc');
    card.appendChild(note);
    const error = mk('p', 'tpl-q-error');
    error.setAttribute('role', 'alert');

    const typed = { ...((initial && initial.typed) || {}) };
    const srSources = sources.filter((s) => s.from === 'uut-sr');
    const uutResolution = () => (opts && typeof opts.getUutResolution === 'function' ? String(opts.getUutResolution() ?? '') : '');
    // What the budget was given: typed into it, and the SR for each 'uut-sr' source.
    const given = () => {
      const all = { ...typed };
      srSources.forEach((s) => { all[s.id] = uutResolution(); });
      return all;
    };
    const typedSources = sources.filter((s) => s.from === 'respondent');
    if (typedSources.length > 0) {
      const grid = mk('div', 'tpl-panel-fields tpl-budget-typed');
      typedSources.forEach((s) => {
        const row = mk('div', 'entry-form-row tpl-field');
        const id = uniqueName('tpl-budget');
        const label = mk('label', null, s.name || 'Value');
        label.htmlFor = id;
        const input = mk('input', 'tpl-input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.id = id;
        input.value = typed[s.id] ?? '';
        if (typeof restrictInput === 'function' && typeof cleanNumberText === 'function') restrictInput(input, (text) => cleanNumberText(text, false));
        input.addEventListener('input', () => {
          typed[s.id] = input.value;
          error.textContent = '';
          card.classList.remove('tpl-has-error');
          refresh();
          onChange();
        });
        row.append(label, input);
        grid.appendChild(row);
      });
      card.appendChild(grid);
    }
    const results = mk('div', 'tpl-budget-results');
    card.append(results, error);

    const state = { pick: 0 };

    function compute() {
      const tb = opts && typeof opts.getTable === 'function' ? opts.getTable() : null;
      if (!tb) return { tb: null, unit: '', points: [] };
      const t = tb.item.table;
      const env = { uf: tb.uf, typed, uutResolution: uutResolution() };
      const points = tb.rows.map((r, i) => ({ label: budgetPointLabel(t, r.out, i), ...evaluateBudget(b, r.nums, t.columns, env) }));
      return { tb, unit: tableUnitOf(t), points };
    }

    // One test point's full budget, as a slide: narrow enough for a phone
    // (no sideways scrolling inside a slide, which would fight the swipe).
    // Each source's type, distribution, divisor and cᵢ (when not 1) are
    // under its name.
    function slide(point, i, count, unit) {
      const u = unit ? ` ${unit}` : '';
      const el = mk('section', 'tpl-budget-slide');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-roledescription', 'slide');
      el.setAttribute('aria-label', `Test point ${point.label}${u}, ${i + 1} of ${count}`);
      const head = mk('div', 'tpl-budget-slide-head');
      head.append(mk('span', 'tpl-budget-slide-point', `Test point ${point.label}${u}`),
        mk('span', 'tpl-budget-slide-U', Number.isFinite(point.U) ? `U = ${figU(point.U)}${u} (k =${kText(point.k)})` : 'U not worked out yet'));
      el.appendChild(head);

      const table = mk('table', 'data-table tpl-budget-table tpl-budget-detail');
      const hr = mk('tr');
      ['Source', 'Value', 'u(xᵢ)', 'cᵢ·u', 'νᵢ'].forEach((text) => hr.appendChild(mk('th', null, text)));
      table.appendChild(mk('thead')).appendChild(hr);
      const tbody = table.appendChild(mk('tbody'));
      point.sources.forEach((s, j) => {
        const src = sources[j] || {};
        const tr = mk('tr');
        const name = mk('td', 'tpl-budget-src', src.name || `Source ${j + 1}`);
        const ciText = src.ci !== undefined ? String(src.ci).trim() : '';
        const ci = ciText !== '' && ciText !== '1' ? ` · cᵢ = ${ciText}` : '';
        name.appendChild(mk('span', 'tpl-budget-sub', `Type ${isTypeA(src) ? 'A' : 'B'} · ${DIST_NAME[src.dist] || ''} · ÷ ${divisorText(src)}${ci}`));
        tr.append(
          name,
          mk('td', s.error ? 'interp-computed cell-error' : 'interp-computed', s.error || fig(s.value)),
          mk('td', 'interp-computed', fig(s.u)),
          mk('td', 'interp-computed', fig(s.cu)),
          mk('td', null, dofText(s.dof) || '—'));
        tbody.appendChild(tr);
      });
      const total = (label, value, cls) => {
        const tr = mk('tr', cls || null);
        const th = mk('th', null, label);
        th.colSpan = 3;
        const td = mk('td', 'interp-computed', value);
        td.colSpan = 2;
        tr.append(th, td);
        tbody.appendChild(tr);
      };
      total('Combined standard uncertainty, uc', fig(point.uc));
      total('Effective degrees of freedom, νeff', dofText(point.veff) || '—');
      total('Coverage factor, k (95.45 %)', kText(point.k));
      total(`Expanded uncertainty, U = k × uc${unit ? ` (${unit})` : ''}`, figU(point.U), 'tpl-budget-U');
      el.appendChild(table);
      return el;
    }

    // Every test point's budget side by side, one at a time: swiped left
    // and right on a phone (scroll snapping), or with ‹ › and the dots.
    // `state.pick` is the one showing, kept when the budget is redrawn.
    function slider(points, unit) {
      const box = mk('div', 'tpl-budget-slider');
      box.setAttribute('role', 'region');
      box.setAttribute('aria-roledescription', 'carousel');
      box.setAttribute('aria-label', 'Budget at each test point');
      const nav = mk('div', 'tpl-budget-nav');
      const prev = mk('button', 'tpl-budget-arrow', '‹');
      const next = mk('button', 'tpl-budget-arrow', '›');
      prev.type = 'button';
      next.type = 'button';
      prev.setAttribute('aria-label', 'Previous test point');
      next.setAttribute('aria-label', 'Next test point');
      const where = mk('span', 'tpl-budget-where');
      where.setAttribute('aria-live', 'polite');
      nav.append(prev, where, next);
      const track = mk('div', 'tpl-budget-track');
      track.tabIndex = 0;
      track.setAttribute('aria-label', 'Swipe left or right for the other test points');
      points.forEach((p, i) => track.appendChild(slide(p, i, points.length, unit)));
      const dots = mk('div', 'tpl-budget-dots');
      const dotBtns = points.map((p, i) => {
        const dot = mk('button', 'tpl-budget-dot');
        dot.type = 'button';
        dot.setAttribute('aria-label', `Test point ${p.label}`);
        dot.addEventListener('click', () => goTo(i, true));
        dots.appendChild(dot);
        return dot;
      });

      function show(i) {
        state.pick = i;
        where.textContent = `${points[i].label}${unit ? ` ${unit}` : ''} · ${i + 1} of ${points.length}`;
        prev.disabled = i === 0;
        next.disabled = i === points.length - 1;
        dotBtns.forEach((d, k) => {
          d.classList.toggle('on', k === i);
          d.setAttribute('aria-current', k === i ? 'true' : 'false');
        });
      }
      function goTo(i, smooth) {
        const k = Math.max(0, Math.min(points.length - 1, i));
        track.scrollTo({ left: k * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
        show(k);
        // A smooth scroll a browser cut short (or never ran) still ends on the slide.
        if (smooth) {
          setTimeout(() => {
            const left = k * track.clientWidth;
            if (state.pick === k && Math.abs(track.scrollLeft - left) > 2) track.scrollLeft = left;
          }, 700);
        }
      }
      // which slide a swipe came to rest on
      const settled = () => {
        if (track.clientWidth > 0) show(Math.max(0, Math.min(points.length - 1, Math.round(track.scrollLeft / track.clientWidth))));
      };
      let settle = 0;
      track.addEventListener('scroll', () => {
        clearTimeout(settle);
        settle = setTimeout(settled, 80);
      });
      track.addEventListener('scrollend', settled);
      track.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(state.pick - 1, true); }
        if (e.key === 'ArrowRight') { e.preventDefault(); goTo(state.pick + 1, true); }
      });
      prev.addEventListener('click', () => goTo(state.pick - 1, true));
      next.addEventListener('click', () => goTo(state.pick + 1, true));
      box.append(nav, track, dots);
      show(Math.min(state.pick, points.length - 1));
      return { el: box, goTo, restore: () => goTo(state.pick, false) };
    }

    function refresh() {
      const { tb, unit, points } = compute();
      if (!tb) {
        note.textContent = 'This budget has no calibration table in the template to be worked out from.';
        results.replaceChildren();
        return;
      }
      const readsCert = sources.some((s) => s.from === 'cert');
      note.textContent = `For each test point of “${tb.item.title || 'the calibration table'}”.`
        + (readsCert ? ' The reference standard’s uncertainty is read off the certificate chosen for that table.' : '')
        + (srSources.length > 0 ? ` ${srSources.map((s) => s.name || 'The UUT resolution').join(', ')} is the SR (Scale Resolution) in UUT info.` : '');
      if (points.length === 0) {
        results.replaceChildren(mk('p', 'camera-note', 'Worked out as readings are typed into the table.'));
        return;
      }
      const u = unit ? ` (${unit})` : '';
      const summary = tableOf(
        [{ text: 'Test point' }, ...sources.map((s, i) => ({ text: s.name || `Source ${i + 1}`, sub: 'cᵢ·u' })),
          { text: 'uc' }, { text: 'νeff' }, { text: 'k' }, { text: `U${u}` }],
        points.map((p) => [
          { text: p.label, cls: 'tpl-budget-point' },
          ...p.sources.map((s) => ({ text: s.error || fig(s.cu), cls: s.error ? 'interp-computed cell-error' : 'interp-computed', title: s.error || '' })),
          { text: fig(p.uc), cls: 'interp-computed' },
          { text: dofText(p.veff) || '—', cls: 'interp-computed' },
          { text: kText(p.k), cls: 'interp-computed' },
          { text: figU(p.U), cls: 'interp-computed tpl-budget-U' },
        ]), 'tpl-budget-summary');
      state.pick = Math.min(state.pick, points.length - 1);
      const slides = slider(points, unit);
      // A test point's row in the summary shows its full budget below.
      summary.querySelectorAll('tbody tr').forEach((tr, i) => {
        tr.classList.add('tpl-budget-row');
        tr.title = 'Show this test point’s full budget';
        tr.addEventListener('click', () => {
          slides.goTo(i, true);
          slides.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      });
      results.replaceChildren(summary, mk('p', 'tpl-budget-hint', 'Full budget at each test point — swipe left or right'), slides.el);
      slides.restore();
    }

    function getValue() {
      const { unit, points } = compute();
      return {
        typed: given(),
        unit,
        points: points.map((p) => ({
          label: p.label,
          sources: p.sources.map((s) => ({ value: keepNum(s.value), u: keepNum(s.u), cu: keepNum(s.cu), dof: keepNum(s.dof) })),
          uc: keepNum(p.uc), veff: keepNum(p.veff), k: keepNum(p.k), U: keepNum(p.U),
        })),
      };
    }

    return {
      el: card,
      item,
      refresh,
      getValue,
      isEmpty: () => isAnswerEmpty(item, { typed: given() }),
      // What to say when it's required and something isn't filled in yet.
      requiredMessage() {
        const missing = sources.filter((s) => s.from === 'respondent' && blank(typed[s.id])).map((s) => s.name || 'a value');
        if (srSources.length > 0 && blank(uutResolution())) missing.push('the SR (Scale Resolution) in UUT info');
        return missing.length > 0 ? `Fill in ${missing.join(', ')}` : 'This is a required question';
      },
      showError(message) {
        error.textContent = message || '';
        card.classList.toggle('tpl-has-error', Boolean(message));
      },
    };
  }

  global.WorksheetTemplates = {
    // maths
    toNum,
    formatNum,
    displayNum,
    colLetter,
    columnHeading,
    columnUnit,
    parseFormula,
    evalFormula,
    evalCert,
    parseTol,
    encodeTol,
    toleranceLimit,
    tolSpecText,
    evalResult,
    isComputed,
    isPresetCell,
    isCellEditable,
    evaluateRow,
    isAnswerEmpty,
    answerText,
    QUESTION_TYPES,
    appSectionOf,
    placeInAppSections,
    hasCertColumn,
    usesReference,
    budgetTableOf,
    budgetPointLabel,
    budgetText,
    withoutMedia,
    // page
    createSectionCard,
    createQuestion,
    createTemplateRows,
    createBudget,
  };
})(typeof window !== 'undefined' ? window : globalThis);
