// ===== Storage =====
const STORAGE_KEY = 'english-tracker-data';
const SETTINGS_KEY = 'english-tracker-settings';

function loadData() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { dailyGoal: 0 };
  } catch {
    return { dailyGoal: 0 };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ===== Debug =====
function debugLog(msg) {
  console.log('[EST]', msg);
  const el = document.getElementById('debug-log');
  if (el) {
    const time = new Date().toLocaleTimeString();
    el.textContent = `[${time}] ${msg}\n` + el.textContent.slice(0, 2000);
  }
}

// ===== State =====
let isRecording = false;
let recognition = null;
let timerInterval = null;
let startTime = null;
let currentTranscript = '';
let accumulatedTranscript = ''; // 再起動をまたいで蓄積する
let interimTranscript = '';
let chart = null;
let currentChartPeriod = 7;

// ===== Tabs =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

    if (tab.dataset.tab === 'history') renderHistory();
    if (tab.dataset.tab === 'stats') renderStats();
  });
});

// ===== Speech Recognition =====
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('このブラウザは音声認識に対応していません');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = 'en-US';
  rec.continuous = false;  // 1発話ずつ処理（重複防止）
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    const result = event.results[0];
    const text = result[0].transcript;
    const isFinal = result.isFinal;

    debugLog(`onresult: "${text}" final=${isFinal}`);

    if (isFinal) {
      // 確定したテキストを蓄積に追加
      accumulatedTranscript = (accumulatedTranscript + ' ' + text).trim();
      currentTranscript = accumulatedTranscript;
      interimTranscript = '';
    } else {
      interimTranscript = text;
    }
    updateLiveDisplay();
  };

  rec.onerror = (event) => {
    debugLog(`onerror: ${event.error}`);
    if (event.error === 'no-speech') {
      // 無音でもrecordingを続ける（onendで再起動される）
      return;
    }
    if (event.error === 'aborted') return;
    if (event.error === 'not-allowed') {
      showToast('マイクの許可が必要です');
      stopRecording(false);
    }
  };

  rec.onend = () => {
    debugLog(`onend: isRecording=${isRecording} accumulated="${accumulatedTranscript}"`);
    if (isRecording) {
      // 少し待ってから再起動（音声バッファが残って重複するのを防ぐ）
      setTimeout(() => {
        if (!isRecording) return;
        try {
          rec.start();
          debugLog('restarted recognition');
        } catch (e) {
          debugLog(`restart failed: ${e.message}`);
          // 新しいインスタンスで再試行
          recognition = initRecognition();
          if (recognition) {
            try { recognition.start(); } catch {}
          }
        }
      }, 300);
    }
  };

  return rec;
}

