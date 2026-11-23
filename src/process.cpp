#include "dimension/process.hpp"

#ifndef _WIN32
#error The JSON worker process bridge requires Windows.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cwctype>
#include <limits>
#include <thread>
#include <utility>

namespace dimension {
namespace {

constexpr std::size_t json_limit = 4 * 1024 * 1024;
constexpr DWORD cleanup_wait_ms = 5000;

class Handle final {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) reset(std::exchange(other.value_, nullptr));
        return *this;
    }
    HANDLE get() const noexcept { return value_; }
    explicit operator bool() const noexcept { return value_ && value_ != INVALID_HANDLE_VALUE; }
    void reset(HANDLE value = nullptr) noexcept {
        if (*this) CloseHandle(value_);
        value_ = value;
    }
private:
    HANDLE value_ = nullptr;
};

[[noreturn]] void fail(ProcessErrorCode code, const char* message, DWORD native = 0) {
    throw ProcessError(code, message, native);
}

void require(bool condition, const char* message) {
    if (!condition) fail(ProcessErrorCode::InvalidArgument, message);
}

// Inverse of the Windows CRT CommandLineToArgvW-style backslash/quote rules.
// Every argument is quoted, including empty strings and argv[0].
std::wstring quote_argument(const std::wstring& value) {
    require(value.find(L'\0') == std::wstring::npos, "Worker arguments cannot contain NUL");
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') { ++slashes; continue; }
        if (character == L'\"') {
            result.append(slashes * 2 + 1, L'\\'); result += L'\"';
        } else {
            result.append(slashes, L'\\'); result += character;
        }
        slashes = 0;
    }
    result.append(slashes * 2, L'\\'); result += L'\"';
    return result;
}

std::wstring environment_value(const wchar_t* name) {
    DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    if (size > 32767) fail(ProcessErrorCode::InvalidArgument, "Inherited worker environment item is oversized");
    std::wstring value(size, L'\0');
    const DWORD copied = GetEnvironmentVariableW(name, value.data(), size);
    if (copied >= size) fail(ProcessErrorCode::Launch, "Worker environment changed during collection");
    value.resize(copied);
    return value;
}

std::wstring upper_name(std::wstring name) {
    require(!name.empty() && name.size() <= 256, "Invalid worker environment name");
    for (auto& character : name) {
        require((character >= L'a' && character <= L'z') || (character >= L'A' && character <= L'Z') ||
                (character >= L'0' && character <= L'9') || character == L'_',
                "Worker environment names must contain ASCII letters, digits or underscore");
        if (character >= L'a' && character <= L'z') character -= L'a' - L'A';
    }
    return name;
}

std::filesystem::path make_cache(const std::filesystem::path& cwd) {
    static std::atomic<std::uint64_t> serial{0};
    const auto root = cwd / L".dimension-worker-cache";
    std::error_code error;
    std::filesystem::create_directories(root, error);
    if (error) fail(ProcessErrorCode::Launch, "Cannot create worker cache directory", static_cast<DWORD>(error.value()));
    const auto attributes = GetFileAttributesW(root.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        fail(ProcessErrorCode::InvalidArgument, "Worker cache root cannot be a reparse point");
    }
    for (int attempt = 0; attempt < 16; ++attempt) {
        const auto name = std::to_wstring(GetCurrentProcessId()) + L"-" +
            std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++serial);
        const auto path = root / name;
        if (CreateDirectoryW(path.c_str(), nullptr)) return path;
        const auto error_code = GetLastError();
        if (error_code != ERROR_ALREADY_EXISTS) fail(ProcessErrorCode::Launch, "Cannot create worker cache directory", error_code);
    }
    fail(ProcessErrorCode::Launch, "Cannot allocate worker cache directory");
}

