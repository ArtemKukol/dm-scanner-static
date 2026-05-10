/* DM Recovery Scanner — pure-frontend, browser-only.
 *
 * What this file does, top to bottom:
 *   1. State machine + UI bindings.
 *   2. Camera (getUserMedia, torch, continuous focus).
 *   3. Frame loop (rAF + Web Worker triage for focus/glare).
 *   4. Pipeline:
 *        - generate 6 preprocessed variants of the same frame
 *        - run ZXing-WASM decoder against each variant
 *        - validate GS1 («Честный ЗНАК»)
 *        - regenerate identical Data Matrix with BWIP-JS
 *        - round-trip-verify (re-decode the regen, compare bytes)
 *   5. POS display: pixel-perfect canvas, fullscreen, wake lock,
 *      orientation lock, brightness hint.
 *
 * Anti-fabrication invariants:
 *   - We only emit a payload that a real decoder returned.
 *   - We only show a regenerated symbol after byte-identity
 *     round-trip with the same decoder.
 *   - On any failure we report failure — never a guessed payload.
 */

// ── Library URLs (pinned). Cached by the service worker so the
//    PWA works offline after first load. -------------------------
const ZXING_URL = "https://esm.sh/zxing-wasm@2.0.0/reader";
const BWIP_URL  = "https://esm.sh/bwip-js@4.5.2";

// ── Tunables --------------------------------------------------
const CFG = {
  captureLongEdge: 1280,    // worker re-renders to this size
  captureFps: 5,            // initial frame loop rate
  captureFpsLow: 2,         // throttled rate when CPU-bound
  minFocus: 50,             // Laplacian variance gate
  maxGlare: 0.92,           // glare fraction gate
  agreementCount: 2,        // multi-frame confirmation
  confidenceMin: 0.70,      // emit success above this
  decodeBudgetMs: 700,      // hard per-frame budget for the pipeline
  posModulesPx: 8,          // pixel-per-module target on POS display
  posQuietModules: 4,       // quiet zone (modules) on POS display
};

// ── DOM refs --------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  app:           $("app"),
  video:         $("camera"),
  start:         $("start-btn"),
  welcome:       $("welcome"),
  camError:      $("cam-error"),
  libStatus:     $("lib-status"),
  torch:         $("torch-btn"),
  reticle:       $("reticle"),
  confidence:    $("confidence"),
  stateLabel:    $("state-label"),
  fpsLabel:      $("fps-label"),
  framesLabel:   $("frames-label"),
  latencyLabel:  $("latency-label"),
  connDot:       $("conn-dot"),
  connLabel:     $("conn-label"),
  hint:          $("hint"),
  hintText:      $("hint-text"),
  sheet:         $("success-sheet"),
  sheetConf:     $("sheet-conf"),
  sheetMeta:     $("sheet-meta"),
  showBtn:       $("show-btn"),
  rescanBtn:     $("rescan-btn"),
  displayStage:  $("display-stage"),
  dmCanvas:      $("dm-canvas"),
  displayPayload:$("display-payload"),
  boostBtn:      $("boost-btn"),
  invertBtn:     $("invert-btn"),
  closeDisplay:  $("close-display-btn"),
  workCanvas:    $("work-canvas"),
  regenCanvas:   $("regen-canvas"),
  verifyCanvas:  $("verify-canvas"),
};

// ── Global mutable state --------------------------------------
const state = {
  stateName: "IDLE",
  stream: null,
  track: null,
  torchSupported: false,
  torchOn: false,
  worker: null,
  loopRaf: 0,
  loopBusy: false,
  fps: CFG.captureFps,
  framesProcessed: 0,
  framesAccepted: 0,
  agreement: new Map(),     // payload hex → count
  bestPayload: null,        // Uint8Array
  bestConfidence: 0,
  bestDecodeMeta: null,     // { decoder, pipeline, sharpness, gs1Valid, bytes }
  bestRegen: null,          // { canvas, payloadUtf8 }
  zxing: null,              // { readBarcodes }
  bwip: null,               // bwipjs
  libsReady: false,
  wakeLock: null,
  posBoost: false,
  posInverted: false,
  hintTimer: 0,
  fpsTimer: 0,
  fpsCounter: 0,
};

