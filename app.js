import { Midi } from 'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm';

// ─── State ─────────────────────────────────────────────

let midiAccess = null;
let selectedOutput = null;
let midiData = null;
let allNotes = [];
let allCCs = [];
let allPitchBends = [];
let totalDuration = 0;

let isPlaying = false;
let isPaused = false;
let startTime = 0;
let elapsedAtPause = 0;
let tempoScale = 1;
let scheduledEvents = [];
let activeNotes = new Set();
let animFrameId = null;

// ─── DOM ───────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dom = {
  statusDot:    $('statusDot'),
  statusText:   $('statusText'),
  deviceSelect: $('deviceSelect'),
  refreshBtn:   $('refreshBtn'),
  fileDrop:     $('fileDrop'),
  fileInput:    $('fileInput'),
  trackSection: $('trackSection'),
  trackInfo:    $('trackInfo'),
  emptyState:   $('emptyState'),
  canvas:       $('pianoRoll'),
  playBtn:      $('playBtn'),
  stopBtn:      $('stopBtn'),
  playIcon:     $('playIcon'),
  currentTime:  $('currentTime'),
  totalTime:    $('totalTime'),
  progressTrack: $('progressTrack'),
  progressFill: $('progressFill'),
  volumeSlider: $('volumeSlider'),
  volumeValue:  $('volumeValue'),
  tempoSlider:  $('tempoSlider'),
  tempoValue:   $('tempoValue'),
  infoBtn:      $('infoBtn'),
  infoModal:    $('infoModal'),
  modalClose:   $('modalClose'),
  composerSelect: $('composerSelect'),
  songList:     $('songList'),
  toast:        $('toast'),
};

const ctx = dom.canvas.getContext('2d');

// ─── Utilities ─────────────────────────────────────────

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let toastTimer;
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2500);
}

function getElapsed() {
  if (!isPlaying) return elapsedAtPause;
  return (performance.now() - startTime) * tempoScale;
}

// ─── MIDI Access ───────────────────────────────────────

async function initMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    dom.statusDot.className = 'status-dot connected';
    dom.statusText.textContent = 'MIDI Ready';
    populateDevices();
    midiAccess.onstatechange = () => populateDevices();
  } catch {
    dom.statusDot.className = 'status-dot error';
    dom.statusText.textContent = 'MIDI Denied';
    showToast('MIDI access denied — check browser permissions');
  }
}

function populateDevices() {
  const prev = dom.deviceSelect.value;
  dom.deviceSelect.innerHTML = '<option value="">— Select Device —</option>';

  for (const [id, output] of midiAccess.outputs) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = output.name;
    dom.deviceSelect.appendChild(opt);
  }

  if (prev && midiAccess.outputs.has(prev)) {
    dom.deviceSelect.value = prev;
    selectedOutput = midiAccess.outputs.get(prev);
  }

  if (midiAccess.outputs.size === 1) {
    const [id, output] = [...midiAccess.outputs][0];
    dom.deviceSelect.value = id;
    selectedOutput = output;
    showToast(`Connected to ${output.name}`);
  }
}

// ─── MIDI Send ─────────────────────────────────────────

function allNotesOff() {
  if (!selectedOutput) return;
  for (const note of activeNotes) {
    selectedOutput.send([0x80, note, 0]);
  }
  activeNotes.clear();

  for (let ch = 0; ch < 16; ch++) {
    selectedOutput.send([0xB0 | ch, 123, 0]);  // All notes off
    selectedOutput.send([0xB0 | ch, 64, 0]);   // Sustain pedal off
    selectedOutput.send([0xB0 | ch, 66, 0]);   // Sostenuto off
    selectedOutput.send([0xB0 | ch, 67, 0]);   // Soft pedal off
    selectedOutput.send([0xE0 | ch, 0, 64]);   // Pitch bend center
  }
}

// ─── MIDI File Processing ──────────────────────────────

