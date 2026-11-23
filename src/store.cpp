#include "dimension/store.hpp"
#include "dimension/archive.hpp"
#include "dimension/relation_notes.hpp"
#include "dimension/message_context.hpp"

#ifndef _WIN32
#error This data service requires the Windows system winsqlite3.dll.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <Windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <initializer_list>
#include <limits>
#include <map>
#include <mutex>
#include <random>
#include <set>
#include <utility>

namespace dimension {
namespace {

// These are declarations of the system SQLite C ABI, not a bundled SQLite
// implementation. Every function is resolved from Windows' own DLL.
struct sqlite3;
struct sqlite3_stmt;
using SqliteDestructor = void(__cdecl*)(void*);
using SqliteCallback = int(__cdecl*)(void*, int, char**, char**);
constexpr int sqlite_ok = 0;
constexpr int sqlite_constraint = 19;
constexpr int sqlite_row = 100;
constexpr int sqlite_done = 101;
constexpr int sqlite_open_readonly = 0x00000001;
constexpr int sqlite_open_readwrite = 0x00000002;
constexpr int sqlite_open_create = 0x00000004;
constexpr int sqlite_open_fullmutex = 0x00010000;
constexpr int application_id = 0x44494d41; // DIMA
constexpr const char* message_receipt_schema = R"SQL(
CREATE TABLE message_receipts (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK(mode IN ('chat','work')),
    group_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
    PRIMARY KEY(bot_id,mode,group_id,request_key)
) WITHOUT ROWID;
PRAGMA user_version=2;
)SQL";

struct SqliteApi final {
    HMODULE module{};
    int(__cdecl* open_v2)(const char*, sqlite3**, int, const char*){};
    int(__cdecl* close_v2)(sqlite3*){};
    const char*(__cdecl* errmsg)(sqlite3*){};
    int(__cdecl* busy_timeout)(sqlite3*, int){};
    int(__cdecl* exec)(sqlite3*, const char*, SqliteCallback, void*, char**){};
    int(__cdecl* prepare_v2)(sqlite3*, const char*, int, sqlite3_stmt**, const char**){};
    int(__cdecl* finalize)(sqlite3_stmt*){};
    int(__cdecl* bind_text)(sqlite3_stmt*, int, const char*, int, SqliteDestructor){};
    int(__cdecl* bind_int64)(sqlite3_stmt*, int, std::int64_t){};
    int(__cdecl* step)(sqlite3_stmt*){};
    std::int64_t(__cdecl* column_int64)(sqlite3_stmt*, int){};
    const unsigned char*(__cdecl* column_text)(sqlite3_stmt*, int){};
    int(__cdecl* column_bytes)(sqlite3_stmt*, int){};
    std::int64_t(__cdecl* last_insert_rowid)(sqlite3*){};
    int(__cdecl* changes)(sqlite3*){};

    template <class Function>
    void resolve(Function& target, const char* name) {
        const auto address = GetProcAddress(module, name);
        if (address == nullptr) {
            throw StoreError(StoreErrorCode::Storage,
                std::string("The system SQLite DLL does not export ") + name);
        }
        target = reinterpret_cast<Function>(address);
    }

    SqliteApi() {
        // Resolve the system path explicitly so a same-named project DLL cannot
        // replace the Windows dependency through the DLL search order.
        std::array<wchar_t, 32768> system_path{};
        const auto size = GetSystemDirectoryW(system_path.data(),
            static_cast<UINT>(system_path.size()));
        if (size == 0 || size >= system_path.size()) {
            throw StoreError(StoreErrorCode::Storage, "Cannot locate the Windows system directory");
        }
        const auto dll_path = std::wstring(system_path.data(), size) + L"\\winsqlite3.dll";
        module = LoadLibraryW(dll_path.c_str());
        if (module == nullptr) {
            throw StoreError(StoreErrorCode::Storage,
                "Cannot load the Windows system winsqlite3.dll (error " +
                std::to_string(GetLastError()) + ")");
        }
        try {
            resolve(open_v2, "sqlite3_open_v2");
            resolve(close_v2, "sqlite3_close_v2");
            resolve(errmsg, "sqlite3_errmsg");
            resolve(busy_timeout, "sqlite3_busy_timeout");
            resolve(exec, "sqlite3_exec");
            resolve(prepare_v2, "sqlite3_prepare_v2");
            resolve(finalize, "sqlite3_finalize");
            resolve(bind_text, "sqlite3_bind_text");
            resolve(bind_int64, "sqlite3_bind_int64");
            resolve(step, "sqlite3_step");
            resolve(column_int64, "sqlite3_column_int64");
            resolve(column_text, "sqlite3_column_text");
            resolve(column_bytes, "sqlite3_column_bytes");
            resolve(last_insert_rowid, "sqlite3_last_insert_rowid");
            resolve(changes, "sqlite3_changes");
        } catch (...) {
            FreeLibrary(module);
            module = nullptr;
            throw;
        }
    }

    ~SqliteApi() { if (module != nullptr) FreeLibrary(module); }
    SqliteApi(const SqliteApi&) = delete;
    SqliteApi& operator=(const SqliteApi&) = delete;
};

SqliteApi& sqlite_api() {
    static SqliteApi api;
    return api;
}

[[noreturn]] void database_error(SqliteApi& api, sqlite3* db, int result) {
    const auto kind = (result & 0xff) == sqlite_constraint
        ? StoreErrorCode::Conflict : StoreErrorCode::Storage;
    const char* message = db == nullptr ? nullptr : api.errmsg(db);
    throw StoreError(kind, std::string("SQLite operation failed: ") +
        (message == nullptr ? "unknown error" : message));
}

void execute(SqliteApi& api, sqlite3* db, const char* sql) {
    const int result = api.exec(db, sql, nullptr, nullptr, nullptr);
    if (result != sqlite_ok) database_error(api, db, result);
}

class Statement final {
public:
    Statement(SqliteApi& api, sqlite3* db, const std::string& sql) : api_(api), db_(db) {
        const int result = api_.prepare_v2(db_, sql.c_str(), -1, &statement_, nullptr);
        if (result != sqlite_ok) {
            if (statement_ != nullptr) api_.finalize(statement_);
            database_error(api_, db_, result);
        }
    }
    ~Statement() { if (statement_ != nullptr) api_.finalize(statement_); }
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;

    void bind(int index, std::string_view value) {
        if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            throw StoreError(StoreErrorCode::InvalidArgument, "Text exceeds SQLite's binding limit");
        }
        // SQLITE_TRANSIENT: SQLite takes an owned copy of each bound value.
        const auto transient = reinterpret_cast<SqliteDestructor>(static_cast<std::intptr_t>(-1));
        const int result = api_.bind_text(statement_, index,
            value.empty() ? "" : value.data(), static_cast<int>(value.size()), transient);
        if (result != sqlite_ok) database_error(api_, db_, result);
    }

    void bind(int index, std::int64_t value) {
        const int result = api_.bind_int64(statement_, index, value);
        if (result != sqlite_ok) database_error(api_, db_, result);
    }

    bool next() {
        const int result = api_.step(statement_);
        if (result == sqlite_row) return true;
        if (result == sqlite_done) return false;
        database_error(api_, db_, result);
    }

    void finish() {
        if (next()) throw StoreError(StoreErrorCode::Storage, "Unexpected SQLite result row");
    }

    std::int64_t integer(int index) const { return api_.column_int64(statement_, index); }
    std::size_t text_bytes(int index) const {
        return static_cast<std::size_t>(api_.column_bytes(statement_, index));
    }
    std::string text(int index) const {
        const auto* value = api_.column_text(statement_, index);
        const auto size = api_.column_bytes(statement_, index);
        return value == nullptr ? std::string{} : std::string(
            reinterpret_cast<const char*>(value), static_cast<std::size_t>(size));
    }

private:
    SqliteApi& api_;
    sqlite3* db_{};
    sqlite3_stmt* statement_{};
};

class Transaction final {
public:
    Transaction(SqliteApi& api, sqlite3* db, bool read_snapshot = false) : api_(api), db_(db) {
        execute(api_, db_, read_snapshot ? "BEGIN" : "BEGIN IMMEDIATE");
    }
    ~Transaction() {
        if (!committed_) api_.exec(db_, "ROLLBACK", nullptr, nullptr, nullptr);
    }
    void commit() {
        execute(api_, db_, "COMMIT");
        committed_ = true;
    }
    Transaction(const Transaction&) = delete;
    Transaction& operator=(const Transaction&) = delete;

private:
    SqliteApi& api_;
    sqlite3* db_{};
    bool committed_{};
};

bool ascii_space(unsigned char value) {
    return value == ' ' || value == '\t' || value == '\n' || value == '\r' ||
        value == '\v' || value == '\f';
}

std::string_view trim(std::string_view value) {
    while (!value.empty() && ascii_space(static_cast<unsigned char>(value.front()))) value.remove_prefix(1);
    while (!value.empty() && ascii_space(static_cast<unsigned char>(value.back()))) value.remove_suffix(1);
    return value;
}

// Return the byte width of a valid Unicode scalar value, rejecting overlong
// sequences, surrogates, truncated sequences, U+0000, and values > U+10FFFF.
std::size_t utf8_width(std::string_view text, std::size_t offset) {
    const auto lead = static_cast<unsigned char>(text[offset]);
    if (lead > 0 && lead < 0x80) return 1;
    std::size_t width{};
    std::uint32_t scalar{};
    std::uint32_t minimum{};
    if (lead >= 0xc2 && lead <= 0xdf) { width = 2; scalar = lead & 0x1f; minimum = 0x80; }
    else if (lead >= 0xe0 && lead <= 0xef) { width = 3; scalar = lead & 0x0f; minimum = 0x800; }
    else if (lead >= 0xf0 && lead <= 0xf4) { width = 4; scalar = lead & 0x07; minimum = 0x10000; }
    else throw StoreError(StoreErrorCode::InvalidArgument, "Text must be valid UTF-8 without NUL");
    if (width > text.size() - offset) {
        throw StoreError(StoreErrorCode::InvalidArgument, "Text contains truncated UTF-8");
    }
    for (std::size_t n = 1; n < width; ++n) {
        const auto byte = static_cast<unsigned char>(text[offset + n]);
        if ((byte & 0xc0) != 0x80) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid UTF-8 continuation");
        scalar = (scalar << 6) | (byte & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
        throw StoreError(StoreErrorCode::InvalidArgument, "Text contains an invalid Unicode scalar value");
    }
    return width;
}

void validate_text(std::string_view value, std::size_t maximum_bytes,
    bool allow_empty, std::string_view field) {
    if ((!allow_empty && value.empty()) || value.size() > maximum_bytes) {
        throw StoreError(StoreErrorCode::InvalidArgument,
            std::string(field) + " is empty or exceeds its byte limit");
    }
    for (std::size_t i = 0; i < value.size();) i += utf8_width(value, i);
}

void validate_bot_id(std::string_view value) {
    if (value.empty() || value.size() > 64 || value.front() < 'a' || value.front() > 'z') {
        throw StoreError(StoreErrorCode::InvalidArgument, "Bot ID must match [a-z][a-z0-9-]{0,63}");
    }
    for (const char c : value) {
        if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-') {
            throw StoreError(StoreErrorCode::InvalidArgument, "Bot ID must match [a-z][a-z0-9-]{0,63}");
        }
    }
}

void validate_scope(std::string_view scope) { validate_text(scope, 1024, true, "Group scope"); }

