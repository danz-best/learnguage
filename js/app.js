// Session state
let sessionWords = [];
let currentWordIndex = 0;
let retryQueue = [];
let endOfSessionQueue = []; // Words to show at very end
let failedWords = []; // Words that failed in this session (for wrong-words queue)
let autoPronounce = false; // Auto-pronounce toggle
let inputLocked = false;   // soft lock during feedback (keeps iOS keyboard up vs. disabling)
let sessionStats = {
    correct: 0,
    totalAttempts: 0,
    wordsCompleted: new Set(),
    wordAttempts: {},
    wordAppearances: {},
    firstAppearance: {},
    wordResults: {},
    firstAppearanceResults: {}
};

// SET_ID comes from the URL query string (?set=N) since there is no server template.
const SET_ID = parseInt(new URLSearchParams(location.search).get('set') || '1', 10);

// DOM elements
const italianText = document.getElementById('italian-text');
const genderIndicator = document.getElementById('gender-indicator');
const hintText = document.getElementById('hint-text');
const letterCount = document.getElementById('letter-count');
const answerInput = document.getElementById('answer-input');
const submitBtn = document.getElementById('submit-btn');
const skipBtn = document.getElementById('skip-btn');
const contextBtn = document.getElementById('context-btn');
const feedback = document.getElementById('feedback');
const contextModal = document.getElementById('context-modal');
const sessionSummary = document.getElementById('session-summary');
const currentWordNum = document.getElementById('current-word-num');
const totalWordsElem = document.getElementById('total-words');

let currentWord = null;
let currentAttempts = 0;

// ----- iOS audio unlock: one shared AudioContext, resumed on first gesture -----
let sharedAudioCtx = null;
function unlockAudio() {
    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
    } catch (e) { /* ignore */ }
}
document.addEventListener('touchend', unlockAudio, { once: false });
document.addEventListener('click', unlockAudio, { once: false });
document.addEventListener('keydown', unlockAudio, { once: false });

// Initialize session
async function initSession() {
    try {
        const data = await Engine.getSessionWords(SET_ID);
        if (data.error) { alert(data.error); return; }

        sessionWords = data.words;
        lastSessionWords = [...sessionWords];
        retryQueue = [];
        endOfSessionQueue = [];
        currentWordIndex = 0;
        resetStats();

        totalWordsElem.textContent = sessionWords.length;
        loadNextWord();
    } catch (error) {
        console.error('Error loading session:', error);
        alert('Failed to load session');
    }
}

function resetStats() {
    sessionStats = {
        correct: 0, totalAttempts: 0,
        wordsCompleted: new Set(),
        wordAttempts: {}, wordAppearances: {}, firstAppearance: {},
        wordResults: {}, firstAppearanceResults: {}
    };
}

// Load next word (priority: new -> retry -> end-of-session)
function loadNextWord() {
    let foundWord = false;

    if (currentWordIndex < sessionWords.length) {
        currentWord = sessionWords[currentWordIndex];
        currentWordIndex++;
        if (!sessionStats.firstAppearance[currentWord.id]) {
            sessionStats.firstAppearance[currentWord.id] = true;
        }
        foundWord = true;
    } else if (retryQueue.length > 0) {
        while (retryQueue.length > 0) {
            const wordId = retryQueue.shift();
            const word = sessionWords.find(w => w.id === wordId);
            const appearances = sessionStats.wordAppearances[wordId] || 0;
            if (word && appearances < 3) { currentWord = word; foundWord = true; break; }
        }
    } else if (endOfSessionQueue.length > 0) {
        while (endOfSessionQueue.length > 0) {
            const wordId = endOfSessionQueue.shift();
            const word = sessionWords.find(w => w.id === wordId);
            const appearances = sessionStats.wordAppearances[wordId] || 0;
            if (word && appearances < 3) { currentWord = word; foundWord = true; break; }
        }
    }

    if (!foundWord) { showSessionSummary(); return; }

    displayWord(currentWord);
    currentAttempts = sessionStats.wordAttempts[currentWord.id] || 0;
    currentWordNum.textContent = sessionStats.wordsCompleted.size + 1;

    answerInput.value = '';
    answerInput.readOnly = false;
    inputLocked = false;
    answerInput.focus();
    hideFeedback();
}

