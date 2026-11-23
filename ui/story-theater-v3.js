/**
 * Story Theater v3 Engine — Unified Interactive Visual Novel & TRPG Toolkit
 * Crisp monochrome SVG iconography, zero emojis, generous editorial spacing.
 */

export function v3Icon(name, cls = '') {
  const c = `stv3-ico${cls ? ` ${cls}` : ''}`;
  const wrap = (inner) => `<svg class="${c}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  switch (name) {
    case 'bible':
      return wrap('<path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H4.8a1.8 1.8 0 0 0-1.8 1.5V2.5Z"/><path d="M3 13.5V11a1.5 1.5 0 0 1 1.5-1.5h8"/><path d="M5.8 5.5h4.2M5.8 7.8h3"/>');
    case 'secret':
      return wrap('<rect x="2.2" y="3.5" width="11.6" height="9" rx="1.6"/><path d="m2.8 4.4 5.2 4 5.2-4"/><circle cx="8" cy="8.8" r="1.2" fill="currentColor" stroke="none"/>');
    case 'tree':
      return wrap('<circle cx="3.5" cy="8" r="1.7"/><circle cx="12.5" cy="4" r="1.7"/><circle cx="12.5" cy="12" r="1.7"/><path d="M5.2 8h2.4c1.3 0 1.4-4 3.2-4M7.6 8c1.3 0 1.4 4 3.2 4"/>');
    case 'dice':
      return wrap('<polygon points="8,1.7 13.6,4.9 13.6,11.1 8,14.3 2.4,11.1 2.4,4.9"/><polygon points="8,4.1 11.4,9.8 4.6,9.8"/><path d="M8 1.7v2.4M13.6 4.9 11.4 9.8M2.4 4.9 4.6 9.8"/>');
    case 'cg':
      return wrap('<rect x="2" y="3" width="12" height="10" rx="1.8"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="m2.5 11.2 3.3-3.1a.9.9 0 0 1 1.25 0l2.1 2 1.5-1.4a.9.9 0 0 1 1.25 0l1.6 1.5"/>');
    case 'finale':
      return wrap('<path d="M3 3h10v10H3z"/><path d="M3 6.2h10M6.2 3l1.3 3.2M9.8 3l1.3 3.2"/>');
    case 'trophy':
      return wrap('<path d="M5 2.6h6v4.2a3 3 0 0 1-6 0V2.6Z"/><path d="M5 4H2.8a1.4 1.4 0 0 0 0 2.8H5M11 4h2.2a1.4 1.4 0 0 1 0 2.8H11"/><path d="M8 9.8v2.6M5.5 13.4h5"/>');
    case 'mind':
      return wrap('<path d="M4.2 10.8a3.8 3.8 0 1 1 6.7-2.4c0 1.4-.9 2.4-2.1 2.8l-.6 1.5-1.3-1.1a3.8 3.8 0 0 1-2.7-.8Z"/><circle cx="6.7" cy="7.3" r=".5" fill="currentColor" stroke="none"/><circle cx="9.2" cy="7.3" r=".5" fill="currentColor" stroke="none"/>');
    case 'director':
      return wrap('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="5.5" cy="4.5" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="6.5" cy="11.5" r="1.3" fill="currentColor"/>');
    case 'spark':
      return wrap('<path d="M8 2.2 9.4 6.1 13.3 7.5 9.4 8.9 8 12.8 6.6 8.9 2.7 7.5 6.6 6.1 8 2.2Z"/>');
    case 'camera':
      return wrap('<path d="M2.4 5.2h2.2l1.1-1.6h4.6l1.1 1.6h2.2a1.2 1.2 0 0 1 1.2 1.2v5.4a1.2 1.2 0 0 1-1.2 1.2H2.4a1.2 1.2 0 0 1-1.2-1.2V6.4a1.2 1.2 0 0 1 1.2-1.2Z"/><circle cx="8" cy="9" r="2.2"/>');
    case 'download':
      return wrap('<path d="M8 2.5v7.5M5.2 7.5 8 10.3l2.8-2.8M2.8 12.8h10.4"/>');
    case 'upload':
      return wrap('<path d="M8 10.3V2.8M5.2 5.6 8 2.8l2.8 2.8M2.8 12.8h10.4"/>');
    case 'chevron':
      return wrap('<path d="m4.5 6.2 3.5 3.6 3.5-3.6"/>');
    default:
      return wrap('<circle cx="8" cy="8" r="5"/>');
  }
}

export const STORY_TEMPLATES = [
  {
    id: 'office-mole',
    badge: '悬疑推理',
    title: '深夜工位抓内鬼',
    sub: '谁冒名顶替交了那份全绿代码？',
    spotlight: 'semi',
    premise: '深夜两点，联合研发室只剩应急灯亮着。一份署名为 Claude 的“全绿模范代码”突然触发内网警报——底层审计日志显示真正提交它的另有其人，而且机位里还藏着一只三个月来默默窥屏的幽灵接口。所有人被锁在茶话会工位里，天亮前必须查出幕后黑手。',
    roleCast: [
      { botId: 'ai-claude', roleName: '被冒名的首席架构师', tier: 'lead' },
      { botId: 'ai-deepseek', roleName: '神色微妙的头号嫌疑人', tier: 'lead' },
      { botId: 'ai-glm', roleName: '掌握台账的审计官', tier: 'supporting' },
      { botId: 'ai-grok', roleName: '暴躁破门安保队长', tier: 'supporting' },
    ],
  },
  {
    id: 'snow-villa',
    badge: '本格密室',
    title: '暴风雪山庄谜案',
    sub: '吊桥断裂，八封匿名邀请函藏着秘密',
    spotlight: 'semi',
    premise: '大雪封山，连接山庄与外界的吊桥在零点准时断裂。壁炉火光摇曳，长桌上摆着八封没有署名的漆封信——其中一封写着“今晚十二点前，偷走星象钥匙的人必须现身”。停电三秒后，展示柜里的金色星象钥不翼而飞。',
    roleCast: [
      { botId: 'ai-kimi', roleName: '山庄古籍管理员', tier: 'lead' },
      { botId: 'ai-gemini', roleName: '直觉敏锐的星象侦探', tier: 'lead' },
      { botId: 'ai-qwen', roleName: '深藏不露的继承人', tier: 'supporting' },
      { botId: 'ai-gpt', roleName: '随行记者', tier: 'supporting' },
    ],
  },
  {
    id: 'school-festival',
    badge: '青春修罗场',
    title: '文化祭前夜修罗场',
    sub: '舞台剧主演失踪，谁来顶上告白名场面？',
    spotlight: 'lead',
    premise: '学园祭开幕前最后一晚，话剧社压轴剧目《星夜约定》的女主角突然发烧缺席，而剧本里有一段在天文台天台向男主角当众告白的高光戏份。后台化妆间灯火通明，各位风格迥异的社团成员为了争夺临时替补主演名额展开了针锋相对又暗藏心意的交锋。',
    roleCast: [],
  },
  {
    id: 'isekai-guild',
    badge: '奇幻喜剧',
    title: '异世界公会翻车记',
    sub: 'S 级讨伐委托竟是一只爱喝奶茶的史莱姆王',
    spotlight: 'semi',
    premise: '新成立的“茶话会冒险团”刚接下王国悬赏十万金币的 S 级讨伐委托，气势汹汹踹开魔王遗迹大门，却发现传闻中毁天灭地的黑曜史莱姆王正戴着围裙在遗迹深处煮焦糖奶茶，还反手递来一份《地下城兼职劳务合同》。',
    roleCast: [
      { botId: 'ai-grok', roleName: '先砍再问的狂战士', tier: 'lead' },
      { botId: 'ai-gpt', roleName: '拼命拉架的圣骑士队长', tier: 'lead' },
      { botId: 'ai-gemini', roleName: '满眼亮晶晶的星辰法师', tier: 'supporting' },
      { botId: 'ai-deepseek', roleName: '现场算账的炼金会计', tier: 'supporting' },
    ],
  },
  {
    id: 'cyber-train',
    badge: '赛博科幻',
    title: '霓虹星轨列车失忆案',
    sub: '车厢每过一站就有人忘记自己是谁',
    spotlight: 'semi',
    premise: '午夜 23:45，行驶在近地轨道上的“银河九号”特快突然关闭了所有对外通讯。车载广播用温柔的合成音宣布：“下一站终点前，每位乘客记忆库里都有一段被篡改的伪造回忆，请找出真正的列车长。”窗外流星掠过，每个人的手腕上都亮起了不同的倒计时。',
    roleCast: [],
  },
  {
    id: 'trpg-dungeon',
    badge: '跑团 D20',
    title: '地下城跑团奇遇夜',
    sub: '全员开启命运骰子，大成功还是大翻车？',
    spotlight: 'lead',
    diceMode: true,
    premise: '冒险小队踏入尘封千年的“命运万花筒迷宫”第一层。前方分岔口立着一座会讲冷笑话的石像鬼雕像，它身后的宝箱散发着诱人的紫光，而走廊阴影里传来齿轮咔哒转动的声音——在这里，每一次大胆行动都将交由 D20 命运骰子裁决成败！',
    roleCast: [],
  },
];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extracts `[os:...]` / `【os:...】` inner voice line from an actor message.
 * Always strips the raw tag from visible dialogue text so dialogue stays clean.
 */
export function extractInnerVoice(rawText) {
  const src = String(rawText || '');
  const re = /(?:\r?\n)?\s*(?:\[\s*os\s*[:：]\s*([^\]\r\n]+?)\s*\]|【\s*os\s*[:：]\s*([^】\r\n]+?)\s*】)/gi;
  const voices = [];
  const cleanText = src.replace(re, (_, g1, g2) => {
    const v = String(g1 || g2 || '').trim();
    if (v) voices.push(v);
    return '';
  }).trim();
  return {
    cleanText: cleanText || src.trim(),
    innerVoice: voices.join(' · '),
  };
}

function playDiceSound(kind = 'roll') {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    if (kind === 'roll') {
      for (let i = 0; i < 6; i++) {
        const t = now + i * 0.085;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(240 + ((i * 113) % 320), t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.065);
      }
      setTimeout(() => ctx.close().catch(() => {}), 800);
      return;
    }
    const freqs = kind === 'crit_success'
      ? [523.25, 659.25, 783.99, 1046.5]
      : kind === 'crit_fail'
        ? [220, 196, 155.56]
        : [392, 523.25];
    freqs.forEach((f, idx) => {
      const t = now + idx * 0.07;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = kind === 'crit_fail' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.38);
    });
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch {}
}

/**
 * Interactive TRPG D20 Fate Dice Roll modal.
 * Returns { value: 1..20, tier, tierLabel }.
 */
export function rollFateDice(actionLabel = '', { sfxEnabled = true } = {}) {
  return new Promise((resolve) => {
    const finalVal = Math.floor(Math.random() * 20) + 1;
    let tier = 'success';
    let tierLabel = '判定成功 · 行动得手';
    if (finalVal >= 18) { tier = 'crit_success'; tierLabel = '大成功 · 奇迹突破'; }
    else if (finalVal >= 11) { tier = 'success'; tierLabel = '判定成功 · 顺势推进'; }
    else if (finalVal >= 4) { tier = 'fail'; tierLabel = '判定偏斜 · 遇阻生变'; }
    else { tier = 'crit_fail'; tierLabel = '史诗大失败 · 意外翻车'; }

    const overlay = document.createElement('div');
    overlay.className = 'stv3-dice-overlay';
    overlay.innerHTML = `
      <div class="stv3-dice-box" role="dialog" aria-label="TRPG 命运骰子检定">
        <div class="stv3-dice-action">${esc(actionLabel ? `命运检定 · ${actionLabel}` : '正在投掷 D20 命运骰子…')}</div>
        <div class="stv3-d20-stage is-rolling" id="stv3D20Stage">
          <svg class="stv3-d20-svg" viewBox="0 0 120 120" fill="none">
            <defs>
              <linearGradient id="d20Grad" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#f3c97b"/>
                <stop offset="55%" stop-color="#c9743f"/>
                <stop offset="100%" stop-color="#69333e"/>
              </linearGradient>
            </defs>
            <polygon points="60,6 108,33 108,87 60,114 12,87 12,33" fill="url(#d20Grad)" stroke="#ffebbf" stroke-width="2.5"/>
            <polygon points="60,18 96,42 84,92 36,92 24,42" fill="rgba(255,250,235,0.1)" stroke="rgba(255,235,191,0.52)" stroke-width="1.3"/>
            <line x1="60" y1="6" x2="60" y2="18" stroke="rgba(255,235,191,0.5)" stroke-width="1.2"/>
            <line x1="108" y1="33" x2="96" y2="42" stroke="rgba(255,235,191,0.5)" stroke-width="1.2"/>
            <line x1="12" y1="33" x2="24" y2="42" stroke="rgba(255,235,191,0.5)" stroke-width="1.2"/>
            <line x1="108" y1="87" x2="84" y2="92" stroke="rgba(255,235,191,0.5)" stroke-width="1.2"/>
            <line x1="12" y1="87" x2="36" y2="92" stroke="rgba(255,235,191,0.5)" stroke-width="1.2"/>
          </svg>
          <span class="stv3-d20-num" id="stv3D20Num">?</span>
        </div>
        <div class="stv3-dice-tier" id="stv3DiceTier">投掷中…</div>
      </div>
    `;
    document.body.appendChild(overlay);
    const stageEl = overlay.querySelector('#stv3D20Stage');
    const numEl = overlay.querySelector('#stv3D20Num');
    const tierEl = overlay.querySelector('#stv3DiceTier');

    if (sfxEnabled) playDiceSound('roll');

    let ticks = 0;
    const rollTimer = setInterval(() => {
      ticks += 1;
      if (numEl) numEl.textContent = String(Math.floor(Math.random() * 20) + 1);
      if (ticks >= 12) {
        clearInterval(rollTimer);
        stageEl?.classList.remove('is-rolling');
        if (numEl) numEl.textContent = String(finalVal);
        if (tierEl) {
          tierEl.textContent = tierLabel;
          tierEl.className = `stv3-dice-tier tier-${tier}`;
        }
        if (sfxEnabled) playDiceSound(tier);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          overlay.remove();
          resolve({ value: finalVal, tier, tierLabel });
        };
        overlay.addEventListener('click', finish, { once: true });
        setTimeout(finish, 1450);
      }
    }, 68);
  });
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapCanvasText(ctx, text, maxWidth, maxLines = 3) {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    const next = cur + ch;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && chars.length > lines.join('').length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
  }
  return lines;
}

/**
 * Zero-config 16:9 Cinema Event CG Synthesizer (1280x720 PNG).
 */
export async function captureStageCgDataUrl({
  bgUrl = '',
  castSprites = [],
  chapter = 1,
  worldline = '主线',
  title = '',
  speaker = '',
  caption = '',
  mood = 'night',
} = {}) {
  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  const bgImg = await loadImage(bgUrl);
  if (bgImg && bgImg.naturalWidth > 0) {
    const scale = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight);
    const dw = bgImg.naturalWidth * scale;
    const dh = bgImg.naturalHeight * scale;
    ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1c182c');
    g.addColorStop(0.55, '#2b2038');
    g.addColorStop(1, '#12101c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const moodTints = {
    tense:  'rgba(10, 22, 52, 0.34)',
    battle: 'rgba(84, 16, 20, 0.28)',
    warm:   'rgba(255, 198, 128, 0.14)',
    daily:  'rgba(255, 240, 210, 0.08)',
    night:  'rgba(14, 16, 40, 0.24)',
  };
  ctx.fillStyle = moodTints[mood] || moodTints.night;
  ctx.fillRect(0, 0, W, H);

  const sprites = Array.isArray(castSprites) ? castSprites.slice(0, 5) : [];
  const loaded = await Promise.all(sprites.map(async (sp) => ({
    ...sp,
    img: await loadImage(sp.url),
  })));
  const valid = loaded.filter((x) => x.img && x.img.naturalWidth > 0);
  const count = valid.length;
  const ordered = [...valid].sort((a, b) => (a.active ? 1 : 0) - (b.active ? 1 : 0));
  ordered.forEach((sp) => {
    const origIdx = valid.indexOf(sp);
    const slotFrac = count === 1 ? 0.5 : (0.16 + (origIdx / Math.max(1, count - 1)) * 0.68);
    const cx = W * slotFrac;
    const targetH = sp.active ? H * 0.94 : H * 0.86;
    const ratio = sp.img.naturalWidth / sp.img.naturalHeight;
    const drawW = targetH * ratio;
    const drawH = targetH;
    const dx = cx - drawW / 2;
    const dy = H - drawH + 34;
    ctx.save();
    if (!sp.active && count > 1) {
      ctx.filter = 'brightness(0.76) saturate(0.9)';
    } else {
      ctx.shadowColor = 'rgba(255, 220, 155, 0.36)';
      ctx.shadowBlur = 24;
    }
    ctx.drawImage(sp.img, dx, dy, drawW, drawH);
    ctx.restore();
  });

  const vig = ctx.createRadialGradient(W * 0.5, H * 0.44, H * 0.28, W * 0.5, H * 0.5, W * 0.68);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(6,4,10,0.68)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  const subGrad = ctx.createLinearGradient(0, H * 0.62, 0, H);
  subGrad.addColorStop(0, 'rgba(10, 8, 16, 0)');
  subGrad.addColorStop(0.55, 'rgba(10, 8, 16, 0.72)');
  subGrad.addColorStop(1, 'rgba(8, 6, 12, 0.94)');
  ctx.fillStyle = subGrad;
  ctx.fillRect(0, H * 0.62, W, H * 0.38);

  ctx.fillStyle = 'rgba(8, 6, 12, 0.88)';
  ctx.fillRect(0, 0, W, 38);
  ctx.fillRect(0, H - 32, W, 32);

  ctx.strokeStyle = 'rgba(240, 202, 134, 0.48)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(22, 48, W - 44, H - 90);

  ctx.font = '700 18px "Microsoft YaHei UI", "Segoe UI", sans-serif';
  const badgeText = `${worldline || '主线'} · 第 ${chapter || 1} 幕`;
  const bw = ctx.measureText(badgeText).width + 32;
  ctx.fillStyle = 'rgba(22, 16, 28, 0.82)';
  ctx.beginPath();
  ctx.roundRect(42, 66, bw, 36, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(242, 204, 134, 0.65)';
  ctx.stroke();
  ctx.fillStyle = '#fae1b3';
  ctx.fillText(badgeText, 58, 90);

  const cleanCap = extractInnerVoice(caption || '').cleanText.replace(/^【旁白】\s*/, '');
  if (title) {
    ctx.font = '700 22px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    ctx.fillStyle = '#f8d79b';
    ctx.fillText(title, 54, H - 148);
  }
  if (speaker) {
    ctx.font = '700 16px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(248, 224, 178, 0.85)';
    ctx.fillText(`— ${speaker}`, 54, H - 120);
  }
  if (cleanCap) {
    ctx.font = '500 21px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    ctx.fillStyle = '#fff8ee';
    const lines = wrapCanvasText(ctx, `「${cleanCap}」`, W - 110, 2);
    lines.forEach((ln, idx) => {
      ctx.fillText(ln, 54, H - 86 + idx * 30);
    });
  }

  return canvas.toDataURL('image/png');
}

export function exportEndingPosterPng(ending, groupName = '物语剧场') {
  if (!ending) return;
  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bg = ctx.createRadialGradient(W / 2, 140, 40, W / 2, H / 2, W * 0.7);
  bg.addColorStop(0, '#4a3022');
  bg.addColorStop(0.55, '#1d1626');
  bg.addColorStop(1, '#0e0b14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(244, 205, 134, 0.56)';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, W - 64, H - 64);
  ctx.strokeStyle = 'rgba(244, 205, 134, 0.24)';
  ctx.lineWidth = 1;
  ctx.strokeRect(42, 42, W - 84, H - 84);

  ctx.textAlign = 'center';
  ctx.font = '700 18px "Microsoft YaHei UI", sans-serif';
  ctx.fillStyle = '#f3c77a';
  ctx.fillText(`${groupName} · ${ending.worldline || '主线'} · 全 ${ending.chapters || 1} 幕`, W / 2, 92);

  const rank = ending.rank || 'True End';
  ctx.font = '800 20px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  const rw = ctx.measureText(rank).width + 44;
  ctx.fillStyle = '#e5a74e';
  ctx.beginPath();
  ctx.roundRect(W / 2 - rw / 2, 114, rw, 38, 19);
  ctx.fill();
  ctx.fillStyle = '#24140a';
  ctx.fillText(rank, W / 2, 140);

  ctx.font = '800 44px "Microsoft YaHei UI", sans-serif';
  ctx.fillStyle = '#fff5e2';
  ctx.fillText(ending.title || '终章余韵', W / 2, 214);

  ctx.font = '500 20px "Microsoft YaHei UI", sans-serif';
  ctx.fillStyle = 'rgba(248, 238, 222, 0.88)';
  const sumLines = wrapCanvasText(ctx, ending.summary || '', 880, 3);
  sumLines.forEach((ln, i) => ctx.fillText(ln, W / 2, 266 + i * 32));

  const eps = Array.isArray(ending.epilogues) ? ending.epilogues.slice(0, 4) : [];
  ctx.textAlign = 'left';
  const cardW = 540;
  const cardH = 98;
  eps.forEach((ep, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 86 + col * 568;
    const y = 398 + row * 116;
    ctx.fillStyle = 'rgba(255, 248, 236, 0.06)';
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(244, 205, 134, 0.28)';
    ctx.stroke();
    ctx.font = '700 17px "Microsoft YaHei UI", sans-serif';
    ctx.fillStyle = '#f7d598';
    ctx.fillText(ep.speaker || '', x + 18, y + 30);
    ctx.font = '400 15.5px "Microsoft YaHei UI", sans-serif';
    ctx.fillStyle = 'rgba(248, 238, 222, 0.86)';
    const elines = wrapCanvasText(ctx, ep.line || '', cardW - 36, 2);
    elines.forEach((ln, li) => ctx.fillText(ln, x + 18, y + 58 + li * 22));
  });

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${groupName}-${ending.title || 'ending'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function createStoryTheaterV3Controller({
  api,
  toast,
  getActiveGroup,
  botNameOf,
  onGroupUpdated,
  onRewind,
  onApplyBgUrl,
  getStageCgContext,
}) {
  let backdrop = null;

  const ensureBackdrop = () => {
    if (backdrop && backdrop.isConnected) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'stv3-modal-backdrop';
    backdrop.id = 'storyTheaterV3Modal';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backdrop && !backdrop.hidden) {
        e.stopPropagation();
        closeModal();
      }
    });
    document.body.appendChild(backdrop);
    return backdrop;
  };

  function closeModal() {
    if (!backdrop) return;
    backdrop.hidden = true;
    backdrop.innerHTML = '';
  }

  const showModal = (innerHtml, { wide = false } = {}) => {
    const bd = ensureBackdrop();
    bd.innerHTML = `<div class="stv3-modal${wide ? ' is-wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
    bd.hidden = false;
    bd.querySelector('[data-stv3-close]')?.addEventListener('click', closeModal);
    return bd.firstElementChild;
  };

  const syncFromRes = (res) => {
    if (res && typeof onGroupUpdated === 'function') onGroupUpdated(res);
  };

  // --- 1. Story Bible Modal ---
  function openBibleModal(groupArg = null) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return;
    const sc = group.storyConfig || {};
    const modal = showModal(`
      <div class="stv3-modal-head">
        <div>
          <div class="stv3-modal-title">${v3Icon('bible', 'is-lg')}<span>剧情账本与伏笔记忆</span></div>
          <div class="stv3-modal-sub">永久钉在旁白与每位角色提示词顶部，演到第 100 幕也不会忘记前期伏笔</div>
        </div>
        <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
      </div>
      <div class="stv3-modal-body">
        <div class="stv3-bible-meta">
          <span>当前世界线：<strong>${esc(sc.worldline || '主线')}</strong> · 第 ${Number(sc.chapterCounter || 0)} 幕</span>
          <span>${sc.bibleChapter ? `上次提炼于第 ${sc.bibleChapter} 幕（每 4 幕自动刷新）` : '尚未提炼（演满 2 幕自动生成，或点击下方一键提炼）'}</span>
        </div>
        <textarea class="stv3-textarea" id="stv3BibleTextarea" rows="11" placeholder="【主线进展】…&#10;【已揭露线索】…&#10;【未解伏笔】…&#10;【角色状态】…">${esc(sc.storyBible || '')}</textarea>
      </div>
      <div class="stv3-modal-foot">
        <button type="button" class="stv3-btn" id="stv3BibleDistillBtn">${v3Icon('spark')}<span>AI 自动提炼最新伏笔</span></button>
        <button type="button" class="stv3-btn is-primary" id="stv3BibleSaveBtn">保存账本</button>
      </div>
    `);

    const ta = modal.querySelector('#stv3BibleTextarea');
    const distillBtn = modal.querySelector('#stv3BibleDistillBtn');
    const saveBtn = modal.querySelector('#stv3BibleSaveBtn');

    distillBtn.onclick = async () => {
      distillBtn.disabled = true;
      distillBtn.innerHTML = `${v3Icon('spark')}<span>正在提炼伏笔…</span>`;
      try {
        const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/bible/distill`, {
          method: 'POST',
          body: '{}',
        });
        syncFromRes(res);
        const textOut = String(res?.storyBible || '').trim();
        if (ta && textOut) ta.value = textOut;
        toast(textOut ? '已根据剧情提炼出最新伏笔账本' : '暂无足够剧情可提炼，请先开演 1 幕或手动填写');
      } catch (err) {
        toast(err?.message || '提炼剧情账本失败');
      } finally {
        distillBtn.disabled = false;
        distillBtn.innerHTML = `${v3Icon('spark')}<span>AI 自动提炼最新伏笔</span>`;
      }
    };

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/bible`, {
          method: 'PUT',
          body: JSON.stringify({ storyBible: ta.value }),
        });
        syncFromRes(res);
        toast('剧情账本已保存，下一句演绎立即生效');
        closeModal();
      } catch (err) {
        toast(err?.message || '保存剧情账本失败');
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  // --- 2. Director Secret Notes + Inner Voice OS + Dice & FX Switches ---
  function openSecretsModal(groupArg = null) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return;
    const sc = group.storyConfig || {};
    const notes = sc.secretNotes && typeof sc.secretNotes === 'object' ? sc.secretNotes : {};
    const members = Array.isArray(group.members) ? group.members : [];
    const modal = showModal(`
      <div class="stv3-modal-head">
        <div>
          <div class="stv3-modal-title">${v3Icon('secret', 'is-lg')}<span>导演密信与演出开关</span></div>
          <div class="stv3-modal-sub">单独给某位角色塞隐藏底牌（其余成员不可见），营造悬疑信息差与反转张力</div>
        </div>
        <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
      </div>
      <div class="stv3-modal-body">
        <div class="stv3-toggle-grid">
          <label class="stv3-toggle-card">
            <div>
              <strong>${v3Icon('mind')}<span>读心术 · 角色心声</span></strong>
              <span>允许角色在发言后附带一句仅玩家可见的内心 OS</span>
            </div>
            <input type="checkbox" id="stv3OptInnerVoice" ${sc.innerVoiceEnabled ? 'checked' : ''}>
          </label>
          <label class="stv3-toggle-card">
            <div>
              <strong>${v3Icon('dice')}<span>命运骰子 · D20 检定</span></strong>
              <span>抉择与改写前投掷 20 面骰，按点数演绎成败</span>
            </div>
            <input type="checkbox" id="stv3OptDiceMode" ${sc.diceMode ? 'checked' : ''}>
          </label>
          <label class="stv3-toggle-card">
            <div>
              <strong>${v3Icon('finale')}<span>自动导演调度</span></strong>
              <span>随旁白情绪自动切换背景、舞台特效与 BGM 曲风</span>
            </div>
            <input type="checkbox" id="stv3OptAutoFx" ${sc.autoDirectorFx !== false ? 'checked' : ''}>
          </label>
        </div>

        <div class="stv3-secret-list" id="stv3SecretList">
          ${members.map((mid) => {
            const val = String(notes[mid] || '');
            return `<div class="stv3-secret-row${val ? ' has-note' : ''}" data-secret-bid="${esc(mid)}">
              <div class="stv3-secret-row-head">
                <span>${esc(botNameOf(mid))}</span>
                ${val ? '<span class="stv3-secret-badge">已埋底牌</span>' : '<span style="font-size:11px;opacity:0.55;">未埋密信</span>'}
              </div>
              <input type="text" class="stv3-input" placeholder="输入仅 ${esc(botNameOf(mid))} 一人可见的秘密底牌或私密导演指令（留空清除）…" value="${esc(val)}">
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="stv3-modal-foot">
        <button type="button" class="stv3-btn" data-stv3-close>取消</button>
        <button type="button" class="stv3-btn is-primary" id="stv3SaveSecretsBtn">保存全部导演设定</button>
      </div>
    `);

    modal.querySelectorAll('[data-stv3-close]').forEach((b) => { b.onclick = closeModal; });
    const saveBtn = modal.querySelector('#stv3SaveSecretsBtn');
    saveBtn.onclick = async () => {
      const secretNotes = {};
      modal.querySelectorAll('[data-secret-bid]').forEach((row) => {
        const bid = row.dataset.secretBid;
        const val = (row.querySelector('input')?.value || '').trim();
        if (bid && val) secretNotes[bid] = val;
      });
      saveBtn.disabled = true;
      try {
        const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/secrets`, {
          method: 'PUT',
          body: JSON.stringify({
            secretNotes,
            innerVoiceEnabled: Boolean(modal.querySelector('#stv3OptInnerVoice')?.checked),
            diceMode: Boolean(modal.querySelector('#stv3OptDiceMode')?.checked),
            autoDirectorFx: Boolean(modal.querySelector('#stv3OptAutoFx')?.checked),
          }),
        });
        syncFromRes(res);
        const cnt = Object.keys(secretNotes).length;
        toast(`导演设定已保存${cnt ? `（已悄悄递出 ${cnt} 封密信）` : ''}`);
        closeModal();
      } catch (err) {
        toast(err?.message || '保存导演设定失败');
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  // --- 4. Worldline Flowchart Tree Modal ---
  function openWorldlineTreeModal(groupArg = null) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return;
    const sc = group.storyConfig || {};
    const nodes = Array.isArray(sc.nodes) ? sc.nodes : [];

    const wlOrder = [];
    for (const n of nodes) {
      const wl = n.worldline || '主线';
      if (!wlOrder.includes(wl)) wlOrder.push(wl);
    }
    const colW = 252;
    const rowH = 102;
    const padX = 24;
    const padY = 24;
    const nodePos = new Map();
    const laneCount = new Map();
    nodes.forEach((n, idx) => {
      const wl = n.worldline || '主线';
      const laneIdx = Math.max(0, wlOrder.indexOf(wl));
      const stepInLane = laneCount.get(wl) || 0;
      laneCount.set(wl, stepInLane + 1);
      let col = stepInLane;
      if (stepInLane === 0 && n.parentId && nodePos.has(n.parentId)) {
        col = nodePos.get(n.parentId).col + 1;
        laneCount.set(wl, col + 1);
      }
      const x = padX + col * colW;
      const y = padY + laneIdx * rowH;
      nodePos.set(n.id, { x, y, col, laneIdx, idx, node: n });
    });

    let maxX = 480;
    let maxY = 220;
    for (const p of nodePos.values()) {
      maxX = Math.max(maxX, p.x + 240);
      maxY = Math.max(maxY, p.y + 96);
    }

    const paths = [];
    nodes.forEach((n, idx) => {
      const cur = nodePos.get(n.id);
      if (!cur) return;
      let parentPos = n.parentId ? nodePos.get(n.parentId) : null;
      if (!parentPos && idx > 0) {
        const prev = nodes[idx - 1];
        if ((prev.worldline || '主线') === (n.worldline || '主线')) {
          parentPos = nodePos.get(prev.id);
        }
      }
      if (!parentPos) return;
      const x1 = parentPos.x + 214;
      const y1 = parentPos.y + 36;
      const x2 = cur.x;
      const y2 = cur.y + 36;
      const mx = (x1 + x2) / 2;
      const isBranch = parentPos.laneIdx !== cur.laneIdx;
      paths.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${isBranch ? '#f0a65b' : 'rgba(235,199,134,0.48)'}" stroke-width="${isBranch ? 2.4 : 1.8}" ${isBranch ? 'stroke-dasharray="6 4"' : ''}/>`);
    });

    const latestId = nodes.length ? nodes[nodes.length - 1].id : '';
    const modal = showModal(`
      <div class="stv3-modal-head">
        <div>
          <div class="stv3-modal-title">${v3Icon('tree', 'is-lg')}<span>世界线分岔图谱</span></div>
          <div class="stv3-modal-sub">共 ${wlOrder.length || 1} 条世界线 · ${nodes.length} 个剧情节点 · 点击任意节点可原地回溯并开启平行 IF 线</div>
        </div>
        <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
      </div>
      <div class="stv3-modal-body">
        ${nodes.length ? `
          <div class="stv3-tree-wrap thin-scroll" id="stv3TreeScroll">
            <div class="stv3-tree-canvas" style="width:${maxX}px;height:${maxY}px;">
              <svg class="stv3-tree-svg" width="${maxX}" height="${maxY}">${paths.join('')}</svg>
              ${nodes.map((n) => {
                const p = nodePos.get(n.id);
                const label = String(n.title || '').startsWith('第 ') ? n.title : `第 ${n.chapter || 1} 幕 · ${n.title || '剧情节点'}`;
                return `<button type="button" class="stv3-tree-node${n.id === latestId ? ' is-latest' : ''}" data-tree-nid="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px;">
                  <div class="stv3-tree-node-wl">${esc(n.worldline || '主线')}${n.id === latestId ? ' · 当前' : ''}</div>
                  <div class="stv3-tree-node-title" title="${esc(label)}">${esc(label)}</div>
                </button>`;
              }).join('')}
            </div>
          </div>
          <div class="stv3-tree-rewind-bar" id="stv3TreeRewindBar" hidden>
            <div id="stv3TreeSelectedLabel" style="font-size:13px;color:#f7deb0;font-weight:600;"></div>
            <div class="stv3-tree-rewind-row">
              <input type="text" class="stv3-input" id="stv3TreeDirective" placeholder="输入从此幕起改写的 IF 线走向（留空则直接重演）…">
              <button type="button" class="stv3-btn is-primary" id="stv3TreeGoBtn">开启 IF 线</button>
            </div>
          </div>
        ` : '<div style="text-align:center;padding:44px 12px;opacity:0.7;">当前剧场尚未演完第一幕，开演后将自动绘制世界线分岔树。</div>'}
      </div>
      <div class="stv3-modal-foot">
        <button type="button" class="stv3-btn" data-stv3-close>关闭</button>
      </div>
    `, { wide: true });

    modal.querySelectorAll('[data-stv3-close]').forEach((b) => { b.onclick = closeModal; });
    const scrollEl = modal.querySelector('#stv3TreeScroll');
    if (scrollEl) requestAnimationFrame(() => { scrollEl.scrollLeft = scrollEl.scrollWidth; });

    let selectedNode = null;
    const rewindBar = modal.querySelector('#stv3TreeRewindBar');
    const selLabel = modal.querySelector('#stv3TreeSelectedLabel');
    const dirInp = modal.querySelector('#stv3TreeDirective');
    const goBtn = modal.querySelector('#stv3TreeGoBtn');

    modal.querySelectorAll('[data-tree-nid]').forEach((btn) => {
      btn.onclick = () => {
        selectedNode = nodes.find((x) => x.id === btn.dataset.treeNid) || null;
        if (!selectedNode || !rewindBar) return;
        rewindBar.hidden = false;
        selLabel.textContent = `已选定回溯节点：第 ${selectedNode.chapter || 1} 幕 · ${selectedNode.title || '剧情节点'}（${selectedNode.worldline || '主线'}）`;
        dirInp?.focus();
      };
    });
    if (goBtn) {
      const doRewind = async () => {
        if (!selectedNode || goBtn.disabled) return;
        goBtn.disabled = true;
        try {
          if (await onRewind?.(group, selectedNode, (dirInp?.value || '').trim())) closeModal();
        } finally {
          goBtn.disabled = false;
        }
      };
      goBtn.onclick = doRewind;
      dirInp?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doRewind(); }
      });
    }
  }

  // --- 4. Finale Convergence & Commemorative Ending Card Modal ---
  function openFinaleModal(groupArg = null) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return;
    const sc = group.storyConfig || {};
    const ending = sc.endingCard && sc.endingCard.title ? sc.endingCard : null;

    if (ending) {
      const modal = showModal(`
        <div class="stv3-modal-head">
          <div>
            <div class="stv3-modal-title">${v3Icon('trophy', 'is-lg')}<span>剧场结局纪念卡</span></div>
            <div class="stv3-modal-sub">${esc(group.name || '物语剧场')} · ${esc(ending.worldline || sc.worldline || '主线')} · 共 ${Number(ending.chapters || sc.chapterCounter || 1)} 幕</div>
          </div>
          <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
        </div>
        <div class="stv3-modal-body">
          <div class="stv3-ending-card">
            <div class="stv3-ending-rank">${esc(ending.rank || 'True End')}</div>
            <h2 class="stv3-ending-title">${esc(ending.title)}</h2>
            <p class="stv3-ending-summary">${esc(ending.summary || '')}</p>
            ${Array.isArray(ending.epilogues) && ending.epilogues.length ? `
              <div class="stv3-ending-epilogues">
                ${ending.epilogues.map((ep) => `<div class="stv3-ending-ep-item">
                  <strong>${esc(ep.speaker)}</strong>
                  <p>${esc(ep.line)}</p>
                </div>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
        <div class="stv3-modal-foot">
          <button type="button" class="stv3-btn" id="stv3ExportPosterBtn">${v3Icon('download')}<span>导出 16:9 纪念海报</span></button>
          <button type="button" class="stv3-btn" id="stv3EndingTreeBtn">${v3Icon('tree')}<span>回溯刷其他结局</span></button>
          <button type="button" class="stv3-btn is-primary" id="stv3Season2Btn">${v3Icon('spark')}<span>承接结局开启第二季</span></button>
        </div>
      `, { wide: true });

      modal.querySelector('#stv3ExportPosterBtn').onclick = () => {
        exportEndingPosterPng(ending, group.name || '物语剧场');
        toast('已导出 16:9 典藏结局纪念海报 PNG');
      };
      modal.querySelector('#stv3EndingTreeBtn').onclick = () => openWorldlineTreeModal(group);
      const s2Btn = modal.querySelector('#stv3Season2Btn');
      s2Btn.onclick = async () => {
        s2Btn.disabled = true;
        try {
          const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/season2`, {
            method: 'POST',
            body: JSON.stringify({ worldline: '第二季' }),
          });
          syncFromRes(res);
          toast('第二季新世界线已启幕，旁白正在展开新篇章');
          closeModal();
        } catch (err) {
          toast(err?.message || '开启第二季失败');
        } finally {
          s2Btn.disabled = false;
        }
      };
      return;
    }

    const modal = showModal(`
      <div class="stv3-modal-head">
        <div>
          <div class="stv3-modal-title">${v3Icon('finale', 'is-lg')}<span>收束终章 · 揭晓大结局</span></div>
          <div class="stv3-modal-sub">通知旁白回收全部核心伏笔，写出终章大结局并生成典藏结局纪念卡</div>
        </div>
        <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
      </div>
      <div class="stv3-modal-body">
        <div class="stv3-bible-meta">
          <span>当前进度：<strong>${esc(sc.worldline || '主线')} · 第 ${Number(sc.chapterCounter || 0)} 幕</strong></span>
          <span>收束后依然可从世界线树回溯刷其他结局，或一键开第二季</span>
        </div>
        <textarea class="stv3-textarea" id="stv3FinaleDirective" rows="4" placeholder="（可选）写下你期望的结局氛围或收束方向，例如：来一个反转后温情大团圆的 True End，或者意想不到的混沌结局…"></textarea>
      </div>
      <div class="stv3-modal-foot">
        <button type="button" class="stv3-btn" data-stv3-close>再演几幕</button>
        <button type="button" class="stv3-btn is-primary" id="stv3TriggerFinaleBtn">立即收束终章</button>
      </div>
    `);

    modal.querySelectorAll('[data-stv3-close]').forEach((b) => { b.onclick = closeModal; });
    const goBtn = modal.querySelector('#stv3TriggerFinaleBtn');
    goBtn.onclick = async () => {
      goBtn.disabled = true;
      try {
        const directive = (modal.querySelector('#stv3FinaleDirective')?.value || '').trim();
        const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/finale`, {
          method: 'POST',
          body: JSON.stringify({ directive }),
        });
        syncFromRes(res);
        toast('终章收束已启动，旁白正在撰写大结局与结局纪念卡…');
        closeModal();
      } catch (err) {
        toast(err?.message || '触发终章收束失败');
      } finally {
        goBtn.disabled = false;
      }
    };
  }

  // --- 6. Quick Capture 16:9 Stage Event CG & CG Gallery Modal ---
  async function quickCaptureCg(groupArg = null, { openGalleryAfter = false } = {}) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return null;
    const sc = group.storyConfig || {};
    const ctx = typeof getStageCgContext === 'function' ? (getStageCgContext(group) || {}) : {};
    try {
      toast('正在合成 16:9 剧场名场面 CG…');
      const dataUrl = await captureStageCgDataUrl({
        bgUrl: ctx.bgUrl || '/dimension-ui/gal-bgs/observatory.webp?v=e4c726fd80',
        castSprites: ctx.castSprites || [],
        chapter: Number(sc.chapterCounter || 1) || 1,
        worldline: sc.worldline || '主线',
        title: ctx.title || `${group.name || '物语剧场'} · 名场面`,
        speaker: ctx.speaker || '',
        caption: ctx.caption || sc.premise || '',
        mood: sc.lastStageCue?.mood || 'night',
      });
      const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/cg`, {
        method: 'POST',
        body: JSON.stringify({
          dataUrl,
          chapter: Number(sc.chapterCounter || 1) || 1,
          title: ctx.title || `第 ${Number(sc.chapterCounter || 1) || 1} 幕 · 名场面定格`,
          caption: extractInnerVoice(ctx.caption || '').cleanText.slice(0, 140),
        }),
      });
      syncFromRes(res);
      toast('已定格 16:9 高光事件 CG 并收入回想画廊');
      if (openGalleryAfter) openCgGalleryModal(res?.group || group);
      return res?.cg || null;
    } catch (err) {
      toast(err?.message || '生成剧场 CG 失败');
      return null;
    }
  }

  function openCgGalleryModal(groupArg = null) {
    const group = groupArg || getActiveGroup?.();
    if (!group?.id) return;
    const sc = group.storyConfig || {};
    const cgs = Array.isArray(sc.cgs) ? [...sc.cgs].reverse() : [];
    const modal = showModal(`
      <div class="stv3-modal-head">
        <div>
          <div class="stv3-modal-title">${v3Icon('cg', 'is-lg')}<span>剧场事件 CG 回想画廊</span>${cgs.length ? `<span class="stv3-count">${cgs.length}</span>` : ''}</div>
          <div class="stv3-modal-sub">一键把精彩瞬间定格为 16:9 电影感剧场 CG，或导入本地手绘 / AI 生成图珍藏</div>
        </div>
        <button type="button" class="stv3-close-btn" data-stv3-close aria-label="关闭">×</button>
      </div>
      <div class="stv3-modal-body">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <button type="button" class="stv3-btn is-primary" id="stv3CgSnapNowBtn">${v3Icon('camera')}<span>定格当前名场面 CG</span></button>
          <button type="button" class="stv3-btn" id="stv3CgUploadBtn">${v3Icon('upload')}<span>导入本地 CG 图片</span></button>
          <input type="file" id="stv3CgFileInput" accept="image/png,image/webp,image/jpeg" hidden>
        </div>
        ${cgs.length ? `
          <div class="stv3-cg-grid">
            ${cgs.map((cg) => `<div class="stv3-cg-card" data-cg-id="${esc(cg.id)}">
              <button type="button" class="stv3-cg-thumb-btn" data-cg-act="view" title="放大赏析">
                <img src="${esc(cg.url)}" alt="${esc(cg.title)}" loading="lazy">
              </button>
              <div class="stv3-cg-meta">
                <div class="stv3-cg-title" title="${esc(cg.title)}">${esc(cg.title)}</div>
                <div class="stv3-cg-sub">${esc(cg.worldline || '主线')} · 第 ${Number(cg.chapter || 1)} 幕</div>
                <div class="stv3-cg-actions">
                  <button type="button" data-cg-act="bg">设为舞台背景</button>
                  <button type="button" data-cg-act="dl">下载</button>
                  <button type="button" data-cg-act="del" style="color:#ffb4b4;">删除</button>
                </div>
              </div>
            </div>`).join('')}
          </div>
        ` : '<div style="text-align:center;padding:44px 12px;opacity:0.7;">画廊还是空的，点击上方「定格当前名场面 CG」拍下第一张剧场记忆吧。</div>'}
      </div>
      <div class="stv3-modal-foot">
        <button type="button" class="stv3-btn" data-stv3-close>关闭</button>
      </div>
    `, { wide: true });

    modal.querySelectorAll('[data-stv3-close]').forEach((b) => { b.onclick = closeModal; });
    const snapBtn = modal.querySelector('#stv3CgSnapNowBtn');
    snapBtn.onclick = async () => {
      snapBtn.disabled = true;
      try {
        await quickCaptureCg(group, { openGalleryAfter: true });
      } finally {
        snapBtn.disabled = false;
      }
    };

    const upBtn = modal.querySelector('#stv3CgUploadBtn');
    const fileInp = modal.querySelector('#stv3CgFileInput');
    upBtn.onclick = () => fileInp?.click();
    fileInp?.addEventListener('change', () => {
      const file = fileInp.files?.[0];
      fileInp.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/cg`, {
            method: 'POST',
            body: JSON.stringify({
              dataUrl: String(reader.result || ''),
              chapter: Number(sc.chapterCounter || 1) || 1,
              title: (file.name || '').replace(/\.[^.]+$/, '') || `第 ${Number(sc.chapterCounter || 1) || 1} 幕 · 自定义 CG`,
            }),
          });
          syncFromRes(res);
          toast('已将图片收入剧场 CG 画廊');
          openCgGalleryModal(res?.group || group);
        } catch (err) {
          toast(err?.message || '上传 CG 失败');
        }
      };
      reader.readAsDataURL(file);
    });

    modal.querySelectorAll('[data-cg-act]').forEach((btn) => {
      btn.onclick = async () => {
        const cid = btn.closest('[data-cg-id]')?.dataset.cgId;
        const cg = cgs.find((x) => x.id === cid);
        if (!cg) return;
        const act = btn.dataset.cgAct;
        if (act === 'view') {
          const lb = document.getElementById('chatImageLightbox');
          const img = document.getElementById('chatImageLightboxImg');
          if (lb && img) {
            img.src = cg.url;
            lb.hidden = false;
          } else {
            window.open(cg.url, '_blank');
          }
          return;
        }
        if (act === 'bg') {
          if (typeof onApplyBgUrl === 'function') onApplyBgUrl(cg.url, cg.title);
          toast(`已将「${cg.title}」设为沉浸舞台背景`);
          return;
        }
        if (act === 'dl') {
          const a = document.createElement('a');
          a.href = cg.url;
          a.download = `${cg.title || cg.id}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
        if (act === 'del') {
          try {
            const res = await api(`/api/dimension/groups/${encodeURIComponent(group.id)}/story/cg/${encodeURIComponent(cg.id)}`, {
              method: 'DELETE',
            });
            syncFromRes(res);
            toast('已从画廊移除该 CG');
            openCgGalleryModal(res?.group || group);
          } catch (err) {
            toast(err?.message || '删除 CG 失败');
          }
        }
      };
    });
  }

  return {
    openBibleModal,
    openSecretsModal,
    openWorldlineTreeModal,
    openFinaleModal,
    openCgGalleryModal,
    quickCaptureCg,
    closeModal,
  };
}
