#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/host_exec.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cwctype>
#include <filesystem>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;

constexpr std::size_t kMaxStreamCaptureBytes = 128U * 1024U;

struct HandleGuard {
    HANDLE h = nullptr;
    explicit HandleGuard(HANDLE v = nullptr) : h(v) {}
    ~HandleGuard() {
        if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    HandleGuard(HandleGuard&& o) noexcept : h(o.h) { o.h = nullptr; }
    HandleGuard& operator=(HandleGuard&& o) noexcept {
        if (this != &o) {
            if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
            h = o.h;
            o.h = nullptr;
        }
        return *this;
    }
    HandleGuard(const HandleGuard&) = delete;
    HandleGuard& operator=(const HandleGuard&) = delete;
};

std::string lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::wstring utf8_to_wide(std::string_view s) {
    if (s.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (needed <= 0) throw std::runtime_error("命令字符串 UTF-8 编码无效");
    std::wstring out(static_cast<std::size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
    return out;
}

std::string decode_output(std::string_view bytes, bool truncated) {
    if (bytes.empty()) return {};
    UINT page = CP_UTF8;
    DWORD flags = MB_ERR_INVALID_CHARS;
    auto wide_size = [&] {
        return MultiByteToWideChar(page, flags, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    };
    int count = wide_size();
    if (!count && truncated) {
        // A full capture buffer can end partway through a UTF-8 character.
        const auto original = bytes;
        for (int tail = 1; !count && tail <= 3 && bytes.size() > 1; ++tail) {
            bytes.remove_suffix(1);
            count = wide_size();
        }
        if (!count) bytes = original;
    }
    if (!count) {
        page = GetOEMCP();
        flags = 0;
        count = wide_size();
    }
    std::wstring wide(count, L'\0');
    MultiByteToWideChar(page, flags, bytes.data(), static_cast<int>(bytes.size()), wide.data(), count);
    const int size = WideCharToMultiByte(CP_UTF8, 0, wide.data(), count, nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), count, result.data(), size, nullptr, nullptr);
    std::erase_if(result, [](unsigned char c) { return c < 32 && c != '\r' && c != '\n' && c != '\t'; });
    if (truncated) result += "\n...[输出已截断至 128 KiB]";
    return result;
}

bool contains_word_or_prefix(std::string_view low, std::string_view token) {
    std::size_t pos = 0;
    while ((pos = low.find(token, pos)) != std::string_view::npos) {
        const bool left_ok = (pos == 0) ||
            !(std::isalnum(static_cast<unsigned char>(low[pos - 1])) || low[pos - 1] == '_' || low[pos - 1] == '-');
        const std::size_t end = pos + token.size();
        const bool right_ok = (end >= low.size()) ||
            !(std::isalnum(static_cast<unsigned char>(low[end])) || low[end] == '_' || low[end] == '-');
        if (left_ok && right_ok) return true;
        pos += token.size();
    }
    return false;
}

std::vector<wchar_t> build_filtered_environment() {
    // Inherit developer toolchain variables (PATH, VC, SDK, Rust/Cargo, Go, Python, Node, User dirs)
    // while stripping any secret API key variables.
    std::vector<wchar_t> block;
    LPWCH raw = GetEnvironmentStringsW();
    if (!raw) {
        block.push_back(L'\0');
        return block;
    }
    struct EnvFree {
        LPWCH p;
        ~EnvFree() { if (p) FreeEnvironmentStringsW(p); }
    } guard{raw};

    for (const wchar_t* cur = raw; *cur != L'\0';) {
        const std::wstring entry(cur);
        cur += entry.size() + 1;
        const auto eq = entry.find(L'=');
        if (eq == 0) continue; // Skip hidden drive current-dir pseudo vars
        if (eq == std::wstring::npos) continue;
        std::wstring key_low = entry.substr(0, eq);
        for (auto& ch : key_low) ch = static_cast<wchar_t>(std::towlower(ch));
        if (key_low.find(L"api_key") != std::wstring::npos ||
            key_low.find(L"apikey") != std::wstring::npos ||
            key_low.find(L"secret") != std::wstring::npos ||
            key_low.find(L"token") != std::wstring::npos ||
            key_low.starts_with(L"dimension_session")) {
            continue;
        }
        block.insert(block.end(), entry.begin(), entry.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

std::wstring quote_powershell_encoded(std::string_view script) {
    // Wrap script with UTF-8 output encoding and pass via -EncodedCommand (UTF-16LE Base64)
    // so arbitrary quotes, newlines, and Unicode never suffer shell escaping bugs!
    std::string full = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;\n";
    full.append(script);
    const std::wstring utf16 = utf8_to_wide(full);
    const auto* bytes = reinterpret_cast<const unsigned char*>(utf16.data());
    const std::size_t len = utf16.size() * sizeof(wchar_t);

    static constexpr wchar_t kB64[] = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::wstring b64;
    b64.reserve(((len + 2) / 3) * 4);
    for (std::size_t i = 0; i < len; i += 3) {
        const unsigned int a = bytes[i];
        const unsigned int b = (i + 1 < len) ? bytes[i + 1] : 0U;
        const unsigned int c = (i + 2 < len) ? bytes[i + 2] : 0U;
        b64.push_back(kB64[a >> 2]);
        b64.push_back(kB64[((a & 3U) << 4) | (b >> 4)]);
        b64.push_back(i + 1 < len ? kB64[((b & 15U) << 2) | (c >> 6)] : L'=');
        b64.push_back(i + 2 < len ? kB64[c & 63U] : L'=');
    }
    return b64;
}

} // namespace

HostCommandRisk classify_host_command(std::string_view command,
                                      const fs::path& project_root,
                                      bool confined_to_project) {
    if (!confined_to_project || project_root.empty()) {
        return {true, "elevated_review", "当前命令未限制在绑定的项目目录内，需人工确认"};
    }
    const std::string low = lower_ascii(command);

    // 1. Destructive deletion / disk commands (use host_recycle_file for safe deletion instead)
    for (const char* danger : {
        "remove-item", "del ", "erase ", "rmdir", "rd /s", "rm -rf", "rm -r", "rm -fo",
        "format-volume", "clear-disk", "diskpart", "cipher /w", "sdelete"
    }) {
        if (low.find(danger) != std::string::npos) {
            return {true, "elevated_review", "包含文件/磁盘删除指令（建议改用进回收站的 host_recycle_file，或经人工确认后执行）"};
        }
    }

    // 2. Process termination, registry, services, startup, firewall, shutdown
    for (const char* sys_kw : {
        "stop-process", "taskkill", "reg add", "reg delete", "reg import", "regedit",
        "set-itemproperty", "remove-itemproperty", "new-itemproperty", "hklm:", "hkcu:",
        "sc.exe", "stop-service", "set-service", "new-service", "schtasks", "register-scheduledtask",
        "netsh", "bcdedit", "shutdown", "restart-computer", "stop-computer",
        "set-executionpolicy", "setx ", "[environment]::setenvironmentvariable"
    }) {
        if (low.find(sys_kw) != std::string::npos) {
            return {true, "elevated_review", "涉及系统进程、注册表、服务、计划任务或全局环境变量修改，需人工确认"};
        }
    }

    // 3. Explicit system directory references or parent-traversal escaping
    for (const char* sys_path : {
        "c:\\windows", "c:/windows", "system32", "appdata\\roaming\\microsoft\\windows\\start menu"
    }) {
        if (low.find(sys_path) != std::string::npos) {
            return {true, "elevated_review", "命令引用了系统敏感目录路径，需人工确认"};
        }
    }
    if (low.find("..\\..") != std::string::npos || low.find("../..") != std::string::npos) {
        return {true, "elevated_review", "命令包含多层上级目录跳转，需人工确认路径边界"};
    }
    if (contains_word_or_prefix(low, "winget") || contains_word_or_prefix(low, "choco") ||
        contains_word_or_prefix(low, "msiexec")) {
        return {true, "elevated_review", "涉及在宿主系统全局安装/卸载软件包，需人工确认"};
    }

    return {false, "safe_in_project", "项目目录内常规构建/脚本/查询命令，按策略免弹窗直跑"};
}

Json execute_host_command(const HostExecRequest& request, std::stop_token stop) {
    if (request.command.empty() || request.command.size() > 32768)
        throw std::runtime_error("host_exec 命令长度须在 1 到 32768 字节之间");
    if (request.cwd.empty() || !request.cwd.is_absolute() || !fs::is_directory(request.cwd))
        throw std::runtime_error("host_exec 工作目录必须是已存在的本机绝对目录");

    const int timeout_sec = std::clamp(request.timeout_seconds, 1, 600);
    wchar_t sys_dir[MAX_PATH]{};
    const UINT sys_len = GetSystemDirectoryW(sys_dir, MAX_PATH);
    if (sys_len == 0 || sys_len >= MAX_PATH)
        throw std::runtime_error("无法定位 Windows System32 目录");
    const fs::path system32(sys_dir);

    std::wstring app_path;
    std::wstring cmd_line;
    if (request.shell == "cmd") {
        app_path = (system32 / L"cmd.exe").wstring();
        cmd_line = L"\"" + app_path + L"\" /d /s /c \"" + utf8_to_wide(request.command) + L"\"";
    } else {
        app_path = (system32 / L"WindowsPowerShell\\v1.0\\powershell.exe").wstring();
        const std::wstring encoded = quote_powershell_encoded(request.command);
        cmd_line = L"\"" + app_path + L"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded;
    }

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE out_read_raw = nullptr, out_write_raw = nullptr;
    HANDLE err_read_raw = nullptr, err_write_raw = nullptr;
    HANDLE in_read_raw = nullptr, in_write_raw = nullptr;

    if (!CreatePipe(&out_read_raw, &out_write_raw, &sa, 0))
        throw std::runtime_error("无法创建标准输出管道");
    HandleGuard out_read(out_read_raw), out_write(out_write_raw);
    SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&err_read_raw, &err_write_raw, &sa, 0))
        throw std::runtime_error("无法创建标准错误管道");
    HandleGuard err_read(err_read_raw), err_write(err_write_raw);
    SetHandleInformation(err_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&in_read_raw, &in_write_raw, &sa, 0))
        throw std::runtime_error("无法创建标准输入管道");
    HandleGuard in_read(in_read_raw), in_write(in_write_raw);
    SetHandleInformation(in_write.h, HANDLE_FLAG_INHERIT, 0);
    // Close write end immediately so interactive prompts receive immediate EOF rather than hanging.
    in_write = HandleGuard{};

    HandleGuard job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) throw std::runtime_error("无法创建进程托管 JobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli)))
        throw std::runtime_error("无法配置 JobObject 进程树清理规则");

    SIZE_T attr_bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attr_bytes);
    std::vector<unsigned char> attr_storage(attr_bytes);
    auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attr_storage.data());
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attr_bytes))
        throw std::runtime_error("无法初始化命令管道");
    struct AttributeGuard {
        LPPROC_THREAD_ATTRIBUTE_LIST list;
        ~AttributeGuard() { DeleteProcThreadAttributeList(list); }
    } attr_guard{attrs};
    HANDLE inherited[]{in_read.h, out_write.h, err_write.h};
    if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                   sizeof(inherited), nullptr, nullptr))
        throw std::runtime_error("无法绑定命令管道");
    STARTUPINFOEXW startup{};
    startup.lpAttributeList = attrs;
    auto& si = startup.StartupInfo;
    si.cb = sizeof(startup);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = in_read.h;
    si.hStdOutput = out_write.h;
    si.hStdError = err_write.h;

    std::vector<wchar_t> env_block = build_filtered_environment();
    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');
    std::wstring cwd_w = fs::absolute(request.cwd).lexically_normal().wstring();

    if (request.shell == "cmd") {
        if (cwd_w.starts_with(LR"(\\?\)")) cwd_w.erase(0, 4);
        if (cwd_w.size() < 3 || cwd_w[1] != L':' || cwd_w[2] != L'\\' || cwd_w.size() >= MAX_PATH)
            throw std::runtime_error("CMD 工作目录需要使用受支持的本地盘符路径");
    }
    PROCESS_INFORMATION pi{};
    const DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP;
    if (!CreateProcessW(app_path.c_str(), mutable_cmd.data(), nullptr, nullptr, TRUE,
                        flags, env_block.data(), cwd_w.c_str(), &si, &pi)) {
        throw std::runtime_error("启动原生 Windows 子进程失败（错误码 " + std::to_string(GetLastError()) + "）");
    }
    HandleGuard proc_h(pi.hProcess), thread_h(pi.hThread);

    // Close parent's copies of child pipe handles before reading
    in_read = HandleGuard{};
    out_write = HandleGuard{};
    err_write = HandleGuard{};

    if (!AssignProcessToJobObject(job.h, proc_h.h)) {
        TerminateProcess(proc_h.h, 1);
        throw std::runtime_error("无法将子进程绑定至安全托管 JobObject");
    }
    if (stop.stop_requested()) throw std::runtime_error("命令已取消");
    if (ResumeThread(thread_h.h) == static_cast<DWORD>(-1))
        throw std::runtime_error("无法启动命令线程");

    std::string stdout_raw, stderr_raw;
    bool stdout_trunc = false, stderr_trunc = false;

    auto drain_pipe = [](HANDLE pipe, std::string& dest, bool& trunc) {
        std::array<char, 4096> buf{};
        DWORD got = 0;
        while (ReadFile(pipe, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
            if (dest.size() < kMaxStreamCaptureBytes) {
                const auto room = kMaxStreamCaptureBytes - dest.size();
                const auto take = std::min<std::size_t>(got, room);
                dest.append(buf.data(), take);
                if (take < got) trunc = true;
            } else {
                trunc = true;
            }
        }
    };

    std::thread out_reader(drain_pipe, out_read.h, std::ref(stdout_raw), std::ref(stdout_trunc));
    std::thread err_reader(drain_pipe, err_read.h, std::ref(stderr_raw), std::ref(stderr_trunc));

    const auto started = std::chrono::steady_clock::now();
    const auto deadline = started + std::chrono::seconds(timeout_sec);
    bool timed_out = false;
    bool cancelled = false;

    while (true) {
        const DWORD wait_rc = WaitForSingleObject(proc_h.h, 50);
        if (wait_rc == WAIT_OBJECT_0) break;
        if (stop.stop_requested()) {
            cancelled = true;
            TerminateJobObject(job.h, 130);
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            timed_out = true;
            TerminateJobObject(job.h, 124);
            break;
        }
    }

    // The command owns its children even if the shell exits ahead of them.
    TerminateJobObject(job.h, cancelled ? 130 : timed_out ? 124 : 0);
    WaitForSingleObject(proc_h.h, INFINITE);
    if (out_reader.joinable()) out_reader.join();
    if (err_reader.joinable()) err_reader.join();

    DWORD exit_code = 1;
    GetExitCodeProcess(proc_h.h, &exit_code);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();

    return O{
        {"ok", !cancelled && !timed_out && exit_code == 0},
        {"exitCode", static_cast<double>(exit_code)},
        {"timedOut", timed_out},
        {"cancelled", cancelled},
        {"durationMs", static_cast<double>(elapsed_ms)},
        {"stdout", decode_output(stdout_raw, stdout_trunc)},
        {"stderr", decode_output(stderr_raw, stderr_trunc)},
        {"stdoutTruncated", stdout_trunc},
        {"stderrTruncated", stderr_trunc}
    };
}

} // namespace dimension
