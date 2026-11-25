# DimensionAgent

DimensionAgent 是一款 Windows 桌面 AI 角色聊天与协作软件。你可以和一个角色聊日常，让八位角色同台讨论，也可以打开 Work 工坊，让她们在你的项目里读代码、修改文件、跑测试。

[下载 Windows x64 安装包](https://github.com/Lzum1Guce/DimensionAgent/releases/download/v0.7.28/DimensionAgent-0.7.28-Windows-x64-Setup.exe) · [查看发布说明与校验文件](https://github.com/Lzum1Guce/DimensionAgent/releases/latest)

## Chat · 和八位角色一起聊天

首次打开会看到 **DeepSeek、GPT、Claude、GLM、Grok、Gemini、Kimi、Qwen**，以及一个空的「AI 娘茶话会」。每位角色都有自己的人设、说话风格和立绘。实际生成回复的模型由你配置，同一个模型也可以扮演不同角色。

单聊时，可以切到沉浸模式，跟着立绘和对白框逐句阅读。群聊时，可以让几位角色各自出主意，再把想法整理成共同的决定。第一次试用，可以在茶话会发一句：

> 周末去露营，每个人只能带一样东西。你们各带什么？最后一起列一份清单。

角色记忆让对话可以接续之前的话题。想听角色说话时，可以再连接自己的 Breeze 语音服务。[查看内置角色设定](include/dimension/default_roster.hpp)

## Work · 把项目交给角色协作

Work 群聊现在默认由群主拟计划、分配成员并审查交付。确认前可以只调整一个节点，或选择「我来分配」。手动更换成员或执行组合会锁定该节点。群主按验收条件检查成员回执，退回时保留已有输出，等待用户决定。重新确认将重跑整张蓝图。

模型池支持按 CLI、模型专长和相对成本选择执行组合。节点记录开工时指定的路线、执行器回报及耗时。首次使用保留八位内置角色，由用户配置自己的模型服务或 CLI 登录。


你可以先说“我想做个星露谷插件”，再和角色商量具体玩法。需求清楚后，Work 会先给出计划。单聊会写明拟定方案和执行任务的模型；群聊会列出各成员的职责、引擎和模型。点击 **按此计划开始** 或回复“执行”，角色才开始查看工作区、调用工具或派单。改动方案后需要重新确认。

退出再打开会话可以继续查看待确认方案。已确认的路线不可用时，客户端会提示重新选择；CLI 使用账号默认且无法识别型号时，方案会明确说明。以“直接做，不用先出计划：”开头可跳过本次规划。

选择一个本地项目目录，就能在 Windows 原生工位里给角色派活。可以从一个只读任务开始：

> 帮我找出项目的启动入口和测试命令，告诉我它们分别在哪个文件里，先不要改代码。

- **单人工作**：让一个角色读取项目、编辑文件或运行命令，在客户端查看进度和改动。
- **群聊分工**：让一位成员排查启动问题，另一位检查测试覆盖。群主会先汇报职责、模型和选择理由，再派发任务。模型池由你勾选，可以包含 API 模型和本机 CLI 型号。
- **CLI 与 GitHub**：已安装并登录的 Kimi Code、DeepSeek Harness、Codex、Claude Code 等可以参与执行。在「扩展中枢 → GitHub 连接」确认账号和仓库权限后，可以让成员查 Issue、创建 PR 或核对 CI。

## 第一次使用

1. 在 Windows 10/11 x64 上安装客户端。缺少 WebView2 的电脑首次安装需要联网。当前 v0.7.28 安装包未签名，Windows 可能显示 SmartScreen 提示。
2. 从开始菜单打开 DimensionAgent，在模型设置中填写自己的服务地址、模型名和密钥。选一个角色发出第一条消息，或进入「AI 娘茶话会」开始群聊。
3. 需要编程协作时，再选择项目目录和 Work 工位。外部 CLI、GitHub、WSL 沙盒和语音服务按需配置。

新安装从空白聊天记录开始。模型调用使用你自己的账号和配额，安装包不含开发者的密钥、聊天记录或个人工作区。

## 在 Windows 上从源码运行

准备 Windows 10/11 x64、Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」和 Windows SDK，以及 CMake 3.24 或更新版本、Ninja、Node.js 22 或更新版本（含 npm）和 Microsoft Edge WebView2 Evergreen Runtime。在 **x64 Native Tools Command Prompt for VS 2022** 中进入仓库根目录，执行以下命令。

```bat
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target DImensionagent DImensionagent-native
npm ci --prefix runtime --ignore-scripts
powershell -NoProfile -File tools/start-client.ps1
```

启动脚本首次从微软的 NuGet 包获取固定版本的 x64 WebView2Loader.dll 并核对 SHA-256。在离线环境中，可通过 `-LoaderPath` 提供相同版本的 DLL。WebView2 SDK 头文件和声明位于 `third_party/webview2`。开发版的账号配置、聊天记录、记忆和浏览器缓存保存在已加入 Git 忽略列表的 `.local-client/` 中。

**运行基础测试**

```bat
cmake --build build --target json_test scheduler_test model_test runs_test
ctest --test-dir build --output-on-failure -R "^(json|scheduler|model|runs)$"
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/`、`include/` | C++ 桌面宿主、后端、角色数据模型、任务和工具执行 |
| `ui/` | WebView2 前端、默认角色头像、立绘及其他界面资源 |
| `runtime/` | Node 插件宿主、CLI 桥接、浏览工具及 npm 依赖锁 |
| `linux/` | 可选 WSL 助手源码、脚本和运行环境说明 |
| `tests/` | C++ 单元测试与集成测试；部分集成测试要求额外运行时、沙盒或测试夹具 |

桌面聊天和 Windows 本机 Work 可以独立运行。构建 Windows 目标不会自动安装 WSL 发行版、第三方 CLI 或语音服务。需要沙盒时，参阅 `linux/README.txt` 并配置对应环境。

## 许可及署名

原创程序代码沿用项目根目录的 [MIT License](LICENSE)。改编的前端组件保留上游许可与署名，见 [前端第三方声明](ui/THIRD_PARTY_NOTICES.txt) 和 `ui/LICENSES/`。WebView2 SDK 头文件附带微软的 LICENSE 和 NOTICE。第三方依赖按各自许可使用。

素材由 AI 制作。
