const state = {
  sessionId: "",
  sessionCode: "",
  ws: null,
  role: "phone",
  seq: 0,
  localStream: null,
  pc: null,
  lastDirectiveSeq: 0,
  heartbeatTimer: null,
  pagerIndex: 0,
  sliderTouchStartX: 0,
  baristaCameraStream: null,
  modelVisible: false,
  voice: {
    active: false,
    pc: null,
    dc: null,
    micStream: null,
    deltaByItem: new Map(),
    triggeredKeys: new Set(),
    retryTimer: null,
    nextRetryAt: 0,
    lastModeToggleAt: 0
  },
  stereo: {
    active: false,
    rafId: 0,
    separationPx: 10,
    depthStrength: 8,
    depthGamma: 1.15,
    workCanvas: null,
    workCtx: null,
    outCanvas: null,
    outCtx: null,
    outImageData: null
  },
  scan: {
    active: false,
    tipIndex: 0,
    tipTimer: null,
    detectTimer: null,
    detected: false,
    progressTimer: null,
    progressPct: 0,
    manualReady: false,
    previewTimer: null,
    pdfReady: false,
    pdfDoc: null,
    tutorialStep: 0,
    lastRenderedPage: 0
  }
};

const KNOWN_COMMANDS = new Set([
  "left",
  "right",
  "back",
  "exit",
  "click",
  "barista",
  "eduar",
  "67",
  "scan",
  "next",
  "show 3d",
  "show 3 d",
  "show three d",
  "hide 3d",
  "hide 3 d",
  "hide three d",
  "change",
  "change mode"
]);
const SCAN_TIPS = [
  "Slowly rotate 360 deg so the camera can map the machine.",
  "Find and face the machine - do a slow 360 deg.",
  "Stand ~1-2 meters from the machine for best results."
];
const TUTORIAL_STEPS = [
  { page: 1, text: "How to make a black coffee", mode: "pdf" },
  { page: 6, text: "Prepare coffee and insert cups", mode: "pdf" },
  { page: 7, text: 'Set current Brew mode to "Constant Pressure"', mode: "pdf" },
  { page: 7, text: "Press the on button", mode: "pdf" },
  { text: "Manual complete", mode: "done" }
];

