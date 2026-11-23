#include "dimension/proactive_reminders.hpp"
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>

namespace {
using namespace dimension;
using O = Json::Object;
namespace fs = std::filesystem;
int checks = 0;
void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); ++checks; }
double num(const Json& value, std::string_view key) {
    const auto* found = value.find(key); return found && found->is_number() ? found->as_number() : 0;
}
std::string str(const Json& value, std::string_view key) {
    const auto* found = value.find(key); return found && found->is_string() ? found->as_string() : "";
}
bool flag(const Json& value, std::string_view key) {
    const auto* found = value.find(key); return found && found->is_bool() ? found->as_bool() : false;
}
Json input(std::string kind, std::int64_t now) {
    O value{{"name", "合成提醒"}, {"kind", kind}, {"message", "只提醒，不执行"}, {"delivery", "notification"},
        {"budget", 3}, {"endAt", static_cast<double>(now + 3600000)},
        {"scope", O{{"source", "scheduler"}, {"botId", ""}, {"groupId", ""}, {"runId", ""}}}};
    if (kind == "interval") value["intervalMinutes"] = 1;
    else value["eventType"] = "run_completed";
    return value;
}
Json event(std::string run, int sequence, std::string type = "run_completed", std::string bot = "bot-a") {
    return O{{"type", type}, {"runId", run}, {"seq", sequence}, {"botId", bot}, {"groupId", "group-a"}};
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) return 2;
        const auto base = fs::absolute(argv[1]) / std::to_wstring(GetCurrentProcessId());
        fs::create_directories(base);
        const auto storage = base / "reminders.json";
        std::int64_t now = 1700000000000;
        bool quiet = false;
        std::vector<Json> sent;
        auto options = [&] {
            return ProactiveReminderOptions{storage, [&] { return now; },
                [&](const Json& notice) { sent.push_back(notice); }, [&] { return quiet; }};
        };
        std::string interval_id;
        {
            ProactiveReminderService service(options());
            check(service.rules().as_array().empty(), "empty dataset starts without rules");
            check(service.capabilities().at("automaticWork").as_bool() == false, "no automatic Work capability");
            auto created = service.create(input("interval", now));
            interval_id = str(created, "id");
            check(!flag(created, "enabled") && str(created, "status") == "paused", "created rules are disabled by default");
            check(num(created, "nextTriggerAt") == 0, "disabled rule has no scheduled trigger");
            now += 10 * 60000;
            service.tick();
            check(sent.empty(), "disabled interval never fires");
            now -= 10 * 60000;
            auto active = service.set_enabled(interval_id, true, O{{"revision", 1}});
            check(num(active, "nextTriggerAt") == static_cast<double>(now + 60000), "enable starts a fresh full interval");
            now += 60000; service.tick(); service.tick();
            check(sent.size() == 1, "due interval emits once without same-tick duplicates");
            now += 10 * 60000; service.tick();
            check(sent.size() == 2, "many missed intervals coalesce into one notification");
            check(num(sent.back(), "missedOccurrences") == 9, "coalesced notification explains missed count");
            check(num(service.rule(interval_id), "triggerCount") == 2, "coalescing charges only delivered occurrence");
            now += 10 * 60000;
        }
        {
            ProactiveReminderService service(options());
            check(sent.size() == 2, "restart load itself does not notify");
            service.tick(); service.tick();
            check(sent.size() == 3, "restart emits at most one coalesced overdue reminder");
            check(str(service.rule(interval_id), "status") == "completed", "budget completion persists across restart");
            now += 100 * 60000; service.tick();
            check(sent.size() == 3, "budget exhaustion prevents later triggers");
        }

        const auto condition_storage = base / "conditions.json";
        auto condition_options = [&] {
            return ProactiveReminderOptions{condition_storage, [&] { return now; },
                [&](const Json& notice) { sent.push_back(notice); }, [&] { return quiet; }};
        };
        std::string condition_id;
        {
            ProactiveReminderService service(condition_options());
            auto value = input("condition", now); value["name"] = "条件去重"; value["budget"] = 2;
            auto created = service.create(value); condition_id = str(created, "id");
            service.observe(event("run-disabled", 1));
            check(sent.size() == 3, "disabled condition does not fire");
            service.set_enabled(condition_id, true, O{{"revision", 1}});
            auto scoped = event("run-other-bot", 1); scoped["botId"] = "bot-b";
            service.observe(scoped);
            check(sent.size() == 4, "empty Bot scope explicitly matches any Bot");
            // A dedicated non-empty scope is tested below.
        }
        // The previous event spent one of two triggers. Restart and replay must not spend another.
        {
            ProactiveReminderService service(condition_options());
            const auto before = sent.size();
            service.observe(event("run-other-bot", 1));
            check(sent.size() == before, "same event is deduplicated across restart");
            service.observe(event("run-new", 2));
            check(sent.size() == before + 1, "new event spends remaining budget");
            service.observe(event("run-after-budget", 3));
            check(str(service.rule(condition_id), "status") == "completed" && sent.size() == before + 1,
                "condition budget stops future matching events");
            auto draft_input = input("condition", now);
            draft_input["name"] = "仅草稿"; draft_input["delivery"] = "draft"; draft_input["budget"] = 1;
            draft_input["endAt"] = 0; draft_input["endEventType"] = "run_completed";
            auto draft = service.create(draft_input);
            service.set_enabled(str(draft, "id"), true, O{{"revision", 1}});
            const auto notifications_before = sent.size();
            service.observe(event("run-draft", 1)); service.observe(event("run-draft", 1));
            check(sent.size() == notifications_before, "draft delivery never calls notification channel");
            const auto saved = service.rule(str(draft, "id"));
            check(str(saved.at("latestDraft"), "status") == "draft-only-not-sent", "draft is durable and explicitly unsent");
            check(str(saved, "status") == "completed", "matching end condition completes after preparing draft");
        }

        {
            ProactiveReminderService service(condition_options());
            auto scoped_input = input("condition", now); scoped_input["name"] = "限定范围"; scoped_input["budget"] = 1;
            scoped_input["scope"] = O{{"source", "scheduler"}, {"botId", "bot-a"}, {"groupId", ""}, {"runId", ""}};
            auto scoped = service.create(scoped_input);
            service.set_enabled(str(scoped, "id"), true, O{{"revision", 1}});
            const auto before = sent.size();
            service.observe(event("run-wrong-scope", 1, "run_completed", "bot-b"));
            check(sent.size() == before, "explicit Bot scope rejects other Bot events");
            service.observe(event("run-right-scope", 1, "run_completed", "bot-a"));
            check(sent.size() == before + 1, "explicit Bot scope accepts matching event");

            auto ending_input = input("condition", now); ending_input["name"] = "独立结束条件";
            ending_input["endAt"] = 0; ending_input["endEventType"] = "run_failed";
            auto ending = service.create(ending_input);
            service.set_enabled(str(ending, "id"), true, O{{"revision", 1}});
            service.observe(event("run-ending", 1, "run_failed"));
            check(str(service.rule(str(ending, "id")), "status") == "completed", "end condition stops without a trigger notification");
            service.observe(event("run-ending", 2, "run_completed"));
            check(sent.size() == before + 1, "completed end-condition rule cannot trigger later");

            auto expiry_input = input("interval", now); expiry_input["name"] = "到期";
            expiry_input["endAt"] = static_cast<double>(now + 30000);
            auto expiry = service.create(expiry_input);
            service.set_enabled(str(expiry, "id"), true, O{{"revision", 1}});
            now += 30000; service.tick();
            check(str(service.rule(str(expiry, "id")), "status") == "completed", "end time wins over a due interval");
            check(sent.size() == before + 1, "expired rule does not notify");

            auto paused_input = input("interval", now); paused_input["name"] = "暂停恢复";
            auto paused = service.create(paused_input);
            service.set_enabled(str(paused, "id"), true, O{{"revision", 1}});
            service.set_enabled(str(paused, "id"), false, O{{"revision", 2}});
            now += 20 * 60000; service.tick();
            check(sent.size() == before + 1, "paused interval does not fire");
            auto resumed = service.set_enabled(str(paused, "id"), true, O{{"revision", 3}});
            check(num(resumed, "nextTriggerAt") == static_cast<double>(now + 60000), "resume discards paused backlog");
            service.tick();
            check(sent.size() == before + 1, "resume does not immediately replay missed intervals");
            service.set_enabled(str(paused, "id"), false, O{{"revision", 4}});

            auto quiet_input = input("interval", now); quiet_input["name"] = "免打扰";
            auto quiet_rule = service.create(quiet_input);
            service.set_enabled(str(quiet_rule, "id"), true, O{{"revision", 1}});
            quiet = true; now += 60000; service.tick();
            check(sent.size() == before + 1 && num(service.rule(str(quiet_rule, "id")), "triggerCount") == 0,
                "quiet time drops occurrence without charging budget");
            check(num(service.rule(str(quiet_rule, "id")), "skippedCount") == 1, "quiet drop is explainable");
            quiet = false; service.tick();
            check(sent.size() == before + 1, "quiet occurrence is not replayed");
            now += 60000; service.tick();
            check(sent.size() == before + 2, "next ordinary interval still fires after quiet time");
        }

        {
            ProactiveReminderService service(condition_options());
            bool rejected = false;
            try { auto bad = input("interval", now); bad["enabled"] = true; service.create(bad); }
            catch (const ProactiveReminderError&) { rejected = true; }
            check(rejected, "create cannot bypass default-disabled state");
            rejected = false;
            try { auto bad = input("interval", now); bad["endAt"] = 0; service.create(bad); }
            catch (const ProactiveReminderError&) { rejected = true; }
            check(rejected, "rule requires explicit end time or condition");
            rejected = false;
            try { auto bad = input("condition", now); bad["scope"] = O{{"source", "filesystem"}}; service.create(bad); }
            catch (const ProactiveReminderError&) { rejected = true; }
            check(rejected, "condition rules cannot escalate to filesystem scope");
        }
        std::cout << "proactive_reminders: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
