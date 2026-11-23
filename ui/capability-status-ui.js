const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text; return element;
};

const styles = `
.cap-status-dialog{width:min(820px,calc(100vw - 32px));max-height:min(780px,calc(100dvh - 32px));padding:0;border:1px solid var(--color-composer-ring);border-radius:16px;background:var(--color-raised);color:var(--color-ink);overflow:auto}
.cap-status-dialog::backdrop{background:rgb(18 16 14 / .35)}
.cap-status-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;background:var(--color-raised);border-bottom:1px solid var(--color-composer-ring)}
.cap-status-head h2{margin:0;font-size:18px}.cap-status-head-actions{display:flex;flex-wrap:wrap;gap:8px}
.cap-status-dialog button{min-height:34px;padding:0 12px;border:1px solid var(--color-composer-ring);border-radius:10px;background:var(--color-raised);color:inherit;font:inherit;cursor:pointer}
.cap-status-dialog button:hover{background:var(--color-raised-hover)}.cap-status-dialog button:disabled{opacity:.55;cursor:default}
.cap-status-primary{background:var(--color-accent)!important;color:var(--color-accent-ink)!important;border-color:transparent!important}
.cap-status-body{padding:18px 22px 22px}.cap-status-summary{margin:0 0 8px;font-size:13px;color:var(--color-ink-secondary)}
.cap-status-note{margin:0 0 16px;font-size:12px;color:var(--color-ink-tertiary)}
.cap-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cap-status-card{padding:14px;border:1px solid var(--color-composer-ring);border-radius:12px;background:var(--color-app)}
.cap-status-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.cap-status-card h3{margin:0;font-size:14px}
.cap-status-pill{flex:none;padding:2px 8px;border-radius:999px;font-size:11px;background:var(--color-control);color:var(--color-ink-secondary)}
.cap-status-card[data-tone=good] .cap-status-pill{color:var(--color-success)}.cap-status-card[data-tone=warn] .cap-status-pill{color:var(--color-warning)}.cap-status-card[data-tone=bad] .cap-status-pill{color:var(--color-danger)}
.cap-status-card ul{margin:0;padding:0;list-style:none;display:grid;gap:5px;font-size:12px;color:var(--color-ink-secondary);overflow-wrap:anywhere}
.cap-status-time{margin:14px 0 0;font-size:11px;color:var(--color-ink-tertiary)}
@media(max-width:620px){.cap-status-grid{grid-template-columns:1fr}.cap-status-head,.cap-status-body{padding-left:14px;padding-right:14px}}
`;

