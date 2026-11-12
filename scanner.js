// scanner.js — the camera QR scanner with auto-zoom, built to
// qr-scanner-design.md (its "Track A", Web: one implementation for a
// PC browser and for the Android app's WebView). Plain globals, no
// bundler — same pattern as history.js. Section numbers below (§4.6
// etc.) refer to that document.
//
// Two halves:
//   createZoomController() — the §4 state machine. Pure logic, no DOM
//     or camera: it's told what each analysed frame showed and answers
//     with what the zoom should do.
//   createQrScanner() — everything around it: camera, frame analysis
//     (detect + decode), the zoom actuator, and the viewfinder UI.
//
// Detecting a code and decoding it are separate steps (§4.1), but one
// tool does both here: qr-decode.js's readQrImage — ZXing, with jsQR
// behind it — in a worker (scan-worker.js), so the page stays
// responsive while it works. Each attempt looks at one region of the
// camera frame and comes back with one of three answers:
//   - The code, read. The certificate payload is raw-DEFLATE bytes (see
//     readCertificateQr at the end of this file), which only a decoder
//     that hands back the code's bytes keeps intact.
//   - A sighting: a code is there, but too small or too blurred to
//     read. Its box is what auto-zoom is steered by, and where the
//     next attempts look — cut from the full-size frame, enlarged.
//   - Nothing. The §6 crop pyramid moves on: each attempt tries the
//     whole view or a tighter centre crop of it, enlarged, which is
//     what finds a smaller, further-away code.
// Attempts run as fast as the decoder gets through them — one at a
// time, always on the newest frame — while the zoom controller is
// updated every analysed frame (about 15 a second, which is what it
// counts in).
//
// The browser's own BarcodeDetector is deliberately not used, though
// the Android WebView has one and it finds a small code sooner. On a
// Galaxy A56 it took the whole app down ("Certificate QR keeps
// stopping") whenever it found a code too small to read: an uncaught
// NullPointerException inside the WebView itself, on its GPU thread,
// where nothing a page does can catch it.

