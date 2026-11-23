#include "dimension/approvals.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#include <algorithm>
#include <array>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <mutex>
#include <utility>
#include <vector>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

[[noreturn]] void fail(int status, const char* code, const char* message) {
    throw ApprovalError(status, code, message);
}
void require(bool value, const char* message) {
    if (!value) fail(400, "approval_invalid", message);
}
void storage_check(bool value, const char* message) {
    if (!value) fail(503, "approval_storage", message);
}
std::int64_t milliseconds_now() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
class Handle {
public:
    Handle() = default;
    explicit Handle(HANDLE handle) : handle_(handle) {}
    ~Handle() { if (valid()) CloseHandle(handle_); }
    Handle(Handle&& other) noexcept : handle_(std::exchange(other.handle_, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) {
            if (valid()) CloseHandle(handle_);
            handle_ = std::exchange(other.handle_, INVALID_HANDLE_VALUE);
        }
        return *this;
    }
    Handle(const Handle&) = delete;
    bool valid() const { return handle_ && handle_ != INVALID_HANDLE_VALUE; }
    HANDLE get() const { return handle_; }
private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};
std::wstring extended(fs::path path) {
    path.make_preferred();
    return L"\\\\?\\" + path.wstring();
}
bool hex(std::string_view value, std::size_t length) {
    return value.size() == length && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
std::string encode_hex(const unsigned char* bytes, std::size_t size) {
    constexpr char alphabet[] = "0123456789abcdef";
    std::string text;
    text.reserve(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        text += alphabet[bytes[i] >> 4U];
        text += alphabet[bytes[i] & 15U];
    }
    return text;
}
std::string nonce() {
    std::array<unsigned char, 16> bytes{};
    storage_check(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0, "Cannot create approval identity");
    return encode_hex(bytes.data(), bytes.size());
}
std::string digest(std::string_view text) {
    struct Hash {
        BCRYPT_ALG_HANDLE algorithm{};
        BCRYPT_HASH_HANDLE value{};
        ~Hash() {
            if (value) BCryptDestroyHash(value);
            if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        }
    } hash;
    storage_check(text.size() <= std::numeric_limits<ULONG>::max() &&
        BCryptOpenAlgorithmProvider(&hash.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0 &&
        BCryptCreateHash(hash.algorithm, &hash.value, nullptr, 0, nullptr, 0, 0) >= 0 &&
        BCryptHashData(hash.value, reinterpret_cast<PUCHAR>(const_cast<char*>(text.data())),
            static_cast<ULONG>(text.size()), 0) >= 0, "Cannot hash approval parameters");
    std::array<unsigned char, 32> bytes{};
    storage_check(BCryptFinishHash(hash.value, bytes.data(), static_cast<ULONG>(bytes.size()), 0) >= 0,
        "Cannot finish approval digest");
    return encode_hex(bytes.data(), bytes.size());
}
void identifier(std::string_view value, std::size_t maximum = 256) {
    require(!value.empty() && value.size() <= maximum &&
        std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; }),
        "Invalid approval identifier");
    try { (void)Json(std::string(value)).dump(); }
    catch (...) { fail(400, "approval_invalid", "Approval identifier is not valid UTF-8"); }
}
void approval_id(std::string_view id) {
    require(id.starts_with("approval-") && hex(id.substr(9), 32), "Invalid approval request ID");
}
ApprovalLimits validate_limits(ApprovalLimits limits) {
    require(limits.max_records > 0 && limits.max_records <= 1024 &&
        limits.max_pending > 0 && limits.max_pending <= limits.max_records &&
        limits.max_snapshot_bytes >= 1024 && limits.max_snapshot_bytes <= 16U * 1024U * 1024U &&
        limits.max_arguments_bytes > 0 && limits.max_arguments_bytes <= 4U * 1024U * 1024U &&
        limits.max_display_bytes >= 32 && limits.max_display_bytes <= 16384 &&
        limits.max_result_bytes >= 4 && limits.max_result_bytes <= 65536 &&
        limits.lifetime.count() > 0 && limits.lifetime <= std::chrono::hours(24),
        "Invalid approval limits");
    return limits;
}
BY_HANDLE_FILE_INFORMATION inspect(HANDLE handle, bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};
    storage_check(GetFileInformationByHandle(handle, &info) != FALSE, "Cannot inspect approval storage");
    storage_check(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
        (directory || info.nNumberOfLinks == 1), "Approval storage contains an unsafe path or hard link");
    return info;
}
fs::path validate_root(const fs::path& input) {
    const auto name = input.root_name().wstring();
    require(input.is_absolute() && name.size() == 2 && name[1] == L':' &&
        ((name[0] >= L'A' && name[0] <= L'Z') || (name[0] >= L'a' && name[0] <= L'z')) &&
        !input.relative_path().empty(), "Approval data path must be an absolute local directory");
    for (const auto& component : input.relative_path()) {
        const auto part = component.wstring();
        require(!part.empty() && part != L"." && part != L".." && part.back() != L'.' &&
            part.back() != L' ' && part.find_first_of(L":*?\"<>|") == part.npos &&
            std::none_of(part.begin(), part.end(), [](wchar_t c) { return c < 32; }),
            "Approval data path contains an ambiguous component");
    }
    auto result = input.lexically_normal();
    result.make_preferred();
    require(result.wstring().size() < 31000, "Approval data path is too long");
    return result;
}

