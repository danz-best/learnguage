// App version shown on the home screen. Bump this together with the service
// worker cache version on every deploy.
const APP_VERSION = '10';

// Home screen: render progress + set cards, wire up backup controls.
document.addEventListener('DOMContentLoaded', async () => {
    await Engine.init();
    const vEl = document.getElementById('app-version');
    if (vEl) vEl.textContent = 'Version ' + APP_VERSION;
    render();

    // ----- backup / restore -----
    document.getElementById('export-btn').addEventListener('click', () => {
        const blob = new Blob([Engine.exportProgress()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'learnguage-progress.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        msg('Progress exported. Keep the file somewhere safe.');
    });

    document.getElementById('import-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                Engine.importProgress(reader.result);
                render();
                msg('Progress imported successfully.');
            } catch (err) {
                msg('Could not import: ' + err.message, true);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });
});

function msg(text, isError) {
    const el = document.getElementById('backup-msg');
    el.textContent = text;
    el.style.color = isError ? '#dc3545' : '#2e7d32';
}

async function render() {
    const gs = Engine.getProgress().global_stats || {};
    document.getElementById('stat-mastered').textContent = gs.total_words_mastered || 0;
    document.getElementById('stat-sessions').textContent = gs.total_sessions || 0;
    document.getElementById('stat-accuracy').textContent =
        Math.round((gs.accuracy_rate || 0) * 100 * 10) / 10 + '%';

    const grid = document.getElementById('sets-grid');
    grid.innerHTML = '';
    const sets = await Engine.getSetsInfo();
    for (const set of sets) {
        const pct = set.total_words > 0
            ? Math.round((set.mastered_count / set.total_words) * 100 * 10) / 10 : 0;
        const card = document.createElement('div');
        card.className = 'set-card';
        const btnClass = set.has_paused_session ? 'btn-resume' : 'btn-primary';
        const btnLabel = set.has_paused_session ? 'Resume Session' : 'Start Session';
        const run = set.run || { seen: 0, correct_first: 0 };
        const runLine = run.seen > 0
            ? `This run: knew ${run.correct_first} of ${run.seen} first try`
            : `This run: not started yet`;
        const prevLine = set.prev_run
            ? `Last run: knew ${set.prev_run.correct_first} of ${set.prev_run.seen} first try`
            : '';
        card.innerHTML = `
            <h3>${set.name}</h3>
            <div class="set-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${pct}%"></div>
                </div>
                <p class="progress-text">${set.mastered_count}/${set.total_words} mastered</p>
                <p class="progress-text">${set.seen_count} words seen</p>
                <p class="progress-text run-stat">${runLine}</p>
                ${prevLine ? `<p class="progress-text run-stat">${prevLine}</p>` : ''}
            </div>
            <a href="session.html?set=${set.id}" class="btn ${btnClass}">${btnLabel}</a>`;
        grid.appendChild(card);
    }
}
