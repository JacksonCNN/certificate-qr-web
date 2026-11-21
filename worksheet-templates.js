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

    function addRow(state) {
      const values = { ...((state && state.v) || {}) };
      if (state && labCol && !values[labCol.id] && state.labRdg) values[labCol.id] = state.labRdg;
      const rowIdx = tbody.children.length;

      const tr = mk('tr', 'form-row');
      tr.appendChild(mk('td', 'form-no')).dataset.label = 'No.';
      const inputs = {};
      const cells = {};
      cols.forEach((c) => {
        const td = mk('td', 'form-cell form-w2');
        td.dataset.label = columnHeading(c);
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
          td.textContent = out[j] === '' ? '—' : out[j];
          return out[j];
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

  // A kept budget in words, for the Records page and the printed sheet:
  // "30: U = 1.207 %rh (k = 2.00); 50: …".
  function budgetText(v) {
    const unit = v && v.unit ? ` ${v.unit}` : '';
    return ((v && Array.isArray(v.points)) ? v.points : [])
      .filter((p) => Number.isFinite(keptNum(p.U)))
      .map((p) => `${p.label}: U = ${displayNum(keptNum(p.U))}${unit} (k = ${kText(keptNum(p.k))})`)
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

    function detail(point, unit) {
      const u = unit ? ` (${unit})` : '';
      return tableOf(
        [{ text: 'Source of uncertainty' }, { text: 'Type' }, { text: `Value${u}` }, { text: 'Distribution' }, { text: 'Divisor' },
          { text: `u(xᵢ)${u}` }, { text: 'cᵢ' }, { text: `cᵢ·u(xᵢ)${u}` }, { text: 'νᵢ' }],
        [
          ...point.sources.map((s, i) => {
            const src = sources[i] || {};
            return [
              { text: src.name || `Source ${i + 1}` },
              { text: isTypeA(src) ? 'A' : 'B' },
              { text: s.error || fig(s.value), cls: s.error ? 'interp-computed cell-error' : 'interp-computed' },
              { text: DIST_NAME[src.dist] || '' },
              { text: divisorText(src) },
              { text: fig(s.u), cls: 'interp-computed' },
              { text: src.ci !== undefined && String(src.ci).trim() !== '' ? String(src.ci) : '1' },
              { text: fig(s.cu), cls: 'interp-computed' },
              { text: dofText(s.dof) || '—' },
            ];
          }),
          [{ th: true, text: 'Combined standard uncertainty, uc', span: 7 }, { text: fig(point.uc), cls: 'interp-computed' }, { text: '' }],
          [{ th: true, text: 'Effective degrees of freedom, νeff', span: 7 }, { text: dofText(point.veff) || '—', cls: 'interp-computed' }, { text: '' }],
          [{ th: true, text: 'Coverage factor, k (95.45 %)', span: 7 }, { text: kText(point.k), cls: 'interp-computed' }, { text: '' }],
          { className: 'tpl-budget-U', cells: [{ th: true, text: `Expanded uncertainty, U = k × uc${u}`, span: 7 }, { text: fig(point.U), cls: 'interp-computed' }, { text: '' }] },
        ], 'tpl-budget-detail');
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
          { text: fig(p.U), cls: 'interp-computed tpl-budget-U' },
        ]), 'tpl-budget-summary');
      state.pick = Math.min(state.pick, points.length - 1);
      const detailBox = mk('div');
      detailBox.appendChild(detail(points[state.pick], unit));
      const pickRow = mk('div', 'tpl-budget-pick');
      const pickLabel = mk('label', null, 'Full budget at test point');
      const pick = mk('select');
      pick.id = uniqueName('tpl-budget-pick');
      pickLabel.htmlFor = pick.id;
      points.forEach((p, i) => { pick.appendChild(mk('option', null, p.label)).value = String(i); });
      pick.value = String(state.pick);
      pick.addEventListener('change', () => {
        state.pick = Number(pick.value);
        detailBox.replaceChildren(detail(points[state.pick], unit));
      });
      pickRow.append(pickLabel, pick);
      results.replaceChildren(summary, pickRow, detailBox);
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