function displayWord(word) {
    italianText.textContent = word.italian;

    if (!sessionStats.wordAppearances[word.id]) sessionStats.wordAppearances[word.id] = 0;
    sessionStats.wordAppearances[word.id]++;

    if (autoPronounce) window.pronounceWord(word.italian);

    const pronounceWordBtn = document.getElementById('pronounce-word-btn');
    if (pronounceWordBtn) pronounceWordBtn.onclick = () => window.pronounceWord(word.italian);

    if (word.gender) {
        genderIndicator.textContent = `(${word.gender})`;
        genderIndicator.classList.remove('hidden');
    } else {
        genderIndicator.textContent = '';
        genderIndicator.classList.add('hidden');
    }

    if (word.hint) {
        hintText.textContent = word.hint;
        hintText.classList.remove('hidden');
    } else {
        hintText.textContent = '';
        hintText.classList.add('hidden');
    }

    const count = word.letter_count || 5;
    if (typeof count === 'string') {
        const parts = count.split('-');
        const spacedParts = parts.map(part => part.split('').join(' '));
        letterCount.textContent = spacedParts.join(' - ');
    } else {
        letterCount.textContent = '_ '.repeat(count).trim();
    }
}

// Submit answer
async function submitAnswer() {
    if (inputLocked) return;
    const answer = answerInput.value.trim();
    if (!answer) return;

    inputLocked = true;
    answerInput.readOnly = true; // lock without blurring (keeps keyboard up on iOS)

    if (!sessionStats.wordAttempts[currentWord.id]) sessionStats.wordAttempts[currentWord.id] = 0;
    sessionStats.wordAttempts[currentWord.id]++;
    currentAttempts = sessionStats.wordAttempts[currentWord.id];
    sessionStats.totalAttempts++;

    try {
        const result = await Engine.checkAnswerAndRecord(SET_ID, currentWord.id, answer);
        if (result.status === 'correct') handleCorrect();
        else if (result.status === 'close') handleClose(result.correct);
        else handleWrong(result.correct);
    } catch (error) {
        console.error('Error checking answer:', error);
        alert('Failed to check answer');
        inputLocked = false;
        answerInput.readOnly = false;
    }
}

// Play success sound using the shared (iOS-unlocked) AudioContext
function playSuccessSound() {
    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
        const ctx = sharedAudioCtx;
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        oscillator.frequency.value = 1000;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.08);
    } catch (e) {
        console.log('Audio not supported:', e);
    }
}

function handleCorrect() {
    sessionStats.correct++;
    const appearances = sessionStats.wordAppearances[currentWord.id] || 0;
    if (appearances === 1) sessionStats.firstAppearanceResults[currentWord.id] = 'correct';
    sessionStats.wordResults[currentWord.id] = 'correct';
    if (appearances >= 3 || appearances === 1) sessionStats.wordsCompleted.add(currentWord.id);

    showFeedback('correct', 'Correct!');
    playSuccessSound();
    setTimeout(loadNextWord, 1000);
}

function handleClose(correctAnswer) { handleWrongAnswer(correctAnswer, true); }
function handleWrong(correctAnswer) { handleWrongAnswer(correctAnswer, false); }

function handleWrongAnswer(correctAnswer, isClose) {
    const message = isClose
        ? `Almost! Check spelling. Correct answer: ${correctAnswer}`
        : `Incorrect. Correct answer: ${correctAnswer}`;
    showFeedback(isClose ? 'close' : 'wrong', message);

    const appearances = sessionStats.wordAppearances[currentWord.id] || 0;
    const isFirstAppearance = appearances === 1;
    if (appearances === 1) sessionStats.firstAppearanceResults[currentWord.id] = 'wrong';
    sessionStats.wordResults[currentWord.id] = 'wrong';

    if (appearances >= 3) {
        sessionStats.wordsCompleted.add(currentWord.id);
        if (isFirstAppearance && !failedWords.includes(currentWord.id)) failedWords.push(currentWord.id);
    } else if (appearances === 1) {
        if (!failedWords.includes(currentWord.id)) failedWords.push(currentWord.id);
        if (!retryQueue.includes(currentWord.id)) {
            if (retryQueue.length === 0) {
                retryQueue.push(currentWord.id);
            } else {
                const randomPos = Math.floor(Math.random() * retryQueue.length) + 1;
                retryQueue.splice(Math.min(randomPos, retryQueue.length), 0, currentWord.id);
            }
        }
        if (!endOfSessionQueue.includes(currentWord.id)) endOfSessionQueue.push(currentWord.id);
    }
    // appearance 2: appearance 3 already scheduled, nothing to do

    setTimeout(loadNextWord, 1000);
}

