// qr-decode.js — reads the QR code out of a picture. One implementation
// for everything that has a picture to read: the camera scanner's worker
// (scan-worker.js pulls this in with importScripts), the scanner's own
// fallback when it has no worker (scanner.js), and an uploaded image
// (interpolate.js). Plain globals, no bundler — same pattern as the
// rest of this app.
//
// Two readers:
//   - ZXing — vendor/zxing-reader.js and vendor/zxing_reader.wasm, which
//     are zxing-wasm 3.1.5's reader build: the ZXing-C++ library
//     compiled to WebAssembly. This is the one that does the reading.
//     Certificate QRs are big (well over a hundred modules a side) and
//     carry a logo over their middle, and ZXing reads them where jsQR
//     can't — jsQR fails on some of them even as a perfect image file.
//   - jsQR — vendor/jsQR.js, what the app read with before. Kept only
//     as the fallback for when ZXing can't be started: no WebAssembly,
//     or its .wasm file can't be fetched (a page opened straight from
//     disk isn't allowed to fetch one).
// Either way a code that was read has the one shape the rest of the app
// was written against, which is the part of jsQR's own result it uses:
//   { data, binaryData, location }
// data is the code's content as text; binaryData is its raw bytes,
// which is what matters here — a certificate's payload is
// raw-DEFLATE-compressed (see readCertificateQr in scanner.js) and only
// survives as bytes; location is the code's four corners in the
// picture, in pixels.
//
// ZXing can also say that a code is there without being able to read
// it — found and lined up, but too small or too blurred for its
// contents to come out right. readQrImage passes that on as `seen`,
// which is what the camera scanner's auto-zoom goes by (scanner.js).

// Relative, so it resolves against whichever of the page or the worker
// is asking — both live next to vendor/. Without this ZXing would fetch
// the file from a CDN, and this app is meant to work with no network.
const ZXING_WASM_URL = 'vendor/zxing_reader.wasm';

let zxingStarting = null;

// Resolves to whether ZXing is usable here. The .wasm is fetched and
// compiled once, the first time this is asked.
function startZxing() {
  if (!zxingStarting) {
    zxingStarting = (async () => {
      if (typeof ZXingWASM === 'undefined' || typeof WebAssembly === 'undefined') return false;
      try {
        await ZXingWASM.prepareZXingModule({
          overrides: {
            locateFile: (path, prefix) => (path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path),
          },
          fireImmediately: true,
        });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return zxingStarting;
}

function zxingLocation(position) {
  return {
    topLeftCorner: position.topLeft,
    topRightCorner: position.topRight,
    bottomRightCorner: position.bottomRight,
    bottomLeftCorner: position.bottomLeft,
  };
}

// readQrImage(image, thorough, wantSeen) resolves to { code, seen } for
// `image` ({ data, width, height } of RGBA pixels — an ImageData):
//   code — the code read from it, or null;
//   seen — only when asked for (`wantSeen`) and nothing was read:
//     { location } of a code that's there but couldn't be read, or
//     null. Always null from jsQR, which has no such answer.
// `thorough` also tries the picture with light and dark swapped: worth
// it for a one-off uploaded image, not for every camera frame —
// certificate QRs are always dark-on-light, and it would double the
// cost of every frame that has no code in it.
async function readQrImage(image, thorough, wantSeen) {
  if (await startZxing()) {
    const options = {
      formats: ['QRCode'],
      tryHarder: true,
      tryInvert: Boolean(thorough),
      maxNumberOfSymbols: 1,
    };
    try {
      const hit = (await ZXingWASM.readBarcodes(image, options)).find((result) => result.isValid);
      if (hit) {
        return {
          code: {
            data: hit.text,
            // A copy: the bytes handed back may be a view onto ZXing's own
            // memory, which the next read reuses.
            binaryData: new Uint8Array(hit.bytes),
            location: zxingLocation(hit.position),
          },
          seen: null,
        };
      }
      if (!wantSeen) return { code: null, seen: null };
      // A second pass rather than an option on the first: told to hand
      // back codes it couldn't read, ZXing stops at the first of those
      // and never gets to the further attempts that sometimes do read
      // the same code.
      const glimpse = (await ZXingWASM.readBarcodes(image, { ...options, returnErrors: true }))[0];
      return { code: null, seen: glimpse && glimpse.position ? { location: zxingLocation(glimpse.position) } : null };
    } catch {
      // A read that throws is a frame that didn't read.
      return { code: null, seen: null };
    }
  }

  let code = null;
  if (typeof jsQR !== 'undefined') {
    try {
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: thorough ? 'attemptBoth' : 'dontInvert' });
      if (found) code = { data: found.data, binaryData: found.binaryData, location: found.location };
    } catch {
      code = null;
    }
  }
  return { code, seen: null };
}

// Just the code, or null — for a picture that either reads or doesn't
// (an uploaded image).
async function decodeQrImage(image, thorough) {
  return (await readQrImage(image, thorough, false)).code;
}
