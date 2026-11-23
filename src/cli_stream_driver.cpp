#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/cli_stream_driver.hpp"
#include "dimension/managed_workspaces.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;

constexpr std::size_t kMaxStreamCaptureBytes = 256U * 1024U;

struct HandleGuard {
    HANDLE h = nullptr;
    explicit HandleGuard(HANDLE v = nullptr) : h(v) {}
    ~HandleGuard() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
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

std::wstring utf8_to_wide(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) throw std::runtime_error("CLI 参数 UTF-8 编码无效");
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string to_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

std::string sanitize_utf8_line(std::string_view raw) {
    std::string out;
    out.reserve(raw.size());
    std::size_t i = 0;
    while (i < raw.size()) {
        const unsigned char c = static_cast<unsigned char>(raw[i]);
        if (c < 0x80U) {
            if (c >= 0x20U || c == '\t' || c == '\n') out.push_back(static_cast<char>(c));
            ++i;
        } else if ((c & 0xE0U) == 0xC0U && i + 1 < raw.size() &&
                   (static_cast<unsigned char>(raw[i + 1]) & 0xC0U) == 0x80U) {
            out.append(raw.substr(i, 2)); i += 2;
        } else if ((c & 0xF0U) == 0xE0U && i + 2 < raw.size() &&
                   (static_cast<unsigned char>(raw[i + 1]) & 0xC0U) == 0x80U &&
                   (static_cast<unsigned char>(raw[i + 2]) & 0xC0U) == 0x80U) {
            out.append(raw.substr(i, 3)); i += 3;
        } else if ((c & 0xF8U) == 0xF0U && i + 3 < raw.size() &&
                   (static_cast<unsigned char>(raw[i + 1]) & 0xC0U) == 0x80U &&
                   (static_cast<unsigned char>(raw[i + 2]) & 0xC0U) == 0x80U &&
                   (static_cast<unsigned char>(raw[i + 3]) & 0xC0U) == 0x80U) {
            out.append(raw.substr(i, 4)); i += 4;
        } else {
            out.push_back('?'); ++i;
        }
    }
    return out;
}

std::wstring quote_win_arg(const std::wstring& arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (std::size_t i = 0;; ++i) {
        std::size_t bs = 0;
        while (i < arg.size() && arg[i] == L'\\') { ++i; ++bs; }
        if (i == arg.size()) {
            out.append(bs * 2, L'\\');
            break;
        } else if (arg[i] == L'"') {
            out.append(bs * 2 + 1, L'\\');
            out.push_back(L'"');
        } else {
            out.append(bs, L'\\');
            out.push_back(arg[i]);
        }
    }
    out.push_back(L'"');
    return out;
}

std::string wsl_path_for_workspace(const fs::path& p, const std::string& distro) {
    if (const auto key = managed_workspaces::key_from_windows(p, distro)) {
        return managed_workspaces::linux_path(*key);
    }
    const auto abs = fs::absolute(p).lexically_normal();
    const auto drive = abs.root_name().wstring();
    if (drive.size() == 2 && drive[1] == L':') {
        const char d = static_cast<char>(std::tolower(static_cast<unsigned char>(drive[0])));
        std::string rel = to_utf8(abs.relative_path());
        std::replace(rel.begin(), rel.end(), '\\', '/');
        return std::string("/mnt/") + d + "/" + rel;
    }
    throw std::runtime_error("无法将该工作区路径映射为 WSL 路径");
}

} // namespace