function processMidi() {
  allNotes = [];
  allCCs = [];
  allPitchBends = [];

  for (let ti = 0; ti < midiData.tracks.length; ti++) {
    const track = midiData.tracks[ti];
    const channel = track.channel !== undefined ? track.channel : ti;

    for (const note of track.notes) {
      allNotes.push({
        midi: note.midi,
        time: note.time,
        duration: note.duration,
        velocity: note.velocity,
        channel,
        name: note.name,
      });
    }

    if (track.controlChanges) {
      for (const [ccNum, events] of Object.entries(track.controlChanges)) {
        for (const ev of events) {
          allCCs.push({
            time: ev.time,
            cc: parseInt(ccNum),
            value: ev.value,
            channel,
          });
        }
      }
    }

    if (track.pitchBends?.length > 0) {
      for (const pb of track.pitchBends) {
        allPitchBends.push({
          time: pb.time,
          value: pb.value,
          channel,
        });
      }
    }
  }

  allNotes.sort((a, b) => a.time - b.time);
  allCCs.sort((a, b) => a.time - b.time);
  allPitchBends.sort((a, b) => a.time - b.time);

  totalDuration = 0;
  for (const n of allNotes) {
    const end = n.time + n.duration;
    if (end > totalDuration) totalDuration = end;
  }
  for (const cc of allCCs) {
    if (cc.time > totalDuration) totalDuration = cc.time;
  }
  totalDuration += 0.5;
  dom.totalTime.textContent = formatTime(totalDuration);
  buildEventList();

  // Debug: log timing gaps between first 20 notes to verify rubato
  if (allNotes.length > 1) {
    const gaps = [];
    for (let i = 1; i < Math.min(21, allNotes.length); i++) {
      gaps.push(Math.round((allNotes[i].time - allNotes[i-1].time) * 1000));
    }
    console.log('Note gaps (ms), first 20:', gaps.join(', '));
    const unique = new Set(gaps);
    if (unique.size <= 3) {
      console.warn('Very uniform timing — likely quantized');
    } else {
      console.log('Varied timing — expressive performance');
    }
  }
}

function showTrackInfo(filename) {
  dom.trackSection.style.display = 'block';
  const name = midiData.name || filename.replace(/\.(mid|midi)$/i, '');
  const trackCount = midiData.tracks.filter(t => t.notes.length > 0).length;
  const noteCount = allNotes.length;
  const ccCount = allCCs.length;
  const hasPedal = allCCs.some(c => c.cc === 64);
  const tempos = midiData.header.tempos;
  const bpm = tempos.length > 0 ? Math.round(tempos[0].bpm) : 120;
  const tempoChanges = tempos.length;

  dom.trackInfo.innerHTML = `
    <div class="track-name">${escHtml(name)}</div>
    <div><span class="label">Tracks</span> <span class="value">${trackCount}</span></div>
    <div><span class="label">Notes</span> <span class="value">${noteCount.toLocaleString()}</span></div>
    <div><span class="label">CC Events</span> <span class="value">${ccCount.toLocaleString()}</span></div>
    <div><span class="label">Pedal</span> <span class="value">${hasPedal ? 'Yes' : 'No'}</span></div>
    <div><span class="label">BPM</span> <span class="value">${bpm}</span></div>
    <div><span class="label">Tempo Chg</span> <span class="value">${tempoChanges}</span></div>
    <div><span class="label">Duration</span> <span class="value">${formatTime(totalDuration)}</span></div>
  `;

  const rubatoMsg = tempoChanges <= 1
    ? 'Quantized — no rubato'
    : `${tempoChanges} tempo changes — rubato present`;

  dom.trackInfo.innerHTML += `
    <div><span class="label">Expression</span> <span class="value ${tempoChanges <= 1 ? 'warn' : 'good'}">${rubatoMsg}</span></div>
  `;
}

async function loadFile(file) {
  stopPlayback();
  try {
    const buf = await file.arrayBuffer();
    midiData = new Midi(buf);
    processMidi();
    showTrackInfo(file.name);
    dom.emptyState.classList.add('hidden');
    dom.playBtn.disabled = false;
    dom.stopBtn.disabled = false;
    drawPianoRoll();
    showToast(`Loaded: ${file.name}`);
  } catch (e) {
    showToast('Error parsing MIDI file');
    console.error(e);
  }
}

// ─── Playback Scheduling (timestamp-based) ────────────
//
// Instead of setTimeout (which has ~4-16ms jitter), we use
// a lookahead scheduler. Every ~25ms, we scan ahead by
// LOOKAHEAD_MS and send MIDI messages with precise
// DOMHighResTimestamps via output.send(data, timestamp).
// The Web MIDI API queues these with sub-ms precision.

const LOOKAHEAD_MS = 100;   // how far ahead to schedule
const SCHEDULER_MS = 25;    // how often the scheduler runs

let schedulerTimer = null;
let noteIndex = 0;          // cursor into allNotes
let ccIndex = 0;            // cursor into allCCs
let pbIndex = 0;            // cursor into allPitchBends

// Build a flat timeline of all MIDI events for efficient scanning
let allEvents = [];

