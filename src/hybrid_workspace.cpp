#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/hybrid_workspace.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/file_ops.hpp"
#include "dimension/managed_workspaces.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <fstream>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

constexpr std::size_t kMaxCheckoutSingleFileBytes = 10U * 1024U * 1024U; // 10 MiB
constexpr std::size_t kMaxCheckoutTotalBytes      = 128U * 1024U * 1024U; // 128 MiB
constexpr std::size_t kMaxCheckoutFileCount       = 4000U;
constexpr std::size_t kDiffPreviewBytes           = 64U * 1024U;

std::int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::wstring extended_path(const fs::path& p) {
    auto v = fs::absolute(p).lexically_normal().wstring();
    if (v.starts_with(L"\\\\?\\")) return v;
    if (v.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + v.substr(2);
    return L"\\\\?\\" + v;
}

std::string to_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

fs::path from_utf8(std::string_view s) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

std::string jstr(const Json& j, std::string_view k, std::string def = {}) {
    const auto* p = j.find(k);
    return p && p->is_string() ? p->as_string() : def;
}

bool jbool(const Json& j, std::string_view k, bool def = false) {
    const auto* p = j.find(k);
    return p && p->is_bool() ? p->as_bool() : def;
}

std::string lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

void validate_run_id(const std::string& run_id) {
    if (!std::regex_match(run_id, std::regex("[A-Za-z0-9_-]{1,128}")))
        throw std::runtime_error("无效的任务编号");
}

bool ignored_checkout_dir(std::string_view name) {
    static const std::set<std::string_view> kDirs{
        ".git", ".hg", ".svn", "node_modules", "build", "out", "dist", "target",
        ".venv", "venv", ".vs", ".idea", "__pycache__", ".next", ".nuxt", ".cache",
        "coverage", "stage-verify-tests", "webview-profile", "native-release",
        "sandbox", ".pytest_cache", ".mypy_cache", ".tox", "CMakeFiles"
    };
    return kDirs.contains(name);
}

bool ignored_checkout_file(std::string_view name) {
    const auto low = lower_ascii(name);
    for (const char* ext : {".pdb", ".obj", ".pch", ".ilk", ".ipch", ".vhdx", ".iso"}) {
        if (low.ends_with(ext)) return true;
    }
    return low == ".dimension-checkout.json" || low == "thumbs.db" || low == ".ds_store";
}

bool is_binary_bytes(std::string_view bytes) {
    const auto probe = std::min<std::size_t>(bytes.size(), 4096U);
    return std::memchr(bytes.data(), '\0', probe) != nullptr;
}

std::string normalize_lf(std::string_view bytes) {
    std::string out;
    out.reserve(bytes.size());
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        if (bytes[i] == '\r' && i + 1 < bytes.size() && bytes[i + 1] == '\n') {
            out.push_back('\n');
            ++i;
        } else {
            out.push_back(bytes[i]);
        }
    }
    return out;
}

std::string apply_eol(std::string_view bytes, std::string_view eol) {
    if (eol == "BINARY") return std::string(bytes);
    const std::string lf = normalize_lf(bytes);
    if (eol != "CRLF") return lf;
    std::string crlf;
    crlf.reserve(lf.size() + lf.size() / 16);
    for (char c : lf) {
        if (c == '\n') crlf += "\r\n";
        else crlf.push_back(c);
    }
    return crlf;
}

std::string read_all_bytes(const fs::path& p, std::size_t max_bytes) {
    const auto ext = extended_path(p);
    std::ifstream in(ext, std::ios::binary);
    if (!in) throw std::runtime_error("无法读取文件：" + to_utf8(p.filename()));
    const auto sz = fs::file_size(ext);
    if (sz > max_bytes) throw std::runtime_error("文件超过读取上限");
    std::string data(static_cast<std::size_t>(sz), '\0');
    if (sz > 0) {
        in.read(data.data(), static_cast<std::streamsize>(sz));
        if (!in) throw std::runtime_error("读取文件不完整");
    }
    return data;
}