// ── State machine --------------------------------------------
const STATES = ["IDLE","CAMERA_READY","SCANNING","PROCESSING","SUCCESS","DISPLAY_FOR_POS"];
function setState(next) {
  if (!STATES.includes(next)) return;
  state.stateName = next;
  els.app.dataset.state = next;
  els.stateLabel.textContent = next;
  els.sheet.hidden       = next !== "SUCCESS";
  els.displayStage.hidden = next !== "DISPLAY_FOR_POS";
}

function flashHint(text, ms = 1400) {
  els.hintText.textContent = text;
  els.hint.hidden = false;
  clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(() => { els.hint.hidden = true; }, ms);
}

// ── Library loader -------------------------------------------
async function loadLibs() {
  els.libStatus.textContent = "Загрузка библиотек…";
  try {
    const [zx, bw] = await Promise.all([
      import(/* @vite-ignore */ ZXING_URL),
      import(/* @vite-ignore */ BWIP_URL),
    ]);
    state.zxing = {
      readBarcodes: zx.readBarcodes ?? zx.default?.readBarcodes,
      prepareZXingModule: zx.prepareZXingModule ?? zx.default?.prepareZXingModule,
    };
    state.bwip = bw.default ?? bw;
    if (typeof state.zxing.readBarcodes !== "function") {
      throw new Error("zxing-wasm: readBarcodes is missing");
    }
    if (!state.bwip || typeof state.bwip.toCanvas !== "function") {
      throw new Error("bwip-js: toCanvas is missing");
    }
    state.libsReady = true;
    els.libStatus.textContent = "Готово к работе";
    setConn(true, "ready");
  } catch (e) {
    console.error("library load failed", e);
    els.libStatus.textContent = "Ошибка загрузки библиотек: " + (e?.message ?? e);
    setConn(false, "lib error");
  }
}

function setConn(on, label) {
  els.connDot.className = "dot " + (on ? "dot-on" : "dot-off");
  els.connLabel.textContent = label;
}

// ── Camera ---------------------------------------------------
async function startCamera() {
  els.camError.textContent = "";
  if (!navigator.mediaDevices?.getUserMedia) {
    els.camError.textContent = "Браузер не поддерживает камеру.";
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    });
    state.stream = stream;
    state.track  = stream.getVideoTracks()[0];

    try {
      const caps = state.track.getCapabilities?.() ?? {};
      if (caps.focusMode?.includes?.("continuous")) {
        await state.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
      state.torchSupported = !!caps.torch;
      els.torch.hidden = !state.torchSupported;
    } catch { /* capability probing is optional */ }

    els.video.srcObject = stream;
    els.video.playsInline = true;
    els.video.muted = true;
    await els.video.play();
    return true;
  } catch (e) {
    const msg = e?.name === "NotAllowedError" ? "Доступ к камере запрещён." :
                e?.name === "NotFoundError"   ? "Камера не найдена." :
                (e?.message ?? String(e));
    els.camError.textContent = msg;
    return false;
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.track  = null;
  state.torchOn = false;
  els.torch.setAttribute("aria-pressed", "false");
}

async function toggleTorch() {
  if (!state.track || !state.torchSupported) return;
  try {
    const next = !state.torchOn;
    await state.track.applyConstraints({ advanced: [{ torch: next }] });
    state.torchOn = next;
    els.torch.setAttribute("aria-pressed", String(next));
  } catch (e) { console.warn("torch failed", e); }
}

// ── Wake lock -----------------------------------------------
async function acquireWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener?.("release", () => { state.wakeLock = null; });
  } catch { /* ignore */ }
}
async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch { /* noop */ }
  state.wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" &&
      (state.stateName === "SCANNING" || state.stateName === "DISPLAY_FOR_POS") &&
      !state.wakeLock) {
    acquireWakeLock();
  }
});

// ── Worker triage --------------------------------------------
function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return state.worker;
}

