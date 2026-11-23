#include "dimension/bot_archive.hpp"
#include "dimension/message_context.hpp"
#include "dimension/relation_notes.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <map>
#include <mutex>
#include <set>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
using Clock = std::chrono::steady_clock;
using Selection = std::set<std::string, std::less<>>;
constexpr std::array<std::string_view, 9> field_names{
    "name", "id", "persona", "chatHistory", "workHistory", "longTermMemory", "relations", "midTermMemory", "avatar"};
constexpr std::size_t text_limit = 4U * 1024U * 1024U;
constexpr std::size_t stage_count_limit = 4;
constexpr std::size_t stage_bytes_limit = 64U * 1024U * 1024U;
constexpr auto stage_lifetime = std::chrono::minutes(10);

[[noreturn]] void reject(int status, const char* code, const char* reason) {
    throw ArchiveStageError(status, code, reason);
}
void exact_fields(const Json& value, std::initializer_list<std::string_view> keys,
                  std::initializer_list<std::string_view> optional = {}) {
    const auto allowed = keys.size() + optional.size();
    if (!value.is_object() || value.as_object().size() > allowed || value.as_object().size() < keys.size())
        reject(400, "bot_archive_fields", "Invalid Bot archive object fields");
    for (const auto& [key, unused] : value.as_object()) {
        (void)unused;
        if (std::find(keys.begin(), keys.end(), key) == keys.end() &&
            std::find(optional.begin(), optional.end(), key) == optional.end())
            reject(400, "bot_archive_fields", "Unknown Bot archive object field");
    }
    for (auto key : keys) if (!value.find(key))
        reject(400, "bot_archive_fields", "Missing Bot archive object field");
}
const std::string& string(const Json& value) {
    if (!value.is_string()) reject(400, "bot_archive_type", "Expected a Bot archive string");
    return value.as_string();
}
bool hex(std::string_view value, std::size_t size) {
    return value.size() == size && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
bool bot_id(std::string_view value) {
    return !value.empty() && value.size() <= 64 && value.front() >= 'a' && value.front() <= 'z' &&
        std::all_of(value.begin(), value.end(), [](char c) {
            return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        });
}
Selection selection(const Json& value) {
    if (!value.is_array() || value.as_array().size() > field_names.size())
        reject(400, "bot_archive_selection", "Expected a bounded Bot archive field selection");
    Selection result;
    for (const auto& item : value.as_array()) {
        const auto& key = string(item);
        if (std::find(field_names.begin(), field_names.end(), key) == field_names.end() || !result.insert(key).second)
            reject(400, "bot_archive_selection", "Unknown or repeated Bot archive field");
    }
    return result;
}
A field_array(const Selection& selected) {
    A result;
    for (auto name : field_names) if (selected.contains(name)) result.emplace_back(std::string(name));
    return result;
}
std::string random_token() {
    std::array<unsigned char, 16> value{};
    if (BCryptGenRandom(nullptr, value.data(), static_cast<ULONG>(value.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        reject(500, "bot_archive_random", "Cannot create a Bot archive stage identity");
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    for (auto byte : value) { result += digits[byte >> 4]; result += digits[byte & 15]; }
    return result;
}
std::string base64(std::string_view bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output; output.reserve((bytes.size() + 2) / 3 * 4);
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const auto a = static_cast<unsigned char>(bytes[i]);
        const auto b = i + 1 < bytes.size() ? static_cast<unsigned char>(bytes[i + 1]) : 0;
        const auto c = i + 2 < bytes.size() ? static_cast<unsigned char>(bytes[i + 2]) : 0;
        output += alphabet[a >> 2]; output += alphabet[((a & 3) << 4) | (b >> 4)];
        output += i + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
        output += i + 2 < bytes.size() ? alphabet[c & 63] : '=';
    }
    return output;
}
std::string decode_base64(const Json& value) {
    const auto& input = string(value);
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (input.empty() || input.size() % 4 || input.size() > (bot_archive_max_avatar_bytes + 2) / 3 * 4)
        reject(413, "bot_archive_avatar_size", "Avatar base64 is empty, malformed or exceeds 8 MiB");
    std::string output; output.reserve(input.size() / 4 * 3);
    for (std::size_t i = 0; i < input.size(); i += 4) {
        std::array<unsigned, 4> n{};
        for (std::size_t j = 0; j < 4; ++j) {
            const char c = input[i + j];
            if (c == '=') {
                if (i + 4 != input.size() || j < 2 || (j == 2 && input[i + 3] != '='))
                    reject(400, "bot_archive_avatar_encoding", "Avatar must use canonical base64");
            } else {
                const auto index = alphabet.find(c);
                if (index == std::string_view::npos)
                    reject(400, "bot_archive_avatar_encoding", "Avatar must use canonical base64");
                n[j] = static_cast<unsigned>(index);
            }
        }
        if ((input[i + 2] == '=' && (n[1] & 15U)) || (input[i + 3] == '=' && (n[2] & 3U)))
            reject(400, "bot_archive_avatar_encoding", "Avatar base64 has noncanonical padding bits");
        output += static_cast<char>((n[0] << 2U) | (n[1] >> 4U));
        if (input[i + 2] != '=') output += static_cast<char>((n[1] << 4U) | (n[2] >> 2U));
        if (input[i + 3] != '=') output += static_cast<char>((n[2] << 6U) | n[3]);
    }
    if (output.size() > bot_archive_max_avatar_bytes)
        reject(413, "bot_archive_avatar_size", "Avatar exceeds 8 MiB");
    return output;
}
const A& array(const Json& value) {
    if (!value.is_array()) reject(400, "bot_archive_type", "Expected a Bot archive record array");
    return value.as_array();
}
const char* memory_state(MemoryState state) {
    if (state == MemoryState::Confirmed) return "confirmed";
    if (state == MemoryState::Candidate) return "candidate";
    if (state == MemoryState::Rejected) return "rejected";
    reject(400, "bot_archive_memory_state", "Invalid memory state");
}
// Structured reference identifiers are pseudonymous even if raw ID export is
// selected. Reference text/timing/ranges stay exact and confer no authority.
Json exported_context(MessageContext context, std::string_view own_bot) {
    for (auto& source : context.sources) {
        const auto origin = source.source_namespace;
        source.bot_id = source.bot_id == own_bot ? "bot" : "ref-" + source_data_digest(origin + ":bot:" + source.bot_id).substr(0, 48);
        if (!source.group_id.empty()) source.group_id = "group-" + source_data_digest(origin + ":group:" + source.group_id);
        source.source_namespace = "ref-" + source_data_digest(origin);
    }
    return message_context_json(context);
}
Json target_context(const Json& value, std::string_view target) {
    auto context = parse_message_context(value);
    for (auto& source : context.sources) if (source.bot_id == "bot") source.bot_id = std::string(target);
    return message_context_json(context);
}
ArchiveDocument document(const O& data, const std::string& target) {
    if (const auto found = data.find("id"); found != data.end())
        if (!bot_id(string(found->second))) reject(400, "bot_archive_id", "Invalid source Bot ID");
    A conversations, memories, mid;
    for (const auto key : {"chatHistory", "workHistory"}) {
        const auto found = data.find(key); if (found == data.end()) continue;
        A messages;
        for (const auto& row : array(found->second)) {
            if (row.find("context")) exact_fields(row, {"id", "actor", "text", "createdAtMs", "context"});
            else exact_fields(row, {"id", "actor", "text", "createdAtMs"});
            auto message = row.as_object();
            if (row.find("context")) message["context"] = target_context(row.at("context"), target);
            messages.emplace_back(std::move(message));
        }
        if (!messages.empty()) conversations.emplace_back(O{{"botId", target}, {"groupId", ""},
            {"mode", std::string_view(key) == "chatHistory" ? "chat" : "work"}, {"messages", std::move(messages)}});
    }
    for (const auto key : {"longTermMemory", "relations"}) {
        const auto found = data.find(key); if (found == data.end()) continue;
        for (const auto& row : array(found->second)) {
            exact_fields(row, {"id", "text", "state", "revision", "sourceActor"},
                {"kind", "eventTimeMs", "sourceRef", "participants", "userChoice", "outcome"});
            const bool relation = is_relation_note_text(string(row.at("text")));
            if (relation != (std::string_view(key) == "relations"))
                reject(400, "bot_archive_memory_kind", "Memory is in the wrong selectable field");
            auto record = row.as_object(); record["botId"] = target; record["groupId"] = "";
            memories.emplace_back(std::move(record));
        }
    }
    if (const auto found = data.find("midTermMemory"); found != data.end())
        for (const auto& row : array(found->second)) {
            exact_fields(row, {"id", "text", "sourceActor", "revision", "createdAtMs", "updatedAtMs", "expiresAtMs", "strength"});
            auto record = row.as_object(); record["botId"] = target; record["groupId"] = "";
            mid.emplace_back(std::move(record));
        }
    O archive{{"format", "dimension-conversation-archive"}, {"version", 3}, {"coverage", "conversation-and-group-data"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins", "accounts", "provider-settings", "application-settings"}},
        {"bots", A{O{{"id", target}, {"name", data.contains("name") ? data.at("name") : Json("Imported Bot")},
            {"persona", data.contains("persona") ? data.at("persona") : Json("")}, {"inChat", false}, {"inWork", false}}}},
        {"groups", A{}}, {"conversations", std::move(conversations)}, {"memories", std::move(memories)}, {"midMemories", std::move(mid)}};
    const auto bytes = Json(std::move(archive)).dump();
    if (bytes.size() > text_limit) reject(413, "bot_archive_text_size", "Selected Bot text exceeds 4 MiB; select fewer content fields");
    return parse_archive(bytes);
}
O counts(const O& data) {
    O result;
    for (auto key : field_names) {
        const auto found = data.find(std::string(key));
        result[std::string(key)] = found == data.end() ? 0.0 : found->second.is_array() ? double(found->second.as_array().size()) : 1.0;
    }
    result["avatarBytes"] = data.contains("avatar") ? data.at("avatar").at("byteSize") : Json(0);
    return result;
}
struct Package {
    std::string source_key, package_digest;
    Selection fields;
    O data;
    O counts;
    std::string avatar_bytes;
    std::size_t bytes{};
};
Package parse_package(const Json& value) {
    exact_fields(value, {"format", "version", "sourceKey", "fields", "data", "counts", "packageSha256"});
    const auto bytes = value.dump().size();
    if (bytes > bot_archive_max_package_bytes) reject(413, "bot_archive_package_size", "Bot archive package exceeds its byte limit");
    if (string(value.at("format")) != "dimension-bot-archive" || !value.at("version").is_number() || value.at("version").as_number() != 1)
        reject(400, "bot_archive_format", "Unsupported Bot archive format or version");
    auto envelope = value.as_object(); envelope.erase("packageSha256");
    if (!hex(string(value.at("packageSha256")), 64) || source_data_digest(Json(envelope).dump()) != value.at("packageSha256").as_string())
        reject(400, "bot_archive_checksum", "Bot archive checksum does not match its contents");
    Package result;
    result.package_digest = string(value.at("packageSha256"));
    result.source_key = string(value.at("sourceKey"));
    if (!hex(result.source_key, 64)) reject(400, "bot_archive_source", "Invalid opaque Bot archive source key");
    result.fields = selection(value.at("fields"));
    if (result.fields.empty() || !value.at("data").is_object() || value.at("data").as_object().size() != result.fields.size())
        reject(400, "bot_archive_fields", "Package fields must match all included data");
    result.data = value.at("data").as_object();
    for (const auto& [key, ignored] : result.data) {
        (void)ignored;
        if (!result.fields.contains(key)) reject(400, "bot_archive_fields", "Package contains an undeclared data field");
    }
    (void)document(result.data, "bot"); // Validates all records, including fields later excluded.
    if (result.fields.contains("avatar")) {
        const auto& avatar = result.data.at("avatar");
        exact_fields(avatar, {"mime", "base64", "byteSize", "sha256", "width", "height", "frames", "animated"});
        result.avatar_bytes = decode_base64(avatar.at("base64"));
        const auto image = inspect_image(result.avatar_bytes);
        const auto equal_number = [&](const char* key, double expected) {
            if (!avatar.at(key).is_number() || avatar.at(key).as_number() != expected)
                reject(400, "bot_archive_avatar_metadata", "Avatar metadata differs from decoded image");
        };
        equal_number("byteSize", double(result.avatar_bytes.size())); equal_number("width", double(image.width));
        equal_number("height", double(image.height)); equal_number("frames", double(image.frames));
        if (string(avatar.at("mime")) != image.mime || string(avatar.at("sha256")) != source_data_digest(result.avatar_bytes) ||
            !avatar.at("animated").is_bool() || avatar.at("animated").as_bool() != image.animated)
            reject(400, "bot_archive_avatar_metadata", "Avatar metadata differs from decoded image");
    }
    result.counts = counts(result.data);
    if (Json(result.counts).dump() != value.at("counts").dump())
        reject(400, "bot_archive_counts", "Package counts do not match its complete content");
    result.bytes = bytes; return result;
}
O applied_counts(const StoreImportCounts& c) {
    return O{{"botsCreated", double(c.bots_created)}, {"botsPreserved", double(c.bots_preserved)},
        {"messagesCreated", double(c.messages_created)}, {"messagesReused", double(c.messages_reused)}, {"messagesTombstoned", double(c.messages_tombstoned)},
        {"memoriesCreated", double(c.memories_created)}, {"memoriesReused", double(c.memories_reused)}, {"memoriesTombstoned", double(c.memories_tombstoned)},
        {"midMemoriesCreated", double(c.mid_memories_created)}, {"midMemoriesReused", double(c.mid_memories_reused)}, {"midMemoriesTombstoned", double(c.mid_memories_tombstoned)}};
}
} // namespace

struct BotArchives::Impl {
    struct Entry {
        std::optional<ArchiveDocument> document;
        StoreImportOptions options;
        StoreBotArchiveReceipt receipt;
        StoreImportPlan plan;
        Json report;
        std::string avatar_bytes, avatar_mime;
        bool replay{}, can_commit{};
        std::size_t bytes{};
        Clock::time_point deadline;
        std::optional<StoreImportResult> result;
    };
    Store& store;
    ImageAssets& images;
    BotArchiveWorkHistory work_history;
    std::mutex mutex;
    std::map<std::string, Entry, std::less<>> entries;
    std::size_t bytes{};
    Impl(Store& target, ImageAssets& assets, BotArchiveWorkHistory history)
        : store(target), images(assets), work_history(std::move(history)) {}
    void prune() {
        const auto now = Clock::now();
        for (auto it = entries.begin(); it != entries.end();) {
            if (it->second.deadline <= now) { bytes -= it->second.bytes; it = entries.erase(it); }
            else ++it;
        }
    }
    auto find(std::string_view token) {
        if (!hex(token, 32)) reject(400, "bot_archive_token", "Invalid Bot archive stage token");
        auto found = entries.find(token);
        if (found == entries.end()) reject(404, "bot_archive_stage_missing", "Bot archive stage is absent; prepare again");
        if (found->second.deadline <= Clock::now()) {
            bytes -= found->second.bytes; entries.erase(found);
            reject(410, "bot_archive_stage_expired", "Bot archive stage expired; prepare again");
        }
        return found;
    }
};

BotArchives::BotArchives(Store& store, ImageAssets& images, BotArchiveWorkHistory history)
    : impl_(std::make_unique<Impl>(store, images, std::move(history))) {}
BotArchives::~BotArchives() = default;

Json BotArchives::capabilities() {
    return O{{"format", "dimension-bot-archive"}, {"version", 1}, {"fields", field_array(Selection(field_names.begin(), field_names.end()))},
        {"maxPackageBytes", double(bot_archive_max_package_bytes)}, {"maxBodyBytes", double(bot_archive_max_body_bytes)},
        {"maxAvatarBytes", double(bot_archive_max_avatar_bytes)}, {"maxTextBytes", double(text_limit)}, {"maxStages", 4},
        {"coverage", "selected-private-bot-data"}, {"workHistory", "conversation-text-only"},
        {"structuredReferenceIds", "pseudonymous"}, {"defaultNewId", true}, {"existingIdOverwrite", false}};
}

Json BotArchives::export_bot(const Json& request) {
    exact_fields(request, {"botId", "fields"});
    const auto& id = string(request.at("botId")); const auto fields = selection(request.at("fields"));
    if (fields.empty()) reject(400, "bot_archive_empty_selection", "Select at least one field to export");
    std::lock_guard lock(impl_->mutex);
    StoreBotArchiveFields wanted{fields.contains("name"), fields.contains("persona"), fields.contains("chatHistory"),
        fields.contains("workHistory"), fields.contains("longTermMemory"), fields.contains("relations"), fields.contains("midTermMemory")};
    const auto snapshot = impl_->store.bot_archive_snapshot(id, wanted);
    const auto& bot = snapshot.bots.front();
    O data;
    if (fields.contains("id")) data["id"] = bot.id;
    if (fields.contains("name")) data["name"] = bot.name;
    if (fields.contains("persona")) data["persona"] = bot.persona;
    for (const auto key : {"chatHistory", "workHistory", "longTermMemory", "relations", "midTermMemory"})
        if (fields.contains(key)) data[key] = A{};
    A chat, work, long_term, relations, mid;
    std::int64_t message_id = 0;
    const auto add_message = [&](const Message& message) {
        O row{{"id", std::to_string(++message_id)}, {"actor", message.actor}, {"text", message.text}, {"createdAtMs", std::to_string(message.created_at_ms)}};
        if (message.context) row["context"] = exported_context(*message.context, bot.id);
        (message.mode == Mode::Chat ? chat : work).emplace_back(std::move(row));
    };
    for (const auto& message : snapshot.messages) add_message(message);
    if (wanted.work_history && impl_->work_history) {
        const auto runtime = impl_->work_history(id);
        if (runtime.size() > ArchiveLimits{}.max_messages - snapshot.messages.size())
            reject(413, "bot_archive_history_count", "Combined selected histories exceed 20000 messages");
        std::size_t runtime_bytes = 0;
        for (const auto& message : runtime) {
            if (message.bot_id != id || !message.group_id.empty() || message.mode != Mode::Work || message.context)
                reject(500, "bot_archive_work_scope", "Work text snapshot contains an unsupported scope or context");
            if (message.text.size() > text_limit - runtime_bytes)
                reject(413, "bot_archive_text_size", "Selected Work conversation text exceeds 4 MiB");
            runtime_bytes += message.text.size(); add_message(message);
        }
    }
    for (const auto& memory : snapshot.memories) {
        O row{{"id", std::to_string(memory.id)}, {"text", memory.text}, {"state", memory_state(memory.state)},
              {"revision", std::to_string(memory.revision)}, {"sourceActor", memory.source_actor},
              {"kind", memory.kind}, {"eventTimeMs", std::to_string(memory.event_time_ms)},
              {"sourceRef", memory.source_ref}, {"participants", memory.participants},
              {"userChoice", memory.user_choice}, {"outcome", memory.outcome}};
        (is_relation_note_text(memory.text) ? relations : long_term).emplace_back(std::move(row));
    }
    for (const auto& m : snapshot.mid_memories) mid.emplace_back(O{{"id", std::to_string(m.id)}, {"text", m.text},
        {"sourceActor", m.source_actor}, {"revision", std::to_string(m.revision)}, {"createdAtMs", std::to_string(m.created_at_ms)},
        {"updatedAtMs", std::to_string(m.updated_at_ms)}, {"expiresAtMs", std::to_string(m.expires_at_ms)}, {"strength", double(m.strength)}});
    if (wanted.chat_history) data["chatHistory"] = std::move(chat);
    if (wanted.work_history) data["workHistory"] = std::move(work);
    if (wanted.long_term_memory) data["longTermMemory"] = std::move(long_term);
    if (wanted.relations) data["relations"] = std::move(relations);
    if (wanted.mid_term_memory) data["midTermMemory"] = std::move(mid);
    // Reserve enough room for the longest valid destination ID so an export
    // near the text cap still imports after its neutral carrier is replaced.
    (void)document(data, std::string(64, 'a'));
    if (fields.contains("avatar")) {
        if (!impl_->images.avatar(AvatarScope::Bot, id))
            reject(409, "bot_archive_avatar_missing", "This Bot has no avatar; deselect avatar to export");
        const auto avatar = impl_->images.read_avatar(AvatarScope::Bot, id);
        const auto image = inspect_image(avatar.bytes);
        data["avatar"] = O{{"mime", image.mime}, {"base64", base64(avatar.bytes)}, {"byteSize", double(avatar.bytes.size())},
            {"sha256", source_data_digest(avatar.bytes)}, {"width", double(image.width)}, {"height", double(image.height)},
            {"frames", double(image.frames)}, {"animated", image.animated}};
    }
    O envelope{{"format", "dimension-bot-archive"}, {"version", 1},
        {"sourceKey", source_data_digest(Json(A{snapshot.source_id, bot.id}).dump())}, {"fields", field_array(fields)},
        {"counts", counts(data)}, {"data", std::move(data)}};
    envelope["packageSha256"] = source_data_digest(Json(envelope).dump());
    Json package(std::move(envelope));
    if (package.dump().size() > bot_archive_max_package_bytes)
        reject(413, "bot_archive_package_size", "Selected Bot archive package exceeds its byte limit; select fewer fields");
    return package;
}

Json BotArchives::stage(const Json& request) {
    std::lock_guard lock(impl_->mutex);
    const auto request_bytes = request.dump().size();
    if (request_bytes > bot_archive_max_body_bytes) reject(413, "bot_archive_body_size", "Bot archive request exceeds 16 MiB");
    impl_->prune();
    if (impl_->entries.size() >= stage_count_limit || request_bytes > stage_bytes_limit - impl_->bytes)
        reject(429, "bot_archive_stage_capacity", "Bot archive staging is full; discard a preview first");
    exact_fields(request, {"package", "fields", "preserveId"});
    if (!request.at("preserveId").is_bool()) reject(400, "bot_archive_preserve_id", "preserveId must be a boolean");
    const bool preserve = request.at("preserveId").as_bool();
    const auto selected = selection(request.at("fields"));
    auto package = parse_package(request.at("package"));
    O data;
    for (const auto& key : selected) {
        if (!package.fields.contains(key)) reject(400, "bot_archive_field_absent", "A selected field is absent from this package");
        data.emplace(key, package.data.at(key));
    }
    if (preserve != selected.contains("id"))
        reject(400, "bot_archive_preserve_id", "Preserving the source ID requires selecting its included id field");
    Impl::Entry entry;
    entry.receipt.selection_digest = source_data_digest(Json(O{{"data", data}, {"fields", field_array(selected)}, {"preserveId", preserve}}).dump());
    // A different package or explicit selection is a new import intent and may
    // create another Bot. Only an exact intent can reuse this durable receipt.
    entry.receipt.source_key = source_data_digest(Json(A{package.source_key, package.package_digest, entry.receipt.selection_digest}).dump());
    const auto previous = impl_->store.bot_archive_receipt(entry.receipt.source_key);
    entry.replay = previous.has_value();
    entry.receipt.target_id = previous ? previous->target_id : preserve ? string(data.at("id")) : "import-" + random_token();
    A conflicts;
    const auto conflict = [&](const char* code, const char* kind, const std::string& locator) {
        conflicts.emplace_back(O{{"code", code}, {"kind", kind}, {"sourceId", locator}});
    };
    if (!selected.empty()) {
        if (previous && previous->selection_digest != entry.receipt.selection_digest)
            conflict("bot_archive_source_changed", "bot", package.source_key);
        if (!previous && impl_->store.find_bot(entry.receipt.target_id))
            conflict("bot_archive_id_exists", "bot", entry.receipt.target_id);
        entry.document.emplace(document(data, entry.receipt.target_id));
        entry.options.source_id = "botarchive-" + entry.receipt.source_key;
        entry.options.bot_conflict = StoreBotConflict::PreserveExisting;
        entry.options.memory_conflict = StoreMemoryConflict::PreserveExisting;
        entry.options.group_conflict = StoreGroupConflict::Reject;
        entry.plan = impl_->store.prepare_archive_import(*entry.document, entry.options);
        for (const auto& issue : entry.plan.issues) conflict(issue.code.c_str(), issue.kind.c_str(), issue.source_id);
        if (entry.plan.issues_truncated) reject(409, "bot_archive_conflict_limit", "Too many import conflicts to preview completely");
        if (previous && (entry.plan.counts.bots_created || entry.plan.counts.messages_created || entry.plan.counts.memories_created ||
            entry.plan.counts.memories_preserved || entry.plan.counts.mid_memories_created || entry.plan.counts.mid_memories_preserved))
            conflict("bot_archive_replay_incomplete", "bot", package.source_key);
    }
    entry.can_commit = !selected.empty() && conflicts.empty() && entry.plan.can_commit;
    if (selected.contains("avatar")) {
        entry.avatar_bytes = std::move(package.avatar_bytes); entry.avatar_mime = string(data.at("avatar").at("mime"));
        if (!previous && impl_->images.avatar(AvatarScope::Bot, entry.receipt.target_id)) {
            conflict("bot_archive_avatar_target_exists", "avatar", entry.receipt.target_id); entry.can_commit = false;
        }
    }
    O source{{"key", package.source_key}};
    if (selected.contains("id")) source["id"] = data.at("id");
    auto report = capabilities().as_object();
    report["availableFields"] = field_array(package.fields); report["selectedFields"] = field_array(selected);
    report["counts"] = std::move(package.counts); report["selectedCounts"] = counts(data);
    report["source"] = std::move(source); report["target"] = O{{"id", entry.receipt.target_id}, {"isNew", !previous},
        {"newCopy", !previous && !preserve}, {"preserveId", preserve}};
    report["conflicts"] = std::move(conflicts); report["canCommit"] = entry.can_commit;
    report["packageBytes"] = double(package.bytes); report["packageByteEncoding"] = "canonical-json-utf8";
    report["importCounts"] = applied_counts(entry.plan.counts); report["idempotent"] = entry.replay;
    entry.report = Json(std::move(report)); entry.bytes = request_bytes; entry.deadline = Clock::now() + stage_lifetime;
    auto token = random_token(); while (impl_->entries.contains(token)) token = random_token();
    const auto expires = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch() + stage_lifetime).count();
    Json response = O{{"token", token}, {"report", entry.report}, {"expiresAtMs", std::to_string(expires)}, {"dataChanged", false}};
    impl_->entries.emplace(token, std::move(entry)); impl_->bytes += request_bytes;
    return response;
}

Json BotArchives::commit(std::string_view token) {
    std::lock_guard lock(impl_->mutex);
    auto& entry = impl_->find(token)->second;
    const bool cached = entry.result.has_value();
    if (!cached) {
        if (!entry.can_commit) reject(409, "bot_archive_stage_blocked", "Select fields and resolve conflicts before committing a new preview");
        bool owned_avatar = false;
        auto result = impl_->store.commit_bot_archive_import(*entry.document, entry.options, entry.receipt,
                entry.plan.target_revision, entry.plan.digest, [&] {
                    if (!entry.avatar_bytes.empty()) {
                        if (impl_->images.avatar(AvatarScope::Bot, entry.receipt.target_id))
                            reject(409, "bot_archive_avatar_target_exists", "New Bot avatar target already exists");
                        owned_avatar = true;
                        (void)impl_->images.put_avatar(AvatarScope::Bot, entry.receipt.target_id, entry.avatar_bytes, entry.avatar_mime);
                    }
                }, [&] {
                    if (owned_avatar) {
                        try { (void)impl_->images.remove_avatar(AvatarScope::Bot, entry.receipt.target_id); }
                        catch (...) { reject(500, "bot_archive_avatar_cleanup", "Import failed; an invisible orphan avatar requires cleanup before retry"); }
                    }
                });
        entry.result.emplace(std::move(result));
        entry.document.reset(); entry.avatar_bytes.clear(); entry.avatar_bytes.shrink_to_fit();
        impl_->bytes -= entry.bytes; entry.bytes = 0;
    }
    const auto bot = impl_->store.find_bot(entry.receipt.target_id);
    if (!bot) reject(500, "bot_archive_receipt_target_missing", "Committed Bot archive target is missing");
    auto report = entry.report.as_object();
    report["importCounts"] = applied_counts(entry.result->counts);
    report["revisionBefore"] = std::to_string(entry.result->revision_before);
    report["revisionAfter"] = std::to_string(entry.result->revision_after);
    report["countsDescribe"] = "original-commit";
    // Return locators/roster only. The ordinary Bot endpoint supplies authorized
    // profile data after import without leaking unselected existing fields here.
    return O{{"token", std::string(token)}, {"committed", true}, {"idempotent", cached || entry.replay},
        {"bot", O{{"id", bot->id}, {"inChat", bot->in_chat}, {"inWork", bot->in_work}}}, {"report", std::move(report)}};
}

bool BotArchives::discard(std::string_view token) {
    std::lock_guard lock(impl_->mutex);
    const auto entry = impl_->find(token); impl_->bytes -= entry->second.bytes; impl_->entries.erase(entry); return true;
}
} // namespace dimension
