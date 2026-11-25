#include "dimension/cli_context_bus.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;
using namespace dimension;

namespace {

int g_checks = 0;

void check(bool cond, const char* msg) {
    ++g_checks;
    if (!cond) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
}

std::string read_text(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    std::ostringstream oss;
    oss << in.rdbuf();
    return oss.str();
}

} // namespace

int main(int argc, char** argv) {
    fs::path root = argc > 1 ? fs::path(argv[1]) : (fs::temp_directory_path() / "dimension_cli_context_bus_test");
    std::error_code ec;
    fs::remove_all(root, ec);
    const fs::path data_root = root / "data";
    const fs::path ws_dir = root / "workspace";
    fs::create_directories(data_root, ec);
    fs::create_directories(ws_dir, ec);

    // 1. Compact line diff computes added/removed counts and unified excerpt accurately
    {
        int added = 0, removed = 0;
        const std::string diff = build_compact_line_diff(
            "line1\nold_a\nold_b\nline4\n",
            "line1\nnew_a\nnew_b\nnew_c\nline4\n",
            added, removed, 900U);
        check(added == 3 && removed == 2, "build_compact_line_diff counts exact added/removed lines");
        check(diff.find("- old_a") != std::string::npos && diff.find("+ new_c") != std::string::npos,
              "build_compact_line_diff renders removed and added hunks");

        int new_add = 0, new_rem = 0;
        const std::string created_diff = build_compact_line_diff("", "alpha\nbeta\n", new_add, new_rem, 900U);
        check(new_add == 2 && new_rem == 0 && created_diff.find("+ alpha") != std::string::npos,
              "build_compact_line_diff handles newly created files cleanly");
    }

    // 2. First turn has empty ledger -> no handoff injected
    {
        CliHandoffPrepareRequest preq;
        preq.data_root = data_root;
        preq.workspace_dir = ws_dir;
        preq.ledger_id = "run-cross-001";
        preq.bot_id = "ai-gemini";
        preq.target_engine_id = "kimi-code";
        preq.target_engine_name = "Kimi Code";
        preq.target_model_label = "k3.1p";
        const auto prep = prepare_cli_context_handoff(preq);
        check(!prep.injected, "Empty ledger injects nothing on the first turn");
    }

    // 3. Record Turn 1 from Kimi Code (file creation + modification + command receipt + hard constraint)
    {
        CliHandoffRecordRequest rreq;
        rreq.data_root = data_root;
        rreq.workspace_dir = ws_dir;
        rreq.ledger_id = "run-cross-001";
        rreq.bot_id = "ai-gemini";
        rreq.bot_name = "Gemini";
        rreq.task_prompt = "实现用户登录模块并跑编译检查，不要改公共 API";
        rreq.constraints.hard_constraints = {"不要改公共 API", "禁止引入第三方依赖"};

        rreq.run_result.success = true;
        rreq.run_result.resolved_engine_id = "kimi-code";
        rreq.run_result.resolved_engine_name = "Kimi Code";
        rreq.run_result.resolved_model_label = "k3.1p";
        rreq.run_result.native_session_id = "session_kimi_1";
        rreq.run_result.final_response = "已完成 auth.cpp 初版，cmake 构建出现 1 个链接未定义符号错误待修。";
        rreq.run_result.duration_ms = 12300;

        WorkspaceFileDelta d1;
        d1.absolute_path = ws_dir / "src" / "auth.cpp";
        d1.relative_path = "src/auth.cpp";
        d1.created = true;
        d1.bytes = 128;
        d1.after_content = "#include \"auth.hpp\"\nbool verify_token() { return true; }\n";
        rreq.run_result.file_deltas.push_back(d1);

        WorkspaceFileDelta d2;
        d2.absolute_path = ws_dir / ".dimension" / "handoffs" / "run-cross-001.md";
        d2.relative_path = ".dimension/handoff.md";
        d2.created = true;
        d2.bytes = 50;
        rreq.run_result.file_deltas.push_back(d2); // Must be filtered out!

        rreq.commands.push_back(CliCommandReceipt{
            "cmake --build build --target app",
            true,
            "unresolved external symbol verify_sig"
        });

        record_cli_context_outcome(rreq);

        const auto loaded = load_cli_handoff_ledger(data_root, "run-cross-001");
        check(loaded.turns.size() == 1U, "Turn 1 persisted into canonical JSON ledger");
        check(loaded.files.size() == 1U && loaded.files.contains("src/auth.cpp") &&
              !loaded.files.contains(".dimension/handoff.md"),
              "File ledger keeps workspace code files and ignores internal .dimension/* files");
        check(loaded.hard_constraints.size() == 2U, "Hard constraints persisted without loss");
        check(fs::is_regular_file(ws_dir / ".dimension" / "handoffs" / "run-cross-001.md", ec),
              "Workspace .dimension/handoff.md detailed handoff file generated");
        const std::string md = read_text(ws_dir / ".dimension" / "handoffs" / "run-cross-001.md");
        check(md.find("src/auth.cpp") != std::string::npos && md.find("unresolved external symbol") != std::string::npos,
              "Detailed handoff markdown contains file changes and command failure excerpt");
    }

    // 4. Same bot + same engine + same model + existing native session => zero redundant injection
    {
        CliHandoffPrepareRequest preq;
        preq.data_root = data_root;
        preq.workspace_dir = ws_dir;
        preq.ledger_id = "run-cross-001";
        preq.bot_id = "ai-gemini";
        preq.target_engine_id = "kimi-code";
        preq.target_engine_name = "Kimi Code";
        preq.target_model_label = "k3.1p";
        preq.target_has_existing_session = true;
        const auto prep = prepare_cli_context_handoff(preq);
        check(!prep.injected && !prep.cross_engine && !prep.cross_member,
              "Same bot + same CLI engine + live native session skips redundant handoff injection");
    }

    // 5. Cross-engine switch (Kimi Code -> Antigravity agy) => injects structured handoff card!
    {
        CliHandoffPrepareRequest preq;
        preq.data_root = data_root;
        preq.workspace_dir = ws_dir;
        preq.ledger_id = "run-cross-001";
        preq.bot_id = "ai-gemini";
        preq.target_engine_id = "antigravity";
        preq.target_engine_name = "Antigravity CLI (agy)";
        preq.target_model_label = "gemini-3.1-pro";
        preq.target_has_existing_session = false;
        const auto prep = prepare_cli_context_handoff(preq);
        check(prep.injected && prep.cross_engine && !prep.cross_member,
              "Switching from Kimi Code to Antigravity triggers cross-engine handoff");
        check(prep.previous_engine_id == "kimi-code" && prep.handed_off_files == 1U && prep.handed_off_turns == 1U,
              "Prepared handoff reports accurate previous engine and file/turn counts");
        check(prep.prompt_prefix.find("不要改公共 API") != std::string::npos &&
              prep.prompt_prefix.find("src/auth.cpp") != std::string::npos &&
              prep.prompt_prefix.find("unresolved external symbol") != std::string::npos &&
              prep.prompt_prefix.find(".dimension/handoffs/run-cross-001.md") != std::string::npos,
              "Cross-engine handoff card carries hard constraints, file diff, command failure, and detail pointer");
        check(prep.prompt_prefix.size() <= 3500U, "Inline cross-engine handoff card respects compact byte budget");
    }

    // 6. Group work cross-member handoff (same engine kimi-code, different member bot_id) => injects handoff card!
    {
        CliHandoffPrepareRequest preq;
        preq.data_root = data_root;
        preq.workspace_dir = ws_dir;
        preq.ledger_id = "run-cross-001";
        preq.bot_id = "ai-claude";
        preq.target_engine_id = "kimi-code";
        preq.target_engine_name = "Kimi Code";
        preq.target_model_label = "k3.1p";
        preq.target_has_existing_session = true;
        const auto prep = prepare_cli_context_handoff(preq);
        check(prep.injected && !prep.cross_engine && prep.cross_member,
              "Group member relay triggers cross-member handoff even when using the same CLI engine");
        check(prep.prompt_prefix.find("Gemini") != std::string::npos,
              "Cross-member handoff identifies the previous group member cleanly");
    }

    {
        NormalizedCliEvent start, end;
        parse_cli_json_event("claude-code", R"({"type":"assistant","message":{"content":[{"type":"tool_use","id":"test","name":"Bash","input":{"command":"fixture-check"}}]}})", start);
        parse_cli_json_event("claude-code", R"({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"test","is_error":true,"content":"failed fixture"}]}})", end);
        CliCommandTracker tracker;
        tracker.observe(start);
        auto unresolved = start;
        unresolved.tool_call_id = "unfinished";
        tracker.observe(unresolved);
        tracker.observe(end);
        CliHandoffRecordRequest req;
        req.workspace_dir = ws_dir;
        req.data_root = data_root;
        req.ledger_id = "cancelled-work";
        req.run_result.cancelled = true;
        req.run_result.resolved_engine_id = "codex";
        req.commands = tracker.take();
        WorkspaceFileDelta delta;
        delta.relative_path = "partial.txt";
        delta.after_content = "partial";
        req.run_result.file_deltas.push_back(delta);
        record_cli_context_outcome(req);
        auto ledger = load_cli_handoff_ledger(data_root, req.ledger_id);
        check(ledger.turns.size() == 1 && ledger.turns.front().cancelled && ledger.files.contains("partial.txt"),
              "cancelled work retains observed modifications");
        const auto& receipts = ledger.turns.front().commands;
        check(receipts.size() == 2 && receipts[0].result_known && receipts[0].failed &&
              !receipts[1].result_known, "failed and unfinished commands remain distinct after persistence");
        const auto prior = read_text(ws_dir / ".dimension/handoffs/run-cross-001.md");
        check(prior.find("partial.txt") == prior.npos && prior.find("src/auth.cpp") != prior.npos,
              "writing another ledger cannot overwrite this task's handoff");
        const auto current = read_text(ws_dir / ".dimension/handoffs/cancelled-work.md");
        check(current.find("UNKNOWN") != current.npos && current.find("FAIL") != current.npos,
              "handoff reports unknown and failed outcomes");
        int added, removed;
        const auto diff = build_compact_line_diff("a\nkeep\nz", "A\nkeep\nZ", added, removed);
        check(added == 2 && removed == 2 && diff.find("- keep") == diff.npos,
              "separated modifications do not count unchanged lines");
    }

    // 7. Front-desk reception history budget tightens when archived summary is present
    {
        const auto chat_with_sum = recommended_reception_history_budget("kimi-code", "chat", true);
        const auto chat_no_sum = recommended_reception_history_budget("kimi-code", "chat", false);
        const auto work_kimi = recommended_reception_history_budget("kimi-code", "work", false);
        const auto work_qwen = recommended_reception_history_budget("qwen-code", "work", false);
        check(chat_with_sum < chat_no_sum && chat_with_sum <= 40U * 1024U,
              "Chat reception switches tighten raw turn replay when archived summary is present");
        check(work_qwen < work_kimi && work_kimi == 140U * 1024U,
              "Work reception budget scales cleanly across CLI engine context tiers");
    }

    fs::remove_all(root, ec);
    std::cout << "cli_context_bus: " << g_checks << " checks passed\n";
    return 0;
}