void write_slot_file(const fs::path& target, std::string_view bytes) {
    const auto ext = extended_path(target);
    fs::create_directories(extended_path(target.parent_path()));
    std::ofstream out(ext, std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error("无法写入沙盒工位文件：" + to_utf8(target.filename()));
    if (!bytes.empty()) {
        out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        if (!out) throw std::runtime_error("写入沙盒工位文件未完成");
    }
}

bool run_wsl_root_cmd(const fs::path& wsl_exe, const std::string& distro, const std::string& sh_cmd) {
    if (wsl_exe.empty() || distro.empty() || !fs::is_regular_file(wsl_exe)) return false;
    auto to_w = [](std::string_view s) {
        int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
        std::wstring w(n > 0 ? n : 0, L'\0');
        if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
        return w;
    };
    std::wstring cmd = L"\"" + wsl_exe.wstring() + L"\" -d " + to_w(distro) +
                       L" -u root --cd / -- /bin/sh -c \"" + to_w(sh_cmd) + L"\"";
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(L'\0');

    SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE r_out = nullptr, w_out = nullptr;
    if (!CreatePipe(&r_out, &w_out, &sa, 0)) return false;
    SetHandleInformation(r_out, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = w_out;
    si.hStdError = w_out;

    PROCESS_INFORMATION pi{};
    const BOOL started = CreateProcessW(wsl_exe.c_str(), buf.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(w_out);
    if (!started) {
        CloseHandle(r_out);
        return false;
    }
    std::array<char, 1024> drain{};
    DWORD got = 0;
    while (ReadFile(r_out, drain.data(), static_cast<DWORD>(drain.size()), &got, nullptr) && got > 0) {}
    CloseHandle(r_out);
    const DWORD waited = WaitForSingleObject(pi.hProcess, 15000);
    DWORD exit_code = 1;
    if (waited == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &exit_code);
    else TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return waited == WAIT_OBJECT_0 && exit_code == 0;
}

} // namespace

HybridWorkspaceService::HybridWorkspaceService(HybridWorkspaceOptions options)
    : options_(std::move(options)) {
    fs::create_directories(extended_path(options_.state_root / L"manifests"));
    if (!options_.local_slots_override.empty()) {
        fs::create_directories(extended_path(options_.local_slots_override));
    }
}

ProjectModeDecision HybridWorkspaceService::resolve_mode(const fs::path& host_project,
                                                         std::string_view configured_mode) {
    if (configured_mode == "windows_native") {
        return {"windows_native", "已按用户设定启用「Windows 原生直改」模式", false};
    }
    if (configured_mode == "sandbox_checkout") {
        return {"sandbox_checkout", "已按用户设定启用「沙盒隔离工位」流式检入模式", false};
    }
    if (host_project.empty() || !fs::is_directory(extended_path(host_project))) {
        return {"sandbox_checkout", "默认采用「沙盒隔离工位」模式", true};
    }

    std::error_code ec;
    for (fs::directory_iterator it(extended_path(host_project), ec), end; it != end && !ec; it.increment(ec)) {
        const auto name = lower_ascii(to_utf8(it->path().filename()));
        if (name.ends_with(".sln") || name.ends_with(".vcxproj") || name.ends_with(".csproj") ||
            name.ends_with(".fsproj") || name == "directory.build.props") {
            return {"windows_native",
                    "检测到 Visual Studio / .NET 原生工程文件 (" + to_utf8(it->path().filename()) +
                    ")，自动采用「Windows 原生直改」模式以直接调用本机编译工具链",
                    true};
        }
        if (name == "cmakelists.txt" && it->is_regular_file(ec)) {
            try {
                const auto cmake_text = lower_ascii(read_all_bytes(it->path(), 128U * 1024U));
                if (cmake_text.find("webview2") != std::string::npos ||
                    cmake_text.find("winhttp") != std::string::npos ||
                    cmake_text.find("dwmapi") != std::string::npos ||
                    cmake_text.find("add_executable(") != std::string::npos && cmake_text.find("win32") != std::string::npos) {
                    return {"windows_native",
                            "检测到 CMake Win32/WebView2 原生桌面工程特征，自动采用「Windows 原生直改」模式",
                            true};
                }
            } catch (...) {}
        }
    }

    return {"sandbox_checkout",
            "自动采用「沙盒隔离工位」模式（纯源码极速检入沙盒独立槽位，原工程保持只读安全，完成后一键差异回写）",
            true};
}

fs::path HybridWorkspaceService::manifest_path(const std::string& run_id) const {
    validate_run_id(run_id);
    return options_.state_root / L"manifests" / from_utf8(run_id + ".json");
}

fs::path HybridWorkspaceService::ensure_slot_directory(const std::string& slot_key) const {
    if (!managed_workspaces::valid_key(slot_key))
        throw std::runtime_error("无效的沙盒槽位标识");
    if (!options_.local_slots_override.empty()) {
        const auto dir = options_.local_slots_override / from_utf8(slot_key);
        fs::create_directories(extended_path(dir));
        return dir;
    }
    const std::string linux_dir = managed_workspaces::linux_path(slot_key);
    const std::string cmd = "mkdir -p /var/lib/dimension/managed && rm -rf " + linux_dir +
                            " && mkdir -p " + linux_dir +
                            " && chown 1000:1002 " + linux_dir +
                            " && chmod 2775 " + linux_dir;
    if (!run_wsl_root_cmd(options_.wsl_executable, options_.sandbox_distribution, cmd)) {
        throw std::runtime_error("无法在 WSL 沙盒中初始化隔离工位目录：" + linux_dir);
    }
    return managed_workspaces::windows_path(options_.sandbox_distribution, slot_key);
}

void HybridWorkspaceService::remove_slot_directory(const std::string& slot_key,
                                                   const fs::path& slot_win_path) const {
    if (!options_.local_slots_override.empty()) {
        std::error_code ec;
        fs::remove_all(extended_path(slot_win_path), ec);
        return;
    }
    if (managed_workspaces::valid_key(slot_key) && !options_.sandbox_distribution.empty()) {
        const std::string linux_dir = managed_workspaces::linux_path(slot_key);
        (void)run_wsl_root_cmd(options_.wsl_executable, options_.sandbox_distribution,
                               "rm -rf " + linux_dir);
    }
}

Json HybridWorkspaceService::checkout(const std::string& run_id,
                                      const std::string& bot_id,
                                      const fs::path& host_project) {
    validate_run_id(run_id);
    const auto abs_host = fs::absolute(host_project).lexically_normal();
    if (!fs::is_directory(extended_path(abs_host)))
        throw std::runtime_error("待检入的 Windows 原项目目录不存在");

    std::lock_guard guard(mutex_);
    const auto mpath = manifest_path(run_id);
    if (fs::is_regular_file(extended_path(mpath))) {
        const auto existing = Json::parse(read_all_bytes(mpath, 16U * 1024U * 1024U));
        if (jstr(existing, "state") == "active") {
            return existing;
        }
    }

    const std::string slot_key = "bot-" + sha256_hex("checkout:" + run_id + ":" + bot_id).substr(0, 32);
    const fs::path slot_win = ensure_slot_directory(slot_key);
    const std::string slot_linux = options_.local_slots_override.empty()
        ? managed_workspaces::linux_path(slot_key)
        : to_utf8(slot_win);

    O files_manifest;
    std::size_t total_bytes = 0;
    std::size_t copied_files = 0;
    std::size_t skipped_large = 0;

    std::error_code ec;
    fs::recursive_directory_iterator it(extended_path(abs_host), fs::directory_options::skip_permission_denied, ec), end;
    for (; it != end; it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        const auto& p = it->path();
        const std::string fname = to_utf8(p.filename());
        if (it->is_symlink(ec)) {
            if (it->is_directory(ec)) it.disable_recursion_pending();
            continue;
        }
        if (it->is_directory(ec)) {
            if (ignored_checkout_dir(fname)) {
                it.disable_recursion_pending();
            }
            continue;
        }
        if (!it->is_regular_file(ec) || ignored_checkout_file(fname)) continue;

        const auto sz = it->file_size(ec);
        if (ec) { ec.clear(); continue; }
        if (sz > kMaxCheckoutSingleFileBytes) {
            ++skipped_large;
            continue;
        }
        if (copied_files >= kMaxCheckoutFileCount || total_bytes + sz > kMaxCheckoutTotalBytes) {
            ++skipped_large;
            continue;
        }

        const auto rel = fs::relative(p, extended_path(abs_host), ec);
        if (ec || rel.empty()) { ec.clear(); continue; }
        std::string rel_str = to_utf8(rel);
        std::replace(rel_str.begin(), rel_str.end(), '\\', '/');

        const std::string raw = read_all_bytes(p, kMaxCheckoutSingleFileBytes);
        const bool binary = is_binary_bytes(raw);
        const std::string eol = binary ? "BINARY" : (raw.find("\r\n") != std::string::npos ? "CRLF" : "LF");
        const std::string norm_sha = binary ? sha256_hex(raw) : sha256_hex(normalize_lf(raw));
        const std::string raw_sha = sha256_hex(raw);

        write_slot_file(slot_win / rel, raw);
        files_manifest[rel_str] = O{
            {"rawSha256", raw_sha},
            {"normSha256", norm_sha},
            {"size", static_cast<double>(raw.size())},
            {"eol", eol}
        };
        total_bytes += raw.size();
        ++copied_files;
    }

    if (options_.local_slots_override.empty() && !options_.sandbox_distribution.empty()) {
        // Ensure all streamed files inside WSL slot are writable by UID 1000 / GID 1002
        (void)run_wsl_root_cmd(options_.wsl_executable, options_.sandbox_distribution,
                               "chown -R 1000:1002 " + slot_linux + " && chmod -R ug+rwX " + slot_linux);
    }

    Json doc = O{
        {"version", 1},
        {"runId", run_id},
        {"botId", bot_id},
        {"state", "active"},
        {"slotKey", slot_key},
        {"hostRoot", to_utf8(abs_host)},
        {"slotWindowsPath", to_utf8(slot_win)},
        {"slotLinuxPath", slot_linux},
        {"copiedFiles", static_cast<double>(copied_files)},
        {"copiedBytes", static_cast<double>(total_bytes)},
        {"skippedLargeOrExcessFiles", static_cast<double>(skipped_large)},
        {"checkedOutAtMs", static_cast<double>(now_ms())},
        {"files", std::move(files_manifest)}
    };
    atomic_write_file(mpath, doc.dump());
    return doc;
}

bool HybridWorkspaceService::has_checkout(const std::string& run_id) const {
    std::lock_guard guard(mutex_);
    return fs::is_regular_file(extended_path(manifest_path(run_id)));
}

Json HybridWorkspaceService::status(const std::string& run_id) const {
    std::lock_guard guard(mutex_);
    const auto mpath = manifest_path(run_id);
    if (!fs::is_regular_file(extended_path(mpath))) return Json(nullptr);
    auto doc = Json::parse(read_all_bytes(mpath, 16U * 1024U * 1024U)).as_object();
    doc.erase("files"); // Keep status summary lightweight
    return doc;
}

Json HybridWorkspaceService::diff(const std::string& run_id) const {
    std::lock_guard guard(mutex_);
    const auto mpath = manifest_path(run_id);
    if (!fs::is_regular_file(extended_path(mpath)))
        throw std::runtime_error("该任务未启用沙盒检入工位");

    const auto manifest = Json::parse(read_all_bytes(mpath, 16U * 1024U * 1024U));
    const std::string state = jstr(manifest, "state");
    const fs::path host_root = from_utf8(jstr(manifest, "hostRoot"));
    const fs::path slot_win = from_utf8(jstr(manifest, "slotWindowsPath"));
    const auto baseline_files = manifest.at("files").as_object();

    if (state != "active" || !fs::is_directory(extended_path(slot_win))) {
        return O{
            {"runId", run_id},
            {"state", state},
            {"hostRoot", jstr(manifest, "hostRoot")},
            {"changes", A{}},
            {"summary", O{{"added", 0}, {"modified", 0}, {"deleted", 0}, {"conflicts", 0}}}
        };
    }

    std::map<std::string, fs::path> current_slot_files;
    std::error_code ec;
    fs::recursive_directory_iterator it(extended_path(slot_win), fs::directory_options::skip_permission_denied, ec), end;
    for (; it != end; it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        const auto& p = it->path();
        const std::string fname = to_utf8(p.filename());
        if (it->is_symlink(ec)) {
            if (it->is_directory(ec)) it.disable_recursion_pending();
            continue;
        }
        if (it->is_directory(ec)) {
            if (ignored_checkout_dir(fname)) it.disable_recursion_pending();
            continue;
        }
        if (!it->is_regular_file(ec) || ignored_checkout_file(fname)) continue;
        const auto sz = it->file_size(ec);
        if (ec || sz > kMaxCheckoutSingleFileBytes) { ec.clear(); continue; }

        const auto rel = fs::relative(p, extended_path(slot_win), ec);
        if (ec || rel.empty()) { ec.clear(); continue; }
        std::string rel_str = to_utf8(rel);
        std::replace(rel_str.begin(), rel_str.end(), '\\', '/');
        current_slot_files.emplace(std::move(rel_str), p);
    }

    A changes;
    std::size_t added_cnt = 0, mod_cnt = 0, del_cnt = 0, conflict_cnt = 0;

    // Check added & modified
    for (const auto& [rel_str, slot_file] : current_slot_files) {
        const std::string slot_bytes = read_all_bytes(slot_file, kMaxCheckoutSingleFileBytes);
        const bool slot_bin = is_binary_bytes(slot_bytes);
        const std::string slot_norm_sha = slot_bin ? sha256_hex(slot_bytes) : sha256_hex(normalize_lf(slot_bytes));

        const auto base_it = baseline_files.find(rel_str);
        const fs::path host_file = host_root / from_utf8(rel_str);
        const bool host_exists = fs::is_regular_file(extended_path(host_file), ec);

        if (base_it == baseline_files.end()) {
            ++added_cnt;
            const bool conflict = host_exists;
            if (conflict) ++conflict_cnt;
            changes.push_back(O{
                {"path", rel_str},
                {"kind", "added"},
                {"hostConflict", conflict},
                {"binary", slot_bin},
                {"beforePreview", ""},
                {"afterPreview", (!slot_bin && slot_bytes.size() <= kDiffPreviewBytes) ? normalize_lf(slot_bytes) : ""},
                {"previewOmitted", slot_bin || slot_bytes.size() > kDiffPreviewBytes},
                {"size", static_cast<double>(slot_bytes.size())}
            });
        } else {
            const std::string base_norm_sha = jstr(base_it->second, "normSha256");
            if (slot_norm_sha == base_norm_sha) continue; // Unchanged (even if CRLF<->LF changed)

            ++mod_cnt;
            std::string host_bytes;
            bool conflict = !host_exists;
            if (host_exists) {
                try {
                    host_bytes = read_all_bytes(host_file, kMaxCheckoutSingleFileBytes);
                    if (sha256_hex(host_bytes) != jstr(base_it->second, "rawSha256"))
                        conflict = true;
                } catch (...) { conflict = true; }
            }
            if (conflict) ++conflict_cnt;
            const bool any_bin = slot_bin || is_binary_bytes(host_bytes);
            const bool omit = any_bin || host_bytes.size() > kDiffPreviewBytes || slot_bytes.size() > kDiffPreviewBytes;
            changes.push_back(O{
                {"path", rel_str},
                {"kind", "modified"},
                {"hostConflict", conflict},
                {"binary", any_bin},
                {"beforePreview", omit ? "" : normalize_lf(host_bytes)},
                {"afterPreview", omit ? "" : normalize_lf(slot_bytes)},
                {"previewOmitted", omit},
                {"size", static_cast<double>(slot_bytes.size())}
            });
        }
    }

    // Check deleted
    for (const auto& [rel_str, base_meta] : baseline_files) {
        if (current_slot_files.contains(rel_str)) continue;
        ++del_cnt;
        const fs::path host_file = host_root / from_utf8(rel_str);
        bool conflict = false;
        std::string host_bytes;
        if (fs::is_regular_file(extended_path(host_file), ec)) {
            try {
                host_bytes = read_all_bytes(host_file, kMaxCheckoutSingleFileBytes);
                if (sha256_hex(host_bytes) != jstr(base_meta, "rawSha256"))
                    conflict = true;
            } catch (...) { conflict = true; }
        }
        if (conflict) ++conflict_cnt;
        const bool bin = is_binary_bytes(host_bytes);
        const bool omit = bin || host_bytes.size() > kDiffPreviewBytes;
        changes.push_back(O{
            {"path", rel_str},
            {"kind", "deleted"},
            {"hostConflict", conflict},
            {"binary", bin},
            {"beforePreview", omit ? "" : normalize_lf(host_bytes)},
            {"afterPreview", ""},
            {"previewOmitted", omit},
            {"size", 0}
        });
    }

    return O{
        {"runId", run_id},
        {"state", state},
        {"hostRoot", jstr(manifest, "hostRoot")},
        {"slotLinuxPath", jstr(manifest, "slotLinuxPath")},
        {"changes", std::move(changes)},
        {"summary", O{
            {"added", static_cast<double>(added_cnt)},
            {"modified", static_cast<double>(mod_cnt)},
            {"deleted", static_cast<double>(del_cnt)},
            {"conflicts", static_cast<double>(conflict_cnt)}
        }}
    };
}

Json HybridWorkspaceService::sync_back(const std::string& run_id,
                                       const std::vector<std::string>& only_paths,
                                       bool force_conflicts,
                                       bool cleanup_slot,
                                       const HostFileBackupHook& on_backup) {
    const Json diff_report = diff(run_id);
    const auto& changes = diff_report.at("changes").as_array();

    std::set<std::string> filter(only_paths.begin(), only_paths.end());
    for (const auto& item : changes) {
        const std::string rel = jstr(item, "path");
        if (!filter.empty() && !filter.contains(rel)) continue;
        if (jbool(item, "hostConflict") && !force_conflicts) {
            throw std::runtime_error("Windows 原目录中的文件「" + rel +
                                     "」在沙盒检入后也被外部修改过；请核对差异后勾选强制覆盖再同步");
        }
    }

    std::lock_guard guard(mutex_);
    const auto mpath = manifest_path(run_id);
    auto manifest = Json::parse(read_all_bytes(mpath, 16U * 1024U * 1024U)).as_object();
    const fs::path host_root = from_utf8(jstr(manifest, "hostRoot"));
    const fs::path slot_win = from_utf8(jstr(manifest, "slotWindowsPath"));
    const auto baseline_files = manifest.at("files").as_object();

    A synced_paths, recycled_paths;
    for (const auto& item : changes) {
        const std::string rel = jstr(item, "path");
        if (!filter.empty() && !filter.contains(rel)) continue;
        const std::string kind = jstr(item, "kind");
        const fs::path host_target = (host_root / from_utf8(rel)).lexically_normal();

        if (kind == "added" || kind == "modified") {
            const std::string slot_bytes = read_all_bytes(slot_win / from_utf8(rel), kMaxCheckoutSingleFileBytes);
            std::string target_eol = "CRLF"; // Default Windows text line-ending for newly created text files
            if (const auto bit = baseline_files.find(rel); bit != baseline_files.end()) {
                target_eol = jstr(bit->second, "eol", "CRLF");
            } else if (is_binary_bytes(slot_bytes)) {
                target_eol = "BINARY";
            }
            const std::string final_bytes = apply_eol(slot_bytes, target_eol);
            fs::create_directories(extended_path(host_target.parent_path()));
            write_file_locked(host_root, host_target, final_bytes,
                [&](std::string_view, std::string_view after) {
                    if (on_backup) on_backup(rel, host_target, after);
                });
            synced_paths.push_back(rel);
        } else if (kind == "deleted") {
            std::error_code ec;
            if (fs::exists(extended_path(host_target), ec)) {
                if (on_backup) on_backup(rel, host_target, "");
                (void)recycle_windows_path(host_target);
                recycled_paths.push_back(rel);
            }
        }
    }

    if (cleanup_slot && filter.empty()) {
        remove_slot_directory(jstr(manifest, "slotKey"), slot_win);
        manifest["state"] = "synced";
        manifest["syncedAtMs"] = static_cast<double>(now_ms());
        atomic_write_file(mpath, Json(manifest).dump());
    }

    return O{
        {"ok", true},
        {"runId", run_id},
        {"syncedCount", static_cast<double>(synced_paths.size())},
        {"recycledCount", static_cast<double>(recycled_paths.size())},
        {"syncedPaths", std::move(synced_paths)},
        {"recycledPaths", std::move(recycled_paths)},
        {"slotCleaned", cleanup_slot && filter.empty()}
    };
}

Json HybridWorkspaceService::discard(const std::string& run_id) {
    std::lock_guard guard(mutex_);
    const auto mpath = manifest_path(run_id);
    if (!fs::is_regular_file(extended_path(mpath)))
        return O{{"ok", true}, {"state", "none"}};

    auto manifest = Json::parse(read_all_bytes(mpath, 16U * 1024U * 1024U)).as_object();
    const fs::path slot_win = from_utf8(jstr(manifest, "slotWindowsPath"));
    remove_slot_directory(jstr(manifest, "slotKey"), slot_win);
    manifest["state"] = "discarded";
    manifest["discardedAtMs"] = static_cast<double>(now_ms());
    atomic_write_file(mpath, Json(manifest).dump());
    return O{{"ok", true}, {"runId", run_id}, {"state", "discarded"}};
}

Json HybridWorkspaceService::cli_profiles() const {
    std::lock_guard guard(mutex_);
    const auto path = options_.state_root / L"cli-profiles.json";
    if (!fs::is_regular_file(extended_path(path))) {
        // Built-in starter templates for external subscribed Agent CLIs & headless Blender
        return O{{"profiles", A{
            O{{"id", "claude-code"}, {"name", "Claude Code CLI (订阅工位)"}, {"binary", "/opt/dimension-tools/bin/claude"},
              {"headlessArgs", A{"-p", "--output-format", "stream-json"}}, {"isolatedBotHome", true}, {"enabled", false}},
            O{{"id", "codex-cli"}, {"name", "Codex CLI (订阅工位)"}, {"binary", "/opt/dimension-tools/bin/codex"},
              {"headlessArgs", A{"--quiet"}}, {"isolatedBotHome", true}, {"enabled", false}},
            O{{"id", "blender-headless"}, {"name", "Blender 后台脚本渲染工位"}, {"binary", "/usr/bin/blender"},
              {"headlessArgs", A{"--background", "--python"}}, {"isolatedBotHome", true}, {"enabled", false}}
        }}};
    }
    return Json::parse(read_all_bytes(path, 1024U * 1024U));
}

Json HybridWorkspaceService::save_cli_profile(const Json& profile) {
    if (!profile.is_object()) throw std::runtime_error("CLI 工位配置必须为对象");
    const std::string id = jstr(profile, "id");
    const std::string name = jstr(profile, "name");
    const std::string binary = jstr(profile, "binary");
    if (!std::regex_match(id, std::regex("[a-z0-9_-]{2,48}")) || name.empty() || binary.empty() || binary.front() != '/')
        throw std::runtime_error("CLI 工位编号、名称或 Linux 绝对可执行路径无效");

    Json current = cli_profiles();
    std::lock_guard guard(mutex_);
    A list = current.at("profiles").as_array();
    bool updated = false;
    for (auto& item : list) {
        if (jstr(item, "id") == id) {
            item = profile;
            updated = true;
            break;
        }
    }
    if (!updated) list.push_back(profile);
    Json saved = O{{"profiles", std::move(list)}};
    atomic_write_file(options_.state_root / L"cli-profiles.json", saved.dump());
    return saved;
}

} // namespace dimension