// Skip word - treat as wrong (2 more appearances)
async function skipWord() {
    if (!currentWord || inputLocked) return;
    inputLocked = true;
    answerInput.readOnly = true;
    try {
        const context = await Engine.getWordContext(SET_ID, currentWord.id);
        showFeedback('wrong', `Skipped. Correct answer: ${context.english}`);

        const appearances = sessionStats.wordAppearances[currentWord.id] || 0;
        if (appearances === 1) sessionStats.firstAppearanceResults[currentWord.id] = 'wrong';
        sessionStats.wordResults[currentWord.id] = 'wrong';
        if (!failedWords.includes(currentWord.id)) failedWords.push(currentWord.id);

        if (appearances === 1) {
            if (!retryQueue.includes(currentWord.id)) {
                if (retryQueue.length === 0) {
                    retryQueue.push(currentWord.id);
                } else {
                    const randomPos = Math.floor(Math.random() * retryQueue.length) + 1;
                    retryQueue.splice(Math.min(randomPos, retryQueue.length), 0, currentWord.id);
                }
            }
            if (!endOfSessionQueue.includes(currentWord.id)) endOfSessionQueue.push(currentWord.id);
        } else {
            sessionStats.wordsCompleted.add(currentWord.id);
        }

        Engine.skipWord(SET_ID, currentWord.id);
        setTimeout(loadNextWord, 1000);
    } catch (error) {
        console.error('Error skipping word:', error);
        inputLocked = false;
        answerInput.readOnly = false;
    }
}

// Show context (during session - no English answer/translation)
async function showContext() {
    if (!currentWord) return;
    try {
        const context = await Engine.getWordContext(SET_ID, currentWord.id);
        document.getElementById('pos').textContent = context.part_of_speech;
        document.getElementById('gender').textContent = context.gender || 'N/A';
        document.getElementById('english-meaning').parentElement.style.display = 'none';
        document.getElementById('example-en').parentElement.style.display = 'none';
        document.getElementById('example-it').textContent = context.example_italian;
        const pronounceBtn = document.getElementById('pronounce-btn');
        if (pronounceBtn) pronounceBtn.onclick = () => pronounceWord(currentWord.italian);
        contextModal.classList.remove('hidden');
    } catch (error) {
        console.error('Error loading context:', error);
    }
}

// Pronounce Italian word using Web Speech API (it-IT)
window.pronounceWord = function(italianWord) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(italianWord);
        utterance.lang = 'it-IT';
        utterance.rate = 0.8;
        window.speechSynthesis.speak(utterance);
    }
};

function showFeedback(type, message) {
    feedback.className = `feedback feedback-${type}`;
    feedback.querySelector('.feedback-message').textContent = message;
    const icon = feedback.querySelector('.feedback-icon');
    icon.textContent = type === 'correct' ? '✓' : (type === 'close' ? '~' : '✗');
    feedback.classList.remove('hidden');
}
function hideFeedback() { feedback.classList.add('hidden'); }

// Session summary
async function showSessionSummary() {
    const accuracy = sessionStats.totalAttempts > 0
        ? Math.round((sessionStats.correct / sessionStats.totalAttempts) * 100) : 0;
    document.getElementById('correct-count').textContent = sessionStats.correct;
    document.getElementById('total-attempts').textContent = sessionStats.totalAttempts;
    document.getElementById('accuracy').textContent = accuracy + '%';

    if (!isRedoSession && failedWords.length > 0) {
        try { await Engine.sessionComplete(SET_ID, failedWords); }
        catch (error) { console.error('Error saving session results:', error); }
    }
    if (!isRedoSession) lastSessionFailedWords = [...failedWords];

    const failedInfo = document.getElementById('failed-words-info');
    if (failedInfo) {
        const failedCount = failedWords.length;
        failedInfo.textContent = `${failedCount} word${failedCount !== 1 ? 's' : ''} to review`;
    }

    await buildWordList();

    document.querySelector('.word-card').style.display = 'none';
    document.querySelector('.answer-section').style.display = 'none';
    sessionSummary.classList.remove('hidden');
}