Json execute_cli_stream(const CliStreamRequest& request,
                        const CliStreamProgressCallback& on_progress,
                        std::stop_token stop) {
    if (request.binary.empty() || request.binary.find('\0') != std::string::npos)
        throw std::runtime_error("CLI 可执行文件路径无效");

    const int timeout_sec = std::clamp(request.timeout_seconds, 5, 1800);
    std::wstring exe_path;
    std::vector<std::wstring> argv_w;
    fs::path win_cwd;

    if (request.platform == "windows") {
        exe_path = utf8_to_wide(request.binary);
        argv_w.push_back(exe_path);
        for (const auto& a : request.base_args) argv_w.push_back(utf8_to_wide(a));
        for (const auto& a : request.task_args) argv_w.push_back(utf8_to_wide(a));
        win_cwd = request.workspace_path;
    } else {
        if (request.wsl_executable.empty() || request.sandbox_distribution.empty() ||
            !fs::is_regular_file(request.wsl_executable)) {
            throw std::runtime_error("WSL 沙盒未就绪，无法启动 Linux CLI 工位");
        }
        if (request.binary.front() != '/')
            throw std::runtime_error("Linux CLI 工位必须使用绝对路径（如 /opt/dimension-tools/bin/claude 或 /usr/bin/blender）");

        const std::string linux_ws = wsl_path_for_workspace(request.workspace_path, request.sandbox_distribution);
        exe_path = request.wsl_executable.wstring();
        argv_w = {
            exe_path,
            L"-d", utf8_to_wide(request.sandbox_distribution),
            L"-u", L"dimension",
            L"--cd", utf8_to_wide(linux_ws),
            L"--",
            L"/usr/bin/env",
            L"PATH=/opt/dimension-tools/bin:/usr/local/bin:/usr/bin:/bin"
        };
        if (!request.bot_linux_home.empty() && request.bot_linux_home.front() == '/') {
            argv_w.push_back(utf8_to_wide("HOME=" + request.bot_linux_home));
            argv_w.push_back(L"/bin/sh");
            argv_w.push_back(L"-c");
            argv_w.push_back(L"mkdir -p -m 700 \"$HOME\" 2>/dev/null || true; exec \"$@\"");
            argv_w.push_back(L"--");
        }
        argv_w.push_back(utf8_to_wide(request.binary));
        for (const auto& a : request.base_args) argv_w.push_back(utf8_to_wide(a));
        for (const auto& a : request.task_args) argv_w.push_back(utf8_to_wide(a));
        win_cwd = fs::temp_directory_path();
    }

    std::wstring cmd_line;
    for (std::size_t i = 0; i < argv_w.size(); ++i) {
        if (i > 0) cmd_line.push_back(L' ');
        cmd_line += quote_win_arg(argv_w[i]);
    }

    SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr, in_r = nullptr, in_w = nullptr;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) throw std::runtime_error("无法创建 CLI 输出管道");
    HandleGuard out_read(out_r), out_write(out_w);
    SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&err_r, &err_w, &sa, 0)) throw std::runtime_error("无法创建 CLI 错误管道");
    HandleGuard err_read(err_r), err_write(err_w);
    SetHandleInformation(err_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&in_r, &in_w, &sa, 0)) throw std::runtime_error("无法创建 CLI 输入管道");
    HandleGuard in_read(in_r), in_write(in_w);
    SetHandleInformation(in_write.h, HANDLE_FLAG_INHERIT, 0);
    in_write = HandleGuard{}; // Immediate EOF on stdin for non-interactive headless run

    HandleGuard job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) throw std::runtime_error("无法创建 CLI 进程树托管 JobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = in_read.h;
    si.hStdOutput = out_write.h;
    si.hStdError = err_write.h;

    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');
    const std::wstring cwd_w = fs::absolute(win_cwd).wstring();

    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(request.platform == "windows" ? nullptr : exe_path.c_str(),
                        mutable_cmd.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                        nullptr, cwd_w.c_str(), &si, &pi)) {
        throw std::runtime_error("无法启动外部 CLI 工位进程（错误码 " + std::to_string(GetLastError()) + "）");
    }
    HandleGuard proc_h(pi.hProcess), thread_h(pi.hThread);
    in_read = HandleGuard{};
    out_write = HandleGuard{};
    err_write = HandleGuard{};

    if (!AssignProcessToJobObject(job.h, proc_h.h)) {
        TerminateProcess(proc_h.h, 1);
        throw std::runtime_error("无法绑定 CLI 子进程至 JobObject");
    }
    ResumeThread(thread_h.h);

    const auto started = std::chrono::steady_clock::now();
    std::mutex progress_mutex;
    std::size_t line_count = 0;
    auto last_emit = started - std::chrono::seconds(1);
    std::string stdout_acc, stderr_acc;
    bool stdout_trunc = false, stderr_trunc = false;

    auto stream_pipe = [&](HANDLE pipe, std::string& acc, bool& trunc, bool emit_lines) {
        std::array<char, 4096> buf{};
        std::string pending_line;
        DWORD got = 0;
        while (ReadFile(pipe, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
            if (acc.size() < kMaxStreamCaptureBytes) {
                const auto take = std::min<std::size_t>(got, kMaxStreamCaptureBytes - acc.size());
                acc.append(buf.data(), take);
                if (take < got) trunc = true;
            } else {
                trunc = true;
            }
            if (emit_lines && on_progress) {
                pending_line.append(buf.data(), got);
                std::size_t nl = 0;
                while ((nl = pending_line.find('\n')) != std::string::npos) {
                    std::string line = pending_line.substr(0, nl);
                    if (!line.empty() && line.back() == '\r') line.pop_back();
                    pending_line.erase(0, nl + 1);
                    if (line.empty()) continue;
                    std::lock_guard lk(progress_mutex);
                    ++line_count;
                    const auto now = std::chrono::steady_clock::now();
                    // Throttle live callbacks to at most ~8 updates/sec to avoid event storm
                    if (line_count == 1 || now - last_emit >= std::chrono::milliseconds(120)) {
                        last_emit = now;
                        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - started).count();
                        try { on_progress(line_count, sanitize_utf8_line(line).substr(0, 320), elapsed); }
                        catch (...) {}
                    }
                }
                if (pending_line.size() > 8192) pending_line.erase(0, 4096);
            }
        }
    };

    std::thread out_th(stream_pipe, out_read.h, std::ref(stdout_acc), std::ref(stdout_trunc), true);
    std::thread err_th(stream_pipe, err_read.h, std::ref(stderr_acc), std::ref(stderr_trunc), false);

    const auto deadline = started + std::chrono::seconds(timeout_sec);
    bool timed_out = false, cancelled = false;
    while (true) {
        if (WaitForSingleObject(proc_h.h, 50) == WAIT_OBJECT_0) break;
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
    WaitForSingleObject(proc_h.h, 2000);
    if (out_th.joinable()) out_th.join();
    if (err_th.joinable()) err_th.join();

    DWORD exit_code = 1;
    GetExitCodeProcess(proc_h.h, &exit_code);
    const auto duration_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();

    return O{
        {"ok", !cancelled && !timed_out && exit_code == 0},
        {"profileId", request.profile_id},
        {"exitCode", static_cast<double>(exit_code)},
        {"timedOut", timed_out},
        {"cancelled", cancelled},
        {"streamedLines", static_cast<double>(line_count)},
        {"durationMs", static_cast<double>(duration_ms)},
        {"stdout", sanitize_utf8_line(stdout_acc)},
        {"stderr", sanitize_utf8_line(stderr_acc)},
        {"stdoutTruncated", stdout_trunc},
        {"stderrTruncated", stderr_trunc}
    };
}