function triage(bitmap) {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const handler = (ev) => {
      const m = ev.data;
      if (m?.type === "triage:done" || m?.type === "triage:error") {
        w.removeEventListener("message", handler);
        m?.type === "triage:done" ? resolve(m) : reject(new Error(m.error));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ type: "triage", bitmap, ts: performance.now() }, [bitmap]);
  });
}

// ── Frame loop -----------------------------------------------
async function captureBitmap() {
  const v = els.video;
  if (!v?.videoWidth) return null;
  try {
    return await createImageBitmap(v, 0, 0, v.videoWidth, v.videoHeight);
  } catch { return null; }
}

function startFrameLoop() {
  cancelAnimationFrame(state.loopRaf);
  let lastTick = 0;
  const tick = async (t) => {
    state.loopRaf = requestAnimationFrame(tick);
    if (state.stateName === "IDLE" || state.stateName === "DISPLAY_FOR_POS") return;
    if (!state.libsReady) return;
    if (state.loopBusy) return;
    const interval = 1000 / state.fps;
    if (t - lastTick < interval) return;
    lastTick = t;

    state.loopBusy = true;
    try {
      const bmp = await captureBitmap();
      if (!bmp) return;
      const triagedRes = await triage(bmp);
      if (triagedRes.focus < CFG.minFocus) {
        flashHint("Не в фокусе — поднесите ближе");
        triagedRes.bitmap.close?.();
        return;
      }
      if (triagedRes.glare > CFG.maxGlare) {
        flashHint("Блики — измените угол");
        triagedRes.bitmap.close?.();
        return;
      }
      await processFrame(triagedRes);
    } catch (e) {
      console.warn("frame loop error", e);
    } finally {
      state.loopBusy = false;
    }
  };
  state.loopRaf = requestAnimationFrame(tick);

  // FPS counter
  clearInterval(state.fpsTimer);
  state.fpsTimer = setInterval(() => {
    els.fpsLabel.textContent = `${state.fpsCounter}fps`;
    state.fpsCounter = 0;
  }, 1000);
}

function stopFrameLoop() {
  cancelAnimationFrame(state.loopRaf);
  clearInterval(state.fpsTimer);
  state.loopRaf = 0;
}

// ── Pipeline: preprocessing ----------------------------------
/** Draw an ImageBitmap into our work canvas and return ImageData. */
function bitmapToImageData(bitmap, longEdge) {
  const w = bitmap.width, h = bitmap.height;
  const longest = Math.max(w, h);
  const scale = Math.min(1, longEdge / longest);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const c = els.workCanvas;
  c.width = dw; c.height = dh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

function imageDataToCanvas(img, c) {
  c.width = img.width; c.height = img.height;
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

/** RGBA → grayscale ImageData (still RGBA, but R=G=B=Y) */
function toGrayImageData(img) {
  const out = new ImageData(img.width, img.height);
  const s = img.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const y = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = y;
    d[i + 3] = 255;
  }
  return out;
}

function clone(img) {
  const out = new ImageData(img.width, img.height);
  out.data.set(img.data);
  return out;
}

/** linear contrast stretch from p2..p98 to 0..255 */
function contrastStretch(grayImg) {
  const w = grayImg.width, h = grayImg.height, d = grayImg.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = w * h;
  const lo = percentile(hist, total, 0.02);
  const hi = percentile(hist, total, 0.98);
  const span = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, ((i - lo) * 255 / span) | 0));
  const out = new ImageData(w, h);
  const o = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = lut[d[i]];
    o[i] = o[i + 1] = o[i + 2] = y; o[i + 3] = 255;
  }
  return out;
}
function percentile(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}

/** Otsu binarization */
function otsu(grayImg) {
  const d = grayImg.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = grayImg.width * grayImg.height;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; t = i; }
  }
  return threshold(grayImg, t);
}

function threshold(grayImg, t) {
  const out = new ImageData(grayImg.width, grayImg.height);
  const s = grayImg.data, o = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const v = s[i] >= t ? 255 : 0;
    o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
  }
  return out;
}