let longTaskObserverBound = false;
function installLongTaskTelemetry(api) {
  if (longTaskObserverBound || typeof PerformanceObserver === 'undefined') return;
  longTaskObserverBound = true;
  let lastReportedAt = 0;
  try {
    const observer = new PerformanceObserver(list => {
      const now = Date.now();
      if (now - lastReportedAt < 5000) return;
      for (const entry of list.getEntries()) {
        if (entry.duration >= 200) {
          lastReportedAt = now;
          const view = document.getElementById('modeSwitch')?.textContent?.trim() || 'app';
          void api('/api/native/diagnostics/ui-longtask', {
            method: 'POST',
            body: JSON.stringify({ durationMs: Math.round(entry.duration), view }),
          }).catch(() => {});
          break;
        }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch { /* Browser may not expose longtask observer; ignore quietly. */ }
}

const formatMib = bytes => Number.isFinite(bytes) && bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : '未知';

export function bindCapabilityStatus({ api }) {
  installLongTaskTelemetry(api);
  const existing = document.getElementById('capabilityStatusDialog');
  if (existing) return { open: () => existing.showModal(), close: () => existing.close(), refresh: () => existing.dispatchEvent(new Event('refresh')) };
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const dialog = node('dialog', 'cap-status-dialog'); dialog.id = 'capabilityStatusDialog'; dialog.setAttribute('aria-label', '能力状态');
  dialog.innerHTML = `<header class="cap-status-head"><h2>能力状态与运行诊断</h2><div class="cap-status-head-actions"><button type="button" data-probe class="cap-status-primary">真实连通测试</button><button type="button" data-refresh>重新检查</button><button type="button" data-close>关闭</button></div></header>
    <div class="cap-status-body"><p class="cap-status-summary" role="status">等待检查</p><p class="cap-status-note">默认打开仅做零副作用只读自检；点击「真实连通测试」可实测 WSL2 沙盒启动延迟与模型接口连通性（不消耗对话生成额度）。</p><div class="cap-status-grid"></div><p class="cap-status-time"></p></div>`;
  document.body.append(dialog);
  const probeButton = dialog.querySelector('[data-probe]'), refreshButton = dialog.querySelector('[data-refresh]'), grid = dialog.querySelector('.cap-status-grid'), summary = dialog.querySelector('.cap-status-summary');
  let version = 0, lastLiveProbe = null;
  const card = (title, state, tone, lines) => {
    const article = node('article', 'cap-status-card'); article.dataset.tone = tone;
    const head = node('div', 'cap-status-card-head'); head.append(node('h3', '', title), node('span', 'cap-status-pill', state)); article.append(head);
    const list = node('ul'); for (const line of lines) { const item = node('li', '', line); list.append(item); } article.append(list); return article;
  };
  const value = (result, fallback = null) => result.status === 'fulfilled' ? result.value : fallback;
  const errorText = result => result.status === 'rejected' ? String(result.reason?.message || result.reason || '检查失败') : '';
  const pluginData = async () => {
    try { return await api('/api/dimension/plugins'); }
    catch (primary) {
      try { const fallback = await api('/api/extensions'); return { plugins: fallback.extensions || fallback.plugins || [] }; }
      catch { throw primary; }
    }
  };
  const load = async ({ runLiveProbe = false } = {}) => {
    const ticket = ++version;
    refreshButton.disabled = true;
    probeButton.disabled = true;
    summary.textContent = runLiveProbe ? '正在执行真实连通测试（探测 WSL2 沙盒与模型服务商端点）…' : '正在分别检查各项能力与运行指标…';
    if (runLiveProbe) {
      try { lastLiveProbe = await api('/api/native/connectivity-check', { method: 'POST', body: '{}' }); }
      catch (err) { lastLiveProbe = { error: String(err?.message || err || '连通自检失败') }; }
    }
    const results = await Promise.allSettled([
      api('/api/status'), api('/api/native/info'), api('/api/providers'), api('/api/dimension/bootstrap'), pluginData(), api('/api/dimension/plugin-market'), api('/api/native/diagnostics'),
    ]);
    if (ticket !== version || !dialog.open) return;
    const [statusResult, infoResult, providerResult, bootstrapResult, pluginsResult, marketResult, diagResult] = results;
    const status = value(statusResult, {}), info = value(infoResult, {}), bootstrap = value(bootstrapResult, {}), diag = value(diagResult, null);
    const providerRows = Array.isArray(value(providerResult, [])) ? value(providerResult, []) : (value(providerResult, {}).providers || []);
    const pluginRows = value(pluginsResult, {}).plugins || value(pluginsResult, {}).extensions || [];
    const market = value(marketResult, {});
    const localReady = status.ready === true && info.stageStatus !== 'failed';
    const readyProviders = providerRows.filter(row => row.ready === true || row.readiness?.state === 'ready').length;
    const configuredProviders = providerRows.filter(row => row.secretConfigured === true || (typeof row.secretConfigured === 'string' && row.secretConfigured !== 'none')).length;
    const failedPlugins = pluginRows.filter(row => row.state === 'failed').length;
    const enabledPlugins = pluginRows.filter(row => row.enabled === true || row.state === 'loaded').length;
    const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
    const cards = [];
    if (statusResult.status === 'rejected' || infoResult.status === 'rejected') {
      cards.push(card('本地服务', '检查失败', 'bad', [errorText(statusResult) || errorText(infoResult), '其他项目仍会独立显示结果。']));
    } else cards.push(card('本地服务', localReady ? '正常' : '需处理', localReady ? 'good' : 'bad', [`版本 ${info.version || '未知'} · ${info.stageStatus || status.status || '未知'}`, `数据格式 ${info.dataFormat || '未知'} · Keep-Alive ${capabilities.includes('http-keepalive') ? '已启用' : '未启用'}`]));

    if (diag) {
      const http = diag.http || {}, apiStat = diag.api || {}, uiStat = diag.uiLongTasks || {};
      const slowCount = Number(apiStat.slowRequestsTotal || 0), uiCount = Number(uiStat.count || 0), rejected = Number(http.rejectedConnections || 0);
      const tone = rejected > 0 ? 'bad' : (slowCount > 5 || uiCount > 5) ? 'warn' : 'good';
      const stateLabel = rejected > 0 ? '曾出现连接限流' : (slowCount || uiCount) ? '有慢耗时记录' : '流畅';
      const diagLines = [
        `运行 ${Math.floor((diag.uptimeSeconds || 0) / 60)} 分钟 · 后端内存 ${formatMib(diag.memoryWorkingSetBytes)}`,
        `HTTP 请求 ${http.totalRequests || 0}（Keep-Alive 复用 ${http.reusedRequests || 0}）· 活跃连接 ${http.activeConnections || 0}/${http.maxConnections || 192} · 流 ${http.activeStreams || 0}/${http.maxStreams || 96}`,
        `后端慢请求(≥150ms)：${slowCount} 次（峰值 ${apiStat.maxDurationMs || 0}ms）· 前端主线程阻塞(≥200ms)：${uiCount} 次（峰值 ${uiStat.maxDurationMs || 0}ms）`,
      ];
      if (Array.isArray(apiStat.recentSlow) && apiStat.recentSlow.length) {
        const latest = apiStat.recentSlow[0];
        diagLines.push(`最近慢接口：${latest.method} ${latest.path} (${latest.durationMs}ms, HTTP ${latest.status})`);
      }
      cards.push(card('性能与卡顿诊断', stateLabel, tone, diagLines));
    }

    if (lastLiveProbe && !lastLiveProbe.error && lastLiveProbe.providers) {
      const p = lastLiveProbe.providers;
      const allOk = p.configuredWithUrl > 0 && p.reachableCount === p.configuredWithUrl;
      const lines = [
        `本地 127.0.0.1 接口正常 · 服务商实时探测耗时 ${p.latencyMs}ms`,
        `已配置地址接口可达：${p.reachableCount}/${p.configuredWithUrl}`,
      ];
      for (const item of (p.items || []).slice(0, 4)) {
        lines.push(`${item.providerId}：${item.reachable ? `可达（${item.modelCount} 个模型）` : `异常（${item.error || item.status}）`}`);
      }
      cards.push(card('网络与接口连通', p.configuredWithUrl === 0 ? '未配置外部地址' : (allOk ? '全部可达' : '部分异常'), p.configuredWithUrl === 0 ? 'warn' : (allOk ? 'good' : 'warn'), lines));
    } else {
      cards.push(card('网络', statusResult.status === 'fulfilled' ? '本地接口正常' : '本地接口失败', statusResult.status === 'fulfilled' ? 'good' : 'bad', [
        '已验证 127.0.0.1 本地接口',
        lastLiveProbe?.error ? `上次连通测试失败：${lastLiveProbe.error}` : '点击右上角「真实连通测试」可实测外部模型接口延迟',
      ]));
    }

    if (providerResult.status === 'rejected') cards.push(card('模型', '检查失败', 'bad', [errorText(providerResult), '没有读取或展示接口密钥']));
    else {
      const state = readyProviders ? '可用' : providerRows.length ? '需处理' : '未配置';
      const active = bootstrap.model?.effective || bootstrap.model?.modelSelection;
      cards.push(card('模型', state, readyProviders ? 'good' : 'warn', [`${readyProviders}/${providerRows.length} 个接口就绪 · ${configuredProviders} 个已配置凭据`, active ? `当前路由 ${active.providerId || ''} / ${active.model || ''}` : `当前模型 ${bootstrap.model?.model || '未选择'}`]));
    }
    if (pluginsResult.status === 'rejected') cards.push(card('插件', '检查失败', 'bad', [errorText(pluginsResult), '未更改插件安装或启用状态']));
    else cards.push(card('插件', failedPlugins ? '有加载失败' : '可查看', failedPlugins ? 'warn' : 'good', [`${pluginRows.length} 个已发现 · ${enabledPlugins} 个已启用 · ${failedPlugins} 个失败`, marketResult.status === 'fulfilled' ? `插件市场 ${market.available === false ? '不可用' : market.hostReady === false ? '宿主未就绪' : '接口可用'}` : '插件市场状态未确认']));

    const desktop = info.desktopConfigured === true;
    if (lastLiveProbe && lastLiveProbe.wsl) {
      const w = lastLiveProbe.wsl;
      cards.push(card('Linux / WSL2 沙盒', w.executionReady ? '执行正常' : w.reachable ? '执行未就绪' : 'WSL 不可达', w.executionReady ? 'good' : 'bad', [
        w.detail ? `${w.detail}（${w.latencyMs} ms）` : '已完成 WSL 探针',
        w.executionDetail || '执行助手尚未验证',
        `Linux 桌面 ${capabilities.includes('linux-desktop') ? '已声明' : '未声明'} · 隔离构建 ${capabilities.includes('sandbox-build-test') ? '已声明' : '未声明'}`,
      ]));
    } else {
      cards.push(card('Linux / WSL2 沙盒', desktop ? '已配置' : '未配置', desktop ? 'good' : 'warn', [`Linux 桌面 ${capabilities.includes('linux-desktop') ? '能力已声明' : '能力未声明'}`, `隔离构建 ${capabilities.includes('sandbox-build-test') ? '能力已声明' : '能力未声明'}`, '点击「真实连通测试」可实测 WSL2 沙盒响应耗时']));
    }

    grid.replaceChildren(...cards);
    const failures = results.filter(result => result.status === 'rejected').length;
    summary.textContent = failures ? `${failures} 项检查失败；其余结果仍可用。` : (runLiveProbe ? '真实连通测试与运行诊断已完成。' : '只读检查与运行诊断完成。');
    dialog.querySelector('.cap-status-time').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    refreshButton.disabled = false;
    probeButton.disabled = false;
  };
  const open = () => { if (!dialog.open) dialog.showModal(); void load(); };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  refreshButton.onclick = () => void load({ runLiveProbe: false });
  probeButton.onclick = () => void load({ runLiveProbe: true });
  dialog.addEventListener('refresh', () => void load({ runLiveProbe: false }));
  dialog.addEventListener('close', () => { version++; refreshButton.disabled = false; probeButton.disabled = false; });
  const trigger = document.getElementById('sharedCapabilityStatusBtn');
  if (trigger) trigger.onclick = open;
  return { open, close: () => dialog.close(), refresh: () => load({ runLiveProbe: false }) };
}
