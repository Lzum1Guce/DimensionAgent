#include "dimension/store.hpp"

#include <algorithm>
#include <atomic>
#include <barrier>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <string>
#include <thread>
#include <vector>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

using namespace dimension;

namespace {

std::size_t checks{};

void check(bool value, const char* message) {
    ++checks;
    if (!value) throw std::runtime_error(message);
}

template <class Function>
void expect_error(StoreErrorCode code, Function action, const char* message) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) {
        if (error.code() == code) return;
        throw std::runtime_error(std::string(message) + ": wrong error: " + error.what());
    }
    throw std::runtime_error(std::string(message) + ": expected a StoreError");
}

Memory confirmed(Store& store, std::string_view bot, std::string_view scope, std::string_view text) {
    const auto memory = store.propose_memory(bot, scope, text, "user");
    return store.review_memory(memory.id, memory.revision, MemoryState::Confirmed);
}

std::size_t unicode_count(std::string_view text) {
    std::size_t result{};
    for (std::size_t i = 0; i < text.size(); ++result) {
        const auto first = static_cast<unsigned char>(text[i]);
        std::size_t width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (i + width > text.size()) throw std::runtime_error("UTF-8 was truncated inside a scalar");
        for (std::size_t n = 1; n < width; ++n) {
            if ((static_cast<unsigned char>(text[i + n]) & 0xc0) != 0x80) {
                throw std::runtime_error("UTF-8 continuation was corrupted");
            }
        }
        i += width;
    }
    return result;
}

