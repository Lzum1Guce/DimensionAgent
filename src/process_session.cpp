#include "dimension/process_session.hpp"

#ifndef _WIN32
#error The persistent JSON process session requires Windows.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

namespace dimension {
namespace {

constexpr std::size_t input_limit = 1024 * 1024;
constexpr std::size_t output_limit = 8 * 1024 * 1024;
constexpr std::size_t queue_limit = 4 * 1024 * 1024;
constexpr DWORD grace_ms = 2000;
constexpr DWORD cleanup_ms = 5000;
thread_local const void* active_callback = nullptr;

class Handle final {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
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

// Normalize separators/dot segments before the extended prefix disables Win32's
// normal parsing. Use it for filesystem wrappers as well as direct Win32 calls;
// neither may rely on an executable's long-path manifest opt-in.
std::wstring win32_path(const std::filesystem::path& path) {
    auto normalized = path.lexically_normal();
    normalized.make_preferred();
    auto value = normalized.wstring();
    if (value.starts_with(L"\\\\?\\")) return value;
    if (value.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}

std::wstring process_cwd(const std::wstring& extended) {
    const auto ordinary = [](const std::wstring& value) {
        if (value.starts_with(L"\\\\?\\UNC\\")) return L"\\\\" + value.substr(8);
        if (value.starts_with(L"\\\\?\\")) return value.substr(4);
        return value;
    };
    auto cwd = ordinary(extended);
    if (cwd.size() < MAX_PATH) return cwd;
    // CreateProcessW still rejects a long lpCurrentDirectory on this platform,
    // including with extended paths and a longPathAware manifest. An existing
    // 8.3 name is the same directory, not a relocated workspace or global alias.
    const auto size = GetShortPathNameW(extended.c_str(), nullptr, 0);
    require(size > 0 && size <= 32767, "Session cwd exceeds Windows limits and has no usable short-path alias");
    std::wstring alias(size, L'\0');
    const auto copied = GetShortPathNameW(extended.c_str(), alias.data(), size);
    require(copied > 0 && copied < size, "Session cwd exceeds Windows limits and has no usable short-path alias");
    alias.resize(copied);
    std::error_code error;
    require(std::filesystem::equivalent(std::filesystem::path(extended), std::filesystem::path(alias), error) && !error,
            "Session cwd short-path identity could not be verified");
    cwd = ordinary(alias);
    require(cwd.size() < MAX_PATH, "Session cwd exceeds Windows limits and has no usable short-path alias");
    return cwd;
}

std::wstring quote_argument(const std::wstring& value) {
    require(value.find(L'\0') == std::wstring::npos, "Session arguments cannot contain NUL");
    // Quoting a simple option is legal for CRT argv but changes WSL's custom
    // option parser: "-d" can become a default-shell command instead of a flag.
    // Use the conventional minimal encoding; special argv still use the exact
    // Windows backslash/quote rules below, without involving a command shell.
    if (!value.empty() && value.find_first_of(L" \t\r\n\v\f\"") == std::wstring::npos) return value;
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const auto character : value) {
        if (character == L'\\') { ++slashes; continue; }
        if (character == L'\"') {
            result.append(slashes * 2 + 1, L'\\'); result += L'\"';
        } else { result.append(slashes, L'\\'); result += character; }
        slashes = 0;
    }
    result.append(slashes * 2, L'\\'); result += L'\"';
    return result;
}

std::wstring environment_value(const wchar_t* name) {
    const auto size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    require(size <= 32767, "Inherited session environment item is oversized");
    std::wstring value(size, L'\0');
    const auto copied = GetEnvironmentVariableW(name, value.data(), size);
    if (copied >= size) fail(ProcessErrorCode::Launch, "Session environment changed during collection");
    value.resize(copied); return value;
}

std::wstring normalize_name(std::wstring name) {
    require(!name.empty() && name.size() <= 256, "Invalid session environment name");
    for (auto& character : name) {
        require((character >= L'a' && character <= L'z') || (character >= L'A' && character <= L'Z') ||
                (character >= L'0' && character <= L'9') || character == L'_', "Invalid session environment name");
        if (character >= L'a' && character <= L'z') character -= L'a' - L'A';
    }
    return name;
}

std::filesystem::path make_cache(const std::filesystem::path& cwd) {
    static std::atomic<std::uint64_t> serial{0};
    const auto root = cwd / L".dimension-session-cache";
    std::error_code error;
    std::filesystem::create_directories(std::filesystem::path(win32_path(root)), error);
    if (error) fail(ProcessErrorCode::Launch, "Cannot create session cache", static_cast<DWORD>(error.value()));
    const auto attributes = GetFileAttributesW(win32_path(root).c_str());
    require(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT),
            "Session cache root cannot be a reparse point");
    for (int attempt = 0; attempt < 16; ++attempt) {
        const auto path = root / (std::to_wstring(GetCurrentProcessId()) + L"-" +
            std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++serial));
        if (CreateDirectoryW(win32_path(path).c_str(), nullptr)) return path;
        if (GetLastError() != ERROR_ALREADY_EXISTS) fail(ProcessErrorCode::Launch, "Cannot allocate session cache", GetLastError());
    }
    fail(ProcessErrorCode::Launch, "Cannot allocate session cache");
}

std::vector<wchar_t> environment_block(const std::filesystem::path& cache, const ProcessEnvironment& extra) {
    ProcessEnvironment variables;
    for (const auto* name : {L"SYSTEMROOT", L"WINDIR", L"PATH", L"PATHEXT"}) {
        auto value = environment_value(name);
        if (!value.empty()) variables.emplace(name, std::move(value));
    }
    if (!variables.contains(L"SYSTEMROOT")) {
        std::array<wchar_t, 32768> path{};
        const auto count = GetWindowsDirectoryW(path.data(), static_cast<UINT>(path.size()));
        if (!count || count >= path.size()) fail(ProcessErrorCode::Launch, "Cannot locate Windows runtime", GetLastError());
        variables[L"SYSTEMROOT"] = std::wstring(path.data(), count);
    }
    if (!variables.contains(L"WINDIR")) variables[L"WINDIR"] = variables.at(L"SYSTEMROOT");
    for (const auto& [name, value] : extra) {
        require(value.size() <= 32767 && value.find(L'\0') == std::wstring::npos, "Invalid session environment value");
        variables[normalize_name(name)] = value;
    }
    variables[L"TEMP"] = win32_path(cache); variables[L"TMP"] = variables[L"TEMP"];
    std::vector<wchar_t> result;
    for (const auto& [name, value] : variables) {
        require(result.size() + name.size() + value.size() + 3 <= 32767, "Session environment exceeds its limit");
        result.insert(result.end(), name.begin(), name.end()); result.push_back(L'=');
        result.insert(result.end(), value.begin(), value.end()); result.push_back(L'\0');
    }
    result.push_back(L'\0'); return result;
}

void output_pipe(Handle& reader, Handle& writer) {
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &attributes, 65536)) fail(ProcessErrorCode::Launch, "Cannot create session output pipe", GetLastError());
    reader.reset(read); writer.reset(write);
    if (!SetHandleInformation(reader.get(), HANDLE_FLAG_INHERIT, 0)) fail(ProcessErrorCode::Launch, "Cannot restrict session pipe", GetLastError());
}

