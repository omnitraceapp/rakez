import {
    FaceLandmarker,
    FilesetResolver
} from "../vendor/mediapipe/vision_bundle.mjs";

// ─── DOM ELEMENTS (all optional — guarded everywhere) ───────────────────────────
const video          = document.getElementById("webcam");
const statusText     = document.getElementById("status-text");
const dot            = document.querySelector(".dot");
const presenceStatus = document.getElementById("presence-status");
const fpsCounter     = document.getElementById("fps-counter");
const gazeStatusEl   = document.getElementById("gaze-status");

const nudgeToast   = document.getElementById("nudge-toast");
const nudgeIcon    = document.getElementById("nudge-icon");
const nudgeMessage = document.getElementById("nudge-message");

// If there is no camera surface on this page, do nothing.
if (video) initTracker();

function initTracker() {

// ─── STATE ─────────────────────────────────────────────────────────────────────
let faceLandmarker;
let webcamRunning = false;
let lastVideoTime = -1;
let metricsInterval = null;
let pipWindow = null; // always-on-top Document Picture-in-Picture window, when popped out

// FPS
let lastFpsUpdate = Date.now(), frameCount = 0;

// Session
let sessionStartTime = null;

// Look-away (alert timing) + observed-time accounting
let lookAwayStartTime = null, lookAwayAlerted = false;
let presentMs = 0, awayMs = 0, lastFrameT = 0; // only time the camera ACTUALLY saw frames
const LOOK_AWAY_THRESHOLD_MS = 3000;
const YAW_THRESHOLD   = 25;
const PITCH_THRESHOLD = 20;

// Alert counter
let lookAwayAlertCount = 0;

// Posture tracking
let postureTrackingEnabled = false;
const SLOUCH_THRESHOLD = 0.45; // If face height takes up >45% of frame vertically
let slouchStartTime = null;
let slouchAlerted = false;

// Nudge cooldown
let lastNudgeTime = 0;
const NUDGE_COOLDOWN_MS = 10000;
let nudgeTimeout = null;

// ─── SMALL DOM HELPERS ──────────────────────────────────────────────────────────
function setStatus(text) { if (statusText) statusText.textContent = text; }
function setChip(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.className = "chip-value" + (cls ? " " + cls : "");
}

// ─── INITIALIZATION ────────────────────────────────────────────────────────────
async function initialize() {
    setStatus("Loading Face AI…");

    const filesetResolver = await FilesetResolver.forVisionTasks(
        chrome.runtime.getURL("vendor/mediapipe/wasm")
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: chrome.runtime.getURL("assets/models/face_landmarker.task"),
            delegate: "GPU"
        },
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });

    setStatus("AI Ready");
    if (dot) dot.classList.add("active");
}

// ─── TRACKING CONTROL (driven by session state, no button) ──────────────────────
function startTracking() {
    if (!faceLandmarker || webcamRunning) return;
    webcamRunning = true;
    resetSession();
    startCamera();
    persistMetrics();
    metricsInterval = setInterval(persistMetrics, 5000);
}

function stopTracking() {
    if (!webcamRunning) return;
    webcamRunning = false;
    if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
    persistMetrics(); // final snapshot
    stopCamera();
    if (pipWindow) { try { pipWindow.close(); } catch (e) {} }
}

function resetSession() {
    sessionStartTime = Date.now();
    presentMs = 0;
    awayMs = 0;
    lastFrameT = 0;
    lookAwayStartTime = null;
    lookAwayAlerted = false;
    lookAwayAlertCount = 0;
    lastNudgeTime = 0;
}

function startCamera() {
    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
        .then(stream => {
            video.srcObject = stream;
            video.addEventListener("loadeddata", predictWebcam);
            setStatus("Tracking Active");
        })
        .catch(err => {
            console.error("Camera error", err);
            setStatus("Camera blocked — allow access");
            webcamRunning = false;
        });
}

