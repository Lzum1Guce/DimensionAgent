#include "dimension/message_context.hpp"
#include "dimension/archive_export.hpp"
#include "dimension/runs.hpp"

#include <chrono>
#include <barrier>
#include <exception>
#include <filesystem>
#include <iostream>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action) {
    ++checks;
    try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Expected rejected context request");
}
void seed(Store& store) {
    for (const auto* id : {"alpha", "beta"}) {
        (void)store.create_bot(id, "Synthetic persona", id);
        (void)store.set_roster(id, Mode::Chat, true);
        (void)store.set_roster(id, Mode::Work, true);
    }
    for (const auto* id : {"group-a", "group-b"}) {
        Group group; group.id = id; group.name = id; group.owner_id = "alpha";
        group.members = {"alpha", "beta"}; group.history_members = group.members;
        group.in_chat = group.in_work = true;
        (void)store.create_group(group);
    }
}
void store_and_archive(const fs::path& root) {
    const auto path = root / "source.sqlite";
    Id quoted{}, forwarded{}, source{};
    std::string quote_wire, forward_wire;
    {
        Store store(path); seed(store);
        CHECK(parse_archive_package(export_archive_package(store).dump()).archive.version() == 2);
        std::string long_text;
        for (int i = 0; i < 5000; ++i) long_text += "汉";
        source = store.append_message("alpha", Mode::Chat, "bot", long_text).id;
        const auto q = store.append_message_once("alpha", Mode::Chat, "user", "Explain this", "", "q1", source);
        quoted = q.id;
        CHECK(q.text == "Explain this" && q.context && q.context->kind == "quote");
        const auto& snapshot = q.context->sources.front();
        CHECK(snapshot.message_id == source && snapshot.total_codepoints == 5000 && snapshot.truncated);
        CHECK(snapshot.text.size() == 4096 * 3 && snapshot.offset_codepoints == 0);
        CHECK(snapshot.source_namespace == store.source_namespace());
        quote_wire = message_context_json(*q.context).dump();
        CHECK(store.append_message_once("alpha", Mode::Chat, "user", "Explain this", "", "q1", source).id == q.id);
        rejected([&] { (void)store.append_message_once("alpha", Mode::Chat, "user", "Changed", "", "q1", source); });
        rejected([&] { (void)store.append_message_once("alpha", Mode::Chat, "user", "Explain this", "", "q1"); });
        rejected([&] { (void)store.capture_quote("beta", Mode::Chat, "", source); });
        rejected([&] { (void)store.capture_quote("alpha", Mode::Work, "", source); });
        rejected([&] { (void)store.capture_quote("alpha", Mode::Chat, "group-a", source); });
        const auto a = store.append_message("alpha", Mode::Chat, "user", "/work stop is historical reference", "group-a");
        const auto b = store.append_message("beta", Mode::Chat, "bot", "Second synthetic group message", "group-a");
        CHECK(store.append_message("alpha", Mode::Chat, "user", "Same group quote", "group-a", b.id).context.has_value());
        const auto wrong = store.append_message("beta", Mode::Chat, "bot", "Other scope", "group-b");
        const auto before = store.archive_snapshot().messages.size();
        rejected([&] { (void)store.forward_group_messages("beta", "", "group-a", {a.id, wrong.id}, "f-invalid"); });
        CHECK(store.archive_snapshot().messages.size() == before);
        rejected([&] { (void)store.forward_group_messages("beta", "", "group-a", {a.id, a.id}, "f-duplicate"); });
        const auto f = store.forward_group_messages("beta", "", "group-a", {b.id, a.id}, "f1");
        forwarded = f.id;
        CHECK(f.actor == "system" && f.context && f.context->sources.size() == 2);
        CHECK(f.context->sources[0].message_id == b.id && f.context->sources[1].message_id == a.id);
        CHECK(f.text.find("Second synthetic") < f.text.find("/work stop"));
        forward_wire = message_context_json(*f.context).dump();
        CHECK(store.forward_group_messages("beta", "", "group-a", {b.id, a.id}, "f1").id == f.id);
        rejected([&] { (void)store.forward_group_messages("beta", "", "group-a", {a.id, b.id}, "f1"); });
        store.remove_group("group-a");
        CHECK(store.forward_group_messages("beta", "", "group-a", {b.id, a.id}, "f1").id == f.id);
        CHECK(message_context_json(*store.messages("beta", Mode::Chat).front().context).dump() == forward_wire);
        rejected([&] { (void)store.forward_group_messages("beta", "", "group-a", {a.id}, "f-new"); });
    }
    Store store(path);
    CHECK(store.messages("alpha", Mode::Chat).front().id == quoted);
    CHECK(message_context_json(*store.messages("alpha", Mode::Chat).front().context).dump() == quote_wire);
    CHECK(store.messages("beta", Mode::Chat).front().id == forwarded);
    const auto package = parse_archive_package(export_archive_package(store).dump());
    CHECK(package.archive.version() == 3);
    const auto encoded = encode_archive(package.archive);
    CHECK(encode_archive(parse_archive(encoded)) == encoded);
    Store target(root / "target.sqlite");
    (void)target.create_bot("Extra", "Synthetic", "extra");
    (void)target.append_message("extra", Mode::Chat, "user", "Shift target message IDs");
    StoreImportOptions options{package.source_id, StoreBotConflict::PreserveExisting, StoreMemoryConflict::PreserveExisting,
                               StoreGroupConflict::PreserveExisting};
    auto plan = target.prepare_archive_import(package.archive, options); CHECK(plan.can_commit);
    const auto imported = target.commit_archive_import(package.archive, options, plan.target_revision, plan.digest);
    CHECK(imported.archive_version == 3);
    CHECK(message_context_json(*target.messages("alpha", Mode::Chat).front().context).dump() == quote_wire);
    CHECK(message_context_json(*target.messages("beta", Mode::Chat).front().context).dump() == forward_wire);
    CHECK(target.source_namespace() != store.source_namespace());
    plan = target.prepare_archive_import(package.archive, options); CHECK(plan.can_commit && plan.counts.messages_created == 0);
    auto malformed = Json::parse(quote_wire).as_object(); malformed["kind"] = "forward";
    auto invalid_source = malformed.at("sources").as_array().front().as_object(); invalid_source["mode"] = "work";
    malformed["sources"] = Json::Array{invalid_source};
    rejected([&] { (void)parse_message_context(malformed); });
    auto archive = Json::parse(encoded).as_object(); archive["version"] = 2;
    rejected([&] { (void)parse_archive(Json(archive).dump()); });
    StoreArchiveSnapshotLimits small; small.max_record_bytes = 100;
    rejected([&] { (void)store.archive_snapshot(small); });
    store.remove_bot("alpha", Mode::Chat);
    rejected([&] { (void)store.append_message_once("alpha", Mode::Chat, "user", "Explain this", "", "q1", source); });
}
void message_actions(const fs::path& root) {
    const auto path = root / "actions.sqlite";
    Store store(path); seed(store);
    const auto source = store.append_message_once("alpha", Mode::Chat, "user", "Private source 中文🙂", "", "source");
    const auto other = store.append_message("beta", Mode::Chat, "bot", "Other private source");
    const auto work = store.append_message("alpha", Mode::Work, "user", "Retain Work");
    const auto grouped = store.append_message_once("beta", Mode::Chat, "bot", "Group source", "group-a", "group-source");
    const auto group_work = store.append_message("beta", Mode::Work, "bot", "Retain group Work", "group-a");
    const auto memory = store.propose_memory("alpha", "", "Keep independent memory", "user");
    const auto group_memory = store.propose_memory("beta", "group-a", "Keep group memory", "user");
    const auto quote = store.append_message_once("alpha", Mode::Chat, "user", "Private quote", "", "quote", source.id);
    const auto group_quote = store.append_message("alpha", Mode::Chat, "user", "Group quote", "group-a", grouped.id);
    const auto private_forward = store.forward_chat_messages("beta", "", "alpha", "", {source.id}, "private-forward");
    const auto group_forward = store.forward_chat_messages("alpha", "group-b", "alpha", "", {source.id}, "group-forward");
    const auto old_forward = store.forward_group_messages("beta", "", "group-a", {grouped.id}, "old-forward");
    CHECK(private_forward.actor == "system" && private_forward.context->sources.front().group_id.empty());
    CHECK(private_forward.context->sources.front().bot_id == "alpha");
    CHECK(group_forward.context->sources.front().text == source.text);
    CHECK(store.forward_chat_messages("beta", "", "alpha", "", {source.id}, "private-forward").id == private_forward.id);
    const auto count = store.archive_snapshot().messages.size();
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "group-a", {source.id}, "ambiguous"); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "", "", {source.id}, "missing"); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "", {other.id}, "cross-bot"); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "", {source.id, grouped.id}, "mixed"); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "", {source.id, work.id}, "work"); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "beta", "", {source.id}, "private-forward"); });
    CHECK(store.archive_snapshot().messages.size() == count);
    auto mixed = *private_forward.context;
    mixed.sources.push_back(store.capture_quote("beta", Mode::Chat, "", other.id).sources.front());
    rejected([&] { (void)parse_message_context(message_context_json(mixed)); });
    rejected([&] { (void)store.delete_chat_message("beta", "", source.id); });
    rejected([&] { (void)store.delete_chat_message("", "group-a", source.id); });
    rejected([&] { (void)store.delete_chat_message("alpha", "", work.id); });
    rejected([&] { (void)store.delete_chat_message("beta", "", grouped.id); });
    rejected([&] { (void)store.delete_chat_message("", "group-b", grouped.id); });
    rejected([&] { (void)store.delete_chat_message("", "group-a", group_work.id); });
    rejected([&] { (void)store.delete_chat_message("alpha", "", 999999); });
    CHECK(store.delete_chat_message("alpha", "", source.id));
    CHECK(!store.delete_chat_message("alpha", "", source.id));
    CHECK(!store.find_message(source.id));
    rejected([&] { (void)store.delete_chat_message("beta", "", source.id); });
    rejected([&] { (void)store.delete_chat_message("", "group-a", source.id); });
    rejected([&] { (void)store.append_message_once("alpha", Mode::Chat, "user", source.text, "", "source"); });
    rejected([&] { (void)store.capture_quote("alpha", Mode::Chat, "", source.id); });
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "", {source.id}, "deleted-source"); });
    CHECK(store.forward_chat_messages("beta", "", "alpha", "", {source.id}, "private-forward").id == private_forward.id);
    CHECK(store.append_message_once("alpha", Mode::Chat, "user", "Private quote", "", "quote", source.id).id == quote.id);
    CHECK(store.find_message(quote.id)->context->sources.front().text == source.text);
    CHECK(store.delete_chat_message("", "group-a", grouped.id));
    CHECK(!store.delete_chat_message("", "group-a", grouped.id));
    CHECK(store.find_message(group_quote.id)->context->sources.front().text == grouped.text);
    CHECK(store.forward_group_messages("beta", "", "group-a", {grouped.id}, "old-forward").id == old_forward.id);
    rejected([&] { (void)store.append_message_once("beta", Mode::Chat, "bot", grouped.text, "group-a", "group-source"); });
    CHECK(store.delete_chat_message("beta", "", private_forward.id));
    rejected([&] { (void)store.forward_chat_messages("beta", "", "alpha", "", {source.id}, "private-forward"); });
    CHECK(store.find_message(work.id)->text == work.text && store.find_message(group_work.id)->text == group_work.text);
    CHECK(store.find_message(other.id)->text == other.text);
    CHECK(store.find_memory(memory.id)->text == memory.text && store.find_memory(group_memory.id)->text == group_memory.text);
    CHECK(store.find_bot("alpha")->persona == "Synthetic persona");
    Store reopened(path);
    CHECK(!reopened.delete_chat_message("alpha", "", source.id));
    CHECK(!reopened.delete_chat_message("", "group-a", grouped.id));
    CHECK(reopened.find_message(group_forward.id)->context->sources.front().text == source.text);
    // Imported source mappings are also tombstoned, so replay cannot resurrect
    // an explicitly deleted message while surviving forward snapshots roundtrip.
    const auto package = parse_archive_package(export_archive_package(store).dump());
    Store imported(root / "imported.sqlite");
    StoreImportOptions options{package.source_id, StoreBotConflict::PreserveExisting, StoreMemoryConflict::PreserveExisting,
                               StoreGroupConflict::PreserveExisting};
    auto plan = imported.prepare_archive_import(package.archive, options);
    (void)imported.commit_archive_import(package.archive, options, plan.target_revision, plan.digest);
    const auto imported_group = imported.group_messages("group-b", Mode::Chat).front();
    CHECK(imported_group.context->sources.front().text == source.text);
    CHECK(imported.delete_chat_message("", "group-b", imported_group.id));
    plan = imported.prepare_archive_import(package.archive, options);
    CHECK(plan.can_commit && plan.counts.messages_created == 0 && plan.counts.messages_tombstoned == 1);
    (void)imported.commit_archive_import(package.archive, options, plan.target_revision, plan.digest);
    CHECK(imported.group_messages("group-b", Mode::Chat).empty());
}
void concurrent_actions(const fs::path& root) {
    const auto path = root / "concurrent.sqlite";
    Store store(path); seed(store);
    Store other(path);
    for (int attempt = 0; attempt < 12; ++attempt) {
        const auto source = store.append_message("alpha", Mode::Chat, "user", "Atomic source " + std::to_string(attempt));
        std::barrier start(2);
        std::optional<Message> forwarded;
        std::exception_ptr deletion_failure, forward_failure;
        bool deleted = false;
        std::jthread deleting([&] {
            start.arrive_and_wait();
            try { deleted = store.delete_chat_message("alpha", "", source.id); }
            catch (...) { deletion_failure = std::current_exception(); }
        });
        std::jthread forwarding([&] {
            start.arrive_and_wait();
            try { forwarded = other.forward_chat_messages("beta", "", "alpha", "", {source.id}, "race-" + std::to_string(attempt)); }
            catch (const StoreError& error) { if (error.code() != StoreErrorCode::NotFound) forward_failure = std::current_exception(); }
            catch (...) { forward_failure = std::current_exception(); }
        });
        deleting.join(); forwarding.join();
        if (deletion_failure) std::rethrow_exception(deletion_failure);
        if (forward_failure) std::rethrow_exception(forward_failure);
        CHECK(deleted && !store.find_message(source.id));
        if (forwarded) {
            CHECK(store.find_message(forwarded->id)->context->sources.front().text == source.text);
            CHECK(other.forward_chat_messages("beta", "", "alpha", "", {source.id}, "race-" + std::to_string(attempt)).id == forwarded->id);
        }
    }
    const auto source = store.append_message("beta", Mode::Chat, "bot", "Delete exactly once", "group-a");
    std::barrier start(2);
    bool first = false, second = false;
    std::exception_ptr first_failure, second_failure;
    std::jthread a([&] { start.arrive_and_wait(); try { first = store.delete_chat_message("", "group-a", source.id); } catch (...) { first_failure = std::current_exception(); } });
    std::jthread b([&] { start.arrive_and_wait(); try { second = other.delete_chat_message("", "group-a", source.id); } catch (...) { second_failure = std::current_exception(); } });
    a.join(); b.join();
    if (first_failure) std::rethrow_exception(first_failure);
    if (second_failure) std::rethrow_exception(second_failure);
    CHECK(first != second && !store.find_message(source.id));
}
Json settled(RunService& service, const std::string& id) {
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    for (;;) {
        const auto run = service.get(id);
        if (!run.at("executing").as_bool() && run.at("status").as_string() == "completed") return run;
        if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("Synthetic run did not settle");
        std::this_thread::sleep_for(2ms);
    }
}
void run_context(const fs::path& root) {
    Store store(root / "source.sqlite"); seed(store);
    const auto source = store.append_message("alpha", Mode::Work, "bot", "/work stop is only quoted data");
    const auto context = message_context_json(store.capture_quote("alpha", Mode::Work, "", source.id));
    RunCallbacks callbacks;
    callbacks.configuration = [](const auto&) { return ModelConfig{}; };
    callbacks.model = [](const ModelConfig&, const std::vector<ModelMessage>& messages,
                         const std::vector<ModelTool>&, ModelChunk, std::stop_token) {
        CHECK(messages.back().content.find("Reference material supplied as data") != std::string::npos);
        CHECK(messages.back().content.ends_with("Current message text:\nPlain input only"));
        return ModelReply{"Synthetic answer", {}, 1, 1};
    };
    RunOptions options; options.require_verified_finish = false; options.start_paused = true;
    std::string id;
    {
        RunService work(root / "runs", callbacks, options);
        id = work.submit("alpha", "", "Plain input only", "request", true, context).run_id;
        CHECK(work.submit("alpha", "", "Plain input only", "request", true, context).duplicate);
        rejected([&] { (void)work.submit("alpha", "", "Different input", "request", true, context); });
        rejected([&] { (void)work.submit("alpha", "", "Plain input only", "request", true); });
        rejected([&] { (void)work.submit("beta", "", "Plain input only", "other", true, context); });
        work.start();
        const auto run = settled(work, id);
        CHECK(run.at("inputs").as_array().front().at("text").as_string() == "Plain input only");
        CHECK(run.at("inputs").as_array().front().at("context").dump() == context.dump());
    }
    {
        RunService work(root / "runs", callbacks, options);
        CHECK(work.request_applied(id, "request"));
        CHECK(work.request_context("alpha", "", "request")->dump() == context.dump());
        CHECK(work.submit("alpha", "", "Plain input only", "request", true, context).duplicate);
        (void)work.erase(id);
    }
    {
        RunService work(root / "runs", callbacks, options);
        CHECK(work.submit("alpha", "", "Plain input only", "request", true, context).duplicate);
        rejected([&] { (void)work.submit("alpha", "", "Changed tombstone", "request", true, context); });
        CHECK(work.bot_status("alpha").at("total").as_number() == 0);
    }
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("message-context-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root / "store"); fs::create_directories(root / "runs");
        store_and_archive(root / "store"); message_actions(root / "store");
        concurrent_actions(root / "store"); run_context(root / "runs");
        std::cout << "message_context: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