/** Adaptive (block-mean) threshold — Sauvola-lite. */
function adaptiveThreshold(grayImg, blockSize = 25, c = 7) {
  const w = grayImg.width, h = grayImg.height, s = grayImg.data;
  const out = new ImageData(w, h);
  const o = out.data;
  // build integral image of luminance for O(1) block sums
  const ii = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += s[(y * w + x) * 4];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + row;
    }
  }
  const r = blockSize >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = ii[(y1 + 1) * (w + 1) + (x1 + 1)]
                - ii[y0 * (w + 1) + (x1 + 1)]
                - ii[(y1 + 1) * (w + 1) + x0]
                + ii[y0 * (w + 1) + x0];
      const mean = sum / area;
      const v = s[(y * w + x) * 4] >= mean - c ? 255 : 0;
      const i = (y * w + x) * 4;
      o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
    }
  }
  return out;
}

/** Unsharp mask: out = clamp(2*src - blur). */
function unsharp(grayImg) {
  const w = grayImg.width, h = grayImg.height, s = grayImg.data;
  const blur = boxBlur(grayImg, 3);
  const out = new ImageData(w, h);
  const o = out.data, b = blur.data;
  for (let i = 0; i < s.length; i += 4) {
    const v = Math.max(0, Math.min(255, 2 * s[i] - b[i]));
    o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
  }
  return out;
}

function boxBlur(grayImg, radius = 3) {
  const w = grayImg.width, h = grayImg.height, s = grayImg.data;
  const tmp = new Uint8ClampedArray(w * h);
  // horizontal
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -radius; x <= radius; x++) acc += s[(row + clampIdx(x, w)) * 4];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (acc / (radius * 2 + 1)) | 0;
      acc -= s[(row + clampIdx(x - radius, w)) * 4];
      acc += s[(row + clampIdx(x + radius + 1, w)) * 4];
    }
  }
  const out = new ImageData(w, h);
  const o = out.data;
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[clampIdx(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      const v = (acc / (radius * 2 + 1)) | 0;
      const i = (y * w + x) * 4;
      o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
      acc -= tmp[clampIdx(y - radius, h) * w + x];
      acc += tmp[clampIdx(y + radius + 1, h) * w + x];
    }
  }
  return out;
}
function clampIdx(v, max) { return v < 0 ? 0 : v >= max ? max - 1 : v; }

/** Build the variant set; cheaper variants first. */
function buildVariants(rgbaImg) {
  const gray = toGrayImageData(rgbaImg);
  const variants = [];
  variants.push({ name: "raw",       img: rgbaImg });
  variants.push({ name: "gray",      img: gray });
  variants.push({ name: "stretch",   img: contrastStretch(gray) });
  variants.push({ name: "otsu",      img: otsu(gray) });
  variants.push({ name: "adaptive",  img: adaptiveThreshold(gray) });
  variants.push({ name: "unsharp",   img: unsharp(gray) });
  return variants;
}

// ── Pipeline: decode -----------------------------------------
async function decodeVariants(variants, deadlineMs) {
  for (const v of variants) {
    if (performance.now() > deadlineMs) return null;
    try {
      const c = imageDataToCanvas(v.img, els.workCanvas);
      const results = await state.zxing.readBarcodes(c, {
        formats: ["DataMatrix"],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        maxNumberOfSymbols: 1,
      });
      if (results && results.length) {
        const r = results[0];
        const bytes = bytesFromResult(r);
        if (bytes && bytes.length) {
          return { variantName: v.name, bytes, text: r.text ?? "", raw: r };
        }
      }
    } catch (e) {
      // zxing throws on some empty inputs — keep iterating
      console.debug("decode failed on", v.name, e?.message ?? e);
    }
  }
  return null;
}

function bytesFromResult(r) {
  if (r?.bytes && r.bytes.length) return new Uint8Array(r.bytes);
  if (r?.text) return new TextEncoder().encode(r.text);
  return null;
}

// ── GS1 parser («Честный ЗНАК») ------------------------------
const GS = 0x1d;
const FIXED_LEN = {
  "00":18,"01":14,"02":14,"03":14,"04":16,
  "11":6,"12":6,"13":6,"15":6,"16":6,"17":6,"20":2,
  "31":6,"32":6,"33":6,"34":6,"35":6,"36":6,
  "41":13,"91":4,"92":44,
};
const VAR_AIS = new Set([
  "10","21","22","240","250","30","37","90","93","94","95","96","97","98","99",
]);

