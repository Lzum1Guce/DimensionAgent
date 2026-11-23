#include "dimension/archive_export.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action) {
    ++checks; try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Expected rejected archive");
}
void seed(Store& store) { (void)store.create_bot("Alpha", "Synthetic persona", "alpha"); }
StoreImportOptions policy(const std::string& source) {
    return {source, StoreBotConflict::PreserveExisting, StoreMemoryConflict::PreserveExisting, StoreGroupConflict::PreserveExisting};
}
StoreImportResult commit(Store& store, const ArchiveDocument& archive, const StoreImportOptions& options) {
    const auto plan = store.prepare_archive_import(archive, options); CHECK(plan.can_commit);
    return store.commit_archive_import(archive, options, plan.target_revision, plan.digest);
}
void roundtrip(const fs::path& root) {
    Store source(root / "source.sqlite"); seed(source);
    const auto expired = source.add_mid_memory("alpha", "", "Expired text remains archived", 1, 1000);
    const auto second = source.add_mid_memory("alpha", "", "Explicitly reinforced text", 7, 2000);
    const auto reinforced = source.reinforce_mid_memory("alpha", "", second.id, second.revision, 3, 3000);
    const auto package = parse_archive_package(export_archive_package(source).dump());
    CHECK(package.archive.version() == 3 && package.archive.mid_memories().size() == 2);
    CHECK(package.archive.memories().empty());
    CHECK(package.archive.mid_memories()[0].expires_at_ms == expired.expires_at_ms);
    CHECK(package.archive.mid_memories()[1].strength == reinforced.strength);
    CHECK(encode_archive(parse_archive(encode_archive(package.archive))) == encode_archive(package.archive));
    const auto settings = policy(package.source_id);
    Store target(root / "target.sqlite");
    const auto result = commit(target, package.archive, settings);
    CHECK(result.archive_version == 3 && result.counts.mid_memories_created == 2);
    auto rows = target.list_mid_memories("alpha"); CHECK(rows.size() == 2);
    for (const auto& row : rows) {
        const auto original = row.text == expired.text ? expired : reinforced;
        CHECK(row.created_at_ms == original.created_at_ms && row.updated_at_ms == original.updated_at_ms);
        CHECK(row.expires_at_ms == original.expires_at_ms && row.revision == original.revision && row.strength == original.strength);
    }
    CHECK(target.recall_mid_memory_excerpts("alpha", "", "archived", 3, 600, 999999999999LL).empty());
    CHECK(commit(target, package.archive, settings).counts.mid_memories_reused == 2);
    const auto deleted = rows.front();
    target.apply_mid_memory_changes("alpha", "", {{deleted.id, deleted.revision, std::nullopt}}, 999999999999LL);
    const auto tombstone = commit(target, package.archive, settings);
    CHECK(tombstone.counts.mid_memories_tombstoned == 1 && tombstone.counts.mid_memories_reused == 1);
    CHECK(target.list_mid_memories("alpha").size() == 1);
    auto changed = Json::parse(encode_archive(package.archive)).as_object();
    auto mid = changed.at("midMemories").as_array(); auto altered = mid.front().as_object();
    altered["expiresAtMs"] = std::to_string(expired.expires_at_ms + 1); mid[0] = altered; changed["midMemories"] = mid;
    CHECK(!target.prepare_archive_import(parse_archive(Json(changed).dump()), settings).can_commit);
    Store conflict(root / "conflict.sqlite"); seed(conflict);
    const auto existing = conflict.add_mid_memory("alpha", "", expired.text, 2, 5000);
    auto strict = settings; strict.memory_conflict = StoreMemoryConflict::Reject;
    CHECK(!conflict.prepare_archive_import(package.archive, strict).can_commit);
    CHECK(commit(conflict, package.archive, settings).counts.mid_memories_preserved == 1);
    for (const auto& row : conflict.list_mid_memories("alpha")) if (row.text == existing.text)
        CHECK(row.expires_at_ms == existing.expires_at_ms && row.created_at_ms == existing.created_at_ms);
    CHECK(preflight_archive(package.archive, conflict).at("counts").at("midMemories").at("conflicts").as_number() == 1);
    auto legacy = Json::parse(encode_archive(package.archive)).as_object(); legacy["version"] = 2;
    rejected([&] { (void)parse_archive(Json(legacy).dump()); });
    auto bad = changed; mid = bad.at("midMemories").as_array(); altered = mid.front().as_object();
    altered["expiresAtMs"] = "0"; mid[0] = altered; bad["midMemories"] = mid;
    rejected([&] { (void)parse_archive(Json(bad).dump()); });
    auto oversized = Json::parse(encode_archive(package.archive)).as_object(); A batch;
    for (int i = 0; i < 201; ++i) {
        auto row = oversized.at("midMemories").as_array().front().as_object();
        row["id"] = std::to_string(i + 1); row["text"] = "Synthetic note " + std::to_string(i); batch.emplace_back(row);
    }
    oversized["midMemories"] = batch;
    rejected([&] { (void)parse_archive(Json(oversized).dump()); });
    StoreArchiveSnapshotLimits limited; limited.max_mid_memories = 1;
    rejected([&] { (void)source.archive_snapshot(limited); });
    CHECK(source.archive_snapshot().mid_memories.size() == 2);
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("archive-mid-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); roundtrip(root);
        std::cout << "archive_mid: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