async function buildWordList() {
    const wordListContainer = document.getElementById('word-list');
    if (!wordListContainer) return;
    wordListContainer.innerHTML = '<h3>Session Words:</h3>';

    for (const word of sessionWords) {
        try {
            const context = await Engine.getWordContext(SET_ID, word.id);
            const result = sessionStats.firstAppearanceResults[word.id] || 'unknown';
            const indicator = result === 'correct' ? '✓' : (result === 'wrong' ? '✗' : '');
            const indicatorClass = result === 'correct' ? 'correct-indicator' : 'wrong-indicator';

            const esc = s => String(s).replace(/'/g, "\\'");
            const wordItem = document.createElement('div');
            wordItem.className = 'word-list-item';
            wordItem.innerHTML = `
                <div class="word-list-main">
                    <span class="${indicatorClass}">${indicator}</span>
                    <strong>${word.italian}</strong> ${word.gender ? '(' + word.gender + ')' : ''} - ${context.english}
                    <button class="btn-small" onclick="showWordDetails('${word.id}', '${esc(word.italian)}', '${esc(context.part_of_speech)}', '${esc(context.gender || 'N/A')}', '${esc(context.english)}', '${esc(context.example_italian)}', '${esc(context.example_english)}')">Details</button>
                    <button class="btn-small" onclick="pronounceWord('${esc(word.italian)}')">🔊 Play</button>
                </div>`;
            wordListContainer.appendChild(wordItem);
        } catch (error) {
            console.error('Error loading word context:', error);
        }
    }
}

window.showWordDetails = function(wordId, italian, pos, gender, english, exampleIt, exampleEn) {
    document.getElementById('pos').textContent = pos;
    document.getElementById('gender').textContent = gender;
    document.getElementById('english-meaning').parentElement.style.display = 'block';
    document.getElementById('english-meaning').textContent = english;
    document.getElementById('example-en').parentElement.style.display = 'block';
    document.getElementById('example-it').textContent = exampleIt;
    document.getElementById('example-en').textContent = exampleEn;
    const pronounceBtn = document.getElementById('pronounce-btn');
    if (pronounceBtn) pronounceBtn.onclick = () => pronounceWord(italian);
    contextModal.classList.remove('hidden');
};

// Event listeners
submitBtn.addEventListener('click', submitAnswer);
skipBtn.addEventListener('click', skipWord);
contextBtn.addEventListener('click', showContext);

answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !inputLocked) submitAnswer();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (!contextModal.classList.contains('hidden')) contextModal.classList.add('hidden');
        else skipWord();
    }
    if (e.key === 'Enter') {
        if (!sessionSummary.classList.contains('hidden')) {
            e.preventDefault();
            continueToNextSession();
        }
    }
});

document.querySelector('.close-modal').addEventListener('click', () => contextModal.classList.add('hidden'));
contextModal.addEventListener('click', (e) => { if (e.target === contextModal) contextModal.classList.add('hidden'); });

// Redo state
let lastSessionWords = [];
let lastSessionFailedWords = [];
let isRedoSession = false;

async function continueToNextSession() {
    document.querySelector('.word-card').style.display = 'block';
    document.querySelector('.answer-section').style.display = 'block';
    sessionSummary.classList.add('hidden');

    currentWordIndex = 0;
    retryQueue = [];
    endOfSessionQueue = [];
    failedWords = [];
    isRedoSession = false;
    resetStats();

    try {
        const data = await Engine.startNewSession(SET_ID);
        if (data.error) { alert(data.error); return; }
        sessionWords = data.words;
        lastSessionWords = [...sessionWords];
        retryQueue = [];
        endOfSessionQueue = [];
        currentWordIndex = 0;
        totalWordsElem.textContent = sessionWords.length;
        loadNextWord();
    } catch (error) {
        console.error('Error loading session:', error);
        alert('Failed to load session');
    }
}

function redoSession() {
    document.querySelector('.word-card').style.display = 'block';
    document.querySelector('.answer-section').style.display = 'block';
    sessionSummary.classList.add('hidden');

    currentWordIndex = 0;
    retryQueue = [];
    endOfSessionQueue = [];
    failedWords = [...lastSessionFailedWords];
    isRedoSession = true;
    resetStats();

    sessionWords = [...lastSessionWords];
    for (let i = sessionWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sessionWords[i], sessionWords[j]] = [sessionWords[j], sessionWords[i]];
    }
    totalWordsElem.textContent = sessionWords.length;
    loadNextWord();
}

// Boot: init the engine (loads/seeds progress) before starting the session.
document.addEventListener('DOMContentLoaded', async () => {
    await Engine.init();

    const setNameEl = document.getElementById('set-name');
    const info = (await Engine.getSetsInfo()).find(s => s.id === SET_ID);
    if (setNameEl && info) setNameEl.textContent = info.name;

    initSession();

    const continueBtn = document.getElementById('continue-session-btn');
    if (continueBtn) continueBtn.addEventListener('click', continueToNextSession);
    const redoBtn = document.getElementById('redo-session-btn');
    if (redoBtn) redoBtn.addEventListener('click', redoSession);

    const autoPronounceCheckbox = document.getElementById('auto-pronounce-checkbox');
    if (autoPronounceCheckbox) {
        autoPronounceCheckbox.addEventListener('change', (e) => { autoPronounce = e.target.checked; });
    }
});