function parseGS1(bytes) {
  const ais = {};
  const errors = [];
  if (!bytes?.length) return { ais, errors: ["empty"], structurallyValid: false };

  let buf = bytes;
  // strip leading AIM identifier
  const head = String.fromCharCode(...buf.slice(0, 3));
  if (head === "]d2" || head === "]C1") buf = buf.slice(3);
  if (buf[0] === GS) buf = buf.slice(1);

  let p = 0;
  while (p < buf.length) {
    if (buf[p] === GS) { p++; continue; }
    let ai = null, aiLen = 0;
    for (const L of [2, 3, 4]) {
      if (p + L > buf.length) continue;
      const cand = String.fromCharCode(...buf.slice(p, p + L));
      if (!/^\d+$/.test(cand)) continue;
      if (cand in FIXED_LEN || VAR_AIS.has(cand)) { ai = cand; aiLen = L; break; }
    }
    if (!ai) { errors.push(`unknown AI at ${p}`); break; }
    p += aiLen;
    if (FIXED_LEN[ai]) {
      const len = FIXED_LEN[ai];
      if (p + len > buf.length) { errors.push(`truncated AI ${ai}`); break; }
      ais[ai] = String.fromCharCode(...buf.slice(p, p + len));
      p += len;
    } else {
      let end = p;
      while (end < buf.length && buf[end] !== GS) end++;
      ais[ai] = String.fromCharCode(...buf.slice(p, end));
      p = end;
    }
  }
  const structurallyValid = Object.keys(ais).length > 0
                           && !errors.some(e => e.startsWith("truncated"));
  return { ais, errors, structurallyValid };
}

function isChestnyZnak(parsed) {
  const gtin = parsed.ais["01"];
  const sn   = parsed.ais["21"];
  return !!gtin && /^\d{14}$/.test(gtin) && !!sn && sn.length >= 1;
}

// ── Pipeline: regenerate + round-trip verify -----------------
/** Convert payload bytes → bwip-js text with FNC1 markers. */
function payloadToBwipText(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === GS) s += "^FNC1";
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += "^" + String(b).padStart(3, "0"); // bwip-js parsefnc decimal escape
  }
  return s;
}

