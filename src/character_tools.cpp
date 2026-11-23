#define NOMINMAX
#include "dimension/character_tools.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/message_context.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <thread>

namespace dimension {
namespace {
using O = Json::Object; using A = Json::Array;
constexpr std::size_t persona_limit = 16384, state_limit = 32U * 1024U * 1024U;
[[noreturn]] void fail(int status, const char* text) { throw CharacterToolError(status, text); }
void fields(const Json& v, std::initializer_list<std::string_view> required,
            std::initializer_list<std::string_view> optional = {}) {
    if (!v.is_object()) fail(400, "目录字段需要对象");
    for (auto key : required) if (!v.find(key)) fail(400, "目录缺少必要字段");
    for (const auto& [key, ignored] : v.as_object()) {
        (void)ignored;
        if (std::find(required.begin(), required.end(), key) == required.end() &&
            std::find(optional.begin(), optional.end(), key) == optional.end()) fail(400, "目录包含未知字段");
    }
}
std::string bounded(std::string_view v, std::size_t maximum, bool empty = false) {
    if (v.size() > maximum || (!empty && v.empty()) || v.find('\0') != v.npos) fail(400, "角色文本为空、过长或包含无效字符");
    // JSON's parser validates UTF-8, including programmatic Store callers.
    try { (void)Json::parse(Json(std::string(v)).dump(), maximum * 6 + 32); }
    catch (...) { fail(400, "角色文本编码无效"); }
    if (!empty && std::all_of(v.begin(), v.end(), [](unsigned char c) { return c <= 32; })) fail(400, "角色文本不能为空白");
    return std::string(v);
}
std::string text(const Json& v, std::string_view key, std::size_t maximum, bool empty = false) {
    const auto* p = v.find(key); if (!p || !p->is_string()) fail(400, "角色字段必须为文本");
    return bounded(p->as_string(), maximum, empty);
}
std::string opaque_id() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        fail(500, "无法创建角色请求编号");
    const char hex[] = "0123456789abcdef"; std::string result;
    for (auto byte : bytes) { result += hex[byte >> 4]; result += hex[byte & 15]; } return result;
}
std::string lower(std::string value) {
    for (auto& c : value) if (static_cast<unsigned char>(c) < 128) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return value;
}
Json catalog_document(const Json& catalog) {
    fields(catalog, {"format", "version", "source", "entries"});
    if (text(catalog, "format", 80) != "dimension-character-directory" || !catalog.at("version").is_number() ||
        catalog.at("version").as_number() != 1) fail(400, "不支持的角色目录格式或版本");
    const auto& source = catalog.at("source"); fields(source, {"id", "name", "url", "license"});
    const auto id = text(source, "id", 160), name = text(source, "name", 256), url = text(source, "url", 2048, true),
               license = text(source, "license", 512);
    if (!url.empty() && !url.starts_with("https://") && !url.starts_with("http://")) fail(400, "目录来源网址须为HTTP或HTTPS");
    if (!catalog.at("entries").is_array() || catalog.at("entries").as_array().size() > 2048) fail(400, "每份目录最多2048个角色");
    std::map<std::string, Json> entries;
    for (const auto& item : catalog.at("entries").as_array()) {
        fields(item, {"id", "name", "persona"}, {"series"});
        const auto key = text(item, "id", 160);
        O row{{"id", key}, {"name", text(item, "name", 256)}, {"persona", text(item, "persona", persona_limit)},
              {"series", item.find("series") ? text(item, "series", 256, true) : ""}};
        if (!entries.emplace(key, std::move(row)).second) fail(400, "目录包含重复角色ID");
    }
    A rows; for (auto& [key, entry] : entries) { (void)key; rows.push_back(std::move(entry)); }
    Json result = O{{"format", "dimension-character-directory"}, {"version", 1},
        {"source", O{{"id", id}, {"name", name}, {"url", url}, {"license", license}}}, {"entries", std::move(rows)}};
    if (result.dump().size() > 2U * 1024U * 1024U) fail(413, "单份目录快照最多2MiB");
    return result;
}
std::string entry_revision(const Json& source, const Json& row) {
    return source_data_digest(Json(A{"dimension-directory-entry-v1", source, row}).dump());
}
std::string read_state(const std::filesystem::path& file) {
    for (auto part = file; !part.empty(); part = part.parent_path()) {
        const auto attr = GetFileAttributesW(part.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_REPARSE_POINT)) fail(500, "目录存储路径不允许链接");
        if (part == part.parent_path()) break;
    }
    HANDLE handle = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        if (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND) return {};
        fail(500, "无法读取角色目录存储");
    }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info) || info.nNumberOfLinks != 1 || info.nFileSizeHigh ||
        !info.nFileSizeLow || info.nFileSizeLow > state_limit || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
        CloseHandle(handle); fail(500, "角色目录存储不安全或过大");
    }
    std::string data(info.nFileSizeLow, '\0'); DWORD read{};
    const bool ok = ReadFile(handle, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) && read == data.size();
    CloseHandle(handle); if (!ok) fail(500, "角色目录存储读取不完整"); return data;
}
} // namespace

