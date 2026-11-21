// calc-core.js — the calculation engine shared by Digital Worksheet
// Designer and the Certificate QR app, so a calibration table works out
// exactly the same figures in both.
//
// THIS FILE IS OWNED BY DIGITAL WORKSHEET DESIGNER (public/js/calc-core.js).
// The Certificate QR app keeps an identical copy (www/calc-core.js), made
// with its `npm run sync-calc-core`. Change it here, run the tests here
// (`npm test`, including test/calc-core.vectors.json), then sync. Both
// repositories run the same test vectors against their copy.
//
// What's in it:
//   - numbers: how a worked-out figure is shown (4 significant figures)
//   - formulas: column letters, + - * /, ABS, AVG, STDEV — parsed, never run
//   - a calibration table's row: pre-filled cells, formulas, the reference
//     certificate's correction, tolerances, Pass / Fail
//   - certificates: a certificate's points, the correction at a reading
//     (linear interpolation), unit conversion, and the certificates held
//     for a piece of equipment in the Certificate QR app's scan list
//   - uncertainty budget: each source's standard uncertainty, the combined
//     and expanded uncertainty, νeff and k (Student's t), per test point
//
// No DOM and no imports: it's a plain script that sets globalThis.CalcCore.
// A browser page loads it with <script>, an ES module with
// `import './calc-core.js'`, Node the same way.