const els = {
  createSessionBtn: document.getElementById("createSessionBtn"),
  codeInput: document.getElementById("codeInput"),
  joinByCodeBtn: document.getElementById("joinByCodeBtn"),
  sessionInfo: document.getElementById("sessionInfo"),
  connectWsBtn: document.getElementById("connectWsBtn"),
  startMediaBtn: document.getElementById("startMediaBtn"),
  startRtcBtn: document.getElementById("startRtcBtn"),
  transportInfo: document.getElementById("transportInfo"),
  sendLandmarksBtn: document.getElementById("sendLandmarksBtn"),
  requestInferBtn: document.getElementById("requestInferBtn"),
  promptInput: document.getElementById("promptInput"),
  directiveOutput: document.getElementById("directiveOutput"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  clockDisplay: document.getElementById("clockDisplay"),
  baristaClock: document.getElementById("baristaClock"),
  baristaUi: document.getElementById("baristaUi"),
  stereoUiOverlay: document.getElementById("stereoUiOverlay"),
  stereoUiLeft: document.getElementById("stereoUiLeft"),
  stereoUiRight: document.getElementById("stereoUiRight"),
  appsSlider: document.getElementById("appsSlider"),
  appsTrack: document.querySelector(".apps-track"),
  appLaunchCard: document.getElementById("appLaunchCard"),
  appFullscreen: document.getElementById("appFullscreen"),
  baristaCameraVideo: document.getElementById("baristaCameraVideo"),
  controlDock: document.getElementById("controlDock"),
  listeningStatus: document.getElementById("listeningStatus"),
  liveTranscript: document.getElementById("liveTranscript"),
  voiceToggleBtn: document.getElementById("voiceToggleBtn"),
  voicePartialText: document.getElementById("voicePartialText"),
  voiceCommandText: document.getElementById("voiceCommandText"),
  voiceEventType: document.getElementById("voiceEventType"),
  voiceDebugLog: document.getElementById("voiceDebugLog"),
  stereoToggleBtn: document.getElementById("stereoToggleBtn"),
  stereoSeparationRange: document.getElementById("stereoSeparationRange"),
  stereoDepthRange: document.getElementById("stereoDepthRange"),
  stereoSeparationValue: document.getElementById("stereoSeparationValue"),
  stereoDepthValue: document.getElementById("stereoDepthValue"),
  stereoCanvas: document.getElementById("stereoCanvas")
};

function roleFromUI() {
  const selected = document.querySelector('input[name="role"]:checked');
  return selected ? selected.value : "phone";
}

function nextSeq() {
  state.seq += 1;
  return state.seq;
}

function wsSend(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  state.ws.send(JSON.stringify(message));
  return true;
}

function setTransportInfo(text) {
  els.transportInfo.textContent = text;
}

function updateSessionText(extra = "") {
  if (!state.sessionId) {
    els.sessionInfo.textContent = "No active session.";
    return;
  }
  const bits = [`Session ${state.sessionId}`, `Code ${state.sessionCode || "n/a"}`];
  if (extra) {
    bits.push(extra);
  }
  els.sessionInfo.textContent = bits.join(" | ");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function updateStereoControls() {
  if (els.stereoSeparationValue) {
    els.stereoSeparationValue.textContent = String(state.stereo.separationPx);
  }
  if (els.stereoDepthValue) {
    els.stereoDepthValue.textContent = String(state.stereo.depthStrength);
  }
  if (els.stereoToggleBtn) {
    els.stereoToggleBtn.textContent = state.stereo.active ? "Disable Stereo AR" : "Enable Stereo AR";
  }
  syncStereoUiShift();
}

function syncStereoUiShift() {
  if (!els.stereoUiOverlay) {
    return;
  }
  const shiftPx = Math.round(state.stereo.separationPx * 0.6);
  els.stereoUiOverlay.style.setProperty("--ui-shift-px", `${shiftPx}px`);
}

function applyModelVisibility() {
  document.querySelectorAll(".machine-model-panel").forEach((node) => {
    node.hidden = !state.modelVisible;
  });
}

function setModelVisible(enabled) {
  state.modelVisible = Boolean(enabled);
  applyModelVisibility();
}

function getTutorialStep() {
  const index = clamp(state.scan.tutorialStep, 0, TUTORIAL_STEPS.length - 1);
  return TUTORIAL_STEPS[index];
}

function isTutorialActive() {
  return state.scan.active && state.scan.manualReady && state.scan.pdfReady;
}

function setTutorialStep(nextIndex) {
  if (!isTutorialActive()) {
    return;
  }
  const clamped = clamp(nextIndex, 0, TUTORIAL_STEPS.length - 1);
  if (state.scan.tutorialStep === clamped) {
    return;
  }
  state.scan.tutorialStep = clamped;
  state.scan.lastRenderedPage = 0;
  applyScanOverlayState();
}

async function renderManualPdfPage(pageNumber) {
  if (!state.scan.pdfReady) {
    return;
  }
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    return;
  }
  if (!state.scan.pdfDoc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    state.scan.pdfDoc = await pdfjsLib.getDocument("/manual-wpm-primus%20instruction.pdf").promise;
  }
  const safePage = Math.max(1, Math.min(pageNumber, state.scan.pdfDoc.numPages || 1));
  const page = await state.scan.pdfDoc.getPage(safePage);
  const canvases = document.querySelectorAll(".manual-pdf-canvas");
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  for (const canvas of canvases) {
    const targetWidth = Math.max(220, Math.floor(canvas.clientWidth || 220));
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = (targetWidth * dpr) / baseViewport.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      continue;
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

function renderTutorialStep() {
  if (!isTutorialActive()) {
    return;
  }
  const step = getTutorialStep();
  const stepLabel = `STEP ${state.scan.tutorialStep + 1} OF ${TUTORIAL_STEPS.length}`;
  const showPdf = step.mode === "pdf";
  const showDone = step.mode === "done";

  document.querySelectorAll(".manual-step-index").forEach((node) => {
    node.textContent = stepLabel;
  });
  document.querySelectorAll(".manual-step-title").forEach((node) => {
    node.textContent = step.text;
  });
  document.querySelectorAll(".tutorial-floating-title").forEach((node) => {
    node.textContent = step.text;
  });
  document.querySelectorAll(".manual-pdf-canvas").forEach((node) => {
    node.hidden = !showPdf;
  });
  document.querySelectorAll(".manual-done-video").forEach((node) => {
    node.hidden = !showDone;
    if (showDone) {
      node.currentTime = 0;
      node.play().catch(() => {
        // Autoplay can be blocked in some browsers.
      });
    } else {
      node.pause();
    }
  });

  if (showPdf && state.scan.lastRenderedPage !== step.page) {
    state.scan.lastRenderedPage = step.page;
    renderManualPdfPage(step.page).catch(() => {
      // Keep UI stable even if PDF renderer is unavailable.
    });
  }
}

function updateScanTip() {
  const text = SCAN_TIPS[state.scan.tipIndex] || SCAN_TIPS[0];
  document.querySelectorAll(".scan-tip-text").forEach((node) => {
    node.textContent = text;
  });
}

function applyScanOverlayState() {
  document.querySelectorAll(".barista-ui").forEach((node) => {
    node.classList.toggle("scan-active", state.scan.active);
  });
  document.querySelectorAll(".scan-overlay").forEach((node) => {
    node.hidden = !state.scan.active || state.scan.detected;
  });
  document.querySelectorAll(".scan-result-card").forEach((node) => {
    node.hidden = !state.scan.active || !state.scan.detected || state.scan.manualReady;
  });
  document.querySelectorAll(".manual-found-card").forEach((node) => {
    node.hidden = !state.scan.active || !state.scan.manualReady;
  });
  document.querySelectorAll(".manual-preview-image").forEach((node) => {
    node.hidden = !state.scan.active || !state.scan.manualReady || state.scan.pdfReady;
  });
  const tutorialVisible = isTutorialActive();
  document.querySelectorAll(".manual-pdf-canvas").forEach((node) => {
    node.hidden = !tutorialVisible;
  });
  document.querySelectorAll(".manual-done-video").forEach((node) => {
    node.hidden = !tutorialVisible;
  });
  document.querySelectorAll(".tutorial-floating").forEach((node) => {
    node.hidden = !tutorialVisible;
  });
  if (tutorialVisible) {
    renderTutorialStep();
  }
  updateScanProgress();
  updateScanTip();
}

function updateScanProgress() {
  const pct = Math.max(0, Math.min(100, Math.round(state.scan.progressPct)));
  document.querySelectorAll(".result-progress span").forEach((node) => {
    node.style.width = `${pct}%`;
  });
}

function setScanMode(enabled) {
  const next = Boolean(enabled);
  const changed = state.scan.active !== next;
  state.scan.active = next;
  if (!state.scan.active) {
    if (state.scan.tipTimer) {
      clearInterval(state.scan.tipTimer);
      state.scan.tipTimer = null;
    }
    if (state.scan.detectTimer) {
      clearTimeout(state.scan.detectTimer);
      state.scan.detectTimer = null;
    }
    if (state.scan.progressTimer) {
      clearInterval(state.scan.progressTimer);
      state.scan.progressTimer = null;
    }
    if (state.scan.previewTimer) {
      clearTimeout(state.scan.previewTimer);
      state.scan.previewTimer = null;
    }
    state.scan.detected = false;
    state.scan.progressPct = 0;
    state.scan.manualReady = false;
    state.scan.pdfReady = false;
    state.scan.tipIndex = 0;
    state.scan.tutorialStep = 0;
    state.scan.lastRenderedPage = 0;
    applyScanOverlayState();
    return;
  }
  if (changed) {
    state.scan.detected = false;
    state.scan.progressPct = 0;
    state.scan.manualReady = false;
    state.scan.pdfReady = false;
    state.scan.pdfDoc = null;
    state.scan.tipIndex = 0;
    state.scan.tutorialStep = 0;
    state.scan.lastRenderedPage = 0;
  }
  if (!state.scan.tipTimer) {
    state.scan.tipTimer = setInterval(() => {
      state.scan.tipIndex = (state.scan.tipIndex + 1) % SCAN_TIPS.length;
      updateScanTip();
    }, 4200);
  }
  if (!state.scan.detectTimer) {
    state.scan.detectTimer = setTimeout(() => {
      state.scan.detected = true;
      state.scan.detectTimer = null;
      if (state.scan.tipTimer) {
        clearInterval(state.scan.tipTimer);
        state.scan.tipTimer = null;
      }
      if (!state.scan.progressTimer) {
        state.scan.progressTimer = setInterval(() => {
          if (!state.scan.active || !state.scan.detected) {
            clearInterval(state.scan.progressTimer);
            state.scan.progressTimer = null;
            return;
          }
          const step = Math.random() * 11 + 2;
          state.scan.progressPct = Math.min(100, state.scan.progressPct + step);
          updateScanProgress();
          if (state.scan.progressPct >= 100) {
            state.scan.manualReady = true;
            clearInterval(state.scan.progressTimer);
            state.scan.progressTimer = null;
            state.scan.pdfReady = false;
            if (state.scan.previewTimer) {
              clearTimeout(state.scan.previewTimer);
            }
            state.scan.previewTimer = setTimeout(() => {
              state.scan.pdfReady = true;
              state.scan.tutorialStep = 0;
              state.scan.lastRenderedPage = 0;
              state.scan.previewTimer = null;
              applyScanOverlayState();
            }, 1000);
            applyScanOverlayState();
          }
        }, 260);
      }
      applyScanOverlayState();
    }, 10000);
  }
  applyScanOverlayState();
}

function stripIds(root) {
  if (!root) {
    return;
  }
  if (root.id) {
    root.removeAttribute("id");
  }
  root.querySelectorAll("[id]").forEach((node) => {
    node.removeAttribute("id");
  });
}

function buildStereoUiMirrors() {
  if (!els.baristaUi || !els.stereoUiLeft || !els.stereoUiRight) {
    return;
  }
  if (els.stereoUiLeft.children.length || els.stereoUiRight.children.length) {
    return;
  }
  const leftClone = els.baristaUi.cloneNode(true);
  const rightClone = els.baristaUi.cloneNode(true);
  stripIds(leftClone);
  stripIds(rightClone);
  els.stereoUiLeft.appendChild(leftClone);
  els.stereoUiRight.appendChild(rightClone);
}

function ensureStereoBuffers() {
  // Adaptive HD-like resolution from current display size with a safe upper cap.
  const perEyeDisplayW = Math.max(2, Math.floor((els.stereoCanvas?.width || 2) / 2));
  const displayH = Math.max(2, Math.floor(els.stereoCanvas?.height || 2));
  const maxPixelsPerEye = 1280 * 720;
  const currentPixels = perEyeDisplayW * displayH;
  const scale = currentPixels > maxPixelsPerEye ? Math.sqrt(maxPixelsPerEye / currentPixels) : 1;
  const targetWorkWidth = Math.max(320, Math.floor(perEyeDisplayW * scale));
  const targetWorkHeight = Math.max(180, Math.floor(displayH * scale));
  const targetOutWidth = targetWorkWidth * 2;
  const targetOutHeight = targetWorkHeight;

  if (!state.stereo.workCanvas) {
    state.stereo.workCanvas = document.createElement("canvas");
    state.stereo.workCanvas.width = targetWorkWidth;
    state.stereo.workCanvas.height = targetWorkHeight;
    state.stereo.workCtx = state.stereo.workCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (
    state.stereo.workCanvas.width !== targetWorkWidth ||
    state.stereo.workCanvas.height !== targetWorkHeight
  ) {
    state.stereo.workCanvas.width = targetWorkWidth;
    state.stereo.workCanvas.height = targetWorkHeight;
  }

  if (!state.stereo.outCanvas) {
    state.stereo.outCanvas = document.createElement("canvas");
    state.stereo.outCanvas.width = targetOutWidth;
    state.stereo.outCanvas.height = targetOutHeight;
    state.stereo.outCtx = state.stereo.outCanvas.getContext("2d");
  }
  if (
    state.stereo.outCanvas.width !== targetOutWidth ||
    state.stereo.outCanvas.height !== targetOutHeight
  ) {
    state.stereo.outCanvas.width = targetOutWidth;
    state.stereo.outCanvas.height = targetOutHeight;
    state.stereo.outImageData = null;
  }
  if (!state.stereo.outImageData && state.stereo.outCtx) {
    state.stereo.outImageData = state.stereo.outCtx.createImageData(state.stereo.outCanvas.width, state.stereo.outCanvas.height);
  }
}

function renderStereoFrame() {
  if (!state.stereo.active || !els.stereoCanvas || !els.baristaCameraVideo) {
    return;
  }
  const video = els.baristaCameraVideo;
  if (video.readyState < 2) {
    state.stereo.rafId = requestAnimationFrame(renderStereoFrame);
    return;
  }
  ensureStereoBuffers();
  const workCtx = state.stereo.workCtx;
  const outCtx = state.stereo.outCtx;
  if (!workCtx || !outCtx || !state.stereo.outImageData) {
    return;
  }

  const workW = state.stereo.workCanvas.width;
  const workH = state.stereo.workCanvas.height;
  const outW = state.stereo.outCanvas.width;
  const outData = state.stereo.outImageData.data;

  workCtx.drawImage(video, 0, 0, workW, workH);
  const source = workCtx.getImageData(0, 0, workW, workH).data;

  const separation = state.stereo.separationPx;
  const depthStrength = state.stereo.depthStrength;
  const gamma = state.stereo.depthGamma;

  for (let y = 0; y < workH; y += 1) {
    for (let x = 0; x < workW; x += 1) {
      const idx = (y * workW + x) * 4;
      const r = source[idx];
      const g = source[idx + 1];
      const b = source[idx + 2];
      const luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      const depth = Math.pow(luma, gamma);
      const disp = Math.round((depth - 0.5) * depthStrength);

      const srcLeftX = clamp(x + disp - separation, 0, workW - 1);
      const srcRightX = clamp(x - disp + separation, 0, workW - 1);

      const leftSrcIdx = (y * workW + srcLeftX) * 4;
      const rightSrcIdx = (y * workW + srcRightX) * 4;
      const leftOutIdx = (y * outW + x) * 4;
      const rightOutIdx = (y * outW + x + workW) * 4;

      outData[leftOutIdx] = source[leftSrcIdx];
      outData[leftOutIdx + 1] = source[leftSrcIdx + 1];
      outData[leftOutIdx + 2] = source[leftSrcIdx + 2];
      outData[leftOutIdx + 3] = 255;

      outData[rightOutIdx] = source[rightSrcIdx];
      outData[rightOutIdx + 1] = source[rightSrcIdx + 1];
      outData[rightOutIdx + 2] = source[rightSrcIdx + 2];
      outData[rightOutIdx + 3] = 255;
    }
  }

  outCtx.putImageData(state.stereo.outImageData, 0, 0);
  const targetCtx = els.stereoCanvas.getContext("2d");
  if (targetCtx) {
    const displayW = els.stereoCanvas.width || 2;
    const displayH = els.stereoCanvas.height || 2;
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = "high";
    targetCtx.clearRect(0, 0, displayW, displayH);
    targetCtx.drawImage(state.stereo.outCanvas, 0, 0, displayW, displayH);
  }

  state.stereo.rafId = requestAnimationFrame(renderStereoFrame);
}

function resizeStereoCanvas() {
  if (!els.stereoCanvas || !els.appFullscreen) {
    return;
  }
  const bounds = els.appFullscreen.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  const nextW = Math.max(2, Math.floor(bounds.width * dpr));
  const nextH = Math.max(2, Math.floor(bounds.height * dpr));
  if (els.stereoCanvas.width !== nextW) {
    els.stereoCanvas.width = nextW;
  }
  if (els.stereoCanvas.height !== nextH) {
    els.stereoCanvas.height = nextH;
  }
}

function setStereoEnabled(enabled) {
  const shouldEnable = Boolean(enabled);
  if (state.stereo.active === shouldEnable) {
    return;
  }
  state.stereo.active = shouldEnable;
  if (state.stereo.active) {
    resizeStereoCanvas();
    buildStereoUiMirrors();
    setScanMode(state.scan.active);
    if (els.stereoCanvas) {
      els.stereoCanvas.hidden = false;
    }
    if (els.baristaUi) {
      els.baristaUi.hidden = true;
    }
    if (els.stereoUiOverlay) {
      els.stereoUiOverlay.hidden = false;
    }
    state.stereo.rafId = requestAnimationFrame(renderStereoFrame);
    setTransportInfo("Stereo AR filter enabled (side-by-side).");
  } else {
    if (state.stereo.rafId) {
      cancelAnimationFrame(state.stereo.rafId);
      state.stereo.rafId = 0;
    }
    if (els.stereoCanvas) {
      const ctx = els.stereoCanvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, els.stereoCanvas.width || 0, els.stereoCanvas.height || 0);
      }
      els.stereoCanvas.hidden = true;
    }
    if (els.stereoUiOverlay) {
      els.stereoUiOverlay.hidden = true;
    }
    if (els.baristaUi) {
      els.baristaUi.hidden = false;
    }
    setTransportInfo("Stereo AR filter disabled.");
  }
  updateStereoControls();
}

function setPagerIndex(index) {
  const dots = document.querySelectorAll(".pager .dot");
  if (!dots.length) {
    return;
  }
  const max = dots.length - 1;
  const clamped = Math.max(0, Math.min(index, max));
  state.pagerIndex = clamped;
  dots.forEach((dot, i) => {
    dot.classList.toggle("active", i === clamped);
  });
  if (els.appsTrack) {
    els.appsTrack.style.transform = `translateX(-${clamped * 100}%)`;
  }
}

function normalizeTranscript(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function resolveVoiceCommand(rawText) {
  const normalized = normalizeTranscript(rawText);
  if (!normalized) {
    return "";
  }
  if (KNOWN_COMMANDS.has(normalized)) {
    return normalized;
  }
  const collapsed = normalized.replace(/\s+/g, "");
  if (collapsed.includes("barista")) {
    return "barista";
  }
  if (collapsed.includes("eduar")) {
    return "eduar";
  }
  if (normalized.includes("67") || normalized.includes("sixty seven")) {
    return "67";
  }
  if (normalized.includes("show 3d") || normalized.includes("show 3 d") || normalized.includes("show three d")) {
    return "show 3d";
  }
  if (normalized.includes("hide 3d") || normalized.includes("hide 3 d") || normalized.includes("hide three d")) {
    return "hide 3d";
  }
  if (normalized === "scan") {
    return "scan";
  }
  if (normalized === "next") {
    return "next";
  }
  if (normalized.includes("change mode")) {
    return "change";
  }
  if (normalized.split(" ").includes("change")) {
    return "change";
  }
  return "";
}

async function createSession() {
  const res = await fetch("/api/session/new", { method: "POST" });
  const data = await res.json();
  state.sessionId = data.session.id;
  state.sessionCode = data.session.code;
  updateSessionText("created");
}

async function findSessionByCode() {
  const code = (els.codeInput.value || "").trim();
  if (!code) {
    return;
  }
  const res = await fetch(`/api/session/by-code/${encodeURIComponent(code)}`, { method: "POST" });
  if (!res.ok) {
    updateSessionText("code not found");
    return;
  }
  const data = await res.json();
  state.sessionId = data.session.id;
  state.sessionCode = data.session.code;
  updateSessionText("resolved from code");
}

function connectWebSocket() {
  if (!state.sessionId) {
    setTransportInfo("Create/find session first.");
    return;
  }
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    state.ws.close();
  }
  state.role = roleFromUI();
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    wsSend({
      type: "join",
      sessionId: state.sessionId,
      role: state.role
    });
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
    }
    state.heartbeatTimer = setInterval(() => {
      wsSend({ type: "heartbeat", ts: Date.now(), seq: nextSeq() });
    }, 3000);
    setTransportInfo(`WS connected as ${state.role}`);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "joined") {
      updateSessionText(`joined as ${msg.role}`);
      return;
    }
    if (msg.type === "pair_state") {
      const s = msg.session;
      updateSessionText(`pair: phone=${s.devices.phone}, tablet=${s.devices.tablet}`);
      return;
    }
    if (msg.type === "directive") {
      if (Number(msg.seq || 0) < state.lastDirectiveSeq) {
        return;
      }
      state.lastDirectiveSeq = Number(msg.seq || 0);
      els.directiveOutput.textContent = JSON.stringify(msg, null, 2);
      return;
    }
    if (msg.type === "webrtc_offer") {
      await ensurePeerConnection();
      await state.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      wsSend({ type: "webrtc_answer", payload: state.pc.localDescription });
      return;
    }
    if (msg.type === "webrtc_answer") {
      if (!state.pc) {
        return;
      }
      await state.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      return;
    }
    if (msg.type === "webrtc_ice") {
      if (!state.pc || !msg.payload) {
        return;
      }
      try {
        await state.pc.addIceCandidate(msg.payload);
      } catch {
        // Ignore race conditions before remote description exists.
      }
      return;
    }
    if (msg.type === "error") {
      setTransportInfo(`WS error: ${msg.code}`);
    }
  };

  ws.onclose = () => {
    setTransportInfo("WS disconnected");
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  };
}

