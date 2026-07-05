/*
 * LearnGuage offline engine.
 * Port of app.py's server-side logic to the browser.
 * - Word selection (3 modes + second-wrong feature) -> selectSessionWords()
 * - Answer checking (Levenshtein) -> checkAnswer()
 * - Progress persistence -> localStorage (was data/progress/user_progress.json)
 *
 * All behavior mirrors APP_LOGIC_SPEC.md. This is a translation, not a redesign.
 */
const Engine = (() => {
  const STORAGE_KEY = 'learnguage_progress_v1';
  const wordSetCache = {};      // set_id -> word set JSON
  let progress = null;          // in-memory copy of localStorage progress

  // ----- text utilities (port of normalize_text / levenshtein_distance) -----
  const ACCENT_MAP = {
    'à': 'a', 'á': 'a', 'ä': 'a', 'â': 'a',
    'è': 'e', 'é': 'e', 'ë': 'e', 'ê': 'e',
    'ì': 'i', 'í': 'i', 'ï': 'i', 'î': 'i',
    'ò': 'o', 'ó': 'o', 'ö': 'o', 'ô': 'o',
    'ù': 'u', 'ú': 'u', 'ü': 'u', 'û': 'u',
    'ñ': 'n', 'ç': 'c', 'ß': 'ss'
  };

  function normalizeText(text) {
    text = (text || '').toLowerCase().trim();
    let out = '';
    for (const ch of text) out += (ACCENT_MAP[ch] !== undefined ? ACCENT_MAP[ch] : ch);
    return out;
  }

  function levenshtein(s1, s2) {
    if (s1.length < s2.length) return levenshtein(s2, s1);
    if (s2.length === 0) return s1.length;
    let previous = [];
    for (let i = 0; i <= s2.length; i++) previous.push(i);
    for (let i = 0; i < s1.length; i++) {
      const current = [i + 1];
      for (let j = 0; j < s2.length; j++) {
        const insertions = previous[j + 1] + 1;
        const deletions = current[j] + 1;
        const substitutions = previous[j] + (s1[i] !== s2[j] ? 1 : 0);
        current.push(Math.min(insertions, deletions, substitutions));
      }
      previous = current;
    }
    return previous[previous.length - 1];
  }

  // port of check_answer()
  function checkAnswer(userAnswer, correctAnswers) {
    const normalizedUser = normalizeText(userAnswer);
    for (const correct of correctAnswers) {
      if (normalizedUser === normalizeText(correct)) {
        return { status: 'correct', message: 'Correct!', correct: null };
      }
    }
    for (const correct of correctAnswers) {
      const normalizedCorrect = normalizeText(correct);
      if (normalizedCorrect.length > 3) {
        if (levenshtein(normalizedUser, normalizedCorrect) <= 2) {
          return { status: 'close', message: 'Almost! Check spelling', correct: correct };
        }
      }
    }
    return { status: 'wrong', message: 'Incorrect', correct: correctAnswers[0] };
  }

  // ----- Fisher-Yates shuffle (port of random.shuffle, in place) -----
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ----- word set loading (port of load_word_set) -----
  async function loadWordSet(setId) {
    if (wordSetCache[setId]) return wordSetCache[setId];
    const resp = await fetch(`data/words/italian_set_${setId}.json`);
    if (!resp.ok) return null;
    const data = await resp.json();
    wordSetCache[setId] = data;
    return data;
  }

  // ----- progress storage (port of load_progress / save_progress) -----
  function defaultProgress() {
    return {
      sets: {},
      global_stats: {
        total_words_mastered: 0,
        total_sessions: 0,
        accuracy_rate: 0.0,
        most_struggled_words: []
      }
    };
  }

  function initializeSetProgress() {
    return {
      current_word_index: 0,
      completed: false,
      in_review_mode: false,
      review_words: [],
      review_word_index: 0,
      shuffled_set: [],
      wrong_queue: [],
      second_wrong_queue: [],
      paused_session: {
        active: false,
        words: [],
        current_word_index: 0,
        retry_queue: [],
        skip_queue: [],
        session_stats: {}
      },
      word_stats: {},
      session_count: 0
    };
  }

  // Load progress into memory. On first run, seed from bundled seed_progress.json
  // (the user's existing progress) so nothing is lost moving to the PWA.
  async function init() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { progress = JSON.parse(raw); }
      catch (e) { progress = defaultProgress(); }
    } else {
      progress = null;
      try {
        const r = await fetch('data/seed_progress.json');
        if (r.ok) progress = await r.json();
      } catch (e) { /* no seed available - start fresh */ }
      if (!progress || typeof progress !== 'object' || !progress.sets) {
        progress = defaultProgress();
      }
      save();
    }
    return progress;
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  }

  function getProgress() { return progress; }

  function ensureSet(setId) {
    const key = String(setId);
    if (!progress.sets[key]) {
      progress.sets[key] = initializeSetProgress();
      save();
    }
    return progress.sets[key];
  }

  // ----- session word selection (port of select_session_words) -----
  // Mutates setProgress in place (modes/indices), mirroring the Python.
  function selectSessionWords(setId, wordSet, setProgress) {
    const wrongQueue = setProgress.wrong_queue || [];
    const wordStats = setProgress.word_stats || {};
    const currentIndex = setProgress.current_word_index || 0;
    const allWords = wordSet.words;
    const totalWords = allWords.length;

    const inReviewMode = setProgress.in_review_mode || false;
    const reviewWords = setProgress.review_words || [];
    const shuffledSet = setProgress.shuffled_set || [];

    const currentSession = setProgress.session_count || 0;
    const secondWrongQueue = setProgress.second_wrong_queue || [];

    // second-wrong words that are ready (3+ sessions old)
    const availableSecondWrong = [];
    for (const entry of secondWrongQueue) {
      if (entry && typeof entry === 'object') {
        const wordId = entry.word_id;
        const addedSession = entry.added_session !== undefined ? entry.added_session : currentSession;
        if (currentSession - addedSession >= 3) availableSecondWrong.push(wordId);
      } else {
        availableSecondWrong.push(entry); // legacy: always available
      }
    }

    // MODE 1: REVIEW MODE
    if (inReviewMode && reviewWords.length) {
      const fromSecondWrong = availableSecondWrong.slice(0, 1);
      const numFromSecondWrong = fromSecondWrong.length;
      const fromWrongQueue = wrongQueue.slice(0, 3);
      const numFromWrong = fromWrongQueue.length;

      const newWordsNeeded = 10 - numFromWrong - numFromSecondWrong;
      const newWords = [];

      const reviewWordIndex = setProgress.review_word_index || 0;
      for (let i = reviewWordIndex; i < reviewWords.length; i++) {
        const wordId = reviewWords[i];
        if (wrongQueue.includes(wordId)) continue;
        if (fromSecondWrong.includes(wordId)) continue;
        newWords.push(wordId);
        if (newWords.length >= newWordsNeeded) break;
      }

      if (newWords.length) {
        const lastWordId = newWords[newWords.length - 1];
        setProgress.review_word_index = reviewWords.indexOf(lastWordId) + 1;
      }

      if (setProgress.review_word_index >= reviewWords.length && wrongQueue.length === 0) {
        const allWordIds = allWords.map(w => w.id);
        shuffle(allWordIds);
        setProgress.shuffled_set = allWordIds;
        setProgress.current_word_index = 0;
        setProgress.in_review_mode = false;
        setProgress.review_words = [];
        setProgress.review_word_index = 0;
      }

      return fromSecondWrong.concat(fromWrongQueue, newWords).slice(0, 10);
    }

    // MODE 2: SHUFFLED MODE
    else if (shuffledSet.length) {
      const fromSecondWrong = availableSecondWrong.slice(0, 1);
      const numFromSecondWrong = fromSecondWrong.length;
      const fromWrongQueue = wrongQueue.slice(0, 3);
      const numFromWrong = fromWrongQueue.length;

      const newWordsNeeded = 10 - numFromWrong - numFromSecondWrong;
      const newWords = [];

      for (let i = currentIndex; i < shuffledSet.length; i++) {
        const wordId = shuffledSet[i];
        if (wrongQueue.includes(wordId)) continue;
        if (fromSecondWrong.includes(wordId)) continue;
        newWords.push(wordId);
        if (newWords.length >= newWordsNeeded) break;
      }

      if (newWords.length) {
        const lastWordId = newWords[newWords.length - 1];
        setProgress.current_word_index = shuffledSet.indexOf(lastWordId) + 1;
      }

      if (setProgress.current_word_index >= shuffledSet.length && wrongQueue.length === 0) {
        const wordsWithErrors = Object.keys(wordStats).filter(id => (wordStats[id].times_wrong || 0) > 0);
        if (wordsWithErrors.length) {
          shuffle(wordsWithErrors);
          setProgress.in_review_mode = true;
          setProgress.review_words = wordsWithErrors;
          setProgress.review_word_index = 0;
          setProgress.shuffled_set = [];
        } else {
          const allWordIds = allWords.map(w => w.id);
          shuffle(allWordIds);
          setProgress.shuffled_set = allWordIds;
          setProgress.current_word_index = 0;
        }
      }

      return fromSecondWrong.concat(fromWrongQueue, newWords).slice(0, 10);
    }

    // MODE 3: NORMAL MODE
    else {
      if (currentIndex >= totalWords && wrongQueue.length === 0) {
        const wordsWithErrors = Object.keys(wordStats).filter(id => (wordStats[id].times_wrong || 0) > 0);
        if (wordsWithErrors.length) {
          shuffle(wordsWithErrors);
          setProgress.in_review_mode = true;
          setProgress.review_words = wordsWithErrors;
          setProgress.review_word_index = 0;
          return selectSessionWords(setId, wordSet, setProgress);
        } else {
          const allWordIds = allWords.map(w => w.id);
          shuffle(allWordIds);
          setProgress.shuffled_set = allWordIds;
          setProgress.current_word_index = 0;
          return selectSessionWords(setId, wordSet, setProgress);
        }
      }

      const fromSecondWrong = availableSecondWrong.slice(0, 1);
      const numFromSecondWrong = fromSecondWrong.length;
      const fromWrongQueue = wrongQueue.slice(0, 3);
      const numFromWrong = fromWrongQueue.length;

      const newWordsNeeded = 10 - numFromWrong - numFromSecondWrong;
      const newWords = [];
      let wordsChecked = 0;

      for (let i = currentIndex; i < allWords.length; i++) {
        if (wordsChecked >= newWordsNeeded * 2) break; // safety limit
        const wordId = allWords[i].id;
        wordsChecked++;
        if (wordStats[wordId] && wordStats[wordId].mastered) continue;
        if (wrongQueue.includes(wordId)) continue;
        if (fromSecondWrong.includes(wordId)) continue;
        newWords.push(wordId);
        if (newWords.length >= newWordsNeeded) break;
      }

      if (newWords.length) {
        const lastWordId = newWords[newWords.length - 1];
        for (let i = 0; i < allWords.length; i++) {
          if (allWords[i].id === lastWordId) { setProgress.current_word_index = i + 1; break; }
        }
      }

      return fromSecondWrong.concat(fromWrongQueue, newWords).slice(0, 10);
    }
  }

  // Build display-only word objects (no english - mirrors server hiding answers)
  function displayWords(wordIds, wordSet) {
    const dict = {};
    for (const w of wordSet.words) dict[w.id] = w;
    const out = [];
    for (const id of wordIds) {
      const w = dict[id];
      if (w) out.push({ id: w.id, italian: w.italian, hint: w.hint, gender: w.gender, letter_count: w.letter_count });
    }
    return out;
  }

  function removeSelectedFromQueues(setProgress, sessionWordIds) {
    const wrongQueue = setProgress.wrong_queue || [];
    setProgress.wrong_queue = wrongQueue.filter(id => !sessionWordIds.includes(id));
    const secondWrongQueue = setProgress.second_wrong_queue || [];
    setProgress.second_wrong_queue = secondWrongQueue.filter(entry => {
      const id = (entry && typeof entry === 'object') ? entry.word_id : entry;
      return !sessionWordIds.includes(id);
    });
  }

  // port of /api/session/<id>/words (resume active or start new)
  async function getSessionWords(setId) {
    const wordSet = await loadWordSet(setId);
    if (!wordSet) return { error: 'Set not found' };
    const setProgress = ensureSet(setId);
    let paused = setProgress.paused_session || {};

    if (!paused.active) {
      const sessionWordIds = selectSessionWords(setId, wordSet, setProgress);
      removeSelectedFromQueues(setProgress, sessionWordIds);
      paused = {
        active: true, words: sessionWordIds, current_word_index: 0,
        retry_queue: [], skip_queue: [], session_stats: {}
      };
      setProgress.paused_session = paused;
      save();
    }

    return {
      words: displayWords(paused.words, wordSet),
      current_index: paused.current_word_index,
      retry_queue: paused.retry_queue,
      skip_queue: paused.skip_queue
    };
  }

  // port of /api/start-new-session/<id>
  async function startNewSession(setId) {
    const wordSet = await loadWordSet(setId);
    if (!wordSet) return { error: 'Set not found' };
    const setProgress = ensureSet(setId);

    setProgress.paused_session = {
      active: false, words: [], current_word_index: 0,
      retry_queue: [], skip_queue: [], session_stats: {}
    };

    const sessionWordIds = selectSessionWords(setId, wordSet, setProgress);
    removeSelectedFromQueues(setProgress, sessionWordIds);

    setProgress.paused_session = {
      active: true, words: sessionWordIds, current_word_index: 0,
      retry_queue: [], skip_queue: [], session_stats: {}
    };
    save();

    return { words: displayWords(sessionWordIds, wordSet), current_index: 0, retry_queue: [], skip_queue: [] };
  }

  // port of /api/check-answer
  async function checkAnswerAndRecord(setId, wordId, userAnswer) {
    const wordSet = await loadWordSet(setId);
    if (!wordSet) return { error: 'Set not found' };
    const word = wordSet.words.find(w => w.id === wordId);
    if (!word) return { error: 'Word not found' };

    const result = checkAnswer(userAnswer, word.english);

    const setProgress = ensureSet(setId);
    const wordStats = setProgress.word_stats || (setProgress.word_stats = {});
    if (!wordStats[wordId]) {
      wordStats[wordId] = {
        times_seen: 0, times_correct: 0, times_wrong: 0,
        consecutive_wrong: 0, mastered: false,
        last_seen_session: setProgress.session_count || 0
      };
    }
    const stats = wordStats[wordId];
    stats.times_seen += 1;
    if (result.status === 'correct') {
      stats.times_correct += 1;
      stats.consecutive_wrong = 0;
      stats.mastered = true;
    } else {
      stats.times_wrong += 1;
      stats.consecutive_wrong += 1;
    }
    save();
    return result;
  }

  // port of /api/word-context
  async function getWordContext(setId, wordId) {
    const wordSet = await loadWordSet(setId);
    if (!wordSet) return { error: 'Set not found' };
    const word = wordSet.words.find(w => w.id === wordId);
    if (!word) return { error: 'Word not found' };
    return {
      part_of_speech: word.part_of_speech,
      gender: word.gender,
      example_italian: word.example_italian,
      example_english: word.example_english,
      english: word.primary_english
    };
  }

  // port of /api/skip-word
  function skipWord(setId, wordId) {
    const setProgress = ensureSet(setId);
    const paused = setProgress.paused_session || {};
    const skipQueue = paused.skip_queue || (paused.skip_queue = []);
    if (!skipQueue.includes(wordId)) skipQueue.push(wordId);
    save();
    return { status: 'ok' };
  }

  // port of /api/session-complete
  async function sessionComplete(setId, failedWords) {
    const setProgress = ensureSet(setId);

    const wrongQueue = setProgress.wrong_queue || [];
    const secondWrongQueue = setProgress.second_wrong_queue || [];
    const currentSession = setProgress.session_count || 0;

    const paused = setProgress.paused_session || {};
    const sessionWords = paused.words || [];

    const wordStats = setProgress.word_stats || {};
    const wasInWrongQueue = [];
    for (const wordId of sessionWords) {
      if (wordStats[wordId]) {
        const timesSeenBefore = (wordStats[wordId].times_seen || 1) - 1;
        if (timesSeenBefore > 0) wasInWrongQueue.push(wordId);
      }
    }

    const secondWrongWordIds = secondWrongQueue.map(e => (e && typeof e === 'object') ? e.word_id : e);

    const randomizedFailed = failedWords.slice();
    shuffle(randomizedFailed);

    for (const wordId of randomizedFailed) {
      if (wasInWrongQueue.includes(wordId)) {
        const idx = wrongQueue.indexOf(wordId);
        if (idx !== -1) wrongQueue.splice(idx, 1);
        let alreadyInSecond = false;
        for (const entry of secondWrongQueue) {
          const eid = (entry && typeof entry === 'object') ? entry.word_id : entry;
          if (eid === wordId) { alreadyInSecond = true; break; }
        }
        if (!alreadyInSecond) {
          secondWrongQueue.push({ word_id: wordId, added_session: currentSession + 1 });
        }
      } else if (secondWrongWordIds.includes(wordId)) {
        for (let i = 0; i < secondWrongQueue.length; i++) {
          const entry = secondWrongQueue[i];
          const eid = (entry && typeof entry === 'object') ? entry.word_id : entry;
          if (eid === wordId) {
            secondWrongQueue[i] = { word_id: wordId, added_session: currentSession + 1 };
            break;
          }
        }
      } else {
        if (!wrongQueue.includes(wordId)) wrongQueue.push(wordId);
      }
    }

    setProgress.wrong_queue = wrongQueue;
    setProgress.second_wrong_queue = secondWrongQueue;
    setProgress.session_count = (setProgress.session_count || 0) + 1;
    setProgress.paused_session = {
      active: false, words: [], current_word_index: 0,
      retry_queue: [], skip_queue: [], session_stats: {}
    };

    const currentIndex = setProgress.current_word_index || 0;
    const wordSet = await loadWordSet(setId);
    const totalWords = wordSet ? wordSet.words.length : 0;

    if (currentIndex >= totalWords && wrongQueue.length === 0) {
      const inReviewMode = setProgress.in_review_mode || false;
      const reviewWords = setProgress.review_words || [];
      const reviewWordIndex = setProgress.review_word_index || 0;

      if (inReviewMode && reviewWordIndex >= reviewWords.length) {
        const allWordIds = wordSet.words.map(w => w.id);
        shuffle(allWordIds);
        setProgress.shuffled_set = allWordIds;
        setProgress.current_word_index = 0;
        setProgress.in_review_mode = false;
        setProgress.review_words = [];
        setProgress.review_word_index = 0;
      } else if (!inReviewMode) {
        const wordsWithErrors = Object.keys(wordStats).filter(id => (wordStats[id].times_wrong || 0) > 0);
        if (wordsWithErrors.length) {
          shuffle(wordsWithErrors);
          setProgress.in_review_mode = true;
          setProgress.review_words = wordsWithErrors;
          setProgress.review_word_index = 0;
        }
      }
    }

    // global stats
    let totalMastered = 0;
    for (const key of Object.keys(progress.sets)) {
      const ws = progress.sets[key].word_stats || {};
      totalMastered += Object.keys(ws).filter(id => ws[id].mastered).length;
    }
    progress.global_stats.total_words_mastered = totalMastered;
    progress.global_stats.total_sessions = (progress.global_stats.total_sessions || 0) + 1;

    save();
    return {
      status: 'ok',
      wrong_queue_size: wrongQueue.length,
      in_review_mode: setProgress.in_review_mode || false,
      shuffled_mode: (setProgress.shuffled_set || []).length > 0
    };
  }

  // port of the index() view: per-set stats for the home screen
  async function getSetsInfo() {
    const setsInfo = [];
    for (let setId = 1; setId <= 5; setId++) {
      const wordSet = await loadWordSet(setId);
      if (!wordSet) continue;
      const sp = progress.sets[String(setId)] || {};
      const totalWords = wordSet.words.length;
      const wordStats = sp.word_stats || {};
      const masteredCount = Object.keys(wordStats).filter(id => wordStats[id].mastered).length;
      const seenCount = Object.keys(wordStats).length;
      const hasPaused = (sp.paused_session || {}).active || false;
      setsInfo.push({
        id: setId, name: wordSet.set_name, total_words: totalWords,
        seen_count: seenCount, mastered_count: masteredCount, has_paused_session: hasPaused
      });
    }
    return setsInfo;
  }

  // ----- backup / restore (iOS storage-eviction safety net) -----
  function exportProgress() { return JSON.stringify(progress, null, 2); }
  function importProgress(json) {
    const data = (typeof json === 'string') ? JSON.parse(json) : json;
    if (!data || typeof data !== 'object' || !data.sets) throw new Error('Invalid backup file');
    progress = data;
    save();
    return true;
  }
  function resetProgress() { progress = defaultProgress(); save(); }

  return {
    init, getProgress, getSetsInfo,
    getSessionWords, startNewSession, checkAnswerAndRecord,
    getWordContext, skipWord, sessionComplete,
    exportProgress, importProgress, resetProgress
  };
})();