function countWords(text) {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

// 繰り返しフレーズを除去する（端末の音声認識エンジンが重複出力するケース対策）
function deduplicateTranscript(text) {
  if (!text.trim()) return text;
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return text;

  // 連続する同一フレーズを検出（1〜8語のパターンをチェック）
  for (let patLen = 1; patLen <= Math.min(8, Math.floor(words.length / 2)); patLen++) {
    const pattern = words.slice(0, patLen).join(' ').toLowerCase();
    let pos = 0;
    let count = 0;

    while (pos + patLen <= words.length) {
      const chunk = words.slice(pos, pos + patLen).join(' ').toLowerCase();
      if (chunk === pattern) {
        count++;
        pos += patLen;
      } else {
        break;
      }
    }

    // 同じフレーズが2回以上連続していたら、1回だけ残して残りを結合
    if (count >= 2) {
      const deduped = words.slice(0, patLen).join(' ') + ' ' + words.slice(count * patLen).join(' ');
      debugLog(`dedup: removed ${count - 1} repeats of "${pattern}"`);
      return deduplicateTranscript(deduped.trim()); // 再帰的にチェック
    }
  }

  return text.trim();
}

function updateLiveDisplay() {
  const fullText = deduplicateTranscript((currentTranscript + ' ' + interimTranscript).trim());
  const count = countWords(fullText);
  document.getElementById('live-word-count').textContent = count;

  const preview = document.getElementById('transcript-preview');
  if (currentTranscript || interimTranscript) {
    preview.innerHTML = escapeHtml(currentTranscript) +
      (interimTranscript ? '<span style="color:#666">' + escapeHtml(interimTranscript) + '</span>' : '');
    preview.scrollTop = preview.scrollHeight;
  }

  updateGoalProgress();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Timer =====
function updateTimer() {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const sec = String(elapsed % 60).padStart(2, '0');
  document.getElementById('timer').textContent = `${min}:${sec}`;
}

// ===== Recording =====
function startRecording() {
  recognition = initRecognition();
  if (!recognition) return;

  isRecording = true;
  currentTranscript = '';
  accumulatedTranscript = '';
  interimTranscript = '';
  startTime = Date.now();

  const btn = document.getElementById('btn-record');
  btn.classList.add('recording');
  btn.querySelector('.btn-record-icon').textContent = '⏹️';
  btn.querySelector('.btn-record-label').textContent = 'タップして停止';

  document.getElementById('transcript-preview').innerHTML = '';
  document.getElementById('live-word-count').textContent = '0';
  document.getElementById('timer').textContent = '00:00';

  timerInterval = setInterval(updateTimer, 1000);

  try {
    recognition.start();
    debugLog('recognition started');
  } catch (e) {
    debugLog(`start failed: ${e.message}`);
    showToast('音声認識を開始できませんでした');
    stopRecording(false);
  }
}

function stopRecording(shouldSave = true) {
  isRecording = false;

  if (recognition) {
    recognition.onend = null; // Prevent auto-restart
    try { recognition.stop(); } catch {}
    recognition = null;
  }

  clearInterval(timerInterval);
  timerInterval = null;

  const btn = document.getElementById('btn-record');
  btn.classList.remove('recording');
  btn.querySelector('.btn-record-icon').textContent = '🎤';
  btn.querySelector('.btn-record-label').textContent = 'タップして開始';

  // 停止時、interimに残ってるテキストもcurrentTranscriptに合流させる
  if (interimTranscript.trim()) {
    currentTranscript = (currentTranscript + ' ' + interimTranscript).trim();
    interimTranscript = '';
  }

  // 重複フレーズを除去
  currentTranscript = deduplicateTranscript(currentTranscript);

  debugLog(`stopRecording: save=${shouldSave} transcript="${currentTranscript}"`);

  if (shouldSave && currentTranscript.trim()) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const wordCount = countWords(currentTranscript);

    const entry = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      words: wordCount,
      seconds: elapsed,
      transcript: currentTranscript.trim()
    };

    const data = loadData();
    data.unshift(entry);
    saveData(data);

    showToast(`保存しました: ${wordCount}語 / ${formatDuration(elapsed)}`);
    updateGoalProgress();
  } else if (shouldSave) {
    showToast('音声が検出されませんでした');
  }

  startTime = null;
}

document.getElementById('btn-record').addEventListener('click', () => {
  if (isRecording) {
    stopRecording(true);
  } else {
    startRecording();
  }
});

// ===== Goal Progress =====
function updateGoalProgress() {
  const settings = loadSettings();
  const goal = settings.dailyGoal;
  const todayWords = getTodayWords();

  const progressBar = document.getElementById('progress-bar');
  const goalStatus = document.getElementById('goal-status');

  if (!goal || goal <= 0) {
    progressBar.style.width = '0%';
    goalStatus.textContent = '目標: 未設定（設定タブから設定できます）';
    return;
  }

  const percent = Math.min(100, Math.round((todayWords / goal) * 100));
  progressBar.style.width = percent + '%';

  if (todayWords >= goal) {
    goalStatus.textContent = `🎉 目標達成！ ${todayWords} / ${goal} 語`;
    goalStatus.style.color = 'var(--accent)';
  } else {
    const remaining = goal - todayWords;
    goalStatus.textContent = `${todayWords} / ${goal} 語（あと ${remaining} 語）`;
    goalStatus.style.color = 'var(--text-secondary)';
  }
}

function getTodayWords() {
  const data = loadData();
  const today = new Date().toDateString();
  return data
    .filter(e => new Date(e.date).toDateString() === today)
    .reduce((sum, e) => sum + e.words, 0);
}

// ===== History =====
function renderHistory() {
  const data = loadData();
  const body = document.getElementById('history-body');
  const noHistory = document.getElementById('no-history');

  if (data.length === 0) {
    body.innerHTML = '';
    noHistory.style.display = 'block';
    return;
  }

  noHistory.style.display = 'none';
  body.innerHTML = data.map(entry => {
    const d = new Date(entry.date);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}<br><span style="color:var(--text-secondary);font-size:0.75rem">${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
    const shortTranscript = entry.transcript.length > 80
      ? entry.transcript.substring(0, 80) + '...'
      : entry.transcript;
    return `<tr data-id="${entry.id}" style="cursor:pointer">
      <td>${dateStr}</td>
      <td>${entry.words}</td>
      <td>${formatDuration(entry.seconds)}</td>
      <td title="${escapeHtml(entry.transcript)}">${escapeHtml(shortTranscript)}</td>
    </tr>`;
  }).join('');

  // Click to expand
  body.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => {
      const entry = data.find(e => e.id === row.dataset.id);
      if (entry) showEntryModal(entry);
    });
  });
}

