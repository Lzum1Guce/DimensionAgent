/**
 * 算力牌局 · Token Rumble — 全套卡牌图鉴弹窗（28 牌 / 8 角色 / 10 事件）、战绩统计弹窗与 AI 娘全员合照背景桌面鉴赏弹窗
 * 严格遵循无内联事件（CSP 合规）与零 Emoji 视觉规范
 */

import { CARD_LIST, CHARACTERS, GAME_MODES, SYSTEM_PROMPTS } from './data.js';
import { formatWinRate } from './stats.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatShortTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return '';
  }
}

export function renderCodexModal({ tab = 'cards', filter = 'all' } = {}) {
  const filteredCards =
    filter === 'all' ? CARD_LIST : CARD_LIST.filter((c) => c.kind === filter);

  const countBasic = CARD_LIST.filter((c) => c.kind === 'basic').length;
  const countTrick = CARD_LIST.filter((c) => c.kind === 'trick').length;
  const countEquip = CARD_LIST.filter((c) => c.kind === 'equip').length;
  const countSig = CARD_LIST.filter((c) => c.kind === 'signature').length;

  let bodyHtml = '';
  if (tab === 'cards') {
    bodyHtml = `
      <div class="tr-codex-filter-bar" role="tablist" aria-label="卡牌类型筛选">
        <button type="button" class="tr-chip-btn${filter === 'all' ? ' is-active' : ''}" data-action="codex-filter" data-filter="all">全部 (${CARD_LIST.length})</button>
        <button type="button" class="tr-chip-btn is-sig-tab${filter === 'signature' ? ' is-active' : ''}" data-action="codex-filter" data-filter="signature">AI 娘特色 (${countSig})</button>
        <button type="button" class="tr-chip-btn${filter === 'basic' ? ' is-active' : ''}" data-action="codex-filter" data-filter="basic">基础 / 爆发 (${countBasic})</button>
        <button type="button" class="tr-chip-btn${filter === 'trick' ? ' is-active' : ''}" data-action="codex-filter" data-filter="trick">策略锦囊 / 延时 (${countTrick})</button>
        <button type="button" class="tr-chip-btn${filter === 'equip' ? ' is-active' : ''}" data-action="codex-filter" data-filter="equip">算力插件 (${countEquip})</button>
      </div>
      <div class="tr-codex-card-grid">
        ${filteredCards
          .map(
            (card) => `
              <article class="tr-codex-card-item${card.kind === 'signature' ? ' is-signature' : ''}"${card.ownerCharId ? ` data-char="${esc(card.ownerCharId)}"` : ''}>
                <div class="tr-codex-art-box">
                  <img src="${esc(card.image)}" alt="${esc(card.name)}" loading="lazy" draggable="false" />
                  <span class="tr-codex-kind-tag is-${esc(card.kind)}">${esc(card.kindLabel)}</span>
                </div>
                <div class="tr-codex-card-meta">
                  <div class="tr-codex-card-title">
                    <strong>${esc(card.name)}</strong>
                    <small>${esc(card.actor)} 娘</small>
                  </div>
                  <p>${esc(card.desc)}</p>
                  ${card.resonanceDesc ? `<p class="tr-codex-resonance">${esc(card.resonanceDesc)}</p>` : ''}
                </div>
              </article>
            `,
          )
          .join('')}
      </div>
    `;
  } else if (tab === 'chars') {
    bodyHtml = `
      <div class="tr-codex-char-grid">
        ${CHARACTERS.map(
          (ch) => `
            <article class="tr-codex-char-item is-fullart" data-char="${esc(ch.id)}">
              <div class="tr-codex-char-art">
                <img src="${esc(ch.portrait)}" alt="${esc(ch.name)}" loading="lazy" draggable="false" />
                <div class="tr-codex-char-banner-scrim" aria-hidden="true"></div>
                <div class="tr-codex-char-banner-title">
                  <strong>${esc(ch.name)}</strong>
                  <span class="tr-pill">${esc(ch.title)}</span>
                  <span class="tr-pill is-subtle tr-num">稳态 ${ch.maxHp} · ${ch.activeCost} TK</span>
                </div>
              </div>
              <div class="tr-codex-char-info">
                <p><b>被动 · ${esc(ch.passiveName)}：</b>${esc(ch.passiveDesc)}</p>
                <p><b>协议技 · ${esc(ch.activeName)}：</b>${esc(ch.activeDesc)}</p>
              </div>
            </article>
          `,
        ).join('')}
      </div>
    `;
  } else {
    bodyHtml = `
      <div class="tr-codex-event-grid">
        ${SYSTEM_PROMPTS.map(
          (ev, idx) => `
            <article class="tr-codex-event-item is-${esc(ev.tone)}">
              <div class="tr-codex-event-head">
                <span class="tr-num tr-codex-event-idx">SP-${String(idx + 1).padStart(2, '0')}</span>
                <span class="tr-pill is-subtle">${esc(ev.short)}</span>
              </div>
              <strong>${esc(ev.title)}</strong>
              <p>${esc(ev.desc)}</p>
            </article>
          `,
        ).join('')}
      </div>
    `;
  }

  return `
    <div class="tr-modal-backdrop is-rich" role="dialog" aria-modal="true" aria-label="算力牌局图鉴" data-action="close-modal-backdrop">
      <div class="tr-rich-modal">
        <header class="tr-rich-modal-head">
          <div>
            <span class="tr-prompt-kicker">TOKEN RUMBLE ARCHIVE · 完整图鉴</span>
            <h3>算力牌局 · 全套卡牌与规则图鉴</h3>
          </div>
          <div class="tr-rich-tabs" role="tablist">
            <button type="button" class="tr-tb-btn${tab === 'cards' ? ' is-active' : ''}" data-action="codex-tab" data-tab="cards">功能牌 (${CARD_LIST.length})</button>
            <button type="button" class="tr-tb-btn${tab === 'chars' ? ' is-active' : ''}" data-action="codex-tab" data-tab="chars">AI 娘 (${CHARACTERS.length})</button>
            <button type="button" class="tr-tb-btn${tab === 'events' ? ' is-active' : ''}" data-action="codex-tab" data-tab="events">全局事件 (${SYSTEM_PROMPTS.length})</button>
            <button type="button" class="tr-tb-btn" data-action="close-modal">关闭</button>
          </div>
        </header>
        <div class="tr-rich-modal-body">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `;
}

