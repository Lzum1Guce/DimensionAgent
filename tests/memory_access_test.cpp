#include "dimension/relation_notes.hpp"
#include "dimension/store.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <set>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(StoreErrorCode expected, F action) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) { if (error.code() == expected) return; throw; }
    throw std::runtime_error("Expected Store error");
}
Memory memory(Store& store, std::string text, MemoryState state = MemoryState::Confirmed,
              const std::string& bot = "alpha", const std::string& scope = "") {
    auto value = store.propose_memory(bot, scope, text, "user");
    return state == MemoryState::Candidate ? value : store.review_memory(value.id, value.revision, state);
}
std::size_t count(std::string_view value) {
    return static_cast<std::size_t>(std::count_if(value.begin(), value.end(), [](unsigned char c) { return (c & 0xc0U) != 0x80U; }));
}
void bots(Store& store) {
    (void)store.create_bot("Alpha", "", "alpha"); (void)store.create_bot("Beta", "", "beta");
    Group group; group.id = "team:1"; group.name = "Group"; group.owner_id = "alpha";
    group.members = {"alpha", "beta"}; group.history_members = group.members;
    group.in_chat = group.in_work = true; group.seal_shape = "circle"; group.seal_color = "violet";
    (void)store.create_group(group);
}

void visible_pages(const fs::path& path) {
    Store store(path); bots(store);
    std::vector<Memory> expected;
    for (int i = 0; i < 141; ++i)
        expected.push_back(memory(store, "visible-" + std::to_string(i), i % 2 ? MemoryState::Candidate : MemoryState::Confirmed));
    for (int i = 0; i < 167; ++i) (void)memory(store, "rejected-" + std::to_string(i), MemoryState::Rejected);
    auto relations = store.read_relation_notes("alpha");
    for (auto& [key, value] : relations.values) value = "Visible only in relation form " + key;
    (void)store.save_relation_notes("alpha", relations.values, relations.revision);
    (void)memory(store, "Other Bot memory", MemoryState::Confirmed, "beta");
    (void)memory(store, "Exact group memory", MemoryState::Confirmed, "alpha", "team:1");
    const auto first = store.visible_memories("alpha", "", 37);
    CHECK(first.size() == 37 && first.front().id == expected.back().id);
    const auto added = memory(store, "New insertion during pagination");
    std::vector<Memory> found = first;
    auto cursor = first.back().id;
    for (;;) {
        const auto page = store.visible_memories("alpha", "", 37, cursor);
        if (page.empty()) break;
        for (const auto& row : page) CHECK(row.id < cursor);
        cursor = page.back().id; found.insert(found.end(), page.begin(), page.end());
    }
    std::set<Id> actual;
    for (const auto& row : found) {
        CHECK(row.state != MemoryState::Rejected && !is_relation_note_text(row.text));
        CHECK(row.bot_id == "alpha" && row.group_id.empty()); CHECK(actual.insert(row.id).second);
    }
    CHECK(found.size() == expected.size());
    for (const auto& row : expected) CHECK(actual.contains(row.id));
    CHECK(!actual.contains(added.id));
    CHECK(store.visible_memories("alpha", "team:1", 100).size() == 1);
    CHECK(store.visible_memories("beta", "", 100).size() == 1);
    CHECK(store.visible_memories("alpha", "", 1).front().id == added.id);
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.visible_memories("alpha", "", 0); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.visible_memories("alpha", "", 10, -1); });

    // Edit two explicit old rows, neither present on the current first page.
    const auto untouched = expected[4];
    const auto notes = store.read_relation_notes("alpha").revision;
    store.apply_memory_changes("alpha", "", {{expected[0].id, expected[0].revision, "Changed old record"},
                                               {expected[2].id, expected[2].revision, std::nullopt}});
    CHECK(!store.find_memory(expected[2].id));
    const auto changed = *store.find_memory(expected[0].id);
    CHECK(changed.text == "Changed old record" && changed.state == MemoryState::Candidate);
    CHECK(changed.revision == expected[0].revision + 1);
    CHECK(store.find_memory(untouched.id)->text == untouched.text);
    CHECK(store.find_memory(untouched.id)->revision == untouched.revision);
    CHECK(store.read_relation_notes("alpha").revision == notes);
    rejected(StoreErrorCode::Conflict, [&] {
        store.apply_memory_changes("alpha", "", {{untouched.id, untouched.revision, "must roll back"},
                                                   {changed.id, expected[0].revision, "stale"}});
    });
    CHECK(store.find_memory(untouched.id)->text == untouched.text);
    CHECK(store.find_memory(changed.id)->text == changed.text);
    store.apply_memory_changes("alpha", "", {});
    CHECK(store.find_memory(untouched.id)->text == untouched.text);
    rejected(StoreErrorCode::NotFound, [&] {
        store.apply_memory_changes("beta", "", {{untouched.id, untouched.revision, "wrong scope"}});
    });
    CHECK(store.find_memory(untouched.id)->text == untouched.text);
}