void persistence_and_rosters(const std::filesystem::path& root) {
    const auto path = root / L"持久角色.sqlite";
    Id memory_id{};
    Id private_message_id{};
    std::string random_id;
    const std::string bot = "researcher-original-id";
    const std::string name = "小维 ' ; DROP TABLE bots; --";
    const std::string persona = "研究员：区分 C 与 C++；保留 1.5、15 与原始标点。";
    {
        Store store(path);
        const auto created = store.create_bot(name, persona, bot);
        check(created.id == bot && !created.in_chat && !created.in_work, "Create preserves explicit ID in library");
        random_id = store.create_bot("Second", "Independent identity").id;
        check(random_id.starts_with("bot-") && random_id.size() == 36, "Generated ID is persistent random identifier");
        check(store.create_bot("Third", "").id != random_id, "Generated IDs differ");
        check(store.list_bots().size() == 3, "Role library lists all bots");
        expect_error(StoreErrorCode::Conflict, [&] { (void)store.create_bot("overwrite", "", bot); }, "Duplicate ID rejected");
        for (const auto id : {"UPPER", "9starts", "bad_id", "has space", "a';drop"}) {
            expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.create_bot("bad", "", id); }, "Invalid ID rejected");
        }
        expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.create_bot("bad", "", std::string(65, 'a')); }, "Long ID rejected");
        check(!store.find_bot("missing"), "Missing bot lookup is optional");
        expect_error(StoreErrorCode::NotFound, [&] { store.remove_bot("missing"); }, "Missing bot removal rejected");
        auto changed = store.set_roster(bot, Mode::Chat, true);
        check(changed.in_chat && !changed.in_work, "Chat roster independent");
        changed = store.set_roster(bot, Mode::Work, true);
        check(changed.in_chat && changed.in_work, "Work roster independent");
        changed = store.set_roster(bot, Mode::Chat, false);
        check(!changed.in_chat && changed.in_work, "Removing chat roster preserves work roster");
        (void)store.set_roster(bot, Mode::Chat, true);
        check(store.list_bots(Mode::Chat).size() == 1 && store.list_bots(Mode::Work).size() == 1, "Roster lists filtered");
        private_message_id = store.append_message(bot, Mode::Chat, "user", "私聊信息：' ? % _ C++").id;
        (void)store.append_message(bot, Mode::Work, "bot", "工作结果");
        (void)store.append_message(bot, Mode::Chat, "user", "群聊信息", "group-a");
        (void)store.append_message(bot, Mode::Work, "system", "群工作信息", "group-a");
        (void)store.append_message(random_id, Mode::Chat, "user", "别的角色私聊");
        check(store.messages(bot, Mode::Chat).size() == 1, "Private chat excludes work and group");
        check(store.messages(bot, Mode::Work).front().text == "工作结果", "Private work excludes chat");
        check(store.messages(bot, Mode::Chat, "group-a").front().text == "群聊信息", "Group chat mode preserved");
        check(store.messages(bot, Mode::Work, "group-a").front().text == "群工作信息", "Group work mode preserved");
        auto memory = store.propose_memory(bot, "", "用户喜欢 C++ 与 1.5 倍速", "user");
        check(memory.state == MemoryState::Candidate && memory.revision == 1, "Proposals enter candidate state");
        check(store.retrieve_memories(bot, "", "C++").empty(), "Candidate is never recalled");
        memory = store.review_memory(memory.id, memory.revision, MemoryState::Confirmed);
        memory_id = memory.id;
        check(memory.revision == 2 && store.retrieve_memories(bot, "", "C++").size() == 1, "Explicit confirmation enables retrieval");
        (void)confirmed(store, bot, "group-a", "只属于群 A 的记忆");
        auto rejected = store.propose_memory(bot, "", "未采纳但保留的记忆", "user");
        (void)store.review_memory(rejected.id, rejected.revision, MemoryState::Rejected);
        (void)store.propose_memory(bot, "", "待审核但保留的记忆", "user");
    }
    {
        Store reopened(path);
        const auto persisted = reopened.find_bot(bot);
        check(persisted && persisted->name == name && persisted->persona == persona, "Identity and persona survive close/reopen");
        check(persisted->in_chat && persisted->in_work, "Both rosters survive close/reopen");
        check(reopened.find_bot(random_id).has_value(), "Generated ID survives close/reopen");
        check(reopened.messages(bot, Mode::Chat).front().id == private_message_id, "Message IDs survive close/reopen");
        check(reopened.find_memory(memory_id)->state == MemoryState::Confirmed, "Memory state survives close/reopen");
        reopened.remove_bot(bot);
        const auto removed = reopened.find_bot(bot);
        check(removed && removed->id == bot && removed->persona == persona && !removed->in_chat && !removed->in_work,
            "Removal retains identity and persona while detaching both modes");
        check(reopened.messages(bot, Mode::Chat).empty() && reopened.messages(bot, Mode::Work).empty(), "Removal clears both private logs");
        check(reopened.messages(bot, Mode::Chat, "group-a").size() == 1 &&
            reopened.messages(bot, Mode::Work, "group-a").size() == 1, "Removal preserves group logs");
        check(reopened.messages(random_id, Mode::Chat).size() == 1, "Removal does not touch another bot");
        check(reopened.list_memories(bot).size() == 4, "Removal preserves every memory state and scope");
        check(reopened.retrieve_memories(bot, "", "C++").front().id == memory_id, "Removed bot retains confirmed recall");
        check(reopened.list_bots().size() == 3, "Removed bot remains in role library");
        const auto restored = reopened.set_roster(bot, Mode::Chat, true);
        check(restored.id == bot && restored.in_chat && !restored.in_work, "Library re-entry restores the same ID");
        check(reopened.find_memory(memory_id).has_value(), "Library re-entry restores same memory");
        check(reopened.append_message(bot, Mode::Chat, "user", "重新开始").id > private_message_id, "Cleared message IDs are never reused");
    }
    Store persisted_again(path);
    check(persisted_again.find_bot(bot)->in_chat && !persisted_again.find_bot(bot)->in_work, "Restored roster persists");
    check(persisted_again.find_memory(memory_id).has_value(), "Memory persists after removal and second reopen");
}