// Overlapped parent writes make close interruptible even if the child never
// reads. A plain synchronous anonymous-pipe writer has a cancellation race.
void input_pipe(Handle& writer, Handle& child_reader) {
    static std::atomic<std::uint64_t> serial{0};
    const auto name = L"\\\\.\\pipe\\dimension-json-session-" + std::to_wstring(GetCurrentProcessId()) +
        L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++serial);
    writer.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr));
    if (!writer) fail(ProcessErrorCode::Launch, "Cannot create session input pipe", GetLastError());
    SECURITY_ATTRIBUTES inherited{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    child_reader.reset(CreateFileW(name.c_str(), GENERIC_READ, 0, &inherited, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS, nullptr));
    if (!child_reader) fail(ProcessErrorCode::Launch, "Cannot open session input pipe", GetLastError());
    Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!connected) fail(ProcessErrorCode::Launch, "Cannot allocate session pipe event", GetLastError());
    OVERLAPPED operation{}; operation.hEvent = connected.get();
    if (!ConnectNamedPipe(writer.get(), &operation)) {
        const auto error = GetLastError();
        if (error == ERROR_PIPE_CONNECTED) return;
        DWORD transferred = 0;
        if (error != ERROR_IO_PENDING || !GetOverlappedResult(writer.get(), &operation, &transferred, TRUE)) {
            fail(ProcessErrorCode::Launch, "Cannot connect session input pipe", error);
        }
    }
}

