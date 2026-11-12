// worksheet-forms.js — the reading tables of the official calibration
// worksheets, for when Settings has the Worksheet page set to
// "Worksheet" rather than "Unofficial record". Loaded by interpolate.html
// ahead of interpolate.js, whose createReadingTable builds a table from
// one of these instead of its own simple one. Plain globals, no bundler.
//
// Each layout is the table part of a "raw data" sheet of one of the
// company's workbooks (F16, F26, F27, F29, F33, F35, F39) — the columns,
// their grouping under headings, and what is worked out from what. The
// rest of those sheets (customer, instrument, standards used) is not
// here: the Worksheet page keeps its own sections for that.
//
// Two halves:
//   - The layouts (WORKSHEET_SHAPES, WORKSHEET_FORMS): columns and
//     arithmetic, no DOM — so they can be checked on their own.
//   - createFormRows(): the rows of one table on the page, built from a
//     layout.
//
// A column is { k, g, s, l, m, in, u, ... }:
//   k    its key in a row's values
//   g, s the heading it sits under, and the sub-heading under that
//        ("{stage}" in a heading becomes " before adjust" / " after
//        adjust", from the table's own before/after mark)
//   l    its own heading (may be blank, when the group is the one column)
//   m    its label on a phone, where a row is a card and not a line
//   in   what is typed in it: 'num', 'text' or 'select' (with `opts`);
//        a column with no `in` is worked out
//   u    its unit: 'x' the table's unit, 'xo' that or mA, or the unit
//        itself ('mA', '%', 'kg', ...)
//   uut  a reading of the unit under test: held to its scale resolution
//   judge a correction: rounded to the scale resolution, and judged
//        against the table's accuracy
//   w    how much of a phone card's width it takes, in quarters
//
// A shape may also say how a row is set out on a phone — `phone`:
// { cols, rows }, a small table with a line per reading and a column
// per set of readings, like a hand-ruled one:
//        #      | REF | UUT
//        Rdg 1  |     |
//        Rdg 2  |     |
// `cols` are its column headings. Each of `rows` is [label, key,
// key, ...] — the columns of the layout that go in that line, one per
// heading; a single key takes the whole width, and null leaves a
// place empty. The string 'head' in `rows` is where the line of
// headings goes (single figures such as the observed value can come
// before it). A shape without `phone` is set out as a card of
// labelled boxes instead.

const formReadings = (prefix, count, g, s, mobile, uut) => Array.from({ length: count }, (unused, i) => ({
  k: `${prefix}${i + 1}`, g, s, l: String(i + 1), m: `${mobile} ${i + 1}`, in: 'num', u: 'x', uut: Boolean(uut),
}));
const formKeys = (prefix, count) => Array.from({ length: count }, (unused, i) => `${prefix}${i + 1}`);