function showEntryModal(entry) {
  const d = new Date(entry.date);
  const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${dateStr}</h3>
      <p><strong>${entry.words}</strong> 語 / <strong>${formatDuration(entry.seconds)}</strong></p>
      <p>${escapeHtml(entry.transcript)}</p>
      <div class="modal-actions">
        <button class="btn-danger" id="modal-delete">削除</button>
        <button class="btn-secondary" id="modal-close">閉じる</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#modal-delete').addEventListener('click', () => {
    const data = loadData();
    const filtered = data.filter(e => e.id !== entry.id);
    saveData(filtered);
    overlay.remove();
    renderHistory();
    showToast('削除しました');
  });
}

// ===== Stats =====
function renderStats() {
  const data = loadData();
  const today = new Date().toDateString();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  // Cards
  const todayWords = data
    .filter(e => new Date(e.date).toDateString() === today)
    .reduce((sum, e) => sum + e.words, 0);

  const weekWords = data
    .filter(e => new Date(e.date) >= weekAgo)
    .reduce((sum, e) => sum + e.words, 0);

  const totalSeconds = data.reduce((sum, e) => sum + e.seconds, 0);

  document.getElementById('stat-today-words').textContent = todayWords.toLocaleString();
  document.getElementById('stat-week-words').textContent = weekWords.toLocaleString();
  document.getElementById('stat-total-sessions').textContent = data.length;
  document.getElementById('stat-total-time').textContent = formatDuration(totalSeconds);

  // Chart
  renderChart(currentChartPeriod);
}

function renderChart(days) {
  const data = loadData();
  const labels = [];
  const values = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toDateString();
    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    labels.push(dayLabel);

    const dayWords = data
      .filter(e => new Date(e.date).toDateString() === dateStr)
      .reduce((sum, e) => sum + e.words, 0);
    values.push(dayWords);
  }

  const ctx = document.getElementById('words-chart').getContext('2d');
  const settings = loadSettings();

  if (chart) chart.destroy();

  const goalLine = settings.dailyGoal > 0
    ? [{
        type: 'line',
        yMin: settings.dailyGoal,
        yMax: settings.dailyGoal,
        borderColor: 'rgba(255, 107, 107, 0.6)',
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: `目標: ${settings.dailyGoal}`,
          position: 'start',
          color: 'rgba(255, 107, 107, 0.8)',
          font: { size: 11 }
        }
      }]
    : [];

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(v =>
          settings.dailyGoal > 0 && v >= settings.dailyGoal
            ? 'rgba(0, 212, 170, 0.7)'
            : 'rgba(108, 99, 255, 0.7)'
        ),
        borderRadius: 6,
        barPercentage: 0.6,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        annotation: goalLine.length > 0 ? { annotations: { goal: goalLine[0] } } : undefined
      },
      scales: {
        x: {
          ticks: { color: '#9999AA', font: { size: 11 } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#9999AA' },
          grid: { color: 'rgba(42, 42, 64, 0.5)' }
        }
      }
    }
  });
}

// Chart period selector
document.querySelectorAll('.chart-period').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-period').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartPeriod = parseInt(btn.dataset.period);
    renderChart(currentChartPeriod);
  });
});

// ===== Settings =====
document.getElementById('btn-save-goal').addEventListener('click', () => {
  const input = document.getElementById('daily-goal');
  const goal = parseInt(input.value) || 0;
  const settings = loadSettings();
  settings.dailyGoal = goal;
  saveSettings(settings);
  updateGoalProgress();
  showToast(goal > 0 ? `目標を ${goal} 語に設定しました` : '目標をクリアしました');
});

document.getElementById('btn-export').addEventListener('click', () => {
  const data = loadData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `english-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('エクスポートしました');
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (confirm('全てのデータを削除しますか？この操作は取り消せません。')) {
    saveData([]);
    showToast('全データを削除しました');
    updateGoalProgress();
  }
});

// Load saved goal into input
const savedSettings = loadSettings();
if (savedSettings.dailyGoal > 0) {
  document.getElementById('daily-goal').value = savedSettings.dailyGoal;
}

// ===== Helpers =====
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min < 60) return sec > 0 ? `${min}分${sec}秒` : `${min}分`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}時間${remainMin}分`;
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ===== Init =====
updateGoalProgress();

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