void pagination(const std::filesystem::path& root) {
    Store store(root / "pagination.sqlite");
    const auto bot = store.create_bot("Pager", "", "pager").id;
    std::vector<Id> expected;
    for (int i = 0; i < 137; ++i) {
        expected.push_back(store.append_message(bot, Mode::Chat, "user", "page-" + std::to_string(i)).id);
        if (i % 7 == 0) {
            (void)store.append_message(bot, Mode::Work, "user", "other mode");
            (void)store.append_message(bot, Mode::Chat, "user", "other scope", "group-a");
        }
    }
    std::reverse(expected.begin(), expected.end());
    std::vector<Id> actual;
    std::optional<Id> before;
    auto page = store.messages(bot, Mode::Chat, "", 17);
    const auto appended = store.append_message(bot, Mode::Chat, "bot", "newest after first page");
    while (!page.empty()) {
        check(page.size() <= 17, "Page limit honored");
        for (const auto& row : page) actual.push_back(row.id);
        before = page.back().id;
        page = store.messages(bot, Mode::Chat, "", 17, before);
    }
    check(actual == expected, "Exclusive cursor pagination neither skips nor duplicates old messages");
    check(std::set<Id>(actual.begin(), actual.end()).size() == 137, "All 137 historical IDs unique");
    check(store.messages(bot, Mode::Chat, "", 1).front().id == appended.id, "Newest message appears first after append");
    check(store.messages(bot, Mode::Chat, "", 5, expected.back()).empty(), "Oldest cursor yields empty page");
    expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.messages(bot, Mode::Chat, "", 0); }, "Zero page limit rejected");
    expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.messages(bot, Mode::Chat, "", 501); }, "Oversized page rejected");
    expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.messages(bot, Mode::Chat, "", 10, 0); }, "Invalid cursor rejected");
}

