// AES-GCM helpers (mirror background.js) so the Gemini key is encrypted at rest, not plaintext.
const RZ_B64 = {
    enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))),
    dec: (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0))
};
async function rzGetOrCreateAesKey() {
    const { rakez_crypto_key } = await chrome.storage.local.get('rakez_crypto_key');
    if (rakez_crypto_key) {
        return crypto.subtle.importKey('raw', RZ_B64.dec(rakez_crypto_key), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.local.set({ rakez_crypto_key: RZ_B64.enc(raw) });
    return key;
}
async function rzEncrypt(plain) {
    const key = await rzGetOrCreateAesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return { iv: RZ_B64.enc(iv), data: RZ_B64.enc(ct) };
}
async function rzDecrypt(enc) {
    if (!enc || !enc.iv || !enc.data) return "";
    const { rakez_crypto_key } = await chrome.storage.local.get('rakez_crypto_key');
    if (!rakez_crypto_key) return "";
    const key = await crypto.subtle.importKey('raw', RZ_B64.dec(rakez_crypto_key), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: RZ_B64.dec(enc.iv) }, key, RZ_B64.dec(enc.data));
    return new TextDecoder().decode(pt);
}

document.addEventListener('DOMContentLoaded', async () => {
    const activeDiv = document.getElementById('dashboard-active');
    const inactiveDiv = document.getElementById('dashboard-inactive');
    const endBtn = document.getElementById('end-session-btn');
    const timerDisplay = document.querySelector('.dashboard-timer');
    const intentionEl = document.querySelector('.dashboard-intention');

    // 1. Initial State Check
    const state = await chrome.runtime.sendMessage({ action: "getSessionState" });
    refreshUI(state);

    // 2. Live Ticking (Dashboard needs its own interval to update the screen)
    setInterval(async () => {
        const currentState = await chrome.runtime.sendMessage({ action: "getSessionState" });
        if (currentState.isActive && !currentState.isPaused) {
            timerDisplay.textContent = new Date(currentState.elapsedTime * 1000).toISOString().substr(11, 8);
        }
    }, 1000);

    // 3. End Session Button (no reload — the storage listener switches the view live)
    endBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "endSession" });
    });

    // 4. Settings: Gemini API key save/load
    const apiKeyInput = document.getElementById('rakez-api-key');
    const saveKeyBtn = document.getElementById('save-api-key');
    const testKeyBtn = document.getElementById('test-api-key');
    const keyStatus = document.getElementById('api-key-status');

    if (apiKeyInput) {
        chrome.storage.local.get(['rakez_api_key_enc', 'rakez_api_key'], async (data) => {
            if (data.rakez_api_key_enc) {
                try { apiKeyInput.value = await rzDecrypt(data.rakez_api_key_enc); } catch (e) {}
            } else if (data.rakez_api_key) {
                apiKeyInput.value = data.rakez_api_key; // legacy plaintext (will be re-encrypted on save)
            }
        });
    }
    if (saveKeyBtn) {
        saveKeyBtn.addEventListener('click', async () => {
            const key = apiKeyInput.value.trim();
            if (key) {
                const enc = await rzEncrypt(key);
                await chrome.storage.local.set({ 'rakez_api_key_enc': enc });
                await chrome.storage.local.remove('rakez_api_key'); // drop any legacy plaintext
            } else {
                await chrome.storage.local.remove(['rakez_api_key_enc', 'rakez_api_key']);
            }
            if (keyStatus) {
                keyStatus.textContent = key ? "Saved ✓ (encrypted)" : "Cleared";
                setTimeout(() => { keyStatus.textContent = ""; }, 2000);
            }
        });
    }
    if (testKeyBtn) {
        testKeyBtn.addEventListener('click', async () => {
            const key = apiKeyInput.value.trim();
            if (!key) {
                if (keyStatus) { keyStatus.textContent = "Enter a key first."; keyStatus.style.color = "#ff4d4d"; }
                return;
            }
            if (keyStatus) { keyStatus.textContent = "Testing..."; keyStatus.style.color = "#ffcc00"; }
            chrome.runtime.sendMessage({ action: "testApiKey", apiKey: key }, (res) => {
                if (keyStatus) {
                    if (res && res.success) {
                        keyStatus.textContent = `Key works ✓ (${res.model})`;
                        keyStatus.style.color = "#00ffcc";
                    } else {
                        keyStatus.textContent = `Key failed: ${(res && res.error) || "Unknown error"}`;
                        keyStatus.style.color = "#ff4d4d";
                    }
                    setTimeout(() => { keyStatus.textContent = ""; keyStatus.style.color = "#00ffcc"; }, 5000);
                }
            });
        });
    }

    // 4b. Settings: domain allowlist save/load
    const allowlistInput = document.getElementById('rakez-allowlist');
    const saveAllowBtn = document.getElementById('save-allowlist');
    const allowStatus = document.getElementById('allowlist-status');
    if (allowlistInput) {
        chrome.storage.local.get(['rakez_allowlist'], (data) => {
            if (data.rakez_allowlist) allowlistInput.value = data.rakez_allowlist;
        });
    }
    if (saveAllowBtn) {
        saveAllowBtn.addEventListener('click', () => {
            chrome.storage.local.set({ 'rakez_allowlist': allowlistInput.value.trim() }, () => {
                if (allowStatus) {
                    allowStatus.textContent = "Saved ✓";
                    setTimeout(() => { allowStatus.textContent = ""; }, 2000);
                }
            });
        });
    }

    // 4c. Settings: Toggles
    const toggleStrict = document.getElementById('dash-toggle-strict');
    const toggleAudio = document.getElementById('dash-toggle-audio');
    const togglePosture = document.getElementById('dash-toggle-posture');

    if (toggleStrict && toggleAudio && togglePosture) {
        chrome.storage.local.get(['rakez_strict_mode', 'rakez_audio_chimes', 'rakez_posture_tracking'], (data) => {
            toggleStrict.checked = !!data.rakez_strict_mode;
            toggleAudio.checked = !!data.rakez_audio_chimes;
            togglePosture.checked = !!data.rakez_posture_tracking;
        });

        toggleStrict.addEventListener('change', () => {
            chrome.storage.local.set({ 'rakez_strict_mode': toggleStrict.checked });
        });
        toggleAudio.addEventListener('change', () => {
            chrome.storage.local.set({ 'rakez_audio_chimes': toggleAudio.checked });
        });
        togglePosture.addEventListener('change', () => {
            chrome.storage.local.set({ 'rakez_posture_tracking': togglePosture.checked });
        });
    }

    // 4d. Settings: Supervisor / Teacher Monitoring
    const toggleSupervisor = document.getElementById('dash-toggle-supervisor');
    const toggleSupervisorIgnore = document.getElementById('dash-toggle-supervisor-ignore');
    const toggleSupervisorSummary = document.getElementById('dash-toggle-supervisor-summary');
    const supervisorNameInput = document.getElementById('supervisor-name');
    const supervisorEmailInput = document.getElementById('supervisor-email');
    const saveSupervisorBtn = document.getElementById('save-supervisor-btn');
    const testSupervisorBtn = document.getElementById('test-supervisor-btn');
    const supervisorStatus = document.getElementById('supervisor-status');

    // Email provider UI elements
    const providerSelect = document.getElementById('email-provider-select');
    const emailjsFields = document.getElementById('provider-emailjs-fields');
    const resendFields = document.getElementById('provider-resend-fields');
    const webhookFields = document.getElementById('provider-webhook-fields');
    const emailjsPublicKey = document.getElementById('emailjs-public-key');
    const emailjsServiceId = document.getElementById('emailjs-service-id');
    const emailjsTemplateId = document.getElementById('emailjs-template-id');
    const resendApiKey = document.getElementById('resend-api-key');
    const webhookUrl = document.getElementById('supervisor-webhook');

    // Provider selector: show/hide field groups
    function showProviderFields(provider) {
        if (emailjsFields) emailjsFields.classList.toggle('hidden', provider !== 'emailjs');
        if (resendFields) resendFields.classList.toggle('hidden', provider !== 'resend');
        if (webhookFields) webhookFields.classList.toggle('hidden', provider !== 'webhook');
    }
    if (providerSelect) {
        providerSelect.addEventListener('change', () => showProviderFields(providerSelect.value));
    }

    if (toggleSupervisor) {
        chrome.storage.local.get([
            'rakez_supervisor_enabled',
            'rakez_supervisor_alert_on_ignore',
            'rakez_supervisor_send_summary',
            'rakez_user_name',
            'rakez_supervisor_email',
            'rakez_emailjs_public_key',
            'rakez_emailjs_service_id',
            'rakez_emailjs_template_id',
            'rakez_resend_api_key',
            'rakez_supervisor_webhook',
            'rakez_email_provider'
        ], (data) => {
            toggleSupervisor.checked = !!data.rakez_supervisor_enabled;
            if (toggleSupervisorIgnore) toggleSupervisorIgnore.checked = data.rakez_supervisor_alert_on_ignore !== false;
            if (toggleSupervisorSummary) toggleSupervisorSummary.checked = data.rakez_supervisor_send_summary !== false;
            if (supervisorNameInput && data.rakez_user_name) supervisorNameInput.value = data.rakez_user_name;
            if (supervisorEmailInput && data.rakez_supervisor_email) supervisorEmailInput.value = data.rakez_supervisor_email;
            if (emailjsPublicKey && data.rakez_emailjs_public_key) emailjsPublicKey.value = data.rakez_emailjs_public_key;
            if (emailjsServiceId && data.rakez_emailjs_service_id) emailjsServiceId.value = data.rakez_emailjs_service_id;
            if (emailjsTemplateId && data.rakez_emailjs_template_id) emailjsTemplateId.value = data.rakez_emailjs_template_id;
            if (resendApiKey && data.rakez_resend_api_key) resendApiKey.value = data.rakez_resend_api_key;
            if (webhookUrl && data.rakez_supervisor_webhook) webhookUrl.value = data.rakez_supervisor_webhook;
            // Restore selected provider tab
            const savedProvider = data.rakez_email_provider || 'emailjs';
            if (providerSelect) providerSelect.value = savedProvider;
            showProviderFields(savedProvider);
        });

        toggleSupervisor.addEventListener('change', () => {
            chrome.storage.local.set({ 'rakez_supervisor_enabled': toggleSupervisor.checked });
        });
        if (toggleSupervisorIgnore) {
            toggleSupervisorIgnore.addEventListener('change', () => {
                chrome.storage.local.set({ 'rakez_supervisor_alert_on_ignore': toggleSupervisorIgnore.checked });
            });
        }
        if (toggleSupervisorSummary) {
            toggleSupervisorSummary.addEventListener('change', () => {
                chrome.storage.local.set({ 'rakez_supervisor_send_summary': toggleSupervisorSummary.checked });
            });
        }
        if (saveSupervisorBtn) {
            saveSupervisorBtn.addEventListener('click', () => {
                const name = supervisorNameInput ? supervisorNameInput.value.trim() : "";
                const email = supervisorEmailInput ? supervisorEmailInput.value.trim() : "";
                const provider = providerSelect ? providerSelect.value : "emailjs";
                const saveData = {
                    'rakez_user_name': name,
                    'rakez_supervisor_email': email,
                    'rakez_email_provider': provider,
                    'rakez_emailjs_public_key': emailjsPublicKey ? emailjsPublicKey.value.trim() : "",
                    'rakez_emailjs_service_id': emailjsServiceId ? emailjsServiceId.value.trim() : "",
                    'rakez_emailjs_template_id': emailjsTemplateId ? emailjsTemplateId.value.trim() : "",
                    'rakez_resend_api_key': resendApiKey ? resendApiKey.value.trim() : "",
                    'rakez_supervisor_webhook': webhookUrl ? webhookUrl.value.trim() : ""
                };
                chrome.storage.local.set(saveData, () => {
                    if (supervisorStatus) {
                        supervisorStatus.textContent = "Supervisor Info Saved ✓";
                        supervisorStatus.style.color = "#00ffcc";
                        setTimeout(() => { supervisorStatus.textContent = ""; }, 2500);
                    }
                });
            });
        }
        if (testSupervisorBtn) {
            testSupervisorBtn.addEventListener('click', () => {
                const email = supervisorEmailInput ? supervisorEmailInput.value.trim() : "";
                if (!email || !email.includes("@")) {
                    if (supervisorStatus) {
                        supervisorStatus.textContent = "Please enter a valid email address first.";
                        supervisorStatus.style.color = "#ff4d4d";
                    }
                    return;
                }
                if (supervisorStatus) {
                    supervisorStatus.textContent = "Sending test alert...";
                    supervisorStatus.style.color = "#ffcc00";
                }
                // Auto-save everything before sending test
                const provider = providerSelect ? providerSelect.value : "emailjs";
                chrome.storage.local.set({
                    'rakez_user_name': supervisorNameInput ? supervisorNameInput.value.trim() : "",
                    'rakez_supervisor_email': email,
                    'rakez_supervisor_enabled': true,
                    'rakez_email_provider': provider,
                    'rakez_emailjs_public_key': emailjsPublicKey ? emailjsPublicKey.value.trim() : "",
                    'rakez_emailjs_service_id': emailjsServiceId ? emailjsServiceId.value.trim() : "",
                    'rakez_emailjs_template_id': emailjsTemplateId ? emailjsTemplateId.value.trim() : "",
                    'rakez_resend_api_key': resendApiKey ? resendApiKey.value.trim() : "",
                    'rakez_supervisor_webhook': webhookUrl ? webhookUrl.value.trim() : ""
                }, () => {
                    toggleSupervisor.checked = true;
                    chrome.runtime.sendMessage({ action: "sendTestAlert" }, (res) => {
                        if (supervisorStatus) {
                            if (res && res.success) {
                                supervisorStatus.textContent = "Test Alert Sent! Check supervisor inbox ✓";
                                supervisorStatus.style.color = "#00ffcc";
                            } else {
                                const detail = (res && res.details) || (res && res.reason) || "No email provider configured.";
                                supervisorStatus.textContent = "⚠ " + detail;
                                supervisorStatus.style.color = "#ff4d4d";
                            }
                            setTimeout(() => { supervisorStatus.textContent = ""; supervisorStatus.style.color = "#00ffcc"; }, 6000);
                        }
                    });
                });
            });
        }
    }

    // 5. Danger Zone: Clear all session data
    const clearBtn = document.getElementById('clear-data-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (confirm("Clear ALL Rakez data (history, notes, API key, settings)? This cannot be undone.")) {
                chrome.storage.local.clear(() => location.reload());
            }
        });
    }

    // 6. Populate all pages from history; live focus chips
    renderHistory();
    renderAnalysis();
    renderAnalytics();
    renderExport();
    renderVault();
    populateQuizSelector();
    updateLiveChips();

    // ── AI Quiz ──────────────────────────────────────────────────────────────────
    const genQuizBtn = document.getElementById('generate-quiz-btn');
    if (genQuizBtn) {
        genQuizBtn.addEventListener('click', () => {
            const sel = document.getElementById('quiz-selector');
            const box = document.getElementById('quiz-box');
            const status = document.getElementById('quiz-status');
            const topicEl = document.getElementById('quiz-topic');
            const levelEl = document.getElementById('quiz-level');
            const topic = topicEl ? topicEl.value.trim() : "";
            const level = levelEl ? levelEl.value : "Medium";
            const id = sel && sel.value ? Number(sel.value) : null;
            if (!id && !topic) { if (status) status.textContent = "Type a topic or pick a session."; return; }
            if (status) status.textContent = "Generating…";
            if (box) box.innerHTML = "";
            chrome.runtime.sendMessage({ action: "generateQuiz", recordId: id, topic, level }, (res) => {
                if (status) status.textContent = "";
                if (!res || res.error) { if (status) status.textContent = (res && res.error) || "Failed."; return; }
                renderQuiz(res.questions || []);
            });
        });
    }

    // Note modal close handlers
    const noteModal = document.getElementById('note-modal');
    const noteModalClose = document.getElementById('note-modal-close');
    if (noteModalClose) noteModalClose.addEventListener('click', () => noteModal.classList.add('hidden'));
    if (noteModal) noteModal.addEventListener('click', (e) => { if (e.target === noteModal) noteModal.classList.add('hidden'); });

    // 7. React live to storage changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.rakez_history) { renderHistory(); renderAnalysis(); renderAnalytics(); renderExport(); renderVault(); populateQuizSelector(); }
        if (changes.rakez_vault_current) renderVault();
        if (changes.rakez_last_camera_metrics || changes.rakez_offtask_count) updateLiveChips();
        if (changes.rakez_session) {
            renderVault();
            chrome.runtime.sendMessage({ action: "getSessionState" }, (s) => refreshUI(s));
        }
    });

    // ── Analytics page: real stat cards + focus-trend chart from history ──────────
    let focusChartInstance = null;

    function renderAnalytics() {
        chrome.storage.local.get(['rakez_history'], (data) => {
            const hist = data.rakez_history || [];
            const totalSecs = hist.reduce((a, r) => a + (r.duration || 0), 0);
            const onSum = hist.reduce((a, r) => a + (r.ontaskCount || 0), 0);
            const offSum = hist.reduce((a, r) => a + (r.offtaskCount || 0), 0);
            const ignSum = hist.reduce((a, r) => a + (r.ignoreCount || 0), 0);
            setText('stat-total-time', formatSecs(totalSecs));
            setText('stat-ontask', String(onSum));
            setText('stat-offtask', String(offSum));
            setText('stat-ignored', String(ignSum));

            const ctx = document.getElementById('focusChart');
            if (!ctx) return;
            const recent = hist.slice(0, 7).reverse(); // oldest → newest
            
            if (!recent.length) { 
                ctx.style.display = 'none';
                return; 
            }
            ctx.style.display = 'block';

            const labels = recent.map((r, i) => r.date ? r.date.split(',')[0] : `S${i + 1}`);
            const dataPoints = recent.map(r => {
                let h;
                const reliable = r.camera && r.camera.focusScore != null && (r.camera.coveragePct == null || r.camera.coveragePct >= 50);
                if (reliable) h = r.camera.focusScore;
                else {
                    const tot = (r.ontaskCount || 0) + (r.relatedCount || 0) + (r.offtaskCount || 0);
                    h = tot ? Math.round((r.ontaskCount || 0) / tot * 100) : 0;
                }
                // Gamified Penalty for off-task and ignores
                const penalties = (r.offtaskCount || 0) * 2 + (r.ignoreCount || 0) * 5;
                return Math.max(0, h - penalties);
            });

            if (focusChartInstance) {
                focusChartInstance.destroy();
            }

            // Requires Chart.js included in index.html
            if (typeof Chart !== 'undefined') {
                focusChartInstance = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Focus Score',
                            data: dataPoints,
                            borderColor: '#00ffcc',
                            backgroundColor: 'rgba(0, 255, 204, 0.2)',
                            borderWidth: 2,
                            pointBackgroundColor: '#00ffcc',
                            tension: 0.3,
                            fill: true
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                beginAtZero: true,
                                max: 100,
                                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                                ticks: { color: '#a0a0a0' }
                            },
                            x: {
                                grid: { display: false },
                                ticks: { color: '#a0a0a0' }
                            }
                        },
                        plugins: {
                            legend: { display: false }
                        }
                    }
                });
            }
        });
    }

    // Off-task counter chip (presence/gaze are set live by the camera tracker itself).
    function updateLiveChips() {
        chrome.storage.local.get(['rakez_offtask_count'], (d) => {
            setText('live-offtask', String(d.rakez_offtask_count || 0));
        });
    }

    function refreshUI(session) {
        if (session && session.isActive) {
            activeDiv.classList.remove('hidden');
            inactiveDiv.classList.add('hidden');
            if (intentionEl) intentionEl.textContent = session.intention || "Focusing";
            timerDisplay.textContent = new Date(session.elapsedTime * 1000).toISOString().substr(11, 8);
            const modeBadge = document.getElementById('dashboard-mode-badge');
            if (modeBadge) {
                const isWork = session.mode === 'work';
                modeBadge.textContent = isWork ? '💼 Work Mode' : '🎓 Study Mode';
                modeBadge.className = 'session-mode-badge ' + (isWork ? 'mode-work' : 'mode-study');
            }
        } else {
            activeDiv.classList.add('hidden');
            inactiveDiv.classList.remove('hidden');
            renderAnalysis();
        }
    }

    // ── Last-session analysis box ──────────────────────────────────────────────
    function renderAnalysis() {
        const box = document.getElementById('session-analysis');
        if (!box) return;
        chrome.storage.local.get(['rakez_history'], (data) => {
            const rec = (data.rakez_history || [])[0];
            if (!rec) { box.classList.add('hidden'); return; }
            box.classList.remove('hidden');

            const disp = camFocusDisplay(rec);
            setText('analysis-intention', rec.intention || "Session");
            setText('analysis-focus', disp.focus);
            setText('analysis-duration', formatSecs(rec.duration || 0));
            setText('analysis-away', disp.reliable ? formatMs(rec.camera.lookAwayMs || 0) : "—");
            setText('analysis-watched', disp.watched);
            setText('analysis-offtask', String(rec.offtaskCount || 0));
            setText('analysis-summary',
                (rec.summary && rec.summary !== "Pending AI Summary...") ? rec.summary : "Generating AI summary…");

            const focusEl = document.getElementById('analysis-focus');
            if (focusEl) {
                const s = disp.rawScore;
                focusEl.className = "analysis-num " + (s == null ? "" : s >= 80 ? "score-great" : s >= 50 ? "score-okay" : "score-poor");
            }
        });
    }

    function renderHistory() {
        const grid = document.querySelector('.notebook-grid');
        if (!grid) return;
        chrome.storage.local.get(['rakez_history'], (data) => {
            const history = data.rakez_history || [];
            if (!history.length) {
                grid.innerHTML = '<p class="dashboard-empty">No sessions yet</p>';
                return;
            }
            grid.innerHTML = history.map(rec => {
                const summary = (rec.summary && rec.summary !== "Pending AI Summary...")
                    ? rec.summary
                    : "Generating AI summary…";
                const isWork = rec.mode === 'work';
                const modeHtml = `<span class="history-mode-badge ${isWork ? 'mode-work' : 'mode-study'}">${isWork ? '💼 Work' : '🎓 Study'}</span>`;
                return `
                    <div class="notebook-card">
                      <div class="card-header">
                        <span class="card-date">${rec.date || ""} ${modeHtml}</span>
                        <h3 class="card-title">${escapeHtml(rec.intention || "Session")}</h3>
                      </div>
                      <p class="card-summary">${escapeHtml(summary.slice(0, 160))}</p>
                      <button class="btn secondary small open-note" data-id="${rec.id}">Open Note</button>
                    </div>`;
            }).join("");
            grid.querySelectorAll('.open-note').forEach(btn =>
                btn.addEventListener('click', () => openNoteModal(Number(btn.dataset.id))));
        });
    }

    // ── Open Note modal ──────────────────────────────────────────────────────────
    function openNoteModal(id) {
        chrome.storage.local.get(['rakez_history'], (data) => {
            const rec = (data.rakez_history || []).find(r => r.id === id);
            if (!rec) return;
            const disp = camFocusDisplay(rec);
            const isWork = rec.mode === 'work';
            const modeLabel = isWork ? "💼 Work Mode" : "🎓 Study Mode";
            const camTxt = disp.reliable ? `${disp.focus} focus (${disp.watched} watched)` : `${disp.focus} focus (Estimated)`;
            setText('note-modal-title', rec.intention || "Session");
            setText('note-modal-date', `${rec.date || ""} · ${modeLabel}`);
            setText('note-modal-stats', `${formatSecs(rec.duration || 0)} · ${camTxt} · ${rec.offtaskCount || 0} off-task pages`);
            setText('note-modal-notes', rec.notes || "(no notes)");
            setText('note-modal-summary', (rec.summary && rec.summary !== "Pending AI Summary...") ? rec.summary : "Generating…");
            const modal = document.getElementById('note-modal');
            if (modal) modal.classList.remove('hidden');
        });
    }

    // ── Export (Markdown + Print/PDF) ────────────────────────────────────────────
    function renderExport() {
        const grid = document.getElementById('export-grid');
        if (!grid) return;
        chrome.storage.local.get(['rakez_history'], (data) => {
            const history = data.rakez_history || [];
            if (!history.length) { grid.innerHTML = '<p class="dashboard-empty">No sessions yet</p>'; return; }
            grid.innerHTML = history.map(rec => `
                <div class="export-card">
                  <div class="card-header">
                    <span class="card-date">${rec.date || ""}</span>
                    <h3 class="card-title">${escapeHtml(rec.intention || "Session")}</h3>
                  </div>
                  <div class="export-actions">
                    <button class="btn secondary export-md" data-id="${rec.id}">Download .MD</button>
                    <button class="btn secondary export-pdf" data-id="${rec.id}">Print / PDF</button>
                  </div>
                </div>`).join("");
            grid.querySelectorAll('.export-md').forEach(b => b.addEventListener('click', () => exportRecord(Number(b.dataset.id), 'md')));
            grid.querySelectorAll('.export-pdf').forEach(b => b.addEventListener('click', () => exportRecord(Number(b.dataset.id), 'pdf')));
        });
    }
    function exportRecord(id, kind) {
        chrome.storage.local.get(['rakez_history'], (data) => {
            const rec = (data.rakez_history || []).find(r => r.id === id);
            if (!rec) return;
            const md = recordToMarkdown(rec);
            const safe = (rec.intention || 'session').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
            if (kind === 'md') {
                downloadText(`rakez_${safe}.md`, md, 'text/markdown');
            } else {
                const w = window.open('', '_blank');
                if (!w) return;
                w.document.write(`<title>${escapeHtml(rec.intention || 'Session')}</title><pre style="font-family:sans-serif;white-space:pre-wrap;padding:24px;line-height:1.6;">${escapeHtml(md)}</pre>`);
                w.document.close();
                w.focus();
                setTimeout(() => w.print(), 300);
            }
        });
    }
    function recordToMarkdown(rec) {
        const disp = camFocusDisplay(rec);
        const cam = disp.reliable ? `${disp.focus} (camera)` : `${disp.focus} (estimated)`;
        const modeStr = rec.mode === 'work' ? 'Work 💼' : 'Study 🎓';
        return `# ${rec.intention || "Session"}\n\n` +
            `- Date: ${rec.date || ""}\n` +
            `- Mode: ${modeStr}\n` +
            `- Duration: ${formatSecs(rec.duration || 0)}\n` +
            `- Focus score: ${cam}\n` +
            `- Pages — on-task: ${rec.ontaskCount || 0}, related: ${rec.relatedCount || 0}, off-task: ${rec.offtaskCount || 0}\n` +
            `- Off-task time: ${formatMs(rec.offtaskMs || 0)}\n\n` +
            `## Notes\n\n${rec.notes || "(none)"}\n\n` +
            `## AI Summary\n\n${rec.summary || ""}\n`;
    }
    function downloadText(filename, text, mime) {
        const blob = new Blob([text], { type: mime || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Distraction Vault ────────────────────────────────────────────────────────
    function renderVault() {
        const box = document.getElementById('vault-container');
        if (!box) return;
        chrome.storage.local.get(['rakez_history', 'rakez_vault_current', 'rakez_session'], (data) => {
            const history = data.rakez_history || [];
            const current = data.rakez_vault_current || [];
            const active = data.rakez_session && data.rakez_session.isActive;
            const withVault = history.filter(r => r.vault && r.vault.length);

            if (!withVault.length && !(active && current.length)) {
                box.innerHTML = '<p class="dashboard-empty">No saved distractions yet</p>';
                return;
            }
            let html = "";
            if (active && current.length) {
                html += `<div class="vault-session locked">
                    <div class="session-info">
                      <h3 class="session-intention">Current session</h3>
                      <p class="lock-status">🔒 Unlocks when this session ends — ${current.length} link${current.length > 1 ? 's' : ''} caught</p>
                    </div>
                </div>`;
            }
            html += withVault.map(r => `
                <div class="vault-session">
                  <div class="session-info">
                    <h3 class="session-intention">${escapeHtml(r.intention || 'Session')}</h3>
                    <span class="session-date">${r.date || ''}</span>
                  </div>
                  <div class="vault-links">
                    ${r.vault.map(v => `<div class="vault-item">
                        <span class="link-title">${escapeHtml((v.title || v.url || '').slice(0, 70))}</span>
                        <button class="btn secondary small vault-visit" data-url="${encodeURIComponent(v.url || '')}">Visit</button>
                    </div>`).join("")}
                  </div>
                </div>`).join("");
            box.innerHTML = html;
            box.querySelectorAll('.vault-visit').forEach(b => b.addEventListener('click', () =>
                chrome.tabs.create({ url: decodeURIComponent(b.dataset.url) })));
        });
    }

    // ── AI Quiz rendering ────────────────────────────────────────────────────────
    function populateQuizSelector() {
        const sel = document.getElementById('quiz-selector');
        if (!sel) return;
        chrome.storage.local.get(['rakez_history'], (data) => {
            const hist = data.rakez_history || [];
            const opts = ['<option value="">— None (use topic above) —</option>'].concat(
                hist.map(r => `<option value="${r.id}">${escapeHtml(r.intention || 'Session')} (${r.date || ''})</option>`));
            sel.innerHTML = opts.join("");
        });
    }
    function renderQuiz(questions) {
        const box = document.getElementById('quiz-box');
        if (!box) return;
        box.classList.remove('hidden');
        if (!questions.length) { box.innerHTML = '<p class="dashboard-empty">No questions generated.</p>'; return; }
        box.innerHTML = questions.map((q, qi) => `
            <div class="quiz-question-block" data-answer="${q.answerIndex}">
              <p class="quiz-q">${qi + 1}. ${escapeHtml(q.q || '')}</p>
              <div class="quiz-options">
                ${(q.options || []).map((opt, oi) =>
                    `<label class="option"><input type="radio" name="q${qi}" value="${oi}"> ${escapeHtml(opt)}</label>`).join("")}
              </div>
            </div>`).join("") +
            `<button class="btn small" id="quiz-submit">Check Answers</button><p id="quiz-score" class="settings-status"></p>`;

        const submit = document.getElementById('quiz-submit');
        if (submit) submit.addEventListener('click', () => {
            let correct = 0;
            box.querySelectorAll('.quiz-question-block').forEach((blk, qi) => {
                const ans = Number(blk.dataset.answer);
                const labels = blk.querySelectorAll('.option');
                labels.forEach((l, oi) => {
                    l.classList.remove('correct', 'wrong');
                    if (oi === ans) l.classList.add('correct');
                });
                const chosen = blk.querySelector(`input[name="q${qi}"]:checked`);
                if (chosen) {
                    const ci = Number(chosen.value);
                    if (ci === ans) correct++;
                    else if (labels[ci]) labels[ci].classList.add('wrong');
                }
            });
            const score = document.getElementById('quiz-score');
            if (score) score.textContent = `Score: ${correct} / ${questions.length}`;
        });
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    // Honest focus display: if camera watched < 50% of the session, fallback to time-weighted & browsing score.
    function camFocusDisplay(rec) {
        const cam = rec.camera;
        const cov = (cam && cam.coveragePct != null) ? cam.coveragePct : 0;
        const reliable = cam && cam.focusScore != null && cov >= 50;
        
        let focusScore;
        if (reliable) {
            const penalties = (rec.offtaskCount || 0) * 2 + (rec.ignoreCount || 0) * 5;
            focusScore = Math.max(0, cam.focusScore - penalties);
        } else {
            const durationSec = rec.duration || 1;
            const offtaskSec = Math.round((rec.offtaskMs || 0) / 1000);
            
            // 1. Time-on-task ratio (how much of the total session time was spent on-task vs off-task)
            const timeOnTaskRatio = Math.max(0, Math.min(1, 1 - (offtaskSec / durationSec)));
            
            // 2. Page category ratio
            const totPages = (rec.ontaskCount || 0) + (rec.relatedCount || 0) + (rec.offtaskCount || 0);
            const pageRatio = totPages > 0 
                ? ((rec.ontaskCount || 0) + 0.5 * (rec.relatedCount || 0)) / totPages 
                : 1;

            // Weighted score: 70% actual time spent, 30% page visit classification
            focusScore = Math.round((timeOnTaskRatio * 0.7 + pageRatio * 0.3) * 100);

            // Penalties for off-task count & warnings ignored
            const penalties = (rec.offtaskCount || 0) * 2 + (rec.ignoreCount || 0) * 5;
            focusScore = Math.max(0, focusScore - penalties);
        }
        
        return { 
            focus: focusScore + "%", 
            watched: cam ? cov + "%" : "—", 
            reliable: reliable,
            rawScore: focusScore
        };
    }
    function formatSecs(s) {
        const m = Math.floor(s / 60);
        return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
    }
    function formatMs(ms) { return formatSecs(Math.floor(ms / 1000)); }
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }
});
