#include "dimension/character_tools.hpp"
#include <chrono>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
namespace {
using namespace dimension; namespace fs = std::filesystem; using O = Json::Object; using A = Json::Array;
std::atomic_size_t checks{};
void check(bool v, const char* expr, int line) { ++checks; if (!v) throw std::runtime_error(std::to_string(line) + ": " + expr); }
#define CHECK(v) check(static_cast<bool>(v), #v, __LINE__)
template<class F> void fails(F action) { ++checks; try { action(); } catch (const std::exception&) { return; } throw std::runtime_error("Expected rejection"); }
std::string s(const Json& j, const char* key) { return j.at(key).as_string(); }
Json catalog(std::string source = "synthetic-source") {
    A entries;
    for (int i = 0; i < 57; ++i) entries.emplace_back(O{{"id", "stable-" + std::to_string(i)}, {"name", "角色 " + std::to_string(i)},
        {"persona", "用户声明的原始人设 " + std::to_string(i)}, {"series", "Synthetic Series"}});
    return O{{"format", "dimension-character-directory"}, {"version", 1},
        {"source", O{{"id", source}, {"name", "自制测试目录"}, {"url", "https://example.test/catalog.json"}, {"license", "Synthetic original fixture"}}},
        {"entries", entries}};
}
void directory(const fs::path& root) {
    Store store(root / "directory.db"); (void)store.create_bot("Existing", "preserve", "existing");
    std::string imported_id, revision;
    {
        CharacterDirectory library(store, root / "directory");
        auto first = library.search(""); CHECK(first.at("results").as_array().empty());
        const auto input = catalog(); library.replace_snapshot(input, s(first, "directoryRevision"));
        auto page = library.search("synthetic", 0, 40); revision = s(page, "directoryRevision");
        CHECK(page.at("results").as_array().size() == 40 && page.at("hasMore").as_bool());
        auto second = library.search("synthetic", 40, 40, revision); CHECK(second.at("results").as_array().size() == 17);
        CHECK(!second.at("hasMore").as_bool()); CHECK(library.search("not present").at("total").as_number() == 0);
        fails([&] { (void)library.search("", 40); });
        const auto item = page.at("results").as_array().front();
        const auto bot = library.import_entry(s(item, "sourceId"), s(item, "entryId"), s(item, "revision")); imported_id = bot.id;
        CHECK(bot.name == s(item, "name") && !bot.in_chat && !bot.in_work);
        CHECK(library.provenance(bot.id).at("source").at("name").as_string() == "自制测试目录");
        CHECK(!library.provenance(bot.id).find("persona"));
        CHECK(library.import_entry(s(item, "sourceId"), s(item, "entryId"), s(item, "revision")).id == bot.id);
        (void)store.update_bot_profile(bot.id, {}, "用户编辑后的人设");
        CHECK(library.import_entry(s(item, "sourceId"), s(item, "entryId"), s(item, "revision")).persona == "用户编辑后的人设");
        auto changed = input.as_object(); auto entries = changed.at("entries").as_array();
        auto row = entries.front().as_object(); row["name"] = "目录已变化"; entries.front() = row; changed["entries"] = entries;
        library.replace_snapshot(changed, revision);
        fails([&] { (void)library.import_entry(s(item, "sourceId"), s(item, "entryId"), s(item, "revision")); });
        fails([&] { (void)library.search("", 40, 40, revision); });
        fails([&] { (void)library.replace_snapshot(input, revision); });
        auto fresh = library.search("目录已变化").at("results").as_array().front();
        CHECK(library.import_entry(s(fresh, "sourceId"), s(fresh, "entryId"), s(fresh, "revision")).id == bot.id);
        CHECK(store.find_bot("existing")->persona == "preserve");
        auto bad = input.as_object(); bad["unknown"] = true;
        fails([&] { (void)library.replace_snapshot(bad, s(library.search(""), "directoryRevision")); });
        bad = input.as_object(); auto duplicate = bad.at("entries").as_array(); duplicate.push_back(duplicate.front()); bad["entries"] = duplicate;
        fails([&] { (void)library.replace_snapshot(bad, s(library.search(""), "directoryRevision")); });
        CHECK(library.search("").at("total").as_number() == 57);
    }
    { CharacterDirectory reopened(store, root / "directory");
      auto item = reopened.search("目录已变化").at("results").as_array().front();
      CHECK(reopened.import_entry(s(item, "sourceId"), s(item, "entryId"), s(item, "revision")).id == imported_id);
      CHECK(store.list_bots().size() == 2 && store.find_bot(imported_id)->persona == "用户编辑后的人设"); }
    fs::create_directories(root / "corrupt");
    { std::ofstream file(root / "corrupt" / "directory.json"); file << "broken"; }
    fails([&] { CharacterDirectory damaged(store, root / "corrupt"); });
}
Json settled(PersonaDrafts& drafts, const std::string& bot, const Json& initial) {
    for (int i = 0; i < 300; ++i) {
        auto row = drafts.get(bot, s(initial, "draftId"));
        if (s(row, "status") != "running" && s(row, "status") != "cancelling") return row;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("Draft did not settle");
}
void drafts(const fs::path& root) {
    Store store(root / "profiles.db");
    for (const auto* id : {"alpha", "beta", "gamma", "delta", "epsilon"}) (void)store.create_bot(id, "original", id);
    auto profile = store.read_bot_profile("alpha"); auto other = store.read_bot_profile("beta");
    CHECK(profile.revision != other.revision);
    fails([&] { (void)store.save_bot_profile("beta", profile.revision, "wrong target"); });
    auto saved = store.save_bot_profile("alpha", profile.revision, "manual");
    CHECK(saved.revision != profile.revision);
    CHECK(store.save_bot_profile("alpha", saved.revision, "manual").revision == saved.revision);
    fails([&] { (void)store.save_bot_profile("alpha", profile.revision, "stale"); });
    PersonaDrafts service(store, [](const auto& config, const auto& messages, auto chunk, auto stop) {
        CHECK(config.max_output_tokens <= 2048 && config.timeout_ms == 45000);
        const auto& text = messages.back().content;
        if (text.find("hold") != std::string::npos) {
            while (!stop.stop_requested()) std::this_thread::sleep_for(std::chrono::milliseconds(2));
            throw std::runtime_error("cancelled fixture");
        }
        if (text.find("fail") != std::string::npos) throw std::runtime_error("synthetic secret must not surface");
        if (text.find("oversized") != std::string::npos) return ModelReply{std::string(16385, 'x')};
        chunk("text", "生成的可编辑人设");
        return ModelReply{"生成的可编辑人设"};
    });
    ModelConfig model; model.model = "explicit-model";
    auto job = service.start("alpha", "brief", model, saved.revision); job = settled(service, "alpha", job);
    CHECK(s(job, "status") == "ready" && s(job, "persona") == "生成的可编辑人设");
    CHECK(store.find_bot("alpha")->persona == "manual");
    fails([&] { (void)service.get("beta", s(job, "draftId")); });
    auto applied = service.apply("alpha", s(job, "draftId"), s(job, "baseRevision"), "用户编辑后的草稿");
    CHECK(applied.bot.persona == "用户编辑后的草稿" && s(service.get("alpha", s(job, "draftId")), "status") == "saved");
    auto conflict = settled(service, "alpha", service.start("alpha", "brief", model, applied.revision));
    (void)store.update_bot_profile("alpha", {}, "另一个窗口编辑");
    fails([&] { (void)service.apply("alpha", s(conflict, "draftId"), s(conflict, "baseRevision"), "must not overwrite"); });
    CHECK(store.find_bot("alpha")->persona == "另一个窗口编辑" && s(service.get("alpha", s(conflict, "draftId")), "status") == "ready");
    for (const auto* brief : {"fail", "oversized"}) {
        auto failed = settled(service, "alpha", service.start("alpha", brief, model, store.read_bot_profile("alpha").revision));
        CHECK(s(failed, "status") == "failed" && s(failed, "persona").empty());
        CHECK(s(failed, "error").find("secret") == std::string::npos);
    }
    auto pending = service.start("alpha", "hold", model, store.read_bot_profile("alpha").revision);
    fails([&] { (void)service.start("alpha", "brief", model, store.read_bot_profile("alpha").revision); });
    (void)service.cancel("alpha", s(pending, "draftId"));
    CHECK(s(settled(service, "alpha", pending), "status") == "cancelled");
    CHECK(store.find_bot("alpha")->persona == "另一个窗口编辑");
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass isolated output path");
        const auto root = fs::path(argv[1]) / ("characters-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); directory(root); drafts(root);
        std::cout << "character_tools: " << checks.load() << " checks passed\n"; return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