void memory_permissions_scopes_and_revisions(const std::filesystem::path& root) {
    const auto path = root / "memory.sqlite";
    Store store(path);
    const auto alice = store.create_bot("Alice", "", "alice").id;
    const auto bob = store.create_bot("Bob", "", "bob").id;
    for (const auto source : {"bot", "assistant", "system", "", "USER"}) {
        expect_error(StoreErrorCode::InvalidArgument,
            [&] { (void)store.propose_memory(alice, "", "must not save", source); }, "Only explicit user source can propose");
    }
    check(store.list_memories(alice).empty(), "Rejected sources do not create any record");
    const auto candidate = store.propose_memory(alice, "", "same text C++ 1.5", "user");
    const auto duplicate = store.propose_memory(alice, "", "  same text C++ 1.5\n", "user");
    check(candidate.id == duplicate.id && duplicate.revision == 1, "Exact trimmed text deduplicates without changing revision");
    const auto in_group = store.propose_memory(alice, "group-a", candidate.text, "user");
    const auto other_bot = store.propose_memory(bob, "", candidate.text, "user");
    check(in_group.id != candidate.id && other_bot.id != candidate.id, "Deduplication never crosses bot or group scope");
    auto private_memory = store.review_memory(candidate.id, 1, MemoryState::Confirmed);
    check(store.propose_memory(alice, "", candidate.text, "user").state == MemoryState::Confirmed,
        "Duplicate proposal does not demote or promote existing state");
    check(store.retrieve_memories(alice, "group-a", "C++").empty(), "Private memory never enters a group");
    check(store.retrieve_memories(bob, "", "C++").empty(), "One bot never retrieves another bot's memory");
    (void)store.review_memory(in_group.id, 1, MemoryState::Confirmed);
    (void)store.review_memory(other_bot.id, 1, MemoryState::Confirmed);
    check(store.retrieve_memories(alice, "", "C++").front().id == candidate.id, "Private scope recall is exact");
    check(store.retrieve_memories(alice, "group-a", "C++").front().id == in_group.id, "Group scope recall is exact");
    check(store.retrieve_memories(bob, "", "C++").front().id == other_bot.id, "Bot scope recall is exact");
    check(store.retrieve_memories(alice, "group-b", "C++").empty(), "Different groups never share recall");
    check(store.retrieve_memories(alice, "GROUP-A", "C++").empty(), "Group identifiers match exact case");

    const auto decimal = store.propose_memory(alice, "symbols", "1.5", "user");
    const auto integer = store.propose_memory(alice, "symbols", "15", "user");
    const auto c = store.propose_memory(alice, "symbols", "C", "user");
    const auto cpp = store.propose_memory(alice, "symbols", "C++", "user");
    check(decimal.id != integer.id && c.id != cpp.id, "Dedup preserves decimal and language punctuation semantics");
    const std::string hostile_scope = "group'; DROP TABLE memories; --";
    const std::string hostile_text = "用户说 ' ); DROP TABLE bots; -- C++ %_ 1.5 中文";
    const auto literal = confirmed(store, alice, hostile_scope, hostile_text);
    const auto literal_result = store.retrieve_memories(alice, hostile_scope, "%_");
    check(literal_result.size() == 1 && literal_result.front().text == hostile_text, "SQL punctuation stored and matched literally");
    check(store.find_bot(alice).has_value() && store.find_memory(literal.id).has_value(), "SQL-looking values cannot alter schema");
    check(store.retrieve_memories(alice, "", "%_").empty(), "SQL-looking scope cannot widen retrieval");

    const auto both = confirmed(store, alice, "rank", "alpha beta older but more relevant");
    (void)confirmed(store, alice, "rank", "alpha newer less relevant");
    (void)confirmed(store, alice, "rank", "unrelated newest");
    const auto ranked = store.retrieve_memories(alice, "rank", "ALPHA beta");
    check(ranked.size() == 2 && ranked.front().id == both.id, "Matched query terms rank before recency");
    check(store.retrieve_memories(alice, "rank", "no-match").empty(), "No matching terms yields no recall");

    Store concurrent(path);
    const auto stale = concurrent.find_memory(private_memory.id).value();
    private_memory = store.review_memory(private_memory.id, private_memory.revision, MemoryState::Rejected);
    check(store.retrieve_memories(alice, "", "C++").empty(), "Rejected memory is never recalled");
    check(store.propose_memory(alice, "", private_memory.text, "user").state == MemoryState::Rejected,
        "Duplicate does not resurrect a rejected memory");
    expect_error(StoreErrorCode::Conflict, [&] { (void)concurrent.edit_memory(stale.id, stale.revision, "stale overwrite"); }, "Stale edit is a conflict");
    expect_error(StoreErrorCode::Conflict, [&] { (void)concurrent.review_memory(stale.id, stale.revision, MemoryState::Confirmed); }, "Stale review is a conflict");
    expect_error(StoreErrorCode::Conflict, [&] { concurrent.delete_memory(stale.id, stale.revision); }, "Stale delete is a conflict");
    check(store.find_memory(stale.id)->text == stale.text, "Conflicts preserve original data");
    auto edited = concurrent.edit_memory(private_memory.id, private_memory.revision, "用户改成 C++ 15");
    check(edited.state == MemoryState::Candidate && edited.revision == private_memory.revision + 1,
        "Editing creates a new candidate revision");
    check(store.retrieve_memories(alice, "", "C++").empty(), "Changed text requires a new explicit confirmation");
    edited = store.review_memory(edited.id, edited.revision, MemoryState::Confirmed);
    const auto unchanged = store.edit_memory(edited.id, edited.revision, edited.text);
    check(unchanged.revision == edited.revision && unchanged.state == MemoryState::Confirmed, "No-op edit does not invalidate confirmed text");
    const auto competing = store.propose_memory(alice, "", "existing target text", "user");
    expect_error(StoreErrorCode::Conflict, [&] { (void)store.edit_memory(edited.id, edited.revision, competing.text); }, "Editing into duplicate is a conflict");
    check(store.find_memory(edited.id)->text == edited.text && store.find_memory(edited.id)->revision == edited.revision,
        "Failed edit rolls back text, state, and revision together");
    expect_error(StoreErrorCode::InvalidArgument, [&] { (void)store.review_memory(edited.id, edited.revision, MemoryState::Candidate); }, "Review must confirm or reject");
    store.remove_bot(alice);
    check(store.find_memory(edited.id).has_value(), "Bot removal does not delete memory");
    store.delete_memory(edited.id, edited.revision);
    check(!store.find_memory(edited.id), "Explicit revision-checked delete removes memory");
    check(store.find_memory(competing.id).has_value(), "Explicit delete removes only selected memory");
    expect_error(StoreErrorCode::NotFound, [&] { store.delete_memory(edited.id, edited.revision); }, "Second explicit delete reports missing record");
    Store reopened(path);
    check(!reopened.find_memory(edited.id) && reopened.find_memory(competing.id).has_value(), "Explicit deletion survives reopening");

    const auto only_private = store.list_memories(alice, std::string_view(""));
    check(!only_private.empty() && std::all_of(only_private.begin(), only_private.end(),
        [](const Memory& item) { return item.group_id.empty(); }), "Management filter distinguishes private from all scopes");
    const auto all_confirmed = store.list_memories(alice, {}, false);
    check(std::all_of(all_confirmed.begin(), all_confirmed.end(), [](const Memory& item) {
        return item.state == MemoryState::Confirmed;
    }), "Management confirmed-only filter");
    const auto all = store.list_memories(alice);
    std::vector<Id> paged;
    std::optional<Id> cursor;
    for (;;) {
        const auto page = store.list_memories(alice, {}, true, 3, cursor);
        if (page.empty()) break;
        for (const auto& memory : page) paged.push_back(memory.id);
        cursor = page.back().id;
    }
    check(paged.size() == all.size() && std::set<Id>(paged.begin(), paged.end()).size() == all.size(),
        "Memory management pagination has no duplicate or lost row");
}

