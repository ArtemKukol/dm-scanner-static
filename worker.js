/* Frame triage worker.
 *
 * Receives an ImageBitmap from the main thread. Computes:
 *   - focus  (Laplacian variance, on a 320-wide grayscale crop)
 *   - glare  (fraction of pixels >= 250 in the same crop)
 * Re-renders the bitmap to MAX_LONG_EDGE so the main thread can pass
 * a single normalized ImageBitmap straight into the decoder pipeline
 * without re-decoding the camera frame again.
 *
 * The CPU-bound triage runs off the main thread so it never blocks
 * the camera preview or UI gestures.
 */

const MAX_LONG_EDGE = 1280;
const TRIAGE_WIDTH  = 320;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg?.type !== "triage") return;

  const bitmap = msg.bitmap;
  if (!bitmap) {
    self.postMessage({ type: "triage:error", error: "no bitmap" });
    return;
  }

  const w = bitmap.width;
  const h = bitmap.height;

  /* ── triage on downscaled grayscale ──────────────────────── */
  const tW = TRIAGE_WIDTH;
  const tH = Math.max(1, Math.round((h / w) * tW));

  let tcanvas, tctx, td;
  try {
    tcanvas = new OffscreenCanvas(tW, tH);
    tctx    = tcanvas.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(bitmap, 0, 0, tW, tH);
    td = tctx.getImageData(0, 0, tW, tH).data;
  } catch (e) {
    bitmap.close?.();
    self.postMessage({ type: "triage:error", error: String(e) });
    return;
  }

  /* grayscale */
  const gray = new Uint8ClampedArray(tW * tH);
  for (let i = 0, j = 0; i < td.length; i += 4, j++) {
    gray[j] = (td[i] * 0.299 + td[i + 1] * 0.587 + td[i + 2] * 0.114) | 0;
  }

  /* 3x3 Laplacian variance */
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < tH - 1; y++) {
    for (let x = 1; x < tW - 1; x++) {
      const i = y * tW + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - tW] - gray[i + tW];
      sum   += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean  = sum / Math.max(1, n);
  const focus = sumSq / Math.max(1, n) - mean * mean;

  /* glare fraction */
  let bright = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] >= 250) bright++;
  const glare = bright / gray.length;

  /* ── re-render to MAX_LONG_EDGE for the pipeline ─────────── */
  const longEdge = Math.max(w, h);
  const scale    = Math.min(1, MAX_LONG_EDGE / longEdge);
  const dW       = Math.max(1, Math.round(w * scale));
  const dH       = Math.max(1, Math.round(h * scale));

  let outBitmap;
  try {
    const oc   = new OffscreenCanvas(dW, dH);
    const octx = oc.getContext("2d", { willReadFrequently: true });
    octx.drawImage(bitmap, 0, 0, dW, dH);
    outBitmap = oc.transferToImageBitmap();
  } catch (e) {
    bitmap.close?.();
    self.postMessage({ type: "triage:error", error: String(e) });
    return;
  }

  bitmap.close?.();

  self.postMessage(
    {
      type: "triage:done",
      bitmap: outBitmap,
      width: dW,
      height: dH,
      focus,
      glare,
      ts: msg.ts ?? performance.now(),
    },
    [outBitmap]
  );
};