void excerpts(const fs::path& path) {
    Store store(path); bots(store);
    std::string long_text;
    for (int i = 0; i < 2100; ++i) long_text += "雪";
    long_text += "\nThe secretneedle location is a quiet tea room 🙂.\n";
    for (int i = 0; i < 1800; ++i) long_text += "海";
    const auto old = memory(store, long_text);
    const auto chinese = memory(store, "我喜欢绿茶，不喜欢太甜的饮料。");
    for (int i = 0; i < 25; ++i) (void)memory(store, "Unrelated recent fact " + std::to_string(i));
    (void)memory(store, "secretneedle candidate", MemoryState::Candidate);
    (void)memory(store, "secretneedle rejected", MemoryState::Rejected);
    (void)memory(store, "secretneedle other Bot", MemoryState::Confirmed, "beta");
    const auto grouped = memory(store, "secretneedle group only", MemoryState::Confirmed, "alpha", "team:1");
    const auto before = store.archive_snapshot().revision;
    auto recalled = store.recall_memory_excerpts("alpha", "", "Where is secretneedle?");
    CHECK(recalled.size() == 1 && recalled[0].id == old.id);
    CHECK(recalled[0].revision == old.revision && recalled[0].offset_codepoints > 1600);
    CHECK(recalled[0].text.find("secretneedle") != std::string::npos);
    CHECK(recalled[0].total_codepoints == count(long_text));
    CHECK(recalled[0].truncated && count(recalled[0].text) <= 512);
    CHECK(long_text.find(recalled[0].text) != std::string::npos);
    CHECK(store.find_memory(old.id)->text == long_text);
    CHECK(store.archive_snapshot().revision == before);
    recalled = store.recall_memory_excerpts("alpha", "", "secretneedle", 20, 43);
    CHECK(recalled.size() == 1 && count(recalled[0].text) == 43);
    CHECK(recalled[0].text.find("secretneedle") != std::string::npos);
    recalled = store.recall_memory_excerpts("alpha", "team:1", "secretneedle");
    CHECK(recalled.size() == 1 && recalled[0].id == grouped.id && !recalled[0].truncated);
    recalled = store.recall_memory_excerpts("alpha", "", "你记得我喜欢什么饮料吗？");
    CHECK(std::any_of(recalled.begin(), recalled.end(), [&](const auto& row) { return row.id == chinese.id; }));
    CHECK(store.recall_memory_excerpts("alpha", "", "secretneedle", 0, 1600).empty());
    CHECK(store.recall_memory_excerpts("alpha", "", "secretneedle", 5, 0).empty());
    recalled = store.recall_memory_excerpts("alpha", "", "", 99, 9999);
    CHECK(recalled.empty());
    auto notes = store.read_relation_notes("alpha"); notes.values["contacts"] = "Memorynote contact anchor";
    (void)store.save_relation_notes("alpha", notes.values, notes.revision);
    recalled = store.recall_memory_excerpts("alpha", "", "Memorynote");
    CHECK(recalled.size() == 1 && recalled[0].relation_key == "contacts");
    CHECK(recalled[0].text == "Memorynote contact anchor" && recalled[0].offset_codepoints == 0);
    CHECK(recalled[0].total_codepoints == count(recalled[0].text));
    CHECK(store.recall_memory_excerpts("alpha", "team:1", "Memorynote").empty());
}


