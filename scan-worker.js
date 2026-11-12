// scan-worker.js — reads QR codes for scanner.js on a thread of its
// own. One image takes tens to hundreds of milliseconds; on the page's
// own thread that's long enough to freeze the zoom animation and the
// highlight box while it runs. Receives { id, buffer, width, height }
// (RGBA pixels, the buffer transferred rather than copied) and answers
// { id, code, seen } — what qr-decode.js's readQrImage made of it.

importScripts('vendor/jsQR.js');
try {
  importScripts('vendor/zxing-reader.js');
} catch {
  // qr-decode.js reads with jsQR when ZXing isn't there.
}
importScripts('qr-decode.js');

self.onmessage = async (e) => {
  const { id, buffer, width, height } = e.data;
  const { code, seen } = await readQrImage(new ImageData(new Uint8ClampedArray(buffer), width, height), false, true);
  self.postMessage({ id, code, seen });
};