async function startLocalMedia() {
  if (state.localStream) {
    return;
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  els.localVideo.srcObject = state.localStream;
  setTransportInfo("Local camera active");
}

async function ensurePeerConnection() {
  if (state.pc) {
    return;
  }
  state.pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  state.pc.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (stream) {
      els.remoteVideo.srcObject = stream;
    }
  };
  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      wsSend({ type: "webrtc_ice", payload: event.candidate });
    }
  };

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      state.pc.addTrack(track, state.localStream);
    }
  }
}

async function startWebRtc() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setTransportInfo("Connect WS first.");
    return;
  }
  await startLocalMedia();
  await ensurePeerConnection();
  const offer = await state.pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: false
  });
  await state.pc.setLocalDescription(offer);
  wsSend({ type: "webrtc_offer", payload: state.pc.localDescription });
  setTransportInfo("WebRTC offer sent");
}

function sendMockLandmarks() {
  const message = {
    type: "landmarks",
    seq: nextSeq(),
    ts: Date.now(),
    payload: {
      hand: [{ x: Math.random(), y: Math.random(), z: Math.random() }],
      pose: [{ x: Math.random(), y: Math.random(), z: Math.random() }]
    }
  };
  wsSend(message);
}

function requestInference() {
  const message = {
    type: "infer",
    seq: nextSeq(),
    ts: Date.now(),
    prompt: (els.promptInput.value || "").trim() || "Identify useful AR overlays for this scene.",
    frameMeta: {
      width: els.localVideo.videoWidth || 1280,
      height: els.localVideo.videoHeight || 720,
      role: state.role
    }
  };
  wsSend(message);
}