function stopCamera() {
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    setStatus("Session ended");
    setChip(presenceStatus, "Idle");
    setChip(gazeStatusEl, "—");
    if (fpsCounter) fpsCounter.textContent = "0";
    hideNudge();
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
function predictWebcam() {
    if (!webcamRunning) return;

    const nowMs = performance.now();

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        const faceResults = faceLandmarker.detectForVideo(video, nowMs);
        processFaceResults(faceResults);
    }

    updateFPS();
    // Drive the loop from the PiP window when popped out — that window is always visible, so
    // the browser does NOT throttle it (a hidden dashboard tab would pause window.rAF).
    if (webcamRunning) (pipWindow || window).requestAnimationFrame(predictWebcam);
}

// ─── FACE ANALYSIS ────────────────────────────────────────────────────────────
function processFaceResults(results) {
    const hasFace = results?.faceLandmarks?.length > 0;

    if (hasFace) {
        setChip(presenceStatus, "Present", "status-present");

        if (results.facialTransformationMatrixes?.length > 0) {
            const { yaw, pitch } = extractHeadPose(results.facialTransformationMatrixes[0].data);
            const away = Math.abs(yaw) > YAW_THRESHOLD || Math.abs(pitch) > PITCH_THRESHOLD;

            if (away) {
                setChip(gazeStatusEl, "Away", "status-away");
                handleLookAway();
                accumulate(false);
            } else {
                setChip(gazeStatusEl, "Focused", "status-present");
                clearLookAway();
                accumulate(true);
            }
        } else {
            clearLookAway();
            accumulate(true);
        }

        // --- POSTURE TRACKING ---
        if (postureTrackingEnabled) {
            const landmarks = results.faceLandmarks[0];
            if (landmarks && landmarks.length > 152) {
                // Distance between top of forehead (10) and bottom of chin (152)
                const faceHeight = Math.sqrt(
                    Math.pow(landmarks[10].x - landmarks[152].x, 2) + 
                    Math.pow(landmarks[10].y - landmarks[152].y, 2)
                );
                
                if (faceHeight > SLOUCH_THRESHOLD) {
                    handleSlouch();
                } else {
                    clearSlouch();
                }
            }
        }
    } else {
        setChip(presenceStatus, "Away", "status-away");
        setChip(gazeStatusEl, "No Face", "status-away");
        handleLookAway();
        accumulate(false);
    }
}

// Accumulate observed time per processed frame. Large gaps (window paused/hidden)
// are ignored so unobserved time is never counted as "focused".
function accumulate(isFocused) {
    const now = performance.now();
    if (lastFrameT) {
        const d = now - lastFrameT;
        if (d > 0 && d < 500) {
            if (isFocused) presentMs += d; else awayMs += d;
        }
    }
    lastFrameT = now;
}

function extractHeadPose(m) {
    const yaw   = Math.atan2(m[8], m[10]) * (180 / Math.PI);
    const pitch = Math.asin(-m[9])         * (180 / Math.PI);
    return { yaw, pitch };
}

function handleLookAway() {
    if (!lookAwayStartTime) {
        lookAwayStartTime = Date.now();
        lookAwayAlerted = false;
    } else if (Date.now() - lookAwayStartTime > LOOK_AWAY_THRESHOLD_MS && !lookAwayAlerted) {
        lookAwayAlerted = true;
        lookAwayAlertCount++;
        showNudge("👀", "You've been looking away. Stay focused!");
    }
}

function clearLookAway() {
    lookAwayStartTime = null;
    lookAwayAlerted = false;
}

function handleSlouch() {
    if (!slouchStartTime) {
        slouchStartTime = Date.now();
        slouchAlerted = false;
    } else if (Date.now() - slouchStartTime > 2000 && !slouchAlerted) {
        slouchAlerted = true;
        showNudge("🧍", "Sit up straight! You're slouching.");
    }
}

function clearSlouch() {
    slouchStartTime = null;
    slouchAlerted = false;
}

// ─── NUDGE SYSTEM ─────────────────────────────────────────────────────────────
function showNudge(icon, message) {
    const now = Date.now();
    if (now - lastNudgeTime < NUDGE_COOLDOWN_MS) return;
    lastNudgeTime = now;
    if (nudgeIcon) nudgeIcon.textContent = icon;
    if (nudgeMessage) nudgeMessage.textContent = message;
    if (nudgeToast) nudgeToast.classList.add("visible");
    clearTimeout(nudgeTimeout);
    nudgeTimeout = setTimeout(hideNudge, 4000);
}