class AttributeList final {
public:
    AttributeList() {
        SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
        if (!bytes) fail(ProcessErrorCode::Launch, "Cannot size session launch attributes", GetLastError());
        storage_.resize(bytes); list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
        if (!InitializeProcThreadAttributeList(list_, 1, 0, &bytes)) {
            list_ = nullptr; fail(ProcessErrorCode::Launch, "Cannot initialize session launch attributes", GetLastError());
        }
    }
    ~AttributeList() { if (list_) DeleteProcThreadAttributeList(list_); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() const noexcept { return list_; }
    void handles(std::array<HANDLE, 3>& values) {
        if (!UpdateProcThreadAttribute(list_, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, values.data(), sizeof(values), nullptr, nullptr)) {
            fail(ProcessErrorCode::Launch, "Cannot restrict session inherited handles", GetLastError());
        }
    }
private:
    std::vector<std::byte> storage_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

enum class Failure { None, Protocol, OutputLimit, Io, Callback, PeerClosed, ProcessExit, Closed, Cleanup };
Json exit_event(Failure reason) {
    if (reason == Failure::None) return Json::Object{{"event", "exit"}, {"ok", true}};
    const char* code = "io_error";
    const char* message = "Session pipe operation failed";
    switch (reason) {
    case Failure::Protocol: code = "invalid_json"; message = "Worker stdout must contain newline-terminated JSON values"; break;
    case Failure::OutputLimit: code = "output_limit"; message = "Worker JSON line exceeds 8 MiB"; break;
    case Failure::Callback: code = "callback_failed"; message = "Session line callback failed"; break;
    case Failure::PeerClosed: code = "peer_closed"; message = "Worker closed its protocol before exiting"; break;
    case Failure::ProcessExit: code = "process_exit"; message = "Worker exited unsuccessfully"; break;
    case Failure::Closed: code = "closed"; message = "Session closed before worker exit"; break;
    case Failure::Cleanup: code = "cleanup_failed"; message = "Session process tree cleanup could not be confirmed"; break;
    default: break;
    }
    return Json::Object{{"event", "exit"}, {"ok", false}, {"error", Json::Object{{"code", code}, {"message", message}}}};
}

} // namespace

class JsonProcessSession::Impl final {
public:
    Impl(LineCallback callback, bool sandbox_diagnostics) : callback_(std::move(callback)), sandbox_diagnostics_(sandbox_diagnostics) {
        require(static_cast<bool>(callback_), "Session callback is required");
    }
    ~Impl() { close(); }

