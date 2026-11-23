#include "dimension/archive.hpp"
#include "dimension/relation_notes.hpp"
#include "dimension/message_context.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <map>
#include <set>
#include <tuple>
#include <utility>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
constexpr std::array<std::string_view, 8> excluded_types_v1{
    "work-runs", "tool-receipts", "message-receipts", "artifacts",
    "plugins", "accounts", "provider-settings", "group-metadata"};
constexpr std::array<std::string_view, 8> excluded_types_v2{
    "work-runs", "tool-receipts", "message-receipts", "artifacts",
    "plugins", "accounts", "provider-settings", "application-settings"};
const auto& excluded_types(int version) {
    return version >= 2 ? excluded_types_v2 : excluded_types_v1;
}

[[noreturn]] void fail(ArchiveErrorCode code, const std::string& path, const char* message) {
    throw ArchiveError(code, path.empty() ? "/" : path, message);
}
void limits_valid(const ArchiveLimits& limits) {
    if (!limits.max_bytes || limits.max_bytes > 64U * 1024U * 1024U ||
        !limits.max_target_records || !limits.max_target_bytes ||
        !limits.max_report_items || limits.max_report_items > 4096)
        fail(ArchiveErrorCode::InvalidFormat, "/limits", "Invalid archive limits");
}
void charge(std::size_t& used, std::size_t amount, std::size_t limit, const std::string& path) {
    if (used > limit || amount > limit - used)
        fail(ArchiveErrorCode::LimitExceeded, path, "Archive resource limit exceeded");
    used += amount;
}
void fields(const Json& value, std::initializer_list<std::string_view> names,
            const std::string& path, std::initializer_list<std::string_view> optional = {}) {
    if (!value.is_object())
        fail(ArchiveErrorCode::InvalidRecord, path, "Expected an object");
    for (const auto& [key, unused] : value.as_object()) {
        (void)unused;
        if (std::find(names.begin(), names.end(), key) == names.end() &&
            std::find(optional.begin(), optional.end(), key) == optional.end())
            fail(ArchiveErrorCode::UnsupportedType, path, "Unknown archive field or record type");
    }
    for (const auto name : names)
        if (!value.find(name))
            fail(ArchiveErrorCode::InvalidRecord, path + "/" + std::string(name), "Required field is absent");
}
const A& array(const Json& value, const std::string& path, std::size_t maximum) {
    if (!value.is_array()) fail(ArchiveErrorCode::InvalidRecord, path, "Expected an array");
    if (value.as_array().size() > maximum)
        fail(ArchiveErrorCode::LimitExceeded, path, "Archive record limit exceeded");
    return value.as_array();
}
std::string string(const Json& value, const std::string& path,
                   std::size_t maximum, bool empty = false) {
    if (!value.is_string()) fail(ArchiveErrorCode::InvalidRecord, path, "Expected a string");
    const auto& text = value.as_string();
    // Json::parse has already validated Unicode scalars. Store additionally rejects NUL.
    if ((!empty && text.empty()) || text.size() > maximum || text.find('\0') != text.npos)
        fail(ArchiveErrorCode::InvalidRecord, path, "Invalid text length or embedded NUL");
    return text;
}
bool boolean(const Json& value, const std::string& path) {
    if (!value.is_bool()) fail(ArchiveErrorCode::InvalidRecord, path, "Expected a boolean");
    return value.as_bool();
}
bool space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; }
void canonical_trim(const std::string& text, const std::string& path) {
    if (text.empty() || space(text.front()) || space(text.back()))
        fail(ArchiveErrorCode::InvalidRecord, path, "Text must already have canonical trimmed edges");
}
std::string bot_id(const Json& value, const std::string& path) {
    auto text = string(value, path, 64);
    if (text.front() < 'a' || text.front() > 'z' ||
        std::any_of(text.begin(), text.end(), [](char c) {
            return !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-';
        })) fail(ArchiveErrorCode::InvalidRecord, path, "Invalid Bot ID");
    return text;
}
bool alnum(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
std::string group_id(const Json& value, const std::string& path, bool empty = false) {
    auto text = string(value, path, 128, empty);
    if (!text.empty() && (!alnum(text.front()) ||
        std::any_of(text.begin(), text.end(), [](char c) {
            return !alnum(c) && c != '.' && c != '_' && c != ':' && c != '-';
        }))) fail(ArchiveErrorCode::InvalidRecord, path, "Invalid Group ID");
    return text;
}
std::string scope(const Json& value, const std::string& path, int version) {
    return version >= 2 ? group_id(value, path, true) : string(value, path, 1024, true);
}
std::string seal_token(const Json& value, const std::string& path) {
    auto text = string(value, path, 32, true);
    if (std::any_of(text.begin(), text.end(), [](char c) {
        return !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-';
    })) fail(ArchiveErrorCode::InvalidRecord, path, "Invalid group seal token");
    return text;
}
std::vector<std::string> bot_references(const Json& value, const std::string& path,
                                      std::size_t maximum, const std::set<std::string>& bots) {
    const auto& values = array(value, path, maximum);
    std::vector<std::string> result;
    std::set<std::string> seen;
    for (std::size_t i = 0; i < values.size(); ++i) {
        const auto item_path = path + "/" + std::to_string(i);
        auto id = bot_id(values[i], item_path);
        if (!bots.contains(id) || !seen.insert(id).second)
            fail(ArchiveErrorCode::InvalidReference, item_path, "Unknown or duplicate group Bot reference");
        result.push_back(std::move(id));
    }
    return result;
}
bool contains(const std::vector<std::string>& values, const std::string& value) {
    return std::find(values.begin(), values.end(), value) != values.end();
}
A strings(const std::vector<std::string>& values) {
    A result;
    for (const auto& value : values) result.emplace_back(value);
    return result;
}
std::int64_t integer(const Json& value, const std::string& path, bool positive) {
    const auto text = string(value, path, 20);
    std::int64_t number{};
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), number);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() ||
        std::to_string(number) != text || (positive && number <= 0))
        fail(ArchiveErrorCode::InvalidRecord, path, "Expected a canonical decimal int64 string");
    return number;
}
Mode mode(const Json& value, const std::string& path) {
    auto text = string(value, path, 4);
    if (text == "chat") return Mode::Chat;
    if (text == "work") return Mode::Work;
    fail(ArchiveErrorCode::UnsupportedType, path, "Unsupported conversation mode");
}
const char* mode_name(Mode value) { return value == Mode::Chat ? "chat" : "work"; }
MemoryState memory_state(const Json& value, const std::string& path) {
    auto text = string(value, path, 9);
    if (text == "candidate") return MemoryState::Candidate;
    if (text == "confirmed") return MemoryState::Confirmed;
    if (text == "rejected") return MemoryState::Rejected;
    fail(ArchiveErrorCode::UnsupportedType, path, "Unsupported memory state");
}
const char* state_name(MemoryState value) {
    if (value == MemoryState::Confirmed) return "confirmed";
    if (value == MemoryState::Rejected) return "rejected";
    return "candidate";
}
A exclusions(int version) {
    A result;
    for (const auto type : excluded_types(version)) result.emplace_back(std::string(type));
    return result;
}
struct Counts {
    std::size_t incoming{}, additions{}, same{}, conflicts{};
    Json json() const {
        return O{{"incoming", static_cast<double>(incoming)}, {"additions", static_cast<double>(additions)},
                 {"sameCandidates", static_cast<double>(same)}, {"conflicts", static_cast<double>(conflicts)}};
    }
};
Json issue(const char* kind, const char* action, std::string bot,
           std::string source_id, std::string group, A changed = {}) {
    return O{{"type", kind}, {"action", action}, {"botId", std::move(bot)},
             {"sourceId", std::move(source_id)}, {"groupId", std::move(group)},
             {"fields", std::move(changed)}};
}
struct TargetBudget {
    const ArchiveLimits& limits;
    std::size_t records{}, bytes{};
    void add(std::size_t length) {
        charge(records, 1, limits.max_target_records, "/target");
        charge(bytes, length, limits.max_target_bytes, "/target");
    }
};
} // namespace

