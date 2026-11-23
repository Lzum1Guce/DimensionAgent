// 用文件内容 SHA-256 前 10 位替换 UI 目录中所有静态资源（含子目录 .webp、无初始 ?v= 的图片、JS 内样式引用）的版本号，
// 并自动计算 <script type="importmap"> 的精确 SHA-256 指纹同步至 index.html 的 Content-Security-Policy 头，
// 彻底杜绝手写版本号漏改导致的 WebView2 新旧缓存混跑。
// 用法：
//   更新哈希：node hash-versions.js <ui 目录>
//   门禁检查：node hash-versions.js <ui 目录> --check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dir = args.find(a => !a.startsWith('--'));
if (!dir) {
  console.error('usage: node hash-versions.js <ui-dir> [--check]');
  process.exit(1);
}

const hashCache = new Map();
const hashFile = (relFile, invalidate = false) => {
  const normalized = relFile.replace(/^\/+/, '');
  if (!invalidate && hashCache.has(normalized)) return hashCache.get(normalized);
  const full = path.join(dir, normalized);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
  hashCache.set(normalized, h);
  return h;
};

let changedRefs = 0;
let modifiedFiles = 0;
const missing = new Set();

// 1) 先扫描并更新所有顶层 JS 模块中引用的 CSS / 静态资源哈希（会改变该 JS 自身哈希，必须在 index.html 前执行）
const jsFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const jsName of jsFiles) {
  const jsPath = path.join(dir, jsName);
  const orig = fs.readFileSync(jsPath, 'utf8');
  let next = orig;

  // 匹配 './xxx.css?v=...' 或 'plugin-market-ui.css?v=...'
  next = next.replace(/([A-Za-z0-9._/-]+\.css)\?v=[A-Za-z0-9._-]+/g, (m, cssRel) => {
    const cleanRel = cssRel.replace(/^\.\//, '');
    const h = hashFile(cleanRel);
    if (!h) return m;
    const updated = `${cssRel}?v=${h}`;
    if (updated !== m) changedRefs++;
    return updated;
  });

  // 匹配 JS 内硬编码的 '/dimension-ui/<subpath>.<ext>?v=...' 或裸 '/dimension-ui/<subpath>.(png|webp|ico|svg)'
  next = next.replace(/\/dimension-ui\/([A-Za-z0-9._/-]+\.(?:png|ico|webp|svg|css))(?:\?v=([A-Za-z0-9._-]+))?/g, (m, relAsset) => {
    const h = hashFile(relAsset);
    if (!h) { missing.add(relAsset); return m; }
    const updated = `/dimension-ui/${relAsset}?v=${h}`;
    if (updated !== m) changedRefs++;
    return updated;
  });

  if (next !== orig) {
    modifiedFiles++;
    if (!checkOnly) {
      fs.writeFileSync(jsPath, next, 'utf8');
      hashFile(jsName, true);
    }
  }
}

// 2) 更新 index.html 中的 link / script / img（含漏写 ?v= 的属性）与 importmap 值
const indexPath = path.join(dir, 'index.html');
const origHtml = fs.readFileSync(indexPath, 'utf8');
// 归一化为 LF，确保磁盘字节与 Chromium HTML 解析器计算 CSP sha256 哈希时的文本 100% 一致
let html = origHtml.replace(/\r\n/g, '\n');

// 2a) 更新所有已带 ?v=... 的 /dimension-ui/... 引用（包括 importmap 右侧值）
html = html.replace(/\/dimension-ui\/([A-Za-z0-9._/-]+\.(?:js|css|png|ico|webp|svg))\?v=[A-Za-z0-9._-]+/g, (m, file) => {
  const h = hashFile(file);
  if (!h) { missing.add(file); return m; }
  const updated = `/dimension-ui/${file}?v=${h}`;
  if (updated !== m) changedRefs++;
  return updated;
});

// 2b) 为 HTML 标签属性 href="..." / src="..." 中漏写 ?v= 的静态资源自动补上 ?v=<hash>（不动 importmap 左侧裸键名）
html = html.replace(/((?:href|src)=["'])\/dimension-ui\/([A-Za-z0-9._/-]+\.(?:js|css|png|ico|webp|svg))(["'])/g, (m, prefix, file, suffix) => {
  const h = hashFile(file);
  if (!h) { missing.add(file); return m; }
  changedRefs++;
  return `${prefix}/dimension-ui/${file}?v=${h}${suffix}`;
});

// 2c) 自动重算 <script type="importmap"> 文本内容的 SHA-256 base64 哈希并同步进 CSP meta 标签
const importMapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (importMapMatch) {
  const mapDigest = crypto.createHash('sha256').update(importMapMatch[1], 'utf8').digest('base64');
  html = html.replace(
    /(<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'self' )'sha256-[A-Za-z0-9+/=_-]+'/,
    (m, pre) => {
      const updated = `${pre}'sha256-${mapDigest}'`;
      if (updated !== m) changedRefs++;
      return updated;
    }
  );
}

if (html !== origHtml) {
  modifiedFiles++;
  if (!checkOnly) {
    fs.writeFileSync(indexPath, html, 'utf8');
  }
}

if (checkOnly) {
  if (modifiedFiles > 0 || missing.size > 0) {
    console.error(`hash-versions check failed: ${changedRefs} stale reference(s) across ${modifiedFiles} file(s)`, missing.size ? `missing: ${[...missing].join(', ')}` : '');
    process.exit(1);
  }
  console.log('hash-versions check passed: all asset hashes and CSP importmap digest are up to date.');
  process.exit(0);
}

console.log(`updated ${changedRefs} reference(s) across ${modifiedFiles} file(s)`, missing.size ? `missing: ${[...missing].join(', ')}` : '');
