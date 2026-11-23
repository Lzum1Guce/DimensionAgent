const element = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
const styles = `
.change-diff{display:grid;gap:6px;margin-top:8px;min-width:0}.change-diff-summary{font-size:11px;color:var(--color-ink-secondary)}
.change-diff-lines{border:1px solid var(--color-composer-ring);border-radius:9px;overflow:auto;max-height:320px;background:var(--color-app)}
.change-diff-row{display:grid;grid-template-columns:20px minmax(0,1fr);gap:5px;padding:2px 8px;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.change-diff-row[data-kind=add]{background:color-mix(in srgb,var(--color-success) 12%,transparent);color:var(--color-success)}.change-diff-row[data-kind=del]{background:color-mix(in srgb,var(--color-danger) 10%,transparent);color:var(--color-danger)}
.change-diff-sign{user-select:none}.change-diff-fallback{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.change-diff-fallback pre{max-height:280px;overflow:auto;padding:8px;background:var(--color-app);white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:560px){.change-diff-fallback{grid-template-columns:1fr}}
`;
function ensureStyles() {
  if (document.getElementById('changeDiffStyles')) return;
  const style = document.createElement('style'); style.id = 'changeDiffStyles'; style.textContent = styles; document.head.append(style);
}
function fallback(root, oldText, newText) {
  const wrap = element('div', 'change-diff-fallback');
  for (const [title, value] of [['原文', oldText], ['替换为', newText]]) {
    const column = element('div'); column.append(element('strong', '', title), element('pre', '', value)); wrap.append(column);
  }
  root.append(wrap);
}
export function createChangeDiff(oldValue, newValue, { maxChars = 16000, maxLines = 600 } = {}) {
  ensureStyles();
  const oldText = String(oldValue ?? ''), newText = String(newValue ?? '');
  const oldPreview = oldText.slice(0, maxChars), newPreview = newText.slice(0, maxChars);
  const truncated = oldText.length > maxChars || newText.length > maxChars;
  const root = element('div', 'change-diff');
  if (oldPreview === newPreview && !truncated) {
    root.append(element('div', 'change-diff-summary', '两段内容没有文本差异。')); return root;
  }
  const oldLines = oldPreview.split(/\r?\n/), newLines = newPreview.split(/\r?\n/);
  const additions = { count: 0 }, deletions = { count: 0 };
  const header = element('div', 'change-diff-summary'); root.append(header);
  if (oldLines.length > maxLines || newLines.length > maxLines || oldLines.length * newLines.length > 360000) {
    header.textContent = `内容较大，使用前后对照预览${truncated ? ` · 每项截断为 ${maxChars} 字符` : ''}`;
    fallback(root, oldPreview, newPreview); return root;
  }
  const rows = newLines.length + 1, columns = oldLines.length + 1;
  const dp = new Uint16Array(rows * columns);
  for (let i = oldLines.length - 1; i >= 0; --i) for (let j = newLines.length - 1; j >= 0; --j) {
    dp[j * columns + i] = oldLines[i] === newLines[j] ? dp[(j + 1) * columns + i + 1] + 1 : Math.max(dp[(j + 1) * columns + i], dp[j * columns + i + 1]);
  }
  const operations = []; let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) { operations.push({ kind: 'context', text: oldLines[i] }); i++; j++; }
    else if (j < newLines.length && (i === oldLines.length || dp[(j + 1) * columns + i] >= dp[j * columns + i + 1])) { operations.push({ kind: 'add', text: newLines[j++] }); additions.count++; }
    else { operations.push({ kind: 'del', text: oldLines[i++] }); deletions.count++; }
  }
  header.textContent = `+${additions.count} 行 / −${deletions.count} 行${truncated ? ` · 每项截断为 ${maxChars} 字符` : ''}`;
  const list = element('div', 'change-diff-lines');
  for (const operation of operations) {
    const row = element('div', 'change-diff-row'); row.dataset.kind = operation.kind;
    row.append(element('span', 'change-diff-sign', operation.kind === 'add' ? '+' : operation.kind === 'del' ? '−' : ' '), element('span', '', operation.text || ' ')); list.append(row);
  }
  root.append(list); return root;
}