struct CharacterDirectory::Impl {
    Store& store; std::filesystem::path file; mutable std::mutex mutex;
    O sources, imports;
    Impl(Store& store, std::filesystem::path directory) : store(store), file(std::filesystem::absolute(directory) / L"directory.json") {
        const auto saved = read_state(file); if (saved.empty()) return;
        try {
            const auto state = Json::parse(saved, state_limit); fields(state, {"version", "sources", "imports"});
            if (!state.at("version").is_number() || state.at("version").as_number() != 1 ||
                !state.at("sources").is_object() || !state.at("imports").is_object()) fail(500, "角色目录存储格式无效");
            for (const auto& [id, value] : state.at("sources").as_object()) {
                auto catalog = catalog_document(value);
                if (catalog.at("source").at("id").as_string() != id) fail(500, "角色目录来源身份损坏");
                sources.emplace(id, std::move(catalog));
            }
            imports = state.at("imports").as_object();
            if (sources.size() > 16 || imports.size() > 1024) fail(500, "角色目录存储超过上限");
            for (const auto& [key, value] : imports) {
                fields(value, {"sourceId", "entryId", "botId", "entryRevision", "source", "name", "persona"});
                const auto sid = text(value, "sourceId", 160), eid = text(value, "entryId", 160);
                if (key != source_data_digest(Json(A{sid, eid}).dump())) fail(500, "角色来源映射损坏");
                (void)text(value, "botId", 160); (void)text(value, "entryRevision", 64);
                (void)text(value, "name", 256); (void)text(value, "persona", persona_limit);
                (void)catalog_document(O{{"format", "dimension-character-directory"}, {"version", 1}, {"source", value.at("source")}, {"entries", A{}}});
            }
        } catch (...) { fail(500, "角色目录存储损坏，请先核对原文件"); }
    }
    std::string revision() const { return source_data_digest(Json(sources).dump()); }
    void persist(const O& next_sources, const O& next_imports) {
        const auto bytes = Json(O{{"version", 1}, {"sources", next_sources}, {"imports", next_imports}}).dump();
        if (bytes.size() > state_limit) fail(413, "角色目录存储已达上限");
        atomic_write_file(file, bytes);
    }
};
CharacterDirectory::CharacterDirectory(Store& store, std::filesystem::path path) : impl_(std::make_unique<Impl>(store, std::move(path))) {}
CharacterDirectory::~CharacterDirectory() = default;
Json CharacterDirectory::search(std::string_view query, std::size_t offset, std::size_t limit, std::string_view revision) const {
    const auto needle = lower(bounded(query, 256, true));
    if (!limit || limit > 100 || offset > 8192) fail(400, "目录分页范围无效");
    std::lock_guard lock(impl_->mutex); const auto current = impl_->revision();
    if ((offset && revision.empty()) || (!revision.empty() && revision != current)) fail(409, "目录已更新，请重新搜索");
    A matches, sources;
    for (const auto& [id, catalog] : impl_->sources) {
        const auto source = catalog.at("source");
        sources.push_back(O{{"source", source}, {"count", static_cast<int>(catalog.at("entries").as_array().size())}});
        for (const auto& entry : catalog.at("entries").as_array()) {
            if (!needle.empty() && lower(entry.at("name").as_string() + " " + entry.at("series").as_string()).find(needle) == std::string::npos) continue;
            matches.emplace_back(O{{"sourceId", id}, {"entryId", entry.at("id")}, {"revision", entry_revision(source, entry)},
                {"name", entry.at("name")}, {"series", entry.at("series")}, {"source", source}});
        }
    }
    const auto total = matches.size(); A page;
    for (std::size_t i = offset; i < total && page.size() < limit; ++i) page.push_back(matches[i]);
    const auto next = std::min(total, offset + limit);
    return O{{"results", std::move(page)}, {"sources", std::move(sources)}, {"directoryRevision", current},
        {"total", static_cast<int>(total)}, {"hasMore", next < total}, {"nextOffset", static_cast<int>(next)}, {"snapshotOnly", true}};
}
Json CharacterDirectory::replace_snapshot(const Json& value, std::string_view expected) {
    auto catalog = catalog_document(value); const auto id = catalog.at("source").at("id").as_string();
    std::lock_guard lock(impl_->mutex);
    if (expected != impl_->revision()) fail(409, "目录已更新，请重新加载后再导入快照");
    auto next = impl_->sources; next[id] = std::move(catalog);
    std::size_t count = 0; for (const auto& [unused, item] : next) { (void)unused; count += item.at("entries").as_array().size(); }
    if (next.size() > 16 || count > 8192) fail(413, "最多保存16个目录来源和8192个条目");
    impl_->persist(next, impl_->imports); impl_->sources = std::move(next);
    return O{{"ok", true}, {"directoryRevision", impl_->revision()}, {"sourceId", id}};
}
Bot CharacterDirectory::import_entry(std::string_view sid, std::string_view eid, std::string_view expected) {
    bounded(sid, 160); bounded(eid, 160); bounded(expected, 64);
    std::lock_guard lock(impl_->mutex);
    const auto found = impl_->sources.find(std::string(sid)); if (found == impl_->sources.end()) fail(404, "目录来源不存在");
    const auto& source = found->second.at("source"); const Json* selected{};
    for (const auto& entry : found->second.at("entries").as_array()) if (entry.at("id").as_string() == eid) { selected = &entry; break; }
    if (!selected) fail(404, "目录角色不存在");
    if (entry_revision(source, *selected) != expected) fail(409, "目录角色已更新，请重新搜索后引入");
    const auto key = source_data_digest(Json(A{std::string(sid), std::string(eid)}).dump());
    auto existing = impl_->imports.find(key);
    if (existing != impl_->imports.end()) {
        const auto bot_id = existing->second.at("botId").as_string();
        if (auto bot = impl_->store.find_bot(bot_id)) return *bot;
        if (impl_->store.list_bots().size() >= 1024) fail(409, "本地Bot数量已达上限");
        // The durable random-ID intent predates creation, so a restart between
        // SQLite commit and the HTTP response reuses the same identity.
        return impl_->store.create_bot(existing->second.at("name").as_string(), existing->second.at("persona").as_string(), bot_id);
    }
    if (impl_->imports.size() >= 1024 || impl_->store.list_bots().size() >= 1024) fail(409, "本地Bot数量已达上限");
    const auto bot_id = "catalog-" + opaque_id();
    if (impl_->store.find_bot(bot_id)) fail(409, "角色身份冲突，请重试");
    auto next = impl_->imports;
    next[key] = O{{"sourceId", std::string(sid)}, {"entryId", std::string(eid)}, {"botId", bot_id},
                  {"entryRevision", std::string(expected)}, {"source", source}, {"name", selected->at("name")}, {"persona", selected->at("persona")}};
    impl_->persist(impl_->sources, next); impl_->imports = std::move(next);
    return impl_->store.create_bot(selected->at("name").as_string(), selected->at("persona").as_string(), bot_id);
}
Json CharacterDirectory::provenance(std::string_view bot_id) const {
    std::lock_guard lock(impl_->mutex);
    for (const auto& [unused, row] : impl_->imports) { (void)unused; if (row.at("botId").as_string() == bot_id) {
        auto result = row.as_object(); result.erase("persona"); result.erase("name"); return result;
    } }
    return Json();
}