function buildEventList() {
  allEvents = [];

  for (const note of allNotes) {
    allEvents.push({
      time: note.time,
      type: 'note_on',
      data: [0x90 | (note.channel & 0x0F), note.midi, Math.round(note.velocity * 127)],
      midi: note.midi,
    });
    allEvents.push({
      time: note.time + note.duration,
      type: 'note_off',
      data: [0x80 | (note.channel & 0x0F), note.midi, 0],
      midi: note.midi,
    });
  }

  for (const cc of allCCs) {
    allEvents.push({
      time: cc.time,
      type: 'cc',
      data: [0xB0 | (cc.channel & 0x0F), cc.cc, Math.round(cc.value * 127)],
    });
  }

  for (const pb of allPitchBends) {
    const intVal = Math.round((pb.value + 1) * 0.5 * 16383);
    allEvents.push({
      time: pb.time,
      type: 'pb',
      data: [0xE0 | (pb.channel & 0x0F), intVal & 0x7F, (intVal >> 7) & 0x7F],
    });
  }

  // Sort by time, with note_off before note_on at same time
  allEvents.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.type === 'note_off' && b.type === 'note_on') return -1;
    if (a.type === 'note_on' && b.type === 'note_off') return 1;
    return 0;
  });
}

let eventCursor = 0;

function schedulerTick() {
  if (!isPlaying || !selectedOutput) return;

  const now = performance.now();
  const elapsedMs = (now - startTime) * tempoScale;
  const lookAheadUntil = elapsedMs + LOOKAHEAD_MS * tempoScale;

  while (eventCursor < allEvents.length) {
    const ev = allEvents[eventCursor];
    const evTimeMs = ev.time * 1000;

    if (evTimeMs > lookAheadUntil) break;

    // Calculate the precise DOMHighResTimestamp for this event
    const sendAt = startTime + (evTimeMs / tempoScale);

    if (sendAt >= now - 1) {
      // Schedule with precise timestamp
      selectedOutput.send(ev.data, Math.max(now, sendAt));
    }
    // else: event is in the past, skip

    if (ev.type === 'note_on') activeNotes.add(ev.midi);
    if (ev.type === 'note_off') activeNotes.delete(ev.midi);

    eventCursor++;
  }

  // Check if we've reached the end
  if (elapsedMs >= totalDuration * 1000) {
    stopPlayback();
  }
}

function startScheduler() {
  eventCursor = 0;
  const elapsedMs = getElapsed();

  // Advance cursor past already-elapsed events
  while (eventCursor < allEvents.length && allEvents[eventCursor].time * 1000 <= elapsedMs) {
    eventCursor++;
  }

  // Run immediately, then on interval
  schedulerTick();
  schedulerTimer = setInterval(schedulerTick, SCHEDULER_MS);
}

function stopScheduler() {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ─── Transport Controls ───────────────────────────────

function updatePlayIcon() {
  if (isPlaying) {
    dom.playIcon.innerHTML = '<rect x="2" y="1" width="3.5" height="12" rx="0.5"/><rect x="8.5" y="1" width="3.5" height="12" rx="0.5"/>';
    dom.playBtn.classList.add('active');
  } else {
    dom.playIcon.innerHTML = '<polygon points="3,1 13,7 3,13"/>';
    dom.playBtn.classList.remove('active');
  }
}

function startPlayback() {
  if (!midiData || !selectedOutput) {
    if (!selectedOutput) showToast('Select an output device first');
    return;
  }

  if (isPaused) {
    isPaused = false;
    isPlaying = true;
    startTime = performance.now() - (elapsedAtPause / tempoScale);
    startScheduler();
    updatePlayIcon();
    tick();
    return;
  }

  stopPlayback();
  isPlaying = true;
  startTime = performance.now();
  elapsedAtPause = 0;
  startScheduler();
  updatePlayIcon();
  tick();
}

function pausePlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  isPaused = true;
  elapsedAtPause = getElapsed();
  stopScheduler();
  allNotesOff();
  updatePlayIcon();
  if (animFrameId) cancelAnimationFrame(animFrameId);
}

function stopPlayback() {
  isPlaying = false;
  isPaused = false;
  elapsedAtPause = 0;
  stopScheduler();
  allNotesOff();
  updatePlayIcon();
  if (animFrameId) cancelAnimationFrame(animFrameId);
  dom.currentTime.textContent = '0:00';
  dom.progressFill.style.width = '0%';
  drawPianoRoll(0);
}

function seekTo(ratio) {
  if (!midiData) return;
  const seekMs = ratio * totalDuration * 1000;
  const wasPlaying = isPlaying;

  stopPlayback();
  elapsedAtPause = seekMs;
  isPaused = true;
  dom.currentTime.textContent = formatTime(seekMs / 1000);
  dom.progressFill.style.width = (ratio * 100) + '%';
  drawPianoRoll(seekMs / 1000);

  if (wasPlaying) startPlayback();
}

