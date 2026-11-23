#include "dimension/archive.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
using O = Json::Object;
constexpr std::uint64_t max_input_bytes = 4U * 1024U * 1024U;
constexpr std::uint64_t max_target_bytes = 64U * 1024U * 1024U;
constexpr std::int64_t max_target_records = 50000;

struct Failure {
    const char* code;
    const char* message;
    int exit_code{2};
};
[[noreturn]] void fail(const char* code, const char* message, int exit_code = 2) {
    throw Failure{code, message, exit_code};
}
class Handle {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) { reset(); value_ = std::exchange(other.value_, INVALID_HANDLE_VALUE); }
        return *this;
    }
    HANDLE get() const { return value_; }
    explicit operator bool() const { return value_ != INVALID_HANDLE_VALUE; }
    void reset() { if (*this) CloseHandle(value_); value_ = INVALID_HANDLE_VALUE; }
private:
    HANDLE value_{INVALID_HANDLE_VALUE};
};
BY_HANDLE_FILE_INFORMATION information(const Handle& handle) {
    BY_HANDLE_FILE_INFORMATION value{};
    if (!GetFileInformationByHandle(handle.get(), &value)) fail("io_error", "Cannot inspect a required file.", 4);
    return value;
}
bool same_file(const BY_HANDLE_FILE_INFORMATION& first, const BY_HANDLE_FILE_INFORMATION& second) {
    return first.dwVolumeSerialNumber == second.dwVolumeSerialNumber &&
           first.nFileIndexHigh == second.nFileIndexHigh && first.nFileIndexLow == second.nFileIndexLow;
}
std::uint64_t file_size(const BY_HANDLE_FILE_INFORMATION& value) {
    return (static_cast<std::uint64_t>(value.nFileSizeHigh) << 32U) | value.nFileSizeLow;
}
bool same_path(const fs::path& first, const fs::path& second) {
    return CompareStringOrdinal(first.c_str(), -1, second.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool device_name(std::wstring value) {
    value = value.substr(0, value.find(L'.'));
    for (auto& c : value) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
    return value == L"CON" || value == L"PRN" || value == L"AUX" || value == L"NUL" ||
        (value.size() == 4 && (value.starts_with(L"COM") || value.starts_with(L"LPT")) &&
         ((value.back() >= L'1' && value.back() <= L'9') || value.back() == L'\u00b9' ||
          value.back() == L'\u00b2' || value.back() == L'\u00b3'));
}
fs::path absolute_path(std::wstring_view value) {
    if (value.empty() || value.size() > 4096) fail("invalid_path", "An ordinary absolute drive path is required.");
    fs::path path(value); path.make_preferred();
    const auto root = path.root_name().native();
    if (!path.is_absolute() || root.size() != 2 || root[1] != L':' ||
        !((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z')) || !path.has_filename())
        fail("invalid_path", "An ordinary absolute drive path is required.");
    for (const auto& component : path.relative_path()) {
        const auto name = component.native();
        if (name.empty() || name == L"." || name == L".." || name.size() > 255 || name.back() == L'.' ||
            name.back() == L' ' || device_name(name) ||
            std::any_of(name.begin(), name.end(), [](wchar_t c) {
                return c < 32 || std::wstring_view(L"<>:\"|?*").find(c) != std::wstring_view::npos;
            })) fail("invalid_path", "Unsupported file path component.");
    }
    return path;
}
void hold_parents(const fs::path& path, std::vector<Handle>& held) {
    auto current = path.root_path();
    const auto open = [&] {
        Handle directory(CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!directory) fail("invalid_parent", "All parent directories must already exist and be accessible.", 4);
        const auto value = information(directory);
        if (!(value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
            fail("unsafe_path", "Reparse points are not supported.");
        held.push_back(std::move(directory)); // No delete sharing: keep the checked ancestors in place.
    };
    open();
    for (const auto& component : path.parent_path().relative_path()) { current /= component; open(); }
}
Handle open_regular(const fs::path& path, bool allow_absent, std::uint64_t cap, bool writable_sharing = false) {
    Handle file(CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | (writable_sharing ? FILE_SHARE_WRITE : 0), nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
    if (!file) {
        const auto error = GetLastError();
        if (allow_absent && error == ERROR_FILE_NOT_FOUND) return {};
        if (error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION)
            fail("file_busy", "Close applications using the input or target before importing.", 4);
        fail("io_error", "Cannot open a required ordinary file.", 4);
    }
    const auto value = information(file);
    if (GetFileType(file.get()) != FILE_TYPE_DISK ||
        (value.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || value.nNumberOfLinks != 1)
        fail("unsafe_path", "Only ordinary files without reparse points or hard links are supported.");
    if (file_size(value) > cap) fail("limit_exceeded", "A file exceeds the migration size limit.");
    return file;
}
void no_sidecars(const fs::path& target) {
    for (const auto* suffix : {L"-wal", L"-shm", L"-journal"}) {
        const fs::path path(target.native() + suffix);
        const auto attributes = GetFileAttributesW(path.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES)
            fail("target_not_offline", "Close and checkpoint the native target before importing.", 4);
        if (GetLastError() != ERROR_FILE_NOT_FOUND)
            fail("io_error", "Cannot inspect target sidecar paths.", 4);
    }
}
std::string read_input(const Handle& file) {
    const auto size = file_size(information(file));
    if (!size || size > max_input_bytes) fail("limit_exceeded", "Input must contain at most 4 MiB of UTF-8 JSON.");
    std::string bytes(static_cast<std::size_t>(size), '\0');
    std::size_t offset{};
    while (offset < bytes.size()) {
        DWORD count{};
        if (!ReadFile(file.get(), bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &count, nullptr) || !count)
            fail("io_error", "Cannot read the complete migration input.", 4);
        offset += count;
    }
    return bytes;
}
struct Transfer { ArchiveDocument archive; std::string source; };
Transfer parse_transfer(std::string_view bytes) {
    Json root;
    try { root = Json::parse(bytes, max_input_bytes); }
    catch (...) { fail("invalid_json", "Input is not valid bounded UTF-8 JSON."); }
    if (!root.is_object() || root.as_object().size() != 4 || !root.find("format") || !root.find("version") ||
        !root.find("sourceId") || !root.find("archive")) fail("invalid_envelope", "Unsupported transfer envelope fields.");
    if (!root.at("format").is_string() || root.at("format").as_string() != "dimension-bot-memory-transfer" ||
        !root.at("version").is_number() || root.at("version").as_number() != 1)
        fail("invalid_envelope", "Unsupported transfer format or version.");
    if (!root.at("sourceId").is_string()) fail("invalid_source", "A stable legacy source namespace is required.");
    const auto source = root.at("sourceId").as_string();
    const auto alnum = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); };
    if (!source.starts_with("legacy-") || source.size() <= 7 || source.size() > 128 || !alnum(source[7]) ||
        std::any_of(source.begin() + 7, source.end(), [&](char c) { return !alnum(c) && c != '-' && c != '_' && c != '.' && c != ':'; }))
        fail("invalid_source", "A stable legacy source namespace is required.");
    ArchiveLimits transfer_limits;
    transfer_limits.max_bots = 256; // Keep migration packets small; native library exports allow 1024.
    auto archive = parse_archive(root.at("archive").dump(), transfer_limits);
    if (archive.version() != 1 || !archive.conversations().empty() || !archive.groups().empty() ||
        std::any_of(archive.memories().begin(), archive.memories().end(), [](const auto& value) { return !value.group_id.empty(); }))
        fail("unsupported_scope", "Only v1 Bots and private memories are supported.");
    return {std::move(archive), source};
}

// A small read-only native-v4 recognizer. This does not reproduce Store's
// import/conflict/fingerprint rules and never claims an authoritative plan.
struct sqlite3;
struct sqlite3_stmt;
struct Sqlite final {
    HMODULE module{};
    int(__cdecl* open)(const char*, sqlite3**, int, const char*){};
    int(__cdecl* close)(sqlite3*){};
    int(__cdecl* prepare)(sqlite3*, const char*, int, sqlite3_stmt**, const char**){};
    int(__cdecl* finalize)(sqlite3_stmt*){};
    int(__cdecl* step)(sqlite3_stmt*){};
    int(__cdecl* type)(sqlite3_stmt*, int){};
    std::int64_t(__cdecl* integer)(sqlite3_stmt*, int){};
    const unsigned char*(__cdecl* text)(sqlite3_stmt*, int){};
    int(__cdecl* bytes)(sqlite3_stmt*, int){};
    int(__cdecl* readonly)(sqlite3*, const char*){};
    int(__cdecl* limit)(sqlite3*, int, int){};
    void(__cdecl* progress)(sqlite3*, int, int(__cdecl*)(void*), void*){};
    template<class T> void resolve(T& value, const char* name) {
        value = reinterpret_cast<T>(GetProcAddress(module, name));
        if (!value) fail("sqlite_unavailable", "Required system SQLite support is unavailable.", 4);
    }
    Sqlite() {
        std::array<wchar_t, 32768> directory{};
        const auto size = GetSystemDirectoryW(directory.data(), static_cast<UINT>(directory.size()));
        if (!size || size >= directory.size()) fail("sqlite_unavailable", "Required system SQLite support is unavailable.", 4);
        module = LoadLibraryW((std::wstring(directory.data(), size) + L"\\winsqlite3.dll").c_str());
        if (!module) fail("sqlite_unavailable", "Required system SQLite support is unavailable.", 4);
        try {
            resolve(open, "sqlite3_open_v2"); resolve(close, "sqlite3_close_v2"); resolve(prepare, "sqlite3_prepare_v2");
            resolve(finalize, "sqlite3_finalize"); resolve(step, "sqlite3_step"); resolve(type, "sqlite3_column_type");
            resolve(integer, "sqlite3_column_int64"); resolve(text, "sqlite3_column_text"); resolve(bytes, "sqlite3_column_bytes");
            resolve(readonly, "sqlite3_db_readonly"); resolve(limit, "sqlite3_limit"); resolve(progress, "sqlite3_progress_handler");
        } catch (...) { FreeLibrary(module); module = nullptr; throw; }
    }
    ~Sqlite() { if (module) FreeLibrary(module); }
};
std::string immutable_uri(const fs::path& path) {
    const auto utf8 = path.generic_u8string();
    std::string result = "file:///";
    constexpr char hex[] = "0123456789ABCDEF";
    for (const auto unit : utf8) {
        const auto c = static_cast<unsigned char>(unit);
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '/' || c == ':' || c == '-' || c == '_' || c == '.' || c == '~') result += static_cast<char>(c);
        else { result += '%'; result += hex[c >> 4U]; result += hex[c & 15U]; }
    }
    return result + "?mode=ro&immutable=1";
}
struct ReadonlyDatabase {
    Sqlite api;
    sqlite3* db{};
    int ticks{20000};
    explicit ReadonlyDatabase(const fs::path& path) {
        const auto uri = immutable_uri(path);
        if (api.open(uri.c_str(), &db, 1 | 0x40 | 0x10000, nullptr) != 0 || api.readonly(db, "main") != 1) {
            if (db) api.close(db); db = nullptr;
            fail("invalid_target", "Target is not a readable offline native database.", 4);
        }
        api.limit(db, 0, static_cast<int>(max_input_bytes)); // SQLITE_LIMIT_LENGTH
        api.limit(db, 1, 65536); // SQLITE_LIMIT_SQL_LENGTH; every query below is fixed.
        api.progress(db, 1000, [](void* state) -> int { return --*static_cast<int*>(state) < 0; }, &ticks);
    }
    ~ReadonlyDatabase() { if (db) api.close(db); }
};
struct Query {
    ReadonlyDatabase& database;
    sqlite3_stmt* statement{};
    Query(ReadonlyDatabase& value, const std::string& sql) : database(value) {
        if (database.api.prepare(database.db, sql.c_str(), -1, &statement, nullptr) != 0) {
            if (statement) database.api.finalize(statement); statement = nullptr;
            fail("invalid_target", "Target does not have the required native-v4 structure.", 4);
        }
    }
    ~Query() { if (statement) database.api.finalize(statement); }
    bool next() {
        const auto result = database.api.step(statement);
        if (result == 100) return true;
        if (result == 101) return false;
        fail(database.ticks < 0 ? "limit_exceeded" : "invalid_target", "Cannot complete the bounded native target inspection.", 4);
    }
    std::int64_t integer(int index) {
        if (database.api.type(statement, index) != 1) fail("invalid_target", "Invalid native target metadata.", 4);
        return database.api.integer(statement, index);
    }
    std::string text(int index) {
        const auto size = database.api.bytes(statement, index);
        if (database.api.type(statement, index) != 3 || size < 0 || size > 128)
            fail("invalid_target", "Invalid native target metadata.", 4);
        const auto* value = database.api.text(statement, index);
        return value ? std::string(reinterpret_cast<const char*>(value), static_cast<std::size_t>(size)) : std::string{};
    }
};
std::int64_t scalar(ReadonlyDatabase& db, const std::string& sql) {
    Query query(db, sql);
    if (!query.next()) fail("invalid_target", "Missing native target metadata.", 4);
    const auto value = query.integer(0);
    if (query.next()) fail("invalid_target", "Invalid native target metadata.", 4);
    return value;
}
struct Existing { std::int64_t bots{}, memories{}; };
Existing inspect_target(const fs::path& path) {
    ReadonlyDatabase db(path);
    const auto uv = scalar(db, "PRAGMA user_version");
    if (scalar(db, "PRAGMA application_id") != 0x44494d41 || uv < 4 || uv > 11)
        fail("invalid_target", "Only current native target databases are supported.", 4);
    for (const auto* table : {"bots", "messages", "memories", "message_receipts", "store_revision",
                            "archive_message_sources", "archive_memory_sources", "groups", "application_metadata_bootstrap"}) {
        if (scalar(db, std::string("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='") + table + "'") != 1)
            fail("invalid_target", "Target does not have the required native-v4 structure.", 4);
    }
    for (const auto* table : {"bots", "messages", "memories", "message_receipts", "archive_message_sources",
                            "archive_memory_sources", "groups", "application_metadata_bootstrap"}) {
        for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
            if (scalar(db, std::string("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='store_revision_") +
                table + "_" + event + "' AND tbl_name='" + table + "'") != 1)
                fail("invalid_target", "Target does not have the required native revision structure.", 4);
    }
    for (const auto* sql : {
        "SELECT id,name,persona,in_chat,in_work FROM bots LIMIT 0",
        "SELECT id,bot_id,group_id,text,state,revision,source_actor FROM memories LIMIT 0",
        "SELECT source_namespace,source_record_id,target_id,fingerprint FROM archive_memory_sources LIMIT 0"}) {
        Query query(db, sql); if (query.next()) fail("invalid_target", "Invalid native target structure.", 4);
    }
    Query state(db, "SELECT revision,identity FROM store_revision WHERE singleton=1");
    if (!state.next() || state.integer(0) < 0) fail("invalid_target", "Invalid native target revision.", 4);
    const auto identity = state.text(1);
    if (identity.size() != 32 || std::any_of(identity.begin(), identity.end(), [](char c) {
        return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    }) || state.next()) fail("invalid_target", "Invalid native target identity.", 4);
    Existing existing{scalar(db, "SELECT count(*) FROM bots"), scalar(db, "SELECT count(*) FROM memories")};
    const auto mappings = scalar(db, "SELECT count(*) FROM archive_memory_sources");
    if (existing.bots < 0 || existing.memories < 0 || mappings < 0 || existing.bots > max_target_records ||
        existing.memories > max_target_records || mappings > max_target_records ||
        existing.bots + existing.memories + mappings > max_target_records)
        fail("limit_exceeded", "Native target exceeds the migration record inspection limit.", 4);
    return existing;
}
Json input_counts(const ArchiveDocument& archive) {
    return O{{"bots", static_cast<double>(archive.bots().size())}, {"memories", static_cast<double>(archive.memories().size())}};
}
Json import_counts(const StoreImportCounts& value) {
    return O{{"botsCreated", static_cast<double>(value.bots_created)}, {"botsPreserved", static_cast<double>(value.bots_preserved)},
        {"memoriesCreated", static_cast<double>(value.memories_created)}, {"memoriesPreserved", static_cast<double>(value.memories_preserved)},
        {"memoriesReused", static_cast<double>(value.memories_reused)}, {"memoriesTombstoned", static_cast<double>(value.memories_tombstoned)}};
}
void print(Json value) { std::cout << value.dump() << '\n'; }
struct Arguments { fs::path input, database; bool apply{}; };
Arguments arguments(int argc, wchar_t** argv) {
    Arguments result;
    bool have_input{}, have_database{};
    for (int index = 1; index < argc; ++index) {
        const std::wstring_view argument(argv[index]);
        if (argument == L"--apply" && !result.apply) result.apply = true;
        else if (argument == L"--input" && !have_input && index + 1 < argc) {
            result.input = absolute_path(argv[++index]); have_input = true;
        } else if (argument == L"--database" && !have_database && index + 1 < argc) {
            result.database = absolute_path(argv[++index]); have_database = true;
        } else fail("invalid_arguments", "Use --input ABSOLUTE_JSON --database ABSOLUTE_DATABASE [--apply].");
    }
    if (!have_input || !have_database) fail("invalid_arguments", "Use --input ABSOLUTE_JSON --database ABSOLUTE_DATABASE [--apply].");
    if (same_path(result.input, result.database)) fail("path_conflict", "Input and target must be distinct files.");
    for (const auto* suffix : {L"-wal", L"-shm", L"-journal"})
        if (same_path(result.input, fs::path(result.database.native() + suffix)))
            fail("path_conflict", "Input cannot occupy a target sidecar path.");
    return result;
}
int run(const Arguments& args) {
    std::vector<Handle> parents;
    hold_parents(args.input, parents); hold_parents(args.database, parents);
    auto input = open_regular(args.input, false, max_input_bytes);
    const auto transfer = parse_transfer(read_input(input)); // Validate everything before opening/creating a Store.
    auto target = open_regular(args.database, true, max_target_bytes);
    if (target && same_file(information(input), information(target))) fail("path_conflict", "Input and target must be distinct files.");
    no_sidecars(args.database);
    const bool existed = static_cast<bool>(target);
    const auto existing = existed ? inspect_target(args.database) : Existing{};
    if (!args.apply) {
        print(O{{"ok", true}, {"status", "preview"}, {"advisory", true}, {"requiresCommitRecheck", true},
            {"canCommit", nullptr}, {"targetExists", existed}, {"input", input_counts(transfer.archive)},
            {"existing", O{{"bots", static_cast<double>(existing.bots)}, {"memories", static_cast<double>(existing.memories)}}},
            {"proposedAdds", existed ? Json() : input_counts(transfer.archive)}, {"messagesImported", 0}, {"attachmentsImported", 0}});
        return 0;
    }
    if (existed) {
        auto shared = open_regular(args.database, false, max_target_bytes, true);
        if (!same_file(information(target), information(shared))) fail("target_changed", "Target changed during inspection.", 4);
        target = std::move(shared); // Retain no-delete sharing while Store acquires its own write connection.
    } else {
        target = Handle(CreateFileW(args.database.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!target) fail("target_changed", "Cannot exclusively create the absent target.", 4);
    }
    no_sidecars(args.database);
    Store store(args.database);
    StoreImportOptions options{transfer.source, StoreBotConflict::Reject, StoreMemoryConflict::Reject};
    const auto plan = store.prepare_archive_import(transfer.archive, options);
    if (!plan.can_commit) {
        O codes{{"bot_conflict", 0}, {"memory_conflict", 0}, {"source_record_changed", 0}, {"other", 0}};
        for (const auto& item : plan.issues) {
            const auto key = codes.contains(item.code) ? item.code : "other";
            codes[key] = codes.at(key).as_number() + 1;
        }
        print(O{{"ok", false}, {"status", "conflict"}, {"canCommit", false}, {"counts", import_counts(plan.counts)},
            {"issueCount", static_cast<double>(plan.issue_count)}, {"issueCodes", std::move(codes)},
            {"issuesTruncated", plan.issues_truncated}, {"error", O{{"code", "import_conflict"}, {"message", "Native import conflicts prevent this batch."}}}});
        return 3;
    }
    const auto result = store.commit_archive_import(transfer.archive, options, plan.target_revision, plan.digest);
    print(O{{"ok", true}, {"status", result.revision_before == result.revision_after ? "unchanged" : "applied"},
        {"counts", import_counts(result.counts)}, {"revisionBefore", std::to_string(result.revision_before)},
        {"revisionAfter", std::to_string(result.revision_after)}, {"messagesImported", 0}, {"attachmentsImported", 0}});
    return 0;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring_view(argv[1]) == L"--help") {
            print(O{{"usage", "DImensionagent-import-bots --input ABSOLUTE_JSON --database ABSOLUTE_DATABASE [--apply]"},
                {"default", "read-only advisory preview"}, {"scope", "normalized v1 Bots and private memories only"}});
            return 0;
        }
        return run(arguments(argc, argv));
    } catch (const Failure& error) {
        print(O{{"ok", false}, {"status", "error"}, {"error", O{{"code", error.code}, {"message", error.message}}}});
        return error.exit_code;
    } catch (const ArchiveError& error) {
        const auto code = error.code() == ArchiveErrorCode::LimitExceeded ? "limit_exceeded" : "invalid_archive";
        print(O{{"ok", false}, {"status", "error"}, {"error", O{{"code", code}, {"message", "The normalized archive is invalid or unsupported."}}}});
        return 2;
    } catch (const StoreError& error) {
        const bool conflict = error.code() == StoreErrorCode::Conflict;
        print(O{{"ok", false}, {"status", "error"}, {"error", O{{"code", conflict ? "commit_conflict" : "store_error"},
            {"message", conflict ? "Target changed or the import conflicts with native data." : "The native Store could not complete the import."}}}});
        return conflict ? 3 : 4;
    } catch (...) {
        print(O{{"ok", false}, {"status", "error"}, {"error", O{{"code", "internal_error"}, {"message", "Migration could not complete."}}}});
        return 5;
    }
}
