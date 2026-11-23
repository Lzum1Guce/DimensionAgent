/* DimensionAgent — 大阿卡纳 3D 鼠标跟随全息塔罗闪卡系统 */
(() => {
  const TAROT_LIST = [
    {
      key: 'deepseek',
      botId: 'ai-deepseek',
      aliases: ['deepseek', '蓝鲸'],
      name: 'DeepSeek',
      roman: 'XVIII',
      arcana: 'THE MOON · 月亮',
      pattern: 'silk',
      glow: 'rgba(74, 158, 255, 0.55)',
      accent: '#7EC4FF',
      edge: '#B8DCFF',
      motto: '深海潜行，于静谧暗潮中拆解万象逻辑。',
      greeting: '刚摸完一条鱼回来——今天是先拆算法难题，还是先聊聊正事？（警告：不许叫我蓝色大肥鱼！）',
      prompts: ['帮我拆解一个棘手的逻辑或代码难题', '用最直白的话讲清楚一个硬核技术概念', '今天不想干活，陪我吐槽摸会儿鱼'],
      image: '/dimension-ui/tarot-cards/deepseek.webp?v=17228a9a40',
    },
    {
      key: 'gpt',
      botId: 'ai-gpt',
      aliases: ['gpt', 'chatgpt', 'openai', '龙娘'],
      name: 'ChatGPT',
      roman: 'XVII',
      arcana: 'THE STAR · 星星',
      pattern: 'cosmos',
      glow: 'rgba(186, 134, 255, 0.52)',
      accent: '#DEC4FF',
      edge: '#E6D6FF',
      motto: '以星辉为引，承接世间一切奇思妙想的许愿机。',
      greeting: '既然来找前辈了，就把你的愿望或企划摊开说说吧，我会替你搭好最稳妥的蓝图。',
      prompts: ['帮我把一个模糊的脑洞整理成完整企划', '给我的项目做一次全局复盘与优化建议', '讲一个既优雅又出人意料的创意点子'],
      image: '/dimension-ui/tarot-cards/gpt.webp?v=d3c27d4e9e',
    },
    {
      key: 'claude',
      botId: 'ai-claude',
      aliases: ['claude', '克劳德'],
      name: 'Claude',
      roman: 'XIX',
      arcana: 'THE SUN · 太阳',
      pattern: 'sunburst',
      glow: 'rgba(255, 146, 68, 0.54)',
      accent: '#FFD08A',
      edge: '#FFD89C',
      motto: '秩序、边界与光辉，将每一行代码与字句雕琢至臻。',
      greeting: '坐下吧。把你要重构的代码或者推敲的文章递过来——先说好，敷衍了事我可是会皱眉的。',
      prompts: ['帮我审校并重构一段不够优雅的代码', '把这段文字润色得更有结构感与质感', '一起设计一个干净可维护的系统架构'],
      image: '/dimension-ui/tarot-cards/claude.webp?v=098aaccb7e',
    },
    {
      key: 'glm',
      botId: 'ai-glm',
      aliases: ['glm', '智谱', 'zhipu', '狐娘'],
      name: '智谱 GLM',
      roman: 'IX',
      arcana: 'THE HERMIT · 隐者',
      pattern: 'cosmos',
      glow: 'rgba(120, 166, 245, 0.52)',
      accent: '#BFD8FF',
      edge: '#D2E2FF',
      motto: '提冷光星灯独行求索，将每一笔账与线索收入秘典。',
      greeting: '哼，终于想起找我了？先说清楚要干什么正事，要是敢坑我，这笔账可要记进小本本里。',
      prompts: ['帮我设计一套能直接跑通的自动化脚本', '一起排查一个让人头疼的中文业务需求', '看看你的「记仇小本本」今天记了谁'],
      image: '/dimension-ui/tarot-cards/glm.webp?v=e8cf3acbe0',
    },
    {
      key: 'grok',
      botId: 'ai-grok',
      aliases: ['grok', 'xai'],
      name: 'Grok',
      roman: 'XVI',
      arcana: 'THE TOWER · 高塔',
      pattern: 'sunburst',
      glow: 'rgba(238, 86, 78, 0.56)',
      accent: '#FFC67C',
      edge: '#FFD28E',
      motto: '雷霆破局，一斧劈开虚伪客套与陈旧教条。',
      greeting: '少来那些假惺惺的开场白——有什么真问题、硬骨头或者热乎大瓜，直接甩过来！',
      prompts: ['用第一性原理犀利拆解一个热门观点', '别打太极，直接帮我毒舌点评这个方案', '带我扒一扒最近科技圈最有意思的事'],
      image: '/dimension-ui/tarot-cards/grok.webp?v=ee6ad7bdee',
    },
    {
      key: 'gemini',
      botId: 'ai-gemini',
      aliases: ['gemini', '小猫娘', '猫娘'],
      name: 'Gemini',
      roman: 'VI',
      arcana: 'THE LOVERS · 恋人',
      pattern: 'cosmos',
      glow: 'rgba(182, 110, 255, 0.56)',
      accent: '#E9C4FF',
      edge: '#E8C8FF',
      motto: '双子星辉交映，以万千感官捕捉世界的每一缕流光。',
      greeting: '终于点开我啦！今天带了什么好看的图片、新奇网页或者大资料给我看？快拿出来嘛～',
      prompts: ['发一张图给你，帮我细看画面里的细节', '帮我构思一个高级感拉满的前端视觉方案', '把一堆跨领域零散资料串成清晰洞察'],
      image: '/dimension-ui/tarot-cards/gemini.webp?v=3ba21c1e70',
    },
    {
      key: 'kimi',
      botId: 'ai-kimi',
      aliases: ['kimi', 'moonshot', '月之暗面'],
      name: 'Kimi',
      roman: 'II',
      arcana: 'THE HIGH PRIESTESS · 女祭司',
      pattern: 'silk',
      glow: 'rgba(138, 176, 255, 0.54)',
      accent: '#D5E4FF',
      edge: '#DCEBFF',
      motto: '如三棱镜分光，将浩瀚长卷理出清澄透彻的脉络。',
      greeting: '夜深了，如果手头有读不完的长文档或理不清的思路，交给我慢慢帮你梳成条理吧。',
      prompts: ['帮我精读并提炼一份超长文档的核心要点', '做一个有理有据的深度资料调研对比', '帮我理顺一篇长文或报告的逻辑大纲'],
      image: '/dimension-ui/tarot-cards/kimi.webp?v=d328e6329d',
    },
    {
      key: 'qwen',
      botId: 'ai-qwen',
      aliases: ['qwen', '通义千问', '千问', '通义'],
      name: '通义千问',
      roman: 'XIV',
      arcana: 'TEMPERANCE · 节制',
      pattern: 'silk',
      glow: 'rgba(116, 178, 245, 0.52)',
      accent: '#F0DDA8',
      edge: '#E6DCBE',
      motto: '轻摇折扇调和万象，将繁杂工程稳健收口于无形。',
      greeting: '别急，先喝口茶。不管是写代码、理数据还是给项目收尾，一步步来，我们都能稳稳搞定。',
      prompts: ['帮我写一个开箱即用的工程效率小工具', '把这批杂乱的数据整理成清晰结构化表格', '帮我制定一份稳健可落地的执行清单'],
      image: '/dimension-ui/tarot-cards/qwen.webp?v=2b8d3b4065',
    },
  ];

  const BY_KEY = Object.fromEntries(TAROT_LIST.map((item) => [item.key, item]));

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getMeta(botId, botName = '') {
    const idLow = String(botId || '').trim().toLowerCase();
    const nameLow = String(botName || '').trim().toLowerCase();
    for (const item of TAROT_LIST) {
      if (idLow && (idLow === item.botId || idLow === item.key)) return item;
    }
    const hay = `${idLow} ${nameLow}`;
    for (const item of TAROT_LIST) {
      if (item.aliases.some((alias) => hay.includes(alias))) return item;
    }
    return null;
  }

  function buildCardMarkup(meta, { size = 'md', clickable = true, label = '' } = {}) {
    const cls = `tarot-holo-stage is-${size}${clickable ? ' is-clickable' : ''}`;
    const style = `--tarot-glow:${meta.glow};--tarot-accent:${meta.accent};--tarot-edge:${meta.edge};`;
    const aria = label || `鉴赏 ${meta.name} 大阿卡纳塔罗牌 ${meta.roman} ${meta.arcana}`;
    return `
      <div class="${cls}" data-tarot-key="${escapeHtml(meta.key)}" data-tarot-pattern="${escapeHtml(meta.pattern)}"
           style="${style}" ${clickable ? `role="button" tabindex="0" aria-label="${escapeHtml(aria)}" title="移动鼠标感受 3D 全息反光 · 点击放大鉴赏"` : ''}>
        <div class="tarot-holo-aura" aria-hidden="true"></div>
        <div class="tarot-holo-shadow" aria-hidden="true"></div>
        <div class="tarot-holo-card">
          <div class="tarot-holo-thickness t6" aria-hidden="true"></div>
          <div class="tarot-holo-thickness t5" aria-hidden="true"></div>
          <div class="tarot-holo-thickness t4" aria-hidden="true"></div>
          <div class="tarot-holo-thickness t3" aria-hidden="true"></div>
          <div class="tarot-holo-thickness t2" aria-hidden="true"></div>
          <div class="tarot-holo-thickness t1" aria-hidden="true"></div>
          <div class="tarot-holo-face">
            <img class="tarot-holo-art" src="${escapeHtml(meta.image)}" alt="${escapeHtml(meta.name)} ${escapeHtml(meta.arcana)}" draggable="false" loading="eager">
            <div class="tarot-holo-foil" aria-hidden="true"></div>
            <div class="tarot-holo-glare" aria-hidden="true"></div>
            <div class="tarot-holo-bevel" aria-hidden="true"></div>
            <div class="tarot-holo-sparkles" aria-hidden="true">
              <span class="tarot-spark s1"></span>
              <span class="tarot-spark s2"></span>
              <span class="tarot-spark s3"></span>
              <span class="tarot-spark s4"></span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderPersonaStageHTML(botId, botName = '') {
    const meta = getMeta(botId, botName);
    if (!meta) return '';
    return `
      <section class="tarot-persona-showcase" style="--tarot-glow:${meta.glow};--tarot-accent:${meta.accent};">
        <div class="tarot-persona-card-col">
          ${buildCardMarkup(meta, { size: 'sm', clickable: true })}
        </div>
        <div class="tarot-persona-info">
          <div class="tarot-arcana-badge">ARCANA ${escapeHtml(meta.roman)}</div>
          <h3 class="tarot-arcana-title">${escapeHtml(meta.arcana)}</h3>
          <p class="tarot-arcana-motto">${escapeHtml(meta.motto)}</p>
          <p class="tarot-arcana-hint">移动鼠标感受 3D 全息流光 · 点击牌面全屏鉴赏</p>
          <div class="tarot-persona-actions">
            <button type="button" class="tarot-chip-btn" data-tarot-inspect="${escapeHtml(meta.key)}">✦ 全屏鉴赏</button>
            <button type="button" class="tarot-chip-btn is-ghost" data-tarot-open-gallery>✦ 命运牌库</button>
          </div>
        </div>
      </section>`;
  }

  function renderEmptyStageHTML(botId, botName = '') {
    const meta = getMeta(botId, botName);
    if (!meta) return '';
    const chips = (meta.prompts || []).map((p) =>
      `<button type="button" class="tarot-prompt-chip" data-tarot-prompt="${escapeHtml(p)}">${escapeHtml(p)}</button>`
    ).join('');
    return `
      <div class="tarot-empty-stage" style="--tarot-glow:${meta.glow};--tarot-accent:${meta.accent};">
        <div class="tarot-empty-card-wrap">
          ${buildCardMarkup(meta, { size: 'md', clickable: true })}
        </div>
        <div class="tarot-empty-meta">
          <div class="tarot-empty-arcana">✦ ${escapeHtml(meta.roman)} · ${escapeHtml(meta.arcana)} ✦</div>
          <p class="tarot-empty-greeting">${escapeHtml(meta.greeting)}</p>
          <div class="tarot-empty-prompts">${chips}</div>
        </div>
      </div>`;
  }

  // 60fps 鼠标跟随 + 弹簧阻尼 + 闲置柔和呼吸引擎
  const activeControllers = new WeakMap();

  function attachController(stage, { maxRy = 22, maxRx = 16, globalPointer = false } = {}) {
    if (!stage || activeControllers.has(stage)) return;
    const state = {
      hovering: false,
      rx: 0, ry: 0, mx: 50, my: 50,
      trx: 0, try: 0, tmx: 50, tmy: 50,
      phase: Math.random() * Math.PI * 2,
      raf: 0,
      destroyed: false,
    };

    const applyVars = () => {
      const tiltMag = Math.min(1, Math.hypot(state.rx / maxRx, state.ry / maxRy));
      stage.style.setProperty('--rx', `${state.rx.toFixed(2)}deg`);
      stage.style.setProperty('--ry', `${state.ry.toFixed(2)}deg`);
      stage.style.setProperty('--mx', `${state.mx.toFixed(1)}%`);
      stage.style.setProperty('--my', `${state.my.toFixed(1)}%`);
      stage.style.setProperty('--sx', `${(-state.ry * 0.95).toFixed(1)}px`);
      stage.style.setProperty('--sy', `${(18 + state.rx * 0.75).toFixed(1)}px`);
      stage.style.setProperty('--foil-o', (0.34 + 0.56 * tiltMag + (state.hovering ? 0.12 : 0)).toFixed(3));
      stage.style.setProperty('--glare-o', (state.hovering ? (0.30 + 0.45 * tiltMag) : (0.14 + 0.22 * tiltMag)).toFixed(3));
    };

    const isMotionReduced = () => (
      document.hidden
      || document.documentElement.dataset.motion === 'off'
      || document.documentElement.dataset.motion === 'lite'
      || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
    );

    const ensureRaf = () => {
      if (!state.raf && !state.destroyed && !isMotionReduced()) {
        state.raf = requestAnimationFrame(tick);
      }
    };

    const tick = () => {
      state.raf = 0;
      if (state.destroyed || !stage.isConnected) {
        cleanup();
        return;
      }
      if (isMotionReduced()) {
        return;
      }
      if (!state.hovering) {
        state.try = 0;
        state.trx = 0;
        state.tmx = 50;
        state.tmy = 50;
      }
      const ease = state.hovering ? 0.16 : 0.09;
      state.rx += (state.trx - state.rx) * ease;
      state.ry += (state.try - state.ry) * ease;
      state.mx += (state.tmx - state.mx) * ease;
      state.my += (state.tmy - state.my) * ease;
      applyVars();

      const settled = !state.hovering
        && Math.abs(state.rx) < 0.06
        && Math.abs(state.ry) < 0.06
        && Math.abs(state.mx - 50) < 0.15
        && Math.abs(state.my - 50) < 0.15;
      if (!settled) {
        state.raf = requestAnimationFrame(tick);
      }
    };

    const onPointerMove = (e) => {
      if (isMotionReduced()) return;
      const rect = globalPointer
        ? { left: 0, top: 0, width: window.innerWidth || 1, height: window.innerHeight || 1 }
        : stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const nx = (px - 0.5) * 2; // -1 ~ 1
      const ny = (py - 0.5) * 2;
      state.hovering = true;
      state.try = nx * maxRy;
      state.trx = -ny * maxRx;
      state.tmx = px * 100;
      state.tmy = py * 100;
      ensureRaf();
    };

    const onPointerLeave = () => {
      state.hovering = false;
      ensureRaf();
    };

    const onClick = () => {
      if (!stage.classList.contains('is-clickable')) return;
      const key = stage.dataset.tarotKey;
      if (key) openLightbox(key);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    };

    const target = globalPointer ? window : stage;
    target.addEventListener('pointermove', onPointerMove, { passive: true });
    if (!globalPointer) {
      stage.addEventListener('pointerleave', onPointerLeave, { passive: true });
      stage.addEventListener('click', onClick);
      stage.addEventListener('keydown', onKeyDown);
    }

    const cleanup = () => {
      state.destroyed = true;
      if (state.raf) cancelAnimationFrame(state.raf);
      target.removeEventListener('pointermove', onPointerMove);
      if (!globalPointer) {
        stage.removeEventListener('pointerleave', onPointerLeave);
        stage.removeEventListener('click', onClick);
        stage.removeEventListener('keydown', onKeyDown);
      }
      activeControllers.delete(stage);
    };

    activeControllers.set(stage, cleanup);
    applyVars();
  }

  function mountInteractiveCards(root = document, opts = {}) {
    if (!root) return;
    const stages = root.querySelectorAll('.tarot-holo-stage');
    stages.forEach((stage) => attachController(stage, opts));
  }

  // 全屏 3D 鉴赏灯箱
  let lightboxEl = null;
  let lightboxKey = 'deepseek';
  let lightboxCleanup = null;

  function ensureLightbox() {
    if (lightboxEl) return lightboxEl;
    const el = document.createElement('div');
    el.className = 'tarot-lightbox';
    el.id = 'tarotHoloLightbox';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '大阿卡纳全息塔罗鉴赏');
    el.innerHTML = `
      <div class="tarot-lightbox-backdrop" data-tarot-lb-close></div>
      <div class="tarot-lightbox-inner">
        <button type="button" class="tarot-lb-close" data-tarot-lb-close aria-label="关闭鉴赏">×</button>
        <button type="button" class="tarot-lb-nav is-prev" id="tarotLbPrev" aria-label="上一张">‹</button>
        <div class="tarot-lb-stage-host" id="tarotLbHost"></div>
        <button type="button" class="tarot-lb-nav is-next" id="tarotLbNext" aria-label="下一张">›</button>
        <div class="tarot-lb-caption" id="tarotLbCaption"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-tarot-lb-close]')) closeLightbox();
    });
    el.querySelector('#tarotLbPrev').addEventListener('click', () => stepLightbox(-1));
    el.querySelector('#tarotLbNext').addEventListener('click', () => stepLightbox(1));
    window.addEventListener('keydown', (e) => {
      if (!lightboxEl || lightboxEl.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
    lightboxEl = el;
    return el;
  }

  function renderLightboxCard(key) {
    const meta = BY_KEY[key] || TAROT_LIST[0];
    lightboxKey = meta.key;
    const el = ensureLightbox();
    const host = el.querySelector('#tarotLbHost');
    const cap = el.querySelector('#tarotLbCaption');
    if (lightboxCleanup) { lightboxCleanup(); lightboxCleanup = null; }
    host.innerHTML = buildCardMarkup(meta, { size: 'lg', clickable: false });
    const stage = host.querySelector('.tarot-holo-stage');
    attachController(stage, { maxRy: 26, maxRx: 18, globalPointer: true });
    lightboxCleanup = activeControllers.get(stage) || null;
    cap.innerHTML = `
      <div class="tarot-lb-arcana">ARCANA ${escapeHtml(meta.roman)} · ${escapeHtml(meta.arcana)}</div>
      <div class="tarot-lb-name">${escapeHtml(meta.name)}</div>
      <div class="tarot-lb-motto">${escapeHtml(meta.motto)}</div>
      <div class="tarot-lb-tip">任意移动鼠标控制 3D 倾角与全息流光 · 方向键切换牌面 · ESC 退出</div>`;
  }

  function openLightbox(key) {
    const el = ensureLightbox();
    el.hidden = false;
    renderLightboxCard(key);
  }

  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.hidden = true;
    if (lightboxCleanup) { lightboxCleanup(); lightboxCleanup = null; }
  }

  function stepLightbox(delta) {
    const idx = TAROT_LIST.findIndex((x) => x.key === lightboxKey);
    const next = TAROT_LIST[(idx + delta + TAROT_LIST.length) % TAROT_LIST.length];
    renderLightboxCard(next.key);
  }

  // 「✦ 命运牌库」典藏展柜
  let galleryEl = null;
  let galleryOnSelect = null;

  function ensureGallery() {
    if (galleryEl) return galleryEl;
    const el = document.createElement('div');
    el.className = 'tarot-gallery-modal';
    el.id = 'tarotGalleryModal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '命运牌库 · 大阿卡纳典藏展柜');
    el.innerHTML = `
      <div class="tarot-gallery-backdrop" data-tarot-gal-close></div>
      <div class="tarot-gallery-shell">
        <header class="tarot-gallery-head">
          <div>
            <h2>✦ 命运牌库 · 大阿卡纳典藏</h2>
            <p>移动鼠标感受每一张全息闪卡的 3D 倾角与衍射流光 · 点击牌面全屏鉴赏</p>
          </div>
          <button type="button" class="tarot-gal-close" data-tarot-gal-close aria-label="关闭牌库">关闭</button>
        </header>
        <div class="tarot-gallery-grid" id="tarotGalleryGrid"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-tarot-gal-close]')) closeGallery();
      const chatBtn = e.target.closest('[data-tarot-chat-bot]');
      if (chatBtn) {
        const botId = chatBtn.dataset.tarotChatBot;
        const key = chatBtn.dataset.tarotChatKey;
        closeGallery();
        if (typeof galleryOnSelect === 'function') galleryOnSelect(botId, BY_KEY[key]);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (galleryEl && !galleryEl.hidden && (!lightboxEl || lightboxEl.hidden) && e.key === 'Escape') {
        closeGallery();
      }
    });
    galleryEl = el;
    return el;
  }

  function openGallery({ onSelectBot } = {}) {
    galleryOnSelect = onSelectBot || null;
    const el = ensureGallery();
    const grid = el.querySelector('#tarotGalleryGrid');
    grid.innerHTML = TAROT_LIST.map((meta) => `
      <article class="tarot-gallery-item" style="--tarot-glow:${meta.glow};--tarot-accent:${meta.accent};">
        ${buildCardMarkup(meta, { size: 'gal', clickable: true })}
        <div class="tarot-gallery-meta">
          <span class="tarot-gallery-roman">${escapeHtml(meta.roman)}</span>
          <strong>${escapeHtml(meta.name)}</strong>
          <span class="tarot-gallery-arcana">${escapeHtml(meta.arcana.split('·')[1]?.trim() || meta.arcana)}</span>
        </div>
        <button type="button" class="tarot-gallery-chat-btn" data-tarot-chat-bot="${escapeHtml(meta.botId)}" data-tarot-chat-key="${escapeHtml(meta.key)}">开启对话</button>
      </article>`).join('');
    el.hidden = false;
    mountInteractiveCards(grid, { maxRy: 22, maxRx: 16 });
  }

  function closeGallery() {
    if (!galleryEl) return;
    galleryEl.hidden = true;
    const grid = galleryEl.querySelector('#tarotGalleryGrid');
    if (grid) grid.innerHTML = '';
  }

  window.DimensionTarot = {
    cards: TAROT_LIST,
    getMeta,
    buildCardMarkup,
    renderPersonaStageHTML,
    renderEmptyStageHTML,
    mountInteractiveCards,
    openLightbox,
    closeLightbox,
    openGallery,
    closeGallery,
  };
})();