struct ArchiveDocument::Data {
    int version = 1;
    std::size_t source_bytes{};
    std::vector<Bot> bots;
    std::vector<Group> groups;
    std::vector<ArchiveConversation> conversations;
    std::vector<Memory> memories;
    std::vector<MidMemory> mid_memories;
};
ArchiveError::ArchiveError(ArchiveErrorCode code, std::string path, std::string message)
    : std::runtime_error(std::move(message) + " at " + path), code_(code), path_(std::move(path)) {}
ArchiveDocument::ArchiveDocument(std::shared_ptr<const Data> data) : data_(std::move(data)) {}
int ArchiveDocument::version() const noexcept { return data_->version; }
const std::vector<Bot>& ArchiveDocument::bots() const noexcept { return data_->bots; }
const std::vector<Group>& ArchiveDocument::groups() const noexcept { return data_->groups; }
const std::vector<ArchiveConversation>& ArchiveDocument::conversations() const noexcept { return data_->conversations; }
const std::vector<Memory>& ArchiveDocument::memories() const noexcept { return data_->memories; }
const std::vector<MidMemory>& ArchiveDocument::mid_memories() const noexcept { return data_->mid_memories; }
std::size_t ArchiveDocument::size_bytes() const noexcept { return data_->source_bytes; }