struct PersonaDrafts::Impl {
    struct Job {
        std::string id, bot_id, brief, revision, model, status = "running", text, error, saved_revision;
        std::jthread worker;
    };
    Store& store; Generate generate; mutable std::mutex mutex; std::map<std::string, std::shared_ptr<Job>> jobs;
    Impl(Store& store, Generate callback) : store(store), generate(std::move(callback)) {
        if (!generate) generate = [](const auto& config, const auto& messages, auto chunk, auto stop) { return call_model(config, messages, {}, chunk, stop); };
    }
    std::shared_ptr<Job> require(std::string_view bot, std::string_view id) const {
        const auto found = jobs.find(std::string(id));
        if (found == jobs.end() || found->second->bot_id != bot) fail(404, "此Bot没有该人设草稿");
        return found->second;
    }
    Json view(const Job& job) const {
        return O{{"draftId", job.id}, {"botId", job.bot_id}, {"status", job.status}, {"baseRevision", job.revision},
            {"model", job.model}, {"persona", job.text}, {"error", job.error}, {"savedRevision", job.saved_revision}};
    }
};
PersonaDrafts::PersonaDrafts(Store& store, Generate generate) : impl_(std::make_unique<Impl>(store, std::move(generate))) {}
PersonaDrafts::~PersonaDrafts() {
    for (auto& [unused, job] : impl_->jobs) { (void)unused; job->worker.request_stop(); }
    for (auto& [unused, job] : impl_->jobs) { (void)unused; if (job->worker.joinable()) job->worker.join(); }
}
Json PersonaDrafts::start(std::string_view bot_id, std::string_view brief, const ModelConfig& selected, std::string_view expected) {
    const auto clean = bounded(brief, 4096); const auto profile = impl_->store.read_bot_profile(bot_id);
    if (profile.revision != expected) fail(409, "人设已修改，请重新打开生成面板");
    auto config = selected; config.max_output_tokens = std::clamp(config.max_output_tokens, 1, 2048); config.timeout_ms = 45000;
    auto job = std::make_shared<Impl::Job>(); job->id = opaque_id(); job->bot_id = bot_id; job->brief = clean;
    job->revision = profile.revision; job->model = config.model;
    std::lock_guard lock(impl_->mutex);
    std::size_t active = 0;
    for (const auto& [unused, row] : impl_->jobs) {
        (void)unused;
        if (row->status == "running" || row->status == "cancelling") {
            ++active; if (row->bot_id == bot_id) fail(409, "此Bot已有正在生成的人设草稿");
        }
    }
    if (active >= 4) fail(429, "同时最多生成4份人设草稿");
    // Keep a bounded set. Finished worker joins must occur outside this mutex.
    if (impl_->jobs.size() >= 64) fail(429, "当前会话的人设草稿已达64份，请重启后继续");
    impl_->jobs.emplace(job->id, job);
    try {
        job->worker = std::jthread([this, job, config, name = profile.bot.name](std::stop_token stop) {
            try {
                std::size_t streamed = 0;
                const auto reply = impl_->generate(config, {{"system", "根据用户提供的简介，为指定Bot编写可编辑的人设草稿。只输出人设正文，不执行任何工具，不声称已保存。未知经历与关系不要编造。保持简洁，最多3000字。"},
                    {"user", "Bot名称：" + name + "\n用户简介：\n" + job->brief}},
                    [&](std::string_view kind, std::string_view text) {
                        if (kind == "text") { streamed += text.size(); if (streamed > persona_limit) fail(413, "生成的人设过长"); }
                    }, stop);
                const auto text = bounded(reply.text, persona_limit);
                if (!reply.tool_calls.empty()) fail(400, "人设草稿不能包含工具调用");
                std::lock_guard lock(impl_->mutex);
                if (stop.stop_requested() || job->status == "cancelling") job->status = "cancelled";
                else { job->text = text; job->status = "ready"; }
            } catch (...) {
                std::lock_guard lock(impl_->mutex);
                job->status = stop.stop_requested() || job->status == "cancelling" ? "cancelled" : "failed";
                if (job->status == "failed") job->error = "生成失败或输出不符合长度要求；原人设未修改，可检查模型后重试。";
            }
        });
    } catch (...) { impl_->jobs.erase(job->id); throw; }
    return impl_->view(*job);
}
Json PersonaDrafts::get(std::string_view bot, std::string_view id) const {
    std::lock_guard lock(impl_->mutex); return impl_->view(*impl_->require(bot, id));
}
Json PersonaDrafts::cancel(std::string_view bot, std::string_view id) {
    std::lock_guard lock(impl_->mutex); auto job = impl_->require(bot, id);
    if (job->status == "running") { job->status = "cancelling"; job->worker.request_stop(); }
    else if (job->status == "ready") { job->status = "cancelled"; job->text.clear(); }
    return impl_->view(*job);
}
BotProfileSnapshot PersonaDrafts::apply(std::string_view bot, std::string_view id,
    std::string_view revision, std::string_view edited) {
    const auto text = bounded(edited, persona_limit);
    std::lock_guard lock(impl_->mutex); auto job = impl_->require(bot, id);
    if (job->status != "ready" || job->revision != revision) fail(409, "草稿状态或版本已变化，请重新生成或核对");
    auto result = impl_->store.save_bot_profile(bot, revision, text);
    job->text = text; job->status = "saved"; job->saved_revision = result.revision; return result;
}
} // namespace dimension