std::vector<wchar_t> environment_block(const std::filesystem::path& cache,
                                      const ProcessEnvironment& additional) {
    std::map<std::wstring, std::wstring> variables;
    for (const auto* name : {L"SYSTEMROOT", L"WINDIR", L"PATH", L"PATHEXT"}) {
        auto value = environment_value(name);
        if (!value.empty()) variables.emplace(name, std::move(value));
    }
    if (!variables.contains(L"SYSTEMROOT")) {
        std::array<wchar_t, 32768> path{};
        const auto count = GetWindowsDirectoryW(path.data(), static_cast<UINT>(path.size()));
        if (!count || count >= path.size()) fail(ProcessErrorCode::Launch, "Cannot locate Windows runtime directory", GetLastError());
        variables[L"SYSTEMROOT"] = std::wstring(path.data(), count);
    }
    if (!variables.contains(L"WINDIR")) variables[L"WINDIR"] = variables.at(L"SYSTEMROOT");
    for (const auto& [name, value] : additional) {
        const auto normalized = upper_name(name);
        require(value.size() <= 32767 && value.find(L'\0') == std::wstring::npos,
                "Invalid worker environment value");
        variables[normalized] = value;
    }
    variables[L"TEMP"] = cache.wstring(); variables[L"TMP"] = cache.wstring();
    std::vector<wchar_t> result;
    for (const auto& [name, value] : variables) {
        if (result.size() + name.size() + value.size() + 3 > 32767) {
            fail(ProcessErrorCode::InvalidArgument, "Worker environment exceeds its size limit");
        }
        result.insert(result.end(), name.begin(), name.end()); result.push_back(L'=');
        result.insert(result.end(), value.begin(), value.end()); result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

void pipe_pair(Handle& reader, Handle& writer) {
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &attributes, 65536)) fail(ProcessErrorCode::Launch, "Cannot create worker pipe", GetLastError());
    reader.reset(read); writer.reset(write);
}

void make_private(const Handle& handle) {
    if (!SetHandleInformation(handle.get(), HANDLE_FLAG_INHERIT, 0)) {
        fail(ProcessErrorCode::Launch, "Cannot restrict worker pipe inheritance", GetLastError());
    }
}

class AttributeList final {
public:
    AttributeList() {
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
        if (!bytes) fail(ProcessErrorCode::Launch, "Cannot size worker launch attributes", GetLastError());
        storage_.resize(bytes);
        list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
        if (!InitializeProcThreadAttributeList(list_, 1, 0, &bytes)) {
            list_ = nullptr; fail(ProcessErrorCode::Launch, "Cannot initialize worker launch attributes", GetLastError());
        }
    }
    ~AttributeList() { if (list_) DeleteProcThreadAttributeList(list_); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }
    void handles(std::array<HANDLE, 3>& values) {
        if (!UpdateProcThreadAttribute(list_, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       values.data(), sizeof(values), nullptr, nullptr)) {
            fail(ProcessErrorCode::Launch, "Cannot set worker handle allowlist", GetLastError());
        }
    }
private:
    std::vector<std::byte> storage_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

class Session final {
public:
    Handle job, completion, process, primary_thread;
    Handle input, output, errors, cancel_event, failed_event;
    std::thread writer, reader, stderr_reader;
    std::string response;
    std::atomic_bool overflow{false};
    std::atomic<DWORD> io_error{0};
    bool assigned = false;
    bool joined = false;

    ~Session() { cleanup(); }

    void report_io(DWORD code) noexcept {
        DWORD empty = 0; io_error.compare_exchange_strong(empty, code);
        SetEvent(failed_event.get());
    }

    void read_stdout() noexcept {
        try {
            std::array<char, 8192> buffer{};
            for (;;) {
                DWORD count = 0;
                if (!ReadFile(output.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) {
                    const auto error = GetLastError();
                    if (error != ERROR_BROKEN_PIPE && error != ERROR_OPERATION_ABORTED) report_io(error);
                    return;
                }
                if (!count) return;
                if (response.size() + count > json_limit + 2) {
                    overflow = true; SetEvent(failed_event.get()); return;
                }
                response.append(buffer.data(), count);
            }
        } catch (...) { report_io(ERROR_NOT_ENOUGH_MEMORY); }
    }

    void read_stderr() noexcept {
        std::array<char, 8192> buffer{};
        // Drain, never retain. No worker diagnostic can be copied into an error,
        // log or exception. Memory use stays constant even for noisy children.
        for (;;) {
            DWORD count = 0;
            if (!ReadFile(errors.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) {
                const auto error = GetLastError();
                if (error != ERROR_BROKEN_PIPE && error != ERROR_OPERATION_ABORTED) report_io(error);
                break;
            }
            if (!count) break;
        }
        SecureZeroMemory(buffer.data(), buffer.size());
    }

    void write_input(const std::string& bytes) noexcept {
        std::size_t offset = 0;
        while (offset < bytes.size()) {
            const auto portion = static_cast<DWORD>(std::min<std::size_t>(65536, bytes.size() - offset));
            DWORD written = 0;
            if (!WriteFile(input.get(), bytes.data() + offset, portion, &written, nullptr) || !written) {
                const auto error = GetLastError();
                if (error != ERROR_OPERATION_ABORTED) report_io(error ? error : ERROR_WRITE_FAULT);
                break;
            }
            offset += written;
        }
        input.reset(); // A complete request is immediately followed by EOF.
    }

    bool wait_empty_job() noexcept {
        if (!assigned) return true;
        const auto deadline = GetTickCount64() + cleanup_wait_ms;
        for (;;) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            if (!QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
                                           &accounting, sizeof(accounting), nullptr)) return false;
            if (!accounting.ActiveProcesses) return true;
            const auto now = GetTickCount64();
            if (now >= deadline) return false;
            DWORD code = 0; ULONG_PTR key = 0; LPOVERLAPPED overlapped = nullptr;
            const auto wait = static_cast<DWORD>(std::min<ULONGLONG>(deadline - now, 100));
            GetQueuedCompletionStatus(completion.get(), &code, &key, &overlapped, wait);
        }
    }