void validate_record_id(Id id) {
    if (id <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Record ID must be positive");
}

void validate_page(std::size_t limit, std::optional<Id> before) {
    if (limit == 0 || limit > 500) {
        throw StoreError(StoreErrorCode::InvalidArgument, "Page limit must be between 1 and 500");
    }
    if (before) validate_record_id(*before);
}

void validate_revision(std::int64_t revision) {
    if (revision <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Expected revision must be positive");
}

bool ascii_alnum(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

void validate_group_id(std::string_view value) {
    if (value.empty() || value.size() > 128 || !ascii_alnum(value.front()) ||
        std::any_of(value.begin(), value.end(), [](char c) {
            return !ascii_alnum(c) && c != '.' && c != '_' && c != ':' && c != '-';
        }))
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid group identity");
}

void validate_seal_token(std::string_view value) {
    if (value.size() > 32 || std::any_of(value.begin(), value.end(), [](char c) {
            return !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-';
        }))
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid group seal token");
}

bool contains(const std::vector<std::string>& values, std::string_view value) {
    return std::find(values.begin(), values.end(), value) != values.end();
}

void merge_history(std::vector<std::string>& history, const std::vector<std::string>& added) {
    for (const auto& id : added) if (!contains(history, id)) history.push_back(id);
    if (history.size() > 1024)
        throw StoreError(StoreErrorCode::InvalidArgument, "Group history exceeds 1024 members");
}

Group normalize_group(const Group& source) {
    Group group = source;
    validate_group_id(group.id);
    group.name = std::string(trim(group.name));
    validate_text(group.name, 1024, false, "Group name");
    validate_revision(group.revision);
    validate_bot_id(group.owner_id);
    validate_seal_token(group.seal_shape); validate_seal_token(group.seal_color);
    if (group.members.empty() || group.members.size() > 16)
        throw StoreError(StoreErrorCode::InvalidArgument, "A group needs 1 to 16 members");
    std::set<std::string> member_ids;
    for (const auto& id : group.members) {
        validate_bot_id(id);
        if (!member_ids.insert(id).second)
            throw StoreError(StoreErrorCode::InvalidArgument, "Group members must be unique");
    }
    if (!member_ids.contains(group.owner_id))
        throw StoreError(StoreErrorCode::InvalidArgument, "Group owner must be a current member");
    std::set<std::string> admin_ids;
    for (const auto& id : group.admins) {
        validate_bot_id(id);
        if (!member_ids.contains(id) || !admin_ids.insert(id).second)
            throw StoreError(StoreErrorCode::InvalidArgument, "Group admins must be unique current members");
    }
    group.history_members.clear();
    for (const auto& id : source.history_members) {
        validate_bot_id(id);
        if (!contains(group.history_members, id)) group.history_members.push_back(id);
    }
    merge_history(group.history_members, group.members);
    if (group.deleted && (group.in_chat || group.in_work))
        throw StoreError(StoreErrorCode::InvalidArgument, "Deleted group cannot be in a roster");
    return group;
}

bool same_group(const Group& first, const Group& second) {
    return first.id == second.id && first.name == second.name && first.owner_id == second.owner_id &&
        first.members == second.members && first.history_members == second.history_members &&
        first.admins == second.admins && first.in_chat == second.in_chat && first.in_work == second.in_work &&
        first.deleted == second.deleted && first.seal_shape == second.seal_shape &&
        first.seal_color == second.seal_color && first.revision == second.revision;
}

std::string encode_ids(const std::vector<std::string>& ids) {
    Json::Array values;
    for (const auto& id : ids) values.emplace_back(id);
    return Json(std::move(values)).dump();
}

std::vector<std::string> decode_ids(const std::string& text) {
    const auto values = Json::parse(text, 128U * 1024U);
    if (!values.is_array() || values.as_array().size() > 1024)
        throw StoreError(StoreErrorCode::Storage, "Stored group IDs are invalid");
    std::vector<std::string> ids;
    for (const auto& value : values.as_array()) {
        if (!value.is_string()) throw StoreError(StoreErrorCode::Storage, "Stored group ID is not text");
        ids.push_back(value.as_string());
    }
    return ids;
}

BotProfileOverride normalize_profile(const BotProfileOverride& source) {
    auto profile = source;
    validate_bot_id(profile.id);
    if (profile.name) {
        *profile.name = std::string(trim(*profile.name));
        validate_text(*profile.name, 1024, false, "Bot name");
    }
    if (profile.persona) validate_text(*profile.persona, 262144, true, "Persona");
    return profile;
}

std::string new_bot_id() {
    std::random_device random;
    std::uniform_int_distribution<unsigned int> distribution(0, 255);
    constexpr char hex[] = "0123456789abcdef";
    std::string id = "bot-";
    id.reserve(36);
    for (int i = 0; i < 16; ++i) {
        const auto byte = distribution(random);
        id.push_back(hex[byte >> 4]);
        id.push_back(hex[byte & 15]);
    }
    return id;
}

std::string_view mode_text(Mode mode) {
    if (mode == Mode::Chat) return "chat";
    if (mode == Mode::Work) return "work";
    throw StoreError(StoreErrorCode::InvalidArgument, "Unknown conversation mode");
}

Mode read_mode(std::string_view mode) {
    if (mode == "chat") return Mode::Chat;
    if (mode == "work") return Mode::Work;
    throw StoreError(StoreErrorCode::Storage, "Stored conversation mode is invalid");
}

std::string_view state_text(MemoryState state) {
    if (state == MemoryState::Candidate) return "candidate";
    if (state == MemoryState::Confirmed) return "confirmed";
    if (state == MemoryState::Rejected) return "rejected";
    throw StoreError(StoreErrorCode::InvalidArgument, "Unknown memory state");
}

MemoryState read_state(std::string_view state) {
    if (state == "candidate") return MemoryState::Candidate;
    if (state == "confirmed") return MemoryState::Confirmed;
    if (state == "rejected") return MemoryState::Rejected;
    throw StoreError(StoreErrorCode::Storage, "Stored memory state is invalid");
}

Bot read_bot(const Statement& row) {
    return {row.text(0), row.text(1), row.text(2), row.integer(3) != 0, row.integer(4) != 0};
}

Memory read_memory(const Statement& row) {
    return {row.integer(0), row.text(1), row.text(2), row.text(3),
        read_state(row.text(4)), row.integer(5), row.text(6), row.text(7),
        row.integer(8), row.text(9), row.text(10), row.text(11), row.text(12),
        row.text(13), row.text(14), row.text(15), row.integer(16)};
}

constexpr const char* memory_columns = "id,bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,source_ref,participants,user_choice,outcome,target_bot_id,evidence,applicable_scenarios,supersedes_id";
constexpr const char* mid_memory_columns = "id,bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength";
constexpr std::int64_t mid_day_ms = 24LL * 60LL * 60LL * 1000LL;

void validate_mid_text(std::string_view text) {
    validate_text(text, mid_memory_text_limit, false, "Mid-term memory");
    if (trim(text).empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term memory must contain text");
}

MidMemory read_mid_memory(const Statement& row) {
    MidMemory memory{row.integer(0), row.text(1), row.text(2), row.text(3), row.text(4),
        row.integer(5), row.integer(6), row.integer(7), row.integer(8), row.integer(9)};
    if (memory.id <= 0 || memory.revision <= 0 || memory.source_actor != "user" ||
        memory.created_at_ms < 0 || memory.updated_at_ms < memory.created_at_ms ||
        memory.expires_at_ms <= memory.created_at_ms || memory.strength < 1 || memory.strength > mid_memory_strength_limit)
        throw StoreError(StoreErrorCode::Storage, "Stored mid-term memory metadata is invalid");
    validate_mid_text(memory.text);
    return memory;
}

std::int64_t mid_now(std::optional<std::int64_t> supplied) {
    const auto value = supplied.value_or(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    if (value < 0) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid mid-term memory clock");
    return value;
}

std::int64_t mid_duration(int days) {
    if (days < 1 || days > 30) throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term duration must be 1..30 days");
    return static_cast<std::int64_t>(days) * mid_day_ms;
}
constexpr const char* group_columns = "id,name,owner_id,members,history_members,admins,in_chat,in_work,deleted,seal_shape,seal_color,revision";

Group read_group(const Statement& row) {
    try {
        Group group;
        group.id = row.text(0); group.name = row.text(1); group.owner_id = row.text(2);
        group.members = decode_ids(row.text(3)); group.history_members = decode_ids(row.text(4));
        group.admins = decode_ids(row.text(5));
        for (int i = 6; i <= 8; ++i)
            if (row.integer(i) != 0 && row.integer(i) != 1)
                throw StoreError(StoreErrorCode::Storage, "Stored group flag is invalid");
        group.in_chat = row.integer(6) != 0; group.in_work = row.integer(7) != 0;
        group.deleted = row.integer(8) != 0; group.seal_shape = row.text(9);
        group.seal_color = row.text(10); group.revision = row.integer(11);
        if (!same_group(group, normalize_group(group)))
            throw StoreError(StoreErrorCode::Storage, "Stored group fields are not canonical");
        return group;
    } catch (const std::exception&) {
        throw StoreError(StoreErrorCode::Storage, "Stored group metadata is invalid");
    }
}

std::vector<std::string> query_terms(std::string_view query) {
    std::vector<std::string> terms;
    while (!query.empty() && terms.size() < 12) {
        while (!query.empty() && ascii_space(static_cast<unsigned char>(query.front()))) query.remove_prefix(1);
        if (query.empty()) break;
        std::size_t end = 0;
        while (end < query.size() && !ascii_space(static_cast<unsigned char>(query[end]))) ++end;
        std::string term(query.substr(0, end));
        for (auto& c : term) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
        if (std::find(terms.begin(), terms.end(), term) == terms.end()) terms.push_back(std::move(term));
        query.remove_prefix(end);
    }
    return terms;
}

std::size_t unicode_scalar_count(std::string_view value) {
    std::size_t count = 0;
    std::size_t offset = 0;
    while (offset < value.size()) {
        offset += utf8_width(value, offset);
        ++count;
    }
    return count;
}

std::vector<std::string> recall_terms(std::string_view query) {
    std::vector<std::string> result;
    const auto add = [&](std::string term) {
        for (auto& c : term) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
        if (!term.empty() && result.size() < 32 && std::find(result.begin(), result.end(), term) == result.end())
            result.push_back(std::move(term));
    };
    std::string word, previous_cjk;
    for (std::size_t offset = 0; offset < query.size() && result.size() < 32;) {
        const auto width = utf8_width(query, offset);
        const auto unit = query.substr(offset, width);
        auto cp = static_cast<std::uint32_t>(static_cast<unsigned char>(unit.front()));
        if (width > 1) {
            cp &= (1U << (7U - static_cast<unsigned>(width))) - 1U;
            for (std::size_t i = 1; i < width; ++i) cp = (cp << 6U) | (static_cast<unsigned char>(unit[i]) & 63U);
        }
        const bool cjk = (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff) ||
                         (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff);
        if (cjk) {
            add(std::move(word)); word.clear();
            if (!previous_cjk.empty()) add(previous_cjk + std::string(unit));
            previous_cjk = unit;
        } else {
            previous_cjk.clear();
            const bool ascii_word = (cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') ||
                                    (cp >= '0' && cp <= '9') || cp == '_' || cp == '-';
            const bool unicode_word = width > 1 && !(cp >= 0x2000 && cp <= 0x303f) &&
                                      !(cp >= 0xff00 && cp <= 0xff65);
            if (ascii_word || unicode_word) word += unit;
            else { add(std::move(word)); word.clear(); }
        }
        offset += width;
    }
    add(std::move(word));
    return result;
}

constexpr std::size_t recall_time_fallback_items = 3;

constexpr std::string_view recall_stop_terms[] = {
    "什么", "哪些", "哪个", "吗", "呢", "啊", "呀", "吧", "的", "了", "着", "过",
    "是", "有", "在", "和", "就", "都", "也", "还", "很", "我", "你", "他", "她", "它", "们",
    "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "to", "of", "and", "or",
    "in", "on", "for", "it", "me", "my", "you", "we"
};

constexpr std::string_view recall_time_cues[] = {
    "最早", "以前", "之前", "第一次", "当初", "曾经", "上次", "最开始", "起初", "从前"
};

// Only suppressed in time-cue questions, so "你记得绿茶吗" can still use 记得.
constexpr std::string_view recall_memory_verbs[] = {
    "记得", "想起", "印象", "回忆", "记忆"
};

bool query_has_time_cue(std::string_view query) {
    for (const auto cue : recall_time_cues) if (query.find(cue) != std::string_view::npos) return true;
    return false;
}

bool is_recall_memory_verb(std::string_view term) {
    for (const auto verb : recall_memory_verbs) if (term == verb) return true;
    return false;
}

bool is_recall_stop_term(std::string_view term, bool time_cue) {
    for (const auto stop : recall_stop_terms) if (term == stop) return true;
    for (const auto cue : recall_time_cues) if (term == cue) return true;
    return time_cue && is_recall_memory_verb(term);
}

std::vector<std::string> effective_recall_terms(std::string_view query) {
    const bool time_cue = query_has_time_cue(query);
    auto terms = recall_terms(query);
    for (auto& term : query_terms(query)) {
        if (term.empty() || is_recall_stop_term(term, time_cue)) continue;
        if (std::find(terms.begin(), terms.end(), term) == terms.end() && terms.size() < 32)
            terms.push_back(std::move(term));
    }
    const bool first_time = query.find("第一次") != std::string_view::npos;
    const bool first_start = query.find("最开始") != std::string_view::npos;
    terms.erase(std::remove_if(terms.begin(), terms.end(), [&](const std::string& term) {
        if (is_recall_stop_term(term, time_cue)) return true;
        if (first_time && (term == "第一" || term == "一次")) return true;
        if (first_start && (term == "最开" || term == "开始")) return true;
        return false;
    }), terms.end());
    return terms;
}

std::string relevance_term_sum(const std::vector<std::string>& terms, std::string_view expression = "text") {
    std::string sql;
    for (std::size_t i = 0; i < terms.size(); ++i) {
        if (i) sql += "+";
        sql += "(CASE WHEN instr(lower(" + std::string(expression) + "),?)>0 THEN 1 ELSE 0 END)";
    }
    return sql;
}

// overlap / max(2, min(12, number of effective terms))
std::string relevance_score_sql(const std::vector<std::string>& terms, std::string_view expression = "text") {
    const auto denom = std::max<std::size_t>(2, std::min<std::size_t>(12, terms.size()));
    return "(" + relevance_term_sum(terms, expression) + ")*1.0/" + std::to_string(denom);
}


MemoryExcerpt memory_excerpt(const Memory& memory, const std::vector<std::string>& terms, std::size_t budget, bool relation_notes = true) {
    const auto relation = relation_notes ? parse_relation_note(memory.text) : std::nullopt;
    const std::string_view content = relation ? std::string_view(relation->content) : std::string_view(memory.text);
    std::vector<std::size_t> boundaries{0};
    for (std::size_t offset = 0; offset < content.size();) {
        offset += utf8_width(content, offset); boundaries.push_back(offset);
    }
    const auto total = boundaries.size() - 1;
    const auto count = std::min({budget, total, std::size_t{512}});
    std::size_t begin = 0, best_score = 0;
    std::string lowered(content);
    for (auto& c : lowered) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
    for (const auto& term : terms) {
        // At most the first 16 occurrences per query term. All source records
        // remain intact; only a bounded view is selected for the model.
        std::size_t match = 0;
        for (unsigned occurrence = 0; occurrence < 16; ++occurrence) {
            match = lowered.find(term, match);
            if (match == lowered.npos) break;
            const auto scalar = static_cast<std::size_t>(std::lower_bound(boundaries.begin(), boundaries.end(), match) - boundaries.begin());
            auto start = scalar > count / 4 ? scalar - count / 4 : 0;
            if (start + count > total) start = total - count;
            const auto window = std::string_view(lowered).substr(boundaries[start], boundaries[start + count] - boundaries[start]);
            const auto score = static_cast<std::size_t>(std::count_if(terms.begin(), terms.end(),
                [&](const auto& candidate) { return window.find(candidate) != window.npos; }));
            if (score > best_score) { best_score = score; begin = start; }
            match += term.size();
        }
    }
    return {memory.id, memory.revision, memory.bot_id, memory.group_id,
        std::string(content.substr(boundaries[begin], boundaries[begin + count] - boundaries[begin])),
        relation ? relation->key : std::string{}, begin, total, count != total};
}


constexpr std::array<const char*, 6> revision_tables{
    "bots", "messages", "memories", "message_receipts",
    "archive_message_sources", "archive_memory_sources"};
constexpr std::array<const char*, 3> revision_events{"INSERT", "UPDATE", "DELETE"};
constexpr std::array<const char*, 2> group_revision_tables{"groups", "application_metadata_bootstrap"};

std::string revision_trigger_name(std::string_view table, std::string_view event) {
    return "store_revision_" + std::string(table) + "_" + std::string(event);
}

bool lower_hex(std::string_view value, std::size_t length) {
    return value.size() == length && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

std::string database_identity() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw StoreError(StoreErrorCode::Storage, "Cannot create native database identity");
    constexpr char hex[] = "0123456789abcdef";
    std::string value;
    for (auto byte : bytes) { value += hex[byte >> 4U]; value += hex[byte & 15U]; }
    return value;
}

std::string import_hash(std::initializer_list<std::string_view> parts) {
    BCRYPT_ALG_HANDLE algorithm{};
    BCRYPT_HASH_HANDLE hash{};
    auto cleanup = [&] {
        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    };
    try {
        if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
            BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) < 0)
            throw StoreError(StoreErrorCode::Storage, "Cannot initialize native archive digest");
        for (const auto part : parts) {
            // Length-framed fields avoid delimiter ambiguities, including text newlines.
            std::array<unsigned char, 8> length{};
            auto size = static_cast<std::uint64_t>(part.size());
            for (std::size_t i = 0; i < length.size(); ++i) {
                length[length.size() - 1 - i] = static_cast<unsigned char>(size & 255U); size >>= 8U;
            }
            if (part.size() > std::numeric_limits<ULONG>::max() ||
                BCryptHashData(hash, length.data(), static_cast<ULONG>(length.size()), 0) < 0 ||
                BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(part.data())),
                               static_cast<ULONG>(part.size()), 0) < 0)
                throw StoreError(StoreErrorCode::Storage, "Cannot hash native archive data");
        }
        std::array<unsigned char, 32> bytes{};
        if (BCryptFinishHash(hash, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0)
            throw StoreError(StoreErrorCode::Storage, "Cannot finish native archive digest");
        cleanup(); hash = nullptr; algorithm = nullptr;
        constexpr char hex[] = "0123456789abcdef";
        std::string result;
        for (auto byte : bytes) { result += hex[byte >> 4U]; result += hex[byte & 15U]; }
        return result;
    } catch (...) { cleanup(); throw; }
}

void validate_import_options(const StoreImportOptions& options) {
    const auto& source = options.source_id;
    const auto alnum = [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    };
    if (source.empty() || source.size() > 128 || !alnum(source.front()) ||
        std::any_of(source.begin(), source.end(), [&](char c) {
            return !alnum(c) && c != '-' && c != '_' && c != '.' && c != ':';
        }))
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid stable archive source namespace");
    if (!options.bot_conflict || (*options.bot_conflict != StoreBotConflict::Reject &&
                                  *options.bot_conflict != StoreBotConflict::PreserveExisting) ||
        (options.memory_conflict != StoreMemoryConflict::Reject &&
         options.memory_conflict != StoreMemoryConflict::PreserveExisting) ||
        (options.group_conflict && *options.group_conflict != StoreGroupConflict::Reject &&
         *options.group_conflict != StoreGroupConflict::PreserveExisting))
        throw StoreError(StoreErrorCode::InvalidArgument, "Select valid archive conflict policies explicitly");
}

struct ImportInput {
    const ArchiveDocument& archive;
    std::string digest;
    std::map<Id, std::string> message_hashes, memory_hashes, mid_hashes;
};

ImportInput import_input(const ArchiveDocument& archive, const StoreImportOptions& options) {
    validate_import_options(options);
    if (archive.version() >= 2 && !options.group_conflict)
        throw StoreError(StoreErrorCode::InvalidArgument, "Select a group conflict policy for archive v2");
    const ArchiveLimits limits;
    if (archive.size_bytes() > limits.max_bytes || archive.bots().size() > limits.max_bots ||
        archive.conversations().size() > limits.max_conversations || archive.memories().size() > limits.max_memories ||
        archive.groups().size() > limits.max_groups || archive.mid_memories().size() > limits.max_mid_memories)
        throw StoreError(StoreErrorCode::InvalidArgument, "Archive exceeds native import limits");
    ImportInput input{archive, {}, {}, {}, {}};
    std::size_t message_count = 0;
    for (const auto& conversation : archive.conversations()) {
        if (conversation.messages.size() > limits.max_messages - message_count)
            throw StoreError(StoreErrorCode::InvalidArgument, "Archive exceeds native import message limit");
        message_count += conversation.messages.size();
        for (const auto& message : conversation.messages) {
            const auto legacy = import_hash({"dimension-message-v1",
                std::to_string(message.id), message.bot_id, message.group_id, mode_text(message.mode),
                message.actor, message.text, std::to_string(message.created_at_ms)});
            input.message_hashes.emplace(message.id, message.context
                ? import_hash({"dimension-message-context-v1", legacy, message_context_json(*message.context).dump()})
                : legacy);
        }
    }
    for (const auto& memory : archive.memories())
        input.memory_hashes.emplace(memory.id, import_hash({"dimension-memory-v1",
            std::to_string(memory.id), memory.bot_id, memory.group_id, memory.text,
            state_text(memory.state), std::to_string(memory.revision), memory.source_actor,
            memory.kind, std::to_string(memory.event_time_ms), memory.source_ref, memory.participants, memory.user_choice, memory.outcome,
            memory.target_bot_id, memory.evidence, memory.applicable_scenarios, std::to_string(memory.supersedes_id)}));
    for (const auto& m : archive.mid_memories()) input.mid_hashes.emplace(m.id, import_hash({"dimension-mid-memory-v1",
        std::to_string(m.id), m.bot_id, m.group_id, m.text, m.source_actor, std::to_string(m.revision),
        std::to_string(m.created_at_ms), std::to_string(m.updated_at_ms), std::to_string(m.expires_at_ms), std::to_string(m.strength)}));
    const auto encoded = encode_archive(archive);
    input.digest = import_hash({"dimension-import-v2", options.source_id,
        *options.bot_conflict == StoreBotConflict::Reject ? "reject" : "preserve-existing",
        options.memory_conflict == StoreMemoryConflict::Reject ? "reject" : "preserve-existing",
        !options.group_conflict ? "unspecified" :
            *options.group_conflict == StoreGroupConflict::Reject ? "reject" : "preserve-existing", encoded});
    return input;
}

struct ImportMapping {
    std::string fingerprint;
    std::optional<Id> target;
};
struct StoredRelationNotes {
    RelationNotesSnapshot view;
    std::map<std::string, Memory> records;
};
struct ImportMemoryWrite {
    const Memory* source{};
    std::string fingerprint;
    std::optional<Id> preserved;
};
struct ImportMidWrite {
    const MidMemory* source{};
    std::string fingerprint;
    std::optional<Id> preserved;
};
constexpr const char* import_mid_columns = "id,bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength";
MidMemory read_import_mid(const Statement& row) {
    return {row.integer(0), row.text(1), row.text(2), row.text(3), row.text(4), row.integer(5),
            row.integer(6), row.integer(7), row.integer(8), row.integer(9)};
}
struct ImportWritePlan {
    StoreImportPlan view;
    std::vector<const Bot*> bots;
    std::vector<const Group*> groups;
    std::vector<const Message*> messages;
    std::vector<ImportMemoryWrite> memories;
    std::vector<ImportMidWrite> mid_memories;
    void issue(std::string code, std::string kind, std::string source) {
        ++view.issue_count;
        if (view.issues.size() < 256)
            view.issues.push_back({std::move(code), std::move(kind), std::move(source)});
        else view.issues_truncated = true;
    }
};

} // namespace

bool is_relation_note_text(std::string_view text) noexcept {
    return text.starts_with(relation_note_reserved_prefix);
}

std::optional<RelationNote> parse_relation_note(std::string_view text) {
    if (!is_relation_note_text(text)) return {};
    if (!text.starts_with(relation_note_prefix))
        throw StoreError(StoreErrorCode::InvalidArgument, "Unsupported relation note format");
    const auto newline = text.find('\n', relation_note_prefix.size());
    if (newline == text.npos)
        throw StoreError(StoreErrorCode::InvalidArgument, "Relation note content is missing");
    const auto key = text.substr(relation_note_prefix.size(), newline - relation_note_prefix.size());
    if (std::none_of(relation_note_fields.begin(), relation_note_fields.end(),
                    [&](const auto& field) { return field.key == key; }))
        throw StoreError(StoreErrorCode::InvalidArgument, "Unknown relation note key");
    const auto content = text.substr(newline + 1);
    validate_text(content, relation_note_max_content_bytes, false, "Relation note");
    if (content != trim(content))
        throw StoreError(StoreErrorCode::InvalidArgument, "Relation note content must have trimmed edges");
    return RelationNote{std::string(key), std::string(content)};
}

std::string encode_relation_note(std::string_view key, std::string_view content) {
    validate_text(content, relation_note_max_content_bytes, false, "Relation note");
    auto encoded = std::string(relation_note_prefix) + std::string(key) + "\n" + std::string(trim(content));
    (void)parse_relation_note(encoded);
    return encoded;
}

std::string memory_context_text(std::string_view text) {
    const auto note = parse_relation_note(text);
    if (!note) return std::string(text);
    const auto field = std::find_if(relation_note_fields.begin(), relation_note_fields.end(),
                                   [&](const auto& value) { return value.key == note->key; });
    return std::string(field->title) + "（" + std::string(field->description) + "）\n" + note->content;
}

StoreError::StoreError(StoreErrorCode code, std::string message)
    : std::runtime_error(std::move(message)), code_(code) {}

struct Store::Impl final {
    SqliteApi& api;
    sqlite3* db{};
    sqlite3* read_db{};
    mutable std::mutex mutex;
    mutable std::mutex read_mutex;

    explicit Impl(const std::filesystem::path& path) : api(sqlite_api()) {
        if (path.empty() || path == std::filesystem::path(":memory:") || !path.has_filename()) {
            throw StoreError(StoreErrorCode::InvalidArgument, "An explicit database file path is required");
        }
        std::filesystem::path absolute_path;
        try {
            absolute_path = std::filesystem::absolute(path);
            std::filesystem::create_directories(absolute_path.parent_path());
        } catch (const std::filesystem::filesystem_error& error) {
            throw StoreError(StoreErrorCode::Storage, error.what());
        }
        const auto encoded = absolute_path.u8string();
        const std::string filename(reinterpret_cast<const char*>(encoded.data()), encoded.size());
        validate_text(filename, 131072, false, "Database path");
        const int result = api.open_v2(filename.c_str(), &db,
            sqlite_open_readwrite | sqlite_open_create | sqlite_open_fullmutex, nullptr);
        try {
            if (result != sqlite_ok) database_error(api, db, result);
            const int busy_result = api.busy_timeout(db, 5000);
            if (busy_result != sqlite_ok) database_error(api, db, busy_result);
            execute(api, db, "PRAGMA foreign_keys=ON");
            {
                Statement foreign_keys(api, db, "PRAGMA foreign_keys");
                if (!foreign_keys.next() || foreign_keys.integer(0) != 1) {
                    throw StoreError(StoreErrorCode::Storage, "SQLite foreign key enforcement is unavailable");
                }
            }
            initialize_schema();
            {
                Statement journal(api, db, "PRAGMA journal_mode=WAL");
                if (!journal.next() || journal.text(0) != "wal") {
                    throw StoreError(StoreErrorCode::Storage, "The database does not support WAL mode");
                }
            }
            // WAL + NORMAL gives crash-consistent durability without forcing an
            // expensive physical disk flush on every single message/receipt write.
            execute(api, db, "PRAGMA synchronous=NORMAL");
            execute(api, db, "PRAGMA temp_store=MEMORY");
            execute(api, db, "PRAGMA cache_size=-16384");
            execute(api, db, "PRAGMA mmap_size=67108864");
            execute(api, db, "CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(mode,created_at_ms DESC,id DESC)");
            execute(api, db, "CREATE INDEX IF NOT EXISTS idx_bots_roster ON bots(in_chat,id)");
            execute(api, db, "CREATE INDEX IF NOT EXISTS idx_bots_work_roster ON bots(in_work,id)");
            execute(api, db, "CREATE INDEX IF NOT EXISTS idx_bots_active_cover ON bots(id,name,in_chat,in_work) WHERE in_chat=1 OR in_work=1");
            execute(api, db, "CREATE INDEX IF NOT EXISTS idx_bots_name_search ON bots(id DESC,name)");
            execute(api, db, "CREATE INDEX IF NOT EXISTS idx_memories_active_id ON memories(id DESC) WHERE state IN ('candidate','confirmed')");
            execute(api, db, "DROP TABLE IF EXISTS archive_memory_sources_v10_backup");
            execute(api, db, R"SQL(
CREATE TABLE IF NOT EXISTS chat_delivery_receipts (
    receipt_key TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
    bot_id TEXT NOT NULL,
    run_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    saved INTEGER NOT NULL DEFAULT 0 CHECK(saved IN (0,1)),
    payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_chat_delivery_unsaved ON chat_delivery_receipts(saved,updated_at_ms) WHERE saved=0;
CREATE INDEX IF NOT EXISTS idx_chat_delivery_run ON chat_delivery_receipts(run_id) WHERE run_id<>'';
CREATE INDEX IF NOT EXISTS idx_chat_delivery_bot ON chat_delivery_receipts(bot_id);
)SQL");

            const int ro_result = api.open_v2(filename.c_str(), &read_db,
                sqlite_open_readonly | sqlite_open_fullmutex, nullptr);
            if (ro_result == sqlite_ok && read_db != nullptr) {
                (void)api.busy_timeout(read_db, 5000);
                execute(api, read_db, "PRAGMA temp_store=MEMORY");
                execute(api, read_db, "PRAGMA cache_size=-16384");
                execute(api, read_db, "PRAGMA mmap_size=67108864");
            }
        } catch (...) {
            if (read_db != nullptr) api.close_v2(read_db);
            if (db != nullptr) api.close_v2(db);
            read_db = nullptr;
            db = nullptr;
            throw;
        }
    }

    ~Impl() {
        if (read_db != nullptr) api.close_v2(read_db);
        if (db != nullptr) api.close_v2(db);
    }

    void add_revision_triggers(const char* table) {
        for (const auto* event : revision_events) {
            const auto sql = "CREATE TRIGGER " + revision_trigger_name(table, event) + " AFTER " +
                event + " ON " + table + R"SQL( BEGIN
SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM store_revision WHERE singleton=1 AND typeof(revision)='integer'
    AND revision>=0 AND revision<9223372036854775807
) THEN RAISE(ABORT,'store_revision_exhausted') END;
UPDATE store_revision SET revision=revision+1 WHERE singleton=1;
END;)SQL";
            execute(api, db, sql.c_str());
        }
    }

    void migrate_import_schema() {
        execute(api, db, R"SQL(
CREATE TABLE store_revision (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
    identity TEXT NOT NULL CHECK(length(identity)=32)
);
CREATE TABLE archive_message_sources (
    source_namespace TEXT NOT NULL,
    source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
    target_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
    PRIMARY KEY(source_namespace,source_record_id)
) WITHOUT ROWID;
CREATE TABLE archive_memory_sources (
    source_namespace TEXT NOT NULL,
    source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
    target_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
    PRIMARY KEY(source_namespace,source_record_id)
) WITHOUT ROWID;
CREATE INDEX archive_memory_targets ON archive_memory_sources(target_id);
)SQL");
        {
            Statement state(api, db, "INSERT INTO store_revision(singleton,revision,identity) VALUES(1,0,?)");
            state.bind(1, database_identity()); state.finish();
        }
        for (const auto* table : revision_tables) add_revision_triggers(table);
        execute(api, db, "PRAGMA user_version=3");
    }

    void migrate_group_schema() {
        execute(api, db, R"SQL(
CREATE TABLE groups (
    id TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    members TEXT NOT NULL,
    history_members TEXT NOT NULL,
    admins TEXT NOT NULL,
    in_chat INTEGER NOT NULL CHECK(in_chat IN (0,1)),
    in_work INTEGER NOT NULL CHECK(in_work IN (0,1)),
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
    seal_shape TEXT NOT NULL,
    seal_color TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
    CHECK(deleted=0 OR (in_chat=0 AND in_work=0))
);
CREATE TABLE application_metadata_bootstrap (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    completed INTEGER NOT NULL CHECK(completed=1)
);
CREATE INDEX messages_group_page ON messages(group_id,mode,id DESC);
)SQL");
        for (const auto* table : group_revision_tables) add_revision_triggers(table);
        execute(api, db, "PRAGMA user_version=4");
    }

    void migrate_context_schema() {
        execute(api, db, R"SQL(
CREATE TABLE message_contexts (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('quote','forward')),
    snapshot TEXT NOT NULL CHECK(length(snapshot)>0 AND length(snapshot)<=262144)
);
)SQL");
        add_revision_triggers("message_contexts");
        execute(api, db, "PRAGMA user_version=5");
    }

    void migrate_mid_memory_schema() {
        execute(api, db, R"SQL(
CREATE TABLE mid_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    group_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
    source_actor TEXT NOT NULL CHECK(source_actor='user'),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
    created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms>=0),
    updated_at_ms INTEGER NOT NULL CHECK(typeof(updated_at_ms)='integer' AND updated_at_ms>=created_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms>created_at_ms),
    strength INTEGER NOT NULL CHECK(typeof(strength)='integer' AND strength BETWEEN 1 AND 1000000),
    UNIQUE(bot_id,group_id,text)
);
CREATE INDEX mid_memory_scope ON mid_memories(bot_id,group_id,id DESC);
CREATE INDEX mid_memory_active ON mid_memories(bot_id,group_id,expires_at_ms);
CREATE TABLE archive_mid_memory_sources (
    source_namespace TEXT NOT NULL,
    source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
    target_id INTEGER REFERENCES mid_memories(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
    PRIMARY KEY(source_namespace,source_record_id)
) WITHOUT ROWID;
CREATE INDEX archive_mid_memory_targets ON archive_mid_memory_sources(target_id);
)SQL");
        add_revision_triggers("mid_memories");
        add_revision_triggers("archive_mid_memory_sources");
        execute(api, db, "PRAGMA user_version=6");
    }

    void migrate_bot_archive_schema() {
        execute(api, db, R"SQL(
CREATE TABLE bot_archive_receipts (
    source_key TEXT PRIMARY KEY NOT NULL CHECK(length(source_key)=64),
    target_id TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE RESTRICT,
    selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64)
) WITHOUT ROWID;
)SQL");
        add_revision_triggers("bot_archive_receipts");
        execute(api, db, "PRAGMA user_version=7");
    }

    void migrate_message_deletion_schema() {
        execute(api, db, R"SQL(
CREATE TABLE message_deletions (
    message_id INTEGER PRIMARY KEY CHECK(message_id>0),
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    group_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode='chat')
);
)SQL");
        add_revision_triggers("message_deletions");
        execute(api, db, "PRAGMA user_version=8");
    }

    std::pair<std::int64_t, std::string> import_state() const {
        Statement state(api, db, "SELECT revision,identity FROM store_revision WHERE singleton=1");
        if (!state.next()) throw StoreError(StoreErrorCode::Storage, "Native import revision is missing");
        const auto revision = state.integer(0);
        const auto identity = state.text(1);
        if (revision < 0 || !lower_hex(identity, 32) || state.next())
            throw StoreError(StoreErrorCode::Storage, "Native import revision is invalid");
        return {revision, identity};
    }

    void verify_revision_triggers(const char* table) const {
        for (const auto* event : revision_events) {
            Statement trigger(api, db, "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?");
            trigger.bind(1, revision_trigger_name(table, event)); trigger.bind(2, table);
            if (!trigger.next())
                throw StoreError(StoreErrorCode::Storage, "Native database revision trigger is missing");
        }
    }

    void verify_import_schema(bool with_groups = false) const {
        (void)import_state();
        for (const auto* table : revision_tables) verify_revision_triggers(table);
        if (with_groups) for (const auto* table : group_revision_tables) verify_revision_triggers(table);
    }

    void migrate_episode_schema() {
        std::set<std::string> columns;
        Statement info(api, db, "PRAGMA table_info(memories)");
        while (info.next()) columns.insert(info.text(1));
        if (!columns.contains("kind")) execute(api, db, "ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','episode'))");
        if (!columns.contains("event_time_ms")) execute(api, db, "ALTER TABLE memories ADD COLUMN event_time_ms INTEGER NOT NULL DEFAULT 0");
        if (!columns.contains("source_ref")) execute(api, db, "ALTER TABLE memories ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''");
        if (!columns.contains("participants")) execute(api, db, "ALTER TABLE memories ADD COLUMN participants TEXT NOT NULL DEFAULT ''");
        if (!columns.contains("user_choice")) execute(api, db, "ALTER TABLE memories ADD COLUMN user_choice TEXT NOT NULL DEFAULT ''");
        if (!columns.contains("outcome")) execute(api, db, "ALTER TABLE memories ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");
        execute(api, db, "CREATE INDEX IF NOT EXISTS memories_kind_scope ON memories(bot_id,group_id,kind,state,id DESC)");
        execute(api, db, "PRAGMA user_version=9");
    }

    void migrate_impression_schema() {
        // Rebuild memories once for directed impressions while preserving all
        // legacy facts, episodes and source mappings.
        execute(api, db, "PRAGMA legacy_alter_table=ON");
        execute(api, db, R"SQL(
CREATE TABLE memories_v10 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    group_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('candidate','confirmed','rejected')),
    revision INTEGER NOT NULL CHECK(revision>0),
    source_actor TEXT NOT NULL CHECK(source_actor='user'),
    kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','episode','impression')),
    event_time_ms INTEGER NOT NULL DEFAULT 0,
    source_ref TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '',
    user_choice TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    target_bot_id TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    applicable_scenarios TEXT NOT NULL DEFAULT '',
    supersedes_id INTEGER NOT NULL DEFAULT 0 CHECK(supersedes_id>=0)
);
INSERT INTO memories_v10(id,bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,
    source_ref,participants,user_choice,outcome)