function setListeningStatus(text) {
  if (els.listeningStatus) {
    els.listeningStatus.textContent = text;
  }
}

function setVoicePartial(text) {
  if (els.voicePartialText) {
    els.voicePartialText.textContent = `Partial: ${text || "-"}`;
  }
}

function setLastCommand(command) {
  if (els.voiceCommandText) {
    els.voiceCommandText.textContent = `Last command: ${command || "none"}`;
  }
}

function setLiveTranscript(text) {
  if (els.liveTranscript) {
    els.liveTranscript.textContent = text || "No voice transcript yet";
  }
}

function setVoiceEventType(type) {
  if (els.voiceEventType) {
    els.voiceEventType.textContent = `Last event: ${type || "-"}`;
  }
}

function appendVoiceDebug(line) {
  if (!els.voiceDebugLog) {
    return;
  }
  const current = els.voiceDebugLog.textContent === "No voice events logged yet." ? "" : els.voiceDebugLog.textContent;
  const lines = current ? current.split("\n") : [];
  lines.push(line);
  const clipped = lines.slice(-12).join("\n");
  els.voiceDebugLog.textContent = clipped || "No voice events logged yet.";
}

function extractEventText(event) {
  const candidates = [];
  if (typeof event.delta === "string") {
    candidates.push(event.delta);
  } else if (typeof event.delta?.text === "string") {
    candidates.push(event.delta.text);
  }
  if (typeof event.transcript === "string") {
    candidates.push(event.transcript);
  }
  if (typeof event.text === "string") {
    candidates.push(event.text);
  }
  if (typeof event.output_text === "string") {
    candidates.push(event.output_text);
  }
  return candidates.find((v) => normalizeTranscript(v).length > 0) || "";
}

