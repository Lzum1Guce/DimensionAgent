// Zero-dependency, XSS-safe lightweight Markdown & incremental block renderer for DimensionAgent.
import { copyMessageText, messageActionNotice } from './message-context-ui.js';
import { stickerUrl } from './stickers.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

let copyDelegated = false;
function ensureCopyDelegation() {
  if (copyDelegated || typeof document === 'undefined') return;
  copyDelegated = true;
  document.addEventListener('click', async event => {
    const btn = event.target.closest?.('.md-code-copy');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const block = btn.closest('.md-code-block');
    const code = block?.querySelector('code')?.textContent ?? '';
    try {
      await copyMessageText(code);
      const prev = btn.textContent;
      btn.textContent = '已复制 ✓';
      btn.classList.add('is-copied');
      setTimeout(() => {
        if (btn.isConnected) {
          btn.textContent = prev || '复制';
          btn.classList.remove('is-copied');
        }
      }, 1800);
    } catch {
      messageActionNotice('复制失败，请手动选中代码复制');
    }
  });
}

function safeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (/^https?:\/\/[^\s<>"'`]+$/i.test(trimmed)) return trimmed;
  return '';
}

function compileMentionRegex(opts) {
  if (opts?._mentionRe !== undefined) return opts._mentionRe;
  const list = opts?.members || opts?.mentionMembers;
  if (!Array.isArray(list) || !list.length) return null;
  const names = list
    .flatMap(m => [m?.name, m?.id])
    .filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length)
    .map(n => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return names.length ? new RegExp(`(@(?:${names.join('|')}))`, 'g') : null;
}

function renderInline(raw, opts = {}) {
  if (!raw) return '';
  const tokens = [];
  const stash = html => {
    const key = `\u0000MDTOK${tokens.length}\u0000`;
    tokens.push(html);
    return key;
  };

  // 1. Protect inline code spans first
  let text = String(raw).replace(/`([^`\r\n]+)`/g, (_, code) =>
    stash(`<code class="md-inline-code">${esc(code)}</code>`)
  );

  // 2. Protect sticker shortcodes [sticker:id]
  text = text.replace(/\[sticker:([^\]\r\n]{1,80})\]/g, (_, id) => {
    const url = esc(stickerUrl(id));
    return stash(`<img src="${url}" alt="[表情包]" class="chat-sticker" loading="lazy">`);
  });

  // 3. Protect explicit markdown links [label](https://...)
  text = text.replace(/\[([^\]\r\n]{1,200})\]\((https?:\/\/[^\s)\r\n]+)\)/gi, (full, label, url) => {
    const clean = safeUrl(url);
    if (!clean) return esc(full);
    return stash(`<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(label)}</a>`);
  });

  // 4. Protect bare URLs BEFORE HTML-escaping so '&' in query strings is escaped once, not twice (&amp;amp;)
  text = text.replace(/(^|[\s(（])(https?:\/\/[^\s<>"')）]+)/gi, (full, prefix, url) => {
    const clean = safeUrl(url);
    if (!clean) return full;
    return `${prefix}${stash(`<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(clean)}</a>`)}`;
  });

  // 5. Escape remaining plain text
  let safe = esc(text);

  // 6. Bold, italic, strikethrough
  safe = safe.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/~~([^~\r\n]+)~~/g, '<del>$1</del>');
  safe = safe.replace(/(^|[^*])\*([^*\s][^*\r\n]*?)\*(?!\*)/g, '$1<em>$2</em>');

  // 7. Highlight @mentions when group members are supplied
  const mentionRe = compileMentionRegex(opts);
  if (mentionRe) {
    safe = safe.replace(mentionRe, '<span class="gmsg-mention">$1</span>');
  }

  // 8. Restore stashed HTML tokens
  return safe.replace(/\u0000MDTOK(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] ?? '');
}

function parseTableRow(line) {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function isTableDivider(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = parseTableRow(trimmed);
  return cells.length >= 2 && cells.every(c => /^:?-{3,}:?$/.test(c));
}

function renderMarkdownBlocks(source, opts = {}) {
  ensureCopyDelegation();
  const raw = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return [];

  const preparedOpts = { ...opts, _mentionRe: compileMentionRegex(opts) };
  const blocks = [];
  const fenceRe = /```([a-zA-Z0-9_+-]{0,24})[ \t]*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of raw.matchAll(fenceRe)) {
    if (match.index > cursor) {
      blocks.push({ kind: 'prose', text: raw.slice(cursor, match.index) });
    }
    blocks.push({
      kind: 'code',
      lang: (match[1] || '').trim(),
      code: match[2].replace(/\n$/, ''),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    const tail = raw.slice(cursor);
    // Smoothly render unclosed streaming code fences instead of flashing raw prose
    const unclosedMatch = tail.match(/^([\s\S]*?)(?:^|\n)```([a-zA-Z0-9_+-]{0,24})[ \t]*(?:\n([\s\S]*))?$/);
    if (unclosedMatch) {
      if (unclosedMatch[1]) {
        blocks.push({ kind: 'prose', text: unclosedMatch[1] });
      }
      blocks.push({
        kind: 'code',
        lang: (unclosedMatch[2] || '').trim(),
        code: (unclosedMatch[3] || '').replace(/\n$/, ''),
      });
    } else {
      blocks.push({ kind: 'prose', text: tail });
    }
  }

  const out = [];
  for (const block of blocks) {
    if (block.kind === 'code') {
      const langLabel = block.lang ? esc(block.lang) : '代码';
      out.push(
        `<div class="md-code-block">` +
          `<div class="md-code-head"><span class="md-code-lang">${langLabel}</span>` +
          `<button type="button" class="md-code-copy" aria-label="复制代码">复制</button></div>` +
          `<pre class="md-code-pre"><code data-lang="${esc(block.lang)}">${esc(block.code)}</code></pre>` +
        `</div>`
      );
      continue;
    }

    const lines = block.text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<div class="md-heading md-h${level}">${renderInline(headingMatch[2], preparedOpts)}</div>`);
        i++;
        continue;
      }

      if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const headers = parseTableRow(lines[i]);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
          bodyRows.push(parseTableRow(lines[i]));
          i++;
        }
        const ths = headers.map(h => `<th>${renderInline(h, preparedOpts)}</th>`).join('');
        const trs = bodyRows.map(cols =>
          `<tr>${headers.map((_, idx) => `<td>${renderInline(cols[idx] ?? '', preparedOpts)}</td>`).join('')}</tr>`
        ).join('');
        out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote class="md-quote">${quoteLines.map(l => renderInline(l, preparedOpts)).join('<br>')}</blockquote>`);
        continue;
      }

      if (/^[-*+]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
          i++;
        }
        out.push(`<ul class="md-list">${items.map(it => `<li>${renderInline(it, preparedOpts)}</li>`).join('')}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
          i++;
        }
        out.push(`<ol class="md-list">${items.map(it => `<li>${renderInline(it, preparedOpts)}</li>`).join('')}</ol>`);
        continue;
      }

      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(?:#{1,4}\s+|>\s?|[-*+]\s+|\d+\.\s+|(?:-{3,}|\*{3,}|_{3,})$)/.test(lines[i].trim()) &&
        !(lines[i].trim().includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))
      ) {
        para.push(renderInline(lines[i], preparedOpts));
        i++;
      }
      if (para.length) {
        out.push(`<p class="md-p">${para.join('<br>')}</p>`);
      }
    }
  }

  return out;
}

