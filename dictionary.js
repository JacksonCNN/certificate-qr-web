// dictionary.js — the shared dictionaries a certificate QR code can be
// compressed with (qr-code-decoding.md, "Shared dictionaries"). Loaded by
// the pages that scan, ahead of scanner.js, whose readCertificateQr is
// what uses them. Plain globals, no bundler — same pattern as history.js.
//
// A dictionary is a block of text that equipment-tracker, which makes the
// codes, and this app both hold: the scope names, units, laboratories and
// equipment names that turn up in code after code. A code made with one
// can point into it rather than spell those out, which makes the code
// about a third smaller — and unreadable without the very dictionary it
// was made with. Each has a number, 1 to 255, that the code names.
//
// The rules a reader has to keep, all of them here:
//   - A dictionary is its text as UTF-8 bytes, exactly. Nothing in it is
//     interpreted.
//   - Every dictionary ever obtained is kept: a printed label is in use
//     for as long as its certificate is current.
//   - One already held is never replaced by another of the same number,
//     whatever a source says. A published dictionary never changes; a
//     better one comes out under a new number.
//
// When a scanning page opens, three places are looked in, in this order,
// and anything new is saved on the device:
//   1. The device's own saved copy (localStorage). Needs no network, and
//      is read the moment this script runs.
//   2. The copies built into this version of the app: dictionaries/
//      index.json — { "ids": [1, ...] } — and dictionaries/<n>.txt, next
//      to the page.
//   3. The app's GitHub repository, where equipment-tracker publishes
//      them (www/dictionaries/, the same two kinds of file). This is how
//      a phone gets one published after its copy of the app was built.
// No network is an ordinary state, not an error: scanning carries on with
// what is held. A label that names one that isn't held is turned away
// with a message saying so, and the download is tried again there and
// then (scanner.js).

const QR_DICTIONARIES_KEY = 'qrDictionaries';
const QR_DICTIONARIES_BUILT_IN_PATH = 'dictionaries';
const QR_DICTIONARIES_FETCH_TIMEOUT_MS = 10000;

function isQrDictionaryId(id) {
  return Number.isInteger(id) && id >= 1 && id <= 255;
}

// The dictionaries held: qrDictionaries.get(n) is dictionary n as a
// Uint8Array, or undefined if this device doesn't hold it.
const qrDictionaries = (() => {
  // Kept as text, which is what localStorage can hold; the bytes of one
  // are worked out the first time a code asks for it.
  const texts = new Map();
  const bytes = new Map();

  // The saved copy: { "<n>": "<text>", ... }.
  try {
    const saved = JSON.parse(localStorage.getItem(QR_DICTIONARIES_KEY) || '{}');
    Object.keys(saved && typeof saved === 'object' ? saved : {}).forEach((key) => {
      const id = Number(key);
      if (isQrDictionaryId(id) && typeof saved[key] === 'string' && saved[key] !== '') texts.set(id, saved[key]);
    });
  } catch {
    // Nothing saved that can be read; the other two places still can be.
  }

  function save() {
    try {
      localStorage.setItem(QR_DICTIONARIES_KEY, JSON.stringify(Object.fromEntries(texts)));
    } catch {
      // Storage full or unavailable: held for as long as the page is
      // open, and fetched again the next time one opens.
    }
  }

  return {
    get(id) {
      if (!texts.has(id)) return undefined;
      if (!bytes.has(id)) bytes.set(id, new TextEncoder().encode(texts.get(id)));
      return bytes.get(id);
    },
    has(id) {
      return texts.has(id);
    },
    ids() {
      return Array.from(texts.keys()).sort((a, b) => a - b);
    },
    // Takes a dictionary in, unless one of that number is held already.
    // Returns whether it was taken.
    hold(id, text) {
      if (!isQrDictionaryId(id) || typeof text !== 'string' || text === '' || texts.has(id)) return false;
      texts.set(id, text);
      save();
      return true;
    },
  };
})();

// One request for a dictionary file, to either place. Resolves to the
// Response, and rejects for anything but the file itself.
async function fetchQrDictionaryFile(url, headers) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(QR_DICTIONARIES_FETCH_TIMEOUT_MS), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A server that answers a missing file with its front page instead of
  // "not found" must not have that page kept as a dictionary — kept is
  // for good.
  if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error('Not a dictionary file');
  return res;
}

// The two places dictionaries are fetched from. `file(name)` is one
// file of the place: its index.json, or a <n>.txt.
const QR_DICTIONARY_SOURCES = [
  {
    available: () => true,
    file: (name) => fetchQrDictionaryFile(`${QR_DICTIONARIES_BUILT_IN_PATH}/${name}`),
  },
  {
    // updater.js's: the repository, and the read-only token the app
    // carries for it. The "raw" media type returns the file itself.
    available: () => hasGithubToken(),
    file: (name) => fetchQrDictionaryFile(`${GITHUB_API_URL}/contents/www/dictionaries/${name}`, {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    }),
  },
];

// Takes in every dictionary a place lists that isn't held yet. Only
// those are asked for.
async function addQrDictionariesFrom(source) {
  if (!source.available()) return;
  const index = await (await source.file('index.json')).json();
  const wanted = (index && Array.isArray(index.ids) ? index.ids : []).filter((id) => isQrDictionaryId(id) && !qrDictionaries.has(id));
  for (const id of wanted) {
    try {
      const res = await source.file(`${id}.txt`);
      // Its bytes read as UTF-8 with nothing taken off the front — the
      // bytes used for inflating have to be the file's, exactly.
      qrDictionaries.hold(id, new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()));
    } catch {
      // That one another time; the rest of the list still counts.
    }
  }
}

// Looks in the two places for dictionaries not held yet. One look at a
// time: a call during one joins it. Never rejects — a place that can't
// be reached is simply not heard from.
let qrDictionariesRefresh = null;

function refreshQrDictionaries() {
  if (!qrDictionariesRefresh) {
    qrDictionariesRefresh = (async () => {
      for (const source of QR_DICTIONARY_SOURCES) {
        try {
          await addQrDictionariesFrom(source);
        } catch {
          // No network, or nothing published there.
        }
      }
    })().finally(() => {
      qrDictionariesRefresh = null;
    });
  }
  return qrDictionariesRefresh;
}

refreshQrDictionaries();
