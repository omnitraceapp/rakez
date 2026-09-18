// --------------------------------------------------------
// 1. GUARD CLAUSE
// --------------------------------------------------------
if (window.rakezHasRun) throw new Error("Rakez: Running.");
window.rakezHasRun = true;

// --------------------------------------------------------
// 2. CLEANUP
// --------------------------------------------------------
document.querySelectorAll('#rakez-floating-notebook').forEach(el => el.remove());
document.querySelectorAll('#rakez-note-window').forEach(el => el.remove());
document.querySelectorAll('#rakez-feedback').forEach(el => el.remove());

// --------------------------------------------------------
// 3. LISTENERS
// --------------------------------------------------------
let isCreating = false;
let saveTimeout = null;
let evalInterval = null;
let lastEvaluatedUrl = "";
let currentStatus = "on_task";
let offtaskTimerStart = null;
let sessionActive = false;
let buttonGuard = null;

const isTopFrame = window.self === window.top;

chrome.storage.onChanged.addListener((changes) => {
    // Drive the floating button straight off the session state in storage — this fires reliably
    // in EVERY open tab, with no dependency on the service worker being awake.
    if (changes.rakez_session) {
        const s = changes.rakez_session.newValue;
        if (s && s.isActive) {
            sessionActive = true;
            ensureButton();
            startEvaluating();
        } else {
            sessionActive = false;
            removeFloatingButton();
            stopEvaluating();
        }
    }

    if (changes.rakez_current_notes) {
        const ta = document.getElementById('rakez-note-area');
        if (ta && ta.value !== changes.rakez_current_notes.newValue) {
            ta.value = changes.rakez_current_notes.newValue || "";
        }
    }
});

// Initial load: read the session directly from storage (works even if the worker is asleep).
chrome.storage.local.get(['rakez_session', 'rakez_notebook_open'], (data) => {
    const s = data.rakez_session;
    if (s && s.isActive) {
        sessionActive = true;
        ensureButton();
        startEvaluating();
    }
    startButtonGuard(); // always-on self-heal so the button appears on any page within ~3s
});

// Fast path: react to background broadcasts too (idempotent with the storage listener).
chrome.runtime.onMessage.addListener((req) => {
    if (req.action === "sessionStarted") {
        sessionActive = true;
        ensureButton();
        startEvaluating();
    } else if (req.action === "sessionEnded") {
        sessionActive = false;
        removeFloatingButton();
        stopEvaluating();
    }
});

function ensureButton() {
    if (isTopFrame && document.body) createFloatingButton();
}
function removeFloatingButton() {
    document.querySelectorAll('#rakez-floating-notebook').forEach(el => el.remove());
}

// Re-add the floating button if a page or SPA removes it during a session.
function startButtonGuard() {
    if (!isTopFrame || buttonGuard) return;
    buttonGuard = setInterval(() => { if (sessionActive) ensureButton(); }, 3000);
}
function stopButtonGuard() {
    if (buttonGuard) { clearInterval(buttonGuard); buttonGuard = null; }
}

// --------------------------------------------------------
// 4. UI GENERATION
// --------------------------------------------------------
function createFloatingButton() {
    if (document.getElementById('rakez-floating-notebook')) return;
    if (!document.body) return;

    // Use an inline SVG (not an <img src="chrome-extension://...">) so strict-site CSP `img-src`
    // can't block it — this is why the old button only showed on some pages.
    const btn = document.createElement('div');
    btn.id = 'rakez-floating-notebook';
    btn.title = 'Rakez Notebook — click to open/close';
    btn.className = 'rakez-floating-icon';
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00ffcc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11a2 2 0 0 1 2 2v16l-3.5-2.2L11 21l-3.5-2.2L4 21V5a2 2 0 0 1 1-1.7z"/><line x1="8" y1="8" x2="14" y2="8"/><line x1="8" y1="12" x2="14" y2="12"/></svg>';

    btn.onclick = () => {
        chrome.storage.local.get(['rakez_notebook_open'], (data) => {
            chrome.storage.local.set({ 'rakez_notebook_open': !data.rakez_notebook_open });
        });
    };
    btn.onmouseenter = () => btn.style.transform = "scale(1.1)";
    btn.onmouseleave = () => btn.style.transform = "scale(1.0)";

    document.body.appendChild(btn);
}