async function regenerate(bytes) {
  if (!state.bwip) throw new Error("bwip not loaded");
  const c = els.regenCanvas;
  const text = payloadToBwipText(bytes);
  state.bwip.toCanvas(c, {
    bcid: "datamatrix",
    text,
    parsefnc: true,
    scale: 8,
    padding: 0,
    backgroundcolor: "FFFFFF",
    barcolor: "000000",
  });

  // round-trip verify by re-decoding the rendered canvas
  const verifyResults = await state.zxing.readBarcodes(c, {
    formats: ["DataMatrix"],
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    maxNumberOfSymbols: 1,
  });
  if (!verifyResults || !verifyResults.length) {
    return { ok: false, reason: "regen_unreadable" };
  }
  const got = bytesFromResult(verifyResults[0]);
  if (!bytesEqual(got, bytes)) {
    return { ok: false, reason: "regen_mismatch" };
  }
  return { ok: true, canvas: c };
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Confidence model -----------------------------------------
function scoreConfidence({ frames, variantName, gs1Valid, focus }) {
  const decoderNative = 0.85; // zxing-wasm general
  const variantPenalty = variantName === "raw" ? 1.0 : variantName === "gray" ? 0.95 : 0.9;
  const ecc = 0.7;
  const sharp = Math.max(0, Math.min(1, focus / 400));
  const agree = Math.max(0, Math.min(1, frames / 3));
  return (
    0.45 * decoderNative * variantPenalty +
    0.20 * ecc +
    0.15 * agree +
    0.10 * sharp +
    0.10 * (gs1Valid ? 1.0 : 0.3)
  );
}

// ── Pipeline: per-frame entry --------------------------------
async function processFrame(triagedRes) {
  state.framesProcessed++;
  state.fpsCounter++;
  els.framesLabel.textContent = `${state.framesProcessed}f`;

  const t0 = performance.now();
  const deadline = t0 + CFG.decodeBudgetMs;

  // bitmap → image data → variants
  const rgba = bitmapToImageData(triagedRes.bitmap, CFG.captureLongEdge);
  triagedRes.bitmap.close?.();
  const variants = buildVariants(rgba);
  const decoded = await decodeVariants(variants, deadline);
  const dt = performance.now() - t0;
  els.latencyLabel.textContent = `${dt | 0}ms`;

  if (!decoded) {
    if (state.stateName === "SCANNING") setState("SCANNING");
    return;
  }

  // GS1 validation (best-effort; we still accept non-CIS Data Matrix)
  const parsed = parseGS1(decoded.bytes);
  const gs1Valid = isChestnyZnak(parsed);

  // multi-frame agreement — payload must be confirmed by ≥ N frames
  const key = bytesToHex(decoded.bytes);
  const hits = (state.agreement.get(key) ?? 0) + 1;
  state.agreement.set(key, hits);
  state.framesAccepted++;

  const conf = scoreConfidence({
    frames: hits,
    variantName: decoded.variantName,
    gs1Valid,
    focus: triagedRes.focus,
  });
  setState("PROCESSING");
  els.confidence.textContent =
    `confidence ${Math.round(conf * 100)}%  ·  agreement ${hits}/${CFG.agreementCount}`;

  const enoughAgreement = hits >= CFG.agreementCount;
  const enoughConfidence = conf >= CFG.confidenceMin;
  if (!(enoughAgreement && enoughConfidence) && conf < 0.85) return;

  // attempt regeneration + round-trip verify
  let regen;
  try {
    regen = await regenerate(decoded.bytes);
  } catch (e) {
    flashHint("Не удалось пересобрать код");
    console.error("regen error", e);
    return;
  }
  if (!regen.ok) {
    flashHint("Регенерация: " + regen.reason);
    return;
  }

  // success
  state.bestPayload = decoded.bytes;
  state.bestConfidence = conf;
  state.bestDecodeMeta = {
    decoder: "zxing-wasm",
    pipeline: decoded.variantName,
    sharpness: triagedRes.focus | 0,
    gs1Valid,
    parsed,
    durationMs: dt | 0,
    framesAgree: hits,
  };
  state.bestRegen = { canvas: regen.canvas, payloadUtf8: tryUtf8(decoded.bytes) };
  showSuccess();
}

function bytesToHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function tryUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
  catch { return null; }
}

// ── Success / display ----------------------------------------
function showSuccess() {
  setState("SUCCESS");
  navigator.vibrate?.([60, 40, 60]);
  const meta = state.bestDecodeMeta;
  const ais = meta.parsed.ais;
  els.sheetConf.textContent = `${(state.bestConfidence * 100).toFixed(0)}%`;
  els.sheetMeta.innerHTML = "";
  const rows = [];
  if (ais["01"]) rows.push(["GTIN", ais["01"]]);
  if (ais["21"]) rows.push(["SN",   ais["21"]]);
  if (ais["91"]) rows.push(["91",   ais["91"]]);
  if (ais["92"]) rows.push(["92",   ais["92"]]);
  if (!rows.length) {
    rows.push(["Данные", state.bestRegen.payloadUtf8 || bytesToHex(state.bestPayload)]);
  }
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    els.sheetMeta.appendChild(dt); els.sheetMeta.appendChild(dd);
  }
  const foot = document.createElement("div");
  foot.className = "meta-foot";
  foot.textContent = `${meta.decoder} · ${meta.pipeline} · ${meta.framesAgree}f · ${meta.durationMs}ms`;
  els.sheetMeta.appendChild(foot);
}

function resetForRescan() {
  state.framesProcessed = 0;
  state.framesAccepted = 0;
  state.agreement.clear();
  state.bestPayload = null;
  state.bestConfidence = 0;
  state.bestDecodeMeta = null;
  state.bestRegen = null;
  els.framesLabel.textContent = "0f";
  els.latencyLabel.textContent = "";
  els.confidence.textContent = "";
  setState("SCANNING");
}