const SCAN_CONFIG = {
  // §4.3 thresholds. `f` is the code's size as a fraction of the view.
  //
  // F_TARGET is 0.55 rather than the spec's 0.40 default: certificate
  // QRs are dense (well over 100 modules a side), and at 0.40 of a
  // 1080-pixel-wide frame that's about 3.5 pixels per module — right
  // at the limit of what decodes. 0.55 leaves margin, and is still far
  // from both F_MIN and F_MAX, so the hysteresis in §4.6 #5 holds.
  F_TARGET: 0.55,
  F_MIN: 0.15,
  F_MAX: 0.85,
  EDGE_MARGIN: 0.02,
  FAIL_FRAMES_BEFORE_ZOOM: 5,
  // Not in the spec: a code between F_MIN and F_TARGET that still
  // hasn't decoded after this many frames (about a second) gets zoomed
  // to F_TARGET too. The spec only zooms in below F_MIN, which leaves
  // dense codes stuck in that band — detected, too small to read, and
  // never enlarged.
  STALL_FRAMES_BEFORE_ZOOM: 15,
  ZOOM_COOLDOWN_MS: 600,
  ZOOM_RAMP_MS: 300,
  ZOOM_STEP_MS: 30,
  MAX_ZOOM: 5,
  MIN_STEP: 0.15,
  LOST_RESET_MS: 3000,
  // Detection of a small code flickers frame to frame; the fail/stall
  // counts survive gaps shorter than this instead of restarting.
  COUNT_RESET_MS: 400,
  // How long a sighting (see the top of this file) goes on counting as
  // "there's a code here" when nothing newer has confirmed it.
  SIGHTING_MS: 600,
  // A code that has stayed in sight this long without being read isn't
  // going to be from where the phone is: enlarging the picture adds no
  // detail to it. The person holding it is told to move closer — and
  // again every this-long, for as long as that goes on.
  UNREAD_HINT_MS: 3000,

  // What the camera is asked for; it gives the nearest it has. 4K where
  // the phone offers it, because that's twice as many pixels across a
  // code as 1080p — the same code reads from about twice as far, or
  // the same distance with twice the margin. Nothing downstream costs
  // more for it: the decoder is fed bounded-size images
  // (ANALYSIS_MAX_SIDE) cut from the bigger frame.
  CAMERA_WIDTH: 3840,
  CAMERA_HEIGHT: 2160,

  ANALYSIS_INTERVAL_MS: 66,
  // Longest side, in pixels, of the image handed to the decoder — bounds the
  // cost of one analysis whatever the camera resolution is.
  ANALYSIS_MAX_SIDE: 960,
  MAX_UPSCALE: 2,
  // §6: the crops tried in turn, one per analysed frame — the whole
  // view, then centred squares: the view's shorter side, then each
  // PYRAMID_RATIO of the last. The spec's 50/33/25% steps suit simple
  // codes; a certificate QR needs most of ANALYSIS_MAX_SIDE to itself
  // before it reads, so the steps are closer together and square, so
  // that at every size a centred code has a crop it nearly fills. They
  // stop at PYRAMID_MIN_SIDE camera pixels — a certificate QR in fewer
  // pixels than that has too few per module to read at any crop — so a
  // higher-resolution camera gets more, smaller steps by itself.
  PYRAMID_RATIO: 0.7,
  PYRAMID_MIN_SIDE: 360,
  // Reading a dense code can turn on exactly how the image was
  // resampled — the same crop can read at one size and miss at the
  // next (jsQR, the fallback decoder, is especially touchy about it).
  // So successive attempts at the same region resize it differently:
  // these multiply the scale it would otherwise get.
  SCALE_VARIANTS: [1, 0.8, 0.65],
  // Extra room kept around a sighted code's box when cropping it for the
  // decoder, which needs the code's quiet zone to find it.
  BOX_MARGIN: 0.12,

  FREEZE_MS: 300,
  // Mean luminance (0–255) below which the frame counts as dark, and
  // how long it has to stay there before the torch is suggested.
  DARK_LUMA: 45,
  DARK_AFTER_MS: 1200,
  // How long a QR that decoded but wasn't accepted is ignored for, so
  // its error isn't re-reported on every frame it stays in view.
  REJECT_REPEAT_MS: 3000,
  HINT_MS: 1600,
  ZOOM_BADGE_MS: 1200,
};

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// --- Zoom controller (§4) ---
// update() is called once per analysed frame with:
//   { now, decoded, box, frameW, frameH, zoom, minZoom, maxZoom }
// `box` is the detected code ({ x, y, w, h } in the same pixels as
// frameW/frameH) or null. It returns { state, action } where action is
// null, { type: 'zoom', target, direction, focus } or { type: 'hint',
// hint } — a hint being the cases zoom can't fix: 'move-back' (code
// overflows at minimum zoom, test T3), 'move-closer' (still tiny at
// maximum zoom), 'centre' (cut off by the edge at minimum zoom).
function createZoomController(config) {
  const cfg = config || SCAN_CONFIG;
  let state = 'SEARCHING';
  let failCount = 0;
  let stallCount = 0;
  let lastSeen = -Infinity;
  let lastZoomAt = -Infinity;
  let rampUntil = -Infinity;
  let userOverride = false;

  function touchesEdge(box, frameW, frameH) {
    const mx = frameW * cfg.EDGE_MARGIN;
    const my = frameH * cfg.EDGE_MARGIN;
    return box.x <= mx || box.y <= my || box.x + box.w >= frameW - mx || box.y + box.h >= frameH - my;
  }

  function beginZoom(now, nextState, target, focus) {
    state = nextState;
    lastZoomAt = now;
    rampUntil = now + cfg.ZOOM_RAMP_MS;
    failCount = 0;
    stallCount = 0;
    const direction = nextState === 'ZOOMING_IN' ? 'in' : 'out';
    return { state, action: { type: 'zoom', target, direction, focus } };
  }

  function update(frame) {
    const { now, box, zoom, minZoom, maxZoom } = frame;
    // §4.6 #1 — decode first, zoom second.
    if (frame.decoded) {
      state = 'DECODED';
      return { state, action: null };
    }
    const ramping = now < rampUntil;

    if (!box) {
      if (now - lastSeen > cfg.COUNT_RESET_MS) {
        failCount = 0;
        stallCount = 0;
      }
      if (now - lastSeen > cfg.LOST_RESET_MS && !ramping) {
        state = 'SEARCHING';
        // §4.6 #4 — lost while zoomed: back to 1.0×.
        if (!userOverride && zoom > minZoom + 0.01) return beginZoom(now, 'ZOOMING_OUT', minZoom, null);
      }
      return { state, action: null };
    }

    lastSeen = now;
    if (!ramping) state = 'TRACKING';
    if (userOverride || ramping || now - lastZoomAt < cfg.ZOOM_COOLDOWN_MS) return { state, action: null };

    // The spec measures width only; a square code in a landscape frame
    // runs out of height first, so whichever side is tighter counts.
    const f = Math.max(box.w / frame.frameW, box.h / frame.frameH);
    const edge = touchesEdge(box, frame.frameW, frame.frameH);
    const focus = { x: (box.x + box.w / 2) / frame.frameW, y: (box.y + box.h / 2) / frame.frameH };

    // §4.6 #3 — too big, or cut off: zoom out. A box cut off by the
    // edge under-reports its own size, so it's treated as at least
    // F_MAX; taken at face value, a small clipped box would compute a
    // zoom-*in* and push the code further out of view.
    if (f > cfg.F_MAX || edge) {
      const target = clampNumber((zoom * cfg.F_TARGET) / Math.max(f, cfg.F_MAX), minZoom, maxZoom);
      if (zoom - target >= cfg.MIN_STEP) return beginZoom(now, 'ZOOMING_OUT', target, focus);
      return { state, action: { type: 'hint', hint: f > cfg.F_MAX ? 'move-back' : 'centre' } };
    }

    // §4.6 #2 — detected, too small, and still not decoding: zoom in.
    if (f < cfg.F_MIN) {
      failCount += 1;
      stallCount += 1;
    } else if (f < cfg.F_TARGET) {
      failCount = 0;
      stallCount += 1;
    } else {
      failCount = 0;
      stallCount = 0;
    }
    if (failCount >= cfg.FAIL_FRAMES_BEFORE_ZOOM || stallCount >= cfg.STALL_FRAMES_BEFORE_ZOOM) {
      failCount = 0;
      stallCount = 0;
      const target = clampNumber((zoom * cfg.F_TARGET) / f, minZoom, maxZoom);
      if (target - zoom >= cfg.MIN_STEP) return beginZoom(now, 'ZOOMING_IN', target, focus);
      // Already as far in as the camera goes and still not reading it.
      if (zoom >= maxZoom - 0.01) return { state, action: { type: 'hint', hint: 'move-closer' } };
    }
    return { state, action: null };
  }

  return {
    update,
    // §4.6 #7 — a manual pinch turns auto-zoom off for the session.
    setUserOverride() {
      userOverride = true;
    },
    getState() {
      return state;
    },
  };
}

// --- Scanner ---
// createQrScanner({ root, validate, onResult }) wires up one scanner
// inside `root`, finding its parts by data-role (see interpolate.html):
// stage, video, highlight, zoom-badge, hint, torch, stop, error-title,
// error-text, and any number of start buttons.
//   validate(code) — called with each code the decoder reads; returns
//     { accepted: value } to finish with that value, or { rejected:
//     'why' } to keep scanning with that reason shown over the picture.
//   onResult(value) — called once with the accepted value, after the
//     success feedback, with the camera already stopped.
// Returns { start, stop, isRunning }. The stage's data-state attribute
// (idle | starting | running | error) drives which overlay shows.
//
// While the camera is starting or live the stage covers the whole page
// (style.css keys that off data-state); it drops back into its place in
// the page the moment the scanner stops — a code read, the ✕ button,
// Esc, or Back, which closes the scanner instead of leaving the page.

const SCANNER_HINT_TEXT = {
  'move-back': 'Too close — move back a little',
  'move-closer': 'Too far — move closer',
  centre: 'Centre the code in the frame',
  dark: 'Low light — turn on the torch',
  'dark-no-torch': 'Low light — add more light',
};