function triggerVoiceCommand(command) {
  console.log("[voice-command]", command);
  setLastCommand(command);
  if (command === "left") {
    setPagerIndex(state.pagerIndex - 1);
    return;
  }
  if (command === "right") {
    setPagerIndex(state.pagerIndex + 1);
    return;
  }
  if (command === "back") {
    if (isTutorialActive()) {
      setTutorialStep(state.scan.tutorialStep - 1);
      return;
    }
    if (els.controlDock?.open) {
      els.controlDock.open = false;
      return;
    }
    setPagerIndex(state.pagerIndex - 1);
    return;
  }
  if (command === "next") {
    if (isTutorialActive()) {
      setTutorialStep(state.scan.tutorialStep + 1);
    }
    return;
  }
  if (command === "exit") {
    if (els.appFullscreen && !els.appFullscreen.hidden) {
      closeBaristaApp();
      return;
    }
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {
        // Ignore fullscreen exit errors.
      });
    }
    if (els.controlDock) {
      els.controlDock.open = false;
    }
    return;
  }
  if (command === "click") {
    els.appLaunchCard?.click();
    return;
  }
  if (command === "barista") {
    launchApp("barista-panas");
    return;
  }
  if (command === "eduar") {
    launchApp("eduar");
    return;
  }
  if (command === "67") {
    launchApp("67");
    return;
  }
  if (command === "show 3d") {
    setModelVisible(true);
    return;
  }
  if (command === "hide 3d") {
    setModelVisible(false);
    return;
  }
  if (command === "scan") {
    setScanMode(true);
    return;
  }
  if (command === "change") {
    const nowMs = Date.now();
    if (nowMs - state.voice.lastModeToggleAt < 1400) {
      return;
    }
    state.voice.lastModeToggleAt = nowMs;
    setStereoEnabled(!state.stereo.active);
  }
}