export function renderStatsModal(stats) {
  const winRate = formatWinRate(stats.wins, stats.totalGames);

  const charRows = CHARACTERS.map((ch) => {
    const rec = stats.byChar?.[ch.id] || { games: 0, wins: 0, kills: 0 };
    return {
      ch,
      games: rec.games || 0,
      wins: rec.wins || 0,
      kills: rec.kills || 0,
      rate: rec.games ? Math.round((rec.wins / rec.games) * 100) : 0,
    };
  }).sort((a, b) => b.games - a.games || b.rate - a.rate);

  return `
    <div class="tr-modal-backdrop is-rich" role="dialog" aria-modal="true" aria-label="战绩与胜率统计" data-action="close-modal-backdrop">
      <div class="tr-rich-modal is-stats">
        <header class="tr-rich-modal-head">
          <div>
            <span class="tr-prompt-kicker">CAREER ANALYTICS · 个人战绩</span>
            <h3>算力牌局 · 战绩与胜率统计</h3>
          </div>
          <div class="tr-rich-tabs">
            <button type="button" class="tr-tb-btn" data-action="reset-stats" ${stats.totalGames === 0 ? 'disabled' : ''}>清空战绩</button>
            <button type="button" class="tr-tb-btn" data-action="close-modal">关闭</button>
          </div>
        </header>

        <div class="tr-rich-modal-body">
          <div class="tr-kpi-grid">
            <div class="tr-kpi-card">
              <span>总对局数</span>
              <strong class="tr-num">${stats.totalGames}</strong>
              <small class="tr-num">${stats.wins} 胜 / ${Math.max(0, stats.totalGames - stats.wins)} 负</small>
            </div>
            <div class="tr-kpi-card">
              <span>综合胜率</span>
              <strong class="tr-num">${esc(winRate)}</strong>
              <small>含 4P / 2v2 / 6P</small>
            </div>
            <div class="tr-kpi-card">
              <span>当前连胜</span>
              <strong class="tr-num">${stats.currentStreak}</strong>
              <small>持续保持手感</small>
            </div>
            <div class="tr-kpi-card">
              <span>最高连胜</span>
              <strong class="tr-num">${stats.bestStreak}</strong>
              <small>个人最佳纪录</small>
            </div>
          </div>

          <section class="tr-stats-section">
            <h4>分模式胜率</h4>
            <div class="tr-mode-stat-grid">
              ${GAME_MODES.map((m) => {
                const rec = stats.byMode?.[m.id] || { games: 0, wins: 0 };
                const pct = rec.games ? Math.round((rec.wins / rec.games) * 100) : 0;
                return `
                  <div class="tr-mode-stat-card">
                    <div class="tr-mode-stat-top">
                      <strong>${esc(m.name)}</strong>
                      <span class="tr-num">${rec.wins}/${rec.games} 胜 (${pct}%)</span>
                    </div>
                    <div class="tr-progress-track">
                      <div class="tr-progress-fill" style="width:${pct}%"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </section>

          <section class="tr-stats-section">
            <h4>8 位 AI 娘出战记录</h4>
            <div class="tr-char-stat-grid">
              ${charRows
                .map(
                  ({ ch, games, wins, kills, rate }) => `
                    <div class="tr-char-stat-item is-fullart" data-char="${esc(ch.id)}">
                      <img src="${esc(ch.portrait)}" alt="${esc(ch.name)}" />
                      <div class="tr-char-stat-meta">
                        <strong>${esc(ch.shortName)}</strong>
                        <small class="tr-num">${games} 局 · 胜率 ${rate}% · 淘汰 ${kills}</small>
                      </div>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>

          <section class="tr-stats-section">
            <h4>最近对局记录（最多 12 场）</h4>
            ${
              stats.recent.length
                ? `
                  <div class="tr-recent-list">
                    ${stats.recent
                      .map(
                        (r) => `
                          <div class="tr-recent-row">
                            <span class="tr-result-mini${r.won ? ' is-win' : ' is-lose'}">${r.won ? '胜' : '负'}</span>
                            <strong>${esc(r.charName)}</strong>
                            <span class="tr-pill is-subtle">${esc(r.modeName)}</span>
                            <span class="tr-pill is-subtle">${esc(r.roleName)}</span>
                            ${r.modelAssisted ? '<span class="tr-pill">接待模型参战</span>' : ''}
                            <span class="tr-recent-right tr-num">${r.rounds} 轮 · ${esc(formatShortTime(r.ts))}</span>
                          </div>
                        `,
                      )
                      .join('')}
                  </div>
                `
                : '<p class="tr-stats-empty">还没有完赛记录，快开一局 4P / 2v2 / 6P 吧！</p>'
            }
          </section>
        </div>
      </div>
    </div>
  `;
}

const GROUP_CAST_ORDER = [
  { seat: '1', name: 'Kimi',     trait: '静谧三棱镜 · 月光书卷' },
  { seat: '2', name: 'Claude',   trait: '精装典籍 · 学院风纪' },
  { seat: '3', name: 'DeepSeek', trait: '托腮鼓脸 · 娇憨蓝鲸' },
  { seat: '4', name: 'GPT',      trait: '白龙角翼 · 从容大姐' },
  { seat: '5', name: 'Gemini',   trait: '异瞳四芒星 · 元气猫娘' },
  { seat: '6', name: 'Qwen',     trait: '青花折扇 · 暖心邻家' },
  { seat: '7', name: 'GLM',      trait: '睡眠眼罩 · 傲娇狐班长' },
  { seat: '8', name: 'Grok',     trait: '黑金战斧 · 酷飒双马尾' },
];

const BG_MODE_OPTIONS = [
  { id: 'soft',    label: '柔光融合', desc: '合照清晰可见，牌面高对比度不干扰' },
  { id: 'vivid',   label: '清晰壁纸', desc: '全员合照原画高亮呈现，赏图优先' },
  { id: 'minimal', label: '极简纯色', desc: '隐藏照片背景，回归纯粹极简牌桌' },
];

export function renderWallpaperModal({ bgMode = 'soft' } = {}) {
  return `
    <div class="tr-modal-backdrop is-rich" role="dialog" aria-modal="true" aria-label="AI 娘全员合照背景桌面" data-action="close-modal-backdrop">
      <div class="tr-rich-modal is-wallpaper">
        <header class="tr-rich-modal-head">
          <div>
            <span class="tr-prompt-kicker">CLIENT OFFICIAL CAST · 8 位 AI 娘原设合照桌面</span>
            <h3>AI 娘全员合照 · 背景桌面</h3>
          </div>
          <div class="tr-rich-tabs">
            ${BG_MODE_OPTIONS.map(
              (opt) => `
                <button
                  type="button"
                  class="tr-tb-btn${bgMode === opt.id ? ' is-active' : ''}"
                  data-action="set-bg-mode"
                  data-bg-mode="${esc(opt.id)}"
                  title="${esc(opt.desc)}"
                >${esc(opt.label)}</button>
              `,
            ).join('')}
            <button type="button" class="tr-tb-btn" data-action="close-modal">关闭</button>
          </div>
        </header>

        <div class="tr-rich-modal-body is-wallpaper-body">
          <figure class="tr-wallpaper-stage">
            <img
              src="./art/table-bg.webp"
              alt="DimensionAgent 客户端 8 位 AI 娘全员性格大合照"
              draggable="false"
            />
          </figure>

          <div class="tr-wallpaper-cast" aria-label="合照全员站位（从左至右）">
            ${GROUP_CAST_ORDER.map(
              (item) => `
                <div class="tr-wallpaper-cast-pill">
                  <span class="tr-wallpaper-cast-idx tr-num">${esc(item.seat)}</span>
                  <div class="tr-wallpaper-cast-text">
                    <strong>${esc(item.name)}</strong>
                    <small>${esc(item.trait)}</small>
                  </div>
                </div>
              `,
            ).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}
