// Only explicit delegation relationships join task panels. Sharing a group,
// Bot, title or start time is not evidence that two tasks belong together.
export function workTaskGroups(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  const parents = new Map();
  const sameScope = (a, b) => (a.groupId || '') === (b.groupId || '');
  for (const record of records) {
    const parent = byId.get(record.parentRunId);
    if (parent && parent.id !== record.id && sameScope(parent, record)) parents.set(record.id, parent.id);
  }
  // Also understand an explicit assignment runId on older snapshots. Never
  // infer identity from a job key or assignee: one Bot can have many tasks.
  for (const parent of records) for (const job of parent.assignments || []) {
    const child = byId.get(job.runId);
    if (child && child.id !== parent.id && sameScope(child, parent) && !parents.has(child.id) && !child.parentRunId)
      parents.set(child.id, parent.id);
  }
  const rootOf = new Map(), groups = new Map();
  const resolvedParents = new Map();
  for (const record of records) {
    let rootId = record.id;
    const visited = new Set();
    let cycle = false;
    while (parents.has(rootId)) {
      if (resolvedParents.has(rootId)) {
        rootId = resolvedParents.get(rootId);
        break;
      }
      if (visited.has(rootId)) {
        // Keep legacy cycle handling, including malformed tails leading into a cycle.
        rootId = [...visited].sort()[0];
        cycle = true;
        break;
      }
      visited.add(rootId);
      rootId = parents.get(rootId);
    }
    if (!cycle) for (const id of visited) resolvedParents.set(id, rootId);
    rootOf.set(record.id, rootId);
    if (!groups.has(rootId)) groups.set(rootId, { root: byId.get(rootId), runs: [] });
    groups.get(rootId).runs.push(record);
  }
  return { groups: [...groups.values()], rootOf };
}

export function shortWorkReport(value, limit = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit - 1).join('') + '…' : text;
}

export function workReport(value, status = 'failed') {
  const text = String(value || '');
  if (['failed', 'interrupted', 'partial'].includes(status)) {
    if (/tool_round_limit_exceeded/i.test(text)) return '已达到本次操作轮数上限，任务尚未完成。可以继续任务。';
    if (/model output token limit reached/i.test(text)) return '本次模型输出达到长度上限，任务尚未完成。可以继续任务。';
  }
  return shortWorkReport(text);
}

// Turn a raw backend error string into something a person can act on.
// Returns { message, detail, resumable }: `message` is friendly Chinese copy,
// `detail` the original text (for a collapsible "查看详情"), and `resumable`
// whether continuing the same thread is a sensible next step.
const WORK_ERROR_RULES = [
  { re: /tool_round_limit_exceeded|round limit|max(imum)?[ _-]?(tool[ _-]?)?(rounds|turns|iterations)/i,
    message: '已达到本次操作轮数上限，任务尚未完成。可以让伙伴继续任务。', resumable: true },
  { re: /model output token limit reached|max[_ ]?tokens|output token|length limit|finish_reason[^a-z]*length/i,
    message: '本次模型输出达到长度上限，任务尚未完成。可以让伙伴继续任务。', resumable: true },
  { re: /context[_ ]?(length|window)|too many tokens|token limit|prompt is too long|maximum context/i,
    message: '对话上下文已接近上限，任务暂时停下了。可以继续任务，伙伴会精简记录后接着做。', resumable: true },
  { re: /interrupt|aborted|abort(ed)? by|cancel+ed by (restart|shutdown)|process (exited|killed)|restart(ed)?|ECONNRESET|socket hang up|stream (closed|ended)/i,
    message: '任务在执行途中被中断了，进度已保留。可以继续任务。', resumable: true },
  { re: /timed? ?out|timeout|ETIMEDOUT/i,
    message: '等待模型或工具响应超时，任务尚未完成。可以稍后继续任务。', resumable: true },
  { re: /\b(401|403)\b|unauthori[sz]ed|invalid api key|api key|authentication|forbidden/i,
    message: '模型服务鉴权失败，请检查 API 密钥或登录状态后再继续。', resumable: false },
  { re: /\b429\b|rate limit|quota|insufficient[_ ]?(balance|quota)|余额不足/i,
    message: '模型服务额度或频率受限，请稍后再继续，或在设置中更换模型。', resumable: true },
  { re: /not installed|ENOENT|command not found|未安装/i,
    message: '执行引擎在本机不可用，请在引擎选择中确认已安装后再试。', resumable: false },
];

export function classifyWorkError(value, status = 'failed') {
  const detail = String(value || '').trim();
  if (status === 'interrupted') {
    return { message: '任务在执行途中被中断了，进度已保留。可以继续任务。', detail, resumable: true };
  }
  for (const rule of WORK_ERROR_RULES) {
    if (rule.re.test(detail)) return { message: rule.message, detail, resumable: rule.resumable };
  }
  // Already-friendly Chinese text (no ASCII-heavy stack/JSON) can be shown as is.
  const looksRaw = /[{}[\]<>]|Error:|\bat\s+\S+\s*\(|\n\s+at\s/.test(detail) || detail.length > 160;
  return {
    message: detail && !looksRaw ? shortWorkReport(detail) : '任务执行出了点状况，可以查看详情后决定是否继续。',
    detail,
    resumable: false,
  };
}
