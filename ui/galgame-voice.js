// 沉浸模式（Galgame 舞台）本地 Breeze-TTS-2 有声演出引擎
// 职责：智能合并同情绪台词句块、单通道预取队列、LRU 音频缓存、瞬时打断、与 AUTO 推进联动

const VOICE_STORAGE = {
  enabled: 'dimension.galgame.voiceEnabled.v1',
  volume: 'dimension.galgame.voiceVolume.v1',
};

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writePref(key, val) {
  try {
    localStorage.setItem(key, String(val));
  } catch {}
}

// 清洗单句用于语音合成（与后端 sanitize_tts_text 保持一致，提前跳过空句/纯代码）
export function cleanBeatForSpeech(raw) {
  let s = String(raw || '');
  if (!s.trim()) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[\[\【]\s*(?:(?:mood|emotion|表情|神态)\s*[:：=]\s*[^\]\】\[\【\r\n]{1,24}|(?:sticker|chat-image|image)\s*[:：]\s*[^\]\】\[\【\r\n]{1,64})\s*[\]\】]/gi, ' ');
  s = s.replace(/https?:\/\/[^\s)）\]】>"']+/gi, ' ');
  s = s.replace(/[*`#_>|]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.startsWith('「') && s.endsWith('」') && s.length > 2) {
    s = s.slice(1, -1).trim();
  }
  // 至少包含中文、假名或英文字母数字才朗读
  if (!/[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]/.test(s)) return '';
  return s;
}

// 将逐字微节拍智能合并为自然连贯的发声句块：
// - 情绪切换（或显式 [mood:...] 切换）自动切新句块，确保 Breeze 语气导演精准变调
// - 同情绪短句合并（上限 88 字符），兼顾流畅自然听感与低延迟
export function groupVoiceChunks(beats, { maxChars = 88 } = {}) {
  const list = Array.isArray(beats) ? beats : [];
  maxChars = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 88;
  const chunks = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || b.isRichBlock) continue;
    const text = cleanBeatForSpeech(b.text);
    if (!text) continue;
    const mood = String(b.mood || 'neutral').trim().toLowerCase() || 'neutral';
    const explicit = Boolean(b.explicit);
    const prev = chunks.length ? chunks[chunks.length - 1] : null;
    if (text.length > maxChars) {
      const chars = Array.from(text);
      for (let offset = 0; offset < chars.length; offset += maxChars) {
        chunks.push({ text: chars.slice(offset, offset + maxChars).join(''), mood, startBeatIdx: i, endBeatIdx: i });
      }
      continue;
    }
    const canMerge = prev &&
      !explicit &&
      prev.mood === mood &&
      (prev.text.length + text.length <= maxChars);
    if (canMerge) {
      const space = /[A-Za-z0-9.!?]$/.test(prev.text) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
      prev.text += space + text;
      prev.endBeatIdx = i;
    } else {
      chunks.push({
        text,
        mood,
        startBeatIdx: i,
        endBeatIdx: i,
      });
    }
  }
  return chunks;
}

export function createGalgameVoiceController({ onStateChange = null, onIdle = null, onToast = null } = {}) {
  const state = {
    enabled: readPref(VOICE_STORAGE.enabled, '1') !== '0',
    volume: Math.max(0.1, Math.min(1.0, parseFloat(readPref(VOICE_STORAGE.volume, '0.95')) || 0.95)),
    serverOnline: false,
    serverState: 'stopped', // 'stopped' | 'starting' | 'ready' | 'error'
    serverConfig: null,
    serverStatus: null,
    voices: [],
    defaultProfiles: {},
    playing: false,
    synthesizing: false,
    offlineUntil: 0,
    configVersion: 0,

    // 当前演出朗读队列状态
    sessionGen: 0,
    turnKey: '',
    botId: '',
    queue: [],        // [{ key, text, mood, botId }]
    nextBeat: 0,
    finishAudio: null,
    activeAudio: null,
    activeAbort: null,
    prefetchAbort: null,
    lastSpokenTurn: null, // { botId, chunks: [{ text, mood }] } 供「重听本句」使用
  };

  // LRU 内存缓存：key -> { blobUrl, at }
  const audioCache = new Map();
  const MAX_CACHE = 24;

  function cacheGet(key) {
    const hit = audioCache.get(key);
    if (!hit) return null;
    audioCache.delete(key);
    audioCache.set(key, hit);
    return hit.blobUrl;
  }

  function cacheSet(key, blobUrl) {
    if (audioCache.has(key)) {
      const old = audioCache.get(key);
      if (old?.blobUrl && old.blobUrl !== blobUrl) {
        try { URL.revokeObjectURL(old.blobUrl); } catch {}
      }
      audioCache.delete(key);
    }
    audioCache.set(key, { blobUrl, at: Date.now() });
    while (audioCache.size > MAX_CACHE) {
      const oldestKey = audioCache.keys().next().value;
      const oldest = audioCache.get(oldestKey);
      audioCache.delete(oldestKey);
      if (oldest?.blobUrl) {
        try { URL.revokeObjectURL(oldest.blobUrl); } catch {}
      }
    }
  }

  function clearAudioCache() {
    for (const entry of audioCache.values()) {
      if (entry?.blobUrl) {
        try { URL.revokeObjectURL(entry.blobUrl); } catch {}
      }
    }
    audioCache.clear();
  }

  function emitState() {
    if (typeof onStateChange === 'function') {
      try {
        onStateChange(getSnapshot());
      } catch {}
    }
  }

  function emitIdleIfReady() {
    if (!state.playing && !state.synthesizing && state.queue.length === 0) {
      if (typeof onIdle === 'function') {
        try { onIdle(); } catch {}
      }
    }
  }

  function getSnapshot() {
    return {
      enabled: state.enabled,
      volume: state.volume,
      playing: state.playing,
      synthesizing: state.synthesizing,
      busy: state.playing || state.synthesizing || state.queue.length > 0,
      serverOnline: state.serverOnline,
      serverState: state.serverState,
      serverStatus: state.serverStatus,
      voices: state.voices,
      defaultProfiles: state.defaultProfiles,
      canReplay: Boolean(state.lastSpokenTurn && state.lastSpokenTurn.chunks.length > 0),
    };
  }

  function makeChunkCacheKey(botId, mood, text) {
    return `${state.configVersion}|${botId || 'default'}|${mood || 'neutral'}|${text}`;
  }

  function stopPlayback({ keepLastTurn = true } = {}) {
    state.sessionGen += 1;
    state.queue = [];

    if (!keepLastTurn) {
      state.lastSpokenTurn = null;
      state.turnKey = '';
      state.nextBeat = 0;
    }
    if (state.activeAbort) {
      try { state.activeAbort.abort(); } catch {}
      state.activeAbort = null;
    }
    if (state.prefetchAbort) {
      try { state.prefetchAbort.abort(); } catch {}
      state.prefetchAbort = null;
    }
    if (state.activeAudio) {
      try {
        state.activeAudio.onended = null;
        state.activeAudio.onerror = null;
        state.activeAudio.pause();
        state.activeAudio.src = '';
      } catch {}
      state.finishAudio?.('aborted');
    }
    const wasBusy = state.playing || state.synthesizing;
    state.playing = false;
    state.synthesizing = false;
    if (wasBusy) emitState();
  }

  async function fetchWavUrl({ botId, text, mood, preview = false, override = null }, signal) {
    const cacheKey = !override ? makeChunkCacheKey(botId, mood, text) : '';
    if (cacheKey) {
      const hit = cacheGet(cacheKey);
      if (hit) return { ok: true, url: hit, fromCache: true };
    }

    const body = {
      botId: botId || '',
      text,
      mood: mood || 'neutral',
      preview: Boolean(preview),
    };
    if (override && typeof override === 'object') {
      if (typeof override.voiceId === 'string') body.voiceId = override.voiceId;
      if (typeof override.instruction === 'string') body.instruction = override.instruction;
      if (typeof override.cfgScale === 'number') body.cfgScale = override.cfgScale;
      if (typeof override.seed === 'number') body.seed = override.seed;
    }

    const res = await fetch('/api/dimension/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (res.status === 204) {
      return { ok: false, empty: true };
    }
    if (!res.ok) {
      let detail = {};
      try { detail = await res.json(); } catch {}
      if (res.status === 503 || detail?.code === 'tts_offline') {
        state.serverOnline = false;
        state.offlineUntil = Date.now() + 15000;
        emitState();
        return { ok: false, offline: true, error: detail?.error || 'Breeze 服务未启动' };
      }
      return { ok: false, error: detail?.error || `合成失败 (${res.status})` };
    }

    const blob = await res.blob();
    signal.throwIfAborted();
    if (!blob || blob.size < 44) {
      return { ok: false, empty: true };
    }
    state.serverOnline = true;
    state.serverState = 'ready';
    state.offlineUntil = 0;
    const blobUrl = URL.createObjectURL(blob);
    if (cacheKey) cacheSet(cacheKey, blobUrl);
    return { ok: true, url: blobUrl, temporary: !cacheKey };
  }

  function startPrefetchNext(gen) {
    if (gen !== state.sessionGen) return;
    if (!state.queue.length || state.prefetchAbort) return;
    const nextItem = state.queue[0];
    if (!nextItem) return;
    const key = makeChunkCacheKey(nextItem.botId, nextItem.mood, nextItem.text);
    if (cacheGet(key)) return;

    const ac = new AbortController();
    state.prefetchAbort = ac;
    nextItem.pendingAudio = fetchWavUrl(nextItem, ac.signal)
      .catch(() => ({ ok: false }))
      .finally(() => {
        if (state.prefetchAbort === ac) state.prefetchAbort = null;
      });
  }

  function playBlobUrl(url, gen, { temporary = false } = {}) {
    return new Promise((resolve) => {
      if (gen !== state.sessionGen) {
        if (temporary) try { URL.revokeObjectURL(url); } catch {}
        resolve('aborted');
        return;
      }
      const audio = new Audio(url);
      audio.volume = state.volume;
      state.activeAudio = audio;
      state.playing = true;
      state.synthesizing = false;
      emitState();

      const finish = (outcome) => {
        if (state.activeAudio === audio) {
          state.activeAudio = null;
          state.finishAudio = null;
        }
        if (temporary) try { URL.revokeObjectURL(url); } catch {}
        resolve(outcome);
      };

      state.finishAudio = finish;
      audio.onended = () => finish('ended');
      audio.onerror = () => finish('error');

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          // 当前句真正开始出声后，在后台静默单通道预取下一句
          startPrefetchNext(gen);
        }).catch((err) => {
          if (err?.name === 'NotAllowedError' && typeof onToast === 'function') {
            onToast('点击舞台任意位置即可解锁角色配音播放');
          }
          finish('blocked');
        });
      } else {
        startPrefetchNext(gen);
      }
    });
  }

  async function drainQueue(gen, manual = false) {
    while (gen === state.sessionGen && state.queue.length > 0) {
      if (!manual && !state.enabled) {
        stopPlayback({ keepLastTurn: true });
        return;
      }
      if (Date.now() < state.offlineUntil) {
        state.queue = [];
        break;
      }
      const item = state.queue.shift();
      if (!item) continue;

      const cacheKey = makeChunkCacheKey(item.botId, item.mood, item.text);
      let url = cacheGet(cacheKey);
      let temporary = false;

      if (!url) {
        state.synthesizing = true;
        emitState();
        const ac = new AbortController();
        state.activeAbort = ac;
        try {
          const r = await (item.pendingAudio ?? fetchWavUrl(item, ac.signal));
          if (state.activeAbort === ac) state.activeAbort = null;
          if (gen !== state.sessionGen) return;
          if (!r.ok) {
            state.synthesizing = false;
            emitState();
            if (r.offline) {
              state.queue = [];
              break;
            }
            continue;
          }
          url = r.url;
          temporary = Boolean(r.temporary);
        } catch {
          if (state.activeAbort === ac) state.activeAbort = null;
          if (gen !== state.sessionGen) return;
          state.synthesizing = false;
          emitState();
          continue;
        }
      }

      const outcome = await playBlobUrl(url, gen, { temporary });
      if (gen !== state.sessionGen || outcome === 'aborted') return;
    }

    if (gen === state.sessionGen) {
      state.playing = false;
      state.synthesizing = false;
      emitState();
      emitIdleIfReady();
    }
  }

  // 在沉浸模式逐句演出中投喂已封口的句块（流式安全、自动去重）
  function feedTurnBeats({ turnKey, botId, beats, streamActive = false }) {
    if (!turnKey || !Array.isArray(beats)) return;
    if (turnKey !== state.turnKey) {
      stopPlayback({ keepLastTurn: false });
      state.turnKey = turnKey;
      state.botId = botId || '';
    }
    const tail = beats.at(-1);
    const holdTail = streamActive && tail && (!tail.completeSentence || /[.~～]$/.test(tail.text));
    const readyEnd = beats.length - (holdTail ? 1 : 0);
    if (readyEnd <= state.nextBeat) return;
    const chunks = groupVoiceChunks(beats.slice(state.nextBeat, readyEnd));
    state.nextBeat = readyEnd;
    if (!chunks.length) return;
    state.lastSpokenTurn ??= { botId: state.botId, chunks: [] };
    state.lastSpokenTurn.chunks.push(...chunks);
    if (!state.enabled || state.serverConfig?.enabled === false || Date.now() < state.offlineUntil) return;
    for (const { text, mood } of chunks) state.queue.push({ botId: state.botId, text, mood });
    if (!state.playing && !state.synthesizing) drainQueue(state.sessionGen);
    else if (state.playing) startPrefetchNext(state.sessionGen);
  }

  // 手动点击「重听本句」
  function replayLastTurn({ fallbackBotId = '', fallbackText = '', fallbackMood = 'neutral' } = {}) {
    let target = state.lastSpokenTurn;
    if ((!target || !target.chunks.length) && fallbackText) {
      const clean = cleanBeatForSpeech(fallbackText);
      if (clean) {
        target = { botId: fallbackBotId, chunks: [{ text: clean, mood: fallbackMood }] };
      }
    }
    if (!target || !target.chunks.length) {
      if (typeof onToast === 'function') onToast('当前没有可朗读的台词');
      return false;
    }
    // 手动点重听时清除离线冷却，让用户立刻能试探连接
    state.offlineUntil = 0;
    stopPlayback({ keepLastTurn: true });
    const gen = state.sessionGen;
    for (const c of target.chunks) {
      state.queue.push({ botId: target.botId || fallbackBotId, text: c.text, mood: c.mood });
    }
    drainQueue(gen, true);
    return true;
  }

  // 设置面板中点击「试听一句」
  async function previewVoice({ botId, text = '', mood = 'neutral', voiceId = '', instruction = '', cfgScale = null, seed = null }) {
    state.offlineUntil = 0;
    stopPlayback({ keepLastTurn: true });
    const gen = state.sessionGen;
    state.synthesizing = true;
    emitState();
    const ac = new AbortController();
    state.activeAbort = ac;
    try {
      const r = await fetchWavUrl(
        {
          botId,
          text,
          mood,
          preview: true,
          override: {
            voiceId,
            instruction,
            ...(typeof cfgScale === 'number' ? { cfgScale } : {}),
            ...(typeof seed === 'number' ? { seed } : {}),
          },
        },
        ac.signal
      );
      if (state.activeAbort === ac) state.activeAbort = null;
      if (gen !== state.sessionGen) return { ok: false, aborted: true };
      if (!r.ok) {
        state.synthesizing = false;
        emitState();
        return r;
      }
      await playBlobUrl(r.url, gen, { temporary: true });
      if (gen === state.sessionGen) {
        state.playing = false;
        state.synthesizing = false;
        emitState();
      }
      return { ok: true };
    } catch (err) {
      if (state.activeAbort === ac) state.activeAbort = null;
      state.synthesizing = false;
      emitState();
      return { ok: false, error: err?.message || '试听失败' };
    }
  }

  async function refreshStatus({ includeVoices = true } = {}) {
    try {
      const res = await fetch(`/api/dimension/tts/status?voices=${includeVoices ? '1' : '0'}`);
      if (!res.ok) return null;
      const data = await res.json();
      state.serverStatus = data;
      state.serverOnline = Boolean(data.online);
      state.serverState = data.state || (data.online ? 'ready' : 'stopped');
      state.serverConfig = data.config || null;
      if (Array.isArray(data.voices)) state.voices = data.voices;
      if (data.defaultProfiles && typeof data.defaultProfiles === 'object') {
        state.defaultProfiles = data.defaultProfiles;
      }
      if (state.serverOnline) state.offlineUntil = 0;
      emitState();
      return data;
    } catch {
      return null;
    }
  }

  async function saveConfig(patch) {
    const res = await fetch('/api/dimension/tts/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `保存语音配置失败 (${res.status})`);
    state.configVersion += 1;
    clearAudioCache();
    state.serverStatus = data;
    state.serverOnline = Boolean(data.online);
    state.serverState = data.state || 'stopped';
    state.serverConfig = data.config || null;
    if (Array.isArray(data.voices)) state.voices = data.voices;
    if (state.serverOnline) state.offlineUntil = 0;
    emitState();
    return data;
  }

  async function controlServer(action) {
    const res = await fetch('/api/dimension/tts/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `操作失败 (${res.status})`);
    state.serverStatus = data;
    state.serverOnline = Boolean(data.online);
    state.serverState = data.state || 'stopped';
    state.serverConfig = data.config || null;
    if (Array.isArray(data.voices)) state.voices = data.voices;
    if (state.serverOnline) state.offlineUntil = 0;
    emitState();
    return data;
  }

  function setEnabled(next) {
    state.enabled = Boolean(next);
    writePref(VOICE_STORAGE.enabled, state.enabled ? '1' : '0');
    if (!state.enabled) {
      stopPlayback({ keepLastTurn: true });
    } else {
      state.offlineUntil = 0;
    }
    emitState();
  }

  function setVolume(vol) {
    state.volume = Math.max(0.1, Math.min(1.0, Number(vol) || 0.95));
    writePref(VOICE_STORAGE.volume, state.volume.toFixed(2));
    if (state.activeAudio) {
      try { state.activeAudio.volume = state.volume; } catch {}
    }
    emitState();
  }

  return {
    getSnapshot,
    isEnabled: () => state.enabled,
    isBusy: () => state.playing || state.synthesizing || state.queue.length > 0,
    setEnabled,
    setVolume,
    stop: stopPlayback,
    feedTurnBeats,
    replayLastTurn,
    previewVoice,
    refreshStatus,
    saveConfig,
    controlServer,
    clearCache: clearAudioCache,
  };
}