    bool cleanup() noexcept {
        if (joined) return true;
        if (assigned) TerminateJobObject(job.get(), ERROR_PROCESS_ABORTED);
        else if (process) TerminateProcess(process.get(), ERROR_PROCESS_ABORTED);
        if (process) WaitForSingleObject(process.get(), cleanup_wait_ms);
        const bool empty = wait_empty_job();
        // Joining normally drains all buffered stdout after job death. A child
        // cannot keep a pipe open once the entire job is empty. If teardown is
        // abnormal, explicitly abort synchronous I/O before joining the threads.
        if (!empty) {
            if (writer.joinable()) CancelSynchronousIo(writer.native_handle());
            if (reader.joinable()) CancelSynchronousIo(reader.native_handle());
            if (stderr_reader.joinable()) CancelSynchronousIo(stderr_reader.native_handle());
        }
        if (writer.joinable()) writer.join();
        if (reader.joinable()) reader.join();
        if (stderr_reader.joinable()) stderr_reader.join();
        joined = true;
        return empty;
    }
};

} // namespace

ProcessError::ProcessError(ProcessErrorCode code, std::string message, unsigned long native_code)
    : std::runtime_error(std::move(message)), code_(code), native_code_(native_code) {}

Json run_json_worker(const std::filesystem::path& executable,
                     const std::vector<std::wstring>& arguments,
                     const std::filesystem::path& cwd, const Json& input,
                     std::stop_token stop, std::chrono::milliseconds timeout,
                     const ProcessEnvironment& environment) {
    require(executable.is_absolute() && cwd.is_absolute(), "Worker executable and cwd must be absolute");
    require(executable.native().find(L'\0') == std::wstring::npos && cwd.native().find(L'\0') == std::wstring::npos,
            "Worker paths cannot contain NUL");
    require(timeout.count() > 0 && timeout <= std::chrono::hours(24), "Worker timeout must be positive and at most 24 hours");
    require(arguments.size() <= 256, "Too many worker arguments");
    if (stop.stop_requested()) fail(ProcessErrorCode::Cancelled, "Worker cancelled");
    std::error_code error;
    require(std::filesystem::is_regular_file(executable, error) && !error, "Worker executable is not a regular file");
    require(std::filesystem::is_directory(cwd, error) && !error, "Worker cwd is not a directory");
    auto request = input.dump();
    require(request.size() <= json_limit, "Worker JSON input exceeds 4 MiB");
    request += '\n';
    std::wstring command = quote_argument(executable.wstring());
    for (const auto& argument : arguments) {
        command += L' '; command += quote_argument(argument);
        require(command.size() < 32767, "Worker command line exceeds Windows limits");
    }
    require(command.size() < 32767, "Worker command line exceeds Windows limits");
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto variables = environment_block(make_cache(cwd), environment);

    Session session;
    session.job.reset(CreateJobObjectW(nullptr, nullptr));
    session.completion.reset(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
    session.cancel_event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    session.failed_event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!session.job || !session.completion || !session.cancel_event || !session.failed_event) {
        fail(ProcessErrorCode::Launch, "Cannot create worker lifecycle resources", GetLastError());
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(session.job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        fail(ProcessErrorCode::Launch, "Cannot set worker job limits", GetLastError());
    }
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT port{};
    port.CompletionKey = &session; port.CompletionPort = session.completion.get();
    if (!SetInformationJobObject(session.job.get(), JobObjectAssociateCompletionPortInformation, &port, sizeof(port))) {
        fail(ProcessErrorCode::Launch, "Cannot associate worker lifecycle notifications", GetLastError());
    }
    Handle child_input, child_output, child_errors;
    pipe_pair(child_input, session.input); pipe_pair(session.output, child_output); pipe_pair(session.errors, child_errors);
    make_private(session.input); make_private(session.output); make_private(session.errors);
    AttributeList attributes;
    std::array<HANDLE, 3> inherited{child_input.get(), child_output.get(), child_errors.get()};
    attributes.handles(inherited);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = child_input.get();
    startup.StartupInfo.hStdOutput = child_output.get();
    startup.StartupInfo.hStdError = child_errors.get();
    startup.lpAttributeList = attributes.get();
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                         CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                         variables.data(), cwd.c_str(), &startup.StartupInfo, &process)) {
        fail(ProcessErrorCode::Launch, "Cannot launch JSON worker", GetLastError());
    }
    session.process.reset(process.hProcess); session.primary_thread.reset(process.hThread);
    if (!AssignProcessToJobObject(session.job.get(), session.process.get())) {
        fail(ProcessErrorCode::Launch, "Cannot assign suspended worker to its job", GetLastError());
    }
    session.assigned = true;
    child_input.reset(); child_output.reset(); child_errors.reset();
    std::stop_callback cancellation(stop, [&] { SetEvent(session.cancel_event.get()); });
    if (stop.stop_requested()) fail(ProcessErrorCode::Cancelled, "Worker cancelled");
    session.reader = std::thread([&] { session.read_stdout(); });
    session.stderr_reader = std::thread([&] { session.read_stderr(); });
    session.writer = std::thread([&] { session.write_input(request); });
    if (stop.stop_requested()) fail(ProcessErrorCode::Cancelled, "Worker cancelled");
    if (std::chrono::steady_clock::now() >= deadline) fail(ProcessErrorCode::Timeout, "Worker timed out");
    if (ResumeThread(session.primary_thread.get()) == static_cast<DWORD>(-1)) {
        fail(ProcessErrorCode::Launch, "Cannot resume JSON worker", GetLastError());
    }
    session.primary_thread.reset();
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
    const std::array<HANDLE, 3> waits{session.process.get(), session.cancel_event.get(), session.failed_event.get()};
    const DWORD waited = remaining.count() <= 0 ? WAIT_TIMEOUT :
        WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, static_cast<DWORD>(remaining.count()));
    const DWORD wait_error = waited == WAIT_FAILED ? GetLastError() : 0;
    DWORD exit_code = STILL_ACTIVE;
    if (waited == WAIT_OBJECT_0 && !GetExitCodeProcess(session.process.get(), &exit_code)) {
        session.report_io(GetLastError());
    }
    const bool cleaned = session.cleanup();
    SecureZeroMemory(request.data(), request.size());
    for (auto& character : variables) character = 0;
    if (stop.stop_requested() || waited == WAIT_OBJECT_0 + 1) fail(ProcessErrorCode::Cancelled, "Worker cancelled");
    if (waited == WAIT_TIMEOUT) fail(ProcessErrorCode::Timeout, "Worker timed out");
    if (session.overflow) fail(ProcessErrorCode::OutputLimit, "Worker stdout exceeds 4 MiB");
    if (waited == WAIT_FAILED) fail(ProcessErrorCode::Io, "Worker wait failed", wait_error);
    if (!cleaned || session.io_error) fail(ProcessErrorCode::Io, "Worker pipe or process-tree cleanup failed", session.io_error.load());
    if (exit_code != 0) fail(ProcessErrorCode::Exit, "JSON worker exited unsuccessfully", exit_code);
    auto& response = session.response;
    if (response.empty() || response.back() != '\n' || response.find('\n') != response.size() - 1) {
        fail(ProcessErrorCode::Protocol, "Worker must return exactly one newline-terminated JSON value");
    }
    response.pop_back();
    if (!response.empty() && response.back() == '\r') response.pop_back();
    if (response.size() > json_limit) fail(ProcessErrorCode::OutputLimit, "Worker stdout exceeds 4 MiB");
    try { return Json::parse(response); }
    catch (...) { fail(ProcessErrorCode::Protocol, "Worker returned invalid JSON"); }
}

} // namespace dimension
