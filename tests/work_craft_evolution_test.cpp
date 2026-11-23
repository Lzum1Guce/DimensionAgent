#include "dimension/work_craft_evolution.hpp"

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
    if (!cond) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
    ++g_checks;
}

std::string read_all(const fs::path& p) {
    std::ifstream ifs(p, std::ios::binary);
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

} // namespace

int main(int argc, char** argv) {
    const fs::path root = argc > 1
        ? fs::path(argv[1])
        : (fs::temp_directory_path() / "dimension_work_craft_evolution_test");
    std::error_code ec;
    fs::remove_all(root, ec);
    fs::create_directories(root, ec);

    CraftEvolutionEngine engine(root);
    const std::int64_t t0 = 1795088000000LL;

    // 1. Bot A encounters a Windows MSVC header dependency pitfall, overcomes it,
    //    and distills a "举一反十" client inspection playbook via Chat-slot LLM abstraction.
    {
        WorkRunTraceSample sample;
        sample.run_id = "run-claude-inspect-1";
        sample.bot_id = "bot-architect";
        sample.bot_name = "主程";
        sample.platform_hint = "windows";
        sample.user_inputs = {
            "帮我看看 Craft 客户端怎么跑",
            "不是 craft 啊，是看本机 Claude 客户端怎么运行，只读排查不要动原配置"
        };
        sample.failed_tool_summaries = {
            "PowerShell Get-Content C:\\Program Files\\Claude\\config.json -> PathNotFound (actual config lives under %APPDATA%\\Claude)"
        };
        sample.succeeded_tool_summaries = {
            "Read %APPDATA%\\Claude\\claude_desktop_config.json and inspected local Claude Code CLI flags"
        };
        sample.final_response = "已只读查清本机 Claude 桌面端与 Claude Code CLI 的拉起链路、配置目录与日志位置。";
        sample.completed_successfully = true;

        auto out = engine.distill_from_run(
            sample,
            [](const std::string&, const std::string&, std::stop_token) -> std::string {
                return R"({
                  "pitfalls": [{
                    "triggerSignature": "Windows 桌面客户端配置误查 Program Files 导致路径不存在",
                    "rootCause": "现代 Electron/WebView2 客户端将用户态配置与日志存放在 %APPDATA% 或 %LOCALAPPDATA%",
                    "remedy": "排查 Windows 客户端时优先只读枚举 %APPDATA%、%LOCALAPPDATA% 与用户主目录隐藏配置文件夹",
                    "domainTags": ["windows", "system-inspection"]
                  }],
                  "habits": [{
                    "preference": "排查本机软件运行方式时严格保持零侵入只读，不登录账号、不修改现有配置",
                    "evidenceKind": "correction"
                  }],
                  "playbook": {
                    "slug": "desktop-agent-client-readonly-audit",
                    "title": "桌面与命令行客户端运行机制只读摸底五步法",
                    "problemArchetype": "调查任意本地桌面客户端、AI 编程工具或后台守护服务的启动链路、配置与工作循环",
                    "coreSteps": [
                      "只读定位可执行文件、%APPDATA%/%LOCALAPPDATA% 配置目录与最新日志文件",
                      "解析启动参数、子进程 CLI 调用方式、模型路由与权限策略",
                      "区分真实运行收据与缺失凭证边界，输出附精确路径的结构化短结"
                    ],
                    "qualityBar": "全程只读零副作用，每项结论均有真实文件或日志佐证"
                  }
                })";
            },
            t0);

        check(out.used_model, "distillation used injected Chat-slot model");
        check(out.global_pitfalls_upserted == 1, "one global pitfall antibody stored");
        check(out.bot_habits_upserted == 1, "one per-bot correction habit stored");
        check(out.bot_playbooks_upserted == 1, "one transferable playbook stored");
        check(out.skills_materialized == 1, "high-strength corrected playbook materialized into SKILL.md");

        const fs::path hermes_skill = root / "cli-homes" / "bot-architect" / "hermes" / "skills" /
                                      "auto-desktop-agent-client-readonly-audit" / "SKILL.md";
        check(fs::is_regular_file(hermes_skill), "Hermes isolated SKILL.md materialized for bot-architect");
        const auto skill_text = read_all(hermes_skill);
        check(skill_text.find("name: auto-desktop-agent-client-readonly-audit") != std::string::npos,
              "SKILL.md has valid YAML frontmatter");
        check(skill_text.find("桌面与命令行客户端运行机制只读摸底五步法") != std::string::npos,
              "SKILL.md contains transferable methodology title");
    }

    // 2. "举一反十" verification: Bot A receives a BRAND NEW task about a totally different app ("Cursor / Kimi 客户端")
    //    and silently recalls the generalized playbook + habit + global pitfall!
    {
        const auto recall = engine.recall_for_task(
            "bot-architect",
            "帮我摸底检查一下本机 Kimi 客户端和它的后台子进程是怎么工作的",
            {},
            "windows",
            t0 + 60000);

        check(!recall.playbooks.empty(), "generalized playbook recalled for a new unseen client app");
        check(recall.playbooks.front().slug == "desktop-agent-client-readonly-audit",
              "exact transferable playbook matched via archetype & domain");
        check(!recall.habits.empty(), "per-bot user preference recalled");
        check(!recall.global_pitfalls.empty(), "global pitfall recalled");
        check(recall.silent_prompt_block.find("桌面与命令行客户端运行机制只读摸底五步法") != std::string::npos,
              "silent prompt block embeds playbook steps");
        check(recall.silent_prompt_block.find("%APPDATA%") != std::string::npos,
              "silent prompt block embeds global pitfall remedy");
        check(recall.silent_prompt_block.size() <= 2000, "silent prompt block strictly bounded");
    }

    // 3. Per-Bot independence vs Global pitfall sharing:
    //    Bot B ("bot-designer") has NEVER inspected a client, so it must NOT inherit Bot A's private
    //    habits or playbooks, YET it MUST inherit the global shared Windows pitfall antibody!
    {
        const auto bot_b_recall = engine.recall_for_task(
            "bot-designer",
            "在 Windows 下检查一下某个桌面客户端的配置目录为什么找不到",
            {},
            "windows",
            t0 + 120000);

        check(bot_b_recall.playbooks.empty(), "Bot B does not leak Bot A's private playbooks");
        check(bot_b_recall.habits.empty(), "Bot B does not leak Bot A's private habits");
        check(!bot_b_recall.global_pitfalls.empty(), "Bot B shares the global pitfall library");
        check(bot_b_recall.global_pitfalls.front().remedy.find("%APPDATA%") != std::string::npos,
              "Bot B receives Bot A's discovered Windows pitfall remedy");
    }

    // 4. Anti-pollution guardrail: One-off hard constraints ("禁止任何测试", "单文件HTML", "不超过50字")
    //    must NEVER be saved as permanent habits or playbooks!
    {
        UserTasteHabit bad_habit;
        bad_habit.preference = "每次交付都禁止任何测试，只输出单文件HTML且不超过50字";
        engine.upsert_bot_habit("bot-designer", bad_habit, t0 + 180000);

        const auto snap = engine.inspect_bot("bot-designer");
        check(snap.at("habits").as_array().empty(), "ephemeral hard constraints rejected from permanent habits");
    }

    // 5. Hard boundary respect at recall & skill sync time:
    //    - "不要调用记忆" -> zero recall injection
    //    - "不允许调用 skills" -> auto-* materialized skills unstaged from isolated CLI home
    {
        const auto c_no_mem = extract_preserved_constraints("重新做一份分析，不要调用记忆，不允许调用 skills");
        check(c_no_mem.forbid_memory && c_no_mem.forbid_skills, "constraints extracted");

        const auto recall_blocked = engine.recall_for_task(
            "bot-architect",
            "排查本机客户端运行方式，不要调用记忆",
            c_no_mem,
            "windows",
            t0 + 240000);
        check(recall_blocked.silent_prompt_block.empty(), "forbid_memory completely suppresses craft recall");

        engine.sync_bot_cli_skills("bot-architect", /*forbid_skills=*/true);
        const fs::path hermes_skill = root / "cli-homes" / "bot-architect" / "hermes" / "skills" /
                                      "auto-desktop-agent-client-readonly-audit" / "SKILL.md";
        check(!fs::exists(hermes_skill), "forbid_skills unstages auto-materialized SKILL.md");

        // Re-enable on subsequent normal task
        engine.sync_bot_cli_skills("bot-architect", /*forbid_skills=*/false);
        check(fs::is_regular_file(hermes_skill), "normal task restores auto-materialized SKILL.md");
    }

    // 6. Offline deterministic distillation fallback (when no LLM caller is provided)
    {
        WorkRunTraceSample offline_sample;
        offline_sample.run_id = "run-ui-offline";
        offline_sample.bot_id = "bot-designer";
        offline_sample.bot_name = "设计师";
        offline_sample.platform_hint = "windows";
        offline_sample.user_inputs = {
            "做一个仪表盘网页",
            "不要花哨霓虹色，改成克制的极简冷灰留白风格"
        };
        offline_sample.failed_tool_summaries = {
            "node --check app.js -> SyntaxError: Unexpected token export"
        };
        offline_sample.succeeded_tool_summaries = {
            "Added type=\"module\" and passed node --check app.js"
        };
        offline_sample.changed_files = {"deliverables/dashboard/index.html", "deliverables/dashboard/app.js"};
        offline_sample.final_response = "已完成极简冷灰留白风格的模块化仪表盘界面并通过语法核验。";
        offline_sample.completed_successfully = true;

        const auto out = engine.distill_from_run(offline_sample, {}, t0 + 300000);
        check(!out.used_model, "deterministic fallback executed without model");
        check(out.bot_habits_upserted >= 1, "mid-turn aesthetic correction captured offline");
        check(out.global_pitfalls_upserted >= 1, "JS syntax pitfall captured into global library offline");
        check(out.bot_playbooks_upserted >= 1, "UI craft playbook synthesized offline");
    }

    fs::remove_all(root, ec);
    std::cout << "work_craft_evolution: " << g_checks << " checks passed\n";
    return 0;
}