// Pins ALL ancestors without FILE_SHARE_DELETE. A junction cannot be swapped
// underneath a checked pathname while this store is alive.
class Disk {
public:
    explicit Disk(const fs::path& root) : root_(validate_root(root)) {
        auto current = root_.root_path();
        pin(current, false);
        for (const auto& component : root_.relative_path()) {
            current /= component;
            pin(current, true);
        }
        lock_ = Handle(CreateFileW(extended(root_ / L"approvals.lock").c_str(),
            GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        storage_check(lock_.valid(), "Approval data is already in use or cannot be locked");
        (void)inspect(lock_.get(), false);
        reject_ambiguous_snapshots();
        pin(root_ / L"archive", true);
        pin(root_ / L"archive" / L"by-id", true);
        pin(root_ / L"archive" / L"by-action", true);
    }
    std::optional<std::string> read(std::size_t maximum) const {
        return read_at(root_ / L"approvals.json", maximum);
    }
    std::optional<std::string> archived_id(std::string_view id, std::size_t maximum) const {
        approval_id(id);
        return read_at(root_ / L"archive" / L"by-id" / (std::wstring(id.begin(), id.end()) + L".json"), maximum);
    }
    std::optional<std::string> archived_action(std::string_view key, std::size_t maximum) const {
        require(hex(key, 64), "Invalid approval archive identity");
        return read_at(root_ / L"archive" / L"by-action" / (std::wstring(key.begin(), key.end()) + L".json"), maximum);
    }
    void archive(std::string_view id, std::string_view key, const std::string& bytes, std::size_t maximum) const {
        approval_id(id); require(hex(key, 64), "Invalid approval archive identity");
        immutable(root_ / L"archive" / L"by-id" / (std::wstring(id.begin(), id.end()) + L".json"), bytes, maximum);
        immutable(root_ / L"archive" / L"by-action" / (std::wstring(key.begin(), key.end()) + L".json"), bytes, maximum);
    }
    void write(const std::string& bytes) const { write_at(root_ / L"approvals.json", bytes, true); }
private:
    void reject_ambiguous_snapshots() const {
        // Older malformed renames must not be silently ignored as a fresh store.
        // At most two names are needed: only one exact snapshot name can exist.
        WIN32_FIND_DATAW entry{};
        const auto search = FindFirstFileW(extended(root_ / L"approvals.json*").c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE) {
            storage_check(GetLastError() == ERROR_FILE_NOT_FOUND, "Cannot inspect approval snapshot names");
            return;
        }
        const bool exact = CompareStringOrdinal(entry.cFileName, -1, L"approvals.json", -1, TRUE) == CSTR_EQUAL;
        const bool another = FindNextFileW(search, &entry) != FALSE;
        const auto error = GetLastError();
        FindClose(search);
        storage_check(exact && !another && error == ERROR_NO_MORE_FILES,
            "Approval storage contains an ambiguous legacy snapshot filename");
    }
    std::optional<std::string> read_at(const fs::path& path, std::size_t maximum) const {
        Handle file(CreateFileW(extended(path).c_str(), GENERIC_READ,
            FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!file.valid()) {
            if (GetLastError() == ERROR_FILE_NOT_FOUND) return {};
            fail(503, "approval_storage", "Cannot read approval snapshot");
        }
        const auto info = inspect(file.get(), false);
        const auto size = (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32U) | info.nFileSizeLow;
        storage_check(size <= maximum, "Approval snapshot exceeds byte budget");
        std::string bytes(static_cast<std::size_t>(size), '\0');
        DWORD got{};
        storage_check(ReadFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &got, nullptr) &&
            got == bytes.size(), "Cannot read complete approval snapshot");
        return bytes;
    }
    void immutable(const fs::path& path, const std::string& bytes, std::size_t maximum) const {
        storage_check(bytes.size() <= maximum, "Approval archive record exceeds byte budget");
        if (const auto existing = read_at(path, maximum)) {
            storage_check(*existing == bytes, "Immutable approval archive conflicts with existing data");
            return;
        }
        write_at(path, bytes, false);
    }
    void write_at(const fs::path& destination, const std::string& bytes, bool replace) const {
        {
            Handle target(CreateFileW(extended(destination).c_str(), FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
            if (target.valid()) {
                (void)inspect(target.get(), false);
                storage_check(replace, "Immutable approval archive already exists");
            }
            else storage_check(GetLastError() == ERROR_FILE_NOT_FOUND, "Cannot inspect approval destination");
        }
        const auto random = nonce();
        const auto temporary = root_ / (L"approvals-" + std::wstring(random.begin(), random.end()) + L".tmp");
        Handle file(CreateFileW(extended(temporary).c_str(), GENERIC_WRITE | DELETE, 0, nullptr,
            CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        storage_check(file.valid(), "Cannot create approval snapshot");
        bool renamed = false;
        try {
            (void)inspect(file.get(), false);
            DWORD written{};
            storage_check(WriteFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()),
                &written, nullptr) && written == bytes.size() && FlushFileBuffers(file.get()),
                "Cannot flush approval snapshot");
            const auto name = extended(destination);
            const auto size = offsetof(FILE_RENAME_INFO, FileName) + (name.size() + 1) * sizeof(wchar_t);
            std::vector<unsigned char> buffer(size);
            auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
            rename->ReplaceIfExists = replace ? TRUE : FALSE;
            rename->RootDirectory = nullptr;
            rename->FileNameLength = static_cast<DWORD>(name.size() * sizeof(wchar_t));
            std::memcpy(rename->FileName, name.data(), rename->FileNameLength);
            rename->FileName[name.size()] = L'\0';
            // Rename the OPEN source handle. No pathname reopen/truncation can
            // redirect the write; replacing a name never writes its link target.
            // Observers may briefly deny DELETE sharing. Retry only those
            // pre-commit transient failures, retaining the owned source handle.
            const auto retry_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            for (;;) {
                if (SetFileInformationByHandle(file.get(), FileRenameInfo, rename,
                    static_cast<DWORD>(buffer.size())) != FALSE) break;
                const auto error = GetLastError();
                storage_check((error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED) &&
                    std::chrono::steady_clock::now() < retry_deadline,
                    "Cannot atomically commit approval snapshot");
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            renamed = true;
            std::vector<wchar_t> actual(32768);
            const auto count = GetFinalPathNameByHandleW(file.get(), actual.data(),
                static_cast<DWORD>(actual.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
            storage_check(count && count < actual.size() &&
                CompareStringOrdinal(actual.data(), static_cast<int>(count), name.data(),
                    static_cast<int>(name.size()), TRUE) == CSTR_EQUAL,
                "Committed approval snapshot has an unexpected filename");
            storage_check(FlushFileBuffers(file.get()) != FALSE, "Cannot flush committed approval snapshot");
        } catch (...) {
            if (!renamed) {
                FILE_DISPOSITION_INFO dispose{TRUE};
                (void)SetFileInformationByHandle(file.get(), FileDispositionInfo, &dispose, sizeof(dispose));
            }
            throw;
        }
    }
    void pin(const fs::path& path, bool create) {
        if (create && !CreateDirectoryW(extended(path).c_str(), nullptr))
            storage_check(GetLastError() == ERROR_ALREADY_EXISTS, "Cannot create approval data directory");
        Handle directory(CreateFileW(extended(path).c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        storage_check(directory.valid(), "Cannot pin approval data directory");
        (void)inspect(directory.get(), true);
        directories_.push_back(std::move(directory));
    }
    fs::path root_;
    std::vector<Handle> directories_;
    Handle lock_;
};

struct Normal {
    std::string bot, run, action_id, tool, arguments_digest, binding;
    unsigned attempt = 1;
    bool high_risk = true;
    Json action;
};
std::string binding(const Normal& value) {
    return digest(Json(A{"dimension-approval-v1", value.bot, value.run, std::to_string(value.attempt),
        value.action_id, value.tool, value.arguments_digest}).dump());
}
std::string action_key(const Normal& value) {
    return digest(Json(A{"dimension-approval-action-v1", value.bot, value.run,
        std::to_string(value.attempt), value.action_id}).dump());
}
bool same_invocation(const Normal& first, const Normal& second) {
    return first.bot == second.bot && first.run == second.run && first.attempt == second.attempt &&
        first.action_id == second.action_id;
}
bool approval_required(ApprovalMode mode, bool high_risk) {
    (void)approval_mode_name(mode);
    return mode == ApprovalMode::Ask || (mode == ApprovalMode::Auto && high_risk);
}
Normal normalize(const ApprovalRequest& request, const ApprovalLimits& limits) {
    identifier(request.bot_id, 160); identifier(request.run_id, 160);
    identifier(request.action_id); identifier(request.tool);
    require(request.attempt > 0 && request.attempt <= static_cast<unsigned>(std::numeric_limits<int>::max()),
        "Invalid approval attempt");
    require(request.arguments.size() <= limits.max_arguments_bytes, "Approval arguments exceed byte budget");
    Normal value{request.bot_id, request.run_id, request.action_id, request.tool, {}, {},
        request.attempt, request.high_risk, {}};
    try {
        const auto arguments = Json::parse(request.arguments, limits.max_arguments_bytes);
        require(arguments.is_object(), "Approval tool arguments must be an object");
        value.arguments_digest = digest(arguments.dump());
        require(request.action.is_object(), "Approval display action must be an object");
        auto display = request.action.as_object();
        display["tool"] = request.tool;
        value.action = Json(std::move(display));
        require(value.action.dump().size() <= limits.max_display_bytes, "Approval display exceeds byte budget");
    } catch (const ApprovalError&) { throw; }
    catch (...) { fail(400, "approval_invalid", "Invalid approval arguments or display JSON"); }
    value.binding = binding(value);
    return value;
}
struct Record {
    std::string id;
    Normal request;
    ApprovalMode mode = ApprovalMode::Auto;
    ApprovalState state = ApprovalState::Pending;
    bool consumed = false;
    std::string decision, reason = "requested";
    std::int64_t created = 0, updated = 0, expires = 0;
    Json result;
    std::stop_token guard;
    Clock::time_point deadline;
};
bool revocable(const Record& row) {
    return !row.consumed && (row.state == ApprovalState::Pending || row.state == ApprovalState::Approved);
}
bool archivable(const Record& row) {
    return row.state == ApprovalState::Rejected || row.state == ApprovalState::Cancelled ||
        row.state == ApprovalState::Stale ||
        (row.state == ApprovalState::Approved && row.consumed && !row.result.is_null());
}
Record archive_form(Record row) {
    if (row.state == ApprovalState::Approved) {
        row.state = ApprovalState::Stale;
        row.reason = "archived";
    }
    row.guard = {};
    return row;
}
bool archive_compatible(const Record& first, const Record& second) {
    const auto a = archive_form(first), b = archive_form(second);
    return a.id == b.id && a.request.binding == b.request.binding &&
        a.request.high_risk == b.request.high_risk && a.request.action.dump() == b.request.action.dump() &&
        a.mode == b.mode && a.state == b.state && a.consumed == b.consumed &&
        a.decision == b.decision && a.result.dump() == b.result.dump() && a.created == b.created;
}
Json encode(const Record& row) {
    return O{{"id", row.id}, {"botId", row.request.bot}, {"runId", row.request.run},
        {"attempt", static_cast<int>(row.request.attempt)}, {"actionId", row.request.action_id},
        {"tool", row.request.tool}, {"argumentsDigest", row.request.arguments_digest},
        {"binding", row.request.binding}, {"highRisk", row.request.high_risk},
        {"action", row.request.action}, {"mode", approval_mode_name(row.mode)},
        {"state", approval_state_name(row.state)}, {"consumed", row.consumed},
        {"decision", row.decision}, {"reason", row.reason},
        {"createdAt", std::to_string(row.created)}, {"updatedAt", std::to_string(row.updated)},
        {"expiresAt", std::to_string(row.expires)}, {"result", row.result}};
}
void shape(const Json& value, std::initializer_list<std::string_view> names) {
    require(value.is_object() && value.as_object().size() == names.size(), "Invalid approval snapshot shape");
    for (auto name : names) require(value.find(name), "Missing approval snapshot field");
}
std::string text(const Json& value, std::string_view name) {
    const auto* field = value.find(name);
    require(field && field->is_string(), "Invalid approval snapshot text");
    return field->as_string();
}
std::int64_t integer_text(const Json& value, std::string_view name) {
    const auto source = text(value, name);
    std::int64_t number = 0;
    const auto parsed = std::from_chars(source.data(), source.data() + source.size(), number);
    require(parsed.ec == std::errc{} && parsed.ptr == source.data() + source.size() && number > 0 &&
        std::to_string(number) == source, "Invalid approval snapshot time");
    return number;
}
ApprovalState state_from(std::string_view state) {
    if (state == "pending") return ApprovalState::Pending;
    if (state == "approved") return ApprovalState::Approved;
    if (state == "rejected") return ApprovalState::Rejected;
    if (state == "cancelled") return ApprovalState::Cancelled;
    if (state == "stale") return ApprovalState::Stale;
    fail(400, "approval_invalid", "Invalid approval state");
}
Record decode(const Json& value, const ApprovalLimits& limits) {
    shape(value, {"id", "botId", "runId", "attempt", "actionId", "tool", "argumentsDigest", "binding",
        "highRisk", "action", "mode", "state", "consumed", "decision", "reason", "createdAt",
        "updatedAt", "expiresAt", "result"});
    Record row;
    row.id = text(value, "id"); approval_id(row.id);
    auto& request = row.request;
    request.bot = text(value, "botId"); identifier(request.bot, 160);
    request.run = text(value, "runId"); identifier(request.run, 160);
    request.action_id = text(value, "actionId"); identifier(request.action_id);
    request.tool = text(value, "tool"); identifier(request.tool);
    const auto& attempt = value.at("attempt");
    require(attempt.is_number() && attempt.as_number() >= 1 &&
        attempt.as_number() <= std::numeric_limits<int>::max() &&
        attempt.as_number() == static_cast<int>(attempt.as_number()), "Invalid stored approval attempt");
    request.attempt = static_cast<unsigned>(attempt.as_number());
    request.arguments_digest = text(value, "argumentsDigest");
    request.binding = text(value, "binding");
    require(hex(request.arguments_digest, 64) && request.binding == binding(request),
        "Invalid stored approval binding");
    require(value.at("highRisk").is_bool() && value.at("consumed").is_bool(),
        "Invalid stored approval boolean");
    request.high_risk = value.at("highRisk").as_bool();
    request.action = value.at("action");
    require(request.action.is_object() && request.action.dump().size() <= limits.max_display_bytes &&
        text(request.action, "tool") == request.tool, "Invalid stored approval display");
    row.mode = approval_mode(text(value, "mode"));
    row.state = state_from(text(value, "state"));
    row.consumed = value.at("consumed").as_bool();
    row.decision = text(value, "decision");
    row.reason = text(value, "reason");
    require(row.reason.size() <= 64 &&
        (row.decision.empty() || row.decision == "allow" || row.decision == "deny" || row.decision == "policy"),
        "Invalid stored approval decision");
    row.created = integer_text(value, "createdAt"); row.updated = integer_text(value, "updatedAt");
    row.expires = integer_text(value, "expiresAt");
    require(row.expires >= row.created, "Invalid stored approval expiry");
    row.result = value.at("result");
    require((row.result.is_null() || row.result.is_object()) &&
        row.result.dump().size() <= limits.max_result_bytes &&
        (row.result.is_null() || row.consumed), "Invalid stored approval result");
    require(!row.consumed || row.decision == "allow" || row.decision == "policy",
        "Consumed approval lacks a decision");
    require(row.state != ApprovalState::Pending || (!row.consumed && row.decision.empty() &&
        approval_required(row.mode, request.high_risk)), "Invalid pending approval");
    require(row.state != ApprovalState::Approved || row.decision == "allow" || row.decision == "policy",
        "Approved record lacks a decision");
    require(row.state != ApprovalState::Rejected || (!row.consumed && row.decision == "deny"),
        "Invalid rejected approval");
    return row;
}
} // namespace

ApprovalError::ApprovalError(int status, std::string code, std::string message)
    : std::runtime_error(std::move(message)), status_(status), code_(std::move(code)) {}
ApprovalMode approval_mode(std::string_view value) {
    if (value == "full") return ApprovalMode::Full;
    if (value == "auto") return ApprovalMode::Auto;
    if (value == "ask") return ApprovalMode::Ask;
    fail(400, "approval_invalid", "Approval mode must be full, auto or ask");
}
std::string approval_mode_name(ApprovalMode value) {
    switch (value) {
    case ApprovalMode::Full: return "full";
    case ApprovalMode::Auto: return "auto";
    case ApprovalMode::Ask: return "ask";
    }
    fail(400, "approval_invalid", "Invalid approval mode");
}
std::string approval_state_name(ApprovalState value) {
    switch (value) {
    case ApprovalState::Pending: return "pending";
    case ApprovalState::Approved: return "approved";
    case ApprovalState::Rejected: return "rejected";
    case ApprovalState::Cancelled: return "cancelled";
    case ApprovalState::Stale: return "stale";
    }
    fail(400, "approval_invalid", "Invalid approval state");
}

struct ApprovalService::Impl {
    using Records = std::map<std::string, Record, std::less<>>;
    ApprovalLimits limits;
    Disk disk;
    std::string session;
    std::mutex mutex;
    std::condition_variable_any changed;
    Records records;
    bool poisoned = false, closing = false;

    Impl(const fs::path& root, ApprovalLimits supplied)
        : limits(validate_limits(supplied)), disk(root), session(nonce()) {
        const auto bytes = disk.read(limits.max_snapshot_bytes);
        if (!bytes) return;
        try {
            const auto snapshot = Json::parse(*bytes, limits.max_snapshot_bytes);
            shape(snapshot, {"version", "records"});
            require(snapshot.at("version").is_number() && snapshot.at("version").as_number() == 1 &&
                snapshot.at("records").is_array() &&
                snapshot.at("records").as_array().size() <= limits.max_records,
                "Unsupported approval snapshot");
            for (const auto& item : snapshot.at("records").as_array()) {
                auto row = decode(item, limits);
                for (const auto& [id, previous] : records) {
                    (void)id;
                    require(!same_invocation(previous.request, row.request), "Duplicate approval invocation");
                }
                require(records.emplace(row.id, row).second, "Duplicate approval record");
            }
            bool modified = false;
            for (auto& [id, row] : records) {
                (void)id;
                if (row.state == ApprovalState::Pending || row.state == ApprovalState::Approved) {
                    row.state = ApprovalState::Stale; row.reason = "restart";
                    row.updated = milliseconds_now(); modified = true;
                }
            }
            if (modified) disk.write(serialize(records));
        } catch (...) {
            // A malformed/oversized file is never treated as an empty database.
            fail(503, "approval_snapshot_invalid", "Approval snapshot cannot be safely restored");
        }
    }
    void healthy(bool open = false) const {
        if (poisoned) fail(503, "approval_storage_failed", "Approval storage failed; restart after inspection");
        if (open && closing) fail(409, "approval_closed", "Approval service is shutting down");
    }
    std::string serialize(const Records& rows) const {
        A result;
        for (const auto& [id, row] : rows) { (void)id; result.push_back(encode(row)); }
        auto bytes = Json(O{{"version", 1}, {"records", std::move(result)}}).dump();
        if (bytes.size() > limits.max_snapshot_bytes)
            fail(429, "approval_capacity", "Approval snapshot byte budget is full");
        return bytes;
    }
    void commit(Records next) {
        healthy();
        const auto bytes = serialize(next);
        try { disk.write(bytes); }
        catch (...) {
            poisoned = true; changed.notify_all();
            fail(503, "approval_storage_failed", "Cannot persist approval transition; no new permit is valid");
        }
        records = std::move(next);
        changed.notify_all();
    }
    void refresh() {
        healthy();
        auto next = records;
        bool modified = false;
        const auto now = Clock::now();
        for (auto& [id, row] : next) {
            (void)id;
            if (!revocable(row)) continue;
            if (row.guard.stop_requested() || now >= row.deadline) {
                const auto stopped = row.guard.stop_requested();
                row.state = stopped ? ApprovalState::Cancelled : ApprovalState::Stale;
                row.reason = stopped ? "stopped" : "expired";
                row.updated = milliseconds_now(); modified = true;
            }
        }
        if (modified) commit(std::move(next));
    }
    std::size_t archive_limit() const {
        return limits.max_display_bytes + limits.max_result_bytes + 4096;
    }
    Record decode_archive(const std::string& bytes) {
        auto row = decode(Json::parse(bytes, archive_limit()), limits);
        require(row.state == ApprovalState::Rejected || row.state == ApprovalState::Cancelled ||
            row.state == ApprovalState::Stale, "An archived approval cannot carry live authority");
        return row;
    }
    std::optional<Record> archived_id(std::string_view id) {
        try {
            const auto bytes = disk.archived_id(id, archive_limit());
            if (!bytes) return {};
            auto row = decode_archive(*bytes);
            require(row.id == id, "Approval archive ID mismatch");
            return row;
        } catch (...) {
            poisoned = true; changed.notify_all();
            fail(503, "approval_archive_invalid", "Approval archive cannot be safely read");
        }
    }
    std::optional<Record> archived_action(const Normal& request) {
        try {
            const auto key = action_key(request);
            const auto bytes = disk.archived_action(key, archive_limit());
            if (!bytes) return {};
            auto row = decode_archive(*bytes);
            require(action_key(row.request) == key, "Approval archive invocation mismatch");
            return row;
        } catch (...) {
            poisoned = true; changed.notify_all();
            fail(503, "approval_archive_invalid", "Approval archive cannot be safely read");
        }
    }
    void compact_terminal() {
        // Retired records have no live wait/decision authority. Two immutable
        // keyed copies are committed before removing the active snapshot entry.
        // A crash at any earlier step leaves that entry and resumes this repair.
        auto next = records;
        bool modified = false;
        try {
            for (const auto& [id, row] : records) {
                if (!archivable(row)) continue;
                auto frozen = archive_form(row);
                const auto by_id = archived_id(id);
                const auto by_action = archived_action(row.request);
                if (by_id) {
                    storage_check(archive_compatible(frozen, *by_id), "Approval archive ID conflict");
                    frozen = *by_id;
                }
                if (by_action) {
                    storage_check(archive_compatible(frozen, *by_action), "Approval archive action conflict");
                    if (by_id) storage_check(encode(*by_id).dump() == encode(*by_action).dump(),
                        "Approval archive copies disagree");
                    frozen = *by_action;
                }
                disk.archive(id, action_key(row.request), encode(frozen).dump(), archive_limit());
                next.erase(id); modified = true;
            }
        } catch (...) {
            poisoned = true; changed.notify_all();
            fail(503, "approval_archive_failed", "Cannot persist retired approval; active record retained");
        }
        if (modified) commit(std::move(next));
    }
    Record own(std::string_view id, std::string_view bot) {
        approval_id(id); identifier(bot, 160);
        const auto found = records.find(id);
        if (found != records.end() && found->second.request.bot == bot) return found->second;
        if (found == records.end()) {
            const auto archived = archived_id(id);
            if (archived && archived->request.bot == bot) return *archived;
        }
        fail(404, "approval_not_found", "Approval does not belong to this Bot");
    }
    Record bound(const ApprovalTicket& ticket, const Normal& expected) {
        if (ticket.session != session)
            fail(409, "approval_stale_ticket", "Approval ticket belongs to another service instance");
        auto row = own(ticket.id, expected.bot);
        if (ticket.binding != row.request.binding || expected.binding != row.request.binding ||
            expected.high_risk != row.request.high_risk)
            fail(409, "approval_binding_mismatch", "Approval does not match this run, attempt or action");
        return row;
    }
    ApprovalGrant grant(const Record& row, bool allowed, std::string reason = {}) const {
        return {allowed, row.state, reason.empty() ? row.reason : std::move(reason), encode(row)};
    }
};

ApprovalService::ApprovalService(fs::path root, ApprovalLimits limits)
    : impl_(std::make_unique<Impl>(root, limits)) {}
ApprovalService::~ApprovalService() = default;

ApprovalTicket ApprovalService::request(const ApprovalRequest& request, ApprovalMode mode,
                                       std::stop_token stop) {
    std::lock_guard guard(impl_->mutex);
    impl_->healthy(true);
    require(stop.stop_possible(), "Approval request requires a lifecycle/steering stop token");
    const auto input = normalize(request, impl_->limits);
    (void)approval_mode_name(mode);
    impl_->refresh();
    impl_->compact_terminal();
    for (const auto& [id, row] : impl_->records) {
        if (!same_invocation(row.request, input)) continue;
        if (row.request.binding != input.binding || row.request.high_risk != input.high_risk ||
            row.mode != mode || row.request.action.dump() != input.action.dump())
            fail(409, "approval_invocation_conflict", "Approval invocation already has different parameters");
        return {id, input.binding, impl_->session};
    }
    if (const auto old = impl_->archived_action(input)) {
        if (old->request.binding != input.binding || old->request.high_risk != input.high_risk ||
            old->mode != mode || old->request.action.dump() != input.action.dump())
            fail(409, "approval_invocation_conflict", "Archived invocation already has different parameters");
        return {old->id, input.binding, impl_->session};
    }
    if (impl_->records.size() >= impl_->limits.max_records)
        fail(429, "approval_capacity", "Approval record capacity is full");
    const bool pending = approval_required(mode, input.high_risk) && !stop.stop_requested();
    const auto count = std::count_if(impl_->records.begin(), impl_->records.end(), [](const auto& item) {
        return item.second.state == ApprovalState::Pending;
    });
    if (pending && static_cast<std::size_t>(count) >= impl_->limits.max_pending)
        fail(429, "approval_capacity", "Too many pending approvals");
    Record row;
    do { row.id = "approval-" + nonce(); } while (impl_->records.contains(row.id));
    row.request = input; row.mode = mode; row.guard = stop;
    row.created = row.updated = milliseconds_now();
    row.expires = row.created + impl_->limits.lifetime.count();
    row.deadline = Clock::now() + impl_->limits.lifetime;
    if (stop.stop_requested()) {
        row.state = ApprovalState::Cancelled; row.reason = "stopped";
    } else if (!pending) {
        row.state = ApprovalState::Approved; row.decision = "policy"; row.reason = "policy";
    }
    auto next = impl_->records;
    next.emplace(row.id, row);
    // Reserve each record's maximum outcome + bounded transition metadata now.
    // Decisions/cancellation must not fail merely because admission filled disk budget.
    const auto bytes = impl_->serialize(next).size();
    const auto reserve = next.size() * (impl_->limits.max_result_bytes + 256);
    if (reserve > impl_->limits.max_snapshot_bytes ||
        bytes > impl_->limits.max_snapshot_bytes - reserve)
        fail(429, "approval_capacity", "Approval byte budget cannot reserve a durable outcome");
    impl_->commit(std::move(next));
    return {row.id, input.binding, impl_->session};
}
ApprovalGrant ApprovalService::wait_and_consume(const ApprovalTicket& ticket,
                                                const ApprovalRequest& expected,
                                                std::stop_token stop) {
    std::unique_lock guard(impl_->mutex);
    impl_->healthy();
    const auto input = normalize(expected, impl_->limits);
    const auto original = impl_->bound(ticket, input).guard;
    // Callback only signals; it performs no I/O and acquires no service lock.
    std::stop_callback original_stopped(original, [this] { impl_->changed.notify_all(); });
    for (;;) {
        impl_->healthy();
        impl_->refresh();
        auto row = impl_->bound(ticket, input);
        if (stop.stop_requested() && revocable(row)) {
            auto next = impl_->records;
            auto& cancelled = next.at(row.id);
            cancelled.state = ApprovalState::Cancelled; cancelled.reason = "stopped";
            cancelled.updated = milliseconds_now();
            impl_->commit(std::move(next));
            continue;
        }
        if (row.consumed) return impl_->grant(row, false, "already_consumed");
        if (row.state != ApprovalState::Pending && row.state != ApprovalState::Approved)
            return impl_->grant(row, false);
        if (impl_->closing) return impl_->grant(row, false, "shutdown");
        if (row.state == ApprovalState::Approved) {
            // All checks and durable consumed=true are one serialized operation.
            auto next = impl_->records;
            auto& consumed = next.at(row.id);
            consumed.consumed = true; consumed.reason = "consumed"; consumed.updated = milliseconds_now();
            impl_->commit(std::move(next));
            if (stop.stop_requested() || original.stop_requested()) {
                auto cancelled = impl_->records;
                auto& claimed = cancelled.at(ticket.id);
                claimed.state = ApprovalState::Cancelled; claimed.reason = "stopped_before_dispatch";
                claimed.updated = milliseconds_now();
                impl_->commit(std::move(cancelled));
                return impl_->grant(impl_->records.at(ticket.id), false);
            }
            return impl_->grant(impl_->records.at(ticket.id), true);
        }
        const auto deadline = row.deadline;
        impl_->changed.wait_until(guard, stop, deadline, [&] {
            const auto current = impl_->records.find(ticket.id);
            return impl_->poisoned || impl_->closing || current == impl_->records.end() ||
                current->second.state != ApprovalState::Pending || current->second.guard.stop_requested();
        });
    }
}
Json ApprovalService::decide(std::string_view id, std::string_view bot_id, bool allow) {
    std::lock_guard guard(impl_->mutex);
    impl_->healthy(true); impl_->refresh();
    auto row = impl_->own(id, bot_id);
    const auto decision = allow ? "allow" : "deny";
    if ((row.state == ApprovalState::Approved || row.state == ApprovalState::Rejected ||
         (row.consumed && !row.result.is_null())) &&
        row.decision == decision)
        return O{{"ok", true}, {"alreadyDecided", true}, {"approval", encode(row)}};
    if (row.state != ApprovalState::Pending)
        fail(409, "approval_not_pending", "Approval is decided, cancelled, expired or stale");
    auto next = impl_->records;
    auto& updated = next.at(std::string(id));
    updated.state = allow ? ApprovalState::Approved : ApprovalState::Rejected;
    updated.decision = decision; updated.reason = allow ? "allowed" : "denied";
    updated.updated = milliseconds_now();
    impl_->commit(std::move(next));
    return O{{"ok", true}, {"alreadyDecided", false}, {"approval", encode(impl_->records.at(std::string(id)))}};
}
Json ApprovalService::get(std::string_view id, std::string_view bot_id) {
    std::lock_guard guard(impl_->mutex);
    impl_->refresh();
    return encode(impl_->own(id, bot_id));
}
Json ApprovalService::list(std::string_view bot_id, bool pending_only) {
    std::lock_guard guard(impl_->mutex);
    identifier(bot_id, 160); impl_->refresh();
    A rows;
    for (const auto& [id, row] : impl_->records) {
        (void)id;
        if (row.request.bot == bot_id && (!pending_only || row.state == ApprovalState::Pending))
            rows.push_back(encode(row));
    }
    return rows;
}
std::size_t ApprovalService::invalidate_run(std::string_view bot_id, std::string_view run_id,
                                           std::optional<unsigned> attempt, ApprovalState state) {
    std::lock_guard guard(impl_->mutex);
    impl_->healthy(); identifier(bot_id, 160); identifier(run_id, 160);
    require(!attempt || (*attempt > 0 && *attempt <= static_cast<unsigned>(std::numeric_limits<int>::max())),
        "Invalid approval attempt");
    require(state == ApprovalState::Cancelled || state == ApprovalState::Stale,
        "Invalid approval invalidation state");
    auto next = impl_->records;
    std::size_t changed = 0;
    for (auto& [id, row] : next) {
        (void)id;
        if (row.request.bot != bot_id || row.request.run != run_id ||
            (attempt && row.request.attempt != *attempt) || !revocable(row)) continue;
        row.state = state;
        row.reason = state == ApprovalState::Cancelled ? "run_cancelled" : "run_invalidated";
        row.updated = milliseconds_now(); ++changed;
    }
    if (changed) impl_->commit(std::move(next));
    return changed;
}
Json ApprovalService::complete(const ApprovalTicket& ticket, const ApprovalRequest& expected,
                              const Json& outcome) {
    std::lock_guard guard(impl_->mutex);
    impl_->healthy();
    const auto input = normalize(expected, impl_->limits);
    auto row = impl_->bound(ticket, input);
    require(outcome.is_object(), "Approval outcome must be an object");
    const auto bytes = outcome.dump();
    require(bytes.size() <= impl_->limits.max_result_bytes, "Approval outcome exceeds byte budget");
    if (!row.result.is_null()) {
        if (row.result.dump() != bytes)
            fail(409, "approval_result_conflict", "Approval already has a different execution outcome");
        return encode(row);
    }
    if (!row.consumed || row.state != ApprovalState::Approved)
        fail(409, "approval_not_consumed", "Only a consumed current approval can record an outcome");
    auto next = impl_->records;
    auto& updated = next.at(ticket.id);
    updated.result = outcome; updated.reason = "completed"; updated.updated = milliseconds_now();
    impl_->commit(std::move(next));
    return encode(impl_->records.at(ticket.id));
}
void ApprovalService::shutdown() {
    std::lock_guard guard(impl_->mutex);
    if (impl_->closing) return;
    impl_->closing = true;
    impl_->changed.notify_all();
    impl_->healthy();
    auto next = impl_->records;
    bool changed = false;
    for (auto& [id, row] : next) {
        (void)id;
        if (!revocable(row)) continue;
        row.state = ApprovalState::Cancelled; row.reason = "shutdown";
        row.updated = milliseconds_now(); changed = true;
    }
    if (changed) impl_->commit(std::move(next));
}

} // namespace dimension