    void start(const std::filesystem::path& executable, const std::vector<std::wstring>& arguments,
               const std::filesystem::path& cwd, const ProcessEnvironment& environment) {
        require(executable.is_absolute() && cwd.is_absolute(), "Session executable and cwd must be absolute");
        require(executable.native().find(L'\0') == std::wstring::npos && cwd.native().find(L'\0') == std::wstring::npos,
                "Session paths cannot contain NUL");
        require(arguments.size() <= 256, "Too many session arguments");
        const auto native_executable = win32_path(executable), native_cwd = win32_path(cwd);
        std::error_code error;
        require(std::filesystem::is_regular_file(std::filesystem::path(native_executable), error) && !error, "Session executable is not a regular file");
        require(std::filesystem::is_directory(std::filesystem::path(native_cwd), error) && !error, "Session cwd is not a directory");
        const auto launch_cwd = process_cwd(native_cwd);
        std::wstring command = quote_argument(executable.wstring());
        for (const auto& argument : arguments) {
            command += L' '; command += quote_argument(argument);
            require(command.size() < 32767, "Session command line exceeds Windows limits");
        }
        require(command.size() < 32767, "Session command line exceeds Windows limits");
        auto variables = environment_block(make_cache(cwd), environment);
        job_.reset(CreateJobObjectW(nullptr, nullptr));
        completion_.reset(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
        close_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        failure_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        input_stop_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        input_done_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        output_done_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        write_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        if (!job_ || !completion_ || !close_event_ || !failure_event_ || !input_stop_ || !input_done_ || !output_done_ || !write_event_) {
            fail(ProcessErrorCode::Launch, "Cannot allocate session lifecycle resources", GetLastError());
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
            fail(ProcessErrorCode::Launch, "Cannot set session job limits", GetLastError());
        }
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT port{}; port.CompletionKey = this; port.CompletionPort = completion_.get();
        if (!SetInformationJobObject(job_.get(), JobObjectAssociateCompletionPortInformation, &port, sizeof(port))) {
            fail(ProcessErrorCode::Launch, "Cannot associate session job notifications", GetLastError());
        }
        Handle child_input, child_output, child_errors;
        input_pipe(input_, child_input); output_pipe(output_, child_output); output_pipe(errors_, child_errors);
        AttributeList attributes;
        std::array<HANDLE, 3> inherited{child_input.get(), child_output.get(), child_errors.get()}; attributes.handles(inherited);
        STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
        startup.StartupInfo.hStdInput = child_input.get(); startup.StartupInfo.hStdOutput = child_output.get();
        startup.StartupInfo.hStdError = child_errors.get(); startup.lpAttributeList = attributes.get();
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(native_executable.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            variables.data(), launch_cwd.c_str(), &startup.StartupInfo, &process)) {
            fail(ProcessErrorCode::Launch, "Cannot launch JSON session", GetLastError());
        }
        process_.reset(process.hProcess); Handle primary_thread(process.hThread);
        if (!AssignProcessToJobObject(job_.get(), process_.get())) fail(ProcessErrorCode::Launch, "Cannot assign suspended session worker", GetLastError());
        assigned_ = true;
        child_input.reset(); child_output.reset(); child_errors.reset();
        running_ = true;
        reader_ = std::thread([this] { read_stdout(); });
        stderr_reader_ = std::thread([this] { read_stderr(); });
        writer_ = std::thread([this] { write_input(); });
        supervisor_ = std::thread([this] { supervise(); });
        if (ResumeThread(primary_thread.get()) == static_cast<DWORD>(-1)) {
            report_failure(Failure::Io); fail(ProcessErrorCode::Launch, "Cannot resume JSON session", GetLastError());
        }
        primary_thread.reset();
        SecureZeroMemory(variables.data(), variables.size() * sizeof(wchar_t));
    }

    bool send(const Json& value) {
        if (!running_) return false;
        try {
            auto bytes = value.dump();
            if (bytes.size() > input_limit) return false;
            bytes += '\n';
            std::lock_guard guard(queue_mutex_);
            if (!running_ || stop_input_ || queued_bytes_ + bytes.size() > queue_limit || queue_.size() >= 128) return false;
            const auto size = bytes.size(); queue_.push_back(std::move(bytes)); queued_bytes_ += size; queue_changed_.notify_one();
            return true;
        } catch (...) { return false; }
    }

    bool running() const noexcept { return running_.load(); }
    Json final_exit() const { std::lock_guard guard(transport_exit_mutex_); return transport_exit_; }