const SCANNER_ERRORS = {
  insecure: {
    title: 'Camera not available here',
    text: 'A browser only allows camera access on a page served over https:// or localhost — not one opened straight from a file. Run the app with "npm run dev", or use Upload image.',
  },
  denied: {
    title: 'Camera permission is off',
    text: 'In a browser: use the camera icon in the address bar to allow the camera for this page. In the Android app: Settings → Apps → Certificate QR → Permissions → Camera → Allow. Then try again.',
  },
  'no-camera': {
    title: 'No camera found',
    text: 'This device has no camera the app can use. Use Upload image with a photo or screenshot of the code instead.',
  },
  busy: {
    title: 'Camera is in use',
    text: 'Another app or browser tab is using the camera. Close it, then try again.',
  },
  failed: {
    title: 'Could not start the camera',
    text: '',
  },
};

// The decoder behind one call: decode(imageData) resolves to what
// qr-decode.js's readQrImage made of it — { code, seen }, either of
// them null. Runs in scan-worker.js; if the worker can't be started
// (pages opened straight from disk aren't allowed one) or dies, it
// falls back to decoding here on the page's thread — slower to the
// touch, but it still scans.
function createQrDecoder() {
  let worker = null;
  let nextId = 0;
  const waiting = new Map();

  function dropWorker() {
    if (worker) worker.terminate();
    worker = null;
    // Their pixel buffers went to the worker with the request, so these
    // can't be retried here — the frames are simply skipped.
    waiting.forEach((resolve) => resolve({ code: null, seen: null }));
    waiting.clear();
  }

  try {
    worker = new Worker('scan-worker.js');
    worker.onmessage = (e) => {
      const resolve = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (resolve) resolve({ code: e.data.code || null, seen: e.data.seen || null });
    };
    worker.onerror = dropWorker;
  } catch {
    worker = null;
  }

  return {
    decode(image) {
      if (!worker) return readQrImage(image, false, true);
      return new Promise((resolve) => {
        nextId += 1;
        waiting.set(nextId, resolve);
        const buffer = image.data.buffer;
        worker.postMessage({ id: nextId, buffer, width: image.width, height: image.height }, [buffer]);
      });
    },
  };
}