ArchiveDocument parse_archive(std::string_view bytes, ArchiveLimits limits) {
    limits_valid(limits);
    if (bytes.size() > limits.max_bytes)
        fail(ArchiveErrorCode::LimitExceeded, "/", "Archive byte limit exceeded");
    Json root;
    try { root = Json::parse(bytes, limits.max_bytes); }
    catch (...) { fail(ArchiveErrorCode::InvalidJson, "/", "Invalid archive JSON"); }
    if (!root.is_object()) fail(ArchiveErrorCode::InvalidRecord, "/", "Expected an object");
    const auto* version_value = root.find("version");
    if (!version_value) fail(ArchiveErrorCode::InvalidRecord, "/version", "Required field is absent");
    if (!version_value->is_number() || (version_value->as_number() != 1 && version_value->as_number() != 2 && version_value->as_number() != 3))
        fail(ArchiveErrorCode::UnsupportedVersion, "/version", "Unsupported archive version");
    const int version = static_cast<int>(version_value->as_number());
    // Preserve v1's diagnostic for a v1 document whose version alone was changed.
    // v2 needs both its explicit coverage declaration and the groups field.
    if (version >= 2 && root.find("coverage") && root.at("coverage").is_string() &&
        root.at("coverage").as_string() == "conversation-data-only")
        fail(ArchiveErrorCode::UnsupportedVersion, "/version", "Archive version does not match coverage");
    if (version == 3 && root.find("midMemories"))
        fields(root, {"format", "version", "coverage", "excludedTypes", "bots", "groups", "conversations", "memories", "midMemories"}, "");
    else if (version >= 2)
        fields(root, {"format", "version", "coverage", "excludedTypes", "bots", "groups", "conversations", "memories"}, "");
    else
        fields(root, {"format", "version", "coverage", "excludedTypes", "bots", "conversations", "memories"}, "");
    if (string(root.at("format"), "/format", 64) != "dimension-conversation-archive" ||
        string(root.at("coverage"), "/coverage", 64) !=
            (version >= 2 ? "conversation-and-group-data" : "conversation-data-only"))
        fail(ArchiveErrorCode::InvalidFormat, "/", "Unsupported archive format or coverage");
    const auto& excluded = excluded_types(version);
    std::set<std::string> omitted;
    for (const auto& item : array(root.at("excludedTypes"), "/excludedTypes", excluded.size())) {
        auto type = string(item, "/excludedTypes", 64);
        if (std::find(excluded.begin(), excluded.end(), type) == excluded.end() ||
            !omitted.insert(type).second)
            fail(ArchiveErrorCode::UnsupportedType, "/excludedTypes", "Unknown or repeated excluded type");
    }
    if (omitted.size() != excluded.size())
        fail(ArchiveErrorCode::InvalidFormat, "/excludedTypes", "All unsupported coverage must be declared");
    auto data = std::make_shared<ArchiveDocument::Data>();
    data->version = version;
    data->source_bytes = bytes.size();
    std::set<std::string> bots;
    std::size_t index = 0;
    for (const auto& item : array(root.at("bots"), "/bots", limits.max_bots)) {
        const auto path = "/bots/" + std::to_string(index++);
        fields(item, {"id", "name", "persona", "inChat", "inWork"}, path);
        Bot bot{bot_id(item.at("id"), path + "/id"), string(item.at("name"), path + "/name", 1024),
            string(item.at("persona"), path + "/persona", 262144, true),
            boolean(item.at("inChat"), path + "/inChat"), boolean(item.at("inWork"), path + "/inWork")};
        canonical_trim(bot.name, path + "/name");
        if (!bots.insert(bot.id).second)
            fail(ArchiveErrorCode::InvalidReference, path + "/id", "Duplicate Bot identity");
        data->bots.push_back(std::move(bot));
    }
    std::map<std::string, std::size_t> groups;
    if (version >= 2) {
        index = 0;
        for (const auto& item : array(root.at("groups"), "/groups", limits.max_groups)) {
            const auto path = "/groups/" + std::to_string(index++);
            fields(item, {"id", "name", "ownerId", "admins", "members", "historyMembers",
                          "inChat", "inWork", "deleted", "seal", "revision"}, path);
            Group group;
            group.id = group_id(item.at("id"), path + "/id");
            group.name = string(item.at("name"), path + "/name", 1024);
            canonical_trim(group.name, path + "/name");
            group.owner_id = bot_id(item.at("ownerId"), path + "/ownerId");
            group.members = bot_references(item.at("members"), path + "/members", 16, bots);
            group.history_members = bot_references(item.at("historyMembers"), path + "/historyMembers", 1024, bots);
            group.admins = bot_references(item.at("admins"), path + "/admins", 16, bots);
            if (group.members.empty())
                fail(ArchiveErrorCode::InvalidRecord, path + "/members", "A group needs at least one member");
            if (!contains(group.members, group.owner_id))
                fail(ArchiveErrorCode::InvalidReference, path + "/ownerId", "Group owner must be a member");
            for (const auto& member : group.members)
                if (!contains(group.history_members, member))
                    fail(ArchiveErrorCode::InvalidReference, path + "/historyMembers", "Group history must include every member");
            for (const auto& admin : group.admins)
                if (!contains(group.members, admin))
                    fail(ArchiveErrorCode::InvalidReference, path + "/admins", "Group admins must be members");
            group.in_chat = boolean(item.at("inChat"), path + "/inChat");
            group.in_work = boolean(item.at("inWork"), path + "/inWork");
            group.deleted = boolean(item.at("deleted"), path + "/deleted");
            if (group.deleted && (group.in_chat || group.in_work))
                fail(ArchiveErrorCode::InvalidRecord, path, "Deleted group cannot be in a roster");
            const auto& seal = item.at("seal");
            fields(seal, {"shape", "color"}, path + "/seal");
            group.seal_shape = seal_token(seal.at("shape"), path + "/seal/shape");
            group.seal_color = seal_token(seal.at("color"), path + "/seal/color");
            group.revision = integer(item.at("revision"), path + "/revision", true);
            if (!groups.emplace(group.id, data->groups.size()).second)
                fail(ArchiveErrorCode::InvalidReference, path + "/id", "Duplicate Group identity");
            data->groups.push_back(std::move(group));
        }
    }
    const auto group_reference = [&](const std::string& group, const std::string& bot,
                                     const std::string& path) -> const Group* {
        if (version == 1 || group.empty()) return nullptr;
        const auto found = groups.find(group);
        if (found == groups.end())
            fail(ArchiveErrorCode::InvalidReference, path + "/groupId", "Unknown Group reference");
        const auto& definition = data->groups[found->second];
        if (!contains(definition.history_members, bot))
            fail(ArchiveErrorCode::InvalidReference, path + "/botId", "Bot is outside group history membership");
        return &definition;
    };
    std::set<std::tuple<std::string, Mode, std::string>> scopes;
    std::set<Id> message_ids, memory_ids;
    std::size_t message_count = 0;
    index = 0;
    for (const auto& item : array(root.at("conversations"), "/conversations", limits.max_conversations)) {
        const auto path = "/conversations/" + std::to_string(index++);
        fields(item, {"botId", "groupId", "mode", "messages"}, path);
        ArchiveConversation conversation{bot_id(item.at("botId"), path + "/botId"),
            scope(item.at("groupId"), path + "/groupId", version), mode(item.at("mode"), path + "/mode"), {}};
        if (!bots.contains(conversation.bot_id) ||
            !scopes.emplace(conversation.bot_id, conversation.mode, conversation.group_id).second)
            fail(ArchiveErrorCode::InvalidReference, path, "Unknown Bot or duplicate conversation scope");
        const auto& messages = array(item.at("messages"), path + "/messages", limits.max_messages);
        const auto* group = group_reference(conversation.group_id, conversation.bot_id, path);
        if (group && group->deleted && !messages.empty())
            fail(ArchiveErrorCode::InvalidReference, path + "/messages", "Deleted group cannot carry message history");
        charge(message_count, messages.size(), limits.max_messages, "/conversations");
        std::size_t message_index = 0;
        for (const auto& value : messages) {
            const auto message_path = path + "/messages/" + std::to_string(message_index++);
            if (version == 3 && value.find("context"))
                fields(value, {"id", "actor", "text", "createdAtMs", "context"}, message_path);
            else fields(value, {"id", "actor", "text", "createdAtMs"}, message_path);
            Message message{integer(value.at("id"), message_path + "/id", true), conversation.bot_id,
                conversation.group_id, conversation.mode, string(value.at("actor"), message_path + "/actor", 6),
                string(value.at("text"), message_path + "/text", 1048576),
                integer(value.at("createdAtMs"), message_path + "/createdAtMs", false)};
            if (message.actor != "user" && message.actor != "bot" && message.actor != "system")
                fail(ArchiveErrorCode::UnsupportedType, message_path + "/actor", "Unsupported message actor");
            if (const auto* context = value.find("context")) {
                try {
                    message.context = parse_message_context(*context);
                    validate_message_context_scope(*message.context, message.bot_id, message.group_id, message.mode, message.actor);
                } catch (...) { fail(ArchiveErrorCode::InvalidRecord, message_path + "/context", "Invalid message source context"); }
                // A deleted or intentionally omitted source is represented by
                // its immutable namespaced snapshot, never by a local FK.
            }
            if (!message_ids.insert(message.id).second)
                fail(ArchiveErrorCode::InvalidReference, message_path + "/id", "Duplicate source message ID");
            conversation.messages.push_back(std::move(message));
        }
        data->conversations.push_back(std::move(conversation));
    }
    std::set<std::tuple<std::string, std::string, std::string>> memory_keys;
    std::set<std::tuple<std::string, std::string, std::string, std::string>> impression_keys;
    std::set<std::pair<std::string, std::string>> relation_keys;
    index = 0;
    for (const auto& item : array(root.at("memories"), "/memories", limits.max_memories)) {
        const auto path = "/memories/" + std::to_string(index++);
        fields(item, {"id", "botId", "groupId", "text", "state", "revision", "sourceActor"}, path,
            {"kind", "eventTimeMs", "sourceRef", "participants", "userChoice", "outcome",
             "targetBotId", "evidence", "applicableScenarios", "supersedesId"});
        Memory memory{integer(item.at("id"), path + "/id", true), bot_id(item.at("botId"), path + "/botId"),
            scope(item.at("groupId"), path + "/groupId", version), string(item.at("text"), path + "/text", 262144),
            memory_state(item.at("state"), path + "/state"), integer(item.at("revision"), path + "/revision", true),
            string(item.at("sourceActor"), path + "/sourceActor", 4)};
        if (const auto* kind = item.find("kind")) memory.kind = string(*kind, path + "/kind", 16);
        if (const auto* stamp = item.find("eventTimeMs")) memory.event_time_ms = integer(*stamp, path + "/eventTimeMs", false);
        if (const auto* source = item.find("sourceRef")) memory.source_ref = string(*source, path + "/sourceRef", 256, true);
        if (const auto* participants = item.find("participants")) memory.participants = string(*participants, path + "/participants", 4000, true);
        if (const auto* choice = item.find("userChoice")) memory.user_choice = string(*choice, path + "/userChoice", 4000, true);
        if (const auto* outcome = item.find("outcome")) memory.outcome = string(*outcome, path + "/outcome", 4000, true);
        if (const auto* target = item.find("targetBotId")) {
            memory.target_bot_id = string(*target, path + "/targetBotId", 128, true);
            if (!memory.target_bot_id.empty()) memory.target_bot_id = bot_id(*target, path + "/targetBotId");
        }
        if (const auto* evidence = item.find("evidence")) memory.evidence = string(*evidence, path + "/evidence", 16384, true);
        if (const auto* scenarios = item.find("applicableScenarios")) memory.applicable_scenarios = string(*scenarios, path + "/applicableScenarios", 8192, true);
        if (const auto* previous = item.find("supersedesId")) memory.supersedes_id = integer(*previous, path + "/supersedesId", false);
        if (memory.kind != "fact" && memory.kind != "episode" && memory.kind != "impression")
            fail(ArchiveErrorCode::InvalidRecord, path + "/kind", "Unsupported memory kind");
        if (memory.kind == "episode" && (memory.event_time_ms <= 0 || memory.source_ref.empty() ||
            memory.participants.empty() || memory.user_choice.empty() || memory.outcome.empty()))
            fail(ArchiveErrorCode::InvalidRecord, path, "Episode provenance is incomplete");
        if (memory.kind == "impression" && (memory.event_time_ms <= 0 || memory.group_id.empty() ||
            memory.target_bot_id.empty() || memory.target_bot_id == memory.bot_id || memory.source_ref.empty() ||
            memory.evidence.empty() || memory.applicable_scenarios.empty() || memory.supersedes_id < 0 ||
            (!memory.source_ref.starts_with("message:") && !memory.source_ref.starts_with("run:"))))
            fail(ArchiveErrorCode::InvalidRecord, path, "Directed impression provenance is incomplete");
        if (memory.kind != "impression" && (!memory.target_bot_id.empty() || !memory.evidence.empty() ||
            !memory.applicable_scenarios.empty() || memory.supersedes_id != 0))
            fail(ArchiveErrorCode::InvalidRecord, path, "Impression fields require kind=impression");
        canonical_trim(memory.text, path + "/text");
        if (memory.kind == "impression") {
            canonical_trim(memory.evidence, path + "/evidence");
            canonical_trim(memory.applicable_scenarios, path + "/applicableScenarios");
        }
        if (memory.source_actor != "user")
            fail(ArchiveErrorCode::InvalidRecord, path + "/sourceActor", "Memory source must be explicit user input");
        std::optional<RelationNote> note;
        try { note = parse_relation_note(memory.text); }
        catch (const StoreError&) {
            fail(ArchiveErrorCode::InvalidRecord, path + "/text", "Invalid reserved relation note");
        }
        if (note) {
            if (!memory.group_id.empty() || memory.state != MemoryState::Confirmed)
                fail(ArchiveErrorCode::InvalidRecord, path, "Relation notes must be confirmed private memories");
            if (!relation_keys.emplace(memory.bot_id, note->key).second)
                fail(ArchiveErrorCode::InvalidReference, path, "Duplicate relation note field for this Bot");
        }
        const bool duplicate = memory.kind == "impression"
            ? !impression_keys.emplace(memory.bot_id, memory.target_bot_id, memory.group_id, memory.source_ref).second
            : !memory_keys.emplace(memory.bot_id, memory.group_id, memory.text).second;
        if (!bots.contains(memory.bot_id) || (memory.kind == "impression" && !bots.contains(memory.target_bot_id)) ||
            !memory_ids.insert(memory.id).second || duplicate)
            fail(ArchiveErrorCode::InvalidReference, path, "Unknown Bot or duplicate memory identity");
        (void)group_reference(memory.group_id, memory.bot_id, path);
        if (memory.kind == "impression") (void)group_reference(memory.group_id, memory.target_bot_id, path);
        data->memories.push_back(std::move(memory));
    }
    std::map<Id, const Memory*> impression_by_id;
    for (const auto& memory : data->memories) impression_by_id.emplace(memory.id, &memory);
    for (const auto& memory : data->memories) if (memory.kind == "impression" && memory.supersedes_id) {
        const auto found = impression_by_id.find(memory.supersedes_id);
        if (found == impression_by_id.end() || memory.supersedes_id >= memory.id || found->second->kind != "impression" ||
            found->second->bot_id != memory.bot_id || found->second->target_bot_id != memory.target_bot_id ||
            found->second->group_id != memory.group_id || found->second->source_ref == memory.source_ref ||
            (memory.state == MemoryState::Confirmed && found->second->state == MemoryState::Confirmed))
            fail(ArchiveErrorCode::InvalidReference, "/memories", "Invalid directed impression correction chain");
    }
    if (const auto* incoming = root.find("midMemories")) {
        std::set<Id> ids;
        std::set<std::tuple<std::string, std::string, std::string>> keys;
        std::map<std::pair<std::string, std::string>, std::size_t> scopes;
        index = 0;
        for (const auto& item : array(*incoming, "/midMemories", std::min(limits.max_mid_memories, mid_memory_total_limit))) {
            const auto path = "/midMemories/" + std::to_string(index++);
            fields(item, {"id", "botId", "groupId", "text", "sourceActor", "revision", "createdAtMs", "updatedAtMs", "expiresAtMs", "strength"}, path);
            MidMemory memory{integer(item.at("id"), path + "/id", true), bot_id(item.at("botId"), path + "/botId"),
                group_id(item.at("groupId"), path + "/groupId", true), string(item.at("text"), path + "/text", mid_memory_text_limit),
                string(item.at("sourceActor"), path + "/sourceActor", 4), integer(item.at("revision"), path + "/revision", true),
                integer(item.at("createdAtMs"), path + "/createdAtMs", false), integer(item.at("updatedAtMs"), path + "/updatedAtMs", false),
                integer(item.at("expiresAtMs"), path + "/expiresAtMs", false)};
            canonical_trim(memory.text, path + "/text");
            const auto& strength = item.at("strength");
            if (!strength.is_number() || strength.as_number() < 1 || strength.as_number() > mid_memory_strength_limit ||
                strength.as_number() != static_cast<std::int64_t>(strength.as_number()))
                fail(ArchiveErrorCode::InvalidRecord, path + "/strength", "Invalid middle-term memory strength");
            memory.strength = static_cast<std::int64_t>(strength.as_number());
            if (memory.source_actor != "user" || memory.created_at_ms < 0 || memory.updated_at_ms < memory.created_at_ms ||
                memory.expires_at_ms <= memory.created_at_ms)
                fail(ArchiveErrorCode::InvalidRecord, path, "Invalid middle-term memory lifecycle");
            if (!bots.contains(memory.bot_id) || !ids.insert(memory.id).second ||
                !keys.emplace(memory.bot_id, memory.group_id, memory.text).second)
                fail(ArchiveErrorCode::InvalidReference, path, "Unknown Bot or duplicate middle-term memory identity");
            if (++scopes[{memory.bot_id, memory.group_id}] > mid_memory_scope_limit)
                fail(ArchiveErrorCode::LimitExceeded, path, "Middle-term memory scope limit exceeded");
            (void)group_reference(memory.group_id, memory.bot_id, path);
            data->mid_memories.push_back(std::move(memory));
        }
    }
    return ArchiveDocument(std::move(data));
}

