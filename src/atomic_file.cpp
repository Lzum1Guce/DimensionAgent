#include "dimension/atomic_file.hpp"
#include "dimension/managed_workspaces.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <utility>
#include <thread>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using Failure = AtomicFileFailure;
[[noreturn]] void fail(Failure kind, const char* message, bool committed = false) {
    throw AtomicFileError(kind, message, committed);
}
void storage(bool good, const char* message, bool committed = false) {
    if (!good) fail(Failure::Storage, message, committed);
}
void active(std::stop_token stop) {
    if (stop.stop_requested()) fail(Failure::Cancelled, "File write cancelled before commit");
}
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE value) : value(value) {}
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    Handle(const Handle&) = delete;
};
std::wstring native(fs::path path) { path.make_preferred(); const auto value=path.wstring();if(value.starts_with(L"\\\\?\\"))return value;if(value.starts_with(L"\\\\"))return L"\\\\?\\UNC\\"+value.substr(2);return L"\\\\?\\"+value; }
void inspect(HANDLE handle, bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};
    storage(GetFileInformationByHandle(handle, &info), "Cannot inspect atomic file storage");
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
        (!directory && info.nNumberOfLinks != 1))
        fail(Failure::UnsafePath, "Atomic file storage contains a link or unsafe path");
}
fs::path checked(const fs::path& input) {
    const auto drive = input.root_name().wstring();
    const bool unc = drive.starts_with(L"\\\\");
    const bool local = drive.size() == 2 && drive[1] == L':' &&
        ((drive[0] >= L'A' && drive[0] <= L'Z') || (drive[0] >= L'a' && drive[0] <= L'z'));
    if (!input.is_absolute() || (!local && !unc) || input.relative_path().empty())
        fail(Failure::InvalidPath, "Atomic file path must be absolute and local or a managed WSL workspace");
    if (unc && !managed_workspaces::key_from_windows_any_descendant(input))
        fail(Failure::InvalidPath, "Atomic network writes are restricted to managed WSL workspaces");
    for (const auto& part : input.relative_path()) {
        const auto name = part.wstring();
        if (name.empty() || name == L"." || name == L".." || name.back() == L' ' || name.back() == L'.' ||
            name.find_first_of(L":*?\"<>|") != name.npos ||
            std::any_of(name.begin(), name.end(), [](wchar_t c) { return c < 32; }))
            fail(Failure::InvalidPath, "Atomic file path contains an ambiguous component");
        auto stem = name.substr(0, name.find(L'.'));
        std::transform(stem.begin(), stem.end(), stem.begin(), [](wchar_t c) {
            return c >= L'a' && c <= L'z' ? wchar_t(c - L'a' + L'A') : c;
        });
        if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
            (stem.size() == 4 && (stem.starts_with(L"COM") || stem.starts_with(L"LPT")) && stem[3] >= L'0' && stem[3] <= L'9'))
            fail(Failure::InvalidPath, "Atomic file path uses a reserved name");
    }
    auto result = input.lexically_normal(); result.make_preferred();
    if (result.wstring().size() >= 31000) fail(Failure::InvalidPath, "Atomic file path is too long");
    return result;
}
std::wstring nonce() {
    std::array<unsigned char, 16> random{};
    storage(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0,
        "Cannot create atomic file identity");
    constexpr wchar_t alphabet[] = L"0123456789abcdef";
    std::wstring value;
    for (auto byte : random) { value += alphabet[byte >> 4]; value += alphabet[byte & 15]; }
    return value;
}
} // namespace