function createQrScanner(options) {
  const cfg = SCAN_CONFIG;
  const root = options.root;
  const part = (role) => root.querySelector(`[data-role="${role}"]`);
  const stage = part('stage');
  const video = part('video');
  const highlightEl = part('highlight');
  const zoomBadgeEl = part('zoom-badge');
  const hintEl = part('hint');
  const torchBtn = part('torch');
  const stopBtn = part('stop');
  const frameEl = part('frame');
  const errorTitleEl = part('error-title');
  const errorTextEl = part('error-text');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Bumped by every start() and stop(): anything asynchronous that
  // finishes after the session it belonged to has ended (a decode,
  // the success timer) compares against it and backs out.
  let session = 0;
  let running = false;
  let stream = null;
  let track = null;
  let controller = null;

  const decoder = createQrDecoder();
  let decoding = false;
  // The latest sighting: { frameBox, at } — where, in camera-frame
  // pixels, a code was last found but not read, and when.
  let sighting = null;
  // When the code now in sight was first sighted (or last had a "move
  // closer" said about it) — null with nothing in sight.
  let sightedSince = null;
  let frozen = false;
  let lastAnalysis = 0;
  let pyramidIndex = 0;
  let boxAttempt = 0;

  // `zoom` is a ratio where 1 is the whole camera frame. It is digital
  // (§6): a centre crop of the frame for the analysis, and a matching
  // CSS scale of the <video> for the eye; the camera itself isn't asked
  // to zoom. Nothing is lost for reading: the frame is asked for at 4K
  // (CAMERA_WIDTH), and decoding always cuts from that full-size frame,
  // so a code is read from the same pixels whether or not the picture
  // is enlarged. And a sighting's box, which is in those pixels, stays
  // true from one frame to the next while the zoom changes.
  let zoom = 1;
  const maxZoom = cfg.MAX_ZOOM;
  let rampTimer = null;

  let torchOn = false;
  let torchAvailable = false;
  let darkSince = null;
  let rejectedKey = null;
  let rejectedUntil = 0;
  let hintTimer = null;
  let hintIsDark = false;
  let badgeTimer = null;
  let audioCtx = null;

  function setState(state) {
    stage.dataset.state = state;
    setFullPage(state === 'starting' || state === 'running');
  }

  // --- Full-page mode ---
  // Going full page adds one entry to the browser history, so that
  // Back (the phone's button or gesture, or the browser's) has
  // something to undo other than the page itself: it pops that entry,
  // which lands in the popstate handler below and stops the scanner.
  // When the scanner closes any other way, the entry is taken back out
  // with history.back() — and that pop is one the handler must ignore.
  let fullPage = false;
  let ownHistoryEntry = false;
  let backsToIgnore = 0;

  function setFullPage(on) {
    if (on === fullPage) return;
    fullPage = on;
    document.documentElement.classList.toggle('scanner-open', on);
    try {
      if (on) {
        window.history.pushState({ certqrScanner: true }, '');
        ownHistoryEntry = true;
      } else if (ownHistoryEntry) {
        ownHistoryEntry = false;
        backsToIgnore += 1;
        window.history.back();
      }
    } catch {
      // No usable history here — Back just behaves as it normally would.
      ownHistoryEntry = false;
    }
    layoutFrame();
  }

  window.addEventListener('popstate', () => {
    if (backsToIgnore > 0) {
      backsToIgnore -= 1;
      return;
    }
    if (!ownHistoryEntry) return;
    // The entry is already gone — that's what this event is — so it
    // mustn't be taken out a second time when stop() leaves full page.
    ownHistoryEntry = false;
    stop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fullPage) stop();
  });

  // The viewfinder is a square sized off the stage's shorter side — the
  // stage being anything from a wide box in the page to a tall phone
  // screen, which plain CSS percentages can't express.
  function layoutFrame() {
    const side = Math.round(Math.min(stage.clientWidth, stage.clientHeight) * 0.72);
    frameEl.style.width = `${side}px`;
    frameEl.style.height = `${side}px`;
  }
  if (window.ResizeObserver) new ResizeObserver(layoutFrame).observe(stage);

  function showError(kind, detail) {
    const message = SCANNER_ERRORS[kind];
    errorTitleEl.textContent = message.title;
    errorTextEl.textContent = message.text || detail || '';
    setState('error');
  }

  // --- Camera manager (§3 #1) ---

  function applyTrackSetting(setting) {
    if (!track) return Promise.resolve();
    return track.applyConstraints({ advanced: [setting] }).catch(() => {
      // Not every camera honours every setting it advertises; each of
      // these (focus, torch) is an improvement, not a requirement.
    });
  }

  async function start() {
    if (running || stage.dataset.state === 'starting') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('insecure');
      return;
    }
    session += 1;
    const mySession = session;
    setState('starting');

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: cfg.CAMERA_WIDTH },
          height: { ideal: cfg.CAMERA_HEIGHT },
        },
      });
    } catch (err) {
      if (mySession !== session) return;
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') showError('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') showError('no-camera');
      else if (name === 'NotReadableError' || name === 'AbortError') showError('busy');
      else showError('failed', (err && err.message) || String(err));
      return;
    }
    // stop() was called while the permission prompt was still up.
    if (mySession !== session) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }

    stream = newStream;
    track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    zoom = 1;
    video.style.transform = '';
    torchAvailable = Boolean(caps.torch);
    torchOn = false;
    torchBtn.classList.toggle('hidden', !torchAvailable);
    torchBtn.setAttribute('aria-pressed', 'false');
    torchBtn.classList.remove('scanner-btn-suggest');
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      applyTrackSetting({ focusMode: 'continuous' });
    }

    controller = createZoomController(cfg);
    decoding = false;
    sighting = null;
    sightedSince = null;
    frozen = false;
    lastAnalysis = 0;
    pyramidIndex = 0;
    boxAttempt = 0;
    darkSince = null;
    rejectedKey = null;
    hideHighlight();
    hideHint();
    zoomBadgeEl.classList.add('hidden');

    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      if (mySession !== session) return;
      stop();
      showError('failed', (err && err.message) || String(err));
      return;
    }
    if (mySession !== session) return;
    running = true;
    setState('running');
    scheduleFrame();
  }

  function stop() {
    session += 1;
    running = false;
    frozen = false;
    decoding = false;
    sighting = null;
    cancelRamp();
    clearTimeout(hintTimer);
    clearTimeout(badgeTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    controller = null;
    pointers.clear();
    video.pause();
    video.srcObject = null;
    video.style.transform = '';
    hideHighlight();
    hideHint();
    zoomBadgeEl.classList.add('hidden');
    setState('idle');
  }

  // --- Zoom actuator (§3 #4) ---

  function setZoom(value) {
    const next = clampNumber(value, 1, maxZoom);
    if (next === zoom) return;
    zoom = next;
    video.style.transform = zoom > 1 ? `scale(${zoom})` : '';
    showZoomBadge();
  }

  function cancelRamp() {
    clearInterval(rampTimer);
    rampTimer = null;
  }

  // §8 — zoom changes are animated, never jumps. Interpolated as a
  // ratio rather than linearly, since zoom is perceived that way: each
  // step enlarges the picture by the same proportion.
  function rampZoom(target) {
    cancelRamp();
    const from = zoom;
    const startedAt = performance.now();
    rampTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / cfg.ZOOM_RAMP_MS);
      // The last step lands on the target itself, not on whatever the
      // arithmetic rounds to — 1× has to end up exactly 1×.
      setZoom(t >= 1 ? target : from * Math.pow(target / from, t * (2 - t)));
      if (t >= 1) cancelRamp();
    }, cfg.ZOOM_STEP_MS);
  }

  // --- Frame analyzer (§3 #2) ---

  function scheduleFrame() {
    if (!running) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
  }

  function onFrame() {
    if (!running) return;
    scheduleFrame();
    const now = performance.now();
    if (frozen || now - lastAnalysis < cfg.ANALYSIS_INTERVAL_MS) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    lastAnalysis = now;
    try {
      analyse(now, session);
    } catch {
      // A frame that couldn't be analysed is just skipped.
    }
  }
  // The part of the camera frame the user is looking at: all of it, or
  // under digital zoom the centre crop the scaled <video> is showing.
  function currentView(vw, vh) {
    if (zoom <= 1) return { x: 0, y: 0, w: vw, h: vh };
    const w = vw / zoom;
    const h = vh / zoom;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  // Copies one region of the current frame out for the decoder, resampled so
  // its longest side is at most ANALYSIS_MAX_SIDE (and enlarged by at
  // most MAX_UPSCALE), times `variant` (see SCALE_VARIANTS). Returns
  // { image, scale }.
  function grabRegion(region, variant) {
    const scale = Math.min(cfg.MAX_UPSCALE, cfg.ANALYSIS_MAX_SIDE / Math.max(region.w, region.h)) * variant;
    const cw = Math.max(1, Math.round(region.w * scale));
    const ch = Math.max(1, Math.round(region.h * scale));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, cw, ch);
    return { image: ctx.getImageData(0, 0, cw, ch), scale: cw / region.w };
  }

  // Which region the next decode attempt looks at, and at what size.
  // With a sighted code's box, that box; without one, the next step of
  // the §6 pyramid. Each attempt at a box, and each full round of the
  // pyramid, moves on to the next scale variant.
  function nextDecodeTarget(box, view, vw, vh) {
    const variants = cfg.SCALE_VARIANTS;
    if (box) {
      boxAttempt += 1;
      return { region: expandBox(box, vw, vh), variant: variants[boxAttempt % variants.length] };
    }
    const sides = pyramidSides(view);
    const steps = sides.length + 1;
    const step = pyramidIndex % steps;
    const round = Math.floor(pyramidIndex / steps);
    pyramidIndex += 1;
    const variant = variants[round % variants.length];
    // Step 0 is the whole view; the rest are the centred squares.
    if (step === 0) return { region: { x: view.x, y: view.y, w: view.w, h: view.h, full: true }, variant };
    const side = sides[step - 1];
    return {
      region: { x: view.x + (view.w - side) / 2, y: view.y + (view.h - side) / 2, w: side, h: side, full: false },
      variant,
    };
  }

  // Side lengths of the pyramid's squares for this view (see
  // PYRAMID_RATIO) — always at least the one that fills it.
  function pyramidSides(view) {
    const sides = [Math.min(view.w, view.h)];
    while (sides[sides.length - 1] * cfg.PYRAMID_RATIO >= cfg.PYRAMID_MIN_SIDE) {
      sides.push(sides[sides.length - 1] * cfg.PYRAMID_RATIO);
    }
    return sides;
  }

  // A sighted code's box as the zoom controller needs it: the part of
  // it that's inside the view, relative to the view. Null when none of
  // it is — under digital zoom a code can be outside the picture and
  // still be read, since decoding cuts from the whole frame.
  function boxInView(box, view) {
    const x1 = Math.max(box.x, view.x);
    const y1 = Math.max(box.y, view.y);
    const x2 = Math.min(box.x + box.w, view.x + view.w);
    const y2 = Math.min(box.y + box.h, view.y + view.h);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1 - view.x, y: y1 - view.y, w: x2 - x1, h: y2 - y1 };
  }
  function expandBox(box, vw, vh) {
    const m = Math.max(box.w, box.h) * cfg.BOX_MARGIN;
    const x = Math.max(0, box.x - m);
    const y = Math.max(0, box.y - m);
    return { x, y, w: Math.min(vw, box.x + box.w + m) - x, h: Math.min(vh, box.y + box.h + m) - y };
  }

  function meanLuma(image) {
    const data = image.data;
    let sum = 0;
    let count = 0;
    // Every 16th pixel is plenty for an average.
    for (let i = 0; i < data.length; i += 64) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      count += 1;
    }
    return count ? sum / count : 255;
  }

  // §8 — suggest the torch when the picture stays dark.
  function trackDarkness(image, now) {
    if (meanLuma(image) >= cfg.DARK_LUMA || torchOn) {
      darkSince = null;
      torchBtn.classList.remove('scanner-btn-suggest');
      if (hintIsDark) hideHint();
      return;
    }
    if (darkSince === null) darkSince = now;
    if (now - darkSince < cfg.DARK_AFTER_MS) return;
    torchBtn.classList.toggle('scanner-btn-suggest', torchAvailable);
    if (hintEl.classList.contains('hidden')) showHint(torchAvailable ? 'dark' : 'dark-no-torch', true);
  }

  function codeBoxInFrame(code, region, scale) {
    const l = code.location;
    const xs = [l.topLeftCorner.x, l.topRightCorner.x, l.bottomRightCorner.x, l.bottomLeftCorner.x];
    const ys = [l.topLeftCorner.y, l.topRightCorner.y, l.bottomRightCorner.y, l.bottomLeftCorner.y];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      x: region.x + x / scale,
      y: region.y + y / scale,
      w: (Math.max(...xs) - x) / scale,
      h: (Math.max(...ys) - y) / scale,
    };
  }

  // Starts one decode attempt on the current frame; its answer arrives
  // some frames later, by which time the zoom controller has carried
  // on without it.
  function startDecode(box, view, vw, vh, now, mySession) {
    const { region, variant } = nextDecodeTarget(box, view, vw, vh);
    const { image, scale } = grabRegion(region, variant);
    if (region.full) trackDarkness(image, now);
    decoding = true;
    decoder.decode(image).then(({ code, seen }) => {
      if (mySession !== session) return;
      decoding = false;
      if (frozen) return;
      if (!code) {
        // There, but not readable yet: where the next attempts look,
        // and what the zoom is steered by.
        const frameBox = seen ? codeBoxInFrame(seen, region, scale) : null;
        if (frameBox && frameBox.w > 0 && frameBox.h > 0) sighting = { frameBox, at: performance.now() };
        return;
      }
      const key = `${code.data}|${code.binaryData ? code.binaryData.length : 0}`;
      const at = performance.now();
      if (key === rejectedKey && at < rejectedUntil) return;
      const verdict = options.validate(code) || {};
      if (verdict.accepted) {
        succeed(verdict.accepted, codeBoxInFrame(code, region, scale));
        return;
      }
      rejectedKey = key;
      rejectedUntil = at + cfg.REJECT_REPEAT_MS;
      if (verdict.rejected) showRejection(verdict.rejected);
    });
  }

  function analyse(now, mySession) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const view = currentView(vw, vh);

    if (sighting && now - sighting.at > cfg.SIGHTING_MS) sighting = null;
    const box = sighting ? sighting.frameBox : null;

    if (!decoding) startDecode(box, view, vw, vh, now, mySession);

    if (box) showHighlight(box, false);
    else hideHighlight();
    if (!box) sightedSince = null;
    else if (sightedSince === null) sightedSince = now;

    // Every frame that gets here is one the code hasn't been read in
    // yet — which is exactly what the controller counts.
    const result = controller.update({
      now,
      decoded: false,
      box: box ? boxInView(box, view) : null,
      frameW: view.w,
      frameH: view.h,
      zoom,
      minZoom: 1,
      maxZoom,
    });
    if (!result.action) {
      // Nothing the zoom can do about it, and it still isn't reading.
      if (box && result.state === 'TRACKING' && now - sightedSince >= cfg.UNREAD_HINT_MS) {
        sightedSince = now;
        showHint('move-closer', false);
      }
      return;
    }
    if (result.action.type === 'zoom') rampZoom(result.action.target);
    else showHint(result.action.hint, false);
  }
  // --- Result handler (§3 #5) ---

  function beep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioCtx = audioCtx || new AudioCtx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 1320;
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.12);
    } catch {
      // No audio — the highlight and the result itself still confirm it.
    }
  }

  // §8 — haptic + beep, and the frame held for a moment so it's clear
  // which code was read before the scanner closes.
  function succeed(accepted, frameBox) {
    frozen = true;
    cancelRamp();
    controller.update({ now: performance.now(), decoded: true });
    video.pause();
    hideHint();
    showHighlight(frameBox, true);
    if (navigator.vibrate) navigator.vibrate(60);
    beep();
    const mySession = session;
    setTimeout(() => {
      if (mySession !== session) return;
      stop();
      options.onResult(accepted);
    }, cfg.FREEZE_MS);
  }

  // --- UI layer (§3 #6) ---

  // Camera-frame pixels → stage pixels, undoing object-fit: cover and
  // the digital-zoom scale so the highlight sits on the code as shown.
  function showHighlight(frameBox, success) {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!sw || !sh || !vw || !vh) return;
    const s = Math.max(sw / vw, sh / vh) * zoom;
    highlightEl.style.left = `${(frameBox.x - vw / 2) * s + sw / 2}px`;
    highlightEl.style.top = `${(frameBox.y - vh / 2) * s + sh / 2}px`;
    highlightEl.style.width = `${frameBox.w * s}px`;
    highlightEl.style.height = `${frameBox.h * s}px`;
    highlightEl.classList.toggle('scanner-highlight-success', success);
    highlightEl.classList.remove('hidden');
  }

  function hideHighlight() {
    highlightEl.classList.add('hidden');
  }

  // Why the code just read wasn't taken — the page's words, shown for
  // as long as that same code goes on being ignored.
  function showRejection(text) {
    hintEl.textContent = text;
    hintEl.classList.add('scanner-hint-rejected');
    hintEl.classList.remove('hidden');
    hintIsDark = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, cfg.REJECT_REPEAT_MS);
  }

  function showHint(hint, isDark) {
    // A rejection is the more useful thing to be reading; it clears
    // itself, and the nudges come round again.
    if (hintEl.classList.contains('scanner-hint-rejected') && !hintEl.classList.contains('hidden')) return;
    hintEl.textContent = SCANNER_HINT_TEXT[hint];
    hintEl.classList.remove('hidden');
    hintIsDark = isDark;
    clearTimeout(hintTimer);
    // The low-light hint stays for as long as it's dark (trackDarkness
    // takes it down); the others are a nudge that fades by itself.
    if (!isDark) hintTimer = setTimeout(hideHint, cfg.HINT_MS);
  }

  function hideHint() {
    clearTimeout(hintTimer);
    hintEl.classList.add('hidden');
    hintEl.classList.remove('scanner-hint-rejected');
    hintIsDark = false;
  }

  function showZoomBadge() {
    zoomBadgeEl.textContent = `${zoom.toFixed(1)}×`;
    zoomBadgeEl.classList.remove('hidden');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => zoomBadgeEl.classList.add('hidden'), cfg.ZOOM_BADGE_MS);
  }

  // Manual pinch-zoom (§8): two fingers on the stage, the zoom follows
  // how far apart they are compared with where they started.
  const pointers = new Map();
  let pinchStartDistance = 0;
  let pinchStartZoom = 1;

  function pinchDistance() {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!running) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      pinchStartDistance = pinchDistance();
      pinchStartZoom = zoom;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size !== 2 || !pinchStartDistance || frozen || !controller) return;
    cancelRamp();
    controller.setUserOverride();
    setZoom((pinchStartZoom * pinchDistance()) / pinchStartDistance);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
    stage.addEventListener(type, (e) => {
      pointers.delete(e.pointerId);
      pinchStartDistance = 0;
    });
  });

  torchBtn.addEventListener('click', () => {
    if (!running || !torchAvailable) return;
    torchOn = !torchOn;
    torchBtn.setAttribute('aria-pressed', String(torchOn));
    torchBtn.classList.remove('scanner-btn-suggest');
    applyTrackSetting({ torch: torchOn });
  });
  stopBtn.addEventListener('click', stop);
  root.querySelectorAll('[data-role="start"]').forEach((btn) => btn.addEventListener('click', start));

  // §9 — no camera (or battery) spent on a page nobody is looking at.
  // Only once it's actually running: the permission prompt can itself
  // hide the page for a moment, and stopping then would cancel the very
  // start it was asked for.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) stop();
  });

  setState('idle');
  layoutFrame();
  return {
    start,
    stop,
    isRunning() {
      return running;
    },
  };
}

