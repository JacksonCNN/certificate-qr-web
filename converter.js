// converter.js — "Converter" page: a process value to the instrument
// signal that stands for it (4–20 mA, 0–10 V, …), and back.
//
// One drop-down and four boxes:
//   Signal      which signal — its two ends are fixed (4 and 20 mA, say)
//   Low limit   the process value at the signal's low end
//   High limit  the process value at the signal's high end
//   Value       a process value   ┐ type either one,
//   Current /   the signal for it ┘ the other is worked out
//   Voltage
// It's a straight line through the two ends: a 0–200 range on 4–20 mA
// puts 100 at 12 mA. Nothing is clamped — a value outside the limits
// converts as it stands (250 gives 24 mA), with a note that it's out
// of range.

// Saved through history.js's store, so the limits entered here are
// still there on the next visit (this is a multi-page app — following
// any nav link reloads the script).
const CONVERTER_KEY = 'certqr:converter';

const SIGNALS = [
  { id: 'ma-4-20', label: '4–20 mA', kind: 'Current', unit: 'mA', min: 4, max: 20 },
  { id: 'ma-0-20', label: '0–20 mA', kind: 'Current', unit: 'mA', min: 0, max: 20 },
  { id: 'v-0-10', label: '0–10 V', kind: 'Voltage', unit: 'V', min: 0, max: 10 },
  { id: 'v-2-10', label: '2–10 V', kind: 'Voltage', unit: 'V', min: 2, max: 10 },
  { id: 'v-0-5', label: '0–5 V', kind: 'Voltage', unit: 'V', min: 0, max: 5 },
  { id: 'v-1-5', label: '1–5 V', kind: 'Voltage', unit: 'V', min: 1, max: 5 },
];

const signalSelect = document.getElementById('conv-signal');
const lowInput = document.getElementById('conv-low');
const highInput = document.getElementById('conv-high');
const valueInput = document.getElementById('conv-value');
const signalInput = document.getElementById('conv-signal-value');
const lowLabel = document.getElementById('conv-low-label');
const highLabel = document.getElementById('conv-high-label');
const signalLabel = document.getElementById('conv-signal-label');
const signalUnit = document.getElementById('conv-signal-unit');
const bannerEl = document.getElementById('conv-banner');
const noteEl = document.getElementById('conv-note');
const clearBtn = document.getElementById('conv-clear');
const pointsSelect = document.getElementById('conv-points');
const checkTableEl = document.getElementById('conv-check-table');

const CHECK_POINT_OPTIONS = { 3: [0, 50, 100], 5: [0, 25, 50, 75, 100], 11: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] };

