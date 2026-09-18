document.addEventListener('DOMContentLoaded', async () => {
    const idleView = document.getElementById('popup-idle');
    const activeView = document.getElementById('popup-active');
    const intentionInput = document.getElementById('intention');
    const intentionLabel = document.getElementById('intention-label');
    const modeStudyBtn = document.getElementById('mode-study');
    const modeWorkBtn = document.getElementById('mode-work');
    const activeModeBadge = document.getElementById('active-mode-badge');
    const startBtn = document.querySelector('.btn-start');
    const pauseBtn = document.querySelector('.btn-pause');
    const endBtn = document.querySelector('.btn-end');
    const dashboardBtn = document.querySelector('.btn-dashboard');
    const currentIntentionText = document.querySelector('.current-intention');

    let currentMode = 'study';

    // Load saved mode preference if available
    const saved = await chrome.storage.local.get('rakez_preferred_mode');
    if (saved.rakez_preferred_mode) {
        setMode(saved.rakez_preferred_mode);
    }

    if (modeStudyBtn && modeWorkBtn) {
        modeStudyBtn.addEventListener('click', () => setMode('study'));
        modeWorkBtn.addEventListener('click', () => setMode('work'));
    }

    function setMode(mode) {
        currentMode = mode;
        chrome.storage.local.set({ rakez_preferred_mode: mode });
        if (mode === 'work') {
            modeWorkBtn?.classList.add('active');
            modeStudyBtn?.classList.remove('active');
            if (intentionLabel) intentionLabel.textContent = "What are you working on?";
            if (intentionInput) intentionInput.placeholder = "e.g. Refactoring Payment API";
        } else {
            modeStudyBtn?.classList.add('active');
            modeWorkBtn?.classList.remove('active');
            if (intentionLabel) intentionLabel.textContent = "What are you studying?";
            if (intentionInput) intentionInput.placeholder = "e.g. Learning JS Closures";
        }
    }

    // 1. Ask background script for current state when popup opens
    const state = await chrome.runtime.sendMessage({ action: "getSessionState" });
    updateUI(state);

    // 2. Start Session
    startBtn.addEventListener('click', () => {
        const intention = intentionInput.value.trim();
        if (intention) {
            chrome.runtime.sendMessage({ action: "startSession", intention: intention, mode: currentMode }, (response) => {
                // Instantly update UI after starting
                chrome.runtime.sendMessage({ action: "getSessionState" }, (newState) => {
                    updateUI(newState);
                });
            });
        } else {
            alert(currentMode === 'work' ? "Please enter your work goal first!" : "Please enter your study intention first!");
        }
    });

    // 3. Pause/Resume Session
    pauseBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "pauseSession" }, (response) => {
            chrome.runtime.sendMessage({ action: "getSessionState" }, (newState) => {
                updateUI(newState);
                pauseBtn.textContent = newState.isPaused ? "Resume Session" : "Pause Session";
            });
        });
    });

    // 4. End Session
    endBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "endSession" }, () => {
            chrome.runtime.sendMessage({ action: "getSessionState" }, (newState) => {
                updateUI(newState);
            });
        });
    });

    // 5. Open Dashboard
    dashboardBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('project/index.html') });
    });

    // Helper function to update live AI assessment badge
    function updateAiEval() {
        const evalBox = document.getElementById('ai-eval-box');
        const evalStatus = document.getElementById('ai-eval-status');
        const evalReason = document.getElementById('ai-eval-reason');
        if (!evalStatus || !evalReason) return;

        chrome.storage.local.get(['rakez_last_eval'], (d) => {
            const ev = d.rakez_last_eval;
            if (!ev) {
                evalStatus.textContent = "🟢 100% On-Task";
                evalStatus.style.color = "#00ffcc";
                evalReason.textContent = "Evaluating current page...";
                return;
            }

            if (ev.status === "off_task") {
                evalStatus.textContent = "⚠️ Off-Task Distraction";
                evalStatus.style.color = "#ff4d4d";
                if (evalBox) {
                    evalBox.style.background = "rgba(255, 77, 77, 0.12)";
                    evalBox.style.borderColor = "rgba(255, 77, 77, 0.35)";
                }
            } else if (ev.status === "related") {
                evalStatus.textContent = `🔵 Related (${ev.relatedness || 50}%)`;
                evalStatus.style.color = "#38bdf8";
                if (evalBox) {
                    evalBox.style.background = "rgba(56, 189, 248, 0.12)";
                    evalBox.style.borderColor = "rgba(56, 189, 248, 0.35)";
                }
            } else {
                evalStatus.textContent = `🟢 On-Task (${ev.relatedness || 100}%)`;
                evalStatus.style.color = "#00ffcc";
                if (evalBox) {
                    evalBox.style.background = "rgba(0, 255, 204, 0.08)";
                    evalBox.style.borderColor = "rgba(0, 255, 204, 0.25)";
                }
            }
            evalReason.textContent = ev.reason || "Page content matches your focus goal.";
        });
    }

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.rakez_last_eval) {
            updateAiEval();
        }
    });

    // Helper function to switch between Idle and Active views
    function updateUI(session) {
        if (session && session.isActive) {
            idleView.classList.add('hidden');
            activeView.classList.remove('hidden');
            currentIntentionText.textContent = session.intention;
            pauseBtn.textContent = session.isPaused ? "Resume Session" : "Pause Session";
            if (activeModeBadge) {
                const isWork = session.mode === 'work';
                activeModeBadge.textContent = isWork ? '💼 Working' : '🎓 Studying';
                activeModeBadge.style.color = isWork ? '#ffcc00' : '#00ffcc';
                activeModeBadge.style.borderColor = isWork ? 'rgba(255, 204, 0, 0.4)' : 'rgba(0, 255, 204, 0.3)';
                activeModeBadge.style.background = isWork ? 'rgba(255, 204, 0, 0.15)' : 'rgba(0, 255, 204, 0.15)';
            }
            updateAiEval();
        } else {
            idleView.classList.remove('hidden');
            activeView.classList.add('hidden');
        }
    }
});