SELECT id,bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,
    source_ref,participants,user_choice,outcome FROM memories;
CREATE TEMP TABLE archive_memory_sources_v10_backup AS SELECT * FROM archive_memory_sources;
DELETE FROM archive_memory_sources;
DROP TABLE memories;
ALTER TABLE memories_v10 RENAME TO memories;
INSERT INTO archive_memory_sources SELECT * FROM archive_memory_sources_v10_backup;
DROP TABLE archive_memory_sources_v10_backup;
CREATE UNIQUE INDEX memories_legacy_text_unique ON memories(bot_id,group_id,text) WHERE kind IN ('fact','episode');
CREATE UNIQUE INDEX impressions_source_unique ON memories(bot_id,target_bot_id,group_id,source_ref) WHERE kind='impression';
CREATE INDEX memories_kind_scope ON memories(bot_id,group_id,kind,state,id DESC);
CREATE INDEX memories_scope_state_page ON memories(bot_id,group_id,state,id DESC);
CREATE INDEX memories_scope_page ON memories(bot_id,group_id,id DESC);
CREATE INDEX memories_bot_page ON memories(bot_id,id DESC);
CREATE INDEX impressions_direction ON memories(bot_id,target_bot_id,group_id,state,id DESC) WHERE kind='impression';
PRAGMA legacy_alter_table=OFF;
PRAGMA user_version=10;
)SQL");
        add_revision_triggers("memories");
    }

    void migrate_experience_schema() {
        execute(api, db, R"SQL(
CREATE TABLE IF NOT EXISTS conversation_drafts (
    mode TEXT NOT NULL CHECK(mode IN ('chat','work')),
    bot_id TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 65536),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
    updated_at_ms INTEGER NOT NULL CHECK(typeof(updated_at_ms)='integer' AND updated_at_ms>=0),
    PRIMARY KEY(mode,bot_id,group_id),
    CHECK((bot_id='')<>(group_id=''))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS persona_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    persona TEXT NOT NULL CHECK(length(CAST(persona AS BLOB))<=262144),
    profile_revision TEXT NOT NULL CHECK(length(profile_revision)=64),
    action TEXT NOT NULL CHECK(action IN ('save','restore')),
    restored_revision_id INTEGER NOT NULL DEFAULT 0 CHECK(restored_revision_id>=0),
    created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms>=0)
);
CREATE INDEX IF NOT EXISTS persona_revisions_bot_page ON persona_revisions(bot_id,id DESC);
)SQL");
        execute(api, db, "PRAGMA user_version=11");
    }

    void initialize_schema() {
        Transaction transaction(api, db);
        std::int64_t app{};
        std::int64_t version{};
        {
            Statement identity(api, db, "PRAGMA application_id");
            if (!identity.next()) throw StoreError(StoreErrorCode::Storage, "Cannot read database identity");
            app = identity.integer(0);
            Statement schema(api, db, "PRAGMA user_version");
            if (!schema.next()) throw StoreError(StoreErrorCode::Storage, "Cannot read schema version");
            version = schema.integer(0);
        }
        if (app == application_id && (version == 6 || version == 7 || version == 8 || version == 9 || version == 10 || version == 11)) {
            verify_import_schema(true);
            verify_revision_triggers("message_contexts");
            verify_revision_triggers("mid_memories");
            verify_revision_triggers("archive_mid_memory_sources");
            if (version == 6) migrate_bot_archive_schema();
            else verify_revision_triggers("bot_archive_receipts");
            if (version < 8) migrate_message_deletion_schema();
            else verify_revision_triggers("message_deletions");
            if (version < 9) migrate_episode_schema();
            if (version < 10) migrate_impression_schema();
            if (version < 11) migrate_experience_schema();
            transaction.commit();
            return;
        }
        if (app == application_id && version == 5) {
            verify_import_schema(true);
            verify_revision_triggers("message_contexts");
            migrate_mid_memory_schema();
            migrate_bot_archive_schema();
            migrate_message_deletion_schema();
            migrate_episode_schema();
            migrate_impression_schema();
            migrate_experience_schema();
            transaction.commit();
            return;
        }
        if (app == application_id && version == 4) {
            verify_import_schema(true);
            migrate_context_schema();
            migrate_mid_memory_schema();
            migrate_bot_archive_schema();
            migrate_message_deletion_schema();
            migrate_episode_schema();
            migrate_impression_schema();
            migrate_experience_schema();
            transaction.commit();
            return;
        }
        if (app == application_id && version == 3) {
            verify_import_schema();
            migrate_group_schema();
            migrate_context_schema();
            migrate_mid_memory_schema();
            migrate_bot_archive_schema();
            migrate_message_deletion_schema();
            migrate_episode_schema();
            migrate_impression_schema();
            migrate_experience_schema();
            transaction.commit();
            return;
        }
        if (app == application_id && (version == 1 || version == 2)) {
            // A versioned migration of this original native schema only. The
            // transaction either adds both the receipts and version or neither.
            if (version == 1) execute(api, db, message_receipt_schema);
            migrate_import_schema();
            migrate_group_schema();
            migrate_context_schema();
            migrate_mid_memory_schema();
            migrate_bot_archive_schema();
            migrate_message_deletion_schema();
            migrate_episode_schema();
            migrate_impression_schema();
            migrate_experience_schema();
            transaction.commit();
            return;
        }
        if (app != 0 || version != 0) {
            throw StoreError(StoreErrorCode::Storage, "Unsupported database identity or schema version");
        }
        {
            Statement tables(api, db,
                "SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1");
            if (tables.next()) {
                throw StoreError(StoreErrorCode::Storage, "Refusing to initialize a nonempty unrelated database");
            }
        }
        execute(api, db, R"SQL(
CREATE TABLE bots (
    id TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    in_chat INTEGER NOT NULL DEFAULT 0 CHECK(in_chat IN (0,1)),
    in_work INTEGER NOT NULL DEFAULT 0 CHECK(in_work IN (0,1))
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    group_id TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL CHECK(mode IN ('chat','work')),
    actor TEXT NOT NULL CHECK(actor IN ('user','bot','system')),
    text TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX messages_scope_page ON messages(bot_id,mode,group_id,id DESC);
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
    group_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('candidate','confirmed','rejected')),
    revision INTEGER NOT NULL CHECK(revision>0),
    source_actor TEXT NOT NULL CHECK(source_actor='user'),
    kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','episode')),
    event_time_ms INTEGER NOT NULL DEFAULT 0,
    source_ref TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '',
    user_choice TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    UNIQUE(bot_id,group_id,text)
);
CREATE INDEX memories_kind_scope ON memories(bot_id,group_id,kind,state,id DESC);
CREATE INDEX memories_scope_state_page ON memories(bot_id,group_id,state,id DESC);
CREATE INDEX memories_scope_page ON memories(bot_id,group_id,id DESC);
CREATE INDEX memories_bot_page ON memories(bot_id,id DESC);
PRAGMA application_id=1145654593;
PRAGMA user_version=9;
)SQL");
        execute(api, db, message_receipt_schema);
        migrate_import_schema();
        migrate_group_schema();
        migrate_context_schema();
        migrate_mid_memory_schema();
        migrate_bot_archive_schema();
        migrate_message_deletion_schema();
        migrate_episode_schema();
        migrate_impression_schema();
        migrate_experience_schema();
        transaction.commit();
    }

    std::optional<Bot> find_bot_unlocked(std::string_view id) const {
        Statement statement(api, db, "SELECT id,name,persona,in_chat,in_work FROM bots WHERE id=?");
        statement.bind(1, id);
        if (statement.next()) return read_bot(statement);
        return {};
    }

    Bot require_bot(std::string_view id) const {
        auto bot = find_bot_unlocked(id);
        if (!bot) throw StoreError(StoreErrorCode::NotFound, "Bot does not exist");
        return *bot;
    }

    Message read_message(const Statement& row) const {
        Message message{row.integer(0), row.text(1), row.text(2), read_mode(row.text(3)),
                        row.text(4), row.text(5), row.integer(6)};
        Statement context(api, db, "SELECT kind,snapshot FROM message_contexts WHERE message_id=?");
        context.bind(1, message.id);
        if (context.next()) {
            if (context.text_bytes(1) > 262144)
                throw StoreError(StoreErrorCode::Storage, "Stored message context exceeds its bound");
            try {
                message.context = parse_message_context(Json::parse(context.text(1), 262144));
                if (message.context->kind != context.text(0))
                    throw StoreError(StoreErrorCode::Storage, "Stored message context kind mismatch");
                validate_message_context_scope(*message.context, message.bot_id, message.group_id, message.mode, message.actor);
            } catch (...) { throw StoreError(StoreErrorCode::Storage, "Invalid stored message context"); }
        }
        return message;
    }

    Message require_message(Id id) const {
        if (id <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid source message ID");
        Statement select(api, db, "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE id=?");
        select.bind(1, id);
        if (!select.next()) throw StoreError(StoreErrorCode::NotFound, "Source message does not exist");
        return read_message(select);
    }

    ConversationSnapshot conversation_snapshot_unlocked(std::string_view bot, Mode mode, std::string_view group) const {
        (void)require_bot(bot);
        ConversationSnapshot result{"native-" + import_state().second, std::string(bot), std::string(group), {}, mode, {}};
        auto digest = import_hash({"dimension-conversation-snapshot-v1", result.source_namespace, bot, group, mode_text(mode)});
        Statement rows(api, db, "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE bot_id=? AND mode=? AND group_id=? ORDER BY id LIMIT 20001");
        rows.bind(1, bot); rows.bind(2, mode_text(mode)); rows.bind(3, group);
        std::size_t bytes = 0;
        while (rows.next()) {
            if (result.messages.size() == 20000 || rows.text_bytes(5) > 4U * 1024U * 1024U - bytes)
                throw StoreError(StoreErrorCode::LimitExceeded, "Conversation summary source exceeds 20000 messages or 4 MiB");
            auto message = read_message(rows);
            const auto context = message.context ? message_context_json(*message.context).dump() : "";
            bytes += message.text.size();
            if (context.size() > 4U * 1024U * 1024U - bytes)
                throw StoreError(StoreErrorCode::LimitExceeded, "Conversation summary source context exceeds 4 MiB");
            bytes += context.size();
            digest = import_hash({digest, std::to_string(message.id), message.actor, message.text,
                std::to_string(message.created_at_ms), context});
            result.messages.push_back(std::move(message));
        }
        result.fingerprint = digest;
        return result;
    }

    MessageSource source_snapshot(const Message& source, std::size_t maximum) const {
        std::size_t end = 0, total = 0;
        for (std::size_t offset = 0; offset < source.text.size();) {
            offset += utf8_width(source.text, offset);
            if (++total <= maximum) end = offset;
        }
        // Snapshot provenance names this database's numeric source ID; it never
        // follows an earlier quote recursively or rebinds imported source IDs.
        return {"native-" + import_state().second, source.id, source.bot_id, source.group_id,
            source.mode, source.actor, source.text.substr(0, end), source.created_at_ms, 0, total, total > maximum};
    }

    MessageContext quote_context(std::string_view bot, Mode mode, std::string_view group, Id id) const {
        const auto source = require_message(id);
        if (source.mode != mode || source.group_id != group || (group.empty() && source.bot_id != bot))
            throw StoreError(StoreErrorCode::InvalidArgument, "Quoted message is outside this conversation scope");
        if (!group.empty()) {
            const auto definition = require_group(group);
            if (definition.deleted || !contains(definition.history_members, source.bot_id))
                throw StoreError(StoreErrorCode::InvalidArgument, "Quoted source is outside recorded group membership");
        }
        MessageContext result{"quote", {source_snapshot(source, 4096)}};
        validate_message_context_scope(result, bot, group, mode, "user");
        return result;
    }

    void write_context(Id id, const std::optional<MessageContext>& context) {
        if (!context) return;
        const auto data = message_context_json(*context).dump();
        (void)parse_message_context(Json::parse(data, 262144));
        Statement insert(api, db, "INSERT INTO message_contexts(message_id,kind,snapshot) VALUES(?,?,?)");
        insert.bind(1, id); insert.bind(2, context->kind); insert.bind(3, data); insert.finish();
    }

    Bot update_profile(const BotProfileOverride& profile) {
        auto bot = require_bot(profile.id);
        const bool name_changed = profile.name && *profile.name != bot.name;
        const bool persona_changed = profile.persona && *profile.persona != bot.persona;
        if (!name_changed && !persona_changed) return bot;
        std::string sql = "UPDATE bots SET ";
        if (profile.name) sql += "name=?";
        if (profile.persona) sql += profile.name ? ",persona=?" : "persona=?";
        sql += " WHERE id=?";
        Statement update(api, db, sql);
        int index = 1;
        if (profile.name) update.bind(index++, *profile.name);
        if (profile.persona) update.bind(index++, *profile.persona);
        update.bind(index, profile.id); update.finish(); require_one_change();
        if (profile.name) bot.name = *profile.name;
        if (profile.persona) bot.persona = *profile.persona;
        return bot;
    }

    std::optional<Group> find_group_unlocked(std::string_view id) const {
        Statement select(api, db, std::string("SELECT ") + group_columns + " FROM groups WHERE id=?");
        select.bind(1, id);
        if (select.next()) return read_group(select);
        return {};
    }

    Group require_group(std::string_view id) const {
        auto group = find_group_unlocked(id);
        if (!group) throw StoreError(StoreErrorCode::NotFound, "Group does not exist");
        return *group;
    }

    void require_group_references(const Group& group) const {
        // Canonical history includes every current member, owner, and admin.
        for (const auto& id : group.history_members) (void)require_bot(id);
    }

    void write_group(const Group& group, std::optional<std::int64_t> expected_revision = {}) {
        require_group_references(group);
        Statement write(api, db, expected_revision
            ? "UPDATE groups SET id=?,name=?,owner_id=?,members=?,history_members=?,admins=?,in_chat=?,in_work=?,deleted=?,seal_shape=?,seal_color=?,revision=? WHERE id=? AND revision=?"
            : "INSERT INTO groups(id,name,owner_id,members,history_members,admins,in_chat,in_work,deleted,seal_shape,seal_color,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
        write.bind(1, group.id); write.bind(2, group.name); write.bind(3, group.owner_id);
        write.bind(4, encode_ids(group.members)); write.bind(5, encode_ids(group.history_members));
        write.bind(6, encode_ids(group.admins)); write.bind(7, static_cast<std::int64_t>(group.in_chat));
        write.bind(8, static_cast<std::int64_t>(group.in_work)); write.bind(9, static_cast<std::int64_t>(group.deleted));
        write.bind(10, group.seal_shape); write.bind(11, group.seal_color); write.bind(12, group.revision);
        if (expected_revision) { write.bind(13, group.id); write.bind(14, *expected_revision); }
        write.finish(); require_one_change();
    }

    void require_new_group_message(std::string_view group_id, std::string_view bot_id, Mode mode) const {
        if (group_id.empty()) return;
        const auto group = find_group_unlocked(group_id);
        // Opaque pre-v4 scopes remain readable/writable until the application's
        // typed bootstrap supplies their identity. Never invent a group here.
        if (!group) return;
        if (group->deleted || !contains(group->members, bot_id) ||
            !(mode == Mode::Chat ? group->in_chat : group->in_work))
            throw StoreError(StoreErrorCode::Conflict, "Group is not active for this member and mode");
    }

    bool metadata_bootstrapped() const {
        Statement select(api, db, "SELECT completed FROM application_metadata_bootstrap WHERE singleton=1");
        if (!select.next()) return false;
        if (select.integer(0) != 1 || select.next())
            throw StoreError(StoreErrorCode::Storage, "Invalid application metadata bootstrap marker");
        return true;
    }

    void add_recorded_group_history(Group& group) const {
        Statement select(api, db,
            "SELECT bot_id FROM messages WHERE group_id=? UNION SELECT bot_id FROM memories WHERE group_id=? ORDER BY bot_id");
        select.bind(1, group.id); select.bind(2, group.id);
        std::vector<std::string> recorded;
        while (select.next()) recorded.push_back(select.text(0));
        merge_history(group.history_members, recorded);
    }

    std::optional<Memory> find_memory_unlocked(Id id) const {
        Statement statement(api, db, std::string("SELECT ") + memory_columns + " FROM memories WHERE id=?");
        statement.bind(1, id);
        if (statement.next()) return read_memory(statement);
        return {};
    }

    Memory require_revision(Id id, std::int64_t expected_revision) const {
        auto memory = find_memory_unlocked(id);
        if (!memory) throw StoreError(StoreErrorCode::NotFound, "Memory does not exist");
        if (memory->revision != expected_revision) {
            throw StoreError(StoreErrorCode::Conflict, "Memory revision changed; reload before editing");
        }
        return *memory;
    }

    StoredRelationNotes relation_notes_unlocked(std::string_view bot_id) const {
        StoredRelationNotes result;
        for (const auto& field : relation_note_fields) result.view.values.emplace(field.key, "");
        Statement rows(api, db, std::string("SELECT ") + memory_columns +
            " FROM memories WHERE bot_id=? AND group_id='' AND instr(text,'@dimension-note/')=1 ORDER BY id LIMIT 5");
        rows.bind(1, bot_id);
        while (rows.next()) {
            auto memory = read_memory(rows);
            const auto note = parse_relation_note(memory.text);
            if (!note || memory.state != MemoryState::Confirmed || memory.source_actor != "user" || memory.revision <= 0)
                throw StoreError(StoreErrorCode::Conflict, "Relation notes must be confirmed private user records");
            if (!result.records.emplace(note->key, memory).second)
                throw StoreError(StoreErrorCode::Conflict, "Multiple relation notes use the same field");
            result.view.values.at(note->key) = note->content;
        }
        const auto identity = import_state().second;
        auto revision = import_hash({"dimension-relation-snapshot-v1", identity, bot_id});
        for (const auto& field : relation_note_fields) {
            const auto row = result.records.find(std::string(field.key));
            if (row == result.records.end()) revision = import_hash({revision, field.key, "absent"});
            else revision = import_hash({revision, field.key, std::to_string(row->second.id),
                std::to_string(row->second.revision), row->second.text, "confirmed", row->second.source_actor});
        }
        result.view.revision = std::move(revision);
        return result;
    }

    std::optional<ImportMapping> source_mapping(bool memory, std::string_view source, Id id, bool mid = false) const {
        const auto table = mid ? "archive_mid_memory_sources" : memory ? "archive_memory_sources" : "archive_message_sources";
        Statement lookup(api, db, std::string("SELECT fingerprint,target_id,target_id IS NULL FROM ") +
            table + " WHERE source_namespace=? AND source_record_id=?");
        lookup.bind(1, source); lookup.bind(2, id);
        if (!lookup.next()) return {};
        ImportMapping value{lookup.text(0), {}};
        if (!lookup.integer(2)) value.target = lookup.integer(1);
        if (!lower_hex(value.fingerprint, 64) || (value.target && *value.target <= 0) || lookup.next())
            throw StoreError(StoreErrorCode::Storage, "Invalid native archive source mapping");
        return value;
    }

    void add_source_mapping(bool memory, std::string_view source, Id source_id, Id target_id,
                            std::string_view fingerprint, bool mid = false) {
        const auto table = mid ? "archive_mid_memory_sources" : memory ? "archive_memory_sources" : "archive_message_sources";
        Statement insert(api, db, std::string("INSERT INTO ") + table +
            "(source_namespace,source_record_id,target_id,fingerprint) VALUES(?,?,?,?)");
        insert.bind(1, source); insert.bind(2, source_id);
        insert.bind(3, target_id); insert.bind(4, fingerprint); insert.finish();
    }

    ImportWritePlan plan_import(const ImportInput& input, const StoreImportOptions& options) const {
        ImportWritePlan plan;
        const auto [revision, identity] = import_state();
        plan.view.target_revision = revision;
        plan.view.archive_version = input.archive.version();
        plan.view.digest = import_hash({"dimension-target-import-v1", identity, input.digest});
        if (options.source_id == "native-" + identity) {
            plan.issue("source_is_target", "archive", options.source_id);
            return plan; // Export restoration is cross-database, never an in-place replay.
        }
        for (const auto& bot : input.archive.bots()) {
            const auto existing = find_bot_unlocked(bot.id);
            if (!existing) {
                plan.bots.push_back(&bot); ++plan.view.counts.bots_created;
            } else {
                ++plan.view.counts.bots_preserved;
                const bool differs = bot.name != existing->name || bot.persona != existing->persona ||
                    bot.in_chat != existing->in_chat || bot.in_work != existing->in_work;
                if (differs && *options.bot_conflict == StoreBotConflict::Reject)
                    plan.issue("bot_conflict", "bot", bot.id);
            }
        }
        std::map<std::string, Group> effective_groups;
        for (const auto& group : input.archive.groups()) {
            const auto existing = find_group_unlocked(group.id);
            if (!existing) {
                plan.groups.push_back(&group); ++plan.view.counts.groups_created;
                effective_groups.emplace(group.id, group);
            } else {
                ++plan.view.counts.groups_preserved;
                effective_groups.emplace(group.id, *existing);
                if (!same_group(group, *existing) && options.group_conflict == StoreGroupConflict::Reject)
                    plan.issue("group_conflict", "group", group.id);
            }
        }
        const auto valid_group_scope = [&](std::string_view id, std::string_view bot_id,
                                            bool message, std::string kind, std::string locator) {
            if (id.empty()) return true;
            const auto found = effective_groups.find(std::string(id));
            if (found == effective_groups.end()) {
                plan.issue("group_metadata_missing", std::move(kind), std::move(locator)); return false;
            }
            if (message && found->second.deleted) {
                plan.issue("group_deleted", std::move(kind), std::move(locator)); return false;
            }
            if (!contains(found->second.history_members, bot_id)) {
                plan.issue("group_member_conflict", std::move(kind), std::move(locator)); return false;
            }
            return true;
        };
        std::size_t conversation_index = 0;
        for (const auto& conversation : input.archive.conversations()) {
            const auto locator = std::to_string(conversation_index++);
            if (!conversation.group_id.empty() && input.archive.version() == 1) {
                plan.issue("group_metadata_unsupported", "conversation", locator);
                continue;
            }
            if (conversation.messages.empty() && conversation.group_id.empty()) {
                plan.issue("empty_conversation_unsupported", "conversation", locator);
                continue;
            }
            for (const auto& message : conversation.messages) {
                const auto previous = source_mapping(false, options.source_id, message.id);
                const auto& fingerprint = input.message_hashes.at(message.id);
                if (previous) {
                    if (previous->fingerprint != fingerprint)
                        plan.issue("source_record_changed", "message", std::to_string(message.id));
                    else if (previous->target) ++plan.view.counts.messages_reused;
                    else ++plan.view.counts.messages_tombstoned;
                } else {
                    if (!valid_group_scope(message.group_id, message.bot_id, true,
                                           "message", std::to_string(message.id))) continue;
                    plan.messages.push_back(&message); ++plan.view.counts.messages_created;
                }
            }
        }
        // Preserve source insertion ordering inside each imported private scope,
        // irrespective of archive array ordering. Target IDs are always new IDs.
        std::sort(plan.messages.begin(), plan.messages.end(),
            [](const Message* first, const Message* second) { return first->id < second->id; });
        std::map<std::string, StoredRelationNotes> relation_targets;
        for (const auto& memory : input.archive.memories()) {
            if (!memory.group_id.empty() && input.archive.version() == 1) {
                plan.issue("group_metadata_unsupported", "memory", std::to_string(memory.id));
                continue;
            }
            const auto previous = source_mapping(true, options.source_id, memory.id);
            const auto& fingerprint = input.memory_hashes.at(memory.id);
            if (previous) {
                if (previous->fingerprint != fingerprint)
                    plan.issue("source_record_changed", "memory", std::to_string(memory.id));
                else if (previous->target) ++plan.view.counts.memories_reused;
                else ++plan.view.counts.memories_tombstoned;
                continue;
            }
            if (!valid_group_scope(memory.group_id, memory.bot_id, false,
                                   "memory", std::to_string(memory.id))) continue;
            std::optional<Memory> existing;
            if (const auto note = parse_relation_note(memory.text)) {
                auto target = relation_targets.find(memory.bot_id);
                if (target == relation_targets.end())
                    target = relation_targets.emplace(memory.bot_id, relation_notes_unlocked(memory.bot_id)).first;
                const auto field = target->second.records.find(note->key);
                if (field != target->second.records.end()) existing = field->second;
            } else if (memory.kind == "impression") {
                Statement lookup(api, db, std::string("SELECT ") + memory_columns +
                    " FROM memories WHERE bot_id=? AND target_bot_id=? AND group_id=? AND source_ref=? AND kind='impression'");
                lookup.bind(1, memory.bot_id); lookup.bind(2, memory.target_bot_id);
                lookup.bind(3, memory.group_id); lookup.bind(4, memory.source_ref);
                if (lookup.next()) existing = read_memory(lookup);
            } else {
                Statement lookup(api, db, std::string("SELECT ") + memory_columns +
                    " FROM memories WHERE bot_id=? AND group_id=? AND text=?");
                lookup.bind(1, memory.bot_id); lookup.bind(2, memory.group_id); lookup.bind(3, memory.text);
                if (lookup.next()) existing = read_memory(lookup);
            }
            if (existing) {
                const bool differs = existing->text != memory.text || existing->state != memory.state || existing->revision != memory.revision ||
                    existing->source_actor != memory.source_actor || existing->kind != memory.kind ||
                    existing->event_time_ms != memory.event_time_ms || existing->source_ref != memory.source_ref ||
                    existing->participants != memory.participants || existing->user_choice != memory.user_choice ||
                    existing->outcome != memory.outcome || existing->target_bot_id != memory.target_bot_id ||
                    existing->evidence != memory.evidence || existing->applicable_scenarios != memory.applicable_scenarios ||
                    existing->supersedes_id != memory.supersedes_id;
                if (differs && options.memory_conflict == StoreMemoryConflict::Reject) {
                    plan.issue("memory_conflict", "memory", std::to_string(memory.id));
                    continue;
                }
                ++plan.view.counts.memories_preserved;
                plan.memories.push_back({&memory, fingerprint, existing->id});
            } else {
                ++plan.view.counts.memories_created;
                plan.memories.push_back({&memory, fingerprint, {}});
            }
        }
        std::map<std::pair<std::string, std::string>, std::size_t> mid_additions;
        for (const auto& memory : input.archive.mid_memories()) {
            const auto previous = source_mapping(true, options.source_id, memory.id, true);
            const auto& fingerprint = input.mid_hashes.at(memory.id);
            if (previous) {
                if (previous->fingerprint != fingerprint) plan.issue("source_record_changed", "mid-memory", std::to_string(memory.id));
                else if (previous->target) ++plan.view.counts.mid_memories_reused;
                else ++plan.view.counts.mid_memories_tombstoned;
                continue;
            }
            if (!valid_group_scope(memory.group_id, memory.bot_id, false, "mid-memory", std::to_string(memory.id))) continue;
            Statement lookup(api, db, std::string("SELECT ") + import_mid_columns + " FROM mid_memories WHERE bot_id=? AND group_id=? AND text=?");
            lookup.bind(1, memory.bot_id); lookup.bind(2, memory.group_id); lookup.bind(3, memory.text);
            if (lookup.next()) {
                const auto existing = read_import_mid(lookup);
                const bool differs = existing.source_actor != memory.source_actor || existing.revision != memory.revision ||
                    existing.created_at_ms != memory.created_at_ms || existing.updated_at_ms != memory.updated_at_ms ||
                    existing.expires_at_ms != memory.expires_at_ms || existing.strength != memory.strength;
                if (differs && options.memory_conflict == StoreMemoryConflict::Reject) {
                    plan.issue("mid_memory_conflict", "mid-memory", std::to_string(memory.id)); continue;
                }
                ++plan.view.counts.mid_memories_preserved;
                plan.mid_memories.push_back({&memory, fingerprint, existing.id});
            } else {
                ++plan.view.counts.mid_memories_created;
                ++mid_additions[{memory.bot_id, memory.group_id}];
                plan.mid_memories.push_back({&memory, fingerprint, {}});
            }
        }
        if (!mid_additions.empty()) {
            Statement total(api, db, "SELECT count(*) FROM mid_memories");
            if (!total.next()) throw StoreError(StoreErrorCode::Storage, "Cannot count middle-term memories");
            if (static_cast<std::size_t>(total.integer(0)) + plan.view.counts.mid_memories_created > mid_memory_total_limit)
                plan.issue("mid_memory_total_limit", "archive", options.source_id);
            for (const auto& [scope, count] : mid_additions) {
                Statement rows(api, db, "SELECT count(*) FROM mid_memories WHERE bot_id=? AND group_id=?");
                rows.bind(1, scope.first); rows.bind(2, scope.second);
                if (!rows.next()) throw StoreError(StoreErrorCode::Storage, "Cannot count middle-term memory scope");
                if (static_cast<std::size_t>(rows.integer(0)) + count > mid_memory_scope_limit)
                    plan.issue("mid_memory_scope_limit", "mid-memory", scope.first + ":" + scope.second);
            }
        }
        plan.view.can_commit = plan.view.issue_count == 0;
        return plan;
    }

    void apply_import(const ImportWritePlan& plan, const ImportInput& input, const StoreImportOptions& options) {
        for (const auto* bot : plan.bots) {
            Statement insert(api, db, "INSERT INTO bots(id,name,persona,in_chat,in_work) VALUES(?,?,?,?,?)");
            insert.bind(1, bot->id); insert.bind(2, bot->name); insert.bind(3, bot->persona);
            insert.bind(4, static_cast<std::int64_t>(bot->in_chat));
            insert.bind(5, static_cast<std::int64_t>(bot->in_work)); insert.finish();
        }
        for (const auto* group : plan.groups) write_group(*group);
        for (const auto* message : plan.messages) {
            Statement insert(api, db,
                "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,?,?,?,?,?)");
            insert.bind(1, message->bot_id); insert.bind(2, message->group_id); insert.bind(3, mode_text(message->mode));
            insert.bind(4, message->actor); insert.bind(5, message->text);
            insert.bind(6, message->created_at_ms); insert.finish();
            const auto target_id = api.last_insert_rowid(db);
            write_context(target_id, message->context);
            add_source_mapping(false, options.source_id, message->id, target_id,
                               input.message_hashes.at(message->id));
        }
        std::map<Id, Id> imported_memory_ids;
        for (const auto& write : plan.memories) {
            Id target_id{};
            const auto& memory = *write.source;
            if (write.preserved) target_id = *write.preserved;
            else {
                Id supersedes_id = 0;
                if (memory.supersedes_id) {
                    if (const auto found = imported_memory_ids.find(memory.supersedes_id); found != imported_memory_ids.end())
                        supersedes_id = found->second;
                    else if (const auto previous = source_mapping(true, options.source_id, memory.supersedes_id);
                             previous && previous->target) supersedes_id = *previous->target;
                    else throw StoreError(StoreErrorCode::InvalidArgument, "Imported impression correction target is unavailable");
                }
                Statement insert(api, db,
                    "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,source_ref,participants,user_choice,outcome,target_bot_id,evidence,applicable_scenarios,supersedes_id) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
                insert.bind(1, memory.bot_id); insert.bind(2, memory.group_id); insert.bind(3, memory.text);
                insert.bind(4, state_text(memory.state)); insert.bind(5, memory.revision); insert.bind(6, memory.source_actor);
                insert.bind(7, memory.kind); insert.bind(8, memory.event_time_ms); insert.bind(9, memory.source_ref);
                insert.bind(10, memory.participants); insert.bind(11, memory.user_choice); insert.bind(12, memory.outcome);
                insert.bind(13, memory.target_bot_id); insert.bind(14, memory.evidence);
                insert.bind(15, memory.applicable_scenarios); insert.bind(16, supersedes_id); insert.finish();
                target_id = api.last_insert_rowid(db);
            }
            imported_memory_ids.emplace(memory.id, target_id);
            add_source_mapping(true, options.source_id, memory.id, target_id, write.fingerprint);
        }
        for (const auto& write : plan.mid_memories) {
            Id target_id{};
            if (write.preserved) target_id = *write.preserved;
            else {
                const auto& m = *write.source;
                Statement insert(api, db, "INSERT INTO mid_memories(bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength) VALUES(?,?,?,?,?,?,?,?,?)");
                insert.bind(1, m.bot_id); insert.bind(2, m.group_id); insert.bind(3, m.text); insert.bind(4, m.source_actor);
                insert.bind(5, m.revision); insert.bind(6, m.created_at_ms); insert.bind(7, m.updated_at_ms);
                insert.bind(8, m.expires_at_ms); insert.bind(9, m.strength); insert.finish();
                target_id = api.last_insert_rowid(db);
            }
            add_source_mapping(true, options.source_id, write.source->id, target_id, write.fingerprint, true);
        }
    }

    void require_one_change() const {
        if (api.changes(db) != 1) throw StoreError(StoreErrorCode::Conflict, "The record changed concurrently");
    }
};

Store::Store(const std::filesystem::path& database_path) : impl_(std::make_unique<Impl>(database_path)) {}
Store::~Store() = default;

StoreArchiveSnapshot Store::archive_snapshot(StoreArchiveSnapshotLimits limits) const {
    for (const auto count : {limits.max_bots, limits.max_groups, limits.max_messages, limits.max_memories, limits.max_mid_memories}) {
        if (count == 0 || static_cast<std::uint64_t>(count) >=
                static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
            throw StoreError(StoreErrorCode::InvalidArgument, "Snapshot count limits must be positive and fit SQLite LIMIT");
    }
    if (limits.max_record_bytes == 0)
        throw StoreError(StoreErrorCode::InvalidArgument, "Snapshot byte limit must be positive");
    auto remaining_bytes = limits.max_record_bytes;
    const auto charge = [&](std::size_t bytes) {
        if (bytes > remaining_bytes)
            throw StoreError(StoreErrorCode::LimitExceeded, "Native archive snapshot exceeds its record byte limit");
        remaining_bytes -= bytes;
    };
    const auto charge_columns = [&](const Statement& row, std::initializer_list<int> columns) {
        // Check raw UTF-8 column lengths before allocating the returned text.
        for (const auto column : columns) charge(row.text_bytes(column));
    };
    const auto count_row = [](std::size_t count, std::size_t maximum) {
        if (count >= maximum)
            throw StoreError(StoreErrorCode::LimitExceeded, "Native archive snapshot exceeds a record count limit");
    };
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    StoreArchiveSnapshot snapshot;
    const auto [revision, identity] = impl_->import_state(); // Establishes the read snapshot first.
    snapshot.source_id = "native-" + identity; snapshot.revision = revision;
    {
        Statement rows(impl_->api, impl_->db, "SELECT id,name,persona,in_chat,in_work FROM bots ORDER BY id LIMIT ?");
        rows.bind(1, static_cast<std::int64_t>(limits.max_bots) + 1);
        while (rows.next()) {
            count_row(snapshot.bots.size(), limits.max_bots);
            charge_columns(rows, {0, 1, 2});
            snapshot.bots.push_back(read_bot(rows));
        }
    }
    {
        Statement rows(impl_->api, impl_->db, std::string("SELECT ") + group_columns + " FROM groups ORDER BY id LIMIT ?");
        rows.bind(1, static_cast<std::int64_t>(limits.max_groups) + 1);
        while (rows.next()) {
            count_row(snapshot.groups.size(), limits.max_groups);
            charge_columns(rows, {0, 1, 2, 9, 10});
            for (int column = 3; column <= 5; ++column)
                if (rows.text_bytes(column) > 128U * 1024U)
                    throw StoreError(StoreErrorCode::Storage, "Stored group member array exceeds its native bound");
            auto group = read_group(rows);
            for (const auto* ids : {&group.members, &group.history_members, &group.admins})
                for (const auto& id : *ids) charge(id.size());
            snapshot.groups.push_back(std::move(group));
        }
    }
    {
        Statement rows(impl_->api, impl_->db,
            "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages ORDER BY id LIMIT ?");
        rows.bind(1, static_cast<std::int64_t>(limits.max_messages) + 1);
        while (rows.next()) {
            count_row(snapshot.messages.size(), limits.max_messages);
            charge_columns(rows, {1, 2, 3, 4, 5});
            auto message = impl_->read_message(rows);
            if (message.context) charge(message_context_json(*message.context).dump().size());
            snapshot.messages.push_back(std::move(message));
        }
    }
    {
        Statement rows(impl_->api, impl_->db, std::string("SELECT ") + memory_columns + " FROM memories ORDER BY id LIMIT ?");
        rows.bind(1, static_cast<std::int64_t>(limits.max_memories) + 1);
        while (rows.next()) {
            count_row(snapshot.memories.size(), limits.max_memories);
            charge_columns(rows, {1, 2, 3, 4, 6});
            snapshot.memories.push_back(read_memory(rows));
        }
    }
    {
        Statement rows(impl_->api, impl_->db, std::string("SELECT ") + import_mid_columns + " FROM mid_memories ORDER BY id LIMIT ?");
        rows.bind(1, static_cast<std::int64_t>(limits.max_mid_memories) + 1);
        while (rows.next()) {
            count_row(snapshot.mid_memories.size(), limits.max_mid_memories);
            charge_columns(rows, {1, 2, 3, 4});
            snapshot.mid_memories.push_back(read_import_mid(rows));
        }
    }
    transaction.commit();
    return snapshot;
}

StoreArchiveSnapshot Store::bot_archive_snapshot(std::string_view bot_id,
    const StoreBotArchiveFields& fields, StoreArchiveSnapshotLimits limits) const {
    validate_bot_id(bot_id);
    for (const auto count : {limits.max_messages, limits.max_memories, limits.max_mid_memories})
        if (!count || count >= static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
            throw StoreError(StoreErrorCode::InvalidArgument, "Invalid Bot archive count limit");
    if (!limits.max_record_bytes)
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid Bot archive byte limit");
    auto remaining = limits.max_record_bytes;
    const auto charge = [&](std::size_t bytes) {
        if (bytes > remaining)
            throw StoreError(StoreErrorCode::LimitExceeded, "Selected Bot archive content exceeds its byte limit");
        remaining -= bytes;
    };
    const auto charge_columns = [&](const Statement& row, std::initializer_list<int> columns) {
        for (const int column : columns) charge(row.text_bytes(column));
    };
    const auto count_row = [](std::size_t count, std::size_t maximum) {
        if (count >= maximum)
            throw StoreError(StoreErrorCode::LimitExceeded, "Selected Bot archive content exceeds its record limit");
    };
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    StoreArchiveSnapshot snapshot;
    const auto [revision, identity] = impl_->import_state();
    snapshot.source_id = "native-" + identity; snapshot.revision = revision;
    {
        const auto sql = std::string("SELECT id,") + (fields.name ? "name" : "'Imported Bot'") + "," +
            (fields.persona ? "persona" : "''") + ",0,0 FROM bots WHERE id=?";
        Statement row(impl_->api, impl_->db, sql); row.bind(1, bot_id);
        if (!row.next()) throw StoreError(StoreErrorCode::NotFound, "Bot does not exist");
        charge_columns(row, {0, 1, 2}); snapshot.bots.push_back(read_bot(row));
    }
    if (fields.chat_history || fields.work_history) {
        Statement rows(impl_->api, impl_->db,
            "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE bot_id=? AND group_id='' "
            "AND ((mode='chat' AND ?=1) OR (mode='work' AND ?=1)) ORDER BY id LIMIT ?");
        rows.bind(1, bot_id); rows.bind(2, static_cast<std::int64_t>(fields.chat_history));
        rows.bind(3, static_cast<std::int64_t>(fields.work_history));
        rows.bind(4, static_cast<std::int64_t>(limits.max_messages) + 1);
        while (rows.next()) {
            count_row(snapshot.messages.size(), limits.max_messages); charge_columns(rows, {1, 2, 3, 4, 5});
            auto message = impl_->read_message(rows);
            if (message.context) charge(message_context_json(*message.context).dump().size());
            snapshot.messages.push_back(std::move(message));
        }
    }
    if (fields.long_term_memory || fields.relations) {
        std::string sql = std::string("SELECT ") + memory_columns + " FROM memories WHERE bot_id=? AND group_id=''";
        if (fields.long_term_memory != fields.relations)
            sql += " AND (substr(text,1,?)=?)=?";
        sql += " ORDER BY id LIMIT ?";
        Statement rows(impl_->api, impl_->db, sql); rows.bind(1, bot_id);
        int parameter = 2;
        if (fields.long_term_memory != fields.relations) {
            rows.bind(parameter++, static_cast<std::int64_t>(relation_note_reserved_prefix.size()));
            rows.bind(parameter++, relation_note_reserved_prefix);
            rows.bind(parameter++, static_cast<std::int64_t>(fields.relations));
        }
        rows.bind(parameter, static_cast<std::int64_t>(limits.max_memories) + 1);
        while (rows.next()) {
            count_row(snapshot.memories.size(), limits.max_memories); charge_columns(rows, {1, 2, 3, 4, 6});
            snapshot.memories.push_back(read_memory(rows));
        }
    }
    if (fields.mid_term_memory) {
        Statement rows(impl_->api, impl_->db, std::string("SELECT ") + import_mid_columns +
            " FROM mid_memories WHERE bot_id=? AND group_id='' ORDER BY id LIMIT ?");
        rows.bind(1, bot_id); rows.bind(2, static_cast<std::int64_t>(limits.max_mid_memories) + 1);
        while (rows.next()) {
            count_row(snapshot.mid_memories.size(), limits.max_mid_memories); charge_columns(rows, {1, 2, 3, 4});
            snapshot.mid_memories.push_back(read_import_mid(rows));
        }
    }
    transaction.commit(); return snapshot;
}

std::optional<StoreBotArchiveReceipt> Store::bot_archive_receipt(std::string_view key) const {
    if (!lower_hex(key, 64)) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid Bot archive source key");
    std::lock_guard lock(impl_->mutex);
    Statement row(impl_->api, impl_->db, "SELECT target_id,selection_digest FROM bot_archive_receipts WHERE source_key=?");
    row.bind(1, key);
    if (!row.next()) return {};
    return StoreBotArchiveReceipt{std::string(key), row.text(0), row.text(1)};
}

std::string Store::source_namespace() const {
    std::lock_guard lock(impl_->mutex);
    return "native-" + impl_->import_state().second;
}

ConversationStatistics Store::conversation_statistics(std::string_view bot, Mode mode, std::string_view group) const {
    validate_bot_id(bot); validate_scope(group); const auto selected_mode = mode_text(mode);
    std::lock_guard lock(impl_->mutex); (void)impl_->require_bot(bot);
    Statement row(impl_->api, impl_->db,
        "SELECT count(*),coalesce(sum(length(CAST(text AS BLOB))),0),coalesce(sum(length(text)),0),coalesce(min(id),0),coalesce(max(id),0) FROM messages WHERE bot_id=? AND mode=? AND group_id=?");
    row.bind(1, bot); row.bind(2, selected_mode); row.bind(3, group);
    if (!row.next()) throw StoreError(StoreErrorCode::Storage, "Cannot read conversation statistics");
    return {row.integer(0), row.integer(1), row.integer(2), row.integer(3), row.integer(4)};
}

ConversationSnapshot Store::conversation_snapshot(std::string_view bot, Mode mode, std::string_view group) const {
    validate_bot_id(bot); validate_scope(group); (void)mode_text(mode);
    std::lock_guard lock(impl_->mutex);
    Transaction snapshot(impl_->api, impl_->db, true);
    auto result = impl_->conversation_snapshot_unlocked(bot, mode, group);
    snapshot.commit(); return result;
}

std::optional<Message> Store::find_message(Id id) const {
    if (id <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid message ID");
    std::lock_guard lock(impl_->mutex);
    Statement row(impl_->api, impl_->db, "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE id=?");
    row.bind(1, id);
    if (!row.next()) return {};
    return impl_->read_message(row);
}

std::vector<Store::SearchHit> Store::search_text(std::string_view query, std::size_t limit) const {
    const std::string value = std::string(trim(query));
    if (value.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Search query cannot be empty");
    validate_text(value, 160, false, "Search query");
    if (!limit || limit > 100) throw StoreError(StoreErrorCode::InvalidArgument, "Search limit must be 1..100");
    std::string escaped;
    for (const char ch : value) {
        if (ch == '%' || ch == '_' || ch == '\\') escaped.push_back('\\');
        escaped.push_back(ch);
    }
    const std::string pattern = "%" + escaped + "%";
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    sqlite3* const conn = use_read_conn ? impl_->read_db : impl_->db;
    const auto cap = static_cast<std::int64_t>(limit);
    Statement select(impl_->api, conn, R"SQL(
SELECT kind,identity,bot_id,group_id,mode,actor,state,text,record_id,timestamp FROM (
    SELECT * FROM (
        SELECT 'bot' AS kind,id AS identity,'' AS bot_id,'' AS group_id,'' AS mode,'' AS actor,'' AS state,
               name AS text,0 AS record_id,0 AS timestamp FROM bots WHERE name LIKE ? ESCAPE '\'
        ORDER BY id DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
        SELECT 'group',id,'',id,'','','',name,0,0 FROM groups WHERE deleted=0 AND name LIKE ? ESCAPE '\'
        ORDER BY id DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
        SELECT 'message','',bot_id,group_id,mode,actor,'',substr(text,1,1200),id,created_at_ms
          FROM messages WHERE mode='chat' AND text LIKE ? ESCAPE '\'
        ORDER BY created_at_ms DESC,id DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
        SELECT 'memory','',bot_id,group_id,'',source_actor,state,substr(text,1,1200),id,id
          FROM memories WHERE state IN ('candidate','confirmed') AND text LIKE ? ESCAPE '\'
            AND substr(text,1,?)<>? COLLATE BINARY
        ORDER BY id DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
        SELECT 'mid_memory','',bot_id,group_id,'',source_actor,'',substr(text,1,1200),id,updated_at_ms
          FROM mid_memories WHERE text LIKE ? ESCAPE '\'
        ORDER BY updated_at_ms DESC,id DESC LIMIT ?
    )
) ORDER BY CASE kind WHEN 'bot' THEN 0 WHEN 'group' THEN 1 WHEN 'message' THEN 2 WHEN 'memory' THEN 3 ELSE 4 END,
           timestamp DESC,record_id DESC LIMIT ?
)SQL");
    select.bind(1, pattern); select.bind(2, cap);
    select.bind(3, pattern); select.bind(4, cap);
    select.bind(5, pattern); select.bind(6, cap);
    select.bind(7, pattern); select.bind(8, static_cast<std::int64_t>(relation_note_reserved_prefix.size()));
    select.bind(9, relation_note_reserved_prefix); select.bind(10, cap);
    select.bind(11, pattern); select.bind(12, cap);
    select.bind(13, cap);
    std::vector<SearchHit> result;
    while (select.next()) result.push_back({select.text(0), select.text(1), select.text(2), select.text(3),
        select.text(4), select.text(5), select.text(6), select.text(7), select.integer(8), select.integer(9)});
    return result;
}

bool Store::delete_chat_message(std::string_view bot, std::string_view group, Id id) {
    if (id <= 0 || bot.empty() == group.empty())
        throw StoreError(StoreErrorCode::InvalidArgument, "Select one Chat conversation and a positive message ID");
    if (group.empty()) validate_bot_id(bot);
    else validate_group_id(group);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (group.empty()) (void)impl_->require_bot(bot);
    else (void)impl_->require_group(group);
    {
        Statement previous(impl_->api, impl_->db,
            "SELECT bot_id,group_id FROM message_deletions WHERE message_id=? AND mode='chat'");
        previous.bind(1, id);
        if (previous.next()) {
            if (previous.text(1) != group || (group.empty() && previous.text(0) != bot))
                throw StoreError(StoreErrorCode::NotFound, "Chat message does not exist in this conversation");
            transaction.commit();
            return false;
        }
    }
    std::string author;
    {
        Statement source(impl_->api, impl_->db,
            "SELECT bot_id,group_id,mode FROM messages WHERE id=?");
        source.bind(1, id);
        if (!source.next() || source.text(2) != "chat" || source.text(1) != group ||
            (group.empty() && source.text(0) != bot))
            throw StoreError(StoreErrorCode::NotFound, "Chat message does not exist in this conversation");
        author = source.text(0);
    }
    Statement tombstone(impl_->api, impl_->db,
        "INSERT INTO message_deletions(message_id,bot_id,group_id,mode) VALUES(?,?,?,'chat')");
    tombstone.bind(1, id); tombstone.bind(2, author); tombstone.bind(3, group); tombstone.finish();
    // Foreign keys tombstone message/import receipts and remove only this
    // row's attached context. Other messages' embedded snapshots remain intact.
    Statement remove(impl_->api, impl_->db, "DELETE FROM messages WHERE id=? AND mode='chat' AND group_id=? AND bot_id=?");
    remove.bind(1, id); remove.bind(2, group); remove.bind(3, author); remove.finish();
    transaction.commit();
    return true;
}

Message Store::append_summary_once(std::string_view bot, std::string_view text,
    std::string_view request, std::string_view expected) {
    validate_bot_id(bot); validate_text(text, 1048576, false, "Summary"); validate_text(request, 1024, false, "Summary request key");
    if (!lower_hex(expected, 64)) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid conversation snapshot fingerprint");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db); (void)impl_->require_bot(bot);
    Statement receipt(impl_->api, impl_->db,
        "SELECT message_id FROM message_receipts WHERE bot_id=? AND mode='chat' AND group_id='' AND request_key=?");
    receipt.bind(1, bot); receipt.bind(2, request);
    if (receipt.next()) {
        const auto id = receipt.integer(0);
        if (id <= 0) throw StoreError(StoreErrorCode::Conflict, "Summary receipt has a deleted message tombstone");
        auto result = impl_->require_message(id);
        if (result.actor != "system" || result.text != text || result.context)
            throw StoreError(StoreErrorCode::Conflict, "Summary request identifies different content");
        transaction.commit(); return result;
    }
    if (impl_->conversation_snapshot_unlocked(bot, Mode::Chat, "").fingerprint != expected)
        throw StoreError(StoreErrorCode::Conflict, "Conversation changed during summarization; all original messages remain");
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,'','chat','system',?,?)");
    insert.bind(1, bot); insert.bind(2, text); insert.bind(3, timestamp); insert.finish();
    const auto id = impl_->api.last_insert_rowid(impl_->db);
    Statement mark(impl_->api, impl_->db,
        "INSERT INTO message_receipts(bot_id,mode,group_id,request_key,message_id) VALUES(?,'chat','',?,?)");
    mark.bind(1, bot); mark.bind(2, request); mark.bind(3, id); mark.finish();
    transaction.commit();
    return {id, std::string(bot), "", Mode::Chat, "system", std::string(text), timestamp};
}

StoreImportPlan Store::prepare_archive_import(const ArchiveDocument& archive, const StoreImportOptions& options) const {
    const auto input = import_input(archive, options);
    std::lock_guard lock(impl_->mutex);
    Transaction snapshot(impl_->api, impl_->db, true);
    auto plan = impl_->plan_import(input, options);
    snapshot.commit();
    return std::move(plan.view);
}

StoreImportResult Store::commit_archive_import(const ArchiveDocument& archive, const StoreImportOptions& options,
                                               std::int64_t expected_revision, std::string_view expected_digest) {
    if (expected_revision < 0 || !lower_hex(expected_digest, 64))
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid archive preparation token");
    const auto input = import_input(archive, options);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (impl_->import_state().first != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "Archive target changed; prepare again");
    auto plan = impl_->plan_import(input, options);
    if (plan.view.digest != expected_digest)
        throw StoreError(StoreErrorCode::Conflict, "Archive document, source, policies or target changed");
    if (!plan.view.can_commit)
        throw StoreError(StoreErrorCode::Conflict, "Archive import has blocking conflicts or unsupported scopes");
    impl_->apply_import(plan, input, options);
    const auto after = impl_->import_state().first;
    StoreImportResult result{expected_revision, after, plan.view.digest, plan.view.counts, plan.view.archive_version};
    transaction.commit();
    return result;
}

StoreImportResult Store::commit_bot_archive_import(const ArchiveDocument& archive,
    const StoreImportOptions& options, const StoreBotArchiveReceipt& receipt,
    std::int64_t expected_revision, std::string_view expected_digest,
    const std::function<void()>& before_create, const std::function<void()>& on_create_failure) {
    if (expected_revision < 0 || !lower_hex(expected_digest, 64) || !lower_hex(receipt.source_key, 64) ||
        !lower_hex(receipt.selection_digest, 64) || archive.bots().size() != 1 ||
        archive.bots().front().id != receipt.target_id || !archive.groups().empty() ||
        options.source_id != "botarchive-" + receipt.source_key)
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid single-Bot import preparation");
    for (const auto& c : archive.conversations())
        if (!c.group_id.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Bot archive cannot import group history");
    for (const auto& m : archive.memories())
        if (!m.group_id.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Bot archive cannot import group memories");
    for (const auto& m : archive.mid_memories())
        if (!m.group_id.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Bot archive cannot import group notes");
    const auto input = import_input(archive, options);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (impl_->import_state().first != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "Bot archive target changed; prepare again");
    bool replay = false;
    {
        Statement previous(impl_->api, impl_->db,
            "SELECT target_id,selection_digest FROM bot_archive_receipts WHERE source_key=?");
        previous.bind(1, receipt.source_key);
        if (previous.next()) {
            if (previous.text(0) != receipt.target_id || previous.text(1) != receipt.selection_digest)
                throw StoreError(StoreErrorCode::Conflict, "This Bot source was imported with different content or selections");
            replay = true;
        }
    }
    if (!replay && impl_->find_bot_unlocked(receipt.target_id))
        throw StoreError(StoreErrorCode::Conflict, "Bot archive target ID already exists");
    auto plan = impl_->plan_import(input, options);
    if (plan.view.digest != expected_digest || !plan.view.can_commit)
        throw StoreError(StoreErrorCode::Conflict, "Bot archive preparation changed or has blocking conflicts");
    const auto& counts = plan.view.counts;
    if (replay && (counts.bots_created || counts.messages_created || counts.memories_created ||
                   counts.memories_preserved || counts.mid_memories_created || counts.mid_memories_preserved))
        throw StoreError(StoreErrorCode::Conflict, "Bot archive replay cannot add records to an existing Bot");
    if (!replay && counts.bots_created != 1)
        throw StoreError(StoreErrorCode::Conflict, "Bot archive must create a new identity");
    try {
        if (!replay && before_create) before_create();
        impl_->apply_import(plan, input, options);
        if (!replay) {
            Statement insert(impl_->api, impl_->db,
                "INSERT INTO bot_archive_receipts(source_key,target_id,selection_digest) VALUES(?,?,?)");
            insert.bind(1, receipt.source_key); insert.bind(2, receipt.target_id);
            insert.bind(3, receipt.selection_digest); insert.finish();
        }
        StoreImportResult result{expected_revision, impl_->import_state().first, plan.view.digest,
                                 plan.view.counts, plan.view.archive_version};
        transaction.commit(); return result;
    } catch (...) {
        if (!replay && on_create_failure) on_create_failure();
        throw;
    }
}

Bot Store::create_bot(std::string_view name, std::string_view persona, std::string_view id) {
    name = trim(name);
    validate_text(name, 1024, false, "Bot name");
    validate_text(persona, 262144, true, "Persona");
    const std::string selected_id = id.empty() ? new_bot_id() : std::string(id);
    validate_bot_id(selected_id);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    Statement insert(impl_->api, impl_->db, "INSERT INTO bots(id,name,persona) VALUES(?,?,?)");
    insert.bind(1, selected_id);
    insert.bind(2, name);
    insert.bind(3, persona);
    insert.finish();
    transaction.commit();
    return {selected_id, std::string(name), std::string(persona), false, false};
}

std::optional<Bot> Store::find_bot(std::string_view bot_id) const {
    validate_bot_id(bot_id);
    std::lock_guard lock(impl_->mutex);
    return impl_->find_bot_unlocked(bot_id);
}

std::vector<Bot> Store::list_bots(std::optional<Mode> roster) const {
    std::string sql = "SELECT id,name,persona,in_chat,in_work FROM bots";
    if (roster) {
        (void)mode_text(*roster);
        sql += *roster == Mode::Chat ? " WHERE in_chat=1" : " WHERE in_work=1";
    }
    sql += " ORDER BY id";
    std::lock_guard lock(impl_->mutex);
    Statement select(impl_->api, impl_->db, sql);
    std::vector<Bot> bots;
    while (select.next()) bots.push_back(read_bot(select));
    return bots;
}

std::vector<Bot> Store::list_active_roster_bots() const {
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    auto* handle = use_read_conn ? impl_->read_db : impl_->db;
    Statement select(impl_->api, handle,
        "SELECT id,name,in_chat,in_work FROM bots WHERE in_chat=1 OR in_work=1 ORDER BY id");
    std::vector<Bot> bots;
    while (select.next()) {
        bots.push_back({select.text(0), select.text(1), {}, select.integer(2) != 0, select.integer(3) != 0});
    }
    return bots;
}

std::int64_t Store::current_revision() const {
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    auto* handle = use_read_conn ? impl_->read_db : impl_->db;
    Statement select(impl_->api, handle, "SELECT revision FROM store_revision WHERE singleton=1");
    return select.next() ? select.integer(0) : 0;
}

std::optional<ChatDeliveryReceipt> Store::find_chat_delivery_receipt(std::string_view receipt_key) const {
    if (receipt_key.empty() || receipt_key.size() > 512) return std::nullopt;
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    auto* handle = use_read_conn ? impl_->read_db : impl_->db;
    Statement select(impl_->api, handle,
        "SELECT receipt_key,bot_id,run_id,message_id,request_id,saved,payload_json,updated_at_ms "
        "FROM chat_delivery_receipts WHERE receipt_key=?");
    select.bind(1, receipt_key);
    if (!select.next()) return std::nullopt;
    return ChatDeliveryReceipt{
        select.text(0), select.text(1), select.text(2), select.text(3),
        select.text(4), select.integer(5) != 0, select.text(6), select.integer(7)
    };
}

std::optional<ChatDeliveryReceipt> Store::find_chat_delivery_receipt_by_run(std::string_view run_id) const {
    if (run_id.empty() || run_id.size() > 256) return std::nullopt;
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    auto* handle = use_read_conn ? impl_->read_db : impl_->db;
    Statement select(impl_->api, handle,
        "SELECT receipt_key,bot_id,run_id,message_id,request_id,saved,payload_json,updated_at_ms "
        "FROM chat_delivery_receipts WHERE run_id=? LIMIT 1");
    select.bind(1, run_id);
    if (!select.next()) return std::nullopt;
    return ChatDeliveryReceipt{
        select.text(0), select.text(1), select.text(2), select.text(3),
        select.text(4), select.integer(5) != 0, select.text(6), select.integer(7)
    };
}

std::vector<ChatDeliveryReceipt> Store::list_unsaved_chat_delivery_receipts() const {
    const bool use_read_conn = impl_->read_db != nullptr;
    std::lock_guard lock(use_read_conn ? impl_->read_mutex : impl_->mutex);
    auto* handle = use_read_conn ? impl_->read_db : impl_->db;
    Statement select(impl_->api, handle,
        "SELECT receipt_key,bot_id,run_id,message_id,request_id,saved,payload_json,updated_at_ms "
        "FROM chat_delivery_receipts WHERE saved=0 ORDER BY updated_at_ms ASC");
    std::vector<ChatDeliveryReceipt> out;
    while (select.next()) {
        out.push_back(ChatDeliveryReceipt{
            select.text(0), select.text(1), select.text(2), select.text(3),
            select.text(4), select.integer(5) != 0, select.text(6), select.integer(7)
        });
    }
    return out;
}

void Store::upsert_chat_delivery_receipt(const ChatDeliveryReceipt& r) {
    if (r.receipt_key.empty() || r.receipt_key.size() > 512) return;
    std::lock_guard lock(impl_->mutex);
    Transaction tx(impl_->api, impl_->db);
    Statement upsert(impl_->api, impl_->db,
        "INSERT INTO chat_delivery_receipts(receipt_key,bot_id,run_id,message_id,request_id,saved,payload_json,updated_at_ms) "
        "VALUES(?,?,?,?,?,?,?,?) "
        "ON CONFLICT(receipt_key) DO UPDATE SET "
        "bot_id=excluded.bot_id,run_id=excluded.run_id,message_id=excluded.message_id,"
        "request_id=excluded.request_id,saved=excluded.saved,payload_json=excluded.payload_json,"
        "updated_at_ms=excluded.updated_at_ms");
    upsert.bind(1, r.receipt_key);
    upsert.bind(2, r.bot_id);
    upsert.bind(3, r.run_id);
    upsert.bind(4, r.message_id);
    upsert.bind(5, r.request_id);
    upsert.bind(6, static_cast<std::int64_t>(r.saved ? 1 : 0));
    upsert.bind(7, r.payload_json);
    upsert.bind(8, r.updated_at_ms);
    upsert.finish();
    tx.commit();
}

void Store::upsert_chat_delivery_receipts_batch(const std::vector<ChatDeliveryReceipt>& receipts) {
    if (receipts.empty()) return;
    std::lock_guard lock(impl_->mutex);
    Transaction tx(impl_->api, impl_->db);
    for (const auto& r : receipts) {
        if (r.receipt_key.empty() || r.receipt_key.size() > 512) continue;
        Statement upsert(impl_->api, impl_->db,
            "INSERT INTO chat_delivery_receipts(receipt_key,bot_id,run_id,message_id,request_id,saved,payload_json,updated_at_ms) "
            "VALUES(?,?,?,?,?,?,?,?) "
            "ON CONFLICT(receipt_key) DO UPDATE SET "
            "bot_id=excluded.bot_id,run_id=excluded.run_id,message_id=excluded.message_id,"
            "request_id=excluded.request_id,saved=excluded.saved,payload_json=excluded.payload_json,"
            "updated_at_ms=excluded.updated_at_ms");
        upsert.bind(1, r.receipt_key);
        upsert.bind(2, r.bot_id);
        upsert.bind(3, r.run_id);
        upsert.bind(4, r.message_id);
        upsert.bind(5, r.request_id);
        upsert.bind(6, static_cast<std::int64_t>(r.saved ? 1 : 0));
        upsert.bind(7, r.payload_json);
        upsert.bind(8, r.updated_at_ms);
        upsert.finish();
    }
    tx.commit();
}

void Store::mark_bot_chat_delivery_receipts_saved(std::string_view bot_id) {
    if (bot_id.empty()) return;
    std::lock_guard lock(impl_->mutex);
    Transaction tx(impl_->api, impl_->db);
    Statement upd(impl_->api, impl_->db,
        "UPDATE chat_delivery_receipts SET saved=1 WHERE bot_id=? AND saved=0");
    upd.bind(1, bot_id);
    upd.finish();
    tx.commit();
}

std::size_t Store::prune_saved_chat_delivery_receipts(std::size_t keep_recent) {
    std::lock_guard lock(impl_->mutex);
    Transaction tx(impl_->api, impl_->db);
    Statement del(impl_->api, impl_->db,
        "DELETE FROM chat_delivery_receipts WHERE saved=1 AND receipt_key NOT IN ("
        "SELECT receipt_key FROM chat_delivery_receipts WHERE saved=1 ORDER BY updated_at_ms DESC, receipt_key DESC LIMIT ?)");
    del.bind(1, static_cast<std::int64_t>(std::max<std::size_t>(keep_recent, 100U)));
    del.finish();
    const auto removed = static_cast<std::size_t>(std::max(0, impl_->api.changes(impl_->db)));
    tx.commit();
    return removed;
}

Bot Store::set_roster(std::string_view bot_id, Mode mode, bool present) {
    validate_bot_id(bot_id);
    (void)mode_text(mode);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto bot = impl_->require_bot(bot_id);
    Statement update(impl_->api, impl_->db, mode == Mode::Chat
        ? "UPDATE bots SET in_chat=? WHERE id=?" : "UPDATE bots SET in_work=? WHERE id=?");
    update.bind(1, static_cast<std::int64_t>(present));
    update.bind(2, bot_id);
    update.finish();
    impl_->require_one_change();
    transaction.commit();
    if (mode == Mode::Chat) bot.in_chat = present;
    else bot.in_work = present;
    return bot;
}

void Store::remove_bot(std::string_view bot_id, std::optional<Mode> mode) {
    validate_bot_id(bot_id);
    if (mode) (void)mode_text(*mode);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    Statement detach(impl_->api, impl_->db, !mode
        ? "UPDATE bots SET in_chat=0,in_work=0 WHERE id=?"
        : *mode == Mode::Chat ? "UPDATE bots SET in_chat=0 WHERE id=?"
                             : "UPDATE bots SET in_work=0 WHERE id=?");
    detach.bind(1, bot_id);
    detach.finish();
    impl_->require_one_change();
    Statement clear(impl_->api, impl_->db, mode
        ? "DELETE FROM messages WHERE bot_id=? AND group_id='' AND mode=?"
        : "DELETE FROM messages WHERE bot_id=? AND group_id=''");
    clear.bind(1, bot_id);
    if (mode) clear.bind(2, mode_text(*mode));
    clear.finish();
    transaction.commit();
}

Bot Store::update_bot_profile(std::string_view bot_id,
    std::optional<std::string> name, std::optional<std::string> persona) {
    const auto profile = normalize_profile({std::string(bot_id), std::move(name), std::move(persona)});
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto result = impl_->update_profile(profile);
    transaction.commit();
    return result;
}

BotProfileSnapshot Store::read_bot_profile(std::string_view bot_id) const {
    validate_bot_id(bot_id);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    auto bot = impl_->require_bot(bot_id);
    auto revision = import_hash({"dimension-bot-profile-v1", impl_->import_state().second, bot.id, bot.name, bot.persona});
    transaction.commit();
    return {std::move(bot), std::move(revision)};
}

BotProfileSnapshot Store::save_bot_profile(std::string_view bot_id,
    std::string_view expected_revision, std::string_view persona) {
    validate_bot_id(bot_id); validate_text(persona, 262144, true, "Persona");
    if (!lower_hex(expected_revision, 64)) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid profile revision");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    const auto before = impl_->require_bot(bot_id);
    const auto identity = impl_->import_state().second;
    const auto before_revision = import_hash({"dimension-bot-profile-v1", identity, before.id, before.name, before.persona});
    if (before_revision != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "人设已在其他位置修改，草稿保留，请重新打开档案核对");
    if (before.persona == persona) { transaction.commit(); return {before, before_revision}; }
    Statement history(impl_->api, impl_->db,
        "INSERT INTO persona_revisions(bot_id,persona,profile_revision,action,restored_revision_id,created_at_ms) VALUES(?,?,?,'save',0,?)");
    history.bind(1, bot_id); history.bind(2, before.persona); history.bind(3, before_revision);
    history.bind(4, std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    history.finish();
    auto bot = impl_->update_profile({std::string(bot_id), {}, std::string(persona)});
    auto revision = import_hash({"dimension-bot-profile-v1", identity, bot.id, bot.name, bot.persona});
    transaction.commit(); return {std::move(bot), std::move(revision)};
}

BotProfileSnapshot Store::restore_bot_profile(std::string_view bot_id,
    std::string_view expected_revision, Id revision_id) {
    validate_bot_id(bot_id); validate_revision(revision_id);
    if (!lower_hex(expected_revision, 64)) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid profile revision");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    const auto before = impl_->require_bot(bot_id);
    const auto identity = impl_->import_state().second;
    const auto before_revision = import_hash({"dimension-bot-profile-v1", identity, before.id, before.name, before.persona});
    if (before_revision != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "人设已在其他位置修改，请重新读取后再恢复");
    Statement selected(impl_->api, impl_->db,
        "SELECT persona FROM persona_revisions WHERE id=? AND bot_id=?");
    selected.bind(1, revision_id); selected.bind(2, bot_id);
    if (!selected.next()) throw StoreError(StoreErrorCode::NotFound, "这个 Bot 没有该人设修订");
    const auto persona = selected.text(0);
    if (persona == before.persona) throw StoreError(StoreErrorCode::Conflict, "该版本已经是当前人设");
    Statement history(impl_->api, impl_->db,
        "INSERT INTO persona_revisions(bot_id,persona,profile_revision,action,restored_revision_id,created_at_ms) VALUES(?,?,?,'restore',?,?)");
    history.bind(1, bot_id); history.bind(2, before.persona); history.bind(3, before_revision);
    history.bind(4, revision_id);
    history.bind(5, std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    history.finish();
    auto bot = impl_->update_profile({std::string(bot_id), {}, persona});
    auto revision = import_hash({"dimension-bot-profile-v1", identity, bot.id, bot.name, bot.persona});
    transaction.commit(); return {std::move(bot), std::move(revision)};
}

std::vector<PersonaRevision> Store::persona_revisions(std::string_view bot_id, std::size_t limit) const {
    validate_bot_id(bot_id);
    if (limit == 0 || limit > 50) throw StoreError(StoreErrorCode::InvalidArgument, "Persona revision page must contain 1 to 50 rows");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    (void)impl_->require_bot(bot_id);
    Statement rows(impl_->api, impl_->db,
        "SELECT id,bot_id,persona,profile_revision,action,restored_revision_id,created_at_ms FROM persona_revisions WHERE bot_id=? ORDER BY id DESC LIMIT ?");
    rows.bind(1, bot_id); rows.bind(2, static_cast<std::int64_t>(limit));
    std::vector<PersonaRevision> result;
    while (rows.next()) result.push_back({rows.integer(0), rows.text(1), rows.text(2), rows.text(3),
        rows.text(4), rows.integer(5), rows.integer(6)});
    transaction.commit(); return result;
}

std::optional<ConversationDraft> Store::read_conversation_draft(Mode mode,
    std::string_view bot_id, std::string_view group_id) const {
    (void)mode_text(mode);
    if (bot_id.empty() == group_id.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Draft requires exactly one Bot or group");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    if (bot_id.empty()) (void)impl_->require_group(group_id); else (void)impl_->require_bot(bot_id);
    Statement row(impl_->api, impl_->db,
        "SELECT text,revision,updated_at_ms FROM conversation_drafts WHERE mode=? AND bot_id=? AND group_id=?");
    row.bind(1, mode_text(mode)); row.bind(2, bot_id); row.bind(3, group_id);
    std::optional<ConversationDraft> result;
    if (row.next()) result = ConversationDraft{mode, std::string(bot_id), std::string(group_id), row.text(0), row.integer(1), row.integer(2)};
    transaction.commit(); return result;
}

ConversationDraft Store::save_conversation_draft(Mode mode, std::string_view bot_id,
    std::string_view group_id, std::string_view text, std::int64_t expected_revision) {
    (void)mode_text(mode); validate_text(text, 65536, false, "Conversation draft");
    if (bot_id.empty() == group_id.empty() || expected_revision < 0)
        throw StoreError(StoreErrorCode::InvalidArgument, "Draft scope or revision is invalid");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (bot_id.empty()) (void)impl_->require_group(group_id); else (void)impl_->require_bot(bot_id);
    Statement current(impl_->api, impl_->db,
        "SELECT revision FROM conversation_drafts WHERE mode=? AND bot_id=? AND group_id=?");
    current.bind(1, mode_text(mode)); current.bind(2, bot_id); current.bind(3, group_id);
    const bool exists = current.next();
    const auto revision = exists ? current.integer(0) : 0;
    if (revision != expected_revision) throw StoreError(StoreErrorCode::Conflict, "草稿已在其他窗口更新，请保留当前输入并重新核对");
    if (revision == std::numeric_limits<std::int64_t>::max()) throw StoreError(StoreErrorCode::LimitExceeded, "Draft revision exhausted");
    if (!exists) {
        Statement count(impl_->api, impl_->db, "SELECT count(*) FROM conversation_drafts");
        if (!count.next() || count.integer(0) >= 512) throw StoreError(StoreErrorCode::LimitExceeded, "最多保存512个上下文草稿");
    }
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    Statement write(impl_->api, impl_->db,
        "INSERT INTO conversation_drafts(mode,bot_id,group_id,text,revision,updated_at_ms) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(mode,bot_id,group_id) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at_ms=excluded.updated_at_ms");
    write.bind(1, mode_text(mode)); write.bind(2, bot_id); write.bind(3, group_id); write.bind(4, text);
    write.bind(5, revision + 1); write.bind(6, timestamp); write.finish();
    transaction.commit();
    return {mode, std::string(bot_id), std::string(group_id), std::string(text), revision + 1, timestamp};
}

bool Store::clear_conversation_draft(Mode mode, std::string_view bot_id,
    std::string_view group_id, std::int64_t expected_revision) {
    (void)mode_text(mode); validate_revision(expected_revision);
    if (bot_id.empty() == group_id.empty()) throw StoreError(StoreErrorCode::InvalidArgument, "Draft requires exactly one Bot or group");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (bot_id.empty()) (void)impl_->require_group(group_id); else (void)impl_->require_bot(bot_id);
    Statement current(impl_->api, impl_->db,
        "SELECT revision FROM conversation_drafts WHERE mode=? AND bot_id=? AND group_id=?");
    current.bind(1, mode_text(mode)); current.bind(2, bot_id); current.bind(3, group_id);
    if (!current.next()) { transaction.commit(); return false; }
    if (current.integer(0) != expected_revision) throw StoreError(StoreErrorCode::Conflict, "草稿已有更新，发送不会清除新输入");
    Statement clear(impl_->api, impl_->db,
        "DELETE FROM conversation_drafts WHERE mode=? AND bot_id=? AND group_id=? AND revision=?");
    clear.bind(1, mode_text(mode)); clear.bind(2, bot_id); clear.bind(3, group_id); clear.bind(4, expected_revision); clear.finish();
    impl_->require_one_change(); transaction.commit(); return true;
}

Group Store::create_group(const Group& value) {
    auto group = normalize_group(value);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    impl_->write_group(group);
    transaction.commit();
    return group;
}

std::optional<Group> Store::find_group(std::string_view group_id) const {
    validate_group_id(group_id);
    std::lock_guard lock(impl_->mutex);
    return impl_->find_group_unlocked(group_id);
}

std::vector<Group> Store::list_groups(std::optional<Mode> roster, bool include_deleted) const {
    std::string sql = std::string("SELECT ") + group_columns + " FROM groups WHERE 1=1";
    if (!include_deleted) sql += " AND deleted=0";
    if (roster) { (void)mode_text(*roster); sql += *roster == Mode::Chat ? " AND in_chat=1" : " AND in_work=1"; }
    sql += " ORDER BY id";
    std::lock_guard lock(impl_->mutex);
    Statement select(impl_->api, impl_->db, sql);
    std::vector<Group> groups;
    while (select.next()) groups.push_back(read_group(select));
    return groups;
}

Group Store::replace_group(const Group& value, std::int64_t expected_revision) {
    validate_revision(expected_revision);
    auto input = value; input.revision = expected_revision;
    auto group = normalize_group(input);
    if (group.deleted)
        throw StoreError(StoreErrorCode::InvalidArgument, "Use remove_group for group deletion");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    const auto original = impl_->require_group(group.id);
    if (original.deleted || original.revision != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "Group was deleted or changed; reload before editing");
    auto history = original.history_members;
    merge_history(history, group.history_members); group.history_members = std::move(history);
    impl_->require_group_references(group);
    if (same_group(original, group)) { transaction.commit(); return original; }
    if (expected_revision == std::numeric_limits<std::int64_t>::max())
        throw StoreError(StoreErrorCode::Conflict, "Group revision cannot be incremented");
    group.revision = expected_revision + 1;
    impl_->write_group(group, expected_revision);
    transaction.commit();
    return group;
}

Group Store::set_group_roster(std::string_view group_id, Mode mode, bool present) {
    validate_group_id(group_id); (void)mode_text(mode);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto group = impl_->require_group(group_id);
    if (group.deleted && present)
        throw StoreError(StoreErrorCode::Conflict, "Deleted group cannot rejoin a roster");
    auto& flag = mode == Mode::Chat ? group.in_chat : group.in_work;
    if (flag == present) { transaction.commit(); return group; }
    if (group.revision == std::numeric_limits<std::int64_t>::max())
        throw StoreError(StoreErrorCode::Conflict, "Group revision cannot be incremented");
    flag = present; const auto before = group.revision++;
    impl_->write_group(group, before);
    transaction.commit();
    return group;
}

void Store::remove_group(std::string_view group_id) {
    validate_group_id(group_id);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto group = impl_->require_group(group_id);
    if (!group.deleted) {
        if (group.revision == std::numeric_limits<std::int64_t>::max())
            throw StoreError(StoreErrorCode::Conflict, "Group revision cannot be incremented");
        const auto before = group.revision++;
        group.deleted = true; group.in_chat = group.in_work = false;
        impl_->write_group(group, before);
    }
    Statement clear(impl_->api, impl_->db, "DELETE FROM messages WHERE group_id=?");
    clear.bind(1, group_id); clear.finish();
    transaction.commit();
}

std::vector<Message> Store::group_messages(std::string_view group_id, Mode mode,
    std::size_t limit, std::optional<Id> before) const {
    validate_group_id(group_id); const auto selected_mode = mode_text(mode); validate_page(limit, before);
    std::string sql = "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE group_id=? AND mode=?";
    if (before) sql += " AND id<?";
    sql += " ORDER BY id DESC LIMIT ?";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_group(group_id);
    Statement select(impl_->api, impl_->db, sql);
    select.bind(1, group_id); select.bind(2, selected_mode);
    int index = 3;
    if (before) select.bind(index++, *before);
    select.bind(index, static_cast<std::int64_t>(limit));
    std::vector<Message> result;
    while (select.next()) result.push_back(impl_->read_message(select));
    return result;
}

std::vector<Message> Store::group_messages_after(std::string_view group_id, Mode mode,
    Id after, std::size_t limit) const {
    validate_group_id(group_id);
    validate_page(limit, std::nullopt);
    if (after != 0) validate_record_id(after);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_group(group_id);
    Statement select(impl_->api, impl_->db,
        "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages "
        "WHERE group_id=? AND mode=? AND id>? ORDER BY id ASC LIMIT ?");
    select.bind(1, group_id); select.bind(2, mode_text(mode));
    select.bind(3, after); select.bind(4, static_cast<std::int64_t>(limit));
    std::vector<Message> result;
    while (select.next()) result.push_back(impl_->read_message(select));
    return result;
}

std::vector<Message> Store::latest_group_bot_messages(std::string_view group_id, Mode mode) const {
    validate_group_id(group_id); const auto selected_mode = mode_text(mode);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_group(group_id);
    Statement select(impl_->api, impl_->db,
        "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE id IN ("
        "SELECT max(id) FROM messages WHERE group_id=? AND mode=? AND actor='bot' GROUP BY bot_id) ORDER BY bot_id");
    select.bind(1, group_id); select.bind(2, selected_mode);
    std::vector<Message> result;
    while (select.next()) result.push_back(impl_->read_message(select));
    return result;
}

bool Store::application_metadata_bootstrapped() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->metadata_bootstrapped();
}

void Store::bootstrap_application_metadata(const std::vector<Group>& source_groups,
    const std::vector<BotProfileOverride>& source_profiles) {
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    if (impl_->metadata_bootstrapped()) { transaction.commit(); return; }
    std::vector<Group> groups;
    std::vector<BotProfileOverride> profiles;
    std::set<std::string> group_ids, profile_ids;
    for (const auto& value : source_groups) {
        auto group = normalize_group(value);
        if (!group_ids.insert(group.id).second)
            throw StoreError(StoreErrorCode::InvalidArgument, "Duplicate bootstrap group identity");
        impl_->add_recorded_group_history(group);
        impl_->require_group_references(group);
        const auto existing = impl_->find_group_unlocked(group.id);
        if (existing) {
            if (!same_group(*existing, group))
                throw StoreError(StoreErrorCode::Conflict, "Bootstrap group conflicts with existing native metadata");
        } else groups.push_back(std::move(group));
    }
    for (const auto& value : source_profiles) {
        auto profile = normalize_profile(value);
        if (!profile_ids.insert(profile.id).second)
            throw StoreError(StoreErrorCode::InvalidArgument, "Duplicate bootstrap Bot profile");
        (void)impl_->require_bot(profile.id); // Orphans never synthesize an identity.
        profiles.push_back(std::move(profile));
    }
    for (const auto& profile : profiles) (void)impl_->update_profile(profile);
    for (const auto& group : groups) impl_->write_group(group);
    execute(impl_->api, impl_->db, "INSERT INTO application_metadata_bootstrap(singleton,completed) VALUES(1,1)");
    transaction.commit();
}

Message Store::append_message(std::string_view bot_id, Mode mode,
    std::string_view actor, std::string_view text, std::string_view group_id, std::optional<Id> quote_source) {
    validate_bot_id(bot_id);
    const auto selected_mode = mode_text(mode);
    validate_scope(group_id);
    validate_text(text, 1048576, false, "Message");
    if (actor != "user" && actor != "bot" && actor != "system") {
        throw StoreError(StoreErrorCode::InvalidArgument, "Message actor must be user, bot, or system");
    }
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    impl_->require_new_group_message(group_id, bot_id, mode);
    std::optional<MessageContext> context;
    if (quote_source) {
        if (actor != "user") throw StoreError(StoreErrorCode::InvalidArgument, "Only user input may attach a quote");
        context = impl_->quote_context(bot_id, mode, group_id, *quote_source);
    }
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,?,?,?,?,?)");
    insert.bind(1, bot_id);
    insert.bind(2, group_id);
    insert.bind(3, selected_mode);
    insert.bind(4, actor);
    insert.bind(5, text);
    insert.bind(6, timestamp);
    insert.finish();
    const Id id = impl_->api.last_insert_rowid(impl_->db);
    impl_->write_context(id, context);
    transaction.commit();
    return {id, std::string(bot_id), std::string(group_id), mode, std::string(actor), std::string(text), timestamp, std::move(context)};
}

Message Store::append_message_once(std::string_view bot_id, Mode mode,
    std::string_view actor, std::string_view text, std::string_view group_id,
    std::string_view request_key, std::optional<Id> quote_source) {
    validate_bot_id(bot_id);
    const auto selected_mode = mode_text(mode);
    validate_scope(group_id);
    validate_text(text, 1048576, false, "Message");
    validate_text(request_key, 1024, false, "Message request key");
    if (actor != "user" && actor != "bot" && actor != "system") {
        throw StoreError(StoreErrorCode::InvalidArgument, "Message actor must be user, bot, or system");
    }
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    {
        Statement receipt(impl_->api, impl_->db,
            "SELECT message_id FROM message_receipts WHERE bot_id=? AND mode=? AND group_id=? AND request_key=?");
        receipt.bind(1, bot_id); receipt.bind(2, selected_mode);
        receipt.bind(3, group_id); receipt.bind(4, request_key);
        if (receipt.next()) {
            const Id id = receipt.integer(0); // SQL NULL maps to zero, never a valid Message ID.
            if (id <= 0) throw StoreError(StoreErrorCode::Conflict, "This message request was consumed and its history was cleared");
            Statement original(impl_->api, impl_->db,
                "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages WHERE id=?");
            original.bind(1, id);
            if (!original.next()) throw StoreError(StoreErrorCode::Storage, "Message receipt references a missing row");
            Message result = impl_->read_message(original);
            const bool same_quote = quote_source
                ? result.context && result.context->kind == "quote" && result.context->sources.front().message_id == *quote_source &&
                    result.context->sources.front().source_namespace == "native-" + impl_->import_state().second
                : !result.context;
            if (result.bot_id != bot_id || result.group_id != group_id || result.mode != mode ||
                result.actor != actor || result.text != text || !same_quote) {
                throw StoreError(StoreErrorCode::Conflict, "Message request key already identifies different content");
            }
            transaction.commit();
            return result;
        }
    }
    impl_->require_new_group_message(group_id, bot_id, mode);
    std::optional<MessageContext> context;
    if (quote_source) {
        if (actor != "user") throw StoreError(StoreErrorCode::InvalidArgument, "Only user input may attach a quote");
        context = impl_->quote_context(bot_id, mode, group_id, *quote_source);
    }
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,?,?,?,?,?)");
    insert.bind(1, bot_id); insert.bind(2, group_id); insert.bind(3, selected_mode);
    insert.bind(4, actor); insert.bind(5, text); insert.bind(6, timestamp); insert.finish();
    const Id id = impl_->api.last_insert_rowid(impl_->db);
    impl_->write_context(id, context);
    Statement receipt(impl_->api, impl_->db,
        "INSERT INTO message_receipts(bot_id,mode,group_id,request_key,message_id) VALUES(?,?,?,?,?)");
    receipt.bind(1, bot_id); receipt.bind(2, selected_mode); receipt.bind(3, group_id);
    receipt.bind(4, request_key); receipt.bind(5, id); receipt.finish();
    transaction.commit();
    return {id, std::string(bot_id), std::string(group_id), mode, std::string(actor), std::string(text), timestamp, std::move(context)};
}

MessageContext Store::capture_quote(std::string_view bot_id, Mode mode,
    std::string_view group_id, Id source_id) const {
    validate_bot_id(bot_id); (void)mode_text(mode); validate_scope(group_id);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    (void)impl_->require_bot(bot_id);
    auto context = impl_->quote_context(bot_id, mode, group_id, source_id);
    transaction.commit();
    return context;
}

Message Store::forward_group_messages(std::string_view destination_bot, std::string_view destination_group,
    std::string_view source_group, const std::vector<Id>& source_ids, std::string_view request_key) {
    return forward_chat_messages(destination_bot, destination_group, "", source_group, source_ids, request_key);
}

Message Store::forward_chat_messages(std::string_view destination_bot, std::string_view destination_group,
    std::string_view source_bot, std::string_view source_group, const std::vector<Id>& source_ids,
    std::string_view request_key) {
    validate_bot_id(destination_bot); validate_scope(destination_group);
    if (source_bot.empty() == source_group.empty())
        throw StoreError(StoreErrorCode::InvalidArgument, "Select one source Chat conversation");
    if (source_group.empty()) validate_bot_id(source_bot);
    else validate_group_id(source_group);
    validate_text(request_key, 1024, false, "Forward request key");
    if (source_ids.empty() || source_ids.size() > 16)
        throw StoreError(StoreErrorCode::InvalidArgument, "Select 1 to 16 source messages");
    std::set<Id> unique;
    for (const auto id : source_ids) if (id <= 0 || !unique.insert(id).second)
        throw StoreError(StoreErrorCode::InvalidArgument, "Invalid or duplicate forwarded source ID");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    const auto target_bot = impl_->require_bot(destination_bot);
    if (destination_group.empty()) {
        if (!target_bot.in_chat) throw StoreError(StoreErrorCode::Conflict, "Destination Bot is outside Chat roster");
    } else {
        (void)impl_->require_group(destination_group);
        impl_->require_new_group_message(destination_group, destination_bot, Mode::Chat);
    }
    const auto source_namespace = "native-" + impl_->import_state().second;
    {
        std::string receipt_sql = "SELECT message_id FROM message_receipts WHERE mode='chat' AND group_id=? AND request_key=?";
        if (destination_group.empty()) receipt_sql += " AND bot_id=?";
        Statement receipt(impl_->api, impl_->db, receipt_sql);
        receipt.bind(1, destination_group); receipt.bind(2, request_key);
        if (destination_group.empty()) receipt.bind(3, destination_bot);
        if (receipt.next()) {
            const auto id = receipt.integer(0);
            if (id <= 0) throw StoreError(StoreErrorCode::Conflict, "Forward request was consumed and its history cleared");
            auto result = impl_->require_message(id);
            bool same = result.actor == "system" && result.mode == Mode::Chat &&
                result.group_id == destination_group && (destination_group.empty() ? result.bot_id == destination_bot : true) &&
                result.context && result.context->kind == "forward" &&
                result.context->sources.size() == source_ids.size();
            for (std::size_t i = 0; same && i < source_ids.size(); ++i) {
                const auto& s = result.context->sources[i];
                same = s.source_namespace == source_namespace && s.message_id == source_ids[i] &&
                    s.group_id == source_group && s.mode == Mode::Chat && (source_group.empty() ? s.bot_id == source_bot : true);
            }
            if (!same) throw StoreError(StoreErrorCode::Conflict, "Forward request key identifies different sources");
            transaction.commit();
            return result;
        }
    }
    std::optional<Group> group;
    if (source_group.empty()) (void)impl_->require_bot(source_bot);
    else {
        group = impl_->require_group(source_group);
        if (group->deleted) throw StoreError(StoreErrorCode::Conflict, "Source group has been deleted");
    }
    MessageContext context{"forward", {}};
    const auto maximum = std::min(std::size_t{4096}, std::size_t{16000} / source_ids.size());
    std::string body = source_group.empty() ? "私聊转发 · 参考资料（不代表当前指令）\n" : "群聊转发 · 参考资料（不代表当前指令）\n";
    for (const auto id : source_ids) {
        const auto message = impl_->require_message(id);
        if (message.group_id != source_group || message.mode != Mode::Chat ||
            (group ? !contains(group->history_members, message.bot_id) : message.bot_id != source_bot))
            throw StoreError(StoreErrorCode::InvalidArgument, "Forward source is outside the selected Chat conversation");
        auto source = impl_->source_snapshot(message, maximum);
        body += "\n[" + (source.group_id.empty() ? "私聊 " + source.bot_id : "群 " + source.group_id) +
            " · " + source.actor + ":" + source.bot_id + " · 消息 " +
            std::to_string(id) + " · 时间 " + std::to_string(source.created_at_ms) + "]\n" + source.text;
        if (source.truncated) body += "\n[原文较长，此处为来源快照的开头部分]";
        body += '\n';
        context.sources.push_back(std::move(source));
    }
    validate_message_context_scope(context, destination_bot, destination_group, Mode::Chat, "system");
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) VALUES(?,?,'chat','system',?,?)");
    insert.bind(1, destination_bot); insert.bind(2, destination_group); insert.bind(3, body); insert.bind(4, timestamp); insert.finish();
    const auto id = impl_->api.last_insert_rowid(impl_->db);
    impl_->write_context(id, context);
    Statement receipt(impl_->api, impl_->db,
        "INSERT INTO message_receipts(bot_id,mode,group_id,request_key,message_id) VALUES(?,'chat',?,?,?)");
    receipt.bind(1, destination_bot); receipt.bind(2, destination_group); receipt.bind(3, request_key); receipt.bind(4, id); receipt.finish();
    transaction.commit();
    return {id, std::string(destination_bot), std::string(destination_group), Mode::Chat, "system", body, timestamp, std::move(context)};
}

std::vector<Message> Store::messages(std::string_view bot_id, Mode mode,
    std::string_view group_id, std::size_t limit, std::optional<Id> before) const {
    validate_bot_id(bot_id);
    const auto selected_mode = mode_text(mode);
    validate_scope(group_id);
    validate_page(limit, before);
    std::string sql = "SELECT id,bot_id,group_id,mode,actor,text,created_at_ms FROM messages"
        " WHERE bot_id=? AND mode=? AND group_id=?";
    if (before) sql += " AND id<?";
    sql += " ORDER BY id DESC LIMIT ?";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    Statement select(impl_->api, impl_->db, sql);
    select.bind(1, bot_id);
    select.bind(2, selected_mode);
    select.bind(3, group_id);
    int index = 4;
    if (before) select.bind(index++, *before);
    select.bind(index, static_cast<std::int64_t>(limit));
    std::vector<Message> result;
    while (select.next()) {
        result.push_back(impl_->read_message(select));
    }
    return result;
}

Memory Store::propose_memory(std::string_view bot_id, std::string_view group_id,
    std::string_view text, std::string_view source_actor) {
    validate_bot_id(bot_id);
    validate_scope(group_id);
    text = trim(text);
    validate_text(text, 262144, false, "Memory");
    if (is_relation_note_text(text))
        throw StoreError(StoreErrorCode::InvalidArgument, "Use the relation note form for reserved memory fields");
    if (source_actor != "user") {
        throw StoreError(StoreErrorCode::InvalidArgument, "Only explicit user input may propose a memory");
    }
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    {
        Statement existing(impl_->api, impl_->db, std::string("SELECT ") + memory_columns +
            " FROM memories WHERE bot_id=? AND group_id=? AND text=?");
        existing.bind(1, bot_id);
        existing.bind(2, group_id);
        existing.bind(3, text);
        if (existing.next()) {
            auto memory = read_memory(existing);
            // Finish the reader before committing on every supported SQLite.
            if (existing.next()) throw StoreError(StoreErrorCode::Storage, "Memory uniqueness constraint failed");
            transaction.commit();
            return memory;
        }
    }
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor) VALUES(?,?,?,'candidate',1,'user')");
    insert.bind(1, bot_id);
    insert.bind(2, group_id);
    insert.bind(3, text);
    insert.finish();
    const Id id = impl_->api.last_insert_rowid(impl_->db);
    transaction.commit();
    return {id, std::string(bot_id), std::string(group_id), std::string(text), MemoryState::Candidate, 1, "user"};
}

Memory Store::propose_episode(std::string_view bot_id, std::string_view group_id,
    std::string_view text, std::int64_t event_time_ms, std::string_view source_ref,
    std::string_view participants, std::string_view user_choice, std::string_view outcome) {
    validate_bot_id(bot_id); validate_scope(group_id);
    text = trim(text); validate_text(text, 262144, false, "Episode");
    if (is_relation_note_text(text)) throw StoreError(StoreErrorCode::InvalidArgument, "Use the relation note form for reserved memory fields");
    if (event_time_ms <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Episode time is required");
    if (source_ref.empty() || source_ref.size() > 256) throw StoreError(StoreErrorCode::InvalidArgument, "Episode source reference is required");
    if (participants.empty() || participants.size() > 4000 || user_choice.empty() || user_choice.size() > 4000 ||
        outcome.empty() || outcome.size() > 4000) throw StoreError(StoreErrorCode::InvalidArgument, "Episode participants, choice and outcome are required and bounded");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    {
        Statement existing(impl_->api, impl_->db, std::string("SELECT ") + memory_columns +
            " FROM memories WHERE bot_id=? AND group_id=? AND text=?");
        existing.bind(1, bot_id); existing.bind(2, group_id); existing.bind(3, text);
        if (existing.next()) {
            auto memory = read_memory(existing);
            if (memory.kind != "episode" || memory.source_ref != source_ref)
                throw StoreError(StoreErrorCode::Conflict, "Episode text already identifies a different source or memory kind");
            transaction.commit(); return memory;
        }
    }
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,source_ref,participants,user_choice,outcome) "
        "VALUES(?,?,?,'candidate',1,'user','episode',?,?,?,?,?)");
    insert.bind(1, bot_id); insert.bind(2, group_id); insert.bind(3, text); insert.bind(4, event_time_ms);
    insert.bind(5, source_ref); insert.bind(6, participants); insert.bind(7, user_choice); insert.bind(8, outcome);
    insert.finish();
    const Id id = impl_->api.last_insert_rowid(impl_->db);
    transaction.commit();
    return {id, std::string(bot_id), std::string(group_id), std::string(text), MemoryState::Candidate, 1, "user",
        "episode", event_time_ms, std::string(source_ref), std::string(participants), std::string(user_choice), std::string(outcome)};
}

std::vector<Memory> Store::recall_episodes(std::string_view bot_id, std::string_view group_id,
    std::string_view query, std::size_t limit) const {
    validate_bot_id(bot_id); validate_scope(group_id);
    validate_text(query, 16384, true, "Retrieval query");
    if (!limit || limit > 10) throw StoreError(StoreErrorCode::InvalidArgument, "Episode recall limit must be 1..10");
    const auto terms = effective_recall_terms(query);
    const bool time_cue = query_has_time_cue(query);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    const auto run = [&](const std::string& sql, const std::vector<std::string>& bound, bool earliest) {
        Statement select(impl_->api, impl_->db, sql);
        int index = 1;
        for (const auto& term : bound) select.bind(index++, term);
        select.bind(index++, bot_id); select.bind(index, group_id);
        std::vector<Memory> result;
        const auto maximum = earliest ? std::min(limit, recall_time_fallback_items) : limit;
        while (result.size() < maximum && select.next()) result.push_back(read_memory(select));
        return result;
    };
    if (!terms.empty()) {
        const auto expression = "text || char(10) || participants || char(10) || user_choice || char(10) || outcome";
        const auto sql = std::string("SELECT ") + memory_columns + " FROM (SELECT " + std::string(memory_columns) + ",(" +
            relevance_score_sql(terms, expression) + ") AS relevance FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='episode')"
            " WHERE relevance>0 ORDER BY relevance DESC,id DESC";
        auto result = run(sql, terms, false);
        if (!result.empty() || !time_cue) return result;
    } else if (!time_cue) return {};
    const auto sql = std::string("SELECT ") + memory_columns +
        " FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='episode' ORDER BY id ASC";
    return run(sql, {}, true);
}

Memory Store::propose_impression(std::string_view observer_bot_id, std::string_view target_bot_id,
    std::string_view group_id, std::string_view text, std::int64_t event_time_ms,
    std::string_view source_ref, std::string_view evidence, std::string_view applicable_scenarios,
    Id supersedes_id) {
    validate_bot_id(observer_bot_id); validate_bot_id(target_bot_id); validate_scope(group_id);
    if (observer_bot_id == target_bot_id)
        throw StoreError(StoreErrorCode::InvalidArgument, "An impression requires distinct observer and target Bots");
    if (group_id.empty())
        throw StoreError(StoreErrorCode::InvalidArgument, "Private conversations cannot ground a Bot-to-Bot impression");
    text = trim(text); evidence = trim(evidence); applicable_scenarios = trim(applicable_scenarios);
    validate_text(text, 262144, false, "Subjective impression");
    validate_text(evidence, 16384, false, "Impression evidence");
    validate_text(applicable_scenarios, 8192, false, "Impression scenarios");
    if (is_relation_note_text(text))
        throw StoreError(StoreErrorCode::InvalidArgument, "Use the relation note form for reserved memory fields");
    if (event_time_ms <= 0) throw StoreError(StoreErrorCode::InvalidArgument, "Impression source time is required");
    if (source_ref.size() > 256 || (source_ref.starts_with("message:") && source_ref.size() == 8) ||
        (source_ref.starts_with("run:") && source_ref.size() == 4) ||
        (!source_ref.starts_with("message:") && !source_ref.starts_with("run:")))
        throw StoreError(StoreErrorCode::InvalidArgument, "Impression source must be a direct shared message or run");
    if (supersedes_id < 0) throw StoreError(StoreErrorCode::InvalidArgument, "Invalid corrected impression ID");

    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(observer_bot_id); (void)impl_->require_bot(target_bot_id);
    const auto group = impl_->require_group(group_id);
    if (group.deleted || !contains(group.history_members, std::string(observer_bot_id)) ||
        !contains(group.history_members, std::string(target_bot_id)))
        throw StoreError(StoreErrorCode::InvalidArgument, "Both Bots must share visibility of the source group");
    if (source_ref.starts_with("message:")) {
        const auto encoded = source_ref.substr(8);
        Id source_id{};
        const auto parsed = std::from_chars(encoded.data(), encoded.data() + encoded.size(), source_id);
        if (parsed.ec != std::errc{} || parsed.ptr != encoded.data() + encoded.size()) validate_record_id(source_id);
        const auto source = impl_->require_message(source_id);
        if (source.group_id != group_id || source.context)
            throw StoreError(StoreErrorCode::InvalidArgument, "Only an original message visible in this shared group is direct evidence");
        if (source.created_at_ms != event_time_ms)
            throw StoreError(StoreErrorCode::InvalidArgument, "Impression time must match its source message");
    }
    Memory corrected;
    if (supersedes_id) {
        validate_record_id(supersedes_id);
        const auto previous = impl_->find_memory_unlocked(supersedes_id);
        if (!previous) throw StoreError(StoreErrorCode::NotFound, "Corrected impression does not exist");
        corrected = *previous;
        if (corrected.kind != "impression" || corrected.bot_id != observer_bot_id ||
            corrected.target_bot_id != target_bot_id || corrected.group_id != group_id)
            throw StoreError(StoreErrorCode::InvalidArgument, "A correction must keep the same observer, target and group");
        if (corrected.source_ref == source_ref)
            throw StoreError(StoreErrorCode::Conflict, "A correction requires a new independent direct source");
    }
    {
        Statement existing(impl_->api, impl_->db, std::string("SELECT ") + memory_columns +
            " FROM memories WHERE bot_id=? AND target_bot_id=? AND group_id=? AND source_ref=? AND kind='impression'");
        existing.bind(1, observer_bot_id); existing.bind(2, target_bot_id);
        existing.bind(3, group_id); existing.bind(4, source_ref);
        if (existing.next()) {
            const auto memory = read_memory(existing);
            if (memory.text != text || memory.event_time_ms != event_time_ms || memory.evidence != evidence ||
                memory.applicable_scenarios != applicable_scenarios || memory.supersedes_id != supersedes_id)
                throw StoreError(StoreErrorCode::Conflict, "This source already grounds a different impression");
            transaction.commit(); return memory;
        }
    }
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor,kind,event_time_ms,source_ref,participants,user_choice,outcome,target_bot_id,evidence,applicable_scenarios,supersedes_id) "
        "VALUES(?,?,?,'candidate',1,'user','impression',?,?,'','','',?,?,?,?)");
    insert.bind(1, observer_bot_id); insert.bind(2, group_id); insert.bind(3, text);
    insert.bind(4, event_time_ms); insert.bind(5, source_ref); insert.bind(6, target_bot_id);
    insert.bind(7, evidence); insert.bind(8, applicable_scenarios); insert.bind(9, supersedes_id); insert.finish();
    const Id id = impl_->api.last_insert_rowid(impl_->db);
    transaction.commit();
    return {id, std::string(observer_bot_id), std::string(group_id), std::string(text), MemoryState::Candidate, 1, "user",
        "impression", event_time_ms, std::string(source_ref), "", "", "", std::string(target_bot_id),
        std::string(evidence), std::string(applicable_scenarios), supersedes_id};
}

std::vector<Memory> Store::recall_impressions(std::string_view observer_bot_id,
    std::string_view target_bot_id, std::string_view group_id, std::string_view query, std::size_t limit) const {
    validate_bot_id(observer_bot_id); validate_bot_id(target_bot_id); validate_scope(group_id);
    validate_text(query, 16384, true, "Retrieval query");
    if (!limit || limit > 10) throw StoreError(StoreErrorCode::InvalidArgument, "Impression recall limit must be 1..10");
    const auto terms = effective_recall_terms(query);
    if (terms.empty()) return {};
    const auto expression = "text || char(10) || evidence || char(10) || applicable_scenarios";
    const auto sql = std::string("SELECT ") + memory_columns + " FROM (SELECT " + std::string(memory_columns) + ",(" +
        relevance_score_sql(terms, expression) + ") AS relevance FROM memories WHERE bot_id=? AND target_bot_id=? AND group_id=? "
        "AND state='confirmed' AND kind='impression') WHERE relevance>0 ORDER BY relevance DESC,id DESC";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(observer_bot_id); (void)impl_->require_bot(target_bot_id);
    Statement select(impl_->api, impl_->db, sql);
    int index = 1; for (const auto& term : terms) select.bind(index++, term);
    select.bind(index++, observer_bot_id); select.bind(index++, target_bot_id); select.bind(index, group_id);
    std::vector<Memory> result;
    while (result.size() < limit && select.next()) result.push_back(read_memory(select));
    return result;
}

std::vector<Memory> Store::list_impressions(std::string_view observer_bot_id,
    std::string_view group_id, std::string_view target_bot_id) const {
    validate_bot_id(observer_bot_id); validate_scope(group_id);
    if (!target_bot_id.empty()) validate_bot_id(target_bot_id);
    std::string sql = std::string("SELECT ") + memory_columns + " FROM memories WHERE bot_id=? AND kind='impression'";
    if (!group_id.empty()) sql += " AND group_id=?";
    if (!target_bot_id.empty()) sql += " AND target_bot_id=?";
    sql += " ORDER BY id DESC LIMIT 500";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(observer_bot_id);
    Statement select(impl_->api, impl_->db, sql);
    int index = 1; select.bind(index++, observer_bot_id);
    if (!group_id.empty()) select.bind(index++, group_id);
    if (!target_bot_id.empty()) select.bind(index, target_bot_id);
    std::vector<Memory> result;
    while (select.next()) result.push_back(read_memory(select));
    return result;
}

std::optional<Memory> Store::find_memory(Id memory_id) const {
    validate_record_id(memory_id);
    std::lock_guard lock(impl_->mutex);
    return impl_->find_memory_unlocked(memory_id);
}

std::vector<Memory> Store::list_memories(std::string_view bot_id,
    std::optional<std::string_view> group_id, bool include_candidates,
    std::size_t limit, std::optional<Id> before) const {
    validate_bot_id(bot_id);
    if (group_id) validate_scope(*group_id);
    validate_page(limit, before);
    std::string sql = std::string("SELECT ") + memory_columns + " FROM memories WHERE bot_id=?";
    if (group_id) sql += " AND group_id=?";
    if (!include_candidates) sql += " AND state='confirmed'";
    if (before) sql += " AND id<?";
    sql += " ORDER BY id DESC LIMIT ?";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    Statement select(impl_->api, impl_->db, sql);
    int index = 1;
    select.bind(index++, bot_id);
    if (group_id) select.bind(index++, *group_id);
    if (before) select.bind(index++, *before);
    select.bind(index, static_cast<std::int64_t>(limit));
    std::vector<Memory> result;
    while (select.next()) result.push_back(read_memory(select));
    return result;
}

std::vector<Memory> Store::visible_memories(std::string_view bot_id,
    std::string_view group_id, std::size_t limit, std::optional<Id> before) const {
    validate_bot_id(bot_id); validate_scope(group_id); validate_page(limit, before);
    std::string sql = std::string("SELECT ") + memory_columns +
        " FROM memories WHERE bot_id=? AND group_id=? AND state IN ('confirmed','candidate') AND kind<>'impression'"
        " AND substr(text,1,?)<>? COLLATE BINARY";
    if (before) sql += " AND id<?";
    sql += " ORDER BY id DESC LIMIT ?";
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    Statement select(impl_->api, impl_->db, sql);
    select.bind(1, bot_id); select.bind(2, group_id);
    select.bind(3, static_cast<std::int64_t>(relation_note_reserved_prefix.size()));
    select.bind(4, relation_note_reserved_prefix);
    int index = 5;
    if (before) select.bind(index++, *before);
    select.bind(index, static_cast<std::int64_t>(limit));
    std::vector<Memory> result;
    while (select.next()) result.push_back(read_memory(select));
    return result;
}

Memory Store::review_memory(Id memory_id, std::int64_t expected_revision, MemoryState state) {
    validate_record_id(memory_id);
    validate_revision(expected_revision);
    const auto selected_state = state_text(state);
    if (state == MemoryState::Candidate) {
        throw StoreError(StoreErrorCode::InvalidArgument, "Review must confirm or reject a memory");
    }
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto memory = impl_->require_revision(memory_id, expected_revision);
    if (is_relation_note_text(memory.text))
        throw StoreError(StoreErrorCode::Conflict, "Use the relation note form to change this field");
    if (memory.revision == std::numeric_limits<std::int64_t>::max()) {
        throw StoreError(StoreErrorCode::Conflict, "Memory revision cannot be incremented");
    }
    if (memory.kind == "impression" && memory.supersedes_id && state == MemoryState::Confirmed) {
        const auto previous = impl_->find_memory_unlocked(memory.supersedes_id);
        if (!previous || previous->kind != "impression" || previous->state != MemoryState::Confirmed ||
            previous->revision == std::numeric_limits<std::int64_t>::max())
            throw StoreError(StoreErrorCode::Conflict, "Only the current confirmed impression can be corrected");
        Statement supersede(impl_->api, impl_->db,
            "UPDATE memories SET state='rejected',revision=revision+1 WHERE id=? AND revision=? AND state='confirmed'");
        supersede.bind(1, previous->id); supersede.bind(2, previous->revision); supersede.finish();
        impl_->require_one_change();
    }
    Statement update(impl_->api, impl_->db,
        "UPDATE memories SET state=?,revision=revision+1 WHERE id=? AND revision=?");
    update.bind(1, selected_state);
    update.bind(2, memory_id);
    update.bind(3, expected_revision);
    update.finish();
    impl_->require_one_change();
    transaction.commit();
    memory.state = state;
    ++memory.revision;
    return memory;
}

Memory Store::edit_memory(Id memory_id, std::int64_t expected_revision, std::string_view text) {
    validate_record_id(memory_id);
    validate_revision(expected_revision);
    text = trim(text);
    validate_text(text, 262144, false, "Memory");
    if (is_relation_note_text(text))
        throw StoreError(StoreErrorCode::InvalidArgument, "Use the relation note form for reserved memory fields");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    auto memory = impl_->require_revision(memory_id, expected_revision);
    if (is_relation_note_text(memory.text))
        throw StoreError(StoreErrorCode::Conflict, "Use the relation note form to change this field");
    if (memory.kind == "impression")
        throw StoreError(StoreErrorCode::Conflict, "Correct an impression with a new direct source instead of editing its evidence");
    if (memory.text == text) {
        transaction.commit();
        return memory;
    }
    if (memory.revision == std::numeric_limits<std::int64_t>::max()) {
        throw StoreError(StoreErrorCode::Conflict, "Memory revision cannot be incremented");
    }
    Statement update(impl_->api, impl_->db,
        "UPDATE memories SET text=?,state='candidate',revision=revision+1 WHERE id=? AND revision=?");
    update.bind(1, text);
    update.bind(2, memory_id);
    update.bind(3, expected_revision);
    update.finish();
    impl_->require_one_change();
    transaction.commit();
    memory.text = std::string(text);
    memory.state = MemoryState::Candidate;
    ++memory.revision;
    return memory;
}

void Store::delete_memory(Id memory_id, std::int64_t expected_revision) {
    validate_record_id(memory_id);
    validate_revision(expected_revision);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    const auto memory = impl_->require_revision(memory_id, expected_revision);
    if (is_relation_note_text(memory.text))
        throw StoreError(StoreErrorCode::Conflict, "Clear the explicit relation field to delete this note");
    if (memory.kind == "impression")
        throw StoreError(StoreErrorCode::Conflict, "Impression audit records cannot be deleted; reject a candidate or confirm a sourced correction");
    Statement remove(impl_->api, impl_->db, "DELETE FROM memories WHERE id=? AND revision=?");
    remove.bind(1, memory_id);
    remove.bind(2, expected_revision);
    remove.finish();
    impl_->require_one_change();
    transaction.commit();
}


void Store::apply_memory_changes(std::string_view bot_id, std::string_view group_id,
                                  const std::vector<MemoryChange>& changes) {
    validate_bot_id(bot_id); validate_scope(group_id);
    if (changes.size() > 100)
        throw StoreError(StoreErrorCode::InvalidArgument, "Memory batch exceeds 100 changes");
    std::set<Id> ids;
    std::vector<std::optional<std::string>> normalized;
    normalized.reserve(changes.size());
    for (const auto& change : changes) {
        validate_record_id(change.id); validate_revision(change.expected_revision);
        if (!ids.insert(change.id).second)
            throw StoreError(StoreErrorCode::InvalidArgument, "Memory batch contains duplicate IDs");
        if (change.text) {
            const auto value = trim(*change.text);
            validate_text(value, 262144, false, "Memory");
            if (is_relation_note_text(value))
                throw StoreError(StoreErrorCode::InvalidArgument, "Use the relation note form for reserved memory fields");
            normalized.emplace_back(std::string(value));
        } else normalized.emplace_back(std::nullopt);
    }
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    std::vector<Memory> current;
    current.reserve(changes.size());
    for (std::size_t i = 0; i < changes.size(); ++i) {
        auto memory = impl_->require_revision(changes[i].id, changes[i].expected_revision);
        if (memory.bot_id != bot_id || memory.group_id != group_id)
            throw StoreError(StoreErrorCode::NotFound, "Memory does not belong to the selected scope");
        if (is_relation_note_text(memory.text))
            throw StoreError(StoreErrorCode::Conflict, "Use the relation note form to change this field");
        if (memory.kind == "impression")
            throw StoreError(StoreErrorCode::Conflict, "Use a new sourced correction; impression audit rows are not editable");
        if (memory.state != MemoryState::Confirmed)
            throw StoreError(StoreErrorCode::Conflict, "Memory batch requires confirmed records");
        if (normalized[i] && *normalized[i] != memory.text &&
            memory.revision == std::numeric_limits<std::int64_t>::max())
            throw StoreError(StoreErrorCode::Conflict, "Memory revision cannot be incremented");
        current.push_back(std::move(memory));
    }
    for (std::size_t i = 0; i < changes.size(); ++i) {
        if (!normalized[i]) {
            Statement remove(impl_->api, impl_->db, "DELETE FROM memories WHERE id=? AND revision=?");
            remove.bind(1, changes[i].id); remove.bind(2, changes[i].expected_revision); remove.finish();
            impl_->require_one_change();
        } else if (*normalized[i] != current[i].text) {
            Statement update(impl_->api, impl_->db,
                "UPDATE memories SET text=?,state='candidate',revision=revision+1 WHERE id=? AND revision=?");
            update.bind(1, *normalized[i]); update.bind(2, changes[i].id);
            update.bind(3, changes[i].expected_revision); update.finish();
            impl_->require_one_change();
        }
    }
    transaction.commit();
}

MidMemory Store::add_mid_memory(std::string_view bot_id, std::string_view group_id,
    std::string_view text, int days, std::optional<std::int64_t> now_ms) {
    validate_bot_id(bot_id); validate_scope(group_id); validate_mid_text(text);
    const auto now = mid_now(now_ms), duration = mid_duration(days);
    if (now > std::numeric_limits<std::int64_t>::max() - duration)
        throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term expiry would overflow");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    {
        Statement count(impl_->api, impl_->db,
            "SELECT count(*),sum(CASE WHEN bot_id=? AND group_id=? THEN 1 ELSE 0 END) FROM mid_memories");
        count.bind(1, bot_id); count.bind(2, group_id);
        if (!count.next()) throw StoreError(StoreErrorCode::Storage, "Cannot count mid-term notes");
        if (count.integer(0) >= static_cast<std::int64_t>(mid_memory_total_limit) ||
            count.integer(1) >= static_cast<std::int64_t>(mid_memory_scope_limit))
            throw StoreError(StoreErrorCode::LimitExceeded, "中期记忆数量已达上限，请先删除不需要的条目（过期原文仍计入数量）");
    }
    Statement insert(impl_->api, impl_->db,
        "INSERT INTO mid_memories(bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength) "
        "VALUES(?,?,?,'user',1,?,?,?,1)");
    insert.bind(1, bot_id); insert.bind(2, group_id); insert.bind(3, text);
    insert.bind(4, now); insert.bind(5, now); insert.bind(6, now + duration); insert.finish();
    const auto id = impl_->api.last_insert_rowid(impl_->db);
    transaction.commit();
    return {id, std::string(bot_id), std::string(group_id), std::string(text), "user", 1, now, now, now + duration, 1};
}

std::vector<MidMemory> Store::list_mid_memories(std::string_view bot_id, std::string_view group_id) const {
    validate_bot_id(bot_id); validate_scope(group_id);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    Statement select(impl_->api, impl_->db, std::string("SELECT ") + mid_memory_columns +
        " FROM mid_memories WHERE bot_id=? AND group_id=? ORDER BY id DESC LIMIT ?");
    select.bind(1, bot_id); select.bind(2, group_id);
    select.bind(3, static_cast<std::int64_t>(mid_memory_scope_limit + 1));
    std::vector<MidMemory> result;
    while (select.next()) result.push_back(read_mid_memory(select));
    if (result.size() > mid_memory_scope_limit)
        throw StoreError(StoreErrorCode::Storage, "Stored mid-term scope exceeds its management limit");
    return result;
}

void Store::apply_mid_memory_changes(std::string_view bot_id, std::string_view group_id,
    const std::vector<MemoryChange>& changes, std::optional<std::int64_t> now_ms) {
    validate_bot_id(bot_id); validate_scope(group_id);
    if (changes.size() > 100) throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term batch exceeds 100 changes");
    std::set<Id> ids;
    for (const auto& change : changes) {
        validate_record_id(change.id); validate_revision(change.expected_revision);
        if (!ids.insert(change.id).second) throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term batch contains duplicate IDs");
        if (change.text) validate_mid_text(*change.text);
    }
    const auto now = mid_now(now_ms);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    std::vector<MidMemory> current;
    for (const auto& change : changes) {
        Statement select(impl_->api, impl_->db, std::string("SELECT ") + mid_memory_columns + " FROM mid_memories WHERE id=?");
        select.bind(1, change.id);
        if (!select.next()) throw StoreError(StoreErrorCode::Conflict, "中期记忆已被移除，请重新打开面板");
        auto item = read_mid_memory(select);
        if (item.bot_id != bot_id || item.group_id != group_id)
            throw StoreError(StoreErrorCode::NotFound, "Mid-term note does not belong to this scope");
        if (item.revision != change.expected_revision)
            throw StoreError(StoreErrorCode::Conflict, "中期记忆已被修改，请重新打开面板");
        if (change.text && *change.text != item.text && item.revision == std::numeric_limits<std::int64_t>::max())
            throw StoreError(StoreErrorCode::Conflict, "Mid-term revision cannot be incremented");
        current.push_back(std::move(item));
    }
    for (std::size_t i = 0; i < changes.size(); ++i) {
        const auto& change = changes[i];
        if (!change.text) {
            Statement remove(impl_->api, impl_->db, "DELETE FROM mid_memories WHERE id=? AND revision=?");
            remove.bind(1, change.id); remove.bind(2, change.expected_revision); remove.finish();
            impl_->require_one_change();
        } else if (*change.text != current[i].text) {
            Statement update(impl_->api, impl_->db,
                "UPDATE mid_memories SET text=?,revision=revision+1,updated_at_ms=? WHERE id=? AND revision=?");
            update.bind(1, *change.text); update.bind(2, std::max(now, current[i].updated_at_ms));
            update.bind(3, change.id); update.bind(4, change.expected_revision); update.finish();
            impl_->require_one_change();
        }
    }
    transaction.commit();
}

MidMemory Store::reinforce_mid_memory(std::string_view bot_id, std::string_view group_id,
    Id id, std::int64_t expected_revision, int days, std::optional<std::int64_t> now_ms) {
    validate_bot_id(bot_id); validate_scope(group_id); validate_record_id(id); validate_revision(expected_revision);
    const auto now = mid_now(now_ms), duration = mid_duration(days), horizon = 90 * mid_day_ms;
    if (now > std::numeric_limits<std::int64_t>::max() - horizon)
        throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term expiry would overflow");
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    MidMemory memory;
    {
        Statement select(impl_->api, impl_->db, std::string("SELECT ") + mid_memory_columns + " FROM mid_memories WHERE id=?");
        select.bind(1, id);
        if (!select.next()) throw StoreError(StoreErrorCode::Conflict, "中期记忆已被移除，请重新打开面板");
        memory = read_mid_memory(select);
    }
    if (memory.bot_id != bot_id || memory.group_id != group_id)
        throw StoreError(StoreErrorCode::NotFound, "Mid-term note does not belong to this scope");
    if (memory.revision != expected_revision || memory.revision == std::numeric_limits<std::int64_t>::max())
        throw StoreError(StoreErrorCode::Conflict, "中期记忆版本已变化，请重新打开面板");
    if (memory.strength == mid_memory_strength_limit || memory.expires_at_ms >= now + horizon)
        throw StoreError(StoreErrorCode::LimitExceeded, "中期记忆最多延长至未来90天，强化次数也有上限");
    const auto start = std::max(now, memory.expires_at_ms);
    const auto expires = start > now + horizon - duration ? now + horizon : start + duration;
    Statement update(impl_->api, impl_->db,
        "UPDATE mid_memories SET revision=revision+1,updated_at_ms=?,expires_at_ms=?,strength=strength+1 WHERE id=? AND revision=?");
    update.bind(1, std::max(now, memory.updated_at_ms)); update.bind(2, expires);
    update.bind(3, id); update.bind(4, expected_revision); update.finish(); impl_->require_one_change();
    ++memory.revision; ++memory.strength; memory.updated_at_ms = std::max(now, memory.updated_at_ms); memory.expires_at_ms = expires;
    transaction.commit(); return memory;
}

std::vector<MidMemoryExcerpt> Store::recall_mid_memory_excerpts(std::string_view bot_id,
    std::string_view group_id, std::string_view query, std::size_t max_items, std::size_t max_codepoints,
    std::optional<std::int64_t> now_ms) const {
    validate_bot_id(bot_id); validate_scope(group_id); validate_text(query, 4096, true, "Mid-term recall query");
    if (!max_items || max_items > 5 || !max_codepoints || max_codepoints > 1600)
        throw StoreError(StoreErrorCode::InvalidArgument, "Mid-term recall exceeds its shared item/text budget");
    const auto now = mid_now(now_ms); const auto terms = effective_recall_terms(query);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    std::vector<MidMemoryExcerpt> result;
    std::set<Id> seen;
    const auto push = [&](const MidMemory& memory) {
        if (!max_codepoints || result.size() >= max_items || seen.contains(memory.id)) return;
        const Memory source{memory.id, memory.bot_id, memory.group_id, memory.text, MemoryState::Confirmed, memory.revision, memory.source_actor};
        auto excerpt = memory_excerpt(source, terms, max_codepoints, false);
        const auto count = unicode_scalar_count(excerpt.text);
        if (!count) return;
        max_codepoints -= count;
        seen.insert(memory.id);
        result.push_back({std::move(excerpt), memory.expires_at_ms, memory.strength});
    };
    if (!terms.empty()) {
        std::string sql = std::string("SELECT ") + mid_memory_columns + " FROM (SELECT " + mid_memory_columns + ",(" +
            relevance_score_sql(terms) + ") AS relevance FROM mid_memories WHERE bot_id=? AND group_id=? AND expires_at_ms>?)"
            " WHERE relevance>0 ORDER BY relevance DESC,strength DESC,updated_at_ms DESC,id DESC LIMIT ?";
        Statement select(impl_->api, impl_->db, sql);
        int parameter = 1;
        for (const auto& term : terms) select.bind(parameter++, term);
        select.bind(parameter++, bot_id); select.bind(parameter++, group_id);
        select.bind(parameter++, now); select.bind(parameter, static_cast<std::int64_t>(max_items));
        while (result.size() < max_items && max_codepoints && select.next()) push(read_mid_memory(select));
    }
    if (result.size() < max_items && max_codepoints) {
        std::string sql = std::string("SELECT ") + mid_memory_columns +
            " FROM mid_memories WHERE bot_id=? AND group_id=? AND expires_at_ms>?"
            " ORDER BY strength DESC,updated_at_ms DESC,id DESC LIMIT ?";
        Statement select(impl_->api, impl_->db, sql);
        select.bind(1, bot_id); select.bind(2, group_id); select.bind(3, now);
        select.bind(4, static_cast<std::int64_t>(max_items));
        while (result.size() < max_items && max_codepoints && select.next()) push(read_mid_memory(select));
    }
    return result;
}

RelationNotesSnapshot Store::read_relation_notes(std::string_view bot_id) const {
    validate_bot_id(bot_id);
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db, true);
    (void)impl_->require_bot(bot_id);
    auto notes = impl_->relation_notes_unlocked(bot_id);
    transaction.commit();
    return std::move(notes.view);
}

RelationNotesSnapshot Store::save_relation_notes(std::string_view bot_id,
    const std::map<std::string, std::string>& values, std::string_view expected_revision) {
    validate_bot_id(bot_id);
    if (!lower_hex(expected_revision, 64) || values.size() != relation_note_fields.size())
        throw StoreError(StoreErrorCode::InvalidArgument, "A complete relation form and valid revision are required");
    std::map<std::string, std::string> normalized;
    for (const auto& field : relation_note_fields) {
        const auto found = values.find(std::string(field.key));
        if (found == values.end())
            throw StoreError(StoreErrorCode::InvalidArgument, "Unknown or missing relation note key");
        validate_text(found->second, relation_note_max_content_bytes, true, "Relation note");
        normalized.emplace(field.key, trim(found->second));
    }
    std::lock_guard lock(impl_->mutex);
    Transaction transaction(impl_->api, impl_->db);
    (void)impl_->require_bot(bot_id);
    const auto original = impl_->relation_notes_unlocked(bot_id);
    if (original.view.revision != expected_revision)
        throw StoreError(StoreErrorCode::Conflict, "Relation notes changed; reopen before saving");
    for (const auto& field : relation_note_fields) {
        const auto key = std::string(field.key);
        const auto& value = normalized.at(key);
        const auto row = original.records.find(key);
        if (!value.empty() && row != original.records.end() && value != original.view.values.at(key) &&
            row->second.revision == std::numeric_limits<std::int64_t>::max())
            throw StoreError(StoreErrorCode::Conflict, "Relation note revision cannot be incremented");
    }
    for (const auto& field : relation_note_fields) {
        const auto key = std::string(field.key);
        const auto& value = normalized.at(key);
        const auto row = original.records.find(key);
        if (value == original.view.values.at(key)) continue;
        if (value.empty()) {
            Statement remove(impl_->api, impl_->db, "DELETE FROM memories WHERE id=? AND revision=?");
            remove.bind(1, row->second.id); remove.bind(2, row->second.revision); remove.finish();
        } else if (row == original.records.end()) {
            Statement insert(impl_->api, impl_->db,
                "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor) VALUES(?,'',?,'confirmed',1,'user')");
            insert.bind(1, bot_id); insert.bind(2, encode_relation_note(key, value)); insert.finish();
        } else {
            Statement update(impl_->api, impl_->db,
                "UPDATE memories SET text=?,state='confirmed',revision=revision+1 WHERE id=? AND revision=?");
            update.bind(1, encode_relation_note(key, value)); update.bind(2, row->second.id);
            update.bind(3, row->second.revision); update.finish();
        }
        impl_->require_one_change();
    }
    auto result = impl_->relation_notes_unlocked(bot_id);
    transaction.commit();
    return std::move(result.view);
}

std::vector<Memory> Store::retrieve_memories(std::string_view bot_id,
    std::string_view group_id, std::string_view query,
    std::size_t max_items, std::size_t max_codepoints) const {
    validate_bot_id(bot_id);
    validate_scope(group_id);
    validate_text(query, 16384, true, "Retrieval query");
    max_items = std::min(max_items, std::size_t{5});
    max_codepoints = std::min(max_codepoints, std::size_t{1600});
    const auto terms = effective_recall_terms(query);
    const bool time_cue = query_has_time_cue(query);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    if (max_items == 0 || max_codepoints == 0) return {};

    const auto collect = [&](Statement& select, bool earliest) {
        std::vector<Memory> result;
        const auto limit = earliest ? std::min(max_items, recall_time_fallback_items) : max_items;
        auto budget = max_codepoints;
        while (result.size() < limit && budget > 0 && select.next()) {
            auto memory = read_memory(select);
            const auto count = unicode_scalar_count(memory.text);
            if (count > budget) continue;
            budget -= count;
            result.push_back(std::move(memory));
        }
        return result;
    };

    auto bind_scored = [&](Statement& select, bool with_length) {
        int index = 1;
        for (const auto& term : terms) select.bind(index++, term);
        select.bind(index++, bot_id);
        select.bind(index++, group_id);
        if (with_length) select.bind(index, static_cast<std::int64_t>(max_codepoints));
    };

    if (query.empty()) {
        const auto sql = std::string("SELECT ") + memory_columns +
            " FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='fact'"
            " AND length(text)<=? ORDER BY id DESC";
        Statement select(impl_->api, impl_->db, sql);
        select.bind(1, bot_id);
        select.bind(2, group_id);
        select.bind(3, static_cast<std::int64_t>(max_codepoints));
        return collect(select, false);
    }
    if (terms.empty() && !time_cue) return {};

    if (!terms.empty()) {
        const auto sql = std::string("SELECT ") + memory_columns + " FROM (SELECT " + memory_columns + ",(" +
            relevance_score_sql(terms) + ") AS relevance FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='fact'"
            " AND length(text)<=?) WHERE relevance>0 ORDER BY relevance DESC,id DESC";
        Statement select(impl_->api, impl_->db, sql);
        bind_scored(select, true);
        auto result = collect(select, false);
        if (!result.empty() || !time_cue) return result;
    }

    const auto sql = std::string("SELECT ") + memory_columns +
        " FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='fact' ORDER BY id ASC";
    Statement fallback(impl_->api, impl_->db, sql);
    fallback.bind(1, bot_id); fallback.bind(2, group_id);
    return collect(fallback, true);
}

std::vector<MemoryExcerpt> Store::recall_memory_excerpts(std::string_view bot_id,
    std::string_view group_id, std::string_view query,
    std::size_t max_items, std::size_t max_codepoints) const {
    validate_bot_id(bot_id); validate_scope(group_id);
    validate_text(query, 16384, true, "Retrieval query");
    max_items = std::min(max_items, std::size_t{5});
    max_codepoints = std::min(max_codepoints, std::size_t{1600});
    const auto terms = effective_recall_terms(query);
    const bool time_cue = query_has_time_cue(query);
    std::lock_guard lock(impl_->mutex);
    (void)impl_->require_bot(bot_id);
    if (!max_items || !max_codepoints) return {};
    const auto run = [&](const std::string& sql, const std::vector<std::string>& bound, bool earliest) {
        Statement select(impl_->api, impl_->db, sql);
        int index = 1;
        for (const auto& term : bound) select.bind(index++, term);
        select.bind(index++, bot_id); select.bind(index, group_id);
        std::vector<MemoryExcerpt> rows;
        auto budget = max_codepoints;
        const auto limit = earliest ? std::min(max_items, recall_time_fallback_items) : max_items;
        while (rows.size() < limit && budget && select.next()) {
            auto excerpt = memory_excerpt(read_memory(select), terms, budget);
            const auto count = unicode_scalar_count(excerpt.text);
            if (!count) continue;
            budget -= count;
            rows.push_back(std::move(excerpt));
        }
        return rows;
    };
    if (!terms.empty()) {
        const auto sql = std::string("SELECT ") + memory_columns + " FROM (SELECT " + std::string(memory_columns) + ",(" +
            relevance_score_sql(terms) + ") AS relevance FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='fact')"
            " WHERE relevance>0 ORDER BY relevance DESC,id DESC";
        auto result = run(sql, terms, false);
        if (!result.empty() || !time_cue) return result;
    } else if (!time_cue) {
        return {};
    }
    const auto sql = std::string("SELECT ") + memory_columns +
        " FROM memories WHERE bot_id=? AND group_id=? AND state='confirmed' AND kind='fact' ORDER BY id ASC";
    return run(sql, {}, true);
}

} // namespace dimension