void unicode_and_budget(const std::filesystem::path& root) {
    Store store(root / "unicode.sqlite");
    const auto bot = store.create_bot("中文名字", "人设🌊", "unicode").id;
    std::string long_text;
    for (int i = 0; i < 1250; ++i) long_text += "中🌊";
    const auto full = confirmed(store, bot, "long", long_text);
    const auto bounded = store.retrieve_memories(bot, "long", "", 900, 90000);
    check(bounded.empty(), "A complete record exceeding the hard 1600-scalar budget is skipped");
    check(store.find_memory(full.id)->text == long_text, "Retrieval never mutates over-budget stored memory");
    const std::string short_text = "中文🌊完整事实，不能丢失否定。";
    const auto short_memory = confirmed(store, bot, "long", short_text);
    const auto tiny = store.retrieve_memories(bot, "long", "", 5, 17);
    check(tiny.size() == 1 && tiny.front().id == short_memory.id && tiny.front().text == short_text &&
        unicode_count(tiny.front().text) <= 17, "Smaller budget retains a complete Chinese/emoji fact without broken UTF-8");
    check(store.retrieve_memories(bot, "long", "", 0, 100).empty() &&
        store.retrieve_memories(bot, "long", "", 5, 0).empty(), "Zero recall budget yields no text");
    for (int i = 0; i < 9; ++i) (void)confirmed(store, bot, "short", "budget " + std::to_string(i));
    check(store.retrieve_memories(bot, "short", "budget", 999, 99999).size() == 5, "Hard recall item limit is five");
    check(store.retrieve_memories(bot, "short", "budget", 2).size() == 2, "Caller can use a smaller item count");
    for (int i = 0; i < 8; ++i) {
        std::string medium = "budget " + std::to_string(i);
        for (int n = 0; n < 440; ++n) medium += "汉";
        (void)confirmed(store, bot, "combined", medium);
    }
    const auto combined = store.retrieve_memories(bot, "combined", "budget");
    std::size_t total{};
    for (const auto& memory : combined) total += unicode_count(memory.text);
    check(combined.size() == 3 && total <= 1600, "Combined budget includes only complete fitting records");
    for (const auto& memory : combined) {
        check(store.find_memory(memory.id)->text == memory.text, "Retrieved records are never partial sentences");
    }
    (void)confirmed(store, bot, "skip", "older short remainder");
    std::string middle(900, 'm');
    std::string newest(1000, 'n');
    (void)confirmed(store, bot, "skip", middle);
    (void)confirmed(store, bot, "skip", newest);
    const auto skipped = store.retrieve_memories(bot, "skip", "");
    check(skipped.size() == 2 && skipped.front().text == newest && skipped.back().text == "older short remainder",
        "Retrieval skips a nonfitting item and can still include a later complete short item");
    const std::vector<std::string> invalid{
        std::string("\xc0\xaf", 2), std::string("\xed\xa0\x80", 3),
        std::string("\xf4\x90\x80\x80", 4), std::string("\xf0\x9f", 2), std::string("a\0b", 3)
    };
    for (const auto& text : invalid) {
        expect_error(StoreErrorCode::InvalidArgument,
            [&] { (void)store.propose_memory(bot, "", text, "user"); }, "Malformed UTF-8 never enters memory");
    }
    expect_error(StoreErrorCode::InvalidArgument,
        [&] { (void)store.append_message(bot, Mode::Chat, "user", invalid.front()); }, "Malformed UTF-8 never enters history");
    expect_error(StoreErrorCode::InvalidArgument,
        [&] { (void)store.retrieve_memories(bot, invalid.front(), ""); }, "Malformed scope rejected");
}