std::string encode_archive(const ArchiveDocument& archive) {
    A bots, groups, conversations, memories, mid_memories;
    for (const auto& bot : archive.bots())
        bots.emplace_back(O{{"id", bot.id}, {"name", bot.name}, {"persona", bot.persona},
                            {"inChat", bot.in_chat}, {"inWork", bot.in_work}});
    for (const auto& group : archive.groups())
        groups.emplace_back(O{{"id", group.id}, {"name", group.name}, {"ownerId", group.owner_id},
                              {"admins", strings(group.admins)}, {"members", strings(group.members)},
                              {"historyMembers", strings(group.history_members)}, {"inChat", group.in_chat},
                              {"inWork", group.in_work}, {"deleted", group.deleted},
                              {"seal", O{{"shape", group.seal_shape}, {"color", group.seal_color}}},
                              {"revision", std::to_string(group.revision)}});
    for (const auto& conversation : archive.conversations()) {
        A messages;
        for (const auto& message : conversation.messages) {
            O row{{"id", std::to_string(message.id)}, {"actor", message.actor}, {"text", message.text},
                  {"createdAtMs", std::to_string(message.created_at_ms)}};
            if (message.context) row.emplace("context", message_context_json(*message.context));
            messages.emplace_back(std::move(row));
        }
        conversations.emplace_back(O{{"botId", conversation.bot_id}, {"groupId", conversation.group_id},
                                     {"mode", mode_name(conversation.mode)}, {"messages", std::move(messages)}});
    }
    for (const auto& memory : archive.memories()) {
        auto row = O{{"id", std::to_string(memory.id)}, {"botId", memory.bot_id}, {"groupId", memory.group_id},
                     {"text", memory.text}, {"state", state_name(memory.state)},
                     {"revision", std::to_string(memory.revision)}, {"sourceActor", memory.source_actor},
                     {"kind", memory.kind}, {"eventTimeMs", std::to_string(memory.event_time_ms)},
                     {"sourceRef", memory.source_ref}, {"participants", memory.participants},
                     {"userChoice", memory.user_choice}, {"outcome", memory.outcome}};
        if (memory.kind == "impression") {
            row.emplace("targetBotId", memory.target_bot_id); row.emplace("evidence", memory.evidence);
            row.emplace("applicableScenarios", memory.applicable_scenarios);
            row.emplace("supersedesId", std::to_string(memory.supersedes_id));
        }
        memories.emplace_back(std::move(row));
    }
    for (const auto& m : archive.mid_memories()) mid_memories.emplace_back(O{
        {"id", std::to_string(m.id)}, {"botId", m.bot_id}, {"groupId", m.group_id}, {"text", m.text}, {"sourceActor", m.source_actor},
        {"revision", std::to_string(m.revision)}, {"createdAtMs", std::to_string(m.created_at_ms)},
        {"updatedAtMs", std::to_string(m.updated_at_ms)}, {"expiresAtMs", std::to_string(m.expires_at_ms)}, {"strength", static_cast<double>(m.strength)}});
    O root{{"format", "dimension-conversation-archive"}, {"version", archive.version()},
           {"coverage", archive.version() >= 2 ? "conversation-and-group-data" : "conversation-data-only"},
           {"excludedTypes", exclusions(archive.version())}, {"bots", std::move(bots)},
           {"conversations", std::move(conversations)}, {"memories", std::move(memories)}};
    if (archive.version() >= 2) root.emplace("groups", std::move(groups));
    if (!mid_memories.empty()) root.emplace("midMemories", std::move(mid_memories));
    return Json(std::move(root)).dump();
}