export function renderMarkdownHtml(source, opts = {}) {
  return renderMarkdownBlocks(source, opts).join('');
}

function bindStickerFallbacks(root) {
  root.querySelectorAll('img.chat-sticker:not([data-fallback-bound])').forEach(img => {
    img.dataset.fallbackBound = '1';
    img.onerror = () => {
      const fallback = document.createElement('span');
      fallback.textContent = '[表情暂不可用]';
      img.replaceWith(fallback);
    };
  });
}

const blockStateMap = new WeakMap();

export function renderRichMessage(element, text, opts = {}) {
  if (!element) return;
  element.classList.add('md-content');
  const nextBlocks = renderMarkdownBlocks(text, opts);
  const prevBlocks = blockStateMap.get(element);

  // Incremental block reconciliation: keep completed upper DOM blocks intact so text selection
  // on finished code blocks survives streaming updates and layout/GC thrashing is minimized!
  if (prevBlocks && prevBlocks.length > 0 && element.children.length === prevBlocks.length) {
    let common = 0;
    const minLen = Math.min(prevBlocks.length, nextBlocks.length);
    while (common < minLen && prevBlocks[common] === nextBlocks[common]) {
      common++;
    }
    if (common > 0) {
      while (element.children.length > common) {
        element.lastElementChild?.remove();
      }
      if (common < nextBlocks.length) {
        const temp = document.createElement('div');
        temp.innerHTML = nextBlocks.slice(common).join('');
        bindStickerFallbacks(temp);
        while (temp.firstElementChild) {
          element.appendChild(temp.firstElementChild);
        }
      }
      blockStateMap.set(element, nextBlocks);
      return;
    }
  }

  element.innerHTML = nextBlocks.join('');
  bindStickerFallbacks(element);
  blockStateMap.set(element, nextBlocks);
}
