#include "dimension/bot_capabilities.hpp"
#include "dimension/cli_stream_driver.hpp"
#include "dimension/runs.hpp"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

int checks = 0;
void check(bool cond, const char* msg) {
    if (!cond) throw std::runtime_error(msg);
    ++checks;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const fs::path root = argc > 1 ? fs::absolute(argv[1]) : fs::temp_directory_path() / L"dimension-studio-046-test";
        std::error_code ec;
        fs::remove_all(root, ec);
        fs::create_directories(root);

        // 1. BotCapabilityService capability cards + directed collaboration ledger + dispatch prompt
        BotCapabilityService caps(root / L"bot-capabilities.json");
        const auto saved = caps.save_card("bot-blender", O{
            {"roleTag", "3D建模与渲染师"},
            {"specialties", A{"Blender脚本建模", "材质渲染"}},
            {"equippedTools", A{"blender-headless", "doubao"}},
            {"handoffContract", "输出 .glb 与预览 .png 至 assets/"}
        });
        check(saved.at("roleTag").as_string() == "3D建模与渲染师", "Saved capability card");
        caps.record_collaboration({"bot-lead", "bot-blender", "grp-1", "run-c1", "completed", "生成展厅白模", {"hall.glb", "preview.png"}});
        caps.add_collaboration_note("bot-lead", "bot-blender", "脚本参数清楚时一次出图率高");

        // Asymmetric check: bot-blender -> bot-lead has no ledger entry
        const std::string brief_lead = caps.group_dispatch_prompt("bot-lead", {"bot-lead", "bot-blender"});
        check(brief_lead.find("3D建模与渲染师") != std::string::npos &&
              brief_lead.find("blender-headless") != std::string::npos &&
              brief_lead.find("1成/0败") != std::string::npos &&
              brief_lead.find("一次出图率高") != std::string::npos,
              "Dispatch prompt injects capability card, ledger stats, and directed note");

        // 2. CliStreamDriver real-time line streaming on Windows
        std::atomic<int> progress_callbacks{0};
        CliStreamRequest stream_req;
        stream_req.profile_id = "win-stream-test";
        stream_req.binary = "C:\\Windows\\System32\\cmd.exe";
        stream_req.platform = "windows";
        stream_req.base_args = {"/d", "/c"};
        stream_req.task_args = {"echo LINE_ONE & echo LINE_TWO"};
        stream_req.workspace_path = root;
        stream_req.timeout_seconds = 15;
        const auto stream_res = execute_cli_stream(stream_req, [&](std::size_t lines, const std::string&, std::int64_t) {
            if (lines >= 1) ++progress_callbacks;
        });
        check(stream_res.at("ok").as_bool() &&
              stream_res.at("stdout").as_string().find("LINE_ONE") != std::string::npos &&
              progress_callbacks.load() >= 1,
              "execute_cli_stream streams live progress callbacks and captures output");

        // 3. RunService parallel read-only tool batch execution + lazy cold terminal hydration
        std::atomic<int> concurrent_now{0};
        std::atomic<int> max_concurrent{0};
        int model_turn = 0;

        RunCallbacks cb;
        cb.is_read_only_tool = [](std::string_view name) { return name == "fast_read"; };
        cb.tools = [](const RunExecutionContext&) {
            return std::vector<ModelTool>{
                {"fast_read", "Read-only parallel probe", O{{"type", "object"}, {"properties", O{{"k", O{{"type", "string"}}}}}}}
            };
        };
        cb.model = [&](const ModelConfig&, const std::vector<ModelMessage>&, const std::vector<ModelTool>&, ModelChunk, std::stop_token) {
            ModelReply r;
            ++model_turn;
            if (model_turn == 1) {
                r.tool_calls = {
                    {"call-1", "fast_read", R"({"k":"a"})"},
                    {"call-2", "fast_read", R"({"k":"b"})"},
                    {"call-3", "fast_read", R"({"k":"c"})"}
                };
            } else {
                r.text = "All parallel reads done";
            }
            return r;
        };
        cb.execute_tool = [&](const ToolCall& c, const RunExecutionContext&, std::stop_token) {
            const int cur = ++concurrent_now;
            int prev = max_concurrent.load();
            while (cur > prev && !max_concurrent.compare_exchange_weak(prev, cur)) {}
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
            --concurrent_now;
            return ToolExecution{"ok:" + c.arguments, false};
        };

        RunOptions ropts;
        ropts.require_verified_finish = false;
        ropts.enable_parallel_readonly_tools = true;
        ropts.lazy_terminal_hydration = true;

        std::string finished_run_id;
        {
            RunService svc(root / L"runs-store", cb, ropts);
            const auto sub = svc.submit("bot-p", "", "test parallel", "req-p1", false);
            finished_run_id = sub.run_id;
            for (int i = 0; i < 100; ++i) {
                const auto b = svc.brief_json(finished_run_id);
                if (b.at("terminal").as_bool()) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
            }
            const auto full1 = svc.get(finished_run_id);
            check(full1.at("status").as_string() == "completed", "Parallel read-only run completed");
            check(max_concurrent.load() >= 2, "Multiple read-only tools executed concurrently in the same turn");
            const auto& tools_arr = full1.at("tools").as_array();
            check(tools_arr.size() == 3 &&
                  tools_arr[0].at("call").at("id").as_string() == "call-1" &&
                  tools_arr[1].at("call").at("id").as_string() == "call-2" &&
                  tools_arr[2].at("call").at("id").as_string() == "call-3",
                  "Parallel tool results committed in deterministic call order");
        }

        // Re-open store with lazy_terminal_hydration = true: brief works immediately without hydrating messages,
        // and get(id) hydrates full transcript seamlessly on demand!
        {
            RunService svc2(root / L"runs-store", cb, ropts);
            const auto b2 = svc2.brief_json(finished_run_id);
            check(b2.at("status").as_string() == "completed" && b2.at("text").as_string() == "test parallel",
                  "Cold lazy-loaded terminal run serves brief metadata immediately");
            const auto full2 = svc2.get(finished_run_id);
            check(full2.at("tools").as_array().size() == 3 && full2.at("messages").as_array().size() >= 4,
                  "On-demand hydration restores full messages and receipts seamlessly");
        }

        fs::remove_all(root, ec);
        std::cout << "studio_backend: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "studio_backend_test FAILED: " << e.what() << '\n';
        return 1;
    }
}