// --- Certificate QR payload ---
// What the pages that scan (interpolate.js, lablog.js) make of a
// decoded code (qr-decode.js) once the scanner — or an uploaded image —
// has produced one. The method is equipment-tracker's, which makes the
// codes; it is written up step by step in qr-code-decoding.md, and the
// step numbers below are that document's. Everything from here down to
// readCertificateBytes is this app's copy of the reference
// implementation there (equipment-tracker's src/utils/qrPayloadFormat.js
// and qrDictionary.js): if one side changes, the other has to change
// with it.
//
// A code's bytes are raw DEFLATE (no zlib or gzip header, no checksum)
// of the JSON text of a list with no key names, everything in it known
// by its position. The list starts with its layout number:
//   layout 3   [3, id, name, [certificate, ...]]
//              certificate = [cert, trace, due, [table, ...]]
//     every current certificate of the equipment, in the one code;
//   layout 2   [2, id, name, cert, trace, due, [table, ...]]
//     the same thing with exactly one certificate, written flat — what
//     equipment-tracker 1.11.0 made, and labels of it may be in use.
//   table = [scope, unit, [labDp, corDp, uncDp], [lab...], [cor...], [unc...]]
// A table's values are by column, not by row, and numbers are whole
// numbers, the decimal point taken out, with how many digits belong
// after it kept once per column.
//
// Decoding gives the same object from either layout, every value in it
// text exactly as it was typed on the certificate:
//   { id, name, cert, trace, due,
//     certs: [{ cert, trace, due }, ...],
//     tables: [{ scope, unit, rows, cert }, ...] }
// `certs` is the equipment's certificates; `tables` is all of their
// tables, each with the number of the certificate it is from and each
// row [lab reading, correction, uncertainty]. The first three fields
// after the name are for whoever asks one thing of the equipment as a
// whole: `cert` is every certificate number joined with ", ", `trace`
// each different traceability likewise, and `due` the EARLIEST of the
// due dates — an equipment's calibration stops being wholly valid the
// day any one of its certificates passes its date. history.js's
// scanCertificates is what judges them one by one.
//
// Most codes are deflated with a shared dictionary (dictionary.js), and
// say so: their first byte is the marker below and their second is the
// dictionary's number, with the deflated data after those two. The
// marker can never be the first byte of raw DEFLATE data (its
// block-type bits are the reserved value), so a code with a dictionary
// and one without cannot be mistaken for each other.

