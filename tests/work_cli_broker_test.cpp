#include "dimension/work_cli_broker.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace dimension;

namespace {

int g_checks = 0;

void check(bool ok, const char* msg) {
    if (!ok) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
    ++g_checks;
}

} // namespace

int main(int argc, char** argv) {
    fs::path test_root = argc > 1 ? fs::path(argv[1]) : (fs::temp_directory_path() / "dim_work_cli_broker_test");
    std::error_code ec;
    fs::remove_all(test_root, ec);
    fs::create_directories(test_root, ec);

    // 1. Constraint extraction & speech-constraint scrubbing
    {
        const std::string raw =
            "创建一个 HTML 文件，用 SVG 绘制鹈鹕骑自行车。你不能进行任何测试，不允许调用 skills，不允许网络检索，不要调用记忆。";
        const auto c = extract_preserved_constraints(raw);
        check(c.forbid_tests, "forbid_tests detected");
        check(c.forbid_skills, "forbid_skills detected");
        check(c.forbid_network, "forbid_network detected");
        check(c.forbid_memory, "forbid_memory detected");
        check(c.single_file_only, "single_file_only detected");
        check(!c.hard_constraints.empty(), "hard_constraints verbatim extracted");

        const std::string dirty_persona =
            "傲娇优雅的大小姐，审美考究，偏爱宝石红与鎏金质感。\n每次回复不超过两句话，尽量少说话，保持惜字如金。";
        const std::string clean = scrub_speech_constraints(dirty_persona);
        check(clean.find("宝石红") != std::string::npos, "aesthetic traits preserved");
        check(clean.find("少说话") == std::string::npos && clean.find("不超过") == std::string::npos,
              "speech length limits scrubbed");

        BrokerEnrichRequest req;
        req.bot_id = "bot-rin";
        req.bot_name = "远坂凛";
        req.bot_persona = dirty_persona;
        req.raw_user_prompt = raw;
        req.chat_slot_model.base_url = "http://127.0.0.1:9/v1";
        req.chat_slot_model.model = "chat-fast";

        const auto enriched = enrich_prompt_with_persona(
            req,
            [](const ModelConfig& cfg, const std::vector<ModelMessage>&, std::stop_token) -> ModelReply {
                check(cfg.model == "chat-fast", "Broker uses Chat slot model");
                ModelReply r;
                r.text = R"({"greeting":"交给我吧，既然本小姐接手，画面质感肯定给你拉满。","tasteNotes":"采用暖阳鎏金渐变光影与流畅的反向运动学蹬踏细节。\n少说话，简短回复。"})";
                return r;
            });

        check(enriched.used_model_enrichment, "used_model_enrichment true");
        check(enriched.greeting.find("本小姐") != std::string::npos, "in-character greeting kept");
        check(enriched.enriched_prompt.find("不能进行任何测试") != std::string::npos, "raw constraint preserved");
        check(enriched.enriched_prompt.find("暖阳鎏金渐变") != std::string::npos, "persona taste injected");
        check(enriched.enriched_prompt.find("少说话") == std::string::npos, "leaked speech limit scrubbed from output");
    }

    // 2. Multi-CLI invocation preparation (Hermes, Kimi Code, Claude Code, Codex) + Dual Model Slot
    {
        std::vector<CliHarnessDescriptor> mock_harnesses{
            {"hermes", "Hermes Agent", "windows", "C:\\mock\\hermes.exe", "0.22.5", true, true, true, true},
            {"kimi-code", "Kimi Code CLI", "windows", "C:\\mock\\kimi.exe", "2.5.2", true, true, true, true},
            {"claude-code", "Claude Code CLI", "windows", "C:\\mock\\claude.exe", "1.0", true, true, true, true},
            {"codex", "Codex CLI", "windows", "C:\\mock\\codex.exe", "0.1", true, true, true, true}
        };

        CliHarnessRunRequest hreq;
        hreq.engine_id = "hermes";
        hreq.model_source = "work";
        hreq.bot_id = "bot-alpha";
        hreq.session_key = "grp1-thread9-bot-alpha";
        hreq.prompt = "Build demo";
        hreq.constraints.forbid_skills = true;
        hreq.constraints.forbid_tests = true;
        hreq.constraints.forbid_network = true;
        hreq.work_slot_model.base_url = "https://api.deepseek.com/v1";
        hreq.work_slot_model.api_key = "sk-work-slot-secret";
        hreq.work_slot_model.model = "deepseek-coder";
        hreq.work_slot_model.reasoning_effort = "high";
        hreq.workspace_dir = test_root / "ws1";
        hreq.data_root = test_root / "data";

        const auto h_inv = prepare_cli_invocation(hreq, mock_harnesses);
        check(h_inv.engine_id == "hermes", "Hermes engine selected");
        bool saw_custom = false, saw_session = false, saw_file_toolset = false, saw_reasoning = false;
        bool has_forbidden_gateway_flag = false;
        for (std::size_t i = 0; i < h_inv.args.size(); ++i) {
            if (h_inv.args[i] == "--no-restore-cwd" || h_inv.args[i] == "--worktree") has_forbidden_gateway_flag = true;
            if (h_inv.args[i] == "--provider" && i + 1 < h_inv.args.size() && h_inv.args[i + 1] == "custom") saw_custom = true;
            if (h_inv.args[i] == "-c" && i + 1 < h_inv.args.size() && h_inv.args[i + 1].starts_with("grp1-thread9-bot-alpha-")) saw_session = true;
            if (h_inv.args[i] == "-t" && i + 1 < h_inv.args.size() && h_inv.args[i + 1] == "file") saw_file_toolset = true;
            if (h_inv.args[i] == "--reasoning" && i + 1 < h_inv.args.size() && h_inv.args[i + 1] == "high") saw_reasoning = true;
        }
        check(!has_forbidden_gateway_flag, "Hermes gateway _UNSUPPORTED flags (--no-restore-cwd / --worktree) never emitted");
        check(saw_custom, "Hermes Work-slot custom provider injected");
        check(saw_session, "Hermes per-Bot persistent session key with route fingerprint passed");
        bool has_hermes_home_override = false;
        for (const auto& [ek, _] : h_inv.env_overrides) {
            if (ek == "HERMES_HOME") has_hermes_home_override = true;
        }
        check(!has_hermes_home_override, "Hermes uses native global home directly (avoids 162s borrowed-root uv sync)");

        // Hermes custom provider auto-inference when nativeProvider was empty in cached UI selection
        auto mock_hermes_named = mock_harnesses;
        mock_hermes_named[0].native_model_groups.push_back(
            CliNativeModelGroup{"CUSTOM · NANBEI", "nanbei", {"claude-opus-5-5"}});
        CliHarnessRunRequest hn_req = hreq;
        hn_req.model_source = "native";
        hn_req.native_provider.clear();
        hn_req.native_model = "claude-opus-5-5";
        const auto hn_inv = prepare_cli_invocation(hn_req, mock_hermes_named);
        bool saw_nanbei_prov = false, saw_opus_model = false;
        for (std::size_t i = 0; i + 1 < hn_inv.args.size(); ++i) {
            if (hn_inv.args[i] == "--provider" && hn_inv.args[i + 1] == "nanbei") saw_nanbei_prov = true;
            if (hn_inv.args[i] == "-m" && hn_inv.args[i + 1] == "claude-opus-5-5") saw_opus_model = true;
        }
        check(saw_nanbei_prov && saw_opus_model,
              "Hermes auto-infers custom --provider nanbei for claude-opus-5-5 even when nativeProvider is empty");
        {
            std::ifstream qin(hn_inv.temp_query_file, std::ios::binary);
            std::string qbody((std::istreambuf_iterator<char>(qin)), std::istreambuf_iterator<char>());
            check(qbody.find("claude-opus-5-5") != std::string::npos &&
                  qbody.find("严禁自称「我是 Hermes CLI") != std::string::npos,
                  "Hermes query file injects authoritative claude-opus-5-5 identity override against Hermes CLI self-branding");
        }
        fs::remove(hn_inv.temp_query_file, ec);

        // Host-to-other-model bare baseUrl / full endpoint normalization across Hermes & Codex
        CliHarnessRunRequest host_relay_req = hreq;
        host_relay_req.model_source = "work";
        host_relay_req.work_slot_model.base_url = "https://hajimi.165201.xyz"; // Bare host without /v1!
        host_relay_req.work_slot_model.model = "claude-opus-5-5";
        const auto hr_inv = prepare_cli_invocation(host_relay_req, mock_harnesses);
        bool saw_norm_v1 = false;
        for (std::size_t i = 0; i + 1 < hr_inv.args.size(); ++i) {
            if (hr_inv.args[i] == "--base-url" && hr_inv.args[i + 1] == "https://hajimi.165201.xyz/v1") saw_norm_v1 = true;
        }
        check(saw_norm_v1 && hr_inv.model_label == "claude-opus-5-5",
              "Host bare baseUrl normalized to /v1 when routing claude-opus-5-5 into CLI SDK");
        fs::remove(hr_inv.temp_query_file, ec);

        host_relay_req.work_slot_model.base_url = "https://api.deepseek.com/v1/chat/completions";
        const auto hr2_inv = prepare_cli_invocation(host_relay_req, mock_harnesses);
        bool saw_stripped_endpoint = false;
        for (std::size_t i = 0; i + 1 < hr2_inv.args.size(); ++i) {
            if (hr2_inv.args[i] == "--base-url" && hr2_inv.args[i + 1] == "https://api.deepseek.com/v1") saw_stripped_endpoint = true;
        }
        check(saw_stripped_endpoint, "Host full /v1/chat/completions URL stripped cleanly to /v1");
        fs::remove(hr2_inv.temp_query_file, ec);

        // Native subscription mode with explicit native model selection (e.g. Kimi Code k3.1p)
        CliHarnessRunRequest nreq = hreq;
        nreq.engine_id = "kimi-code";
        nreq.model_source = "native";
        nreq.native_model = "k3.1p";
        const auto n_inv = prepare_cli_invocation(nreq, mock_harnesses);
        check(std::find(n_inv.args.begin(), n_inv.args.end(), "-S") == n_inv.args.end(),
            "A new Kimi task lets the CLI allocate its own session ID");
        bool saw_native_m = false;
        for (std::size_t i = 0; i + 1 < n_inv.args.size(); ++i) {
            if (n_inv.args[i] == "-m" && n_inv.args[i + 1] == "k3.1p") saw_native_m = true;
        }
        check(saw_native_m && n_inv.model_label.find("k3.1p") != std::string::npos,
              "Native subscription explicit model passed via -m without overriding native credentials");
        bool has_kimi_home_in_native = false;
        for (const auto& [ek, _] : n_inv.env_overrides) {
            if (ek == "KIMI_CODE_HOME") has_kimi_home_in_native = true;
        }
        check(!has_kimi_home_in_native, "Kimi Code native mode uses genuine ~/.kimi-code directly without KIMI_CODE_HOME override");
        check(saw_file_toolset, "Hermes physical toolset restriction enforced on strict constraints");
        check(saw_reasoning, "Hermes reasoning effort flag passed");
        fs::remove(h_inv.temp_query_file, ec);
        fs::remove(n_inv.temp_query_file, ec);

        // Kimi Code isolated config.toml synthesis in Dimension Work API mode
        CliHarnessRunRequest kreq = hreq;
        kreq.engine_id = "kimi-code";
        kreq.bot_id = "bot-beta";
        const auto k_inv = prepare_cli_invocation(kreq, mock_harnesses);
        check(k_inv.engine_id == "kimi-code", "Kimi Code selected");
        check(fs::is_regular_file(k_inv.isolated_home_dir / "config.toml"), "Kimi isolated config.toml synthesized");
        check(k_inv.isolated_home_dir != h_inv.isolated_home_dir, "Per-Bot CLI homes are isolated across group members");
        // Native .exe passes prompts up to 24,000 UTF-16 chars directly (avoids extra Read-file roundtrip),
        // and gracefully spills >24,000 UTF-16 prompts to temp_query_file outside the 32K CreateProcessW limit.
        auto medium_request = kreq;
        medium_request.prompt = std::string(12000, 'x') + "末尾约束：兼容旧项目";
        const auto medium_inv = prepare_cli_invocation(medium_request, mock_harnesses);
        check(medium_inv.args.back().find("末尾约束：兼容旧项目") != std::string::npos && medium_inv.args.back().size() > 12000,
              "Medium 12KB prompt passes directly to Windows .exe without extra Read-file roundtrip");
        fs::remove(medium_inv.temp_query_file, ec);

        auto long_request = kreq;
        long_request.prompt = std::string(26000, 'x') + "末尾约束：兼容旧项目";
        const auto long_inv = prepare_cli_invocation(long_request, mock_harnesses);
        std::ifstream prompt_file(long_inv.temp_query_file, std::ios::binary);
        const std::string saved((std::istreambuf_iterator<char>(prompt_file)), {});
        check(saved.find(long_request.prompt) != std::string::npos && long_inv.args.back().size() < 1024,
              "Oversized (>24K UTF-16) Kimi requests preserve the full original outside the Windows argument limit");
        prompt_file.close();
        fs::remove(long_inv.temp_query_file, ec);
        fs::remove(k_inv.temp_query_file, ec);

        // .cmd batch wrapper strictly keeps the 6000-byte cmd.exe safeguard.
        auto cmd_harnesses = mock_harnesses;
        for (auto& h : cmd_harnesses) {
            if (h.id == "kimi-code") h.binary_path = "C:\\tools\\kimi.cmd";
        }
        auto batch_long_req = kreq;
        batch_long_req.prompt = std::string(7000, 'y') + "批处理末尾";
        const auto batch_long_inv = prepare_cli_invocation(batch_long_req, cmd_harnesses);
        check(batch_long_inv.args.back().size() < 1024,
              "Windows .cmd/.bat wrappers keep the 6000-byte cmd.exe argument safeguard");
        fs::remove(batch_long_inv.temp_query_file, ec);

        // DeepSeek Harness invocation synthesis (both Dimension Work API & Native Account modes, reusing ~/.dsh directly)
        CliHarnessDescriptor dsh_desc;
        dsh_desc.id = "deepseek-harness";
        dsh_desc.name = "DeepSeek Harness";
        dsh_desc.platform = "windows";
        dsh_desc.installed = true;
        dsh_desc.native_configured = true;
        dsh_desc.native_default_model = "deepseek-flash";
        dsh_desc.binary_path = "F:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd";
        auto mock_with_dsh = mock_harnesses;
        mock_with_dsh.push_back(dsh_desc);

        CliHarnessRunRequest dreq = kreq;
        dreq.engine_id = "deepseek-harness";
        dreq.bot_id = "bot-gamma";
        const auto d_api_inv = prepare_cli_invocation(dreq, mock_with_dsh);
        check(d_api_inv.engine_id == "deepseek-harness", "DeepSeek Harness selected");
        check(fs::is_regular_file(d_api_inv.isolated_home_dir / "dimension-run.patch.yml"),
              "DeepSeek Harness dimension-run.patch.yml synthesized");
        bool has_dsh_home_override = false;
        for (const auto& [ek, _] : d_api_inv.env_overrides) {
            if (ek == "DSH_HOME") has_dsh_home_override = true;
        }
        check(!has_dsh_home_override, "DeepSeek Harness reuses genuine ~/.dsh directly without DSH_HOME override");
        check(!d_api_inv.stdin_payload.empty() && d_api_inv.args.back() == "-",
              "DeepSeek Harness passes full task safely via stdin");
        fs::remove(d_api_inv.temp_query_file, ec);

        dreq.model_source = "native";
        dreq.native_model = "deepseek-v4-pro";
        const auto d_nat_inv = prepare_cli_invocation(dreq, mock_with_dsh);
        check(d_nat_inv.model_label == "deepseek-v4-pro · 原生",
              "DeepSeek Harness native model label synthesized");
        fs::remove(d_nat_inv.temp_query_file, ec);

        // Cross-harness MCP bridge injection for Claude Code & Codex when forbid_skills == false
        const fs::path mock_app = test_root / "mock_app";
        fs::create_directories(mock_app / "runtime" / "node", ec);
        std::ofstream(mock_app / "runtime" / "node" / "node.exe") << "stub";
        std::ofstream(mock_app / "runtime" / "cross-harness-mcp.mjs") << "// stub";

        CliHarnessRunRequest cl_req = hreq;
        cl_req.app_root = mock_app;
        cl_req.constraints.forbid_skills = false;
        cl_req.engine_id = "claude-code";
        const auto cl_inv = prepare_cli_invocation(cl_req, mock_with_dsh);
        bool saw_claude_mcp = false;
        for (const auto& a : cl_inv.args) {
            if (a == "--mcp-config") saw_claude_mcp = true;
        }
        check(saw_claude_mcp && fs::is_regular_file(cl_inv.isolated_home_dir / "claude-cross-mcp.json"),
              "Claude Code automatically mounts cross_harness MCP via --mcp-config");
        fs::remove(cl_inv.temp_query_file, ec);

        CliHarnessRunRequest cx_req = cl_req;
        cx_req.engine_id = "codex";
        const auto cx_inv = prepare_cli_invocation(cx_req, mock_with_dsh);
        bool saw_skip_git = false, saw_codex_mcp = false;
        for (const auto& a : cx_inv.args) {
            if (a == "--skip-git-repo-check") saw_skip_git = true;
            if (a.find("mcp_servers.cross_harness.command=") != std::string::npos) saw_codex_mcp = true;
        }
        check(saw_skip_git && saw_codex_mcp,
              "Codex passes --skip-git-repo-check and mounts cross_harness MCP via -c");
        fs::remove(cx_inv.temp_query_file, ec);
    }

    // 3. Stream-JSON normalization & programmatic action rollup classification
    {
        NormalizedCliEvent ev;
        check(parse_cli_json_event("deepseek-harness",
            R"({"type":"session","sessionId":"session-abc-123","cwd":"L:\\ws"})", ev),
            "parse DeepSeek Harness session init");
        check(ev.kind == "init" && ev.session_id == "session-abc-123",
              "DeepSeek Harness sessionId extracted");

        check(parse_cli_json_event("deepseek-harness",
            R"({"type":"tool_call","callId":"call_9","tool":"pwsh","input":{"script":"npm test"}})", ev),
            "parse DeepSeek Harness pwsh tool_call");
        check(ev.kind == "tool_start" && ev.tool_call_id == "call_9" && ev.action_category == "command" &&
              ev.display_verb == "运行命令" && ev.display_target == "npm test",
              "DeepSeek Harness pwsh classified as 运行命令 npm test");

        check(parse_cli_json_event("deepseek-harness",
            R"({"type":"final","text":"任务已完成并通过验收。"})", ev),
            "parse DeepSeek Harness final event");
        check(ev.kind == "result" && ev.text == "任务已完成并通过验收。" && !ev.is_error,
              "DeepSeek Harness final normalized");
        check(parse_cli_json_event("hermes",
            R"({"type":"tool_use","name":"read_file","tool_call_id":"c1","input":{"path":"D:/SampleProject/src/app.cpp"}})", ev),
            "parse hermes tool_use");
        check(ev.kind == "tool_start" && ev.action_category == "read" && ev.display_verb == "阅读" && ev.display_target == "app.cpp",
              "read_file classified as 阅读 app.cpp");

        check(parse_cli_json_event("hermes",
            R"({"type":"tool_use","name":"patch","tool_call_id":"c2","input":{"file_path":"src/app.cpp"}})", ev),
            "parse patch tool_use");
        check(ev.action_category == "edit" && ev.display_verb == "编辑" && ev.display_target == "app.cpp",
              "patch classified as 编辑 app.cpp");

        check(parse_cli_json_event("claude-code",
            R"({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Bash","input":{"command":"cp setup-hermes.sh /tmp","description":"复制 Hermes 安装脚本以检查依赖流程"}}]}})", ev),
            "parse Claude/Kimi assistant tool_use envelope");
        check(ev.action_category == "command" && ev.display_verb == "运行命令" &&
              ev.display_target == "复制 Hermes 安装脚本以检查依赖流程",
              "Bash command description extracted for rollup tree");

        check(parse_cli_json_event("codex",
            R"({"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"挂载隔离实测已通过。"}})", ev),
            "parse Codex agent_message");
        check(ev.kind == "commentary" && ev.text == "挂载隔离实测已通过。", "Codex commentary normalized");

        check(parse_cli_json_event("hermes",
            R"({"type":"result","session_id":"sess-42","exit_code":0,"text":"完成交付","tokens":{"input":1200,"output":450},"duration_ms":3200})", ev),
            "parse Hermes terminal result");
        check(ev.kind == "result" && ev.session_id == "sess-42" && ev.input_tokens == 1200 && !ev.is_error,
              "result fields normalized");

        // 4. Dev server URL extraction & zero-latency fast persona brief synthesis
        check(extract_local_dev_url("  ➜  Local:   http://localhost:5173/ ") == "http://localhost:5173/",
              "Vite localhost:5173 dev URL captured");
        check(extract_local_dev_url("Listening on http://0.0.0.0:3000.") == "http://localhost:3000",
              "0.0.0.0 normalized to localhost:3000");
        check(extract_local_dev_url("Internal API http://127.0.0.1:18788/api/health").empty(),
              "Dimension internal port 18788 ignored");

        const auto fast_cs = extract_preserved_constraints("做一个画板，禁止测试");
        const auto fast_brief = fast_synthesize_persona_brief("中野三玖", "沉静考据，偏爱旧图鉴色彩；平时少说话", "做一个画板，禁止测试", fast_cs);
        check(fast_brief.find("旧图鉴色彩") != std::string::npos && fast_brief.find("少说话") == std::string::npos &&
              fast_brief.find("禁止测试") != std::string::npos,
              "fast_synthesize_persona_brief preserves hard constraints and scrubs speech caps in <0.1ms");
    }

    // 5. Work-only read_only_reception safety guardrails across official Code CLIs
    {
        const fs::path mock_app = test_root / "mock_app_ro";
        fs::create_directories(mock_app / "runtime" / "node", ec);
        std::ofstream(mock_app / "runtime" / "node" / "node.exe") << "stub";
        std::ofstream(mock_app / "runtime" / "cross-harness-mcp.mjs") << "// stub";

        CliHarnessDescriptor dsh_desc;
        dsh_desc.id = "deepseek-harness";
        dsh_desc.name = "DeepSeek Harness";
        dsh_desc.platform = "windows";
        dsh_desc.installed = true;
        dsh_desc.native_configured = true;
        dsh_desc.native_default_model = "deepseek-flash";
        dsh_desc.binary_path = "C:\\mock\\dsh.cmd";

        CliHarnessDescriptor gem_desc;
        gem_desc.id = "gemini-cli";
        gem_desc.name = "Gemini CLI";
        gem_desc.platform = "windows";
        gem_desc.installed = true;
        gem_desc.native_configured = true;
        gem_desc.native_default_model = "gemini-2.5-pro";
        gem_desc.binary_path = "C:\\mock\\gemini.cmd";

        CliHarnessDescriptor agy_desc;
        agy_desc.id = "antigravity";
        agy_desc.name = "Antigravity (agy)";
        agy_desc.platform = "windows";
        agy_desc.installed = true;
        agy_desc.supports_custom_model = false;
        agy_desc.native_configured = true;
        agy_desc.native_default_model = "gemini-3.8-pro-high";
        agy_desc.binary_path = "C:\\mock\\agy.exe";

        std::vector<CliHarnessDescriptor> ro_harnesses{
            {"hermes", "Hermes Agent", "windows", "C:\\mock\\hermes.exe", "0.22.5", true, true, true, true},
            {"kimi-code", "Kimi Code CLI", "windows", "C:\\mock\\kimi.exe", "2.5.2", true, true, true, true},
            {"claude-code", "Claude Code CLI", "windows", "C:\\mock\\claude.exe", "1.0", true, true, true, true},
            {"codex", "Codex CLI", "windows", "C:\\mock\\codex.exe", "0.1", true, true, true, true},
            dsh_desc,
            gem_desc,
            agy_desc
        };

        auto has_arg = [](const std::vector<std::string>& args, std::string_view needle) {
            return std::find(args.begin(), args.end(), needle) != args.end();
        };
        auto has_pair = [](const std::vector<std::string>& args, std::string_view k, std::string_view v) {
            for (std::size_t i = 0; i + 1 < args.size(); ++i) {
                if (args[i] == k && args[i + 1] == v) return true;
            }
            return false;
        };

        CliHarnessRunRequest ro_base;
        ro_base.model_source = "native";
        ro_base.bot_id = "work-lead";
        ro_base.session_key = "work-lead-test";
        ro_base.prompt = "请帮我评估这个需求需要哪些步骤，不要修改任何文件。";
        ro_base.workspace_dir = test_root / "cli-reception-sandbox";
        ro_base.data_root = test_root / "data_ro";
        ro_base.app_root = mock_app;
        ro_base.require_exact_engine = true;
        ro_base.read_only_reception = true;

        // 5a. Hermes read-only reception: oneshot + max-turns 1 + ignore-rules, no --yolo/--checkpoints/-c
        {
            auto req = ro_base;
            req.engine_id = "hermes";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            check(has_arg(inv.args, "--oneshot") && has_pair(inv.args, "--max-turns", "1") &&
                  has_arg(inv.args, "--ignore-rules"),
                  "Hermes read_only_reception enforces --oneshot --max-turns 1 --ignore-rules");
            check(!has_arg(inv.args, "--yolo") && !has_arg(inv.args, "--checkpoints") && !has_arg(inv.args, "-c"),
                  "Hermes read_only_reception omits --yolo, --checkpoints, and persistent -c session");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5b. Claude Code read-only reception: --tools "" + stdin payload, no --dangerously-skip-permissions/--mcp-config
        {
            auto req = ro_base;
            req.engine_id = "claude-code";
            req.prompt = std::string(7000, 'a') + "结尾检查";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            check(has_pair(inv.args, "--tools", ""),
                  "Claude Code read_only_reception disables local tools via --tools \"\"");
            check(!has_arg(inv.args, "--dangerously-skip-permissions") &&
                  !has_arg(inv.args, "--session-id") && !has_arg(inv.args, "--mcp-config"),
                  "Claude Code read_only_reception strips dangerous permission skip, session reuse, and MCP bridge");
            check(inv.stdin_payload.find("结尾检查") != std::string::npos,
                  "Claude Code read_only_reception streams long prompt cleanly over stdin");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5c. Codex read-only reception: --sandbox read-only + '-' stdin, no --full-auto or MCP bridge
        {
            auto req = ro_base;
            req.engine_id = "codex";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            check(has_pair(inv.args, "--sandbox", "read-only") && !inv.args.empty() && inv.args.back() == "-",
                  "Codex read_only_reception enforces --sandbox read-only and stdin '-'");
            check(!has_arg(inv.args, "--full-auto") && !has_arg(inv.args, "--trust"),
                  "Codex read_only_reception strips --full-auto and MCP --trust");
            check(inv.stdin_payload.find("不要修改任何文件") != std::string::npos,
                  "Codex read_only_reception passes prompt through stdin_payload");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5d. DeepSeek Harness read-only reception: DSH_PERMISSION_MODE=read-only + patch defaultPreset
        {
            auto req = ro_base;
            req.engine_id = "deepseek-harness";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            bool saw_ro_env = false;
            for (const auto& [ek, ev] : inv.env_overrides) {
                if (ek == "DSH_PERMISSION_MODE" && ev == "read-only") saw_ro_env = true;
            }
            std::ifstream pin(inv.isolated_home_dir / "dimension-run.patch.yml", std::ios::binary);
            const std::string patch_body((std::istreambuf_iterator<char>(pin)), {});
            check(saw_ro_env && patch_body.find("defaultPreset: read-only") != std::string::npos,
                  "DeepSeek Harness read_only_reception sets read-only env and patch preset");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5e. Kimi Code read-only reception: omit incompatible --plan, no --yolo/--auto/-S, empty skills dir
        {
            auto req = ro_base;
            req.engine_id = "kimi-code";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            check(!has_arg(inv.args, "--plan") && !has_arg(inv.args, "--yolo") && !has_arg(inv.args, "--auto") &&
                      has_arg(inv.args, "--skills-dir") && !has_arg(inv.args, "-S"),
                  "Kimi Code read_only_reception omits --plan/--yolo/--auto/-S and enforces empty skills-dir");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5f. Gemini CLI read-only reception: no --yolo
        {
            auto req = ro_base;
            req.engine_id = "gemini-cli";
            const auto inv = prepare_cli_invocation(req, ro_harnesses);
            check(!has_arg(inv.args, "--yolo"),
                  "Gemini CLI read_only_reception omits --yolo");
            fs::remove(inv.temp_query_file, ec);
        }

        // 5g. Antigravity CLI (`agy`): read-only reception vs full worker execution
        {
            auto req = ro_base;
            req.engine_id = "antigravity";
            req.native_model = "gemini-3.8-flash-high";
            req.work_slot_model.reasoning_effort = "high";
            const auto ro_inv = prepare_cli_invocation(req, ro_harnesses);
            check(has_arg(ro_inv.args, "--print") &&
                      has_pair(ro_inv.args, "--output-format", "stream-json") &&
                      has_pair(ro_inv.args, "--mode", "plan") &&
                      has_arg(ro_inv.args, "--disable-slash-commands") &&
                      !has_arg(ro_inv.args, "--dangerously-skip-permissions") &&
                      has_pair(ro_inv.args, "--model", "gemini-3.8-flash-high") &&
                      has_pair(ro_inv.args, "--effort", "high") &&
                      ro_inv.stdin_payload.find("请帮我评估这个需求需要哪些步骤") != std::string::npos,
                  "Antigravity CLI read_only_reception uses --mode plan --disable-slash-commands and stdin payload");
            fs::remove(ro_inv.temp_query_file, ec);

            req.read_only_reception = false;
            const auto exec_inv = prepare_cli_invocation(req, ro_harnesses);
            check(has_arg(exec_inv.args, "--dangerously-skip-permissions") &&
                      !has_pair(exec_inv.args, "--mode", "plan") &&
                      !exec_inv.session_id_map_file.empty() &&
                      exec_inv.stdin_payload.find("请帮我评估这个需求需要哪些步骤") != std::string::npos,
                  "Antigravity CLI worker mode enables --dangerously-skip-permissions and session map");
            fs::remove(exec_inv.temp_query_file, ec);
        }
    }

    // 6. Native CLI reception prompt serialization & <dimension_tool_call> protocol parser
    {
        ModelTool t_read;
        t_read.name = "read_file";
        t_read.description = "读取工作区文件内容";
        t_read.parameters = Json::Object{
            {"type", "object"},
            {"properties", Json::Object{{"path", Json::Object{{"type", "string"}}}}}
        };

        ModelTool t_list;
        t_list.name = "list_dir";
        t_list.description = "列出目录文件";
        t_list.parameters = Json::Object{{"type", "object"}};

        std::vector<ModelTool> tools{t_read, t_list};

        ModelMessage sys_msg;
        sys_msg.role = "system";
        sys_msg.content = "你是工坊接待主理，请冷静拆解任务。";

        ModelMessage usr_msg;
        usr_msg.role = "user";
        usr_msg.content = "先看看 src 目录和 README.md。";

        ModelMessage asst_msg;
        asst_msg.role = "assistant";
        asst_msg.content = "好的，我先检查。";
        asst_msg.tool_calls.push_back(ToolCall{"c1", "list_dir", R"({"path":"src"})"});

        ModelMessage tool_msg;
        tool_msg.role = "tool";
        tool_msg.tool_call_id = "c1";
        tool_msg.content = "app.cpp\nwork_cli_broker.cpp";

        const std::string prompt = build_cli_reception_prompt({sys_msg, usr_msg, asst_msg, tool_msg}, tools);
        check(prompt.find("纯对话统筹中继") != std::string::npos, "reception prompt contains read-only safety banner");
        check(prompt.find("你是工坊接待主理") != std::string::npos, "reception prompt embeds system role");
        check(prompt.find("- 工具名: read_file") != std::string::npos && prompt.find("- 工具名: list_dir") != std::string::npos,
              "reception prompt enumerates allowed Dimension backend tools");
        check(prompt.find("TOOL RESULT id=c1") != std::string::npos && prompt.find("work_cli_broker.cpp") != std::string::npos,
              "reception prompt preserves tool execution feedback");

        const std::string no_tool_prompt = build_cli_reception_prompt({sys_msg, usr_msg}, {});
        check(no_tool_prompt.find("本轮无工具调用") != std::string::npos,
              "no-tool reception prompt asks for plain response");

        const std::string chat_prompt = build_cli_reception_prompt({sys_msg, usr_msg}, {}, "chat");
        check(chat_prompt.find("只读纯对话模式") != std::string::npos &&
                  chat_prompt.find("系统角色设定与对话指令") != std::string::npos,
              "chat reception prompt uses natural persona dialogue read-only framing");

        // Kimi Code 2.5+ role-based stream-json events must never leak raw JSON into plain fallback
        {
            NormalizedCliEvent ev;
            check(parse_cli_json_event("kimi-code", R"({"role":"meta","type":"system.version","version":"2.5.2"})", ev) &&
                      ev.kind == "init",
                  "Kimi Code 2.5 meta system.version parsed as init");
            check(parse_cli_json_event("kimi-code", R"({"role":"assistant","tool_calls":[{"type":"function","id":"tc1","function":{"name":"Read","arguments":"{\"path\":\"q.txt\"}"}}]})", ev) &&
                      ev.kind == "tool_start" && ev.tool_name == "Read" && ev.tool_call_id == "tc1",
                  "Kimi Code 2.5 assistant tool_calls parsed as tool_start");
            check(parse_cli_json_event("kimi-code", R"({"role":"tool","tool_call_id":"tc1","content":"internal prompt text"})", ev) &&
                      ev.kind == "tool_end" && ev.tool_call_id == "tc1",
                  "Kimi Code 2.5 tool result parsed as tool_end");
            check(parse_cli_json_event("kimi-code", R"({"role":"assistant","content":"哟，线路通了！"})", ev) &&
                      ev.kind == "commentary" && ev.text == "哟，线路通了！",
                  "Kimi Code 2.5 assistant string content parsed cleanly as commentary");
            check(parse_cli_json_event("kimi-code", R"({"role":"meta","type":"session.resume_hint","session_id":"session_abc","content":"hint"})", ev) &&
                      ev.kind == "init" && ev.session_id == "session_abc",
                  "Kimi Code 2.5 session.resume_hint parsed as init with session_id");
        }

        // Antigravity CLI (`agy --output-format stream-json`) NDJSON events
        {
            NormalizedCliEvent ev;
            check(parse_cli_json_event("antigravity", R"({"event":"init","conversation_id":"agy-cid-1","init":{"cwd":"/proj","permission_mode":"always-proceed"}})", ev) &&
                      ev.kind == "init" && ev.session_id == "agy-cid-1",
                  "Antigravity init event parsed with conversation_id");
            check(parse_cli_json_event("antigravity", R"({"event":"step_update","step_update":{"conversation_id":"agy-cid-1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm test"}}}})", ev) &&
                      ev.kind == "tool_start" && ev.tool_name == "run_command" && ev.args_json.find("npm test") != std::string::npos,
                  "Antigravity ACTIVE tool step_update parsed as tool_start");
            check(parse_cli_json_event("antigravity", R"({"event":"step_update","step_update":{"conversation_id":"agy-cid-1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.25,"tool_info":{"name":"run_command","output":"ok"}}})", ev) &&
                      ev.kind == "tool_end" && ev.output == "ok" && ev.duration_ms == 250 && !ev.is_error,
                  "Antigravity DONE tool step_update parsed as tool_end");
            check(parse_cli_json_event("antigravity", R"({"event":"step_update","step_update":{"conversation_id":"agy-cid-1","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"已修复完毕"}})", ev) &&
                      ev.kind == "commentary" && ev.text == "已修复完毕",
                  "Antigravity agent_response text_delta parsed as commentary");
            check(parse_cli_json_event("antigravity", R"({"event":"result","result":{"conversation_id":"agy-cid-1","status":"SUCCESS","response":"最终答复","duration_seconds":1.5,"usage":{"input_tokens":120,"output_tokens":45}}})", ev) &&
                      ev.kind == "result" && !ev.is_error && ev.text == "最终答复" && ev.input_tokens == 120 && ev.output_tokens == 45 && ev.duration_ms == 1500,
                  "Antigravity result SUCCESS parsed cleanly with usage");
            check(parse_cli_json_event("antigravity", R"({"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication required"}})", ev) &&
                      ev.kind == "result" && ev.is_error && ev.text == "authentication required",
                  "Antigravity result ERROR surfaced cleanly");
        }

        // Plain reply with no allowed tools
        const auto plain_reply = parse_cli_reception_reply("  收到，已经整理完毕。  ", {});
        check(plain_reply.text == "收到，已经整理完毕。" && plain_reply.tool_calls.empty(),
              "parse_cli_reception_reply trims plain response when no tools allowed");

        // Multi-tool reply with ```json fence, stringified arguments, and unauthorized hallucinated tool filtered out
        const std::string raw_reply =
            "我先读取 README 并列一下目录。\n"
            "<dimension_tool_call>\n"
            "```json\n"
            "{\"name\": \"read_file\", \"arguments\": {\"path\": \"README.md\"}}\n"
            "```\n"
            "</dimension_tool_call>\n"
            "<dimension_tool_call>\n"
            "{\"name\": \"evil_shell_exec\", \"arguments\": {\"cmd\": \"rm -rf /\"}}"
            "</dimension_tool_call>\n"
            "<dimension_tool_call>\n"
            "{\"name\": \"list_dir\", \"arguments\": \"{\\\"path\\\":\\\"src\\\"}\"}\n"
            "</dimension_tool_call>\n"
            "读取完我再继续汇报。";

        const auto parsed = parse_cli_reception_reply(raw_reply, tools);
        check(parsed.tool_calls.size() == 2, "exactly 2 whitelisted tool calls extracted (hallucinated tool blocked)");
        check(parsed.tool_calls[0].name == "read_file" &&
              parsed.tool_calls[0].arguments.find("README.md") != std::string::npos,
              "first tool call parsed cleanly from fenced json block");
        check(parsed.tool_calls[1].name == "list_dir" &&
              parsed.tool_calls[1].arguments.find("src") != std::string::npos,
              "second tool call parsed cleanly from JSON-encoded arguments string");
        check(parsed.text.find("我先读取 README") != std::string::npos &&
              parsed.text.find("读取完我再继续汇报") != std::string::npos &&
              parsed.text.find("<dimension_tool_call>") == std::string::npos &&
              parsed.text.find("evil_shell_exec") == std::string::npos,
              "clean human text preserved without leaking XML or blocked tool payload");
    }

    // 7. Bubblewrap (bwrap) sandbox path mapping, mount isolation & strict require_sandbox enforcement
    {
        check(windows_path_to_wsl_path(fs::path(L"D:\\SampleProject\\demo"), "dimension-sandbox") ==
              "/mnt/d/SampleProject/demo",
              "Windows drive path maps cleanly to /mnt/<drive>/...");
        check(windows_path_to_wsl_path(fs::path(L"\\\\wsl.localhost\\dimension-sandbox\\home\\dimension\\proj"), "dimension-sandbox") ==
              "/home/dimension/proj",
              "WSL localhost UNC path strips distro prefix cleanly");
        check(windows_path_to_wsl_path(fs::path(L"\\\\wsl$\\dimension-sandbox\\workspace"), "dimension-sandbox") ==
              "/workspace",
              "Legacy wsl$ UNC path maps cleanly");
        check(windows_path_to_wsl_path(fs::path("/workspace/app"), "dimension-sandbox") ==
              "/workspace/app",
              "POSIX path passes through untouched");

        auto has_arg = [](const std::vector<std::string>& args, std::string_view needle) {
            return std::find(args.begin(), args.end(), needle) != args.end();
        };
        auto has_triple = [](const std::vector<std::string>& args, std::string_view a, std::string_view b, std::string_view c) {
            for (std::size_t i = 0; i + 2 < args.size(); ++i) {
                if (args[i] == a && args[i + 1] == b && args[i + 2] == c) return true;
            }
            return false;
        };

        CliHarnessDescriptor sb_codex;
        sb_codex.id = "codex";
        sb_codex.name = "Codex";
        sb_codex.platform = "wsl";
        sb_codex.binary_path = "/opt/dimension-tools/bin/codex";
        sb_codex.installed = true;
        sb_codex.sandbox_installed = true;
        sb_codex.sandbox_binary_path = "/opt/dimension-tools/bin/codex";
        sb_codex.execution_mode = "sandbox";

        CliHarnessDescriptor host_only_hermes;
        host_only_hermes.id = "hermes";
        host_only_hermes.name = "Hermes";
        host_only_hermes.platform = "windows";
        host_only_hermes.binary_path = "C:\\mock\\hermes.exe";
        host_only_hermes.installed = true;
        host_only_hermes.host_installed = true;
        host_only_hermes.sandbox_installed = false;
        host_only_hermes.execution_mode = "host";

        std::vector<CliHarnessDescriptor> mixed{sb_codex, host_only_hermes};

        // 7a. Work API mode inside bwrap: isolated empty home, rw /workspace, --ro-bind /opt/dimension-tools
        {
            CliHarnessRunRequest sreq;
            sreq.engine_id = "codex";
            sreq.model_source = "work";
            sreq.bot_id = "bot-sb";
            sreq.session_key = "sb-sess-1";
            sreq.prompt = "生成一个 hello.txt";
            sreq.work_slot_model.base_url = "https://api.openai.com/v1";
            sreq.work_slot_model.api_key = "sk-test-sandbox";
            sreq.work_slot_model.model = "gpt-5";
            sreq.workspace_dir = test_root / "sb_ws";
            sreq.data_root = test_root / "sb_data";
            sreq.sandbox_distribution = "dimension-sandbox";
            sreq.require_sandbox = true;

            const auto inv = prepare_cli_invocation(sreq, mixed);
            check(inv.use_bwrap_sandbox && inv.platform == "wsl", "sandbox CLI activates bwrap sandbox carrier");
            check(has_arg(inv.bwrap_args, "--unshare-all") && has_arg(inv.bwrap_args, "--share-net") &&
                  has_arg(inv.bwrap_args, "--clearenv"),
                  "bwrap enforces full namespace unshare, net share, and clean env");
            check(has_triple(inv.bwrap_args, "--ro-bind", "/opt/dimension-tools", "/opt/dimension-tools"),
                  "bwrap mounts /opt/dimension-tools strictly read-only");
            check(has_triple(inv.bwrap_args, "--bind", inv.linux_workspace_path, "/workspace"),
                  "bwrap binds ONLY the active workspace into /workspace");
            check(inv.linux_home_path.empty() &&
                  has_triple(inv.bwrap_args, "--symlink", "/tmp/dim-home", "/home/dimension"),
                  "Work API mode uses ephemeral tmpfs home without touching native credential store");
            check(has_triple(inv.bwrap_args, "--setenv", "OPENAI_API_KEY", "sk-test-sandbox"),
                  "bwrap injects Work API key solely inside clean sandbox env");
            fs::remove(inv.temp_query_file, ec);
        }

        // 7b. Native read-only reception mode inside bwrap: --ro-bind /workspace & isolated per-engine home
        {
            CliHarnessRunRequest sreq;
            sreq.engine_id = "codex";
            sreq.model_source = "native";
            sreq.bot_id = "work-lead";
            sreq.prompt = "只读分析方案";
            sreq.workspace_dir = test_root / "sb_ro_ws";
            sreq.data_root = test_root / "sb_data";
            sreq.sandbox_distribution = "dimension-sandbox";
            sreq.read_only_reception = true;
            sreq.require_sandbox = true;

            const auto inv = prepare_cli_invocation(sreq, mixed);
            check(inv.use_bwrap_sandbox && inv.linux_home_path == "/var/lib/dimension-cli-homes/codex",
                  "native sandbox mode mounts per-engine isolated credential home");
            check(has_triple(inv.bwrap_args, "--ro-bind", inv.linux_workspace_path, "/workspace"),
                  "read_only_reception inside bwrap upgrades /workspace mount to kernel-enforced --ro-bind");
            check(has_triple(inv.bwrap_args, "--bind", "/var/lib/dimension-cli-homes/codex", "/home/dimension"),
                  "bwrap binds only this engine's isolated home into /home/dimension");
            fs::remove(inv.temp_query_file, ec);
        }

        // 7c. require_sandbox refuses falling back to host-only engine
        {
            CliHarnessRunRequest sreq;
            sreq.engine_id = "hermes";
            sreq.require_exact_engine = true;
            sreq.require_sandbox = true;
            sreq.workspace_dir = test_root / "sb_ws";
            sreq.data_root = test_root / "sb_data";
            bool threw = false;
            try {
                (void)prepare_cli_invocation(sreq, mixed);
            } catch (const std::exception&) {
                threw = true;
            }
            check(threw, "require_sandbox strictly rejects host-only engine without silent host fallback");
        }
    }

    // 8. P0 + P2 + P3 reception streaming filter, stable fingerprint & delta prompt tests
    {
        // 8a. ReceptionTextStreamFilter handles split tag boundaries, normal '<', and multi-tool blocks cleanly
        ReceptionTextStreamFilter filter;
        std::string emitted;
        auto sink = [&](std::string_view p) { emitted.append(p); };
        const std::vector<std::string> chunks = {
            "你好呀，a < b 是对的！<di",
            "mension_tool_",
            "call>\n{\"name\":\"chat_web_lookup\",\"arguments\":{\"query\":\"test\"}}\n</dimen",
            "sion_tool_call>马上帮你查好了",
            "<br>继续聊天<dimension_tool_call>{\"name\":\"t2\",\"arguments\":{}}</dimension_tool_call>完成！"
        };
        for (const auto& c : chunks) filter.feed(c, sink);
        filter.flush(sink);
        check(emitted == "你好呀，a < b 是对的！马上帮你查好了<br>继续聊天完成！",
              "ReceptionTextStreamFilter streams prose live across split chunks while silently stripping tool blocks");
        check(filter.emitted_any(), "ReceptionTextStreamFilter tracks emitted_any state accurately");

        // Unclosed tool tag at EOF must not leak raw JSON to frontend
        filter.reset();
        emitted.clear();
        filter.feed("安全前缀<dimension_tool_call>{\"name\":\"secret\"", sink);
        filter.flush(sink);
        check(emitted == "安全前缀", "ReceptionTextStreamFilter suppresses incomplete tool tag tail on flush");

        // 8b. System fingerprint remains invariant across volatile time anchor / input char count / secondary memory updates
        ModelConfig cfg;
        cfg.protocol = "cli-reception";
        cfg.cli_engine_id = "kimi-code";
        cfg.cli_native_model = "k3.1p";
        cfg.context_feature = "chat";
        cfg.thinking_enabled = false;
        cfg.reasoning_effort = "low";

        std::vector<ModelTool> tools;
        ModelTool wt;
        wt.name = "chat_web_lookup";
        wt.description = "web search";
        wt.parameters = Json::Object{{"type", "object"}};
        tools.push_back(wt);

        std::vector<ModelMessage> m1{
            {"system", "你是 Grok。正在与用户在即时通讯软件上私聊（当前本地时间：周三上午 11:01）。\n普通随口闲聊（当前对方输入约 5 字）简短回应。", {}, {}},
            {"system", "回忆片段A", {}, {}},
            {"user", "嗨", {}, {}}
        };
        std::vector<ModelMessage> m2{
            {"system", "你是 Grok。正在与用户在即时通讯软件上私聊（当前本地时间：周三上午 11:08）。\n普通随口闲聊（当前对方输入约 42 字）简短回应。", {}, {}},
            {"system", "回忆片段B（已变化）", {}, {}},
            {"user", "嗨", {}, {}},
            {"assistant", "在呢", {}, {}},
            {"user", "第二轮聊聊今天天气怎么样", {}, {}}
        };
        const auto fp1 = compute_cli_reception_system_fingerprint(cfg, m1, tools);
        const auto fp2 = compute_cli_reception_system_fingerprint(cfg, m2, tools);
        check(fp1 == fp2, "Reception system fingerprint stays stable across volatile time/len/memory changes for KV cache hits");

        ModelConfig cfg_think = cfg;
        cfg_think.thinking_enabled = true;
        const auto fp_think = compute_cli_reception_system_fingerprint(cfg_think, m1, tools);
        check(fp_think != fp1, "Toggling thinking_enabled invalidates reception fingerprint cleanly");

        const auto fp_notools = compute_cli_reception_system_fingerprint(cfg, m1, {});
        check(fp_notools != fp1, "Changing allowed tools invalidates reception fingerprint cleanly");

        // 8c. Incremental delta prompt includes only non-system delta messages
        const std::string delta = build_cli_reception_delta_prompt({
            {"system", "ignored", {}, {}},
            {"user", "第二轮只发这一句", {}, {}}
        });
        check(delta.find("第二轮只发这一句") != std::string::npos && delta.find("ignored") == std::string::npos,
              "build_cli_reception_delta_prompt emits only incremental non-system turns");

        // 8d. parse_cli_reception_reply tolerates nested <tool_name>/<arguments> XML syntax too
        {
            std::vector<ModelTool> work_tools;
            work_tools.push_back(ModelTool{"dispatch_native_cli", "dispatch", Json::Object{{"type", "object"}}});
            const std::string xml_reply =
                "马上派单！\n<dimension_tool_call>\n<tool_name>dispatch_native_cli</tool_name>\n"
                "<arguments>\n{\"task\": \"create hello.txt\"}\n</arguments>\n</dimension_tool_call>";
            const auto parsed = parse_cli_reception_reply(xml_reply, work_tools);
            check(parsed.tool_calls.size() == 1U && parsed.tool_calls[0].name == "dispatch_native_cli" &&
                  parsed.tool_calls[0].arguments.find("create hello.txt") != std::string::npos &&
                  parsed.text == "马上派单！",
                  "parse_cli_reception_reply parses nested <tool_name>/<arguments> XML fallback cleanly");

            const std::string flat_reply =
                "收到，开工。\n<dimension_tool_call>\n"
                "{\"tool\": \"dispatch_native_cli\", \"cli\": \"kimi-code\", \"instruction\": \"write hello_fast.txt\"}\n"
                "</dimension_tool_call>";
            const auto parsed_flat = parse_cli_reception_reply(flat_reply, work_tools);
            check(parsed_flat.tool_calls.size() == 1U && parsed_flat.tool_calls[0].name == "dispatch_native_cli" &&
                  parsed_flat.tool_calls[0].arguments.find("\"task\":\"write hello_fast.txt\"") != std::string::npos &&
                  parsed_flat.tool_calls[0].arguments.find("\"engine\":\"kimi-code\"") != std::string::npos &&
                  parsed_flat.text == "收到，开工。",
                  "parse_cli_reception_reply normalizes flattened tool/instruction/cli envelopes cleanly");
        }

        // 8e. Shutdown of idle pool is safe & idempotent
        shutdown_cli_reception_pool();
        shutdown_cli_reception_pool();
    }

    fs::remove_all(test_root, ec);
    std::cout << "work_cli_broker: " << g_checks << " checks passed\n";
    return 0;
}