// ─── Animation Loop ───────────────────────────────────

function tick() {
  if (!isPlaying) return;
  const elapsed = getElapsed() / 1000;
  const ratio = Math.min(1, elapsed / totalDuration);

  dom.currentTime.textContent = formatTime(elapsed);
  dom.progressFill.style.width = (ratio * 100) + '%';
  drawPianoRoll(elapsed);

  if (elapsed >= totalDuration) {
    stopPlayback();
    return;
  }
  animFrameId = requestAnimationFrame(tick);
}

// ─── Piano Roll Renderer ──────────────────────────────

const PIXELS_PER_SECOND = 120;

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function drawPianoRoll(currentTime = 0) {
  const dpr = window.devicePixelRatio || 1;
  const rect = dom.canvas.parentElement.getBoundingClientRect();
  dom.canvas.width = rect.width * dpr;
  dom.canvas.height = rect.height * dpr;
  dom.canvas.style.width = rect.width + 'px';
  dom.canvas.style.height = rect.height + 'px';
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;

  ctx.fillStyle = '#111010';
  ctx.fillRect(0, 0, W, H);

  if (allNotes.length === 0) return;

  let minNote = 127, maxNote = 0;
  for (const n of allNotes) {
    if (n.midi < minNote) minNote = n.midi;
    if (n.midi > maxNote) maxNote = n.midi;
  }
  minNote = Math.max(0, minNote - 3);
  maxNote = Math.min(127, maxNote + 3);
  const noteRange = maxNote - minNote + 1;
  const noteH = Math.max(3, Math.min(12, H / noteRange));

  const playheadX = W * 0.25;
  const timeOffset = currentTime - (playheadX / PIXELS_PER_SECOND);

  // Octave grid lines
  ctx.strokeStyle = '#1a1918';
  ctx.lineWidth = 1;
  for (let n = minNote; n <= maxNote; n++) {
    if (n % 12 === 0) {
      const y = H - ((n - minNote + 0.5) / noteRange) * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }

  // Black key bands
  const blackKeys = [1, 3, 6, 8, 10];
  ctx.fillStyle = '#0e0d0c';
  for (let n = minNote; n <= maxNote; n++) {
    if (blackKeys.includes(n % 12)) {
      const y = H - ((n - minNote + 1) / noteRange) * H;
      ctx.fillRect(0, y, W, noteH);
    }
  }

  // Notes
  for (const note of allNotes) {
    const x = (note.time - timeOffset) * PIXELS_PER_SECOND;
    const w = note.duration * PIXELS_PER_SECOND;

    if (x + w < -10 || x > W + 10) continue;

    const y = H - ((note.midi - minNote + 1) / noteRange) * H;
    const isActive = note.time <= currentTime && (note.time + note.duration) > currentTime;

    if (isActive) {
      ctx.fillStyle = '#f0c060';
      ctx.shadowColor = '#d4a04a66';
      ctx.shadowBlur = 8;
    } else if (note.time < currentTime) {
      ctx.fillStyle = '#3a332a';
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#8a7040';
      ctx.shadowBlur = 0;
    }

    const r = Math.min(2, noteH / 2);
    roundRect(ctx, x, y, Math.max(2, w - 1), noteH - 1, r);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Playhead
  if (isPlaying || isPaused) {
    ctx.strokeStyle = '#d4a04a';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#d4a04a44';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, H);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#d4a04a';
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX, 7);
    ctx.closePath();
    ctx.fill();
  }
}

// ─── Event Binding ────────────────────────────────────

dom.deviceSelect.addEventListener('change', () => {
  if (dom.deviceSelect.value) {
    selectedOutput = midiAccess.outputs.get(dom.deviceSelect.value);
    showToast(`Connected to ${selectedOutput.name}`);
  } else {
    selectedOutput = null;
  }
});

dom.refreshBtn.addEventListener('click', () => {
  populateDevices();
  showToast('Devices refreshed');
});

dom.fileDrop.addEventListener('dragover', e => {
  e.preventDefault();
  dom.fileDrop.classList.add('drag-over');
});
dom.fileDrop.addEventListener('dragleave', () => dom.fileDrop.classList.remove('drag-over'));
dom.fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  dom.fileDrop.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
dom.fileInput.addEventListener('change', () => {
  if (dom.fileInput.files[0]) loadFile(dom.fileInput.files[0]);
});

dom.playBtn.addEventListener('click', () => {
  if (isPlaying) pausePlayback();
  else startPlayback();
});

dom.stopBtn.addEventListener('click', stopPlayback);

dom.progressTrack.addEventListener('click', e => {
  const rect = dom.progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekTo(ratio);
});

dom.volumeSlider.addEventListener('input', () => {
  const vol = parseInt(dom.volumeSlider.value);
  dom.volumeValue.textContent = vol;
  if (!selectedOutput) return;
  for (let ch = 0; ch < 16; ch++) {
    selectedOutput.send([0xB0 | ch, 7, vol]);
  }
});

dom.tempoSlider.addEventListener('input', () => {
  const pct = parseInt(dom.tempoSlider.value);
  tempoScale = pct / 100;
  dom.tempoValue.textContent = pct + '%';

  if (isPlaying) {
    const elapsed = getElapsed();
    stopScheduler();
    allNotesOff();
    startTime = performance.now() - (elapsed / tempoScale);
    startScheduler();
  }
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    if (isPlaying) pausePlayback();
    else if (midiData) startPlayback();
  }
  if (e.code === 'Escape') stopPlayback();
});

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (midiData) drawPianoRoll(getElapsed() / 1000);
  }, 50);
});