Json preflight_archive(const ArchiveDocument& archive, const Store& target, ArchiveLimits limits) {
    limits_valid(limits);
    Counts bots, groups, messages, memories, mid_memories;
    bots.incoming = archive.bots().size(); memories.incoming = archive.memories().size();
    groups.incoming = archive.groups().size();
    mid_memories.incoming = archive.mid_memories().size();
    if (archive.size_bytes() > limits.max_bytes || bots.incoming > limits.max_bots || memories.incoming > limits.max_memories ||
        archive.conversations().size() > limits.max_conversations || groups.incoming > limits.max_groups ||
        mid_memories.incoming > limits.max_mid_memories)
        fail(ArchiveErrorCode::LimitExceeded, "/", "Archive preflight record limit exceeded");
    A details, blockers, losses;
    std::size_t detail_count = 0, new_scopes = 0, existing_scopes = 0, empty_scopes = 0;
    auto detail = [&](Json value) {
        ++detail_count;
        if (details.size() < limits.max_report_items) details.push_back(std::move(value));
    };
    TargetBudget budget{limits};
    std::set<std::string> existing_bots, conflict_bots, existing_groups;
    std::set<std::pair<std::string, std::string>> group_scopes;
    for (const auto& bot : archive.bots()) {
        const auto current = target.find_bot(bot.id);
        if (!current) { ++bots.additions; detail(issue("bot", "add", bot.id, bot.id, "")); continue; }
        existing_bots.insert(bot.id);
        budget.add(current->id.size() + current->name.size() + current->persona.size() + 64);
        A changed;
        if (current->name != bot.name) changed.emplace_back("name");
        if (current->persona != bot.persona) changed.emplace_back("persona");
        if (current->in_chat != bot.in_chat) changed.emplace_back("inChat");
        if (current->in_work != bot.in_work) changed.emplace_back("inWork");
        const bool same = changed.empty();
        if (same) ++bots.same;
        else { ++bots.conflicts; conflict_bots.insert(bot.id); }
        detail(issue("bot", same ? "same-candidate" : "conflict", bot.id, bot.id, "", std::move(changed)));
    }
    for (const auto& group : archive.groups()) {
        const auto current = target.find_group(group.id);
        if (!current) {
            ++groups.additions;
            detail(issue("group", "add", "", group.id, group.id));
            continue;
        }
        existing_groups.insert(group.id);
        std::size_t bytes = current->id.size() + current->name.size() + current->owner_id.size() +
            current->seal_shape.size() + current->seal_color.size() + 128;
        for (const auto* refs : {&current->members, &current->history_members, &current->admins})
            for (const auto& ref : *refs) bytes += ref.size() + 8;
        budget.add(bytes);
        A changed;
        if (current->name != group.name) changed.emplace_back("name");
        if (current->owner_id != group.owner_id) changed.emplace_back("ownerId");
        if (current->admins != group.admins) changed.emplace_back("admins");
        if (current->members != group.members) changed.emplace_back("members");
        if (current->history_members != group.history_members) changed.emplace_back("historyMembers");
        if (current->in_chat != group.in_chat) changed.emplace_back("inChat");
        if (current->in_work != group.in_work) changed.emplace_back("inWork");
        if (current->deleted != group.deleted) changed.emplace_back("deleted");
        if (current->seal_shape != group.seal_shape) changed.emplace_back("seal.shape");
        if (current->seal_color != group.seal_color) changed.emplace_back("seal.color");
        if (current->revision != group.revision) changed.emplace_back("revision");
        const bool same = changed.empty();
        if (same) ++groups.same; else ++groups.conflicts;
        detail(issue("group", same ? "same-candidate" : "conflict", "", group.id, group.id, std::move(changed)));
    }
    // Small public pages bound transient allocations even before charging bytes.
    constexpr std::size_t page_size = 8;
    for (const auto& conversation : archive.conversations()) {
        if (!conversation.group_id.empty()) group_scopes.emplace(conversation.bot_id, conversation.group_id);
        if (conversation.messages.empty() && (archive.version() == 1 || conversation.group_id.empty()))
            ++empty_scopes;
        charge(messages.incoming, conversation.messages.size(), limits.max_messages, "/conversations");
        using Key = std::tuple<std::int64_t, std::string, std::string, std::string>;
        std::map<Key, std::vector<Id>> candidates;
        std::size_t target_count = 0;
        if (existing_bots.contains(conversation.bot_id)) {
            std::optional<Id> before;
            for (;;) {
                const auto page = target.messages(conversation.bot_id, conversation.mode, conversation.group_id, page_size, before);
                if (page.empty()) break;
                for (const auto& message : page) {
                    const auto context = message.context ? message_context_json(*message.context).dump() : "";
                    budget.add(message.bot_id.size() + message.group_id.size() + message.actor.size() + message.text.size() + context.size() + 64);
                    candidates[{message.created_at_ms, message.actor, message.text, context}].push_back(message.id);
                    ++target_count;
                }
                before = page.back().id;
                if (page.size() < page_size) break;
            }
        }
        const bool existing_scope = archive.version() >= 2 && !conversation.group_id.empty()
            ? existing_groups.contains(conversation.group_id) : target_count != 0;
        if (existing_scope) ++existing_scopes; else ++new_scopes;
        for (const auto& message : conversation.messages) {
            auto found = candidates.find({message.created_at_ms, message.actor, message.text,
                message.context ? message_context_json(*message.context).dump() : ""});
            const bool same = found != candidates.end() && !found->second.empty();
            if (same) ++messages.same; else ++messages.additions;
            auto item = issue("message", same ? "same-candidate" : "add", message.bot_id,
                              std::to_string(message.id), message.group_id).as_object();
            item.emplace("mode", mode_name(message.mode));
            if (same) {
                item.emplace("targetId", std::to_string(found->second.back()));
                found->second.pop_back(); // A target row can match only one source row.
            }
            detail(std::move(item));
        }
    }
    // Read only scopes represented by incoming memories; do not scan other groups.
    std::map<std::pair<std::string, std::string>, std::vector<const Memory*>> incoming_scopes;
    for (const auto& memory : archive.memories()) {
        incoming_scopes[{memory.bot_id, memory.group_id}].push_back(&memory);
        if (!memory.group_id.empty()) group_scopes.emplace(memory.bot_id, memory.group_id);
    }
    const auto memory_key = [](const Memory& memory) {
        return memory.kind == "impression"
            ? std::make_tuple(memory.bot_id, memory.target_bot_id, memory.source_ref)
            : std::make_tuple(memory.bot_id, std::string{}, memory.text);
    };
    for (const auto& [scope, incoming] : incoming_scopes) {
        std::map<std::tuple<std::string, std::string, std::string>, Memory> current;
        if (existing_bots.contains(scope.first)) {
            std::optional<Id> before;
            for (;;) {
                const auto page = target.list_memories(scope.first, std::string_view(scope.second), true, page_size, before);
                if (page.empty()) break;
                for (const auto& memory : page) {
                    budget.add(memory.bot_id.size() + memory.group_id.size() + memory.text.size() + memory.source_actor.size() + 64);
                    current.emplace(memory_key(memory), memory);
                }
                before = page.back().id;
                if (page.size() < page_size) break;
            }
        }
        for (const auto* memory : incoming) {
            const auto found = current.find(memory_key(*memory));
            A changed;
            if (found != current.end()) {
                if (found->second.state != memory->state) changed.emplace_back("state");
                if (found->second.revision != memory->revision) changed.emplace_back("revision");
                if (found->second.source_actor != memory->source_actor || found->second.kind != memory->kind ||
                    found->second.event_time_ms != memory->event_time_ms || found->second.source_ref != memory->source_ref ||
                    found->second.participants != memory->participants || found->second.user_choice != memory->user_choice ||
                    found->second.outcome != memory->outcome || found->second.target_bot_id != memory->target_bot_id ||
                    found->second.evidence != memory->evidence || found->second.applicable_scenarios != memory->applicable_scenarios ||
                    found->second.supersedes_id != memory->supersedes_id) changed.emplace_back("provenance");
            }
            const bool same = found != current.end() && changed.empty();
            if (found == current.end()) ++memories.additions;
            else if (same) ++memories.same;
            else ++memories.conflicts;
            auto item = issue("memory", found == current.end() ? "add" : same ? "same-candidate" : "conflict",
                              memory->bot_id, std::to_string(memory->id), memory->group_id, std::move(changed)).as_object();
            if (found != current.end()) item.emplace("targetId", std::to_string(found->second.id));
            detail(std::move(item));
        }
    }
    std::map<std::pair<std::string, std::string>, std::map<std::string, MidMemory>> mid_targets;
    for (const auto& memory : archive.mid_memories()) {
        const auto key = std::make_pair(memory.bot_id, memory.group_id);
        auto target_scope = mid_targets.find(key);
        if (target_scope == mid_targets.end()) {
            std::map<std::string, MidMemory> values;
            if (existing_bots.contains(memory.bot_id)) for (const auto& row : target.list_mid_memories(memory.bot_id, memory.group_id)) {
                budget.add(row.bot_id.size() + row.group_id.size() + row.text.size() + row.source_actor.size() + 128);
                values.emplace(row.text, row);
            }
            target_scope = mid_targets.emplace(key, std::move(values)).first;
        }
        const auto found = target_scope->second.find(memory.text);
        A changed;
        if (found != target_scope->second.end()) {
            const auto& row = found->second;
            if (row.revision != memory.revision) changed.emplace_back("revision");
            if (row.source_actor != memory.source_actor) changed.emplace_back("sourceActor");
            if (row.created_at_ms != memory.created_at_ms) changed.emplace_back("createdAtMs");
            if (row.updated_at_ms != memory.updated_at_ms) changed.emplace_back("updatedAtMs");
            if (row.expires_at_ms != memory.expires_at_ms) changed.emplace_back("expiresAtMs");
            if (row.strength != memory.strength) changed.emplace_back("strength");
        }
        const bool same = found != target_scope->second.end() && changed.empty();
        if (found == target_scope->second.end()) ++mid_memories.additions;
        else if (same) ++mid_memories.same;
        else ++mid_memories.conflicts;
        auto item = issue("mid-memory", found == target_scope->second.end() ? "add" : same ? "same-candidate" : "conflict",
            memory.bot_id, std::to_string(memory.id), memory.group_id, std::move(changed)).as_object();
        if (found != target_scope->second.end()) item.emplace("targetId", std::to_string(found->second.id));
        detail(std::move(item));
    }
    blockers.emplace_back(O{{"code", "staging-with-explicit-policies-required"}});
    if (archive.version() == 1 && !group_scopes.empty())
        blockers.emplace_back(O{{"code", "group-metadata-unsupported"}, {"scopes", static_cast<double>(group_scopes.size())}});
    if (!conflict_bots.empty())
        blockers.emplace_back(O{{"code", "bot-conflicts-require-policy"}, {"count", static_cast<double>(conflict_bots.size())}});
    if (memories.conflicts)
        blockers.emplace_back(O{{"code", "memory-conflicts-preserve-existing"}, {"count", static_cast<double>(memories.conflicts)}});
    if (groups.conflicts)
        blockers.emplace_back(O{{"code", "group-conflicts-require-policy"}, {"count", static_cast<double>(groups.conflicts)}});
    if (mid_memories.conflicts)
        blockers.emplace_back(O{{"code", "mid-memory-conflicts-preserve-existing"}, {"count", static_cast<double>(mid_memories.conflicts)}});
    auto loss = [&](const char* code, std::size_t count) {
        if (count) losses.emplace_back(O{{"code", code}, {"count", static_cast<double>(count)}});
    };
    loss("source-record-ids-require-mapping", messages.incoming + memories.incoming + mid_memories.incoming);
    loss("empty-conversation-scopes-not-persistable", empty_scopes);
    O report{{"format", "dimension-archive-preflight"}, {"version", 1}, {"archiveVersion", archive.version()}, {"archiveValid", true},
             {"advisory", true}, {"readOnly", true}, {"importImplemented", true}, {"canImport", false},
             {"importCoverage", archive.version() >= 2 ? "conversation-and-group-data" : "private-conversation-data-only"},
             {"commitRequiresStaging", true},
             {"preservedByStagedImport", A{"source-id-mapping", "historical-message-timestamps", "memory-revisions"}},
             {"targetSnapshot", "non-atomic-public-reads"}, {"requiresCommitRecheck", true},
             {"requiresExplicitConflictPolicy", true}, {"defaultMemoryPolicy", "preserve-existing"},
             {"messageMatching", "content-time-candidates-only-source-ids-not-target-identity"},
             {"excludedTypes", exclusions(archive.version())}, {"blockers", std::move(blockers)}, {"potentialLosses", std::move(losses)},
             {"counts", O{{"bots", bots.json()}, {"messages", messages.json()}, {"memories", memories.json()},
                         {"conversationScopes", O{{"incoming", static_cast<double>(archive.conversations().size())},
                             {"new", static_cast<double>(new_scopes)}, {"existing", static_cast<double>(existing_scopes)},
                             {"unsupportedGroups", archive.version() == 1 ? static_cast<double>(group_scopes.size()) : 0.0}}}}},
             {"details", std::move(details)}, {"detailCount", static_cast<double>(detail_count)},
             {"detailsTruncated", detail_count > limits.max_report_items},
             {"targetRecordsRead", static_cast<double>(budget.records)}, {"targetBytesRead", static_cast<double>(budget.bytes)}};
    if (archive.version() >= 2) {
        auto counts = report.at("counts").as_object();
        counts.emplace("groups", groups.json());
        report["counts"] = std::move(counts);
        report["requiredPolicies"] = A{"bots", "memories", "groups"};
        report["groupPolicies"] = A{"preserve-existing", "reject-conflicts"};
        report["applicationSettingsCompared"] = false;
        report["applicationSettingsRestored"] = false;
        report["completeApplicationRestore"] = false;
        report["preservedByStagedImport"] = A{"source-id-mapping", "historical-message-timestamps", "memory-revisions",
                                               "group-identities", "group-membership", "group-seals", "group-revisions"};
    }
    if (archive.version() == 3) {
        report["messageSourceContextsPreserved"] = true;
        auto counts = report.at("counts").as_object(); counts.emplace("midMemories", mid_memories.json()); report["counts"] = counts;
        report["midMemoryExpiryPreserved"] = true;
    }
    return report;
}
} // namespace dimension