    void close() noexcept {
        // Callback use is state publication only. A defensive close request from
        // a callback cannot join itself; destruction from callbacks is forbidden.
        if (active_callback == this) { request_close(); return; }
        std::lock_guard guard(close_mutex_);
        request_close();
        if (supervisor_.joinable()) supervisor_.join();
        else if (!cleaned_) { terminate_tree(); join_io(); release_process(); cleaned_ = true; }
        close_event_.reset(); failure_event_.reset(); input_stop_.reset(); input_done_.reset();
        output_done_.reset(); write_event_.reset();
    }

private:
    LineCallback callback_;
    bool sandbox_diagnostics_;
    std::string stderr_tail_;
    Handle job_, completion_, process_, input_, output_, errors_;
    Handle close_event_, failure_event_, input_stop_, input_done_, output_done_, write_event_;
    std::thread reader_, stderr_reader_, writer_, supervisor_;
    std::mutex queue_mutex_, close_mutex_;
    mutable std::mutex transport_exit_mutex_;
    Json transport_exit_;
    std::condition_variable queue_changed_;
    std::deque<std::string> queue_;
    std::size_t queued_bytes_ = 0;
    std::atomic_bool running_{false}, close_requested_{false}, stop_input_{false}, tearing_down_{false};
    std::atomic<Failure> failure_{Failure::None};
    bool assigned_ = false, cleaned_ = false;

    void stop_writer() noexcept {
        { std::lock_guard guard(queue_mutex_); stop_input_ = true; }
        if (input_stop_) SetEvent(input_stop_.get());
        queue_changed_.notify_all();
    }
    void request_close() noexcept {
        running_ = false; close_requested_ = true; stop_writer();
        if (close_event_) SetEvent(close_event_.get());
    }
    void report_failure(Failure reason) noexcept {
        Failure empty = Failure::None; failure_.compare_exchange_strong(empty, reason);
        running_ = false; stop_writer();
        if (failure_event_) SetEvent(failure_event_.get());
    }
    bool publish(const Json& value) noexcept {
        const auto prior = active_callback; active_callback = this;
        try { callback_(value); active_callback = prior; return true; }
        catch (...) { active_callback = prior; return false; }
    }

