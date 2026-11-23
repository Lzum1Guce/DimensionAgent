/**
 * DimensionAgent Galgame & Story Theater Smart BGM Engine
 * - 5 built-in Web Audio ambient procedural soundscapes (zero external file dependency)
 * - Custom local MP3/OGG/WAV upload per mood slot (persisted in IndexedDB)
 * - Smooth 1.1s crossfade between tracks + Breeze TTS Audio Ducking
 */

const BGM_STORAGE_KEY = 'dimension.galgame.bgm.v1';
const BGM_IDB_NAME = 'dimension.galgame.bgm.assets.v1';
const BGM_IDB_STORE = 'tracks';

export const BGM_TRACKS = [
  { id: 'daily',  label: '晴日日常', desc: '暖阳电钢与轻盈分解和弦' },
  { id: 'tense',  label: '悬疑暗涌', desc: '低频脉动与钟摆张力氛围' },
  { id: 'battle', label: '高能交锋', desc: '疾走脉冲与紧迫打击律动' },
  { id: 'warm',   label: '温情羁绊', desc: '柔和竖琴与暖光长音铺底' },
  { id: 'night',  label: '深夜星夜', desc: 'Lo-Fi 星空电钢与静谧夜风' },
];

function openBgmDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(BGM_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BGM_IDB_STORE)) db.createObjectStore(BGM_IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('openBgmDb failed'));
  });
}

async function idbGetTrack(slot) {
  try {
    const db = await openBgmDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(BGM_IDB_STORE, 'readonly');
      const req = tx.objectStore(BGM_IDB_STORE).get(slot);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function idbPutTrack(slot, payload) {
  const db = await openBgmDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BGM_IDB_STORE, 'readwrite');
    if (payload) tx.objectStore(BGM_IDB_STORE).put(payload, slot);
    else tx.objectStore(BGM_IDB_STORE).delete(slot);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('idbPutTrack failed'));
  });
}