(function (root) {
  'use strict';

  const CALC_CORE_VERSION = 4;

  // ---------- numbers ----------

  function toNum(v) {
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim();
    return s === '' ? NaN : Number(s);
  }

  // To 12 significant figures: hides float noise (0.1 + 0.2 shows as 0.3).
  function formatNum(n) {
    return String(Number(n.toPrecision(12)));
  }

  // A worked-out number as cells show and keep it: 4 significant figures
  // ("5.006", "0.2000", "10.01", "1235"), and below 0.001 — four or more
  // zeros in front, like 0.0005774 — in scientific notation ("5.774E-4").
  // Calculations carry on with the full value; only what's shown is rounded.
  function displayNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    if (n === 0) return '0';
    const r = Number(n.toPrecision(4));
    const size = Math.abs(r);
    if (size < 0.001) {
      const parts = r.toExponential(3).split('e');
      return `${parts[0]}E${Number(parts[1])}`;
    }
    if (size >= 1e4) return String(r); // toPrecision would switch to "1.235e+4"
    return r.toPrecision(4);
  }

  // A figure from a certificate, as messages quote it: up to 6 decimals.
  function plainNum(n) {
    if (!Number.isFinite(n)) return '—';
    return parseFloat(n.toFixed(6)).toString();
  }

  const colLetter = (i) => String.fromCharCode(65 + i);
  const MAX_COLS = 26;

  // ---------- formulas ----------
  // A formula is column letters (A–Z: that column's number in the same
  // row), numbers, + - * /, brackets and the functions
  //   ABS(x)               size of x
  //   AVG(…), STDEV(…)     average / sample standard deviation (as a
  //                        spreadsheet's AVERAGE / STDEV) of the arguments:
  //                        letters, expressions or ranges such as B:D.
  //                        Blank cells are left out.
  // Any other blank cell, or a result that isn't a finite number, makes the
  // whole cell blank. A formula comes from a form file: it is parsed here,
  // never run as code.

  const FUNCS = { ABS: 'ABS', AVG: 'AVG', AVERAGE: 'AVG', STDEV: 'STDEV' };

  function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z]+)|([-+*/(),:])|(#REF!?))/y;
    let at = 0;
    while (at < src.length) {
      if (/^\s*$/.test(src.slice(at))) break;
      re.lastIndex = at;
      const m = re.exec(src);
      if (!m) throw new Error(`Unexpected “${src.slice(at).trim()[0]}”`);
      if (m[1]) tokens.push({ t: 'num', v: Number(m[1]) });
      else if (m[2]) tokens.push({ t: 'name', v: m[2].toUpperCase() });
      else if (m[4]) throw new Error('This formula used a column that was deleted');
      else tokens.push({ t: m[3] });
      at = re.lastIndex;
    }
    return tokens;
  }

  // Parses a formula into a tree. Throws an Error with a readable message when it isn't one.
  function parseFormula(formula) {
    const tokens = tokenize(String(formula == null ? '' : formula));
    if (!tokens.length) throw new Error('Empty formula');
    let i = 0;
    const peek = () => tokens[i];
    const is = (t) => Boolean(tokens[i]) && tokens[i].t === t;
    const take = (t) => {
      if (!is(t)) throw new Error(tokens[i] ? `Expected “${t}”` : 'The formula ends too soon');
      return tokens[i++];
    };
    const letter = (name) => {
      if (!/^[A-Z]$/.test(name)) throw new Error(`“${name}” isn't a column letter or a function`);
      return name.charCodeAt(0) - 65;
    };
    function expr() {
      let node = term();
      while (is('+') || is('-')) node = { op: tokens[i++].t, a: node, b: term() };
      return node;
    }
    function term() {
      let node = unary();
      while (is('*') || is('/')) node = { op: tokens[i++].t, a: node, b: unary() };
      return node;
    }
    function unary() {
      if (is('-')) { i += 1; return { op: 'neg', a: unary() }; }
      if (is('+')) { i += 1; return unary(); }
      return atom();
    }
    function arg() {
      // a range such as B:D, or any expression
      if (is('name') && tokens[i + 1] && tokens[i + 1].t === ':') {
        const from = letter(tokens[i].v);
        i += 2;
        const to = letter(take('name').v);
        return { op: 'range', from: Math.min(from, to), to: Math.max(from, to) };
      }
      return expr();
    }
    function atom() {
      const tok = peek();
      if (!tok) throw new Error('The formula ends too soon');
      if (tok.t === 'num') { i += 1; return { op: 'num', v: tok.v }; }
      if (tok.t === '(') { i += 1; const node = expr(); take(')'); return node; }
      if (tok.t === 'name') {
        i += 1;
        if (is('(')) {
          const fn = FUNCS[tok.v];
          if (!fn) throw new Error(`Unknown function “${tok.v}”`);
          i += 1;
          const args = [arg()];
          while (is(',')) { i += 1; args.push(arg()); }
          take(')');
          if (fn === 'ABS' && (args.length !== 1 || args[0].op === 'range')) throw new Error('ABS takes one value');
          return { op: 'fn', fn, args };
        }
        return { op: 'ref', col: letter(tok.v) };
      }
      throw new Error(`Unexpected “${tok.t}”`);
    }
    const tree = expr();
    if (i < tokens.length) throw new Error(`Unexpected “${tokens[i].v != null ? tokens[i].v : tokens[i].t}”`);
    return tree;
  }

  // Rewrites the column letters in a formula, keeping the rest as typed.
  // `change(cols)` gets [i] for a single column, or [from, to] for a range
  // such as B:D, and returns the text to put in its place.
  function rewriteColumns(formula, change) {
    const src = String(formula == null ? '' : formula);
    const toks = [...src.matchAll(/[A-Za-z]+|\S/g)];
    const isCol = (k) => Boolean(toks[k]) && /^[A-Za-z]$/.test(toks[k][0]) && !(toks[k + 1] && toks[k + 1][0] === '(');
    const idx = (k) => toks[k][0].toUpperCase().charCodeAt(0) - 65;
    let out = '';
    let last = 0;
    for (let k = 0; k < toks.length; k += 1) {
      if (!isCol(k)) continue;
      const range = Boolean(toks[k + 1]) && toks[k + 1][0] === ':' && isCol(k + 2);
      const end = range ? k + 2 : k;
      out += src.slice(last, toks[k].index) + change(range ? [idx(k), idx(k + 2)] : [idx(k)]);
      last = toks[end].index + toks[end][0].length;
      k = end;
    }
    return out + src.slice(last);
  }

  // A formula after a new column is put in at position `at`: the letters from there on move along one.
  function formulaAfterInsert(formula, at) {
    return rewriteColumns(formula, (cols) => cols.map((c) => colLetter(c >= at ? c + 1 : c)).join(':'));
  }

  // A formula after the column at position `at` is deleted: later letters
  // move back one, a range shrinks, and a reference to the deleted column
  // itself becomes #REF! (which a designer shows as a problem).
  function formulaAfterDelete(formula, at) {
    return rewriteColumns(formula, (cols) => {
      if (cols.length === 1) return cols[0] === at ? '#REF!' : colLetter(cols[0] > at ? cols[0] - 1 : cols[0]);
      const lo = Math.min(...cols);
      const hi = Math.max(...cols);
      if (lo === at && hi === at) return '#REF!';
      return `${colLetter(lo > at ? lo - 1 : lo)}:${colLetter(hi >= at ? hi - 1 : hi)}`;
    });
  }

  // '' when the formula is fine, otherwise what's wrong (for a designer).
  function formulaProblem(formula, colCount) {
    const count = colCount == null ? MAX_COLS : colCount;
    try {
      const refs = [];
      const walk = (n) => {
        if (!n) return;
        if (n.op === 'ref') refs.push(n.col);
        if (n.op === 'range') refs.push(n.to);
        walk(n.a);
        walk(n.b);
        (n.args || []).forEach(walk);
      };
      walk(parseFormula(formula));
      const bad = refs.find((c) => c >= count);
      return bad === undefined ? '' : `There is no column ${colLetter(bad)}`;
    } catch (e) {
      return e.message;
    }
  }

  function evalNode(n, nums) {
    switch (n.op) {
      case 'num': return n.v;
      case 'ref': return typeof nums[n.col] === 'number' ? nums[n.col] : NaN;
      case 'neg': return -evalNode(n.a, nums);
      case '+': return evalNode(n.a, nums) + evalNode(n.b, nums);
      case '-': return evalNode(n.a, nums) - evalNode(n.b, nums);
      case '*': return evalNode(n.a, nums) * evalNode(n.b, nums);
      case '/': return evalNode(n.a, nums) / evalNode(n.b, nums);
      case 'fn': {
        if (n.fn === 'ABS') return Math.abs(evalNode(n.args[0], nums));
        const values = [];
        n.args.forEach((a) => {
          if (a.op === 'range') {
            for (let c = a.from; c <= a.to; c += 1) if (Number.isFinite(nums[c])) values.push(nums[c]);
          } else {
            const v = evalNode(a, nums);
            if (Number.isFinite(v)) values.push(v);
          }
        });
        if (!values.length) return NaN;
        const mean = values.reduce((x, y) => x + y, 0) / values.length;
        if (n.fn === 'AVG') return mean;
        if (values.length < 2) return NaN;
        return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
      }
      default: return NaN;
    }
  }

  // Formulas are parsed once per text and kept (a table works the same
  // formula out on every row, on every keystroke).
  const parsed = new Map();
  function treeOf(formula) {
    const key = String(formula == null ? '' : formula);
    if (!parsed.has(key)) {
      let tree = null;
      try { tree = parseFormula(key); } catch { tree = null; }
      if (parsed.size > 2000) parsed.clear();
      parsed.set(key, tree);
    }
    return parsed.get(key);
  }

  // The formula's full value (NaN when it can't be worked out), for further calculation.
  function evalFormulaValue(formula, nums) {
    const tree = treeOf(formula);
    if (!tree) return NaN;
    const v = evalNode(tree, nums);
    return Number.isFinite(v) ? v : NaN;
  }

  // …and as the cell shows it ('' when it can't be worked out).
  function evalFormula(formula, nums) {
    return displayNum(evalFormulaValue(formula, nums));
  }

  // ---------- a calibration table's row ----------

  const isComputed = (c) => Boolean(c) && (c.type === 'calc' || c.type === 'result' || c.type === 'cert');
  const indexOfId = (cols, id) => cols.findIndex((c) => c.id === id);

  // A certificate-correction cell: the reference's certificate read at the
  // value in col.certOf — that value + the correction (certMode
  // 'corrected', the default), or the correction alone ('factor').
  // `cf(x)` → { value, error } is the certificate read at x; see
  // correctionReader below. Returns { text, value, error }.
  function evalCert(col, nums, cols, cf) {
    const none = { text: '', value: NaN, error: '' };
    const x = nums[indexOfId(cols, col.certOf)];
    if (!Number.isFinite(x) || typeof cf !== 'function') return none;
    const r = cf(x) || {};
    if (r.error) return { text: '', value: NaN, error: String(r.error) };
    if (!Number.isFinite(r.value)) return none;
    const value = col.certMode === 'factor' ? r.value : x + r.value;
    return { text: displayNum(value), value, error: '' };
  }

  // A tolerance is typed as "% of reading" and/or a fixed value, kept as
  // "pct|fixed" — "0.5|0.02" is ± (0.5 % of the reading + 0.02).
  function parseTol(v) {
    const parts = String(v == null ? '' : v).split('|');
    return { pct: (parts[0] || '').trim(), fixed: (parts[1] || '').trim() };
  }

  function encodeTol(pct, fixed) {
    const p = String(pct == null ? '' : pct).trim();
    const f = String(fixed == null ? '' : fixed).trim();
    return p || f ? `${p}|${f}` : '';
  }

  // The ± limit: |pct % × reading| + |fixed|, the reading being the
  // row's value in col.tolRef. NaN until it can be worked out.
  function toleranceLimit(col, raw, nums, cols) {
    const tol = parseTol(raw);
    const p = toNum(tol.pct);
    const f = toNum(tol.fixed);
    const hasPct = Number.isFinite(p) && p !== 0;
    const hasFixed = Number.isFinite(f);
    if (!hasPct && !hasFixed) return NaN;
    let v = hasFixed ? Math.abs(f) : 0;
    if (hasPct) {
      const ref = nums[indexOfId(cols, col.tolRef)];
      if (typeof ref !== 'number' || !Number.isFinite(ref)) return NaN;
      v += Math.abs(ref * p) / 100;
    }
    return v;
  }

  // "0.5% rdg + 0.02" — how the entry reads.
  function tolSpecText(raw) {
    const tol = parseTol(raw);
    return [tol.pct && `${tol.pct}% rdg`, tol.fixed].filter(Boolean).join(' + ');
  }

  // Pass when the size of the checked column (col.resultOf, usually the
  // error) is within the tolerance column's limit (col.resultTol, else the
  // table's first tolerance column). The small margin is for the
  // arithmetic, so float noise never turns an exact pass into a fail.
  function evalResult(col, nums, cols) {
    const tolIdx = indexOfId(cols, col.resultTol);
    const at = tolIdx < 0 ? cols.findIndex((c) => c.type === 'tol') : tolIdx;
    const v = nums[indexOfId(cols, col.resultOf)];
    const limit = nums[at];
    if (!Number.isFinite(v) || !Number.isFinite(limit)) return '';
    return Math.abs(v) <= limit + 1e-9 * Math.max(1, limit) ? 'Pass' : 'Fail';
  }

  // A cell the designer filled in (a test point, say): not typed by the respondent.
  function isPresetCell(col, rowIdx, defaultRows) {
    return !isComputed(col) && col.type !== 'tol' && Boolean(col.preset) && rowIdx < defaultRows &&
      String(col.values && col.values[rowIdx] != null ? col.values[rowIdx] : '').trim() !== '';
  }

  function isCellEditable(col, rowIdx, defaultRows) {
    return !isComputed(col) && !isPresetCell(col, rowIdx, defaultRows);
  }

  // One row. `row` is what was typed, by column position (a tolerance
  // column's is its "pct|fixed" entry). Returns the cells as text (out),
  // as numbers (nums — a tolerance column's is its ± limit, so formulas
  // can use it) and what to show in place of a cell that can't be worked
  // out (errors, e.g. a certificate's "Out of range (0–10)").
  // `env.cf(x)` reads the reference certificate (correctionReader below).
  // Columns are worked out left to right, at full value; results last.
  function evaluateRow(table, row, rowIdx, env) {
    const cols = (table && table.columns) || [];
    const cf = env && env.cf;
    const out = cols.map((c, j) => {
      if (isComputed(c)) return '';
      if (isPresetCell(c, rowIdx, table.rows)) return String(c.values[rowIdx]);
      return String(row && row[j] != null ? row[j] : '');
    });
    const nums = out.map(toNum);
    const errors = cols.map(() => '');
    cols.forEach((c, j) => {
      if (c.type === 'calc') {
        nums[j] = evalFormulaValue(c.formula, nums);
        out[j] = displayNum(nums[j]);
      } else if (c.type === 'cert') {
        const r = evalCert(c, nums, cols, cf);
        out[j] = r.text;
        errors[j] = r.error;
        nums[j] = r.value;
      } else if (c.type === 'tol') {
        nums[j] = toleranceLimit(c, out[j], nums, cols);
      }
    });
    cols.forEach((c, j) => { if (c.type === 'result') out[j] = evalResult(c, nums, cols); });
    return { out, nums, errors };
  }

  const hasCertColumn = (table) => Boolean(table && Array.isArray(table.columns) && table.columns.some((c) => c.type === 'cert'));

  // ---------- certificates ----------
  // A certificate (as the Certificate QR app reads it off an equipment's
  // label) has one or more tables, each { scope, unit, rows }, a row being
  // [reading, correction, …]. The correction at any reading between two of
  // its points is read off the straight line between them.

  // Unit conversion: Pressure, Temperature, Current and Voltage.
  const PRESSURE_TO_PA = {
    Pa: 1, hPa: 100, kPa: 1000, MPa: 1e6, mbar: 100, bar: 1e5,
    psi: 6894.757293168361, 'kgf/cm²': 98066.5, mmHg: 133.322387415, inHg: 3386.389, atm: 101325,
  };
  const TEMPERATURE_TO_CELSIUS = { '°C': (v) => v, '°F': (v) => ((v - 32) * 5) / 9, K: (v) => v - 273.15 };
  const CELSIUS_TO_TEMPERATURE = { '°C': (v) => v, '°F': (v) => (v * 9) / 5 + 32, K: (v) => v + 273.15 };
  const CURRENT_TO_A = { A: 1, mA: 1e-3, uA: 1e-6 };
  const VOLTAGE_TO_V = { V: 1, mV: 1e-3, uV: 1e-6 };

  // The many ways a unit is written in certificate data, onto the keys above.
  const UNIT_ALIASES = {
    pa: 'Pa', 'n/m2': 'Pa', 'n/m²': 'Pa',
    hpa: 'hPa',
    kpa: 'kPa',
    mpa: 'MPa',
    mbar: 'mbar', mb: 'mbar',
    bar: 'bar',
    psi: 'psi', psia: 'psi', psig: 'psi',
    'kgf/cm2': 'kgf/cm²', 'kgf/cm²': 'kgf/cm²', 'kg/cm2': 'kgf/cm²', 'kg/cm²': 'kgf/cm²',
    mmhg: 'mmHg',
    inhg: 'inHg',
    atm: 'atm',
    c: '°C', '°c': '°C', degc: '°C', 'deg c': '°C', celsius: '°C',
    f: '°F', '°f': '°F', degf: '°F', 'deg f': '°F', fahrenheit: '°F',
    k: 'K', kelvin: 'K',
    a: 'A', amp: 'A', amps: 'A', ampere: 'A', amperes: 'A',
    ma: 'mA', milliamp: 'mA', milliamps: 'mA',
    ua: 'uA', 'µa': 'uA', microamp: 'uA', microamps: 'uA',
    v: 'V', volt: 'V', volts: 'V',
    mv: 'mV', millivolt: 'mV', millivolts: 'mV',
    uv: 'uV', 'µv': 'uV', microvolt: 'uV', microvolts: 'uV',
  };

  function normalizeUnit(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
    return UNIT_ALIASES[key] || UNIT_ALIASES[key.replace(/\s+/g, '')] || null;
  }

  function unitCategory(unit) {
    if (!unit) return null;
    if (unit in PRESSURE_TO_PA) return 'pressure';
    if (unit in TEMPERATURE_TO_CELSIUS) return 'temperature';
    if (unit in CURRENT_TO_A) return 'current';
    if (unit in VOLTAGE_TO_V) return 'voltage';
    return null;
  }

  const MULTIPLIER_TABLE_BY_CATEGORY = { pressure: PRESSURE_TO_PA, current: CURRENT_TO_A, voltage: VOLTAGE_TO_V };

  // The units a reading in each category can be converted to.
  const UNITS_BY_CATEGORY = {
    pressure: Object.keys(PRESSURE_TO_PA),
    temperature: Object.keys(TEMPERATURE_TO_CELSIUS),
    current: Object.keys(CURRENT_TO_A),
    voltage: Object.keys(VOLTAGE_TO_V),
  };

  function convertUnit(value, fromUnit, toUnit, category) {
    if (!Number.isFinite(value) || fromUnit === toUnit) return value;
    if (category === 'temperature') {
      const toC = TEMPERATURE_TO_CELSIUS[fromUnit];
      const fromC = CELSIUS_TO_TEMPERATURE[toUnit];
      if (!toC || !fromC) return value;
      return fromC(toC(value));
    }
    const table = MULTIPLIER_TABLE_BY_CATEGORY[category];
    if (table) {
      const fromFactor = table[fromUnit];
      const toFactor = table[toUnit];
      if (!fromFactor || !toFactor) return value;
      return (value * fromFactor) / toFactor;
    }
    return value;
  }

  // A certificate table's points, [{ x: reading, y: correction }], in
  // order of reading, one per reading.
  function certificatePoints(table) {
    if (!table || !Array.isArray(table.rows)) return [];
    const points = table.rows
      .map((row) => ({ x: parseFloat(row[0]), y: parseFloat(row[1]) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    points.sort((a, b) => a.x - b.x);
    const seenX = new Set();
    return points.filter((p) => {
      if (seenX.has(p.x)) return false;
      seenX.add(p.x);
      return true;
    });
  }

  // The correction at reading x: { value, error }. Exact at a point,
  // interpolated between two, refused outside the certificate's range.
  function correctionAt(points, x) {
    if (!Number.isFinite(x)) return { value: null, error: null };
    if (!points || points.length === 0) return { value: null, error: 'No reference data selected' };
    const minX = points[0].x;
    const maxX = points[points.length - 1].x;
    if (x < minX || x > maxX) return { value: null, error: `Out of range (${plainNum(minX)}–${plainNum(maxX)})` };
    const exact = points.find((p) => p.x === x);
    if (exact) return { value: exact.y, error: null };
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (x >= a.x && x <= b.x) {
        const t = (x - a.x) / (b.x - a.x);
        return { value: a.y + t * (b.y - a.y), error: null };
      }
    }
    return { value: null, error: 'Could not interpolate' };
  }

  // What a table reads a certificate table with: its points with the
  // readings converted from the certificate's unit to `readingUnit` (the
  // unit the readings are typed in; the correction is never converted),
  // the units it can be converted to, cf(x) for evaluateRow and uf(x),
  // the certificate's expanded uncertainty there, for a budget.
  function correctionReader(certTable, readingUnit) {
    const nativeUnit = certTable ? normalizeUnit(certTable.unit) : null;
    const category = unitCategory(nativeUnit);
    const raw = certificatePoints(certTable);
    const target = category && readingUnit && UNITS_BY_CATEGORY[category].includes(readingUnit) ? readingUnit : nativeUnit;
    const points = category && target ? raw.map((p) => ({ x: convertUnit(p.x, nativeUnit, target, category), y: p.y })) : raw;
    const rawU = certificateUncertainties(certTable);
    const uPoints = category && target ? rawU.map((p) => ({ x: convertUnit(p.x, nativeUnit, target, category), u: p.u })) : rawU;
    return {
      nativeUnit,
      category,
      unit: (category ? target : (certTable && certTable.unit)) || '',
      units: category ? UNITS_BY_CATEGORY[category].slice() : [],
      points,
      cf: (x) => correctionAt(points, x),
      uf: (x) => uncertaintyAt(uPoints, x),
    };
  }

  // Past its due date (a date as the certificate gives it, e.g. 2027-12-31)?
  function isCalibrationDue(due, today) {
    if (!due) return false;
    const dueDate = new Date(due);
    if (Number.isNaN(dueDate.getTime())) return false;
    const day = today ? new Date(today) : new Date();
    day.setHours(0, 0, 0, 0);
    return dueDate < day;
  }

  // The certificates on one scan of an equipment's label:
  // [{ cert, trace, due, tables }]. A label of the newer layout holds
  // several (scan.certs, each table naming its certificate); an older one,
  // one (the scan's own cert, trace, due and tables).
  function scanCertificates(scan) {
    if (!scan) return [];
    const tables = Array.isArray(scan.tables) ? scan.tables : [];
    if (Array.isArray(scan.certs) && scan.certs.length > 0) {
      return scan.certs.map((c) => {
        const cert = (c && c.cert) || '';
        return { cert, trace: (c && c.trace) || '', due: (c && c.due) || '', tables: tables.filter((t) => t && t.cert === cert) };
      });
    }
    return [{ cert: scan.cert || '', trace: scan.trace || '', due: scan.due || '', tables }];
  }

  // Every certificate held for an equipment, across all its scans in the
  // scan list (newest scan first): each certificate once, from the newest
  // scan that has it.
  function heldCertificates(scans, equipmentId) {
    const out = [];
    (Array.isArray(scans) ? scans : []).forEach((scan) => {
      if (!scan || scan.id !== equipmentId) return;
      scanCertificates(scan).forEach((c) => {
        if (!out.some((o) => o.cert === c.cert)) out.push(c);
      });
    });
    return out;
  }

  // The scan list as reference equipment to choose from:
  // [{ id, name, certificates: [{ cert, trace, due, isDue, tables }] }],
  // in the order each was last scanned.
  function referenceEquipment(scans, today) {
    const list = [];
    (Array.isArray(scans) ? scans : []).forEach((scan) => {
      if (!scan || !scan.id || list.some((e) => e.id === scan.id)) return;
      list.push({
        id: String(scan.id),
        name: String(scan.name || ''),
        certificates: heldCertificates(scans, scan.id).map((c) => ({ ...c, isDue: isCalibrationDue(c.due, today) })),
      });
    });
    return list;
  }

  // ---------- uncertainty budget ----------
  // A budget lists the sources of uncertainty of a measurement and works
  // out, for each test point (row) of a calibration table, the combined
  // and expanded uncertainty (GUM / EA-4/02):
  //   u(xi)   = |value| ÷ divisor            the source's standard uncertainty
  //   ci·u    = |ci| × u(xi)                 its contribution
  //   uc      = √Σ (ci·u)²                   combined standard uncertainty
  //   νeff    = uc⁴ ÷ Σ (ci·u)⁴ / νi         effective degrees of freedom
  //   k       = Student's t at 95.45 % for νeff (cut down to a whole number),
  //             or a fixed k the designer sets
  //   U       = k × uc                       expanded uncertainty
  //
  // A source: { id, name, from, formula, at, value, dist, n, k, ci, dof }.
  //   from      where its value comes from, for each row:
  //               'table'       formula over the table's row (e.g. STDEV(F:H))
  //               'cert'        the reference certificate's expanded uncertainty
  //                             at the row's reading in column `at` (a column id)
  //               'fixed'       `value`, typed by the designer
  //               'respondent'  typed once by whoever fills the form in
  //               'uut-sr'      the UUT's resolution: in the Certificate QR app,
  //                             the worksheet's SR (Scale Resolution) in UUT
  //                             info (env.uutResolution); on its own, typed
  //                             like 'respondent'
  //   dist      how the value becomes a standard uncertainty (BUDGET_DISTS)
  //   n         Type A: the number of readings (÷ √n, ν = n − 1)
  //   k         Normal: the coverage factor the value was given at (÷ k, e.g. 2)
  //   ci        sensitivity coefficient (blank = 1)
  //   dof       Type B degrees of freedom (blank = infinite)

  const BUDGET_DISTS = [
    { id: 'A', label: 'Type A: std. deviation ÷ √n' },
    { id: 'normal', label: 'Normal ÷ k' },
    { id: 'rect', label: 'Rectangular ÷ √3' },
    { id: 'res', label: 'Resolution ÷ 2√3' },
    { id: 'tri', label: 'Triangular ÷ √6' },
    { id: 'u', label: 'U-shaped ÷ √2' },
  ];

  const BUDGET_SOURCES = [
    { id: 'table', label: 'Readings table' },
    { id: 'cert', label: 'Reference certificate' },
    { id: 'fixed', label: 'Fixed value' },
    { id: 'respondent', label: 'Typed by respondent' },
    { id: 'uut-sr', label: 'UUT resolution (SR)' },
  ];

  const isTypeA = (src) => Boolean(src) && src.dist === 'A';

  // What the value is divided by. NaN when it can't be (Type A with no n).
  function budgetDivisor(src) {
    switch (src && src.dist) {
      case 'A': {
        const n = Math.floor(toNum(src.n));
        return n >= 1 ? Math.sqrt(n) : NaN;
      }
      case 'normal': {
        const k = toNum(src.k);
        return Number.isFinite(k) && k > 0 ? k : 2;
      }
      case 'res': return 2 * Math.sqrt(3);
      case 'tri': return Math.sqrt(6);
      case 'u': return Math.SQRT2;
      default: return Math.sqrt(3); // rectangular
    }
  }

  // Degrees of freedom: n − 1 for Type A, else as set (blank = infinite).
  function budgetDof(src) {
    if (isTypeA(src)) {
      const n = Math.floor(toNum(src.n));
      return n >= 2 ? n - 1 : NaN;
    }
    const v = toNum(src && src.dof);
    return Number.isFinite(v) && v > 0 ? v : Infinity;
  }

  // ln Γ(x), Lanczos (g = 7, n = 9): plenty for the t-distribution below.
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lnGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // The regularised incomplete beta function I_x(a, b) (continued fraction).
  function betaCf(x, a, b) {
    const TINY = 1e-300;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m += 1) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  }
  function incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? (front * betaCf(x, a, b)) / a : 1 - (front * betaCf(1 - x, b, a)) / b;
  }

  // Coverage factor for a two-sided `p` (default 95.45 %) at ν degrees of
  // freedom: Student's t, as in the GUM's table G.2 (ν = 10 → 2.28), to 2
  // decimals. ν is cut down to a whole number first (GUM G.6.4); infinite
  // ν gives the normal distribution's (2.00 at 95.45 %). NaN below ν = 1.
  function coverageFactor(dof, p) {
    const prob = Number.isFinite(p) && p > 0 && p < 1 ? p : 0.9545;
    let lo = 0;
    let hi = 1000;
    let within;
    if (dof === Infinity || dof > 1e7) {
      // the normal distribution: P(|Z| ≤ z) = erf(z / √2), erf by its series
      within = (z) => {
        const x = z / Math.SQRT2;
        let term = x;
        let sum = x;
        for (let n = 1; n < 200; n += 1) {
          term *= (-x * x) / n;
          sum += term / (2 * n + 1);
          if (Math.abs(term) < 1e-17) break;
        }
        return (2 / Math.sqrt(Math.PI)) * sum;
      };
      hi = 10;
    } else {
      const v = Math.floor(dof);
      if (!(v >= 1)) return NaN;
      // P(|T| ≤ t) = 1 − I_{ν/(ν+t²)}(ν/2, ½)
      within = (t) => 1 - incompleteBeta(v / (v + t * t), v / 2, 0.5);
    }
    for (let i = 0; i < 200; i += 1) {
      const mid = (lo + hi) / 2;
      if (within(mid) < prob) lo = mid; else hi = mid;
    }
    return Math.round(((lo + hi) / 2) * 100) / 100;
  }

  // A Type A source's n, guessed from its formula: how many columns a
  // STDEV(…) of it reads (STDEV(F:H) → 3). 0 when it can't tell.
  function readingsCount(formula) {
    const m = /STDEV\s*\(([^()]*)\)/i.exec(String(formula || ''));
    if (!m) return 0;
    let n = 0;
    m[1].split(',').forEach((part) => {
      const r = /^\s*([A-Za-z])\s*(?::\s*([A-Za-z]))?\s*$/.exec(part);
      if (!r) return;
      const a = r[1].toUpperCase().charCodeAt(0);
      const b = (r[2] || r[1]).toUpperCase().charCodeAt(0);
      n += Math.abs(b - a) + 1;
    });
    return n;
  }

  // A certificate table's expanded uncertainties, [{ x: reading, u }], in
  // order of reading (each row is [reading, correction, uncertainty]).
  function certificateUncertainties(table) {
    if (!table || !Array.isArray(table.rows)) return [];
    const points = table.rows
      .map((row) => ({ x: parseFloat(row[0]), u: parseFloat(row[2]) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.u));
    points.sort((a, b) => a.x - b.x);
    const seenX = new Set();
    return points.filter((p) => {
      if (seenX.has(p.x)) return false;
      seenX.add(p.x);
      return true;
    });
  }

  // The certificate's expanded uncertainty at reading x: { value, error }.
  // Exact at a point; between two, the larger of them (an uncertainty
  // isn't interpolated down); refused outside the certificate's range.
  function uncertaintyAt(points, x) {
    if (!Number.isFinite(x)) return { value: null, error: null };
    if (!points || points.length === 0) return { value: null, error: 'No uncertainty on the certificate' };
    const minX = points[0].x;
    const maxX = points[points.length - 1].x;
    if (x < minX || x > maxX) return { value: null, error: `Out of range (${plainNum(minX)}–${plainNum(maxX)})` };
    const exact = points.find((p) => p.x === x);
    if (exact) return { value: exact.u, error: null };
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (x >= a.x && x <= b.x) return { value: Math.max(a.u, b.u), error: null };
    }
    return { value: null, error: 'Could not read the uncertainty' };
  }

  // One test point's budget.
  //   nums      the table row's numbers, as evaluateRow gives them
  //   cols      the table's columns (for a 'cert' source's reading column)
  //   env.uf(x) the reference certificate's uncertainty at x — { value, error }
  //   env.typed { [source id]: what the respondent typed }
  //   env.uutResolution  the UUT's SR, where the app has one (else a
  //             'uut-sr' source is read from env.typed)
  // → { sources: [{ id, value, u, cu, dof, error }], uc, veff, k, U }
  // Anything that can't be worked out yet is NaN (a value not typed, a
  // repeatability with one reading); uc, k and U are NaN until all are.
  function evaluateBudget(budget, nums, cols, env) {
    const e = env || {};
    const sources = (budget && Array.isArray(budget.sources) ? budget.sources : []).map((src) => {
      let value = NaN;
      let error = null;
      if (src.from === 'table') value = evalFormulaValue(src.formula, nums || []);
      else if (src.from === 'cert') {
        const at = (cols || []).findIndex((c) => c.id === src.at);
        const x = at >= 0 && nums ? nums[at] : NaN;
        if (typeof e.uf !== 'function') error = 'No reference certificate chosen';
        else if (Number.isFinite(x)) {
          const r = e.uf(x);
          if (r && Number.isFinite(r.value)) value = r.value;
          else error = (r && r.error) || null;
        }
      } else if (src.from === 'respondent') value = toNum(e.typed && e.typed[src.id]);
      else if (src.from === 'uut-sr') {
        value = e.uutResolution !== undefined ? toNum(e.uutResolution) : toNum(e.typed && e.typed[src.id]);
      }
      else value = toNum(src.value);
      const ci = Number.isFinite(toNum(src.ci)) ? toNum(src.ci) : 1;
      const u = Math.abs(value) / budgetDivisor(src);
      const cu = Math.abs(ci) * u;
      return { id: src.id, value, ci, u, cu, dof: budgetDof(src), error };
    });
    const complete = sources.length > 0 && sources.every((s) => Number.isFinite(s.cu));
    if (!complete) return { sources, uc: NaN, veff: NaN, k: NaN, U: NaN };
    const uc = Math.sqrt(sources.reduce((sum, s) => sum + s.cu * s.cu, 0));
    let denom = 0;
    let dofKnown = true;
    sources.forEach((s) => {
      if (s.cu === 0 || s.dof === Infinity) return;
      if (!Number.isFinite(s.dof)) { dofKnown = false; return; }
      denom += s.cu ** 4 / s.dof;
    });
    const veff = !dofKnown ? NaN : denom === 0 ? Infinity : uc ** 4 / denom;
    const fixedK = toNum(budget.k);
    const k = budget.coverage === 'fixed' && Number.isFinite(fixedK) && fixedK > 0 ? fixedK : coverageFactor(veff);
    return { sources, uc, veff, k, U: k * uc };
  }

  // νeff as a budget shows it: "∞", or cut down to a whole number.
  const dofText = (v) => (v === Infinity ? '∞' : Number.isFinite(v) ? String(Math.floor(v)) : '');

  const api = {
    CALC_CORE_VERSION,
    MAX_COLS,
    // numbers
    toNum, formatNum, displayNum, plainNum, colLetter,
    // formulas
    parseFormula, formulaProblem, formulaAfterInsert, formulaAfterDelete, evalFormula, evalFormulaValue,
    // a calibration table's row
    isComputed, isPresetCell, isCellEditable, evalCert, parseTol, encodeTol, toleranceLimit, tolSpecText,
    evalResult, evaluateRow, hasCertColumn,
    // certificates
    normalizeUnit, unitCategory, convertUnit, UNITS_BY_CATEGORY, certificatePoints, correctionAt,
    correctionReader, isCalibrationDue, scanCertificates, heldCertificates, referenceEquipment,
    // uncertainty budget
    BUDGET_DISTS, BUDGET_SOURCES, isTypeA, budgetDivisor, budgetDof, coverageFactor, readingsCount,
    certificateUncertainties, uncertaintyAt, evaluateBudget, dofText,
  };
  root.CalcCore = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
