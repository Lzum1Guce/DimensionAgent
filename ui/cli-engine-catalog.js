export const CLI_META = {
  antigravity: {
    label: 'Antigravity (agy)',
    desc: 'Google 官方 Antigravity 终端代理 · 支持沙盒一键下载与宿主机安装，无头流式调度多模型',
    pkg: 'antigravity.google/cli/install.sh',
  },
  'claude-code': {
    label: 'Claude Code',
    desc: 'Anthropic 官方编码代理 CLI · 支持维度 API 与 Claude 订阅',
    pkg: '@anthropic-ai/claude-code',
  },
  codex: {
    label: 'Codex',
    desc: 'OpenAI 官方编码代理 CLI · 支持维度 API 与 ChatGPT 订阅',
    pkg: '@openai/codex',
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    desc: 'Google 官方 Gemini 终端代理 · 支持 Google 账号与 API',
    pkg: '@google/gemini-cli',
  },
  'qwen-code': {
    label: 'Qwen Code',
    desc: '通义千问官方编码 CLI · 支持维度 API 与 Qwen OAuth',
    pkg: '@qwen-code/qwen-code',
  },
  opencode: {
    label: 'OpenCode',
    desc: '开源多供应商编码 CLI · 支持灵活模型路由',
    pkg: 'opencode-ai',
  },
  'kimi-code': {
    label: 'Kimi Code',
    desc: 'Moonshot 官方编码 CLI · 支持维度 API 与 Kimi 订阅',
    pkg: '@moonshot-ai/kimi-code',
  },
  'deepseek-harness': {
    label: 'DeepSeek Harness',
    desc: 'DeepSeek 官方编码 CLI (@deepseek-ai/dsh)',
    pkg: '@deepseek-ai/dsh',
  },
  hermes: {
    label: 'Hermes',
    desc: 'Nous Research 开源编码代理（首次拉取完整运行环境，耗时约 1-3 分钟）',
    pkg: 'hermes-agent.nousresearch.com/install.sh',
  },
};

export const CLI_ORDER = Object.keys(CLI_META);

export function cliEngineDisplayName(id) {
  return Object.hasOwn(CLI_META, id) ? CLI_META[id].label : String(id || 'CLI');
}

export function cliOptions(ids) {
  return ids.map(id => ({ id, label: cliEngineDisplayName(id) }));
}