// --- Arithmetic shared by the layouts ---
// `n(key)` is a row's typed value as a number, or null if blank.
function formMean(n, keys) {
  const values = keys.map(n).filter((value) => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// The sample standard deviation, as a spreadsheet's STDEV gives it.
function formStdDev(n, keys) {
  const values = keys.map(n).filter((value) => value !== null);
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function formDiff(a, b) {
  return a !== null && b !== null ? a - b : null;
}

// A reference reading put right by its certificate: Corrected Value =
// Observed Value + Correction Factor. `cf(x)` is the table's certificate
// read at x — { value, error } — and an error (out of the certificate's
// range, no certificate chosen) is passed on for the cell to show.
function formCorrected(observed, cf) {
  if (observed === null) return { value: null, error: null };
  const factor = cf(observed);
  if (factor.error) return { value: null, error: factor.error };
  return { value: factor.value !== null ? observed + factor.value : null, error: null };
}

// Each shape's compute(n, cf) returns { out, errors, ref }: the
// worked-out columns by key, any message to show in place of one, and
// the reference value a percentage accuracy is taken of.
const WORKSHEET_SHAPES = {
  // F16 General, F33 measure, F39 simulation: one reference value, the
  // UUT read three times before adjustment and three times after.
  adjust: {
    labKey: 'obs',
    primary: formKeys('b', 3),
    phone: { cols: ['Before', 'After'], rows: [['Observed', 'obs'], ['Corrected', 'cor'], 'head', ['Rdg 1', 'b1', 'a1'], ['Rdg 2', 'b2', 'a2'], ['Rdg 3', 'b3', 'a3'], ['Avg', 'bAvg', 'aAvg'], ['Correction', 'cb', 'ca']] },
    cols: [
      { k: 'obs', g: 'Reference', l: 'Observed value', m: 'Observed', in: 'num', u: 'x', w: 2 },
      { k: 'cor', g: 'Reference', l: 'Corrected value', m: 'Corrected', u: 'x', w: 2 },
      ...formReadings('b', 3, 'Indicated value', 'Before adjust', 'Before', true),
      { k: 'bAvg', g: 'Indicated value', s: 'Before adjust', l: 'AVG', m: 'Before avg', u: 'x' },
      ...formReadings('a', 3, 'Indicated value', 'After adjust', 'After', true),
      { k: 'aAvg', g: 'Indicated value', s: 'After adjust', l: 'AVG', m: 'After avg', u: 'x' },
      { k: 'cb', g: 'Correction', l: 'Before adjust', m: 'Correction before', u: 'x', judge: true, w: 2 },
      { k: 'ca', g: 'Correction', l: 'After adjust', m: 'Correction after', u: 'x', judge: true, w: 2 },
    ],
    compute(n, cf) {
      const cor = formCorrected(n('obs'), cf);
      const bAvg = formMean(n, formKeys('b', 3));
      const aAvg = formMean(n, formKeys('a', 3));
      return { out: { cor: cor.value, bAvg, aAvg, cb: formDiff(cor.value, bAvg), ca: formDiff(cor.value, aAvg) }, errors: { cor: cor.error }, ref: cor.value };
    },
  },

  // F16 switch, F26 pressure switch: the pressure the switch trips at,
  // read three times, against its setting.
  switch: {
    labKey: 'set',
    primary: formKeys('b', 3),
    phone: { cols: ['Before', 'After'], rows: [['Applied pressure', 'app'], ['Condition', 'cond'], ['Setting', 'set'], 'head', ['Rdg 1', 'b1', 'a1'], ['Rdg 2', 'b2', 'a2'], ['Rdg 3', 'b3', 'a3'], ['Avg', 'bAvg', 'aAvg'], ['Correction', 'cb', 'ca']] },
    cols: [
      { k: 'app', g: 'Reference', l: 'Applied pressure', m: 'Applied pressure', in: 'text', w: 4, wide: true },
      { k: 'cond', g: 'Reference', l: 'Desired switch condition', m: 'Switch condition', in: 'select', opts: ['', 'Open to Close', 'Close to Open'], w: 4, wide: true },
      { k: 'set', g: 'Reference', l: 'Switch setting', m: 'Setting', in: 'num', u: 'x', w: 2 },
      ...formReadings('b', 3, 'Indicated value before adjust', undefined, 'Before', true),
      { k: 'bAvg', g: 'Indicated value before adjust', l: 'AVG', m: 'Before avg', u: 'x' },
      ...formReadings('a', 3, 'Indicated value after adjust', undefined, 'After', true),
      { k: 'aAvg', g: 'Indicated value after adjust', l: 'AVG', m: 'After avg', u: 'x' },
      { k: 'cb', g: 'Correction', l: 'Before adjust', m: 'Correction before', u: 'x', judge: true, w: 2 },
      { k: 'ca', g: 'Correction', l: 'After adjust', m: 'Correction after', u: 'x', judge: true, w: 2 },
    ],
    compute(n) {
      const bAvg = formMean(n, formKeys('b', 3));
      const aAvg = formMean(n, formKeys('a', 3));
      return { out: { bAvg, aAvg, cb: formDiff(n('set'), bAvg), ca: formDiff(n('set'), aAvg) }, errors: {}, ref: n('set') };
    },
  },

  // F26 pressure: the UUT read three times going up and three coming
  // down. A transmitter is read by its output, so the correction is
  // against the output it should give (typed in) where there is one,
  // and against the corrected pressure where there isn't.
  updown: {
    labKey: 'obs',
    primary: formKeys('i', 3),
    phone: { cols: ['Up', 'Down'], rows: [['Observed', 'obs'], ['Corrected', 'cor'], ['Output (mA)', 'out'], 'head', ['Rdg 1', 'i1', 'd1'], ['Rdg 2', 'i2', 'd2'], ['Rdg 3', 'i3', 'd3'], ['Avg', 'iAvg', 'dAvg'], ['Correction', 'ci', 'cd']] },
    stage: true,
    cols: [
      { k: 'obs', g: 'Reference', l: 'Observed value', m: 'Observed', in: 'num', u: 'x', w: 2 },
      { k: 'cor', g: 'Reference', l: 'Corrected value', m: 'Corrected', u: 'x', w: 2 },
      { k: 'out', g: 'Reference', l: 'Corrected value (output)', m: 'Output (mA)', in: 'num', u: 'mA', w: 4 },
      ...formReadings('i', 3, 'Unit under test indicated value{stage}', 'Increasing', 'Up', true).map((col) => ({ ...col, u: 'xo' })),
      { k: 'iAvg', g: 'Unit under test indicated value{stage}', s: 'Increasing', l: 'AVG', m: 'Up avg', u: 'xo' },
      ...formReadings('d', 3, 'Unit under test indicated value{stage}', 'Decreasing', 'Down', true).map((col) => ({ ...col, u: 'xo' })),
      { k: 'dAvg', g: 'Unit under test indicated value{stage}', s: 'Decreasing', l: 'AVG', m: 'Down avg', u: 'xo' },
      { k: 'ci', g: 'Correction{stage}', l: 'Increasing', m: 'Correction up', u: 'xo', judge: true, w: 2 },
      { k: 'cd', g: 'Correction{stage}', l: 'Decreasing', m: 'Correction down', u: 'xo', judge: true, w: 2 },
    ],
    compute(n, cf) {
      const cor = formCorrected(n('obs'), cf);
      const iAvg = formMean(n, formKeys('i', 3));
      const dAvg = formMean(n, formKeys('d', 3));
      const against = n('out') !== null ? n('out') : cor.value;
      return { out: { cor: cor.value, iAvg, dAvg, ci: formDiff(against, iAvg), cd: formDiff(against, dAvg) }, errors: { cor: cor.error }, ref: against };
    },
  },

  // F27 temperature: the reference read three times as well as the UUT.
  temperature: {
    labKey: 'r1',
    primary: formKeys('u', 3),
    phone: { cols: ['Ref', 'UUT'], rows: ['head', ['Rdg 1', 'r1', 'u1'], ['Rdg 2', 'r2', 'u2'], ['Rdg 3', 'r3', 'u3'], ['Avg', 'rAvg', 'uAvg'], ['Corrected', 'cor'], ['Output (mA)', 'out'], ['Correction', 'c']] },
    stage: true,
    cols: [
      ...formReadings('r', 3, 'Reference', undefined, 'Ref', false),
      { k: 'rAvg', g: 'Reference', l: 'AVG', m: 'Ref avg', u: 'x' },
      { k: 'cor', g: 'Reference (corrected value)', l: 'Value', m: 'Corrected', u: 'x', w: 2 },
      { k: 'out', g: 'Reference (corrected value)', l: 'Output', m: 'Output (mA)', in: 'num', u: 'mA', w: 2 },
      ...formReadings('u', 3, 'Unit under test indicated value{stage}', undefined, 'UUT', true).map((col) => ({ ...col, u: 'xo' })),
      { k: 'uAvg', g: 'Unit under test indicated value{stage}', l: 'AVG', m: 'UUT avg', u: 'xo' },
      { k: 'c', g: 'Correction{stage}', l: '', m: 'Correction', u: 'xo', judge: true, w: 4 },
    ],
    compute(n, cf) {
      const rAvg = formMean(n, formKeys('r', 3));
      const cor = formCorrected(rAvg, cf);
      const uAvg = formMean(n, formKeys('u', 3));
      const against = n('out') !== null ? n('out') : cor.value;
      return { out: { rAvg, cor: cor.value, uAvg, c: formDiff(against, uAvg) }, errors: { cor: cor.error }, ref: against };
    },
  },

  // F29 liquid-in-glass thermometer: as temperature, with the emergent
  // stem temperature noted beside each point.
  lig: {
    labKey: 'r1',
    primary: formKeys('u', 3),
    phone: { cols: ['Ref', 'UUT'], rows: ['head', ['Rdg 1', 'r1', 'u1'], ['Rdg 2', 'r2', 'u2'], ['Rdg 3', 'r3', 'u3'], ['Avg', 'rAvg', 'uAvg'], ['Corrected', 'cor'], ['Emergent stem', 'est'], ['Correction', 'c']] },
    cols: [
      ...formReadings('r', 3, 'Reference', 'Observed value', 'Ref', false),
      { k: 'rAvg', g: 'Reference', s: 'Observed value', l: 'AVG', m: 'Ref avg', u: 'x' },
      { k: 'cor', g: 'Reference', l: 'Corrected value', m: 'Corrected', u: 'x', w: 2 },
      { k: 'est', g: 'Emergent stem temperature', l: '', m: 'Emergent stem', in: 'num', u: 'x', w: 2 },
      ...formReadings('u', 3, 'UUT indicated value', undefined, 'UUT', true),
      { k: 'uAvg', g: 'UUT indicated value', l: 'AVG', m: 'UUT avg', u: 'x' },
      { k: 'c', g: 'Correction', l: '', m: 'Correction', u: 'x', judge: true, w: 4 },
    ],
    compute(n, cf) {
      const rAvg = formMean(n, formKeys('r', 3));
      const cor = formCorrected(rAvg, cf);
      const uAvg = formMean(n, formKeys('u', 3));
      return { out: { rAvg, cor: cor.value, uAvg, c: formDiff(cor.value, uAvg) }, errors: { cor: cor.error }, ref: cor.value };
    },
  },

  // F33 simulate: the UUT sources a value, and the reference reads it
  // three times before adjustment and three times after.
  simulate: {
    labKey: 'src',
    primary: formKeys('b', 3),
    phone: { cols: ['Before', 'After'], rows: [['Source value', 'src'], 'head', ['Rdg 1', 'b1', 'a1'], ['Rdg 2', 'b2', 'a2'], ['Rdg 3', 'b3', 'a3'], ['Avg', 'bAvg', 'aAvg'], ['Actual', 'bAct', 'aAct'], ['Correction', 'cb', 'ca']] },
    cols: [
      { k: 'src', g: 'UUT', l: 'Source value', m: 'Source value', in: 'num', u: 'x', w: 4 },
      ...formReadings('b', 3, 'Reference reading before adjust', 'Observe value', 'Before', false),
      { k: 'bAvg', g: 'Reference reading before adjust', s: 'Observe value', l: 'AVG', m: 'Before avg', u: 'x' },
      { k: 'bAct', g: 'Reference reading before adjust', l: 'Actual value (corrected)', m: 'Actual before', u: 'x', w: 4 },
      ...formReadings('a', 3, 'Reference reading after adjust', 'Observe value', 'After', false),
      { k: 'aAvg', g: 'Reference reading after adjust', s: 'Observe value', l: 'AVG', m: 'After avg', u: 'x' },
      { k: 'aAct', g: 'Reference reading after adjust', l: 'Actual value (corrected)', m: 'Actual after', u: 'x', w: 4 },
      { k: 'cb', g: 'Correction before adjust', l: '', m: 'Correction before', u: 'x', judge: true, w: 2 },
      { k: 'ca', g: 'Correction after adjust', l: '', m: 'Correction after', u: 'x', judge: true, w: 2 },
    ],
    compute(n, cf) {
      const bAvg = formMean(n, formKeys('b', 3));
      const aAvg = formMean(n, formKeys('a', 3));
      const bAct = formCorrected(bAvg, cf);
      const aAct = formCorrected(aAvg, cf);
      return {
        out: { bAvg, aAvg, bAct: bAct.value, aAct: aAct.value, cb: formDiff(bAct.value, n('src')), ca: formDiff(aAct.value, n('src')) },
        errors: { bAct: bAct.error, aAct: aAct.error },
        ref: n('src'),
      };
    },
  },

  // F35 temperature and humidity sensor: one row per chamber setting,
  // five readings of the reference and five of the UUT at each.
  chamber: {
    labKey: 'set',
    primary: formKeys('u', 5),
    phone: { cols: ['Ref', 'UUT'], rows: [['Setting', 'set'], 'head', ['Rdg 1', 'r1', 'u1'], ['Rdg 2', 'r2', 'u2'], ['Rdg 3', 'r3', 'u3'], ['Rdg 4', 'r4', 'u4'], ['Rdg 5', 'r5', 'u5'], ['Mean', 'rMean', 'uMean'], ['Std dev', 'rSd', 'uSd'], ['Corrected', 'rCor'], ['Correction', 'c']] },
    stage: true,
    cols: [
      { k: 'set', g: 'Chamber setting', l: '', m: 'Chamber setting', in: 'num', u: 'x', w: 4 },
      ...formReadings('r', 5, 'Reference', 'Readings', 'Ref', false),
      { k: 'rMean', g: 'Reference', l: 'Average (mean)', m: 'Ref mean', u: 'x' },
      { k: 'rCor', g: 'Reference', l: 'Corrected value (mean + CF)', m: 'Ref corrected', u: 'x' },
      { k: 'rSd', g: 'Reference', l: 'Std dev', m: 'Ref std dev', u: 'x' },
      ...formReadings('u', 5, 'UUT indicated value{stage}', 'Readings', 'UUT', true),
      { k: 'uMean', g: 'UUT indicated value{stage}', l: 'Average (mean)', m: 'UUT mean', u: 'x', w: 2 },
      { k: 'uSd', g: 'UUT indicated value{stage}', l: 'Std dev', m: 'UUT std dev', u: 'x' },
      { k: 'c', g: 'Correction', l: '', m: 'Correction', u: 'x', judge: true, w: 4 },
    ],
    compute(n, cf) {
      const rMean = formMean(n, formKeys('r', 5));
      const rCor = formCorrected(rMean, cf);
      const uMean = formMean(n, formKeys('u', 5));
      return {
        out: { rMean, rCor: rCor.value, rSd: formStdDev(n, formKeys('r', 5)), uMean, uSd: formStdDev(n, formKeys('u', 5)), c: formDiff(rCor.value, uMean) },
        errors: { rCor: rCor.error },
        ref: rCor.value,
      };
    },
  },

  // F39 clamp-on / flow rig: flowrates as found and as left, reference
  // against UUT, with the error as a flowrate and as a percentage.
  flow: {
    labKey: 'rf',
    primary: ['uf', 'ul'],
    phone: { cols: ['As found', 'As left'], rows: ['head', ['Reference', 'rf', 'rl'], ['UUT', 'uf', 'ul'], ['Error', 'ef', 'el'], ['Error (%)', 'pf', 'pl']] },
    rowLabel: 'Batch no.',
    cols: [
      { k: 'rf', g: 'Reference', l: 'As found flowrate', m: 'Ref as found', in: 'num', u: 'x', w: 2 },
      { k: 'rl', g: 'Reference', l: 'As left flowrate', m: 'Ref as left', in: 'num', u: 'x', w: 2 },
      { k: 'uf', g: 'UUT value', l: 'As found flowrate', m: 'UUT as found', in: 'num', u: 'x', w: 2 },
      { k: 'ul', g: 'UUT value', l: 'As left flowrate', m: 'UUT as left', in: 'num', u: 'x', w: 2 },
      { k: 'ef', g: 'Error', l: 'As found', m: 'Error as found', u: 'x', w: 2 },
      { k: 'el', g: 'Error', l: 'As left', m: 'Error as left', u: 'x', w: 2 },
      { k: 'pf', g: 'Error (%)', l: 'As found', m: 'Error as found (%)', u: '%', w: 2 },
      { k: 'pl', g: 'Error (%)', l: 'As left', m: 'Error as left (%)', u: '%', w: 2 },
    ],
    compute(n) {
      const ef = formDiff(n('rf'), n('uf'));
      const el = formDiff(n('rl'), n('ul'));
      const percent = (error, reference) => (error !== null && reference ? (error / reference) * 100 : null);
      return { out: { ef, el, pf: percent(ef, n('rf')), pl: percent(el, n('rl')) }, errors: {}, ref: n('rf') };
    },
  },

  // F39 batching without a totaliser. The workbook has no formulas in
  // this table beyond the obvious two, so the rest is typed.
  batch: {
    labKey: 'fr',
    primary: ['ind'],
    cols: [
      { k: 'fr', g: 'Flowrate', l: 'L/hr', m: 'Flowrate (L/hr)', in: 'num', w: 2 },
      { k: 'fs', g: 'Flowrate', l: 'L/s', m: 'Flowrate (L/s)', w: 2 },
      { k: 'time', g: 'Batching time', l: '', m: 'Batching time (s)', in: 'num', u: 'second', w: 2 },
      { k: 'ww', g: 'Water weight', l: '', m: 'Water weight (kg)', in: 'num', u: 'kg', w: 2 },
      { k: 'ew', g: 'Electronic weigher reading', l: '', m: 'Weigher reading (kg)', in: 'num', u: 'kg', w: 2 },
      { k: 'err', g: 'Error', l: '', m: 'Error (kg)', in: 'num', u: 'kg', w: 2 },
      { k: 'ref', g: 'Reference', l: '', m: 'Reference (L/hr)', in: 'num', u: 'L/hr', w: 2 },
      { k: 'ind', g: 'Indicated value', l: '', m: 'Indicated (L/hr)', in: 'num', u: 'L/hr', uut: true, w: 2 },
      { k: 'c', g: 'Correction', l: 'L/hr', m: 'Correction (L/hr)', judge: true, w: 2 },
      { k: 'cp', g: 'Correction', l: '%', m: 'Correction (%)', w: 2 },
    ],
    compute(n) {
      const c = formDiff(n('ref'), n('ind'));
      return { out: { fs: n('fr') !== null ? n('fr') / 3600 : null, c, cp: c !== null && n('ref') ? (c / n('ref')) * 100 : null }, errors: {}, ref: n('ref') };
    },
  },

  // F39 batching with a totaliser.
  totaliser: {
    labKey: 'ta',
    primary: ['tb'],
    rowLabel: 'Batch no.',
    cols: [
      { k: 'ta', g: 'Flowmeter totaliser display', l: 'Before batching [A]', m: 'Totaliser before [A]', in: 'num', w: 2 },
      { k: 'tb', g: 'Flowmeter totaliser display', l: 'After batching [B]', m: 'Totaliser after [B]', in: 'num', w: 2 },
      { k: 'nett', g: 'Nett flowmeter totaliser display [B − A]', l: '', m: 'Nett [B − A]', w: 4 },
      { k: 'ps', g: 'Preset counter', l: 'Setting', m: 'Preset setting', in: 'num', u: 'L', w: 2 },
      { k: 'pd', g: 'Preset counter', l: 'Display', m: 'Preset display', in: 'num', u: 'L', w: 2 },
      { k: 'ew', g: 'Electronic weigher reading [reference]', l: '', m: 'Weigher reading (kg)', in: 'num', u: 'kg', w: 2 },
      { k: 'sg', g: 'Sugar temperature & specific gravity', l: '', m: 'Temp & SG', in: 'text', u: '°C (SG)', w: 2, wide: true },
      { k: 'vol', g: 'Conversion from weight to volume', l: '', m: 'Volume (L)', in: 'num', u: 'L', w: 2 },
      { k: 'ep', g: 'Error against preset counter display', l: '', m: 'Error vs preset (L)', in: 'num', u: 'L', w: 2 },
      { k: 'et', g: 'Error against magnetic flowmeter totaliser', l: '', m: 'Error vs totaliser', w: 4 },
    ],
    compute(n) {
      const nett = formDiff(n('tb'), n('ta'));
      return { out: { nett, et: formDiff(n('ew'), nett) }, errors: {}, ref: n('ew') };
    },
  },
};

// The types the Worksheet page offers, in the order of the workbooks.
// `fn` gives the table a line for the function under test (F33).
const WORKSHEET_FORMS = [
  { id: 'f16-general', name: 'F16 · General / Control valve / Timer', shape: 'adjust' },
  { id: 'f16-switch', name: 'F16 · Switch', shape: 'switch' },
  { id: 'f26-pressure', name: 'F26 · Pressure', shape: 'updown' },
  { id: 'f26-switch', name: 'F26 · Pressure switch', shape: 'switch' },
  { id: 'f27-temperature', name: 'F27 · Temperature', shape: 'temperature' },
  { id: 'f29-thermometer', name: 'F29 · Liquid-in-glass thermometer', shape: 'lig' },
  { id: 'f33-simulate', name: 'F33 · Electrical — UUT simulate', shape: 'simulate', fn: true },
  { id: 'f33-measure', name: 'F33 · Electrical — UUT measure', shape: 'adjust', fn: true },
  { id: 'f35-humidity', name: 'F35 · Temperature & humidity sensor', shape: 'chamber' },
  { id: 'f39-flow', name: 'F39 · Flowmeter — clamp-on / flow rig', shape: 'flow' },
  { id: 'f39-simulate', name: 'F39 · Flowmeter — simulation', shape: 'adjust' },
  { id: 'f39-batch', name: 'F39 · Flowmeter — batching (no totaliser)', shape: 'batch' },
  { id: 'f39-totaliser', name: 'F39 · Flowmeter — batching (with totaliser)', shape: 'totaliser' },
];

// How many rows a table of one of these starts with.
const FORM_DEFAULT_ROWS = 5;

// The layout a worksheet type stands for — its entry above with its
// shape's columns and arithmetic — or null for the simple table (a type
// of '', or one this version doesn't know).
function worksheetForm(typeId) {
  const form = WORKSHEET_FORMS.find((f) => f.id === typeId);
  return form ? { ...WORKSHEET_SHAPES[form.shape], ...form } : null;
}

// A unit as a column heading shows it: "( bar )".
function formUnitText(col, unit) {
  let text = col.u;
  if (col.u === 'x') text = unit;
  else if (col.u === 'xo') text = unit ? `${unit} / mA` : 'mA';
  return text ? `( ${text} )` : '';
}

// The heading rows of a layout, as rows of { t, c, r } (text, columns
// and rows spanned): groups over sub-groups over the columns' own
// headings, then a row of units. A row-number column comes first.
// `stage` is the table's before/after mark; `unit` its unit.
function formHead(form, stage, unit) {
  const stageText = stage === 'before' ? ' before adjust' : stage === 'after' ? ' after adjust' : '';
  const cols = form.cols.map((col) => ({ ...col, g: (col.g || '').replace('{stage}', stageText) }));
  const hasSub = cols.some((col) => col.s);
  const depth = hasSub ? 3 : 2;
  const rows = Array.from({ length: depth }, () => []);
  rows[0].push({ t: form.rowLabel || 'No.', c: 1, r: depth });

  for (let i = 0; i < cols.length;) {
    let end = i;
    while (end + 1 < cols.length && cols[end + 1].g === cols[i].g) end += 1;
    const group = cols.slice(i, end + 1);
    if (group.length === 1 && !group[0].l) {
      // The group is its one column: a single heading the full height.
      rows[0].push({ t: group[0].g, c: 1, r: depth });
    } else {
      rows[0].push({ t: group[0].g, c: group.length, r: 1 });
      for (let j = 0; j < group.length;) {
        if (hasSub && group[j].s) {
          let last = j;
          while (last + 1 < group.length && group[last + 1].s === group[j].s) last += 1;
          rows[1].push({ t: group[j].s, c: last - j + 1, r: 1 });
          group.slice(j, last + 1).forEach((col) => rows[2].push({ t: col.l, c: 1, r: 1 }));
          j = last + 1;
        } else {
          rows[1].push({ t: group[j].l, c: 1, r: depth - 1 });
          j += 1;
        }
      }
    }
    i = end + 1;
  }

  // Units: one cell over each run of neighbouring columns that share one.
  const units = [{ t: '', c: 1, r: 1 }];
  cols.forEach((col) => {
    const text = formUnitText(col, unit);
    const last = units[units.length - 1];
    if (units.length > 1 && last.t === text && last.g === col.g) last.c += 1;
    else units.push({ t: text, c: 1, r: 1, g: col.g });
  });
  rows.push(units.map(({ t, c, r }) => ({ t, c, r })));
  return rows;
}

// --- The rows of one table on the page ---
// createFormRows({ form, table, env }) fills `table` (a <table>) with
// the layout's headings and gives back what createReadingTable needs to
// run it. `env` is the table's side of things:
//   env.cf(x)        the certificate's correction at x — { value, error }
//   env.limit(ref)   the accuracy, as a limit on a correction (or null)
//   env.resolution() the UUT's scale resolution (or null)
//   env.unit()       the unit the table is in ('' if not known)
//   env.stage()      'before', 'after' or ''
//   env.onChange()   something was typed, added or removed
// Rows are <tr>s in the table's <tbody>, each with _recompute,
// _applyResolution and _photos like the simple table's, and marked
// row-tol-pass / row-tol-fail the same way.
function createFormRows({ form, table, env }) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  table.classList.remove('interp-table');
  table.classList.add('form-table');

  function setHead() {
    thead.innerHTML = '';
    formHead(form, env.stage(), env.unit()).forEach((cells, rowIndex, all) => {
      const tr = make('tr', rowIndex === all.length - 1 ? 'form-units' : null);
      cells.forEach((cell) => {
        const th = make('th', null, cell.t);
        if (cell.c > 1) th.colSpan = cell.c;
        if (cell.r > 1) th.rowSpan = cell.r;
        tr.appendChild(th);
      });
      // Over the photo and remove buttons.
      if (rowIndex === 0) tr.appendChild(make('th', 'form-head-actions')).rowSpan = all.length;
      thead.appendChild(tr);
    });
    renumber();
  }

  // Each row's number — and, for a phone, where the headings are not
  // shown, the unit the table is in beside it.
  function renumber() {
    const unit = env.unit();
    Array.from(tbody.children).forEach((tr, index) => {
      tr.firstElementChild.textContent = String(index + 1).padStart(2, '0');
      tr.firstElementChild.dataset.unit = unit ? `in ${unit}` : '';
    });
  }

  // A worked-out number as the page shows it: a correction to the
  // UUT's scale resolution once that is known, anything else to at most
  // six places.
  function show(col, value) {
    if (value === null || !Number.isFinite(value)) return '—';
    const resolution = col.judge ? env.resolution() : null;
    return resolution ? snapToResolution(Number(value.toFixed(9)), resolution) : formatNumber(value);
  }

  // `state` is a row as collect() gave it — { v, labRdg, uutRdg,
  // photos } — from this layout, from another one, or from the simple
  // table (which has no `v`). Values under keys this layout has are
  // taken as they are; failing that, the row's reference reading and
  // its UUT readings go into this layout's own columns for them, so a
  // worksheet changed from one type to another keeps what it can.
  function addRow(state) {
    const values = { ...((state && state.v) || {}) };
    if (state && !values[form.labKey] && state.labRdg) values[form.labKey] = state.labRdg;
    if (state && !form.primary.some((key) => values[key])) {
      String(state.uutRdg || '').split(/[,\s/]+/).filter(Boolean).slice(0, form.primary.length).forEach((reading, i) => {
        values[form.primary[i]] = reading;
      });
    }

    const tr = make('tr', 'form-row');
    tr.appendChild(make('td', 'form-no')).dataset.label = form.rowLabel || 'No.';
    const inputs = {};
    const cells = {};
    let section = null;
    form.cols.forEach((col) => {
      // On a phone the row is a card, and the card is in sections: a
      // heading goes in ahead of each group of columns (a wide screen,
      // which has the table's own headings, doesn't show these). Not
      // ahead of a group that is one column — its label says it all —
      // nor ahead of the corrections, which close the card.
      const heading = [col.g.replace('{stage}', ''), col.s].filter(Boolean).join(' · ');
      if (heading !== section && !col.judge && form.cols.filter((other) => other.g === col.g).length > 1) {
        tr.appendChild(make('td', 'form-group', heading));
      }
      section = heading;
      const td = make('td', `form-cell form-w${col.w || 1}${col.in ? '' : ' form-calc'}${col.wide ? ' form-wide' : ''}${col.judge ? ' form-judge' : ''}`);
      td.dataset.label = col.m;
      if (col.in === 'select') {
        const select = document.createElement('select');
        col.opts.forEach((option) => { select.appendChild(make('option', null, option || '—')).value = option; });
        select.value = values[col.k] || '';
        inputs[col.k] = select;
        td.appendChild(select);
      } else if (col.in) {
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', col.m);
        if (col.in === 'num') {
          input.inputMode = 'decimal';
          // One number, which can be below zero.
          restrictInput(input, (text) => cleanNumberText(text, true));
        }
        if (values[col.k]) input.value = values[col.k];
        inputs[col.k] = input;
        td.appendChild(input);
      } else {
        td.textContent = '—';
      }
      cells[col.k] = td;
      tr.appendChild(td);
    });

    // Where each cell goes when the row is a small table on a phone
    // (the shape's `phone`): its line and its column there, handed to
    // style.css as custom properties, with a cell for every line's
    // label and every column's heading added. A wide screen ignores
    // all of it.
    if (form.phone) {
      tr.classList.add('form-grid');
      tr.style.setProperty('--form-cols', String(form.phone.cols.length));
      const place = (td, line, column, span) => {
        td.style.setProperty('--gr', String(line));
        td.style.setProperty('--gc', String(column));
        td.style.setProperty('--gs', String(span));
      };
      form.phone.rows.forEach((row, index) => {
        const line = index + 2; // the first is the card's own heading
        if (row === 'head') {
          place(tr.appendChild(make('td', 'form-ph form-ph-head', '#')), line, 1, 1);
          form.phone.cols.forEach((title, i) => place(tr.appendChild(make('td', 'form-ph form-ph-head', title)), line, i + 2, 1));
          return;
        }
        const [label, ...keys] = row;
        place(tr.appendChild(make('td', 'form-ph', label)), line, 1, 1);
        keys.forEach((key, i) => {
          if (key) place(cells[key], line, i + 2, keys.length === 1 ? form.phone.cols.length : 1);
        });
      });
    }

    const photoBtn = make('button', 'interp-row-photo');
    photoBtn.type = 'button';
    photoBtn.title = 'Add a photo of this reading';
    photoBtn.setAttribute('aria-label', 'Add a photo of this reading');
    photoBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    const removeBtn = make('button', 'interp-row-remove');
    removeBtn.type = 'button';
    removeBtn.title = 'Remove row';
    removeBtn.setAttribute('aria-label', 'Remove row');
    removeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    const actionsTd = make('td', 'interp-row-actions form-actions');
    actionsTd.append(photoBtn, removeBtn);
    const photosTd = make('td', 'interp-row-photos');
    tr.append(actionsTd, photosTd);

    // The photos taken of this row (photos.js), by id, kept on the row.
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
        // The row was removed while the camera was open.
        if (!tr.isConnected) {
          deletePhoto(photoId);
          return;
        }
        addRowPhoto(photoId, dataUrl);
        env.onChange();
      });
    });

    const number = (key) => {
      const text = inputs[key] ? inputs[key].value.trim() : '';
      const value = text === '' ? NaN : Number(text);
      return Number.isFinite(value) ? value : null;
    };

    function recompute() {
      const result = form.compute(number, env.cf);
      let failed = false;
      let judged = false;
      form.cols.forEach((col) => {
        if (col.in) return;
        const td = cells[col.k];
        const error = result.errors[col.k];
        const value = result.out[col.k];
        const text = error || show(col, value === undefined ? null : value);
        td.textContent = text;
        td.classList.toggle('cell-error', Boolean(error));
        td.classList.remove('tol-pass', 'tol-fail');
        if (!col.judge || error || value === null || value === undefined) return;
        // The figure shown is the one judged, so the page and its
        // verdict always agree; the margin is for the arithmetic.
        const limit = env.limit(result.ref);
        if (limit === null) return;
        const out = Math.abs(Number(text)) > limit + 1e-9;
        td.classList.add(out ? 'tol-fail' : 'tol-pass');
        judged = true;
        if (out) failed = true;
      });
      tr.classList.toggle('row-tol-fail', failed);
      tr.classList.toggle('row-tol-pass', judged && !failed);
    }

    // A UUT reading rewritten as something the UUT could show: the
    // nearest multiple of its scale resolution.
    function applyResolution() {
      const resolution = env.resolution();
      if (!resolution) return;
      let changed = false;
      form.cols.forEach((col) => {
        if (!col.uut) return;
        const input = inputs[col.k];
        const formatted = snapReadings(input.value, resolution);
        if (formatted !== input.value) {
          input.value = formatted;
          changed = true;
        }
      });
      if (changed) recompute();
    }

    Object.keys(inputs).forEach((key) => {
      const input = inputs[key];
      const col = form.cols.find((c) => c.k === key);
      input.addEventListener(col.in === 'select' ? 'change' : 'input', () => {
        recompute();
        env.onChange();
      });
      // Once the reading has been keyed in and the box left — not while
      // typing, which would fight the cursor.
      if (col.uut) {
        input.addEventListener('change', () => {
          applyResolution();
          env.onChange();
        });
      }
    });
    removeBtn.addEventListener('click', () => {
      const rowPhotos = tr._photos.slice();
      tr.remove();
      renumber();
      env.onChange();
      deleteUnusedPhotos(rowPhotos);
    });

    tr._recompute = recompute;
    tr._applyResolution = applyResolution;
    tr._values = () => {
      const typed = {};
      Object.keys(inputs).forEach((key) => {
        if (inputs[key].value !== '') typed[key] = inputs[key].value;
      });
      return typed;
    };
    tr._texts = () => form.cols.map((col) => (col.in ? inputs[col.k].value : cells[col.k].textContent));
    tr._fails = () => form.cols.map((col, index) => (cells[col.k].classList.contains('tol-fail') ? index + 1 : -1)).filter((index) => index > 0);
    tbody.appendChild(tr);
    renumber();
    recompute();
  }

  // A row as the worksheet keeps it. Beside its own values it carries
  // the two things every kind of row is known by elsewhere (a photo's
  // name, whether a row is blank): its reference reading and its UUT
  // readings.
  function rowState(tr) {
    const v = tr._values();
    return {
      labRdg: v[form.labKey] || '',
      uutRdg: form.primary.map((key) => v[key]).filter(Boolean).join(', '),
      photos: tr._photos.slice(),
      v,
    };
  }

  setHead();
  return {
    setHead,
    addRow,
    collect() {
      return Array.from(tbody.children).map(rowState);
    },
    // The table as a saved record keeps it: its headings and every cell
    // as it reads now, with which cells are out of tolerance — so the
    // record can be shown and printed without knowing the layout. Rows
    // with nothing typed in them are left out.
    record() {
      const kept = Array.from(tbody.children).filter((tr) => Object.keys(tr._values()).length > 0 || tr._photos.length > 0);
      const judgeCol = form.cols.find((col) => col.judge);
      return {
        form: {
          id: form.id,
          name: form.name,
          head: formHead(form, env.stage(), env.unit()),
          rows: kept.map((tr, index) => [String(index + 1).padStart(2, '0'), ...tr._texts()]),
          fails: kept.map((tr) => tr._fails()),
        },
        rows: kept.map((tr) => {
          const texts = tr._texts();
          const cell = (key) => { const at = form.cols.findIndex((col) => col.k === key); return at < 0 ? '' : texts[at]; };
          return {
            ...rowState(tr),
            labCorrectionRdg: '',
            actLabRdg: cell('cor'),
            correctionRdg: judgeCol ? cell(judgeCol.k) : '',
            outOfTolerance: tr.classList.contains('row-tol-fail'),
          };
        }),
      };
    },
  };
}
