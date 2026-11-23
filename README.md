# DimensionAgent

DimensionAgent 是 Windows x64 桌面角色聊天与协作工具。Chat 支持单聊、群聊和立绘剧场，Work 支持个人任务、多角色分工和本机 CLI。源码快照版本为 **0.7.26**。

首次启动会在本机创建 DeepSeek、GPT、Claude、GLM、Grok、Gemini、Kimi、Qwen 八位角色，以及空的「AI 娘茶话会」。角色人设位于 `include/dimension/default_roster.hpp`。配置自己的模型服务后即可开始对话。外部 CLI、GitHub、WSL 沙盒及 Breeze 语音按需在使用者电脑上配置。

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