// --------------------------------------------------------
// 5. GEMINI EVALUATION (the "off task or not?" loop)
// --------------------------------------------------------
function getPageContext() {
    // Prefer the main content area so AI chats (Claude/ChatGPT) and articles read as their real
    // conversation/text, not the surrounding nav chrome.
    const root = document.querySelector('main') || document.body;
    const text = ((root && root.innerText) || document.body?.innerText || "")
        .replace(/<<<|>>>/g, "")        // strip prompt-fence tokens a page might try to forge
        .replace(/\s+/g, " ").trim().slice(0, 3000);
    return {
        title: document.title || "",
        url: location.href,
        host: location.hostname,
        text
    };
}

let smartPollObserver = null;
let scrollTimeout = null;

function startEvaluating() {
    if (!isTopFrame) return;
    runEvaluation();

    if (!smartPollObserver) {
        smartPollObserver = new MutationObserver(() => {
            if (location.href !== lastEvaluatedUrl) maybeEvaluate();
        });
        smartPollObserver.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('scroll', handleSmartScroll);
}

function handleSmartScroll() {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
        // Only evaluate if we haven't evaluated recently to prevent API spam
        // and if it's been a long scroll on a long page.
        if (location.href !== lastEvaluatedUrl) maybeEvaluate();
    }, 2000);
}

function stopEvaluating() {
    if (smartPollObserver) {
        smartPollObserver.disconnect();
        smartPollObserver = null;
    }
    window.removeEventListener('scroll', handleSmartScroll);
    stopOfftaskTimer();
    currentStatus = "on_task";
    lastEvaluatedUrl = "";
    removeFeedbackBanner();
}

function maybeEvaluate() {
    if (location.href === lastEvaluatedUrl) return; // same page already judged
    runEvaluation();
}

function runEvaluation() {
    if (!document.body) return;
    // Only evaluate the tab the user is actually looking at — keeps us well under
    // the Gemini free-tier rate limit instead of every open tab polling at once.
    if (document.hidden) return;
    lastEvaluatedUrl = location.href;
    chrome.runtime.sendMessage({ action: "evaluatePage", context: getPageContext() }, (result) => {
        if (chrome.runtime.lastError || !result) return;
        const status = result.status || (result.onTask === false ? "off_task" : "on_task");
        countStatus(status);
        applyStatus(status, result.reason || "");
    });
}

// Count this page once per visit, by its status (for the on/related/off-task split).
function countStatus(status) {
    const key = status === "off_task" ? "rakez_offtask_count"
              : status === "related"  ? "rakez_related_count"
              : "rakez_ontask_count";
    chrome.storage.local.get([key], (d) => {
        chrome.storage.local.set({ [key]: (d[key] || 0) + 1 });
    });
}

function applyStatus(status, reason) {
    currentStatus = status;
    if (status === "off_task") {
        showFeedbackBanner("off_task", reason || "This page doesn't match your goal.");
        startOfftaskTimer();
        saveToVault();
        chrome.runtime.sendMessage({
            action: "distractionDetected",
            reason: reason || "Page content does not match goal",
            url: location.href,
            title: document.title || location.hostname
        }).catch(() => {});
    } else if (status === "related") {
        stopOfftaskTimer();
        showFeedbackBanner("related", reason || "Related, but not your exact goal.");
    } else {
        stopOfftaskTimer();
        removeFeedbackBanner();
    }
}

// ── Off-task time accounting (deterministic): count time spent on off-task pages while visible ──
function startOfftaskTimer() {
    if (offtaskTimerStart || document.hidden) return;
    offtaskTimerStart = Date.now();
}
function stopOfftaskTimer() {
    if (!offtaskTimerStart) return;
    const elapsed = Date.now() - offtaskTimerStart;
    offtaskTimerStart = null;
    if (elapsed > 0) {
        chrome.storage.local.get(['rakez_offtask_ms'], (d) => {
            chrome.storage.local.set({ 'rakez_offtask_ms': (d.rakez_offtask_ms || 0) + elapsed });
        });
    }
}