void concurrent_revision(const std::filesystem::path& root) {
    const auto path = root / "concurrent.sqlite";
    Store left(path);
    const auto bot = left.create_bot("Concurrent", "", "concurrent").id;
    const auto memory = left.propose_memory(bot, "", "competing reviews", "user");
    Store right(path);
    std::barrier ready(3);
    std::atomic<int> successes{};
    std::atomic<int> conflicts{};
    std::atomic<int> unexpected{};
    auto review = [&](Store& store, MemoryState state) {
        ready.arrive_and_wait();
        try {
            (void)store.review_memory(memory.id, memory.revision, state);
            ++successes;
        } catch (const StoreError& error) {
            if (error.code() == StoreErrorCode::Conflict) ++conflicts;
            else ++unexpected;
        } catch (...) { ++unexpected; }
    };
    std::thread first([&] { review(left, MemoryState::Confirmed); });
    std::thread second([&] { review(right, MemoryState::Rejected); });
    ready.arrive_and_wait();
    first.join();
    second.join();
    check(successes == 1 && conflicts == 1 && unexpected == 0, "Competing connections produce exactly one successful revision");
    check(left.find_memory(memory.id)->revision == 2, "Concurrent review increments revision only once");
}

void idempotent_messages(const std::filesystem::path& root) {
    const auto path = root / "message-receipts.sqlite";
    Message accepted;
    Id group_message{};
    {
        Store store(path);
        (void)store.create_bot("Durable requests", "", "receipt-bot");
        (void)store.create_bot("Other scope", "", "other-bot");
        accepted = store.append_message_once("receipt-bot", Mode::Chat, "user", "精确原文 C++ 1.5", "", "user:request-1");
        const auto duplicate = store.append_message_once("receipt-bot", Mode::Chat, "user", "精确原文 C++ 1.5", "", "user:request-1");
        check(duplicate.id == accepted.id && duplicate.created_at_ms == accepted.created_at_ms,
              "Exact message retry returns original row and original timestamp");
        check(store.messages("receipt-bot", Mode::Chat).size() == 1, "Duplicate request appends no history row");
        expect_error(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("receipt-bot", Mode::Chat, "user", "changed", "", "user:request-1");
        }, "Same request key cannot change message text");
        expect_error(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("receipt-bot", Mode::Chat, "bot", "精确原文 C++ 1.5", "", "user:request-1");
        }, "Same request key cannot change source actor");
        for (const auto& request : std::vector<std::string>{"", std::string(1025, 'x'), std::string("bad\0key", 7)}) {
            expect_error(StoreErrorCode::InvalidArgument, [&] {
                (void)store.append_message_once("receipt-bot", Mode::Chat, "user", "invalid key", "", request);
            }, "Invalid receipt key rejects before insertion");
        }
        check(store.append_message_once("other-bot", Mode::Chat, "user", "other bot", "", "user:request-1").id != accepted.id,
              "Request keys are independent across bots");
        check(store.append_message_once("receipt-bot", Mode::Work, "user", "other mode", "", "user:request-1").id != accepted.id,
              "Request keys are independent across modes");
        group_message = store.append_message_once("receipt-bot", Mode::Chat, "user", "group copy", "group", "user:request-1").id;
        check(group_message != accepted.id, "Request keys are independent across exact group scopes");
        (void)store.append_message_once("receipt-bot", Mode::Chat, "bot", "saved answer", "", "reply:run-1");
    }
    {
        // Simulates process restart after the SQLite commit but before an app's
        // separate acknowledgment/harvest flag could have been written.
        Store store(path);
        check(store.append_message_once("receipt-bot", Mode::Chat, "user", "精确原文 C++ 1.5", "", "user:request-1").id == accepted.id,
              "Request receipt survives a new connection");
        const auto answer = store.append_message_once("receipt-bot", Mode::Chat, "bot", "saved answer", "", "reply:run-1");
        check(store.messages("receipt-bot", Mode::Chat).size() == 2 && answer.actor == "bot",
              "Restarted answer harvesting does not duplicate reply history");
        store.remove_bot("receipt-bot");
        check(store.messages("receipt-bot", Mode::Chat).empty(), "Private history is cleared normally with receipts present");
        expect_error(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("receipt-bot", Mode::Chat, "user", "精确原文 C++ 1.5", "", "user:request-1");
        }, "Consumed key cannot resurrect deleted private history");
        expect_error(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("receipt-bot", Mode::Chat, "bot", "saved answer", "", "reply:run-1");
        }, "A stale reply collector cannot restore deleted history");
        check(store.append_message_once("receipt-bot", Mode::Chat, "user", "group copy", "group", "user:request-1").id == group_message,
              "Removing private history preserves group receipt and message");
        (void)store.set_roster("receipt-bot", Mode::Chat, true);
        check(store.append_message_once("receipt-bot", Mode::Chat, "user", "new request", "", "user:request-2").id > accepted.id,
              "An explicitly new request can start fresh after removal");
    }
    Store reopened(path);
    expect_error(StoreErrorCode::Conflict, [&] {
        (void)reopened.append_message_once("receipt-bot", Mode::Chat, "user", "精确原文 C++ 1.5", "", "user:request-1");
    }, "Deleted-message tombstone survives another restart");
}