// ─── Safety: clean up on page unload ──────────────────

function panicReset() {
  if (!selectedOutput) return;
  stopScheduler();
  for (const note of activeNotes) {
    selectedOutput.send([0x80, note, 0]);
  }
  for (let ch = 0; ch < 16; ch++) {
    selectedOutput.send([0xB0 | ch, 123, 0]);  // All notes off
    selectedOutput.send([0xB0 | ch, 120, 0]);  // All sound off
    selectedOutput.send([0xB0 | ch, 64, 0]);   // Sustain off
    selectedOutput.send([0xB0 | ch, 66, 0]);   // Sostenuto off
    selectedOutput.send([0xB0 | ch, 67, 0]);   // Soft pedal off
    selectedOutput.send([0xE0 | ch, 0, 64]);   // Pitch bend center
  }
}

window.addEventListener('beforeunload', panicReset);

// ─── Library ──────────────────────────────────────────

let catalog = [];
let activeSongEl = null;

async function loadCatalog() {
  try {
    const res = await fetch('catalog.json');
    catalog = await res.json();
    populateComposers();
  } catch {
    // No catalog available — library section just stays empty
  }
}

function populateComposers() {
  const composers = new Map();
  for (const entry of catalog) {
    composers.set(entry.composer, (composers.get(entry.composer) || 0) + 1);
  }

  // Sort by count descending
  const sorted = [...composers.entries()].sort((a, b) => b[1] - a[1]);

  for (const [name, count] of sorted) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${count})`;
    dom.composerSelect.appendChild(opt);
  }
}

function showSongs(composer) {
  dom.songList.innerHTML = '';
  if (!composer) {
    dom.songList.innerHTML = '<div class="song-list-empty">Select a composer</div>';
    return;
  }

  const songs = catalog.filter(s => s.composer === composer);
  songs.sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));

  for (const song of songs) {
    const btn = document.createElement('button');
    btn.className = 'song-item';
    btn.innerHTML = `
      <span class="song-title">${escHtml(song.title)}</span>
      <span class="song-duration">${song.year} · ${formatTime(song.duration)}</span>
    `;
    btn.addEventListener('click', () => loadFromCatalog(song, btn));
    dom.songList.appendChild(btn);
  }
}

async function loadFromCatalog(song, btnEl) {
  stopPlayback();
  showToast(`Loading: ${song.title}...`);

  try {
    const res = await fetch(song.file);
    const buf = await res.arrayBuffer();
    midiData = new Midi(buf);
    processMidi();
    showTrackInfo(`${song.composer} — ${song.title}`);
    dom.emptyState.classList.add('hidden');
    dom.playBtn.disabled = false;
    dom.stopBtn.disabled = false;
    drawPianoRoll();
    showToast(`${song.composer} — ${song.title}`);

    // Highlight active song
    if (activeSongEl) activeSongEl.classList.remove('active');
    btnEl.classList.add('active');
    activeSongEl = btnEl;
  } catch (e) {
    showToast('Error loading MIDI file');
    console.error(e);
  }
}

dom.infoBtn.addEventListener('click', () => dom.infoModal.classList.add('show'));
dom.modalClose.addEventListener('click', () => dom.infoModal.classList.remove('show'));
dom.infoModal.addEventListener('click', e => {
  if (e.target === dom.infoModal) dom.infoModal.classList.remove('show');
});

dom.composerSelect.addEventListener('change', () => {
  showSongs(dom.composerSelect.value);
});

// ─── Init ─────────────────────────────────────────────

initMIDI();
loadCatalog();
drawPianoRoll();
