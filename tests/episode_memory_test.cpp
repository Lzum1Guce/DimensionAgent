#include "dimension/archive_export.hpp"
#include "dimension/store.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
std::size_t checks{};
void check(bool good, const char* expression, int line) {
    ++checks; if (!good) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action) {
    ++checks; try { action(); } catch (const StoreError&) { return; }
    throw std::runtime_error("Expected rejected episode operation");
}
void episodes(const fs::path& root) {
    const auto file = root / "identities.sqlite";
    auto store = std::make_unique<Store>(file);
    (void)store->create_bot("Alpha", "Synthetic", "alpha");
    (void)store->create_bot("Beta", "Synthetic", "beta");
    const auto source = store->append_message("alpha", Mode::Chat, "user", "Synthetic source event");
    const auto source_ref = "message:" + std::to_string(source.id);
    auto episode = store->propose_episode("alpha", "", "We fixed the same synthetic issue", 1700000000000,
        source_ref, "User、Alpha", "Use the verified fix", "Synthetic verification passed");
    CHECK(episode.id > 0 && episode.kind == "episode" && episode.state == MemoryState::Candidate);
    CHECK(store->recall_episodes("alpha", "", "synthetic").empty());
    const auto reviewed = store->review_memory(episode.id, episode.revision, MemoryState::Confirmed);
    CHECK(reviewed.state == MemoryState::Confirmed && reviewed.revision == episode.revision + 1);
    auto recalled = store->recall_episodes("alpha", "", "synthetic");
    CHECK(recalled.size() == 1 && recalled.front().source_ref == source_ref && recalled.front().participants == "User、Alpha");
    CHECK(store->recall_episodes("alpha", "", "TEST_PREFIX:episode_recall\nshared synthetic").size() == 1);
    CHECK(store->recall_episodes("alpha", "", "%").empty());
    CHECK(recalled.front().user_choice == "Use the verified fix" && recalled.front().outcome == "Synthetic verification passed");
    CHECK(store->recall_episodes("beta", "", "synthetic").empty());
    const auto duplicate = store->propose_episode("alpha", "", "We fixed the same synthetic issue", 1700000000000,
        source_ref, "User、Alpha", "Use the verified fix", "Synthetic verification passed");
    CHECK(duplicate.id == episode.id && store->list_memories("alpha").size() == 1);
    rejected([&] { (void)store->propose_episode("alpha", "", "We fixed the same synthetic issue", 1700000000000,
        "message:999999", "User、Alpha", "Use the verified fix", "Synthetic verification passed"); });
    rejected([&] { (void)store->propose_episode("alpha", "", "Missing time", 0, source_ref, "User", "Choice", "Outcome"); });
    store->delete_memory(episode.id, reviewed.revision);
    CHECK(store->recall_episodes("alpha", "", "synthetic").empty());

    auto second = store->propose_episode("alpha", "", "Archived synthetic collaboration", 1700000001000,
        source_ref, "User、Alpha", "Keep the event", "Archived with provenance");
    (void)store->review_memory(second.id, second.revision, MemoryState::Confirmed);
    (void)store->propose_memory("alpha", "", "Ordinary long-term fact", "user");
    const auto package = export_archive_package(*store);
    const auto restored = parse_archive_package(package.dump());
    CHECK(!restored.archive.memories().empty());
    bool found_episode = false, found_fact = false;
    for (const auto& memory : restored.archive.memories()) {
        if (memory.kind == "episode") {
            found_episode = memory.source_ref == source_ref && memory.participants == "User、Alpha" &&
                memory.user_choice == "Keep the event" && memory.outcome == "Archived with provenance" && memory.event_time_ms == 1700000001000;
        }
        if (memory.kind == "fact" && memory.text == "Ordinary long-term fact") found_fact = true;
    }
    CHECK(found_episode && found_fact);
    store.reset();
    store = std::make_unique<Store>(file);
    CHECK(store->recall_episodes("alpha", "", "Archived").size() == 1);
    CHECK(store->recall_episodes("alpha", "", "Ordinary").empty());
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("episode-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); episodes(root);
        std::cout << "episode_memory: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