// Save the off-task page into the Distraction Vault (deduped) — visit it after the session.
function saveToVault() {
    const url = location.href;
    const title = document.title || url;
    chrome.storage.local.get(['rakez_vault_current'], (d) => {
        const list = d.rakez_vault_current || [];
        if (list.some(v => v.url === url)) return;
        list.push({ url, title });
        chrome.storage.local.set({ rakez_vault_current: list.slice(-50) });
    });
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopOfftaskTimer();
    else if (currentStatus === "off_task") startOfftaskTimer();
});
window.addEventListener('pagehide', stopOfftaskTimer);

function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 1);
    } catch (e) {}
}

function showFeedbackBanner(type, reason) {
    chrome.storage.local.get(['rakez_strict_mode', 'rakez_audio_chimes'], (prefs) => {
        const isOff = type === "off_task";
        const isStrict = isOff && prefs.rakez_strict_mode;
        
        if (isOff && prefs.rakez_audio_chimes && !document.getElementById('rakez-feedback')) {
            playChime();
        }

        const cls = isStrict ? "rakez-strict-block" : (isOff ? "rakez-offtask" : "rakez-related");
        const label = (isOff ? "⚠️ Off your goal: " : "🔵 Related, not your exact goal: ") + reason;

        let banner = document.getElementById('rakez-feedback');
        if (banner) {
            banner.className = cls;
            const msg = banner.querySelector(isStrict ? '.rakez-strict-block-msg' : '.rakez-feedback-msg');
            if (msg) msg.textContent = label;
            
            const b1 = banner.querySelectorAll('button')[0];
            const b2 = banner.querySelectorAll('button')[1];
            if (b1) b1.textContent = isOff ? "Refocus" : "Keep";
            if (b2) {
                b2.textContent = isOff ? "Ignore" : "Switch back";
                b2.style.display = isStrict ? "none" : "inline-block"; // Hide ignore button in strict mode
            }
            return;
        }

        banner = document.createElement('div');
        banner.id = 'rakez-feedback';
        banner.className = cls;

        const msg = document.createElement('span');
        msg.className = isStrict ? 'rakez-strict-block-msg' : 'rakez-feedback-msg';
        msg.textContent = label;

        const refocus = document.createElement('button');
        refocus.className = isStrict ? 'rakez-strict-block-btn' : 'rakez-feedback-btn rakez-refocus';
        refocus.textContent = isOff ? "Refocus" : "Keep";
        refocus.onclick = () => {
            removeFeedbackBanner();
            if (isStrict) {
                chrome.runtime.sendMessage({ action: "closeCurrentTab" });
            }
        };

        const ignore = document.createElement('button');
        ignore.className = isStrict ? 'rakez-strict-block-btn' : 'rakez-feedback-btn rakez-ignore';
        ignore.textContent = isOff ? "Ignore" : "Switch back";
        if (isStrict) ignore.style.display = 'none'; // Users cannot ignore in strict mode!
        ignore.onclick = () => {
            if (isOff) {
                chrome.storage.local.get(['rakez_ignore_count'], (data) => {
                    chrome.storage.local.set({ 'rakez_ignore_count': (data.rakez_ignore_count || 0) + 1 });
                });
                chrome.runtime.sendMessage({
                    action: "distractionIgnored",
                    reason: reason || "User dismissed off-task warning",
                    url: location.href,
                    title: document.title || location.hostname
                }).catch(() => {});
            }
            removeFeedbackBanner();
        };

        banner.appendChild(msg);
        banner.appendChild(refocus);
        banner.appendChild(ignore);
        if (document.body) document.body.appendChild(banner);
    });
}

function removeFeedbackBanner() {
    const banner = document.getElementById('rakez-feedback');
    if (banner) banner.remove();
}