function maybeTriggerCommand(rawText, itemId) {
  const command = resolveVoiceCommand(rawText);
  if (!command) {
    return;
  }
  const key = `${itemId || "global"}:${command}`;
  if (state.voice.triggeredKeys.has(key)) {
    return;
  }
  state.voice.triggeredKeys.add(key);
  triggerVoiceCommand(command);
}

function handleRealtimeTranscriptEvent(event) {
  setVoiceEventType(event.type || "unknown");
  const preview = extractEventText(event);
  appendVoiceDebug(`${event.type || "unknown"}${preview ? ` | ${preview}` : ""}`);

  if (event.type === "input_audio_buffer.speech_started") {
    setListeningStatus("Listening...");
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    setListeningStatus("Processing...");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const itemId = event.item_id || "unknown";
    const delta = String(event.delta || "");
    const prev = state.voice.deltaByItem.get(itemId) || "";
    const partial = `${prev}${delta}`;
    state.voice.deltaByItem.set(itemId, partial);
    const normalizedPartial = normalizeTranscript(partial);
    setVoicePartial(normalizedPartial || "-");
    setLiveTranscript(normalizedPartial || "-");
    console.log("[voice-delta]", normalizedPartial || delta);
    maybeTriggerCommand(delta, itemId);
    maybeTriggerCommand(partial, itemId);
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const itemId = event.item_id || "unknown";
    const transcript = String(event.transcript || "");
    state.voice.deltaByItem.delete(itemId);
    for (const key of state.voice.triggeredKeys) {
      if (key.startsWith(`${itemId}:`)) {
        state.voice.triggeredKeys.delete(key);
      }
    }
    setVoicePartial("-");
    setLiveTranscript(normalizeTranscript(transcript) || transcript || "-");
    console.log("[voice-completed]", transcript);
    maybeTriggerCommand(transcript, itemId);
    setListeningStatus("Listening...");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.failed") {
    const errMessage =
      String(
        event.error?.message ||
          event.error?.code ||
          event.error?.type ||
          event.reason ||
          "unknown transcription error"
      ) || "unknown transcription error";
    setListeningStatus("Transcript failed");
    setVoicePartial("-");
    appendVoiceDebug(`transcription-failed | ${errMessage}`);
    setTransportInfo(`Voice transcription failed: ${errMessage}`);
    return;
  }

  // Fallback for Realtime variants that stream transcript on response events.
  if (event.type === "response.audio_transcript.delta" || event.type === "response.output_text.delta") {
    const deltaText = extractEventText(event);
    const normalized = normalizeTranscript(deltaText);
    if (normalized) {
      setVoicePartial(normalized);
      setLiveTranscript(normalized);
      maybeTriggerCommand(normalized, event.response_id || "response");
    }
    return;
  }

  if (event.type === "response.audio_transcript.done" || event.type === "response.output_text.done") {
    const finalText = extractEventText(event);
    const normalized = normalizeTranscript(finalText);
    if (normalized) {
      setLiveTranscript(normalized);
      maybeTriggerCommand(normalized, event.response_id || "response");
    }
    setVoicePartial("-");
    setListeningStatus("Listening...");
  }
}