void time_and_stop_terms(const fs::path& path) {
    Store store(path); bots(store);
    const auto earliest = memory(store, "【旧版笔记：daily.md】二〇二六年十月二十六日，第一次见面约定只记大事。");
    const auto middle = memory(store, "中间一条：喜欢摄影。");
    std::vector<Memory> recent;
    for (int i = 0; i < 12; ++i)
        recent.push_back(memory(store, "最近闲聊什么都记下了 " + std::to_string(i)));
    const auto rejected = memory(store, "最早的一次秘密不该出现", MemoryState::Rejected);
    const auto candidate = memory(store, "最早的一次还在候选", MemoryState::Candidate);

    auto recalled = store.recall_memory_excerpts("alpha", "", "你最早记得什么", 5, 1600);
    CHECK(recalled.size() == 3);
    CHECK(recalled[0].id == earliest.id && recalled[1].id == middle.id && recalled[2].id == recent[0].id);
    CHECK(std::none_of(recalled.begin(), recalled.end(), [&](const auto& row) {
        return row.id == rejected.id || row.id == candidate.id;
    }));

    const auto drink = memory(store, "我喜欢绿茶，不喜欢太甜的饮料。");
    recalled = store.recall_memory_excerpts("alpha", "", "你记得我喜欢什么饮料吗？");
    CHECK(std::any_of(recalled.begin(), recalled.end(), [&](const auto& row) { return row.id == drink.id; }));
    recalled = store.recall_memory_excerpts("alpha", "", "你记得绿茶吗", 5, 1600);
    CHECK(std::any_of(recalled.begin(), recalled.end(), [&](const auto& row) { return row.id == drink.id; }));

    const auto remembered = memory(store, "我还记得那天的约定。");
    recalled = store.recall_memory_excerpts("alpha", "", "你还记得吗", 5, 1600);
    CHECK(std::any_of(recalled.begin(), recalled.end(), [&](const auto& row) { return row.id == remembered.id; }));

    const auto memory_word = memory(store, "这段只谈记忆两个字，不该挡住时间回退。");
    recalled = store.recall_memory_excerpts("alpha", "", "最早的记忆是什么", 5, 1600);
    CHECK(recalled.size() == 3);
    CHECK(recalled[0].id == earliest.id && recalled[1].id == middle.id && recalled[2].id == recent[0].id);
    CHECK(std::none_of(recalled.begin(), recalled.end(), [&](const auto& row) { return row.id == memory_word.id; }));
    recalled = store.recall_memory_excerpts("alpha", "", "以前想起什么", 5, 1600);
    CHECK(recalled.size() == 3 && recalled[0].id == earliest.id);

    recalled = store.recall_memory_excerpts("alpha", "", "什么呢", 5, 1600);
    CHECK(recalled.empty());
    recalled = store.recall_memory_excerpts("alpha", "", "", 5, 1600);
    CHECK(recalled.empty());
}

void latest_speakers(const fs::path& path) {
    Store store(path); bots(store);
    (void)store.append_message("alpha", Mode::Chat, "bot", "Alpha earlier", "team:1");
    const auto beta = store.append_message("beta", Mode::Chat, "bot", "Beta latest", "team:1");
    const auto alpha = store.append_message("alpha", Mode::Chat, "bot", "Alpha latest", "team:1");
    for (int i = 0; i < 120; ++i) (void)store.append_message("alpha", Mode::Chat, "user", "New user", "team:1");
    (void)store.append_message("alpha", Mode::Work, "bot", "Different mode", "team:1");
    (void)store.append_message("alpha", Mode::Chat, "bot", "Private latest");
    const auto latest = store.latest_group_bot_messages("team:1");
    CHECK(latest.size() == 2);
    CHECK(latest[0].id == alpha.id && latest[1].id == beta.id);
    CHECK(store.latest_group_bot_messages("team:1", Mode::Work).size() == 1);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("memory-access-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        visible_pages(root / "pages.db"); excerpts(root / "excerpts.db"); time_and_stop_terms(root / "time-cue.db"); latest_speakers(root / "speakers.db");
        std::cout << "memory_access: " << checks << " checks passed (synthetic pagination, excerpts and exact scopes)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
