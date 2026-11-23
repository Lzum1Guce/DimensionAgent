#include "dimension/approvals.hpp"
#include "dimension/approval_tools.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <latch>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
int checks = 0;
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(x) check(static_cast<bool>(x), #x, __LINE__)
template<class Function> void rejected(Function fn, int status = 0) {
    bool failed = false;
    try { fn(); }
    catch (const ApprovalError& e) { failed = true; CHECK(!status || e.status() == status); }
    CHECK(failed);
}
std::wstring native(fs::path path) { path.make_preferred(); return L"\\\\?\\" + path.wstring(); }
void directory(const fs::path& path) { fs::create_directories(native(path)); }
void write(const fs::path& file, const std::string& text) {
    std::ofstream out(native(file), std::ios::binary | std::ios::trunc);
    out << text; out.close(); CHECK(out.good());
}
std::string read(const fs::path& file) {
    std::ifstream in(native(file), std::ios::binary);
    CHECK(in.good());
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
Json snapshot(const fs::path& root) {
    CHECK(fs::is_regular_file(native(root / "approvals.json")));
    for (const auto& entry : fs::directory_iterator(native(root))) {
        const auto name = entry.path().filename().wstring();
        CHECK(!name.starts_with(L"approvals.json") || name == L"approvals.json");
    }
    auto result = Json::parse(read(root / "approvals.json"));
    CHECK(result.at("version").as_number() == 1 && result.at("records").is_array());
    return result;
}
std::vector<fs::path> files(const fs::path& root) {
    std::vector<fs::path> result;
    for (const auto& entry : fs::directory_iterator(native(root))) result.push_back(root / entry.path().filename());
    return result;
}
ApprovalRequest request(std::string id = "call-a") {
    return {"bot-a", "run-a", 1, std::move(id), "write_file",
        R"({"path":"result.txt","content":"合成内容"})", true,
        Json::Object{{"risk", "write"}, {"path", "result.txt"}, {"content", "合成内容"}}};
}
std::string state(ApprovalService& service, const ApprovalTicket& ticket, const std::string& bot = "bot-a") {
    return service.get(ticket.id, bot).at("state").as_string();
}
struct Waiter {
    std::promise<ApprovalGrant> promise;
    std::future<ApprovalGrant> future = promise.get_future();
    std::jthread worker;
    Waiter(ApprovalService& service, ApprovalTicket ticket, ApprovalRequest expected)
        : worker([&, ticket = std::move(ticket), expected = std::move(expected)](std::stop_token stop) {
            try { promise.set_value(service.wait_and_consume(ticket, expected, stop)); }
            catch (...) { promise.set_exception(std::current_exception()); }
        }) {}
    ApprovalGrant get() {
        CHECK(future.wait_for(3s) == std::future_status::ready);
        return future.get();
    }
};

void modes_and_claims(const fs::path& root) {
    CHECK(approval_mode("full") == ApprovalMode::Full);
    CHECK(approval_mode("auto") == ApprovalMode::Auto);
    CHECK(approval_mode("ask") == ApprovalMode::Ask);
    rejected([] { (void)approval_mode("automatic"); }, 400);
    ApprovalService service(root);
    std::stop_source life;
    auto r = request();
    rejected([&] { (void)service.request(r, ApprovalMode::Ask, {}); }, 400);
    auto full = service.request(r, ApprovalMode::Full, life.get_token());
    CHECK(state(service, full) == "approved");
    auto persisted = snapshot(root).at("records").as_array();
    CHECK(persisted.size() == 1 && persisted.front().at("id").as_string() == full.id);
    CHECK(persisted.front().at("decision").as_string() == "policy");
    CHECK(!persisted.front().at("consumed").as_bool());
    CHECK(service.wait_and_consume(full, r).allowed);
    CHECK(snapshot(root).at("records").as_array().front().at("consumed").as_bool());
    CHECK(!service.wait_and_consume(full, r).allowed);
    auto result = service.complete(full, r, Json::Object{{"ok", true}, {"resultDigest", "fixture"}});
    CHECK(result.at("consumed").as_bool());
    CHECK(service.complete(full, r, result.at("result")).at("result").at("ok").as_bool());
    rejected([&] { (void)service.complete(full, r, Json::Object{{"ok", false}}); }, 409);
    auto same = service.request(r, ApprovalMode::Full, life.get_token());
    CHECK(same.id == full.id && !service.wait_and_consume(same, r).allowed);
    r.action_id = "low-auto"; r.high_risk = false;
    auto low = service.request(r, ApprovalMode::Auto, life.get_token());
    CHECK(service.wait_and_consume(low, r).allowed);
    r.action_id = "high-auto"; r.high_risk = true;
    auto high = service.request(r, ApprovalMode::Auto, life.get_token());
    CHECK(state(service, high) == "pending");
    r.action_id = "low-ask"; r.high_risk = false;
    auto ask = service.request(r, ApprovalMode::Ask, life.get_token());
    CHECK(state(service, ask) == "pending");
    CHECK(service.list("bot-a").as_array().size() == 2);
    CHECK(service.list("bot-b").as_array().empty());
}

void bindings_and_decisions(const fs::path& root) {
    ApprovalService service(root);
    std::stop_source life;
    auto r = request();
    auto ticket = service.request(r, ApprovalMode::Ask, life.get_token());
    auto canonical = r;
    canonical.arguments = R"({ "content" : "合成内容", "path" : "result.txt" })";
    CHECK(service.request(canonical, ApprovalMode::Ask, life.get_token()).id == ticket.id);
    auto altered = r; altered.arguments = R"({"path":"other.txt","content":"合成内容"})";
    rejected([&] { (void)service.request(altered, ApprovalMode::Ask, life.get_token()); }, 409);
    rejected([&] { (void)service.wait_and_consume(ticket, altered); }, 409);
    altered = r; ++altered.attempt;
    rejected([&] { (void)service.wait_and_consume(ticket, altered); }, 409);
    altered = r; altered.bot_id = "bot-b";
    rejected([&] { (void)service.wait_and_consume(ticket, altered); }, 404);
    rejected([&] { (void)service.decide(ticket.id, "bot-b", true); }, 404);
    rejected([&] { (void)service.complete(ticket, r, Json::Object{{"ok", true}}); }, 409);
    auto spoof = ticket; spoof.binding[0] = spoof.binding[0] == 'a' ? 'b' : 'a';
    rejected([&] { (void)service.wait_and_consume(spoof, r); }, 409);
    Waiter waiting(service, ticket, r);
    CHECK(waiting.future.wait_for(25ms) == std::future_status::timeout);
    HANDLE snapshot_reader = CreateFileW(native(root / "approvals.json").c_str(), GENERIC_READ,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    CHECK(snapshot_reader != INVALID_HANDLE_VALUE);
    auto decision = std::async(std::launch::async,
        [&] { return service.decide(ticket.id, "bot-a", false); });
    CHECK(decision.wait_for(40ms) == std::future_status::timeout);
    CloseHandle(snapshot_reader);
    CHECK(decision.get().at("ok").as_bool());
    const auto denied = snapshot(root).at("records").as_array().front();
    CHECK(denied.at("state").as_string() == "rejected" && denied.at("decision").as_string() == "deny");
    CHECK(!waiting.get().allowed);
    CHECK(service.decide(ticket.id, "bot-a", false).at("alreadyDecided").as_bool());
    rejected([&] { (void)service.decide(ticket.id, "bot-a", true); }, 409);
    CHECK(state(service, ticket) == "rejected");
    CHECK(!fs::exists(native(root / "result.txt"))); // No executor is hidden in decide().
}

void single_consumption_under_concurrency(const fs::path& root) {
    ApprovalService service(root);
    std::stop_source life;
    auto r = request();
    auto ticket = service.request(r, ApprovalMode::Ask, life.get_token());
    std::vector<std::unique_ptr<Waiter>> waiters;
    for (int i = 0; i < 12; ++i) waiters.push_back(std::make_unique<Waiter>(service, ticket, r));
    CHECK(service.decide(ticket.id, "bot-a", true).at("ok").as_bool());
    int grants = 0;
    for (auto& waiter : waiters) if (waiter->get().allowed) ++grants;
    CHECK(grants == 1);
    CHECK(service.get(ticket.id, "bot-a").at("consumed").as_bool());
    CHECK(service.decide(ticket.id, "bot-a", true).at("alreadyDecided").as_bool());
}

void competing_decisions(const fs::path& root) {
    ApprovalService service(root);
    std::stop_source life;
    for (int iteration = 0; iteration < 4; ++iteration) {
        const auto r = request("decision-race-" + std::to_string(iteration));
        const auto ticket = service.request(r, ApprovalMode::Ask, life.get_token());
        std::latch ready(2), go(1);
        std::atomic_int success{0}, conflicts{0}, unexpected{0};
        auto decide = [&](bool allow) {
            ready.count_down(); go.wait();
            try { (void)service.decide(ticket.id, "bot-a", allow); ++success; }
            catch (const ApprovalError& error) {
                if (error.status() == 409) ++conflicts; else ++unexpected;
            } catch (...) { ++unexpected; }
        };
        std::jthread allow([&] { decide(true); }), deny([&] { decide(false); });
        ready.wait(); go.count_down();
        allow.join(); deny.join();
        CHECK(success == 1 && conflicts == 1 && unexpected == 0);
        const auto approved = state(service, ticket) == "approved";
        CHECK(service.wait_and_consume(ticket, r).allowed == approved);
        CHECK(!service.wait_and_consume(ticket, r).allowed);
    }
}
void cancellation_and_scoped_invalidation(const fs::path& root) {
    ApprovalService service(root);
    std::stop_source first, other;
    auto r = request();
    auto a = service.request(r, ApprovalMode::Ask, first.get_token());
    Waiter waiting(service, a, r);
    first.request_stop();
    CHECK(!waiting.get().allowed && state(service, a) == "cancelled");
    rejected([&] { (void)service.decide(a.id, "bot-a", true); }, 409);
    r.action_id = "already-approved";
    auto approved = service.request(r, ApprovalMode::Ask, other.get_token());
    (void)service.decide(approved.id, "bot-a", true);
    CHECK(service.invalidate_run("bot-b", "run-a") == 0);
    CHECK(service.invalidate_run("bot-a", "run-a", 2) == 0);
    CHECK(service.invalidate_run("bot-a", "run-a", 1) == 1);
    CHECK(!service.wait_and_consume(approved, r).allowed);
    CHECK(state(service, approved) == "stale");
    r.action_id = "waiting-after-steer"; r.attempt = 2;
    auto newer = service.request(r, ApprovalMode::Ask, other.get_token());
    Waiter next(service, newer, r);
    CHECK(service.invalidate_run("bot-a", "run-a", 2, ApprovalState::Cancelled) == 1);
    CHECK(!next.get().allowed);
    r.action_id = "already-stopped";
    auto stopped = service.request(r, ApprovalMode::Full, first.get_token());
    CHECK(state(service, stopped) == "cancelled" && !service.wait_and_consume(stopped, r).allowed);
    r.action_id = "waiter-token"; r.attempt = 3;
    auto independent = service.request(r, ApprovalMode::Ask, other.get_token());
    Waiter waiter(service, independent, r);
    waiter.worker.request_stop();
    CHECK(!waiter.get().allowed);
    CHECK(state(service, independent) == "cancelled");
    r.action_id = "shutdown";
    auto end = service.request(r, ApprovalMode::Ask, other.get_token());
    Waiter shutdown_waiter(service, end, r);
    service.shutdown();
    CHECK(!shutdown_waiter.get().allowed);
    rejected([&] { (void)service.request(request("closed"), ApprovalMode::Full, other.get_token()); }, 409);
}

void restart_invalidates_all_old_authority(const fs::path& root) {
    std::stop_source life;
    std::vector<ApprovalTicket> tickets;
    auto r = request();
    {
        ApprovalService service(root);
        tickets.push_back(service.request(r, ApprovalMode::Ask, life.get_token()));
        r.action_id = "approved";
        tickets.push_back(service.request(r, ApprovalMode::Ask, life.get_token()));
        (void)service.decide(tickets.back().id, "bot-a", true);
        r.action_id = "claimed";
        tickets.push_back(service.request(r, ApprovalMode::Full, life.get_token()));
        CHECK(service.wait_and_consume(tickets.back(), r).allowed);
        r.action_id = "completed";
        tickets.push_back(service.request(r, ApprovalMode::Full, life.get_token()));
        CHECK(service.wait_and_consume(tickets.back(), r).allowed);
        (void)service.complete(tickets.back(), r, Json::Object{{"ok", true}});
    }
    ApprovalService restored(root);
    for (const auto& ticket : tickets) CHECK(state(restored, ticket) == "stale");
    CHECK(restored.list("bot-a").as_array().empty());
    CHECK(restored.get(tickets[2].id, "bot-a").at("consumed").as_bool());
    CHECK(restored.get(tickets[3].id, "bot-a").at("result").at("ok").as_bool());
    rejected([&] { (void)restored.wait_and_consume(tickets.back(), r); }, 409);
    rejected([&] { (void)restored.decide(tickets.front().id, "bot-a", true); }, 409);
    r = request();
    auto old = restored.request(r, ApprovalMode::Ask, life.get_token());
    CHECK(!restored.wait_and_consume(old, r).allowed);
    ++r.attempt;
    auto fresh = restored.request(r, ApprovalMode::Ask, life.get_token());
    (void)restored.decide(fresh.id, "bot-a", true);
    CHECK(restored.wait_and_consume(fresh, r).allowed);
}

void capacities_expiry_and_bad_json(const fs::path& root) {
    ApprovalLimits limits;
    limits.max_records = 2; limits.max_pending = 1; limits.max_result_bytes = 32;
    limits.max_arguments_bytes = 100; limits.max_snapshot_bytes = 8192;
    ApprovalService service(root / "limits", limits);
    std::stop_source life;
    auto r = request();
    auto first = service.request(r, ApprovalMode::Ask, life.get_token());
    rejected([&] { (void)service.request(request("second"), ApprovalMode::Ask, life.get_token()); }, 429);
    auto second = service.request(request("second"), ApprovalMode::Full, life.get_token());
    CHECK(service.wait_and_consume(second, request("second")).allowed);
    rejected([&] { (void)service.complete(second, request("second"),
        Json::Object{{"oversized", std::string(64, 'x')}}); }, 400);
    rejected([&] { (void)service.request(request("third"), ApprovalMode::Full, life.get_token()); }, 429);
    auto invalid = request(); invalid.arguments = R"({"x":1,"x":2})";
    rejected([&] { (void)service.request(invalid, ApprovalMode::Ask, life.get_token()); }, 400);
    invalid.arguments = std::string(101, ' ');
    rejected([&] { (void)service.request(invalid, ApprovalMode::Ask, life.get_token()); }, 400);
    invalid = request(); invalid.action_id = "../not-a-path";
    // IDs are inert data, not filenames; a new record cannot bypass capacity.
    rejected([&] { (void)service.request(invalid, ApprovalMode::Full, life.get_token()); }, 429);
    // Pending and consumed-without-outcome remain active. Terminal records retire
    // only after immutable audit and invocation tombstones have both committed.
    (void)service.decide(first.id, "bot-a", false);
    const auto third = service.request(request("third"), ApprovalMode::Full, life.get_token());
    CHECK(service.list("bot-a", false).as_array().size() == 2);
    CHECK(state(service, first) == "rejected");
    CHECK(service.wait_and_consume(third, request("third")).allowed);
    (void)service.complete(second, request("second"), Json::Object{{"ok", true}});
    const auto fourth = service.request(request("fourth"), ApprovalMode::Ask, life.get_token());
    CHECK(state(service, fourth) == "pending" && service.list("bot-a", false).as_array().size() == 2);
    rejected([&] { (void)service.request(request("still-full"), ApprovalMode::Full, life.get_token()); }, 429);
    limits = {}; limits.lifetime = 35ms;
    ApprovalService timed(root / "expiry", limits);
    auto expired = timed.request(r, ApprovalMode::Ask, life.get_token());
    Waiter waiting(timed, expired, r);
    CHECK(!waiting.get().allowed && state(timed, expired) == "stale");
    rejected([&] { (void)timed.decide(expired.id, "bot-a", true); }, 409);
    limits = {}; limits.max_snapshot_bytes = 1024; limits.max_result_bytes = 1024;
    ApprovalService budget(root / "bytes", limits);
    rejected([&] { (void)budget.request(r, ApprovalMode::Full, life.get_token()); }, 429);
    CHECK(budget.list("bot-a", false).as_array().empty());
}

void sustained_archival_and_replay(const fs::path& root) {
    ApprovalLimits limits;
    limits.max_records = 4; limits.max_pending = 2; limits.max_snapshot_bytes = 65536;
    limits.max_result_bytes = 128;
    std::stop_source life;
    std::vector<ApprovalTicket> tickets;
    const Json outcome = Json::Object{{"ok", true}, {"receipt", "synthetic-completed"}};
    {
        ApprovalService service(root, limits);
        for (int i = 0; i < 320; ++i) {
            auto r = request("sustained-" + std::to_string(i));
            auto ticket = service.request(r, ApprovalMode::Ask, life.get_token());
            tickets.push_back(ticket);
            CHECK(service.decide(ticket.id, "bot-a", true).at("ok").as_bool());
            CHECK(service.wait_and_consume(ticket, r).allowed);
            CHECK(service.complete(ticket, r, outcome).at("result").dump() == outcome.dump());
            CHECK(service.list("bot-a", false).as_array().size() <= limits.max_records);
        }
        auto first = request("sustained-0");
        auto retry = service.request(first, ApprovalMode::Ask, life.get_token());
        CHECK(retry.id == tickets.front().id && !service.wait_and_consume(retry, first).allowed);
        CHECK(service.list("bot-a", false).as_array().empty());
        CHECK(snapshot(root).at("records").as_array().empty());
        CHECK(files(root / "archive" / "by-id").size() == 320);
        CHECK(files(root / "archive" / "by-action").size() == 320);
        CHECK(service.decide(retry.id, "bot-a", true).at("alreadyDecided").as_bool());
        rejected([&] { (void)service.decide(retry.id, "bot-a", false); }, 409);
        CHECK(service.complete(retry, first, outcome).at("result").dump() == outcome.dump());
        auto changed = first; changed.arguments = R"({"path":"changed.txt","content":"changed"})";
        rejected([&] { (void)service.request(changed, ApprovalMode::Ask, life.get_token()); }, 409);
        rejected([&] { (void)service.get(retry.id, "bot-b"); }, 404);
    }
    ApprovalService restarted(root, limits);
    for (std::size_t i = 0; i < tickets.size(); ++i) {
        auto r = request("sustained-" + std::to_string(i));
        const auto audit = restarted.get(tickets[i].id, "bot-a");
        CHECK(audit.at("state").as_string() == "stale" && audit.at("consumed").as_bool());
        CHECK(audit.at("result").dump() == outcome.dump());
        const auto retry = restarted.request(r, ApprovalMode::Ask, life.get_token());
        CHECK(retry.id == tickets[i].id && !restarted.wait_and_consume(retry, r).allowed);
    }
    auto first = request("sustained-0");
    rejected([&] { (void)restarted.wait_and_consume(tickets.front(), first); }, 409);
    rejected([&] { (void)restarted.request(first, ApprovalMode::Full, life.get_token()); }, 409);
    ++first.attempt;
    const auto fresh = restarted.request(first, ApprovalMode::Ask, life.get_token());
    CHECK(fresh.id != tickets.front().id && state(restarted, fresh) == "pending");
    (void)restarted.decide(fresh.id, "bot-a", false);
}

void archive_partial_recovery_and_conflict(const fs::path& root) {
    std::stop_source life;
    const auto r = request("archive-recovery");
    for (const auto* missing : {"by-action", "by-id"}) {
        const auto data = root / missing;
        ApprovalTicket ticket;
        std::string before;
        {
            ApprovalService service(data);
            ticket = service.request(r, ApprovalMode::Ask, life.get_token());
            (void)service.decide(ticket.id, "bot-a", true);
            CHECK(service.wait_and_consume(ticket, r).allowed);
            (void)service.complete(ticket, r, Json::Object{{"ok", true}});
            before = read(data / "approvals.json");
            CHECK(service.request(r, ApprovalMode::Ask, life.get_token()).id == ticket.id);
        }
        // Model a crash between immutable writes and removal of the active row.
        write(data / "approvals.json", before);
        const auto partial = files(data / "archive" / missing);
        CHECK(partial.size() == 1 && fs::remove(native(partial.front())));
        ApprovalService restored(data);
        const auto retry = restored.request(r, ApprovalMode::Ask, life.get_token());
        CHECK(retry.id == ticket.id && !restored.wait_and_consume(retry, r).allowed);
        CHECK(restored.get(ticket.id, "bot-a").at("result").at("ok").as_bool());
        const auto by_id = files(data / "archive" / "by-id");
        const auto by_action = files(data / "archive" / "by-action");
        CHECK(by_id.size() == 1 && by_action.size() == 1);
        CHECK(read(by_id.front()) == read(by_action.front()));
        CHECK(snapshot(data).at("records").as_array().empty());
    }
    const auto data = root / "conflict";
    ApprovalService service(data);
    const auto ticket = service.request(r, ApprovalMode::Full, life.get_token());
    CHECK(service.wait_and_consume(ticket, r).allowed);
    auto record = service.complete(ticket, r, Json::Object{{"ok", true}}).as_object();
    const auto before = read(data / "approvals.json");
    record["state"] = "stale"; record["reason"] = "archived";
    record["result"] = Json::Object{{"ok", false}};
    const auto conflicting = Json(std::move(record)).dump();
    const auto archived = data / "archive" / "by-id" / (ticket.id + ".json");
    write(archived, conflicting);
    rejected([&] { (void)service.request(request("after-conflict"), ApprovalMode::Full, life.get_token()); }, 503);
    rejected([&] { (void)service.request(request("still-closed"), ApprovalMode::Full, life.get_token()); }, 503);
    CHECK(read(data / "approvals.json") == before && read(archived) == conflicting);
}

void storage_failure_is_closed(const fs::path& root) {
    ApprovalService service(root);
    std::stop_source life;
    auto r = request();
    auto ticket = service.request(r, ApprovalMode::Ask, life.get_token());
    Waiter waiting(service, ticket, r);
    CHECK(fs::remove(native(root / "approvals.json")));
    directory(root / "approvals.json"); // Controlled disk fault, inside isolated fixture.
    rejected([&] { (void)service.decide(ticket.id, "bot-a", true); }, 503);
    rejected([&] { (void)waiting.get(); }, 503);
    rejected([&] { (void)service.request(request("another"), ApprovalMode::Full, life.get_token()); }, 503);
}
void manual_file_queue(const fs::path& root) {
    const auto project = root / "project";
    directory(project);
    ApprovalService approvals(root / "approval-store");
    ApprovalToolQueue queue(approvals);
    auto denied = queue.write("bot-a", project, "incoming/denied.txt", "synthetic denied",
        ApprovalMode::Ask, "deny-file");
    CHECK(denied.at("pending").as_bool());
    CHECK(!fs::exists(native(project / "incoming")));
    (void)approvals.decide(denied.at("approvalId").as_string(), "bot-a", false);
    auto accepted = queue.write("bot-a", project, "incoming/accepted.txt", "合成 accepted",
        ApprovalMode::Ask, "approve-file");
    const auto id = accepted.at("approvalId").as_string();
    CHECK(!fs::exists(native(project / "incoming" / "accepted.txt")));
    (void)approvals.decide(id, "bot-a", true);
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (approvals.get(id, "bot-a").at("result").is_null() &&
           std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(5ms);
    CHECK(approvals.get(id, "bot-a").at("result").at("ok").as_bool());
    CHECK(read(project / "incoming" / "accepted.txt") == "合成 accepted");
    const auto incoming = files(project / "incoming");
    CHECK(incoming.size() == 1 && incoming.front().filename() == L"accepted.txt");
    CHECK(!fs::exists(native(project / "incoming" / "denied.txt")));
    // A retried UI request returns the same durable result rather than another write.
    CHECK(queue.write("bot-a", project, "incoming/accepted.txt", "合成 accepted",
        ApprovalMode::Ask, "approve-file").at("approvalId").as_string() == id);
    rejected([&] { (void)queue.write("bot-a", project, "incoming/different.txt", "changed",
        ApprovalMode::Ask, "approve-file"); }, 409);
    rejected([&] { (void)queue.write("bot-a", project, "../escape.txt", "bad",
        ApprovalMode::Full, "escape"); }, 400);
    rejected([&] { (void)queue.write("bot-a", project, "incoming/a.txt:stream", "bad",
        ApprovalMode::Full, "stream"); }, 400);
    const auto foreign = root / "foreign.txt";
    write(foreign, "FOREIGN");
    CHECK(CreateHardLinkW(native(project / "linked.txt").c_str(), native(foreign).c_str(), nullptr));
    auto blocked = queue.write("bot-a", project, "linked.txt", "must not change",
        ApprovalMode::Full, "hard-link");
    CHECK(!blocked.at("ok").as_bool());
    CHECK(read(foreign) == "FOREIGN");
    auto stopped = queue.write("bot-a", project, "incoming/stopped.txt", "must not exist",
        ApprovalMode::Ask, "stop-file");
    queue.shutdown();
    CHECK(approvals.get(stopped.at("approvalId").as_string(), "bot-a").at("state").as_string() == "cancelled");
    CHECK(!fs::exists(native(project / "incoming" / "stopped.txt")));
    ApprovalToolQueue bounded(approvals);
    for (int i = 0; i < 16; ++i)
        CHECK(bounded.write("bot-a", project, "queued/" + std::to_string(i) + ".txt", "fixture",
            ApprovalMode::Ask, "queue-" + std::to_string(i)).at("pending").as_bool());
    rejected([&] { (void)bounded.write("bot-a", project, "queued/overflow.txt", "fixture",
        ApprovalMode::Ask, "queue-overflow"); }, 429);
    bounded.shutdown();
    CHECK(!fs::exists(native(project / "queued")));
}
void path_and_file_protection(const fs::path& root) {
    directory(root);
    rejected([&] { ApprovalService relative("relative"); }, 400);
    rejected([&] { ApprovalService dot(root / ".." / "escape"); }, 400);
    {
        ApprovalService first(root / "owned");
        rejected([&] { ApprovalService second(root / "owned"); }, 503);
    }
    const auto sentinel = root / "host-sentinel.txt";
    write(sentinel, "DO NOT CHANGE");
    const auto linked = root / "hardlink";
    directory(linked);
    CHECK(CreateHardLinkW(native(linked / "approvals.json").c_str(), native(sentinel).c_str(), nullptr));
    rejected([&] { ApprovalService bad(linked); }, 503);
    CHECK(read(sentinel) == "DO NOT CHANGE");
    const auto corrupt = root / "corrupt";
    directory(corrupt);
    const std::string broken = R"({"version":1,"records":[{"broken":true}]})";
    write(corrupt / "approvals.json", broken);
    rejected([&] { ApprovalService bad(corrupt); }, 503);
    CHECK(read(corrupt / "approvals.json") == broken);
    const auto malformed = root / "legacy-filename";
    directory(malformed);
    write(malformed / "approvals.json-unexpected", R"({"version":1,"records":[]})");
    rejected([&] { ApprovalService bad(malformed); }, 503);
    CHECK(!fs::exists(native(malformed / "approvals.json")));

    // Junction fixture uses the standard Windows filesystem API, no shell/WSL.
    const auto foreign = root / "foreign";
    const auto link = root / "junction";
    directory(foreign); directory(link);
    struct Reparse {
        DWORD tag; WORD length, reserved, sub_offset, sub_length, print_offset, print_length;
        WCHAR path[2048];
    } data{};
    const auto destination = L"\\??\\" + foreign.wstring();
    CHECK(destination.size() + 2 < 2048);
    data.tag = IO_REPARSE_TAG_MOUNT_POINT;
    data.sub_length = static_cast<WORD>(destination.size() * sizeof(WCHAR));
    data.print_offset = data.sub_length + sizeof(WCHAR);
    data.length = static_cast<WORD>(8 + data.print_offset + sizeof(WCHAR));
    std::copy(destination.begin(), destination.end(), data.path);
    HANDLE handle = CreateFileW(native(link).c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    CHECK(handle != INVALID_HANDLE_VALUE);
    DWORD bytes{};
    const auto ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, data.length + 8,
        nullptr, 0, &bytes, nullptr);
    CloseHandle(handle); CHECK(ok);
    rejected([&] { ApprovalService bad(link / "must-not-be-created"); }, 503);
    CHECK(!fs::exists(native(foreign / "must-not-be-created")));
    auto long_path = root / "long";
    while (long_path.wstring().size() < 310) long_path /= L"long-component";
    std::stop_source life;
    ApprovalService long_store(long_path);
    auto r = request();
    auto ticket = long_store.request(r, ApprovalMode::Full, life.get_token());
    CHECK(long_store.wait_and_consume(ticket, r).allowed);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass the configured isolated absolute test output directory");
        const fs::path supplied(argv[1]);
        CHECK(supplied.is_absolute() && supplied.lexically_normal() == fs::path(DIMENSION_TEST_ROOT).lexically_normal());
        const auto root = supplied / ("approvals-" +
            std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        directory(root);
        modes_and_claims(root / "modes");
        bindings_and_decisions(root / "bindings");
        single_consumption_under_concurrency(root / "concurrent");
        competing_decisions(root / "decision-race");
        cancellation_and_scoped_invalidation(root / "cancel");
        restart_invalidates_all_old_authority(root / "restart");
        capacities_expiry_and_bad_json(root / "bounded");
        sustained_archival_and_replay(root / "sustained");
        archive_partial_recovery_and_conflict(root / "archive-recovery");
        storage_failure_is_closed(root / "storage-fault");
        manual_file_queue(root / "manual-files");
        path_and_file_protection(root / "paths");
        std::cout << "approvals: " << checks
                  << " checks passed; synthetic state only, no tools/models/services invoked\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "approvals test failed: " << error.what() << '\n';
        return 1;
    }
}