void concurrent_message_receipts(const std::filesystem::path& root) {
    const auto path = root / "concurrent-message-receipts.sqlite";
    Store left(path);
    (void)left.create_bot("Concurrent messages", "", "concurrent-messages");
    Store right(path);
    std::barrier ready(3);
    Id left_id{}, right_id{};
    std::atomic<int> errors{};
    auto append = [&](Store& store, Id& id) {
        ready.arrive_and_wait();
        try { id = store.append_message_once("concurrent-messages", Mode::Chat, "user", "one durable request", "", "same-key").id; }
        catch (...) { ++errors; }
    };
    std::thread first([&] { append(left, left_id); });
    std::thread second([&] { append(right, right_id); });
    ready.arrive_and_wait(); first.join(); second.join();
    check(errors == 0 && left_id > 0 && left_id == right_id,
          "Independent competing connections converge on one message receipt");
    check(left.messages("concurrent-messages", Mode::Chat).size() == 1,
          "Concurrent retries commit exactly one history row");
}

void schema_one_receipt_migration(const std::filesystem::path& root) {
    const auto path = root / "schema-one-upgrade.sqlite";
    Id prior_message{}, prior_memory{};
    {
        Store store(path);
        (void)store.create_bot("Existing native schema", "retained persona", "schema-upgrade");
        prior_message = store.append_message("schema-upgrade", Mode::Chat, "user", "prior native message").id;
        prior_memory = confirmed(store, "schema-upgrade", "", "prior native memory").id;
    }
    // Produce the actual former schema layout using the OS database engine.
    // This only edits the fixture just created above, never an application DB.
    wchar_t system[32768]{};
    const auto length = GetSystemDirectoryW(system, 32768);
    check(length > 0 && length < 32768, "Locate system SQLite for migration fixture");
    HMODULE module = LoadLibraryW((std::wstring(system, length) + L"\\winsqlite3.dll").c_str());
    check(module != nullptr, "Load system SQLite for migration fixture");
    using Open = int(__cdecl*)(const char*, void**, int, const char*);
    using Execute = int(__cdecl*)(void*, const char*, void*, void*, void*);
    using Close = int(__cdecl*)(void*);
    const auto open = reinterpret_cast<Open>(GetProcAddress(module, "sqlite3_open_v2"));
    const auto execute = reinterpret_cast<Execute>(GetProcAddress(module, "sqlite3_exec"));
    const auto close = reinterpret_cast<Close>(GetProcAddress(module, "sqlite3_close_v2"));
    if (!open || !execute || !close) { FreeLibrary(module); throw std::runtime_error("Missing fixture SQLite API"); }
    const auto encoded = path.u8string();
    void* database = nullptr;
    const int opened = open(reinterpret_cast<const char*>(encoded.c_str()), &database, 2, nullptr);
    std::string downgrade = "BEGIN IMMEDIATE;";
    for (const auto* table : {"bots", "messages", "memories", "message_receipts",
                              "archive_message_sources", "archive_memory_sources", "groups", "application_metadata_bootstrap"})
        for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
            downgrade += "DROP TRIGGER store_revision_" + std::string(table) + "_" + event + ";";
    downgrade += "DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; DROP TABLE archive_mid_memory_sources; DROP TABLE mid_memories; DROP TABLE message_contexts;"
                 "DROP TABLE groups; DROP TABLE application_metadata_bootstrap; DROP INDEX messages_group_page;"
                 "DROP TABLE archive_message_sources; DROP TABLE archive_memory_sources;"
                 "DROP TABLE store_revision; DROP TABLE message_receipts; PRAGMA user_version=1; COMMIT;";
    const int changed = opened == 0 ? execute(database, downgrade.c_str(), nullptr, nullptr, nullptr) : opened;
    if (database) close(database);
    FreeLibrary(module);
    check(opened == 0 && changed == 0, "Create a schema-1 native migration fixture");
    {
        Store upgraded(path);
        check(upgraded.messages("schema-upgrade", Mode::Chat).front().id == prior_message,
              "Schema migration retains prior message IDs and text");
        check(upgraded.find_memory(prior_memory)->state == MemoryState::Confirmed &&
              upgraded.find_bot("schema-upgrade")->persona == "retained persona",
              "Schema migration retains identity and confirmed memory");
        const auto message = upgraded.append_message_once("schema-upgrade", Mode::Chat, "bot", "new receipt", "", "reply:after-upgrade");
        check(upgraded.append_message_once("schema-upgrade", Mode::Chat, "bot", "new receipt", "", "reply:after-upgrade").id == message.id,
              "Schema-1 migration installs working atomic request receipts");
    }
    Store reopened(path);
    check(reopened.messages("schema-upgrade", Mode::Chat).size() == 2,
          "Upgraded native schema reopens without duplicating historical messages");
}