// ── POS display rendering -----------------------------------
async function openPosDisplay() {
  if (!state.bestRegen) return;
  setState("DISPLAY_FOR_POS");
  renderPosCanvas();
  // Best-effort fullscreen + orientation lock
  try {
    if (els.displayStage.requestFullscreen) await els.displayStage.requestFullscreen();
  } catch { /* iOS Safari does not allow */ }
  try { await screen.orientation?.lock?.("portrait"); } catch { /* not supported */ }
  await acquireWakeLock();
  flashHint("Поставьте максимальную яркость экрана", 2200);
}

async function closePosDisplay() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
  try { screen.orientation?.unlock?.(); } catch {}
  await releaseWakeLock();
  state.posBoost = false; state.posInverted = false;
  els.boostBtn.setAttribute("aria-pressed", "false");
  els.invertBtn.setAttribute("aria-pressed", "false");
  els.boostBtn.textContent = "Крупнее";
  els.invertBtn.textContent = "Инвертировать";
  setState("SCANNING");
}

function renderPosCanvas() {
  const src = state.bestRegen?.canvas;
  if (!src) return;
  const dpr = window.devicePixelRatio || 1;
  const cssMin = Math.min(window.innerWidth, window.innerHeight);
  const targetCss = Math.floor(cssMin * (state.posBoost ? 0.96 : 0.85));

  // bwip-js renders at scale=8 px-per-module by default; src.width is
  // (modules + 2*quietZone) * scale. We re-snap so each *src* pixel
  // is an integer number of *device* pixels — that avoids any
  // fractional scaling on the screen.
  const srcSide = src.width;
  const minDevPxPerSrcPx = state.posBoost ? 2 : 1;
  const factor = Math.max(minDevPxPerSrcPx, Math.floor((targetCss * dpr) / srcSide));
  const sideDev = srcSide * factor;
  const sideCss = sideDev / dpr;

  const c = els.dmCanvas;
  c.width = sideDev; c.height = sideDev;
  c.style.width  = `${sideCss}px`;
  c.style.height = `${sideCss}px`;

  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = state.posInverted ? "#000000" : "#FFFFFF";
  ctx.fillRect(0, 0, sideDev, sideDev);
  ctx.drawImage(src, 0, 0, srcSide, srcSide, 0, 0, sideDev, sideDev);
  if (state.posInverted) {
    const img = ctx.getImageData(0, 0, sideDev, sideDev);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(img, 0, 0);
  }
  els.displayPayload.textContent = state.bestRegen.payloadUtf8 ?? "";
}

window.addEventListener("resize", () => {
  if (state.stateName === "DISPLAY_FOR_POS") renderPosCanvas();
});

// ── Wire up DOM events ---------------------------------------
els.start.addEventListener("click", async () => {
  els.start.disabled = true;
  if (!state.libsReady) await loadLibs();
  const ok = await startCamera();
  if (!ok) { els.start.disabled = false; return; }
  setState("CAMERA_READY");
  await acquireWakeLock();
  setState("SCANNING");
  startFrameLoop();
  els.start.disabled = false;
});

els.torch.addEventListener("click", () => { void toggleTorch(); });

els.showBtn.addEventListener("click", () => { void openPosDisplay(); });
els.rescanBtn.addEventListener("click", resetForRescan);

els.closeDisplay.addEventListener("click", () => { void closePosDisplay(); });
els.boostBtn.addEventListener("click", () => {
  state.posBoost = !state.posBoost;
  els.boostBtn.setAttribute("aria-pressed", String(state.posBoost));
  els.boostBtn.textContent = state.posBoost ? "Норм. размер" : "Крупнее";
  renderPosCanvas();
});
els.invertBtn.addEventListener("click", () => {
  state.posInverted = !state.posInverted;
  els.invertBtn.setAttribute("aria-pressed", String(state.posInverted));
  els.invertBtn.textContent = state.posInverted ? "Норм. цвет" : "Инвертировать";
  renderPosCanvas();
});

// ── Service worker registration ------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("./sw.js", import.meta.url))
      .catch((e) => console.warn("SW register failed", e));
  });
}

// ── Boot -----------------------------------------------------
setState("IDLE");
loadLibs();