// A number as typed: comma or dot for the decimal point. null for
// anything that isn't (yet) a number — an empty box, or a half-typed
// "-" or "." on the way to one.
function parseNumber(text) {
  const trimmed = String(text).trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Rounded for display, never for the maths (the typed number is kept
// at full precision): 4 decimals for ordinary values, 4 significant
// figures below 1 so a small range like 0–0.5 doesn't round to nothing.
// Trailing zeros dropped — 12 rather than 12.0000.
function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  const rounded = Math.abs(n) >= 1 ? Number(n.toFixed(4)) : Number(n.toPrecision(4));
  return String(rounded === 0 ? 0 : rounded);
}

// The signal the boxes are currently on. Kept here rather than read
// off the drop-down so that, the moment the drop-down changes, the old
// signal is still known for one last conversion (see its handler).
let signalId = SIGNALS[0].id;

function currentSignal() {
  return SIGNALS.find((s) => s.id === signalId);
}

// The two limits as numbers, and whether there's a span between them
// to convert across — there isn't while either is blank, or when
// they're equal.
function currentLimits() {
  const low = parseNumber(lowInput.value);
  const high = parseNumber(highInput.value);
  return { low, high, usable: low !== null && high !== null && low !== high };
}

// What both boxes are derived from: { field, value } — which of the
// two was last typed in ('value' or 'signal') and the number typed.
// null when there's nothing entered. Holding on to that, rather than
// to both numbers, is what makes a changed limit behave: a value of
// 100 is still 100 when the high limit moves, and it's the signal that
// is worked out again.
let source = null;
// The box being typed in right now, if either. Its text is left
// exactly as typed — a box that reformatted itself under the cursor
// ("12." snapping to "12") would be unusable — while the other is
// rewritten. Cleared on leaving the box, which tidies it too.
let editing = null;

// Both numbers for the current source, limits and signal:
// { value, signal }, either of which is null if it can't be worked out.
function compute() {
  if (!source) return { value: null, signal: null };
  const sig = currentSignal();
  const { low, high, usable } = currentLimits();
  if (source.field === 'value') {
    const signal = usable ? sig.min + ((source.value - low) / (high - low)) * (sig.max - sig.min) : null;
    return { value: source.value, signal };
  }
  const value = usable ? low + ((source.value - sig.min) / (sig.max - sig.min)) * (high - low) : null;
  return { value, signal: source.value };
}

function renderBanner(sig, signal) {
  // A hair of tolerance, so 20 mA worked out as 20.000000000000004
  // isn't reported as over range.
  const tolerance = (sig.max - sig.min) * 1e-9;
  const outOfRange = signal !== null && (signal < sig.min - tolerance || signal > sig.max + tolerance);
  bannerEl.classList.toggle('hidden', !outOfRange);
  if (!outOfRange) return;
  bannerEl.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'due-banner-icon';
  icon.textContent = '⚠';
  const text = document.createElement('span');
  text.textContent = `${signal < sig.min ? 'Below' : 'Above'} the ${sig.label} range — outside the limits. Converted as it stands, not clamped.`;
  bannerEl.appendChild(icon);
  bannerEl.appendChild(text);
}

// "Low limit (at 4 mA)" — the bracketed part in a span of its own,
// because the label is styled in capitals and a unit isn't something
// to capitalise: "MA" would read as megaamps.
function setLimitLabel(label, text, at, unit) {
  label.textContent = `${text} `;
  const span = document.createElement('span');
  span.className = 'conv-row-at';
  span.textContent = `(at ${at} ${unit})`;
  label.appendChild(span);
}

// The same conversion tabulated at the usual calibration check points
// — percent of span, the value there, and the signal there — for the
// signal and limits above, whatever is or isn't typed in the Value box.
// Without usable limits there's no value to give, so that column is
// left out and the table is just percent against signal.
function renderCheckTable() {
  const sig = currentSignal();
  const { low, high, usable } = currentLimits();
  const points = CHECK_POINT_OPTIONS[pointsSelect.value] || CHECK_POINT_OPTIONS[5];
  const cell = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  checkTableEl.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(cell('th', '%'));
  if (usable) headRow.appendChild(cell('th', 'VALUE'));
  // Capitals written out rather than applied by CSS, so the unit keeps
  // its own case — "mA", not "MA".
  headRow.appendChild(cell('th', `${sig.kind.toUpperCase()} (${sig.unit})`));
  thead.appendChild(headRow);
  checkTableEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  points.forEach((point) => {
    const tr = document.createElement('tr');
    tr.appendChild(cell('td', String(point)));
    if (usable) tr.appendChild(cell('td', formatNumber(low + (point / 100) * (high - low))));
    tr.appendChild(cell('td', formatNumber(sig.min + (point / 100) * (sig.max - sig.min))));
    tbody.appendChild(tr);
  });
  checkTableEl.appendChild(tbody);
}

function render() {
  const sig = currentSignal();
  const { low, high } = currentLimits();
  const kind = sig.kind.toLowerCase();

  // The labels spell out what each limit lines up with, so there's no
  // doubt which way round the range is.
  signalSelect.value = sig.id;
  setLimitLabel(lowLabel, 'Low limit', sig.min, sig.unit);
  setLimitLabel(highLabel, 'High limit', sig.max, sig.unit);
  signalLabel.textContent = sig.kind;
  signalUnit.textContent = sig.unit;

  const { value, signal } = compute();
  if (editing !== 'value') valueInput.value = value !== null ? formatNumber(value) : '';
  if (editing !== 'signal') signalInput.value = signal !== null ? formatNumber(signal) : '';
  renderBanner(sig, signal);
  renderCheckTable();

  if (low === null || high === null) noteEl.textContent = 'Enter both limits to convert.';
  else if (low === high) noteEl.textContent = 'The low and high limits are the same — there is nothing to convert across.';
  else noteEl.textContent = `Type a value to get its ${kind}, or a ${kind} to get its value.`;
}

function saveState() {
  writeStore(CONVERTER_KEY, {
    signal: signalId,
    low: lowInput.value,
    high: highInput.value,
    points: pointsSelect.value,
    source,
  });
}

function wireBox(input, field) {
  input.addEventListener('input', () => {
    editing = field;
    const value = parseNumber(input.value);
    source = value !== null ? { field, value } : null;
    render();
    saveState();
  });
  input.addEventListener('blur', () => {
    if (editing !== field) return;
    editing = null;
    render();
  });
}
// All four boxes take one number, which may be negative (history.js's
// restrictInput). Before wireBox and the limits' listeners below, so
// those work from the cleaned text.
[lowInput, highInput, valueInput, signalInput].forEach((input) => {
  restrictInput(input, (text) => cleanNumberText(text, true));
});
wireBox(valueInput, 'value');
wireBox(signalInput, 'signal');

[lowInput, highInput].forEach((input) => {
  input.addEventListener('input', () => {
    render();
    saveState();
  });
});

// Switching signal keeps the value and works the new signal out from
// it: 100 on a 0–200 range is 12 mA on 4–20 mA and becomes 5 V on
// 0–10 V. Holding on to a typed signal number across the switch
// instead would turn 12 mA into "12 V".
signalSelect.addEventListener('change', () => {
  const { value } = compute(); // still on the old signal at this point
  signalId = signalSelect.value;
  if (value !== null) source = { field: 'value', value };
  editing = null;
  render();
  saveState();
});

pointsSelect.addEventListener('change', () => {
  renderCheckTable();
  saveState();
});

clearBtn.addEventListener('click', () => {
  source = null;
  editing = null;
  render();
  saveState();
});

// --- Boot: restore the last signal, limits and value, or start at
// 4–20 mA over 0–100 ---
SIGNALS.forEach((sig) => {
  const option = document.createElement('option');
  option.value = sig.id;
  option.textContent = sig.label;
  signalSelect.appendChild(option);
});

hydrateStorage([CONVERTER_KEY]).then(() => {
  const saved = readStore(CONVERTER_KEY, null);
  if (saved && typeof saved === 'object') {
    if (SIGNALS.some((s) => s.id === saved.signal)) signalId = saved.signal;
    // `lrv`/`urv` are what an earlier layout of this page called the
    // two limits — read so limits saved by it carry over.
    const low = saved.low !== undefined ? saved.low : saved.lrv;
    const high = saved.high !== undefined ? saved.high : saved.urv;
    if (typeof low === 'string') lowInput.value = low;
    if (typeof high === 'string') highInput.value = high;
    if (CHECK_POINT_OPTIONS[saved.points]) pointsSelect.value = saved.points;
    const s = saved.source;
    if (s && (s.field === 'value' || s.field === 'signal') && Number.isFinite(s.value)) {
      source = { field: s.field, value: s.value };
    }
  }
  render();
});