void history_sample(const std::filesystem::path& root) {
    Store store(root / "history-sample.sqlite");
    const auto bot = store.create_bot("History", "", "history").id;
    constexpr int count = 6000;
    Id midpoint{};
    const auto begin = std::chrono::steady_clock::now();
    for (int i = 0; i < count; ++i) {
        const auto message = store.append_message(bot, Mode::Chat, "user", "historical message " + std::to_string(i));
        if (i == count / 2) midpoint = message.id;
    }
    const auto inserted = std::chrono::steady_clock::now();
    constexpr int reads = 100;
    for (int i = 0; i < reads; ++i) {
        const auto page = store.messages(bot, Mode::Chat, "", 20, i % 2 == 0 ? std::optional<Id>{} : midpoint);
        check(page.size() == 20, "History sample returns bounded pages");
    }
    const auto read = std::chrono::steady_clock::now();
    const auto insert_ms = std::chrono::duration<double, std::milli>(inserted - begin).count();
    const auto reads_ms = std::chrono::duration<double, std::milli>(read - inserted).count();
    std::cout << "history_sample rows=" << count << " insert_ms=" << insert_ms
        << " bounded_reads=" << reads << " total_read_ms=" << reads_ms
        << " mean_read_ms=" << reads_ms / reads << '\n';
    std::cout << "Timing is a local sample, not a latency guarantee or a comparison with another framework.\n";
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    try {
        if (argc != 2) throw std::runtime_error("Usage: store_test <temporary-output-root>");
        const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        const auto root = std::filesystem::absolute(argv[1]) / ("store-test-" + std::to_string(stamp));
        std::filesystem::create_directories(root);
        persistence_and_rosters(root);
        pagination(root);
        memory_permissions_scopes_and_revisions(root);
        unicode_and_budget(root);
        concurrent_revision(root);
        idempotent_messages(root);
        concurrent_message_receipts(root);
        schema_one_receipt_migration(root);
        history_sample(root);
        std::cout << "store_test PASS checks=" << checks << '\n';
        const auto encoded = root.u8string();
        std::cout << "Evidence databases: ";
        std::cout.write(reinterpret_cast<const char*>(encoded.data()), static_cast<std::streamsize>(encoded.size()));
        std::cout << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "store_test FAIL after " << checks << " checks: " << error.what() << '\n';
        return 1;
    }
}