    void read_stdout() noexcept {
        try {
            std::array<char, 8192> buffer{};
            std::string line;
            bool done = false;
            while (!done) {
                DWORD count = 0;
                if (!ReadFile(output_.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) {
                    const auto error = GetLastError();
                    if (error != ERROR_BROKEN_PIPE && !(tearing_down_ && error == ERROR_OPERATION_ABORTED)) report_failure(Failure::Io);
                    break;
                }
                if (!count) break;
                std::size_t offset = 0;
                while (offset < count) {
                    const auto* begin = buffer.data() + offset;
                    const auto* end = buffer.data() + count;
                    const auto* newline = std::find(begin, end, '\n');
                    const auto size = static_cast<std::size_t>(newline - begin);
                    if (line.size() + size > output_limit + 1) { report_failure(Failure::OutputLimit); done = true; break; }
                    line.append(begin, size);
                    if (line.size() > output_limit && line.back() != '\r') { report_failure(Failure::OutputLimit); done = true; break; }
                    offset += size;
                    if (newline == end) break;
                    ++offset;
                    if (!line.empty() && line.back() == '\r') line.pop_back();
                    Json value;
                    try { value = Json::parse(line, output_limit); }
                    catch (...) { report_failure(Failure::Protocol); done = true; break; }
                    line.clear();
                    if (!publish(value)) { report_failure(Failure::Callback); done = true; break; }
                    if (failure_ != Failure::None) { done = true; break; }
                }
            }
            if (!line.empty() && failure_ == Failure::None) report_failure(Failure::Protocol);
        } catch (...) { report_failure(Failure::Io); }
        SetEvent(output_done_.get());
    }

    void read_stderr() noexcept {
        std::array<char, 8192> buffer{};
        for (;;) {
            DWORD count = 0;
            if (!ReadFile(errors_.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) {
                const auto error = GetLastError();
                if (error != ERROR_BROKEN_PIPE && !(tearing_down_ && error == ERROR_OPERATION_ABORTED)) report_failure(Failure::Io);
                break;
            }
            if (!count) break;
            if (sandbox_diagnostics_) {
                for (DWORD i = 0; i < count; ++i) {
                    const unsigned char ch = buffer[i];
                    if ((ch >= 32 && ch < 127) || ch == '\n') stderr_tail_.push_back(static_cast<char>(ch));
                }
                if (stderr_tail_.size() > 2048) stderr_tail_.erase(0, stderr_tail_.size() - 2048);
            }
        }
        SecureZeroMemory(buffer.data(), buffer.size());
    }

    bool write_bytes(std::string_view bytes) noexcept {
        while (!bytes.empty() && !stop_input_) {
            ResetEvent(write_event_.get());
            OVERLAPPED operation{}; operation.hEvent = write_event_.get();
            DWORD written = 0;
            const auto portion = static_cast<DWORD>(std::min<std::size_t>(bytes.size(), 65536));
            if (!WriteFile(input_.get(), bytes.data(), portion, &written, &operation)) {
                const auto error = GetLastError();
                if (error != ERROR_IO_PENDING) {
                    if (!stop_input_) report_failure(Failure::Io);
                    return false;
                }
                const std::array<HANDLE, 2> waits{input_stop_.get(), write_event_.get()};
                const auto waited = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
                if (waited != WAIT_OBJECT_0 && waited != WAIT_OBJECT_0 + 1) report_failure(Failure::Io);
                if (waited != WAIT_OBJECT_0 + 1) CancelIoEx(input_.get(), &operation);
                if (!GetOverlappedResult(input_.get(), &operation, &written, TRUE)) {
                    if (!stop_input_) report_failure(Failure::Io);
                    return false;
                }
                if (waited != WAIT_OBJECT_0 + 1 || stop_input_) return false;
            }
            if (!written) { if (!stop_input_) report_failure(Failure::Io); return false; }
            bytes.remove_prefix(written);
        }
        return bytes.empty();
    }

    void write_input() noexcept {
        try {
            for (;;) {
                std::string bytes;
                {
                    std::unique_lock guard(queue_mutex_);
                    queue_changed_.wait(guard, [this] { return stop_input_ || !queue_.empty(); });
                    if (stop_input_) break;
                    bytes = std::move(queue_.front()); queue_.pop_front();
                }
                const auto count = bytes.size();
                const bool written = write_bytes(bytes);
                SecureZeroMemory(bytes.data(), bytes.size());
                { std::lock_guard guard(queue_mutex_); queued_bytes_ -= count; }
                if (!written) break;
            }
        } catch (...) { report_failure(Failure::Io); }
        {
            std::lock_guard guard(queue_mutex_);
            for (auto& bytes : queue_) SecureZeroMemory(bytes.data(), bytes.size());
            queue_.clear(); queued_bytes_ = 0;
        }
        input_.reset(); // EOF reaches cooperative Linux helpers before job death.
        SetEvent(input_done_.get());
    }

    bool terminate_tree() noexcept {
        tearing_down_ = true;
        if (assigned_) TerminateJobObject(job_.get(), ERROR_PROCESS_ABORTED);
        else if (process_) TerminateProcess(process_.get(), ERROR_PROCESS_ABORTED);
        if (process_) WaitForSingleObject(process_.get(), cleanup_ms);
        if (!assigned_) return true;
        const auto deadline = GetTickCount64() + cleanup_ms;
        for (;;) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            if (!QueryInformationJobObject(job_.get(), JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
            if (!accounting.ActiveProcesses) return true;
            const auto now = GetTickCount64();
            if (now >= deadline) return false;
            DWORD code = 0; ULONG_PTR key = 0; LPOVERLAPPED operation = nullptr;
            GetQueuedCompletionStatus(completion_.get(), &code, &key, &operation,
                static_cast<DWORD>(std::min<ULONGLONG>(deadline - now, 100)));
        }
    }
    void join_io(bool confirmed = false) noexcept {
        stop_writer();
        if (!confirmed) {
            if (reader_.joinable()) CancelSynchronousIo(reader_.native_handle());
            if (stderr_reader_.joinable()) CancelSynchronousIo(stderr_reader_.native_handle());
        }
        if (writer_.joinable()) writer_.join();
        if (reader_.joinable()) reader_.join();
        if (stderr_reader_.joinable()) stderr_reader_.join();
    }
    void release_process() noexcept {
        input_.reset(); output_.reset(); errors_.reset(); process_.reset(); job_.reset(); completion_.reset();
    }

    void supervise() noexcept {
        const std::array<HANDLE, 4> waits{failure_event_.get(), close_event_.get(), process_.get(), output_done_.get()};
        const auto waited = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
        if (waited == WAIT_FAILED) report_failure(Failure::Io);
        running_ = false; stop_writer();
        Failure outcome = failure_.load();
        DWORD exit_code = STILL_ACTIVE;
        if (outcome == Failure::None) {
            // Overlapped cancellation lets the writer close stdin even if a peer
            // filled its pipe. Grace starts after EOF, not after an arbitrary send.
            const std::array<HANDLE, 2> input_waits{failure_event_.get(), input_done_.get()};
            const auto input_closed = WaitForMultipleObjects(2, input_waits.data(), FALSE, grace_ms);
            const std::array<HANDLE, 2> exit_waits{failure_event_.get(), process_.get()};
            const auto exited = input_closed == WAIT_OBJECT_0 + 1 ? WaitForMultipleObjects(2, exit_waits.data(), FALSE, grace_ms) : WAIT_TIMEOUT;
            if (failure_ != Failure::None) outcome = failure_.load();
            else if (exited == WAIT_OBJECT_0 + 1) {
                if (!GetExitCodeProcess(process_.get(), &exit_code)) outcome = Failure::Io;
                else if (exit_code != 0) outcome = Failure::ProcessExit;
            } else outcome = close_requested_ ? Failure::Closed : Failure::PeerClosed;
        }
        const bool confirmed = terminate_tree();
        join_io(confirmed);
        if (failure_ != Failure::None) outcome = failure_.load();
        else if (!confirmed && outcome == Failure::None) outcome = Failure::Cleanup;
        release_process(); cleaned_ = true;
        auto final_exit = exit_event(outcome);
        if (sandbox_diagnostics_ && outcome != Failure::None) {
            final_exit["stage"] = "sandbox_worker_transport";
            if (exit_code != STILL_ACTIVE) final_exit["exitCode"] = static_cast<double>(exit_code);
            if (!stderr_tail_.empty()) final_exit["stderrTail"] = stderr_tail_;
        }
        { std::lock_guard guard(transport_exit_mutex_); transport_exit_ = final_exit; }
        try { publish(final_exit); } catch (...) {}
    }
};

JsonProcessSession::JsonProcessSession(const std::filesystem::path& executable,
    const std::vector<std::wstring>& arguments, const std::filesystem::path& cwd,
    LineCallback callback, const ProcessEnvironment& environment)
    : JsonProcessSession(executable, arguments, cwd, std::move(callback), environment, false) {}

JsonProcessSession::JsonProcessSession(const std::filesystem::path& executable,
    const std::vector<std::wstring>& arguments, const std::filesystem::path& cwd,
    LineCallback callback, const ProcessEnvironment& environment, bool sandbox_diagnostics)
    : impl_(std::make_unique<Impl>(std::move(callback), sandbox_diagnostics)) {
    try { impl_->start(executable, arguments, cwd, environment); }
    catch (const ProcessError&) { throw; }
    catch (...) { fail(ProcessErrorCode::Launch, "Cannot initialize JSON session"); }
}
JsonProcessSession::~JsonProcessSession() = default;
bool JsonProcessSession::send(const Json& value) { return impl_->send(value); }
bool JsonProcessSession::running() const noexcept { return impl_->running(); }
void JsonProcessSession::close() noexcept { impl_->close(); }
Json JsonProcessSession::transport_exit() const { return impl_->final_exit(); }

} // namespace dimension
