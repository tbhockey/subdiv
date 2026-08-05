(function () {
  "use strict";

  var SUBDIVISIONS = [
    { name: "Half note",      mult: 2,     freq: 640 },
    { name: "Dotted quarter", mult: 1.5,   freq: 760 },
    { name: "Quarter note",   mult: 1,     freq: 900 },
    { name: "Quarter triplet",mult: 2 / 3, freq: 1060 },
    { name: "Dotted 8th",     mult: 0.75,  freq: 1250 },
    { name: "8th note",       mult: 0.5,   freq: 1480 },
    { name: "8th triplet",    mult: 1 / 3, freq: 1750 }
  ];

  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';

  var rowsEl = document.getElementById("rows");
  var bpmInput = document.getElementById("bpm");
  var rows = [];

  SUBDIVISIONS.forEach(function (sd) {
    var row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<div class="name-cell">' +
        '<span class="led"></span>' +
        '<span class="name-text">' +
          '<span class="name">' + sd.name + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="bpm-cell"><span class="bpm-val">0</span><span class="u">bpm</span></div>' +
      '<div class="ms-cell"><span class="ms-val">0</span><span class="u">ms</span></div>' +
      '<button type="button" class="play" aria-label="Play metronome for ' + sd.name + '">' + PLAY_SVG + '</button>';

    rowsEl.appendChild(row);
    var rec = {
      el: row,
      name: sd.name,
      mult: sd.mult,
      freq: sd.freq,
      led: row.querySelector(".led"),
      bpmVal: row.querySelector(".bpm-val"),
      msVal: row.querySelector(".ms-val"),
      btn: row.querySelector(".play"),
      rate: 0,      // exact bpm for this row (unrounded — display rounds)
      playing: false,
      beat: 0,      // beat index on the shared grid
      ledTimer: null
    };
    rec.btn.setAttribute("aria-pressed", "false");
    rows.push(rec);
    rec.btn.addEventListener("click", function () { toggle(rec); });
  });

  var lastSong = null;

  function recalc() {
    var song = clampBpm(parseFloat(bpmInput.value) || 0);
    rows.forEach(function (r) {
      r.rate = song / r.mult;
      r.bpmVal.textContent = Math.round(r.rate);
      r.msVal.textContent = r.rate > 0 ? Math.round(60000 / r.rate) : 0;
    });
    // Rates take effect immediately; only the grid re-lay is debounced,
    // so typing "140" costs one gap instead of one per keystroke.
    if (song !== lastSong && playCount > 0) scheduleReanchor();
    lastSong = song;
  }

  function clampBpm(v) {
    if (!v || v < 20) return v < 20 && v > 0 ? v : 20;
    if (v > 400) return 400;
    return v;
  }

  bpmInput.addEventListener("input", recalc);
  bpmInput.addEventListener("change", function () {
    var v = Math.round(clampBpm(parseFloat(bpmInput.value) || 120));
    bpmInput.value = v;
    recalc();
  });
  document.getElementById("up").addEventListener("click", function () { nudge(1); });
  document.getElementById("down").addEventListener("click", function () { nudge(-1); });
  function nudge(d) {
    bpmInput.value = Math.round(clampBpm((parseFloat(bpmInput.value) || 120) + d));
    recalc();
  }

  /* ---------- Tap tempo (set the song BPM by ear) ---------- */
  var tapBtn = document.getElementById("tap");
  var tapTimes = [];
  var tapReset = null;
  tapBtn.addEventListener("click", function () {
    var now = performance.now();
    if (tapReset) clearTimeout(tapReset);
    tapReset = setTimeout(function () { tapTimes = []; }, 2000);
    tapTimes.push(now);
    if (tapTimes.length > 6) tapTimes.shift();
    if (tapTimes.length >= 2) {
      var intervals = 0;
      for (var i = 1; i < tapTimes.length; i++) intervals += tapTimes[i] - tapTimes[i - 1];
      var avg = intervals / (tapTimes.length - 1);
      var bpm = Math.round(clampBpm(60000 / avg));
      bpmInput.value = bpm;
      recalc();
    }
    tapBtn.classList.add("lit");
    setTimeout(function () { tapBtn.classList.remove("lit"); }, 110);
  });

  /* ---------- Metronome (Web Audio, lookahead scheduler) ---------- */
  var audioCtx = null;
  var masterGain = null;
  var playCount = 0;
  var gridOrigin = 0;       // audio-clock time of the shared downbeat
  var timerId = null;
  var LOOKAHEAD = 25;       // ms, how often the scheduler runs
  var SCHEDULE_AHEAD = 0.1; // s, how far ahead to schedule audio
  var REANCHOR_DEBOUNCE = 200; // ms of tempo quiet before re-laying the grid
  var reanchorTimer = null;

  var transportEl = document.getElementById("transport");
  var playingCountEl = document.getElementById("playingCount");
  document.getElementById("stopAll").addEventListener("click", stopAll);

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  function toggle(r) {
    if (r.playing) stop(r); else start(r);
  }

  function start(r) {
    if (r.playing || !r.rate) return;
    ensureAudio();

    var now = audioCtx.currentTime;
    if (playCount === 0) gridOrigin = now + 0.08;

    r.playing = true;
    playCount++;
    // Join the grid at its next beat, so this row lands in phase with whatever is already running.
    r.beat = beatIndexAt(r, Math.max(gridOrigin, now + 0.02));

    r.el.classList.add("active");
    r.btn.innerHTML = STOP_SVG;
    r.btn.setAttribute("aria-label", "Stop metronome for " + r.name);
    r.btn.setAttribute("aria-pressed", "true");

    updateMaster();
    updateTransport();
    if (timerId === null) scheduler();
  }

  function stop(r) {
    if (!r.playing) return;
    r.playing = false;
    playCount--;

    r.el.classList.remove("active");
    r.led.classList.remove("beat");
    if (r.ledTimer) { clearTimeout(r.ledTimer); r.ledTimer = null; }
    r.btn.innerHTML = PLAY_SVG;
    r.btn.setAttribute("aria-label", "Play metronome for " + r.name);
    r.btn.setAttribute("aria-pressed", "false");

    if (playCount === 0) {
      if (timerId !== null) { clearTimeout(timerId); timerId = null; }
      // Don't let a pending re-lay fire into the next thing started.
      cancelReanchor();
    }
    updateMaster();
    updateTransport();
  }

  function stopAll() {
    rows.forEach(stop);
  }

  function updateTransport() {
    transportEl.hidden = playCount === 0;
    if (playCount > 0) playingCountEl.textContent = playCount + " playing";
  }

  /* Keep the summed output roughly level as rows are layered on. */
  function updateMaster() {
    if (!masterGain) return;
    var g = 1 / Math.sqrt(Math.max(1, playCount));
    masterGain.gain.setTargetAtTime(g, audioCtx.currentTime, 0.03);
  }

  /* First beat index on the shared grid at or after `notBefore`. */
  function beatIndexAt(r, notBefore) {
    var period = 60 / r.rate;
    var k = Math.ceil((notBefore - gridOrigin) / period - 1e-9);
    return k > 0 ? k : 0;
  }

  /* A tempo change re-lays the grid past everything already scheduled, so
     no click is dropped or doubled and all rows stay locked together. */
  function reanchor() {
    if (!audioCtx) return;
    gridOrigin = audioCtx.currentTime + SCHEDULE_AHEAD + 0.02;
    rows.forEach(function (r) { if (r.playing) r.beat = 0; });
  }

  function scheduleReanchor() {
    if (reanchorTimer) clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(function () {
      reanchorTimer = null;
      if (playCount > 0) reanchor();
    }, REANCHOR_DEBOUNCE);
  }

  function cancelReanchor() {
    if (reanchorTimer) { clearTimeout(reanchorTimer); reanchorTimer = null; }
  }

  function scheduler() {
    timerId = null;
    if (playCount === 0) return;

    var now = audioCtx.currentTime;
    var horizon = now + SCHEDULE_AHEAD;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.playing || !r.rate) continue;
      var period = 60 / r.rate;
      // If the timer was throttled (background tab), skip the backlog
      // rather than firing a burst of late clicks.
      if (gridOrigin + r.beat * period < now) r.beat = beatIndexAt(r, now);
      var t = gridOrigin + r.beat * period;
      while (t < horizon) {
        scheduleClick(r.freq, t);
        flashLed(r, t);
        r.beat++;
        t = gridOrigin + r.beat * period;
      }
    }
    timerId = setTimeout(scheduler, LOOKAHEAD);
  }

  function scheduleClick(freq, t) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.03);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  function flashLed(r, t) {
    var delay = Math.max(0, (t - audioCtx.currentTime) * 1000);
    setTimeout(function () {
      if (!r.playing) return;
      r.led.classList.add("beat");
      if (r.ledTimer) clearTimeout(r.ledTimer);
      r.ledTimer = setTimeout(function () {
        r.ledTimer = null;
        r.led.classList.remove("beat");
      }, 70);
    }, delay);
  }

  recalc();
})();
