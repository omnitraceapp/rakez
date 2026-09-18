document.addEventListener('DOMContentLoaded', () => {
    const textArea = document.getElementById('notebook-area');
    let saveTimeout = null;

    // Load initial notes
    chrome.storage.local.get(['rakez_current_notes'], (data) => {
        if (data.rakez_current_notes) {
            textArea.value = data.rakez_current_notes;
        }
    });

    // Save notes as user types (debounced)
    textArea.addEventListener('input', () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            chrome.storage.local.set({ 'rakez_current_notes': textArea.value });
        }, 500);
    });

    // Listen for changes from other contexts (e.g. if another window modifies it)
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.rakez_current_notes) {
            if (textArea.value !== changes.rakez_current_notes.newValue) {
                textArea.value = changes.rakez_current_notes.newValue || "";
            }
        }
    });

    // Export current notes
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const text = textArea.value;
            if (!text.trim()) {
                alert("Notes are empty!");
                return;
            }
            
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Rakez-Session-Notes-${new Date().toISOString().slice(0,10)}.txt`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    }
});