Json probe_cli_profile(const Json& profile,
                       const fs::path& wsl_executable,
                       const std::string& sandbox_distribution) {
    const auto str_field = [&](const char* k, std::string def = {}) {
        const auto* p = profile.find(k);
        return p && p->is_string() ? p->as_string() : def;
    };
    const std::string id = str_field("id");
    const std::string bin = str_field("binary");
    const std::string platform = str_field("platform", "wsl");

    if (bin.empty()) {
        return O{{"id", id}, {"installed", false}, {"detail", "未填写可执行程序路径"}};
    }

    try {
        if (platform == "windows") {
            CliStreamRequest req;
            req.profile_id = id;
            req.binary = bin;
            req.platform = "windows";
            req.task_args = {"--version"};
            req.workspace_path = fs::temp_directory_path();
            req.timeout_seconds = 10;
            const auto res = execute_cli_stream(req);
            const bool ok = res.at("ok").as_bool();
            return O{
                {"id", id},
                {"installed", ok},
                {"versionOutput", res.at("stdout").as_string().substr(0, 200)},
                {"detail", ok ? "本机 CLI 可正常调用" : "未找到该 Windows CLI 或退出非 0"}
            };
        }

        if (wsl_executable.empty() || sandbox_distribution.empty() || !fs::is_regular_file(wsl_executable)) {
            return O{{"id", id}, {"installed", false}, {"detail", "WSL 沙盒未配置"}};
        }
        CliStreamRequest req;
        req.profile_id = id;
        req.binary = "/bin/sh";
        req.platform = "wsl";
        req.task_args = {"-c", "if [ -x '" + bin + "' ]; then '" + bin + "' --version 2>&1 | head -n 2; exit 0; else exit 127; fi"};
        req.workspace_path = fs::temp_directory_path();
        req.wsl_executable = wsl_executable;
        req.sandbox_distribution = sandbox_distribution;
        req.timeout_seconds = 12;
        const auto res = execute_cli_stream(req);
        const bool ok = res.at("ok").as_bool();
        return O{
            {"id", id},
            {"installed", ok},
            {"versionOutput", res.at("stdout").as_string().substr(0, 200)},
            {"detail", ok ? ("沙盒内已就绪：" + bin) : ("沙盒中尚未安装 " + bin + "（可安装至公共只读目录 /opt/dimension-tools/bin）")}
        };
    } catch (const std::exception& e) {
        return O{{"id", id}, {"installed", false}, {"detail", std::string(e.what())}};
    }
}

} // namespace dimension