function hideNudge() {
    if (nudgeToast) nudgeToast.classList.remove("visible");
    clearTimeout(nudgeTimeout);
}

// ─── METRICS (persisted continuously so End always has fresh numbers) ───────────
function computeMetrics() {
    const durationMs = Date.now() - (sessionStartTime || Date.now());
    const observed = presentMs + awayMs;
    // focusScore = focus WHILE the camera could watch; coveragePct = how much of the session it watched.
    const focusScore = observed > 1000 ? Math.round((presentMs / observed) * 100) : null;
    const coveragePct = durationMs > 0 ? Math.min(100, Math.round((observed / durationMs) * 100)) : 0;
    return {
        focusScore,
        coveragePct,
        lookAwayMs: Math.round(awayMs),
        observedMs: Math.round(observed),
        alertCount: lookAwayAlertCount,
        durationMs
    };
}

function persistMetrics() {
    if (typeof chrome !== "undefined" && chrome.storage) {
        chrome.storage.local.set({ rakez_last_camera_metrics: computeMetrics() });
    }
}

// ─── FPS ──────────────────────────────────────────────────────────────────────
function updateFPS() {
    frameCount++;
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
        if (fpsCounter) fpsCounter.textContent = `${frameCount}`;
        frameCount = 0;
        lastFpsUpdate = now;
    }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initialize().then(() => {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    // If a focus session is already running when the dashboard opens, start tracking.
    chrome.storage.local.get(['rakez_session', 'rakez_posture_tracking'], (data) => {
        postureTrackingEnabled = !!data.rakez_posture_tracking;
        const s = data.rakez_session;
        if (s && s.isActive) startTracking();
    });
}).catch(err => {
    console.error("Rakez camera init failed", err);
    setStatus("AI failed to load");
});

// Follow the session: start when it begins, stop when it ends.
if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.rakez_posture_tracking) {
            postureTrackingEnabled = !!changes.rakez_posture_tracking.newValue;
        }
        if (changes.rakez_session) {
            const s = changes.rakez_session.newValue;
            if (s && s.isActive && !webcamRunning) startTracking();
            else if ((!s || !s.isActive) && webcamRunning) stopTracking();
        }
    });
}

// ─── ALWAYS-ON-TOP POP-OUT (Document Picture-in-Picture) ────────────────────────
const pipBtn = document.getElementById('pip-camera-btn');
if (pipBtn) pipBtn.addEventListener('click', togglePip);

async function togglePip() {
    if (pipWindow) { pipWindow.close(); return; }
    if (!('documentPictureInPicture' in window)) {
        setStatus('Pop-out needs Chrome 116+');
        return;
    }
    const box = document.getElementById('camera-box');
    if (!box) return;
    try {
        pipWindow = await documentPictureInPicture.requestWindow({ width: 340, height: 280 });
    } catch (e) {
        console.warn('Rakez: PiP open failed', e);
        pipWindow = null;
        return;
    }

    copyStylesTo(pipWindow);
    pipWindow.document.body.style.margin = '0';
    pipWindow.document.body.style.background = '#111c28';
    pipWindow.document.body.appendChild(box); // move the live camera into the floating window
    if (pipBtn) pipBtn.textContent = '⤢ Return camera';

    // When the PiP window closes, move the camera back into the dashboard.
    pipWindow.addEventListener('pagehide', () => {
        const host = document.getElementById('dashboard-active');
        const chips = host ? host.querySelector('.focus-chips') : null;
        if (host && box) host.insertBefore(box, chips);
        pipWindow = null;
        if (pipBtn) pipBtn.textContent = '⤢ Pop out camera';
    });
}

// Copy the page's stylesheets into the PiP document so the camera looks the same there.
function copyStylesTo(win) {
    Array.from(document.styleSheets).forEach(sheet => {
        try {
            const cssText = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
            const style = win.document.createElement('style');
            style.textContent = cssText;
            win.document.head.appendChild(style);
        } catch (e) {
            if (sheet.href) {
                const link = win.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = sheet.href;
                win.document.head.appendChild(link);
            }
        }
    });
}

}