function extractClientSecret(data) {
  if (!data) {
    return "";
  }
  if (typeof data.client_secret === "string") {
    return data.client_secret;
  }
  if (typeof data.client_secret?.value === "string") {
    return data.client_secret.value;
  }
  if (typeof data.value === "string") {
    return data.value;
  }
  return "";
}

async function stopVoiceCommands() {
  state.voice.active = false;
  state.voice.deltaByItem.clear();
  state.voice.triggeredKeys.clear();
  setVoicePartial("-");
  setLiveTranscript("No voice transcript yet");
  setListeningStatus("Voice idle");
  setVoiceEventType("-");
  if (els.voiceDebugLog) {
    els.voiceDebugLog.textContent = "No voice events logged yet.";
  }
  if (els.voiceToggleBtn) {
    els.voiceToggleBtn.textContent = "Reconnect voice";
  }
  if (state.voice.dc) {
    state.voice.dc.close();
    state.voice.dc = null;
  }
  if (state.voice.pc) {
    state.voice.pc.close();
    state.voice.pc = null;
  }
  if (state.voice.micStream) {
    state.voice.micStream.getTracks().forEach((track) => track.stop());
    state.voice.micStream = null;
  }
}

async function startVoiceCommands() {
  if (state.voice.active) {
    return;
  }

  const secretRes = await fetch("/api/realtime/transcription/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "en" })
  });
  if (!secretRes.ok) {
    const failure = await secretRes.text();
    throw new Error(`Client secret failed: ${failure}`);
  }
  const secretData = await secretRes.json();
  const clientSecret = extractClientSecret(secretData);
  if (!clientSecret) {
    throw new Error("No ephemeral client secret returned by server.");
  }

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true
    },
    video: false
  });

  const pc = new RTCPeerConnection();
  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (evt) => {
    try {
      const message = JSON.parse(evt.data);
      handleRealtimeTranscriptEvent(message);
    } catch {
      // Ignore non-JSON events.
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });
  if (!sdpRes.ok) {
    const failure = await sdpRes.text();
    throw new Error(`Realtime SDP failed: ${failure}`);
  }
  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({
    type: "answer",
    sdp: answerSdp
  });

  state.voice.active = true;
  state.voice.pc = pc;
  state.voice.dc = dc;
  state.voice.micStream = micStream;
  setListeningStatus("Listening...");
  if (els.voiceToggleBtn) {
    els.voiceToggleBtn.textContent = "Reconnect voice";
  }

  dc.onopen = () => {
    setTransportInfo("Voice command transcription active.");
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
      stopVoiceCommands().catch(() => {
        // Ignore cleanup errors during connection transitions.
      });
    }
  };
}

async function ensureVoiceCommands() {
  const nowMs = Date.now();
  if (state.voice.active || nowMs < state.voice.nextRetryAt) {
    return;
  }
  try {
    await startVoiceCommands();
    state.voice.nextRetryAt = 0;
  } catch (err) {
    setListeningStatus("Voice unavailable");
    setTransportInfo(`Voice failed: ${err.message}`);
    await stopVoiceCommands();
    state.voice.nextRetryAt = Date.now() + 15000;
  }
}

function refreshClock() {
  const dt = new Date();
  const hours = String(dt.getHours()).padStart(2, "0");
  const mins = String(dt.getMinutes()).padStart(2, "0");
  const hhmm = `${hours}:${mins}`;
  if (els.clockDisplay) {
    els.clockDisplay.textContent = hhmm;
  }
  document.querySelectorAll(".barista-clock").forEach((node) => {
    node.textContent = hhmm;
  });
}

async function requestVideoFullscreen(videoEl) {
  if (!videoEl) {
    return;
  }
  try {
    if (document.fullscreenElement === videoEl && document.exitFullscreen) {
      await document.exitFullscreen();
      return;
    }
    if (videoEl.requestFullscreen) {
      await videoEl.requestFullscreen();
      return;
    }
    if (videoEl.webkitRequestFullscreen) {
      videoEl.webkitRequestFullscreen();
      return;
    }
    if (videoEl.webkitEnterFullscreen) {
      videoEl.webkitEnterFullscreen();
      return;
    }
    setTransportInfo("Fullscreen not supported on this device/browser.");
  } catch (err) {
    setTransportInfo(`Fullscreen failed: ${err.message}`);
  }
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No-op in local dev if service worker registration fails.
    });
  }
}

function hydrateFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  if (session) {
    state.sessionId = session;
    updateSessionText("from URL");
  }
}

async function openFullscreenLayer(el) {
  if (!el || !el.requestFullscreen || document.fullscreenElement) {
    return;
  }
  try {
    await el.requestFullscreen();
  } catch {
    // Ignore fullscreen permission failures.
  }
}

async function startBaristaCamera() {
  if (state.baristaCameraStream) {
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  });
  state.baristaCameraStream = stream;
  if (els.baristaCameraVideo) {
    els.baristaCameraVideo.srcObject = stream;
    if (els.baristaCameraVideo.readyState >= 1) {
      resizeStereoCanvas();
    } else {
      els.baristaCameraVideo.addEventListener("loadedmetadata", resizeStereoCanvas, { once: true });
    }
  }
}