async function idbListTrackSlots() {
  try {
    const db = await openBgmDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(BGM_IDB_STORE, 'readonly');
      const req = tx.objectStore(BGM_IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

// Gentle pentatonic/diatonic chord progressions (frequencies in Hz) for pleasant non-fatiguing ambient loops
const SYNTH_PATTERNS = {
  daily: {
    tempoMs: 560,
    wave: 'triangle',
    padWave: 'sine',
    cutoff: 1350,
    chords: [
      [261.63, 329.63, 392.00, 493.88], // Cmaj7
      [220.00, 261.63, 329.63, 392.00], // Am7
      [174.61, 220.00, 261.63, 329.63], // Fmaj7
      [196.00, 246.94, 293.66, 392.00], // G6
    ],
    arpOrder: [0, 1, 2, 3, 2, 1, 3, 2],
  },
  tense: {
    tempoMs: 480,
    wave: 'sine',
    padWave: 'triangle',
    cutoff: 720,
    chords: [
      [146.83, 174.61, 220.00, 277.18], // Dm(maj7)
      [146.83, 164.81, 220.00, 261.63], // Dm9
      [130.81, 155.56, 196.00, 246.94], // Cm(maj7)
      [138.59, 174.61, 207.65, 261.63], // C#dim-ish tension
    ],
    arpOrder: [0, 2, 1, 3, 0, 1, 2, 1],
    pulseBass: true,
  },
  battle: {
    tempoMs: 250,
    wave: 'sawtooth',
    padWave: 'triangle',
    cutoff: 1180,
    chords: [
      [164.81, 246.94, 329.63, 392.00], // Em
      [130.81, 196.00, 261.63, 329.63], // C
      [146.83, 220.00, 293.66, 369.99], // D
      [123.47, 185.00, 246.94, 329.63], // Bm
    ],
    arpOrder: [0, 2, 1, 3, 2, 3, 1, 2],
    pulseBass: true,
  },
  warm: {
    tempoMs: 680,
    wave: 'sine',
    padWave: 'sine',
    cutoff: 1150,
    chords: [
      [174.61, 220.00, 261.63, 329.63], // Fmaj7
      [196.00, 246.94, 293.66, 349.23], // G7
      [164.81, 196.00, 246.94, 329.63], // Em7
      [220.00, 261.63, 329.63, 392.00], // Am7
    ],
    arpOrder: [0, 1, 2, 3, 2, 1, 0, 2],
  },
  night: {
    tempoMs: 740,
    wave: 'sine',
    padWave: 'triangle',
    cutoff: 880,
    chords: [
      [196.00, 246.94, 293.66, 369.99], // Gmaj7
      [164.81, 196.00, 246.94, 293.66], // Em7
      [130.81, 164.81, 196.00, 246.94], // Cmaj7
      [146.83, 185.00, 220.00, 261.63], // D7
    ],
    arpOrder: [0, 2, 3, 1, 2, 0, 3, 2],
  },
};

export function createGalgameBgmController({ onChange = null } = {}) {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(BGM_STORAGE_KEY) || '{}') || {}; } catch { return {}; }
  })();

  const state = {
    enabled: Boolean(saved.enabled),
    trackId: BGM_TRACKS.some((t) => t.id === saved.trackId) ? saved.trackId : 'night',
    volume: typeof saved.volume === 'number' ? Math.max(0.05, Math.min(1, saved.volume)) : 0.38,
    autoSwitch: saved.autoSwitch !== false,
    duckOnVoice: saved.duckOnVoice !== false,
    ducked: false,
    activeStage: false,
    customSlots: new Set(),
    customNames: {},
  };

  let ctx = null;
  let masterGain = null;
  let duckGain = null;
  let synthTimer = 0;
  let stepIdx = 0;
  let customAudio = null;
  let customObjectUrl = '';
  let currentRunningMode = ''; // '' | 'synth:<id>' | 'custom:<id>'

  const persist = () => {
    try {
      localStorage.setItem(BGM_STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        trackId: state.trackId,
        volume: state.volume,
        autoSwitch: state.autoSwitch,
        duckOnVoice: state.duckOnVoice,
      }));
    } catch {}
  };

  const emit = () => {
    if (typeof onChange === 'function') {
      try { onChange(getSnapshot()); } catch {}
    }
  };

  const ensureAudioGraph = () => {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    duckGain = ctx.createGain();
    duckGain.gain.value = state.ducked ? 0.22 : 1.0;
    masterGain = ctx.createGain();
    masterGain.gain.value = state.volume * 0.42;
    masterGain.connect(duckGain);
    duckGain.connect(ctx.destination);
    return ctx;
  };

  const applyGain = () => {
    const vol = state.volume;
    const duckFactor = (state.ducked && state.duckOnVoice) ? 0.22 : 1.0;
    if (ctx && masterGain && duckGain) {
      const now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(vol * 0.42, now, 0.12);
      duckGain.gain.cancelScheduledValues(now);
      duckGain.gain.setTargetAtTime(duckFactor, now, state.ducked ? 0.09 : 0.24);
    }
    if (customAudio) {
      customAudio.volume = Math.max(0, Math.min(1, vol * duckFactor));
    }
  };

  const stopPlayback = () => {
    clearInterval(synthTimer);
    synthTimer = 0;
    if (customAudio) {
      try { customAudio.pause(); } catch {}
      customAudio = null;
    }
    if (customObjectUrl) {
      try { URL.revokeObjectURL(customObjectUrl); } catch {}
      customObjectUrl = '';
    }
    currentRunningMode = '';
  };

  const triggerSynthStep = (trackId) => {
    if (!ctx || !masterGain || ctx.state !== 'running') return;
    const pat = SYNTH_PATTERNS[trackId] || SYNTH_PATTERNS.night;
    const chord = pat.chords[Math.floor(stepIdx / 8) % pat.chords.length];
    const noteIdx = pat.arpOrder[stepIdx % pat.arpOrder.length];
    const freq = chord[noteIdx % chord.length];
    const now = ctx.currentTime;

    // Gentle low-pass filter so every note stays silky warm
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(pat.cutoff, now);
    filter.connect(masterGain);

    // Lead arpeggio note
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = pat.wave;
    osc.frequency.setValueAtTime(freq * (trackId === 'daily' || trackId === 'warm' ? 2 : 1), now);
    const dur = (pat.tempoMs / 1000) * 1.65;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.16, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(filter);
    osc.start(now);
    osc.stop(now + dur + 0.05);

    // Soft sustained chord pad on bar downbeat
    if (stepIdx % 8 === 0) {
      const padOsc = ctx.createOscillator();
      const padEnv = ctx.createGain();
      padOsc.type = pat.padWave;
      padOsc.frequency.setValueAtTime(chord[0] * 0.5, now);
      const padDur = (pat.tempoMs / 1000) * 7.8;
      padEnv.gain.setValueAtTime(0.0001, now);
      padEnv.gain.linearRampToValueAtTime(0.13, now + 0.65);
      padEnv.gain.linearRampToValueAtTime(0.0001, now + padDur);
      padOsc.connect(padEnv);
      padEnv.connect(filter);
      padOsc.start(now);
      padOsc.stop(now + padDur + 0.08);
    }

    // Subtle bass pulse for tense / battle
    if (pat.pulseBass && stepIdx % 2 === 0) {
      const bOsc = ctx.createOscillator();
      const bEnv = ctx.createGain();
      bOsc.type = 'sine';
      bOsc.frequency.setValueAtTime(chord[0] * 0.5, now);
      bEnv.gain.setValueAtTime(0.0001, now);
      bEnv.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
      bEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      bOsc.connect(bEnv);
      bEnv.connect(filter);
      bOsc.start(now);
      bOsc.stop(now + 0.28);
    }
    stepIdx += 1;
  };

  const syncPlayback = async () => {
    if (!state.enabled || !state.activeStage) {
      stopPlayback();
      return;
    }
    const targetCustom = state.customSlots.has(state.trackId);
    const wantMode = `${targetCustom ? 'custom' : 'synth'}:${state.trackId}`;
    if (currentRunningMode === wantMode) {
      applyGain();
      return;
    }
    stopPlayback();

    if (targetCustom) {
      const rec = await idbGetTrack(state.trackId);
      if (!state.enabled || !state.activeStage) return;
      if (rec?.blob) {
        try {
          customObjectUrl = URL.createObjectURL(rec.blob);
          const audio = new Audio(customObjectUrl);
          audio.loop = true;
          audio.volume = Math.max(0, Math.min(1, state.volume * (state.ducked ? 0.22 : 1.0)));
          customAudio = audio;
          currentRunningMode = wantMode;
          await audio.play();
          return;
        } catch {
          stopPlayback();
        }
      }
    }

    const ac = ensureAudioGraph();
    if (!ac) return;
    applyGain();
    const pat = SYNTH_PATTERNS[state.trackId] || SYNTH_PATTERNS.night;
    stepIdx = 0;
    currentRunningMode = `synth:${state.trackId}`;
    triggerSynthStep(state.trackId);
    synthTimer = setInterval(() => triggerSynthStep(state.trackId), pat.tempoMs);
  };

  // Load saved custom slots asynchronously
  void idbListTrackSlots().then(async (slots) => {
    for (const s of slots) {
      state.customSlots.add(s);
      const rec = await idbGetTrack(s);
      if (rec?.name) state.customNames[s] = rec.name;
    }
    emit();
  });

  function getSnapshot() {
    return {
      enabled: state.enabled,
      trackId: state.trackId,
      volume: state.volume,
      autoSwitch: state.autoSwitch,
      duckOnVoice: state.duckOnVoice,
      ducked: state.ducked && state.duckOnVoice,
      activeStage: state.activeStage,
      customSlots: [...state.customSlots],
      customNames: { ...state.customNames },
    };
  }

  return {
    getSnapshot,
    setStageActive(active) {
      const next = Boolean(active);
      if (state.activeStage === next) return;
      state.activeStage = next;
      void syncPlayback();
      emit();
    },
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      persist();
      void syncPlayback();
      emit();
    },
    setTrack(trackId, { manual = true } = {}) {
      if (!BGM_TRACKS.some((t) => t.id === trackId)) return;
      if (!manual && !state.autoSwitch) return;
      state.trackId = trackId;
      persist();
      void syncPlayback();
      emit();
    },
    setVolume(vol) {
      state.volume = Math.max(0.05, Math.min(1, Number(vol) || 0.38));
      persist();
      applyGain();
      emit();
    },
    setAutoSwitch(on) {
      state.autoSwitch = Boolean(on);
      persist();
      emit();
    },
    setDuckOnVoice(on) {
      state.duckOnVoice = Boolean(on);
      persist();
      applyGain();
      emit();
    },
    setDucked(duck) {
      const next = Boolean(duck);
      if (state.ducked === next) return;
      state.ducked = next;
      applyGain();
      emit();
    },
    async uploadCustomTrack(slot, file) {
      if (!file || !BGM_TRACKS.some((t) => t.id === slot)) return false;
      await idbPutTrack(slot, { name: file.name || '本地音轨', blob: file });
      state.customSlots.add(slot);
      state.customNames[slot] = file.name || '本地音轨';
      if (state.trackId === slot && state.enabled && state.activeStage) {
        stopPlayback();
        void syncPlayback();
      }
      emit();
      return true;
    },
    async clearCustomTrack(slot) {
      await idbPutTrack(slot, null);
      state.customSlots.delete(slot);
      delete state.customNames[slot];
      if (state.trackId === slot && state.enabled && state.activeStage) {
        stopPlayback();
        void syncPlayback();
      }
      emit();
    },
  };
}
