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
        auto long_request = kreq;
        long_request.prompt = std::string(12000, 'x') + "末尾约束：兼容旧项目";
        const auto long_inv = prepare_cli_invocation(long_request, mock_harnesses);
        std::ifstream prompt_file(long_inv.temp_query_file, std::ios::binary);
        const std::string saved((std::istreambuf_iterator<char>(prompt_file)), {});
        check(saved.find(long_request.prompt) != std::string::npos && long_inv.args.back().size() < 1024,
              "Long Kimi requests preserve the full original outside the Windows argument limit");
        prompt_file.close();
        fs::remove(long_inv.temp_query_file, ec);
        fs::remove(k_inv.temp_query_file, ec);

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
            R"({"type":"tool_use","name":"read_file","tool_call_id":"c1","input":{"path":"C:/Projects/Sample/src/app.cpp"}})", ev),
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

    fs::remove_all(test_root, ec);
    std::cout << "work_cli_broker: " << g_checks << " checks passed\n";
    return 0;
}