function stopBaristaCamera() {
  if (!state.baristaCameraStream) {
    return;
  }
  state.baristaCameraStream.getTracks().forEach((track) => track.stop());
  state.baristaCameraStream = null;
  if (els.baristaCameraVideo) {
    els.baristaCameraVideo.srcObject = null;
  }
}

function closeBaristaApp() {
  if (!els.appFullscreen) {
    return;
  }
  if (document.fullscreenElement === els.appFullscreen && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
      // Ignore fullscreen exit errors.
    });
  }
  els.appFullscreen.hidden = true;
  setModelVisible(false);
  setScanMode(false);
  setStereoEnabled(false);
  stopBaristaCamera();
}

function launchPlaceholder(name) {
  setTransportInfo(`${name} placeholder app opened.`);
}

async function launchApp(appId) {
  if (appId === "barista-panas") {
    if (!els.appFullscreen) {
      return;
    }
    els.appFullscreen.hidden = false;
    await openFullscreenLayer(els.appFullscreen);
    try {
      // Always start in pre-scan state for the Barista flow.
      setModelVisible(false);
      setScanMode(false);
      await startBaristaCamera();
      setStereoEnabled(true);
      setTransportInfo("Barista Panas opened with back camera.");
    } catch (err) {
      setTransportInfo(`Barista Panas camera failed: ${err.message}`);
    }
    return;
  }
  if (appId === "eduar") {
    launchPlaceholder("EduAR");
    return;
  }
  if (appId === "67") {
    launchPlaceholder("67");
  }
}

els.createSessionBtn.addEventListener("click", () => {
  createSession().catch((err) => {
    setTransportInfo(`Create failed: ${err.message}`);
  });
});

els.joinByCodeBtn.addEventListener("click", () => {
  findSessionByCode().catch((err) => {
    setTransportInfo(`Lookup failed: ${err.message}`);
  });
});

els.connectWsBtn.addEventListener("click", connectWebSocket);
els.startMediaBtn.addEventListener("click", () => {
  startLocalMedia().catch((err) => {
    setTransportInfo(`Camera failed: ${err.message}`);
  });
});
els.startRtcBtn.addEventListener("click", () => {
  startWebRtc().catch((err) => {
    setTransportInfo(`WebRTC failed: ${err.message}`);
  });
});
els.sendLandmarksBtn.addEventListener("click", sendMockLandmarks);
els.requestInferBtn.addEventListener("click", requestInference);
els.localVideo.addEventListener("click", () => {
  requestVideoFullscreen(els.localVideo);
});
els.remoteVideo.addEventListener("click", () => {
  requestVideoFullscreen(els.remoteVideo);
});
document.querySelectorAll(".app-card").forEach((card) => {
  card.addEventListener("click", () => {
    const appId = card.dataset.app || "";
    launchApp(appId).catch((err) => {
      setTransportInfo(`App launch failed: ${err.message}`);
    });
  });
});
els.voiceToggleBtn?.addEventListener("click", () => {
  state.voice.nextRetryAt = 0;
  ensureVoiceCommands().catch((err) => {
    setTransportInfo(`Voice reconnect failed: ${err.message}`);
  });
});
els.stereoToggleBtn?.addEventListener("click", () => {
  setStereoEnabled(!state.stereo.active);
});
els.stereoSeparationRange?.addEventListener("input", (event) => {
  const value = Number(event.target?.value || 0);
  state.stereo.separationPx = clamp(Math.round(value), 0, 32);
  updateStereoControls();
});
els.stereoDepthRange?.addEventListener("input", (event) => {
  const value = Number(event.target?.value || 0);
  state.stereo.depthStrength = clamp(Math.round(value), 0, 24);
  updateStereoControls();
});
els.appsSlider?.addEventListener("touchstart", (event) => {
  state.sliderTouchStartX = Number(event.touches?.[0]?.clientX || 0);
});
els.appsSlider?.addEventListener("touchend", (event) => {
  const endX = Number(event.changedTouches?.[0]?.clientX || 0);
  const delta = endX - state.sliderTouchStartX;
  if (Math.abs(delta) < 26) {
    return;
  }
  if (delta < 0) {
    setPagerIndex(state.pagerIndex + 1);
    return;
  }
  setPagerIndex(state.pagerIndex - 1);
});

hydrateFromQuery();
registerServiceWorker();
setPagerIndex(0);
setListeningStatus("Voice idle");
setVoicePartial("-");
setLiveTranscript("No voice transcript yet");
setLastCommand("");
setVoiceEventType("-");
if (els.stereoSeparationRange) {
  els.stereoSeparationRange.value = String(state.stereo.separationPx);
}
if (els.stereoDepthRange) {
  els.stereoDepthRange.value = String(state.stereo.depthStrength);
}
updateStereoControls();
setScanMode(false);
setModelVisible(false);
if (els.voiceDebugLog) {
  els.voiceDebugLog.textContent = "No voice events logged yet.";
}
if (state.voice.retryTimer) {
  clearInterval(state.voice.retryTimer);
}
ensureVoiceCommands().catch(() => {
  // Retry loop below keeps voice alive.
});
state.voice.retryTimer = setInterval(() => {
  ensureVoiceCommands().catch(() => {
    // Keep silent; status text already updates on failures.
  });
}, 4000);
refreshClock();
setInterval(refreshClock, 30000);
window.addEventListener("resize", resizeStereoCanvas);
window.addEventListener("beforeunload", () => {
  if (state.voice.retryTimer) {
    clearInterval(state.voice.retryTimer);
    state.voice.retryTimer = null;
  }
  setScanMode(false);
  setModelVisible(false);
  setStereoEnabled(false);
  stopVoiceCommands().catch(() => {
    // Ignore cleanup errors during unload.
  });
  stopBaristaCamera();
});