void atomic_write_file(const fs::path& input, std::string_view bytes, const AtomicWriteOptions& options,
                       std::stop_token stop) {
    active(stop);
    const auto target = checked(input);
    const auto boundary = options.existing_root.empty() ? fs::path{} : checked(options.existing_root);
    if (!boundary.empty()) {
        const auto relative = target.lexically_relative(boundary);
        if (relative.empty() || relative.is_absolute() || *relative.begin() == L".." || relative == L".")
            fail(Failure::InvalidPath, "Atomic destination is outside the configured project");
    }
    std::vector<Handle> directories;
    auto pin = [&](const fs::path& path, bool create) {
        active(stop);
        if (create && !CreateDirectoryW(native(path).c_str(), nullptr)) {
            const auto code=GetLastError();
            if(code!=ERROR_ALREADY_EXISTS){
                const auto message="Cannot prepare atomic file directory; Windows error "+std::to_string(code);
                throw AtomicFileError(Failure::Storage,message.c_str());
            }
        }
        Handle handle(CreateFileW(native(path).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        storage(handle.value != INVALID_HANDLE_VALUE, "Cannot pin atomic file directory");
        inspect(handle.value, true); directories.push_back(std::move(handle));
    };
    auto current = target.root_path();
    if (target.root_name().wstring().starts_with(L"\\\\")) {
        const auto managed_root=managed_workspaces::root_from_windows_descendant(target);
        if (!managed_root) fail(Failure::InvalidPath, "Managed workspace root is unavailable");
        current=*managed_root;
    }
    pin(current, false);
    bool may_create = boundary.empty(), passed_boundary = boundary.empty();
    if (!boundary.empty() && current == boundary) may_create = passed_boundary = true;
    for (const auto& part : target.parent_path().lexically_relative(current)) {
        // Equal directories yield ".". The managed root is already pinned.
        if (part == L".") continue;
        current /= part; pin(current, may_create);
        if (!boundary.empty() && current == boundary) may_create = passed_boundary = true;
    }
    if (!passed_boundary) fail(Failure::InvalidPath, "Atomic path did not pass its project boundary");
    {
        Handle existing(CreateFileW(native(target).c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (existing.value != INVALID_HANDLE_VALUE) {
            inspect(existing.value, false);
            if (!options.replace_existing) fail(Failure::AlreadyExists, "Atomic destination already exists");
        } else storage(GetLastError() == ERROR_FILE_NOT_FOUND, "Cannot inspect atomic file destination");
    }
    const auto temporary = target.parent_path() / (L".dimension-" + nonce() + L".tmp");
    Handle file(CreateFileW(native(temporary).c_str(), GENERIC_WRITE | DELETE, 0, nullptr, CREATE_NEW,
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    storage(file.value != INVALID_HANDLE_VALUE, "Cannot create exclusive atomic file");
    bool committed = false;
    try {
        inspect(file.value, false);
        for (std::size_t offset = 0; offset < bytes.size();) {
            active(stop);
            const auto count = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, 1024U * 1024U));
            DWORD written = 0;
            storage(WriteFile(file.value, bytes.data() + offset, count, &written, nullptr) && written == count,
                "Cannot write atomic file contents");
            offset += written;
        }
        storage(FlushFileBuffers(file.value), "Cannot flush atomic file contents");
        active(stop);
        const auto name = native(target);
        std::vector<unsigned char> buffer(offsetof(FILE_RENAME_INFO, FileName) + (name.size() + 1) * sizeof(wchar_t));
        auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
        rename->ReplaceIfExists = options.replace_existing ? TRUE : FALSE;
        rename->RootDirectory = nullptr; rename->FileNameLength = static_cast<DWORD>(name.size() * sizeof(wchar_t));
        std::memcpy(rename->FileName, name.data(), rename->FileNameLength); rename->FileName[name.size()] = L'\0';
        // Short-lived readers (including filesystem observers) may deny DELETE
        // sharing. Retain the same exclusively owned temp/parent handles and
        // retry only pre-commit sharing/access failures for a bounded interval.
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
        for (;;) {
            active(stop);
            if (SetFileInformationByHandle(file.value, FileRenameInfo, rename, static_cast<DWORD>(buffer.size()))) break;
            const auto error = GetLastError();
            storage((error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED) &&
                std::chrono::steady_clock::now() < deadline, "Cannot atomically commit file");
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        committed = true;
        std::vector<wchar_t> actual(32768);
        const auto count = GetFinalPathNameByHandleW(file.value, actual.data(), static_cast<DWORD>(actual.size()),
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if(!count){
            const auto code=GetLastError();
            const bool wsl_handle_query_unavailable=target.root_name().wstring().starts_with(L"\\\\")&&code==ERROR_FILE_NOT_FOUND;
            if(!wsl_handle_query_unavailable){const auto message="Cannot inspect committed file path; Windows error "+std::to_string(code);throw AtomicFileError(Failure::Storage,message.c_str(),true);}
            // The owned source handle was renamed successfully while every
            // managed directory stayed pinned. This WSL provider cannot query
            // the post-rename handle path; all other errors remain fatal.
        }else storage(count < actual.size() && CompareStringOrdinal(actual.data(), static_cast<int>(count),
            name.data(), static_cast<int>(name.size()), TRUE) == CSTR_EQUAL, "Committed file has an unexpected path", true);
        if(!FlushFileBuffers(file.value)){const auto message="Cannot flush committed file; Windows error "+std::to_string(GetLastError());throw AtomicFileError(Failure::Storage,message.c_str(),true);}
    } catch (...) {
        if (!committed) { FILE_DISPOSITION_INFO dispose{TRUE}; (void)SetFileInformationByHandle(file.value, FileDispositionInfo, &dispose, sizeof(dispose)); }
        throw;
    }
}
} // namespace dimension
