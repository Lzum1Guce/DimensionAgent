#include "dimension/notification_inbox.hpp"
#include <algorithm>
#include <filesystem>
#include <iostream>
#include <process.h>
#include <stdexcept>
#include <string>

namespace {
using namespace dimension;
using O = Json::Object;
int checks = 0;
void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); ++checks; }
Json notice(const std::string& id, const std::string& kind = "completed", const std::string& run = "run-1") {
    return O{{"id", id}, {"kind", kind}, {"title", "任务完成"}, {"botId", "bot-1"},
             {"groupId", ""}, {"botName", "测试 Bot"}, {"runId", run},
             {"summary", "APPTEST:" + id}, {"detail", "任务已完成，可查看结果"},
             {"time", "2026-11-16T08:00:00.000Z"}};
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("isolated absolute output directory required");
        const std::filesystem::path root = std::filesystem::path(argv[1]) / std::to_wstring(_getpid());
        if (!root.is_absolute()) throw std::runtime_error("absolute test directory required");
        const auto file = root / L"notification-inbox.json";
        {
            NotificationInbox inbox(file, 3);
            check(inbox.size() == 0 && inbox.unread_count() == 0, "empty inbox");
            check(inbox.add(notice("event-1")), "first event inserted");
            check(!inbox.add(notice("event-1")), "same real event ID is idempotent");
            check(inbox.size() == 1 && inbox.unread_count() == 1, "duplicate did not change counters");
            const auto record = inbox.list().at("items").as_array().at(0);
            check(record.at("summary").as_string() == "APPTEST:event-1" &&
                  record.at("botName").as_string() == "测试 Bot" && !record.at("read").as_bool(),
                  "required display fields persisted");
            check(inbox.add(notice("event-2", "resource", "run-wait")), "resource inserted");
            check(inbox.list().at("items").as_array().at(0).at("waiting").as_bool(), "resource starts waiting");
            check(inbox.resolve_waiting("run-missing", "2026-11-16T08:01:00.000Z") == 0,
                  "unknown resolution creates nothing");
            check(inbox.resolve_waiting("run-wait", "2026-11-16T08:01:00.000Z") == 1, "waiting resolved once");
            const auto resolved = inbox.list().at("items").as_array().at(0);
            check(!resolved.at("waiting").as_bool() && resolved.at("resolvedAt").as_string() == "2026-11-16T08:01:00.000Z",
                  "resolution updates original record");
            check(inbox.resolve_waiting("run-wait", "2026-11-16T08:02:00.000Z") == 0, "resolution is idempotent");
            check(inbox.mark_read("event-1"), "single event marked read");
            check(inbox.mark_read("event-1"), "repeat read remains successful");
            check(!inbox.mark_read("missing"), "missing read ID returns false");
            check(inbox.unread_count() == 1, "unread count after single read");
            check(inbox.add(notice("event-3", "takeover", "run-3")), "takeover inserted");
            check(inbox.add(notice("event-4", "failed", "run-4")), "bounded insertion");
            check(inbox.size() == 3 && inbox.list().at("items").as_array().front().at("id").as_string() == "event-4",
                  "oldest record evicted at bound");
            check(inbox.mark_all_read() == 3 && inbox.unread_count() == 0, "all retained records marked read");
            check(inbox.mark_all_read() == 0, "repeat mark all is a no-op");
            check(inbox.list(true).at("items").as_array().empty(), "unread-only list");
        }
        {
            NotificationInbox restored(file, 3);
            check(restored.size() == 3 && restored.unread_count() == 0, "records and read state survive reload");
            const auto restored_document = restored.list();
            const auto& restored_items = restored_document.at("items").as_array();
            const auto resolved_record = std::find_if(restored_items.begin(), restored_items.end(), [](const Json& item) {
                return item.at("id").as_string() == "event-2";
            });
            check(resolved_record != restored_items.end() && !resolved_record->at("waiting").as_bool() &&
                  !resolved_record->at("resolvedAt").as_string().empty(), "resolved wait survives reload without replay");
            check(!restored.add(notice("event-4", "failed", "run-4")), "dedup survives reload");
        }
        {
            NotificationInbox categories(root / L"categories" / L"notification-inbox.json", 5);
            for (const auto& kind : {"completed", "partial", "failed", "resource", "takeover"})
                check(categories.add(notice("kind-" + std::string(kind), kind, "run-" + std::string(kind))),
                      "every real notification category persists");
            check(categories.size() == 5 && categories.unread_count() == 5, "all categories share bounded unread accounting");
        }
        bool rejected = false;
        try { NotificationInbox invalid(root / L"NUL.json"); invalid.add(notice("must-fail")); }
        catch (const std::exception&) { rejected = true; }
        check(rejected, "invalid atomic destination is safely rejected");
        std::cout << "notification_inbox: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