// The newest layout this app reads — the number a payload starts with.
// A later layout will start with a higher one.
const QR_PAYLOAD_VERSION = 3;
// The layout before it: one certificate, written flat.
const SINGLE_CERTIFICATE_VERSION = 2;
const QR_DICTIONARY_MARKER = 0xd6;

// A whole number back to the text it was typed as: 574 with 2 decimals
// is "5.74", -27 with 2 is "-0.27", 10 with 1 is "1.0". Done on the
// digits, never by dividing: floating point can change a reading, and
// trailing zeros would be lost — "0.30" on a certificate has to come
// back as "0.30", not "0.3".
function scaledToText(int, decimals) {
  const digits = String(Math.abs(int)).padStart(decimals + 1, '0');
  const sign = int < 0 ? '-' : '';
  return decimals === 0 ? sign + digits : `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

// One column of a table back to text. `dp` is the column's decimals:
// one count for every value in it, or a list with a count per value
// (a column that mixes "-100.00" and "-60.000"). A value that was never
// a plain decimal number — "N/A", "< 0.1", "1e-3" — was stored as its
// own text and comes back as it is; a blank comes back blank.
function decodeColumn(values, dp) {
  return (Array.isArray(values) ? values : []).map((value, i) => {
    if (typeof value !== 'number') return value === null || value === undefined ? '' : String(value);
    const decimals = Array.isArray(dp) ? dp[i] : dp;
    return scaledToText(value, Number.isInteger(decimals) && decimals > 0 ? decimals : 0);
  });
}

// A certificate's tables, the same in both layouts. A table whose three
// columns differ in length is from a damaged code: it gets as many rows
// as it has lab readings, blanks where the others run short, rather
// than an error.
function decodeTables(tables) {
  return (Array.isArray(tables) ? tables : []).map((table) => {
    const [scope, unit, dp, lab, cor, unc] = Array.isArray(table) ? table : [];
    const decimals = Array.isArray(dp) ? dp : [];
    const columns = [decodeColumn(lab, decimals[0]), decodeColumn(cor, decimals[1]), decodeColumn(unc, decimals[2])];
    return { scope: scope || '', unit: unit || '', rows: columns[0].map((value, i) => [value, columns[1][i] ?? '', columns[2][i] ?? '']) };
  });
}

// The result object, from an equipment's certificates each with its own
// tables. The dates are YYYY-MM-DD, so the first in plain text order is
// the earliest; a certificate with no date doesn't count towards it.
function toContent(id, name, certificates) {
  const certs = certificates.map(({ cert, trace, due }) => ({ cert: cert || '', trace: trace || '', due: due || '' }));
  return {
    id: id || '',
    name: name || '',
    cert: certs.map((c) => c.cert).filter(Boolean).join(', '),
    trace: [...new Set(certs.map((c) => c.trace).filter(Boolean))].join(', '),
    due: certs.map((c) => c.due).filter(Boolean).sort()[0] || '',
    certs,
    tables: certificates.flatMap((certificate, i) => certificate.tables.map((table) => ({ ...table, cert: certs[i].cert }))),
  };
}

// Step 5. Returns the result object, or null if the payload is neither
// layout. A certificate that isn't a list is from a damaged code: it
// becomes one with blank fields and no tables, rather than an error.
function decodeQrPayload(payload) {
  if (!Array.isArray(payload)) return null;
  if (payload[0] === QR_PAYLOAD_VERSION) {
    const [, id, name, certificates] = payload;
    return toContent(id, name, (Array.isArray(certificates) ? certificates : []).map((certificate) => {
      const [cert, trace, due, tables] = Array.isArray(certificate) ? certificate : [];
      return { cert, trace, due, tables: decodeTables(tables) };
    }));
  }
  if (payload[0] === SINGLE_CERTIFICATE_VERSION) {
    const [, id, name, cert, trace, due, tables] = payload;
    return toContent(id, name, [{ cert, trace, due, tables: decodeTables(tables) }]);
  }
  return null;
}
// Steps 1 to 5, from a code's raw bytes. `dictionaries.get(n)` is
// dictionary n as a Uint8Array, or nothing if it isn't held. Returns
// { payload }, or { problem } naming which failure it was:
//   'missing-dictionary' — the code names a dictionary that isn't
//     held (`dictionaryId` says which). It is never tried with another
//     one, or with none: the data cannot be inflated without its own.
//   'newer-layout' — a layout number above the one this app knows,
//     which is never guessed at.
//   'not-a-certificate' — with `detail`, this copy's one addition to
//     the reference, saying how far it got: 'inflate' (the bytes are
//     not DEFLATE data), 'json' (they are, but not of JSON) or
//     'layout' (JSON, but not a layout-2 or layout-3 list with an id).
function readCertificateBytes(bytes, dictionaries, inflateRaw) {
  let text;
  try {
    if (bytes.length > 2 && bytes[0] === QR_DICTIONARY_MARKER) {
      const dictionary = dictionaries.get(bytes[1]);
      if (!dictionary) return { problem: 'missing-dictionary', dictionaryId: bytes[1] };
      text = inflateRaw(bytes.subarray(2), { dictionary, toText: true });
    } else {
      text = inflateRaw(bytes, { toText: true });
    }
  } catch {
    return { problem: 'not-a-certificate', detail: 'inflate' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'not-a-certificate', detail: 'json' };
  }
  if (Array.isArray(parsed) && typeof parsed[0] === 'number' && parsed[0] > QR_PAYLOAD_VERSION) return { problem: 'newer-layout' };
  const payload = decodeQrPayload(parsed);
  return payload && payload.id ? { payload } : { problem: 'not-a-certificate', detail: 'layout' };
}

// Why a code that is not a certificate isn't one, for the status line.
const NOT_CERTIFICATE_REASONS = {
  inflate: 'That code is not certificate data (it does not hold the compressed data a certificate label carries).',
  json: 'That code decompressed, but it is not certificate data (not JSON).',
  layout: 'That code is valid JSON but does not look like equipment-tracker certificate data (not a layout-2 or layout-3 list with an "id").',
};

// What a decoded QR turned out to be: { payload } if it carries
// certificate data; otherwise { error, hint, problem } — why not, in
// full for the page and in a few words for over the camera picture, and
// which of readCertificateBytes's problems it was. Each kind of failure
// has its own remedy, so each has its own message.
//
// `code.binaryData` is the raw bytes of the QR's byte-mode segment(s),
// which is what a certificate is read from (step 1). `code.data`, the
// decoder's own reading of those bytes as text, is no use here: they
// are compressed binary, and reading them as text destroys them.
function readCertificateQr(code) {
  const result = readCertificateBytes(new Uint8Array(code.binaryData || []), qrDictionaries, pako.inflateRaw);
  if (result.payload) return { payload: result.payload };
  if (result.problem === 'missing-dictionary') {
    // Asked for again at once (dictionary.js). With the camera open the
    // label is read again on a later frame, and is taken as soon as the
    // download has finished.
    refreshQrDictionaries();
    return {
      error: `This label needs dictionary ${result.dictionaryId}, which this device has not downloaded yet. Connect to the internet — it downloads by itself — then scan the label again.`,
      hint: `Needs dictionary ${result.dictionaryId} — not downloaded yet`,
      problem: result.problem,
    };
  }
  if (result.problem === 'newer-layout') {
    return {
      error: 'This QR code is in a newer format than this version of the app can read. Update the app (Settings → Updates), then scan it again.',
      hint: 'Update the app to read this code',
      problem: result.problem,
    };
  }
  return { error: NOT_CERTIFICATE_REASONS[result.detail], hint: 'Not a certificate QR code', problem: result.problem };
}

// --- Equipment label QR ---
// The other kind of code the Scan in / out page (lablog.js) reads: an
// equipment's own label. It is made in Kanji mode at error-correction
// level Q and holds no certificate data, only four things as text:
//   ID, Maker, Brand, Serial number
// Nothing here depends on the mode or the level. The decoder
// (qr-decode.js) reads every QR mode and level by itself, and hands back
// a Kanji-mode code's text already turned from Shift_JIS into ordinary
// text as `code.data`. A certificate is read from the raw bytes instead,
// which for one of these codes are Shift_JIS and not certificate data.
//
// Two ways of writing the four are read:
//   - labelled, in any order, each "label: value" — "ID: EA-E-O01,
//     Maker: Fluke, Brand: 726, Serial number: 1234567". The labels
//     below are recognised, in English or Japanese, either case. At
//     least two of them have to be there, so a code that just happens to
//     contain "id:" isn't taken for a label.
//   - by position, exactly four values in the order above, one to a
//     line, or on one line separated by commas (a trailing comma is
//     fine). A value may be blank, except the ID.
// Kanji mode can only hold full-width characters, so a label written
// entirely in it has "ＥＡ－Ｅ－Ｏ０１" for EA-E-O01. Everything is
// therefore brought to its ordinary form (Unicode NFKC) first, and the
// dashes Shift_JIS has in place of "-" become "-" in the ID, so the ID
// matches the one on the equipment's certificate.
const EQUIPMENT_LABEL_FIELDS = [
  { key: 'id', labels: ['equipment id', 'equipment no.', 'equipment no', 'id', '管理番号', '機器番号'] },
  { key: 'maker', labels: ['manufacturer', 'maker', 'メーカー', 'メーカ', '製造元', '製造者'] },
  { key: 'brand', labels: ['brand', 'ブランド'] },
  { key: 'serial', labels: ['serial number', 'serial no.', 'serial no', 'serial', 's/n', 'sn', '製造番号', 'シリアル番号'] },
];
const EQUIPMENT_LABEL_KEYS = new Map(EQUIPMENT_LABEL_FIELDS.flatMap(({ key, labels }) => labels.map((label) => [label, key])));
// A label, then ":" or "=". The longest labels are tried first ("serial
// number" before "serial"), and an English one has to start a word, so
// the "id" in "uuid:" is not one.
const EQUIPMENT_LABEL_PATTERN = new RegExp(
  `(?<![a-z0-9])(${[...EQUIPMENT_LABEL_KEYS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('|')})\\s*[:=]`,
  'gi',
);
const EQUIPMENT_LABEL_ORDER = ['id', 'maker', 'brand', 'serial'];

// Text of an equipment label → { id, maker, brand, serial }, or null if
// it isn't one.
function parseEquipmentLabel(rawText) {
  const text = String(rawText || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  // What separates one value from the next isn't part of either.
  const clean = (value) => value.replace(/^[\s,;、]+|[\s,;、]+$/g, '');
  const fields = {};

  const found = [...text.matchAll(EQUIPMENT_LABEL_PATTERN)];
  if (found.length > 0) {
    found.forEach((match, index) => {
      const key = EQUIPMENT_LABEL_KEYS.get(match[1].toLowerCase());
      const end = index + 1 < found.length ? found[index + 1].index : text.length;
      if (key && fields[key] === undefined) fields[key] = clean(text.slice(match.index + match[0].length, end));
    });
    if (Object.keys(fields).length < 2) return null;
  } else {
    let pieces = text.split('\n');
    if (pieces.length === 1) pieces = text.split(/[,;、\t]/);
    pieces = pieces.map(clean);
    while (pieces.length > EQUIPMENT_LABEL_ORDER.length && pieces[pieces.length - 1] === '') pieces.pop();
    if (pieces.length !== EQUIPMENT_LABEL_ORDER.length) return null;
    EQUIPMENT_LABEL_ORDER.forEach((key, index) => { fields[key] = pieces[index]; });
  }

  const id = (fields.id || '').replace(/[‐-―−－]/g, '-').replace(/\s+/g, ' ');
  if (!id) return null;
  return { id, maker: fields.maker || '', brand: fields.brand || '', serial: fields.serial || '' };
}

// A decoded QR (qr-decode.js) as an equipment label, or null.
function readEquipmentLabelQr(code) {
  return parseEquipmentLabel(code && code.data);
}

// The label's description, for a log that has no certificate scan of
// the equipment to take its name from: "Fluke 726 (S/N 1234567)".
function equipmentLabelDescription(label) {
  const name = [label.maker, label.brand].filter(Boolean).join(' ');
  if (!label.serial) return name;
  return name ? `${name} (S/N ${label.serial})` : `S/N ${label.serial}`;
}
