#include "dimension/message_context.hpp"
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/work_cli_broker.hpp"
#include "dimension/cli_context_bus.hpp"
#include "dimension/network_proxy.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/managed_workspaces.hpp"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cwctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace dimension {
namespace {
std::filesystem::path runtime_directory(const std::filesystem::path& install) {
    const auto packaged = install / L"app" / L"native-runtime";
    std::error_code ec;
    return std::filesystem::is_directory(packaged, ec) ? packaged : install / L"native-runtime";
}

namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

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

std::wstring utf8_to_wide(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return {};
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string wide_to_utf8(std::wstring_view w) {
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string s(static_cast<std::size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

// Ensures subprocess stdout/stderr (which on localized Windows may emit CP_ACP / GBK bytes)
// is strictly valid UTF-8 so JSON event serialization never throws on invalid UTF-8 bytes.
std::string ensure_valid_utf8(std::string_view raw) {
    if (raw.empty()) return {};
    bool all_ascii = true;
    for (unsigned char ch : raw) {
        if (ch >= 0x80U) { all_ascii = false; break; }
    }
    if (all_ascii) return std::string(raw);
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw.data(), static_cast<int>(raw.size()), nullptr, 0) > 0) {
        return std::string(raw);
    }
    const int wn = MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(raw.size()), nullptr, 0);
    if (wn > 0) {
        std::wstring w(static_cast<std::size_t>(wn), L'\0');
        if (MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(raw.size()), w.data(), wn) > 0) {
            std::string conv = wide_to_utf8(w);
            if (!conv.empty() &&
                MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, conv.data(), static_cast<int>(conv.size()), nullptr, 0) > 0) {
                return conv;
            }
        }
    }
    // Byte-by-byte lossless UTF-8 salvage fallback
    std::string safe;
    safe.reserve(raw.size());
    std::size_t i = 0;
    while (i < raw.size()) {
        const auto b0 = static_cast<unsigned char>(raw[i]);
        if (b0 < 0x80U) {
            safe.push_back(static_cast<char>(b0));
            ++i;
            continue;
        }
        std::size_t width = 0;
        std::uint32_t cp = 0, min_cp = 0;
        if (b0 >= 0xC2U && b0 <= 0xDFU) { width = 2; cp = b0 & 0x1FU; min_cp = 0x80U; }
        else if (b0 >= 0xE0U && b0 <= 0xEFU) { width = 3; cp = b0 & 0x0FU; min_cp = 0x800U; }
        else if (b0 >= 0xF0U && b0 <= 0xF4U) { width = 4; cp = b0 & 0x07U; min_cp = 0x10000U; }
        bool ok = width > 0 && (raw.size() - i >= width);
        if (ok) {
            for (std::size_t k = 1; k < width; ++k) {
                const auto bk = static_cast<unsigned char>(raw[i + k]);
                if ((bk & 0xC0U) != 0x80U) { ok = false; break; }
                cp = (cp << 6U) | (bk & 0x3FU);
            }
            if (ok && (cp < min_cp || cp > 0x10FFFFU || (cp >= 0xD800U && cp <= 0xDFFFU))) ok = false;
        }
        if (ok) {
            safe.append(raw.substr(i, width));
            i += width;
        } else {
            safe += "\xEF\xBF\xBD";
            ++i;
        }
    }
    return safe;
}

std::string path_to_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

fs::path utf8_to_path(std::string_view s) {
    return fs::path(utf8_to_wide(s));
}

std::string ascii_lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string trim_copy(std::string_view s) {
    std::size_t b = 0, e = s.size();
    while (b < e && static_cast<unsigned char>(s[b]) <= 0x20U) ++b;
    while (e > b && static_cast<unsigned char>(s[e - 1]) <= 0x20U) --e;
    return std::string(s.substr(b, e - b));
}

std::string jstr(const Json& j, std::string_view key, std::string def = {}) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return p && p->is_string() ? p->as_string() : def;
}

double jnum(const Json& j, std::string_view key, double def = 0.0) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return p && p->is_number() ? p->as_number() : def;
}

bool jbool(const Json& j, std::string_view key, bool def = false) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return p && p->is_bool() ? p->as_bool() : def;
}

std::string safe_utf8_clip(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t end = max_bytes;
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0U) == 0x80U) --end;
    return std::string(s.substr(0, end)) + "…";
}

std::string sanitize_slug(std::string_view raw, std::size_t max_len = 48) {
    std::string out;
    out.reserve(std::min(raw.size(), max_len));
    for (unsigned char ch : raw) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            (ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
            out.push_back(static_cast<char>(ch));
        } else {
            out.push_back('-');
        }
        if (out.size() >= max_len) break;
    }
    if (out.empty()) out = "default";
    return out;
}

std::string env_var_utf8(const wchar_t* name) {
    const DWORD need = GetEnvironmentVariableW(name, nullptr, 0);
    if (need == 0) return {};
    std::wstring buf(need, L'\0');
    const DWORD got = GetEnvironmentVariableW(name, buf.data(), need);
    if (got == 0) return {};
    buf.resize(got);
    return wide_to_utf8(buf);
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

std::string find_in_windows_path(std::initializer_list<const wchar_t*> names) {
    for (const wchar_t* name : names) {
        wchar_t buf[4096]{};
        const DWORD len = SearchPathW(nullptr, name, nullptr, 4096, buf, nullptr);
        if (len > 0 && len < 4096) {
            std::error_code ec;
            if (fs::is_regular_file(buf, ec)) return wide_to_utf8(std::wstring_view(buf, len));
        }
    }
    return {};
}

std::string first_existing_file(const std::vector<fs::path>& candidates) {
    std::error_code ec;
    for (const auto& p : candidates) {
        if (!p.empty() && fs::is_regular_file(p, ec)) return path_to_utf8(fs::absolute(p, ec));
    }
    return {};
}

std::string basename_clean(std::string_view raw_path) {
    std::string s = trim_copy(raw_path);
    while (!s.empty() && (s.back() == '/' || s.back() == '\\')) s.pop_back();
    const auto pos = s.find_last_of("/\\");
    return pos == std::string::npos ? s : s.substr(pos + 1);
}

std::string extract_json_block(std::string_view text) {
    const auto first = text.find('{');
    const auto last = text.rfind('}');
    if (first != std::string_view::npos && last != std::string_view::npos && last > first) {
        return std::string(text.substr(first, last - first + 1));
    }
    return {};
}

std::string toml_escape_basic(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '\\') out += "\\\\";
        else if (c == '"') out += "\\\"";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

void copy_file_if_missing(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    if (!fs::is_regular_file(src, ec) || fs::exists(dst, ec)) return;
    fs::create_directories(dst.parent_path(), ec);
    fs::copy_file(src, dst, fs::copy_options::none, ec);
}

void copy_file_sync(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    if (!fs::is_regular_file(src, ec)) return;
    fs::create_directories(dst.parent_path(), ec);
    fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
}

std::string deterministic_uuid_from_key(std::string_view key) {
    // Stable v4-shaped identifier for session keys and CLI mapping files.
    std::uint64_t h1 = 14695981039346656037ULL;
    std::uint64_t h2 = 1099511628211ULL ^ 0x9E3779B97F4A7C15ULL;
    for (unsigned char c : key) {
        h1 ^= c;
        h1 *= 1099511628211ULL;
        h2 ^= (static_cast<std::uint64_t>(c) + 0x9e3779b9ULL + (h2 << 6) + (h2 >> 2));
    }
    char buf[40]{};
    std::snprintf(buf, sizeof(buf), "%08x-%04x-4%03x-%04x-%012llx",
                  static_cast<unsigned>(h1 >> 32),
                  static_cast<unsigned>((h1 >> 16) & 0xFFFFU),
                  static_cast<unsigned>(h1 & 0x0FFFU),
                  static_cast<unsigned>(0x8000U | ((h2 >> 48) & 0x3FFFU)),
                  static_cast<unsigned long long>(h2 & 0xFFFFFFFFFFFFULL));
    return std::string(buf);
}

struct FileSnap {
    fs::file_time_type mtime{};
    std::uintmax_t size = 0;
    std::string text_content;
    bool captured_text = false;
};

bool should_skip_walk_dir(std::string_view name) {
    const auto low = ascii_lower(name);
    return low == ".git" || low == "node_modules" || low == "__pycache__" ||
           low == ".venv" || low == "venv" || low == ".hermes" || low == ".kimi" ||
           low == ".dimension" || low == ".dimension-cli-tmp" || low == "target" ||
           low == ".next" || low == "dist-cache";
}

bool looks_like_text_file(const fs::path& p, std::uintmax_t sz) {
    if (sz > 512U * 1024U) return false;
    const auto ext = ascii_lower(path_to_utf8(p.extension()));
    static const std::set<std::string> kTextExts{
        ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
        ".json", ".md", ".txt", ".svg", ".py", ".cpp", ".hpp", ".c", ".h",
        ".rs", ".go", ".java", ".cs", ".toml", ".yaml", ".yml", ".xml",
        ".sh", ".ps1", ".cmd", ".bat", ".sql", ".vue", ".svelte"
    };
    return kTextExts.contains(ext);
}

std::string read_small_file(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    std::ostringstream oss;
    oss << in.rdbuf();
    return oss.str();
}

std::map<std::string, FileSnap> snapshot_workspace(const fs::path& root) {
    std::map<std::string, FileSnap> out;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return out;
    std::size_t count = 0;
    for (fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec), end;
         it != end && !ec; it.increment(ec)) {
        if (it->is_directory(ec)) {
            const auto dname = path_to_utf8(it->path().filename());
            if (should_skip_walk_dir(dname)) it.disable_recursion_pending();
            continue;
        }
        if (!it->is_regular_file(ec)) continue;
        const auto rel_p = it->path().lexically_relative(root);
        std::string rel = path_to_utf8(rel_p);
        std::replace(rel.begin(), rel.end(), '\\', '/');
        if (rel.empty() || rel.starts_with("..") ||
            rel.starts_with(".dimension/") || rel.starts_with(".dimension-cli-tmp/")) continue;
        FileSnap snap;
        snap.mtime = it->last_write_time(ec);
        snap.size = it->file_size(ec);
        if (looks_like_text_file(it->path(), snap.size)) {
            snap.text_content = read_small_file(it->path());
            snap.captured_text = true;
        }
        out.emplace(std::move(rel), std::move(snap));
        if (++count >= 4000) break;
    }
    return out;
}

std::vector<WorkspaceFileDelta> diff_workspace_snapshots(
    const fs::path& root,
    const std::map<std::string, FileSnap>& before) {
    std::vector<WorkspaceFileDelta> deltas;
    const auto after = snapshot_workspace(root);
    for (const auto& [rel, snap] : after) {
        const auto it = before.find(rel);
        if (it == before.end()) {
            WorkspaceFileDelta d;
            d.absolute_path = root / utf8_to_path(rel);
            d.relative_path = rel;
            d.created = true;
            d.bytes = snap.size;
            if (snap.captured_text) d.after_content = snap.text_content;
            deltas.push_back(std::move(d));
        } else if (snap.mtime != it->second.mtime || snap.size != it->second.size ||
                   (snap.captured_text && it->second.captured_text && snap.text_content != it->second.text_content)) {
            if (snap.captured_text && it->second.captured_text && snap.text_content == it->second.text_content) {
                continue;
            }
            WorkspaceFileDelta d;
            d.absolute_path = root / utf8_to_path(rel);
            d.relative_path = rel;
            d.created = false;
            d.bytes = snap.size;
            d.before_content = it->second.text_content;
            d.after_content = snap.text_content;
            deltas.push_back(std::move(d));
        }
    }
    return deltas;
}

std::wstring build_environment_block(const std::vector<std::pair<std::string, std::string>>& overrides) {
    struct CiLess {
        bool operator()(const std::wstring& a, const std::wstring& b) const {
            return _wcsicmp(a.c_str(), b.c_str()) < 0;
        }
    };
    std::map<std::wstring, std::wstring, CiLess> env_map;
    if (LPWCH raw = GetEnvironmentStringsW()) {
        const wchar_t* cur = raw;
        while (*cur) {
            const std::size_t len = std::wcslen(cur);
            if (cur[0] != L'=') {
                const wchar_t* eq = std::wcschr(cur, L'=');
                if (eq && eq > cur) {
                    env_map[std::wstring(cur, static_cast<std::size_t>(eq - cur))] = std::wstring(eq + 1);
                }
            }
            cur += len + 1;
        }
        FreeEnvironmentStringsW(raw);
    }
    for (const auto& [k, v] : overrides) {
        if (k.empty()) continue;
        const auto wk = utf8_to_wide(k);
        if ( _wcsicmp(wk.c_str(), L"PATH_PREPEND") == 0 ) {
            const auto existing = env_map.count(L"Path") ? env_map[L"Path"] : env_map[L"PATH"];
            env_map[L"PATH"] = utf8_to_wide(v) + (existing.empty() ? L"" : L";" + existing);
        } else if (v.empty() &&
                   (_wcsicmp(wk.c_str(), L"HTTP_PROXY") == 0 ||
                    _wcsicmp(wk.c_str(), L"HTTPS_PROXY") == 0 ||
                    _wcsicmp(wk.c_str(), L"ALL_PROXY") == 0 ||
                    _wcsicmp(wk.c_str(), L"NO_PROXY") == 0)) {
            // Explicitly strip inherited proxy env vars when user chose "none" or no active proxy.
            env_map.erase(wk);
        } else {
            env_map[wk] = utf8_to_wide(v);
        }
    }
    std::wstring block;
    for (const auto& [k, v] : env_map) {
        block += k;
        block.push_back(L'=');
        block += v;
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

} // namespace

Json CliNativeModelGroup::to_json() const {
    A arr;
    for (const auto& m : models) arr.push_back(m);
    return O{
        {"title", group_title},
        {"providerArg", provider_arg},
        {"models", std::move(arr)}
    };
}

Json CliHarnessDescriptor::to_json() const {
    A groups;
    for (const auto& g : native_model_groups) groups.push_back(g.to_json());
    return O{
        {"id", id},
        {"name", name},
        {"platform", platform},
        {"binaryPath", binary_path},
        {"version", version},
        {"installed", installed},
        {"supportsCustomModel", supports_custom_model},
        {"supportsSessionResume", supports_session_resume},
        {"supportsStreamJson", supports_stream_json},
        {"nativeConfigured", native_configured},
        {"nativeStatusLabel", native_status_label},
        {"nativeDefaultModel", native_default_model},
        {"nativeModelGroups", std::move(groups)},
        {"sandboxInstalled", sandbox_installed},
        {"sandboxBinaryPath", sandbox_binary_path},
        {"sandboxVersion", sandbox_version},
        {"sandboxNativeConfigured", sandbox_native_configured},
        {"hostInstalled", host_installed},
        {"hostBinaryPath", host_binary_path},
        {"hostVersion", host_version},
        {"hostNativeConfigured", host_native_configured},
        {"sandboxInstallable", sandbox_installable},
        {"sandboxInstallPackage", sandbox_install_package},
        {"executionMode", execution_mode}
    };
}

Json SandboxCliEnvironmentStatus::to_json() const {
    return O{
        {"wslAvailable", wsl_available},
        {"distroReady", distro_ready},
        {"bwrapReady", bwrap_ready},
        {"nodeReady", node_ready},
        {"npmReady", npm_ready},
        {"pythonReady", python_ready},
        {"ready", ready},
        {"nodeVersion", node_version},
        {"detail", detail}
    };
}

Json SandboxCliInstallResult::to_json() const {
    A arr;
    for (const auto& l : logs) arr.push_back(l);
    return O{
        {"ok", ok},
        {"cancelled", cancelled},
        {"exitCode", static_cast<double>(exit_code)},
        {"engineId", engine_id},
        {"version", version},
        {"binaryPath", binary_path},
        {"error", error},
        {"logs", std::move(arr)}
    };
}

Json BrokerEnrichResult::to_json() const {
    A hard;
    for (const auto& c : constraints.hard_constraints) hard.push_back(c);
    return O{
        {"greeting", greeting},
        {"enrichedPrompt", enriched_prompt},
        {"hardConstraints", std::move(hard)},
        {"usedModelEnrichment", used_model_enrichment}
    };
}

Json NormalizedCliEvent::to_json() const {
    return O{
        {"kind", kind},
        {"sessionId", session_id},
        {"text", text},
        {"toolCallId", tool_call_id},
        {"toolName", tool_name},
        {"actionCategory", action_category},
        {"displayVerb", display_verb},
        {"displayTarget", display_target},
        {"args", args_json},
        {"output", output},
        {"detectedDevUrl", detected_dev_url},
        {"durationMs", static_cast<double>(duration_ms)},
        {"isError", is_error},
        {"exitCode", static_cast<double>(exit_code)},
        {"inputTokens", static_cast<double>(input_tokens)},
        {"outputTokens", static_cast<double>(output_tokens)}
    };
}

Json CliHarnessRunResult::to_json() const {
    A files;
    for (const auto& f : file_deltas) {
        files.push_back(O{
            {"path", path_to_utf8(f.absolute_path)},
            {"relativePath", f.relative_path},
            {"created", f.created},
            {"bytes", static_cast<double>(f.bytes)}
        });
    }
    return O{
        {"success", success},
        {"cancelled", cancelled},
        {"exitCode", static_cast<double>(exit_code)},
        {"engineId", resolved_engine_id},
        {"engineName", resolved_engine_name},
        {"modelLabel", resolved_model_label},
        {"sessionId", native_session_id},
        {"response", final_response},
        {"error", error_detail},
        {"durationMs", static_cast<double>(duration_ms)},
        {"inputTokens", static_cast<double>(input_tokens)},
        {"outputTokens", static_cast<double>(output_tokens)},
        {"files", std::move(files)}
    };
}

PreservedConstraintSet extract_preserved_constraints(std::string_view raw_prompt) {
    PreservedConstraintSet out;
    const std::string text(raw_prompt);
    const std::string low = ascii_lower(text);

    auto has_any = [&](std::initializer_list<const char*> needles) {
        for (const char* n : needles) {
            if (text.find(n) != std::string::npos || low.find(n) != std::string::npos) return true;
        }
        return false;
    };

    if (has_any({"不能进行任何测试", "禁止测试", "不要测试", "不做测试", "无需测试", "不允许测试", "no test", "without test"})) {
        out.forbid_tests = true;
    }
    if (has_any({"不允许调用 skills", "不允许调用skills", "禁止调用 skills", "禁止skills", "不使用技能", "不要调用技能", "no skills"})) {
        out.forbid_skills = true;
    }
    if (has_any({"不允许网络检索", "禁止联网", "禁止网络", "不要联网", "不允许联网", "不能联网", "no network", "offline only"})) {
        out.forbid_network = true;
    }
    if (has_any({"不要调用记忆", "不调用记忆", "不要查看以前的聊天", "禁止调用记忆"})) {
        out.forbid_memory = true;
    }
    if (has_any({"单文件", "单个文件", "single html", "single-file", "一个 html 文件", "一个html文件"})) {
        out.single_file_only = true;
    }

    // Split clauses and preserve every explicit negative/boundary clause verbatim
    std::string normalized = text;
    for (const char* sep : {"。", "；", "！", "\n", ";"}) {
        std::size_t pos = 0;
        while ((pos = normalized.find(sep, pos)) != std::string::npos) {
            normalized.replace(pos, std::strlen(sep), "\n");
            pos += 1;
        }
    }
    std::istringstream iss(normalized);
    std::string line;
    std::set<std::string> seen;
    while (std::getline(iss, line)) {
        const std::string clause = trim_copy(line);
        if (clause.empty() || clause.size() > 300) continue;
        const std::string clow = ascii_lower(clause);
        if (clause.find("不能") != std::string::npos ||
            clause.find("不允许") != std::string::npos ||
            clause.find("禁止") != std::string::npos ||
            clause.find("不要") != std::string::npos ||
            clause.find("必须") != std::string::npos ||
            clause.find("只能") != std::string::npos ||
            clause.find("严禁") != std::string::npos ||
            clow.find("must not") != std::string::npos ||
            clow.find("do not") != std::string::npos) {
            if (seen.insert(clause).second) {
                out.hard_constraints.push_back(clause);
            }
        }
    }
    return out;
}

std::string scrub_speech_constraints(std::string_view text) {
    std::string s(text);
    // Remove chat-only speech length / terseness directives at clause granularity
    // so valid aesthetic traits in the same paragraph (e.g. separated by ； or 。) stay intact!
    static const std::vector<std::string> kForbiddenPhrases{
        "少说话", "少废话", "简短回复", "简短回答", "只回一两句", "每次回复不超过",
        "回复控制在", "字数控制在", "不要长篇大论", "言简意赅即可", "保持惜字如金",
        "一句话回答", "两句话以内", "三句话以内", "不得多说", "尽量少说"
    };
    for (const char* sep : {"；", "。", ";"}) {
        std::size_t pos = 0;
        const std::size_t slen = std::strlen(sep);
        while ((pos = s.find(sep, pos)) != std::string::npos) {
            s.replace(pos, slen, std::string(sep) + "\n");
            pos += slen + 1;
        }
    }
    std::istringstream iss(s);
    std::string line;
    std::string cleaned;
    while (std::getline(iss, line)) {
        const std::string trimmed = trim_copy(line);
        if (trimmed.empty()) continue;
        bool drop_clause = false;
        for (const auto& phrase : kForbiddenPhrases) {
            if (trimmed.find(phrase) != std::string::npos) {
                drop_clause = true;
                break;
            }
        }
        if (!drop_clause) {
            if (!cleaned.empty()) cleaned += " ";
            cleaned += trimmed;
        }
    }
    return trim_copy(cleaned);
}

BrokerEnrichResult enrich_prompt_with_persona(const BrokerEnrichRequest& req,
                                              const BrokerCaller& caller,
                                              std::stop_token stop) {
    BrokerEnrichResult res;
    res.constraints = extract_preserved_constraints(req.raw_user_prompt);

    const std::string clean_persona = scrub_speech_constraints(req.bot_persona);
    const std::string name_label = req.bot_name.empty() ? "专属代理人" : req.bot_name;

    auto build_locked_envelope = [&](const std::string& taste_notes) {
        std::string full = "【用户原始任务目标（核心边界，100% 严格遵守）】\n" + trim_copy(req.raw_user_prompt) + "\n";
        if (!res.constraints.hard_constraints.empty()) {
            full += "\n【不可违背硬约束（严禁突破、严禁软化）】\n";
            for (const auto& c : res.constraints.hard_constraints) {
                full += "- " + c + "\n";
            }
        }
        const std::string scrubbed_notes = scrub_speech_constraints(taste_notes);
        if (!scrubbed_notes.empty()) {
            full += "\n【由委托中间人「" + name_label + "」基于角色品味补充的实现细节（仅在不冲突的自由度内生效，不改变上述任何硬约束）】\n";
            full += scrubbed_notes + "\n";
        }
        full += "\n【执行进度播报约定】在分批执行工具的间隙，可用一两句简短自然的中文说明当前查明了什么或下一步正在改什么，无需输出多余套话。";
        return full;
    };

    res.greeting = "收到委托，我已梳理好细节要求并转交工坊引擎执行。";
    res.enriched_prompt = build_locked_envelope("");

    if (req.chat_slot_model.base_url.empty() || req.chat_slot_model.model.empty()) {
        return res;
    }

    std::string sys =
        "你是「" + name_label + "」，在维度工坊中担任用户的专属委托中间人（Broker）。\n"
        "你的人设性格与审美偏好：\n" + (clean_persona.empty() ? "专业、敏锐、注重作品质感与细节完成度。" : safe_utf8_clip(clean_persona, 1600)) + "\n";
    if (!req.bot_specialties.empty()) {
        sys += "你的专长侧重：" + safe_utf8_clip(req.bot_specialties, 400) + "\n";
    }
    sys +=
        "\n请阅读用户的任务需求，并严格输出一个 JSON 对象（不要包裹在多余解释中），格式为：\n"
        "{\"greeting\": \"你接下这份委托时对用户说的1~2句贴合你角色性格的话\", "
        "\"tasteNotes\": \"你在不越界前提下为幕后工程引擎补充的审美质感、构图光影、交互细节或代码品质建议\"}\n"
        "【死守铁律】：\n"
        "1. 严禁在 tasteNotes 中加入任何‘少说话/简短回复/限制字数/口癖’等说话约束！\n"
        "2. 严禁违背、删减或篡改用户的任何显式禁令（如禁止测试、禁止联网、禁止调用skills、单文件等）！\n"
        "3. 不得擅自把简单任务膨胀为复杂多文件架构；只在用户未锁死的审美与细节空白处注入你的独特角色品味。";

    ModelConfig fast_cfg = req.chat_slot_model;
    fast_cfg.timeout_ms = std::min(fast_cfg.timeout_ms, 25000);
    fast_cfg.max_output_tokens = std::clamp(fast_cfg.max_output_tokens, 512, 1600);
    fast_cfg.thinking_enabled = false;

    std::vector<ModelMessage> msgs{
        {"system", sys, {}, "", {}, {}},
        {"user", req.raw_user_prompt, {}, "", {}, {}}
    };

    try {
        const ModelReply reply = caller
            ? caller(fast_cfg, msgs, stop)
            : call_model(fast_cfg, msgs, {}, {}, stop);
        const std::string jblock = extract_json_block(reply.text);
        if (!jblock.empty()) {
            const auto parsed = Json::parse(jblock);
            const auto g = trim_copy(jstr(parsed, "greeting"));
            const auto notes = trim_copy(jstr(parsed, "tasteNotes"));
            if (!g.empty()) res.greeting = g;
            if (!notes.empty()) {
                res.enriched_prompt = build_locked_envelope(notes);
                res.used_model_enrichment = true;
            }
        }
    } catch (...) {
        // Graceful zero-loss fallback: keep locked user prompt intact if Chat slot is unreachable
    }
    return res;
}

std::string fast_synthesize_persona_brief(const std::string& bot_name,
                                          const std::string& bot_persona,
                                          std::string_view raw_task,
                                          const PreservedConstraintSet& constraints,
                                          std::string_view explicit_taste_notes) {
    const std::string name_label = bot_name.empty() ? "Agent" : bot_name;
    std::string full = "【用户核心需求（最高优先级，100%保留原意）】\n" + std::string(raw_task) + "\n";

    if (!constraints.hard_constraints.empty()) {
        full += "\n【不可违背硬约束（严禁突破、严禁软化）】\n";
        for (const auto& c : constraints.hard_constraints) {
            full += "- " + c + "\n";
        }
    }

    const std::string clean_notes = trim_copy(scrub_speech_constraints(explicit_taste_notes));
    if (!clean_notes.empty()) {
        full += "\n【由委托中间人「" + name_label + "」补充的角色审美与工程细节（仅在不冲突自由度内生效）】\n" + clean_notes + "\n";
    } else if (!bot_persona.empty()) {
        const std::string clean_p = trim_copy(scrub_speech_constraints(bot_persona));
        if (!clean_p.empty()) {
            full += "\n【委托中间人「" + name_label + "」的审美气质参考（仅在不违背用户硬约束的视觉/细节空白处自然体现，严禁引入任何字数或说话限制）】\n" +
                    safe_utf8_clip(clean_p, 600) + "\n";
        }
    }

    full += "\n【执行进度播报约定】在分批执行工具的间隙，可用一两句简短自然的中文说明当前查明了什么或下一步正在改什么，无需输出多余套话。";
    return full;
}

std::string extract_local_dev_url(std::string_view text) {
    if (text.empty()) return {};
    static const std::regex kDevUrlRe(
        R"((https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?:/[^\s"'<>)\]]*)?))",
        std::regex::icase);
    const std::string s(text);
    std::smatch m;
    auto search_start = s.cbegin();
    while (std::regex_search(search_start, s.cend(), m, kDevUrlRe)) {
        const std::string port = m[2].str();
        if (port != "18788") { // Never capture Dimension's own internal daemon port
            std::string url = m[1].str();
            const auto host_pos = url.find("0.0.0.0:");
            if (host_pos != std::string::npos) {
                url.replace(host_pos, 8, "localhost:");
            }
            while (!url.empty() && (url.back() == '.' || url.back() == ',' || url.back() == ';')) {
                url.pop_back();
            }
            return url;
        }
        search_start = m.suffix().first;
    }
    return {};
}

std::string compose_persona_delivery(const std::string& bot_name,
                                     const std::string& bot_persona,
                                     const std::string& user_goal,
                                     const CliHarnessRunResult& cli_result,
                                     const ModelConfig& chat_slot_model,
                                     const BrokerCaller& caller,
                                     std::stop_token stop) {
    if (!cli_result.success) {
        return cli_result.error_detail.empty() ? cli_result.final_response : cli_result.error_detail;
    }
    if (chat_slot_model.base_url.empty() || chat_slot_model.model.empty() || bot_persona.empty()) {
        return cli_result.final_response;
    }

    std::string files_summary;
    for (std::size_t i = 0; i < cli_result.file_deltas.size() && i < 12; ++i) {
        const auto& f = cli_result.file_deltas[i];
        files_summary += "- " + f.relative_path + (f.created ? " (新建, " : " (更新, ") + std::to_string(f.bytes) + " 字节)\n";
    }

    const std::string sys =
        "你是「" + (bot_name.empty() ? "委托代理人" : bot_name) + "」。你的人设：\n" +
        safe_utf8_clip(scrub_speech_constraints(bot_persona), 1400) + "\n\n"
        "底层目标模型（" + cli_result.resolved_model_label + "）刚刚通过工坊工具链完成了用户的委托。\n"
        "请用符合你自身性格与说话温度的口吻，向用户做最终交付汇报。\n"
        "【要求】：\n"
        "1. 100% 忠实保留原始报告中的所有关键文件路径、功能要点、打开/运行方式与真实核验事实，绝不编造未执行的测试；\n"
        "2. 若用户询问底层模型身份，如实保留真实大模型名称（" + cli_result.resolved_model_label + "），严禁把工具外壳（如 Hermes CLI / DSH）当成模型身份自称；\n"
        "3. 语气自然鲜活、有你自己的个性色彩，不要像冰冷的机器模板，但也不要漏掉核心交付信息。";

    const std::string usr =
        "【用户原始需求】\n" + safe_utf8_clip(user_goal, 1200) + "\n\n" +
        (files_summary.empty() ? "" : "【工作区实际产出/变更文件】\n" + files_summary + "\n") +
        "【工程引擎原始结果报告】\n" + safe_utf8_clip(cli_result.final_response, 6000);

    ModelConfig cfg = chat_slot_model;
    cfg.timeout_ms = std::min(cfg.timeout_ms, 30000);
    cfg.thinking_enabled = false;

    try {
        const ModelReply reply = caller
            ? caller(cfg, {{"system", sys, {}, "", {}, {}}, {"user", usr, {}, "", {}, {}}}, stop)
            : call_model(cfg, {{"system", sys, {}, "", {}, {}}, {"user", usr, {}, "", {}, {}}}, {}, {}, stop);
        const auto txt = trim_copy(reply.text);
        if (!txt.empty()) return txt;
    } catch (...) {}
    return cli_result.final_response;
}

namespace {

void push_unique_str(std::vector<std::string>& vec, const std::string& val) {
    const std::string t = trim_copy(val);
    if (t.empty()) return;
    if (std::find(vec.begin(), vec.end(), t) == vec.end()) vec.push_back(t);
}

std::string unquote_simple(std::string_view sv) {
    std::string s = trim_copy(sv);
    if (s.size() >= 2 && ((s.front() == '"' && s.back() == '"') || (s.front() == '\'' && s.back() == '\''))) {
        return s.substr(1, s.size() - 2);
    }
    return s;
}

std::string normalize_endpoint_url(std::string_view raw) {
    std::string s = trim_copy(raw);
    if (const auto hash = s.find('#'); hash != std::string::npos) s.erase(hash);
    s = trim_copy(s);
    while (!s.empty() && s.back() == '/') s.pop_back();
    return ascii_lower(s);
}

// Normalizes Dimension Host base_url for OpenAI-compatible CLI SDKs (Hermes, DSH, Kimi Code, Codex, OpenCode):
// 1. Strips accidental endpoint suffixes (/chat/completions, /responses, /messages) so SDKs never double-append;
// 2. Appends "/v1" when a bare origin (e.g. "https://api.deepseek.com" or "https://relay.example.com") has no path.
std::string normalize_cli_openai_base_url(std::string_view raw) {
    std::string s = trim_copy(raw);
    while (!s.empty() && s.back() == '/') s.pop_back();
    static constexpr std::string_view kEndpointSuffixes[] = {
        "/chat/completions", "/responses", "/messages"
    };
    const std::string low = ascii_lower(s);
    for (const auto suf : kEndpointSuffixes) {
        if (low.size() > suf.size() && low.ends_with(suf)) {
            s.resize(s.size() - suf.size());
            while (!s.empty() && s.back() == '/') s.pop_back();
            break;
        }
    }
    const auto scheme_pos = s.find("://");
    if (scheme_pos != std::string::npos) {
        const auto slash_after_host = s.find('/', scheme_pos + 3);
        if (slash_after_host == std::string::npos) {
            s += "/v1";
        }
    }
    return s;
}

std::string normalize_cli_anthropic_base_url(std::string_view raw) {
    std::string s = trim_copy(raw);
    while (!s.empty() && s.back() == '/') s.pop_back();
    const std::string low = ascii_lower(s);
    if (low.ends_with("/v1/messages")) {
        s.resize(s.size() - 12);
    } else if (low.ends_with("/messages")) {
        s.resize(s.size() - 9);
    }
    while (!s.empty() && s.back() == '/') s.pop_back();
    return s;
}

void maybe_prewarm_hermes_gateway(const std::string& binary_path, const fs::path& hermes_home) {
#ifdef _WIN32
    if (binary_path.empty() || hermes_home.empty()) return;
    std::error_code ec;
    const fs::path bin_p = utf8_to_path(binary_path);
    if (!fs::is_regular_file(bin_p, ec) || !fs::is_directory(hermes_home, ec)) return;
    if (!fs::is_regular_file(hermes_home / L"config.yaml", ec) &&
        !fs::is_regular_file(hermes_home / L"auth.json", ec)) {
        return;
    }

    static std::mutex prewarm_mu;
    static std::chrono::steady_clock::time_point last_attempt{};
    std::lock_guard lk(prewarm_mu);
    const auto now = std::chrono::steady_clock::now();
    if (last_attempt.time_since_epoch().count() != 0 &&
        (now - last_attempt) < std::chrono::seconds(45)) {
        return;
    }

    // Fast path (<0.1ms): check if native Hermes Gateway is already alive via gateway.pid
    const fs::path pid_file = hermes_home / L"gateway.pid";
    if (fs::is_regular_file(pid_file, ec)) {
        try {
            const auto doc = Json::parse(read_small_file(pid_file));
            const auto pid = static_cast<DWORD>(jnum(doc, "pid", 0));
            if (pid > 0) {
                HandleGuard proc(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
                if (proc.h && WaitForSingleObject(proc.h, 0) == WAIT_TIMEOUT) {
                    last_attempt = now;
                    return; // Already warm and running!
                }
            }
        } catch (...) {}
    }

    last_attempt = now;
    const std::wstring cmd_str = quote_win_arg(utf8_to_wide(binary_path)) + L" gateway run --quiet --idle-exit";
    std::vector<wchar_t> mutable_cmd(cmd_str.begin(), cmd_str.end());
    mutable_cmd.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    const std::wstring cwd_w = hermes_home.wstring();
    DWORD flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB;
    BOOL spawned = CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE,
                                  flags, nullptr, cwd_w.c_str(), &si, &pi);
    if (!spawned) {
        std::vector<wchar_t> retry_cmd(cmd_str.begin(), cmd_str.end());
        retry_cmd.push_back(L'\0');
        flags &= ~CREATE_BREAKAWAY_FROM_JOB;
        spawned = CreateProcessW(nullptr, retry_cmd.data(), nullptr, nullptr, FALSE,
                                 flags, nullptr, cwd_w.c_str(), &si, &pi);
    }
    if (spawned) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
#else
    (void)binary_path;
    (void)hermes_home;
#endif
}

void probe_hermes_native(CliHarnessDescriptor& d, const fs::path& hermes_home) {
    std::error_code ec;
    const bool has_cfg = fs::is_regular_file(hermes_home / L"config.yaml", ec);
    const bool has_auth = fs::is_regular_file(hermes_home / L"auth.json", ec) || fs::is_regular_file(hermes_home / L".env", ec);
    d.native_configured = d.installed && (has_cfg || has_auth);

    struct HermesNamedProvider {
        std::string name;
        std::string api_url_norm;
        std::vector<std::string> models;
    };
    std::vector<HermesNamedProvider> named_providers;

    auto strip_yaml_inline_comment = [](std::string s) {
        bool in_sq = false, in_dq = false;
        for (std::size_t i = 0; i < s.size(); ++i) {
            if (s[i] == '\'' && !in_dq) in_sq = !in_sq;
            else if (s[i] == '"' && !in_sq && (i == 0 || s[i - 1] != '\\')) in_dq = !in_dq;
            else if (s[i] == '#' && !in_sq && !in_dq && (i == 0 || s[i - 1] == ' ' || s[i - 1] == '\t')) {
                s.erase(i);
                break;
            }
        }
        return s;
    };

    // 1. Parse default model & named custom providers (providers.<name>) from config.yaml
    std::vector<std::string> yaml_models;
    if (has_cfg) {
        const std::string yaml = read_small_file(hermes_home / L"config.yaml");
        std::istringstream iss(yaml);
        std::string line;
        bool in_model_sec = false;
        bool in_providers_sec = false;
        int cur_prov_idx = -1;
        while (std::getline(iss, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            std::size_t indent = 0;
            while (indent < line.size() && (line[indent] == ' ' || line[indent] == '\t')) ++indent;
            const std::string t = trim_copy(line);
            if (t.empty() || t.front() == '#') continue;

            if (indent == 0) {
                in_model_sec = (t == "model:");
                in_providers_sec = (t == "providers:");
                cur_prov_idx = -1;
                continue;
            }
            if (in_providers_sec) {
                if (indent == 2 && t.back() == ':' && t.find(' ') == std::string::npos) {
                    const std::string pname = unquote_simple(t.substr(0, t.size() - 1));
                    if (!pname.empty()) {
                        named_providers.push_back(HermesNamedProvider{pname, {}, {}});
                        cur_prov_idx = static_cast<int>(named_providers.size()) - 1;
                    } else {
                        cur_prov_idx = -1;
                    }
                } else if (indent >= 4 && cur_prov_idx >= 0) {
                    auto& np = named_providers[static_cast<std::size_t>(cur_prov_idx)];
                    if (t.starts_with("api:") || t.starts_with("base_url:")) {
                        const auto colon = t.find(':');
                        const auto raw_u = unquote_simple(strip_yaml_inline_comment(t.substr(colon + 1)));
                        if (!raw_u.empty()) np.api_url_norm = normalize_endpoint_url(raw_u);
                    } else if (t.starts_with("default_model:") || t.starts_with("model:")) {
                        const auto colon = t.find(':');
                        const auto m = unquote_simple(strip_yaml_inline_comment(t.substr(colon + 1)));
                        if (!m.empty()) push_unique_str(np.models, m);
                    }
                }
                continue;
            }
            if (in_model_sec && t.starts_with("default:")) {
                const auto def_m = unquote_simple(strip_yaml_inline_comment(t.substr(8)));
                if (!def_m.empty()) {
                    if (d.native_default_model.empty()) d.native_default_model = def_m;
                    push_unique_str(yaml_models, def_m);
                }
            } else if (t.starts_with("model:")) {
                const auto m = unquote_simple(strip_yaml_inline_comment(t.substr(6)));
                const auto m_low = ascii_lower(m);
                const bool is_audio_or_embed =
                    m_low.empty() || m_low == "base" || m_low == "tiny" || m_low == "small" ||
                    m_low == "medium" || m_low == "large" || m_low.starts_with("large-") ||
                    m_low.find("whisper") != std::string::npos || m_low.find("tts") != std::string::npos ||
                    m_low.find("embed") != std::string::npos || m_low.find("rerank") != std::string::npos ||
                    m_low.find("silero") != std::string::npos;
                if (!is_audio_or_embed) push_unique_str(yaml_models, m);
            }
        }
    }

    auto make_upper = [](std::string s) {
        for (char& ch : s) {
            if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
        }
        return s;
    };

    auto upsert_group = [&](const std::string& title, const std::string& prov_arg, const std::vector<std::string>& models) {
        if (models.empty()) return;
        for (auto& existing : d.native_model_groups) {
            if (existing.group_title == title || (!prov_arg.empty() && existing.provider_arg == prov_arg)) {
                if (existing.provider_arg.empty() && !prov_arg.empty()) existing.provider_arg = prov_arg;
                for (const auto& m : models) push_unique_str(existing.models, m);
                return;
            }
        }
        CliNativeModelGroup grp;
        grp.group_title = title;
        grp.provider_arg = prov_arg;
        for (const auto& m : models) push_unique_str(grp.models, m);
        d.native_model_groups.push_back(std::move(grp));
    };

    // Pre-seed named custom providers declared in config.yaml so their provider_arg & default_model always win
    for (const auto& np : named_providers) {
        const std::string low_name = ascii_lower(np.name);
        const std::string title = (low_name == "kimi-coding-plan" || np.api_url_norm.find("kimi.com") != std::string::npos)
            ? "KIMI CODING PLAN"
            : ("CUSTOM · " + make_upper(np.name));
        upsert_group(title, np.name, np.models);
    }

    // 2. Parse cached provider model catalogs from provider_models_cache.json
    const fs::path cache_p = hermes_home / L"provider_models_cache.json";
    if (fs::is_regular_file(cache_p, ec)) {
        try {
            const auto root = Json::parse(read_small_file(cache_p));
            if (root.is_object()) {
                for (const auto& [raw_key, entry] : root.as_object()) {
                    if (!entry.is_object()) continue;
                    const auto* m_arr = entry.find("models");
                    if (!m_arr || !m_arr->is_array() || m_arr->as_array().empty()) continue;

                    std::vector<std::string> cached_list;
                    for (const auto& item : m_arr->as_array()) {
                        if (item.is_string()) push_unique_str(cached_list, item.as_string());
                    }
                    if (cached_list.empty()) continue;

                    if (raw_key.starts_with("custom:http")) {
                        std::string clean_url = raw_key.substr(7);
                        if (const auto hash = clean_url.find('#'); hash != std::string::npos) clean_url.erase(hash);
                        const std::string norm_u = normalize_endpoint_url(clean_url);

                        const HermesNamedProvider* matched_np = nullptr;
                        for (const auto& np : named_providers) {
                            if (!np.api_url_norm.empty() && np.api_url_norm == norm_u) {
                                matched_np = &np;
                                break;
                            }
                        }

                        if (matched_np) {
                            const std::string low_name = ascii_lower(matched_np->name);
                            const std::string title = (low_name == "kimi-coding-plan" || norm_u.find("kimi.com") != std::string::npos)
                                ? "KIMI CODING PLAN"
                                : ("CUSTOM · " + make_upper(matched_np->name));
                            std::vector<std::string> merged = matched_np->models;
                            for (const auto& cm : cached_list) push_unique_str(merged, cm);
                            upsert_group(title, matched_np->name, merged);
                        } else {
                            std::string host = clean_url;
                            if (const auto sl = host.find("://"); sl != std::string::npos) host = host.substr(sl + 3);
                            if (const auto pth = host.find('/'); pth != std::string::npos) host.erase(pth);
                            const std::string title = (norm_u.find("kimi.com") != std::string::npos)
                                ? "KIMI CODING PLAN"
                                : ("CUSTOM · " + host);
                            upsert_group(title, "", cached_list);
                        }
                    } else {
                        upsert_group(make_upper(raw_key), raw_key, cached_list);
                    }
                }
            }
        } catch (...) {}
    }

    if (!yaml_models.empty()) {
        std::vector<std::string> uncovered;
        for (const auto& ym : yaml_models) {
            bool found = false;
            for (const auto& g : d.native_model_groups) {
                if (std::find(g.models.begin(), g.models.end(), ym) != g.models.end()) { found = true; break; }
            }
            if (!found) push_unique_str(uncovered, ym);
        }
        if (!uncovered.empty()) {
            d.native_model_groups.insert(d.native_model_groups.begin(), CliNativeModelGroup{"本机配置模型", "", std::move(uncovered)});
        }
    }

    if (d.native_model_groups.empty()) {
        d.native_model_groups.push_back({"HERMES 原生推荐", "", {"k3.1-pro", "deepseek-v4-pro", "claude-sonnet-4-6", "gpt-5.3-codex"}});
    }
    d.native_status_label = d.native_configured
        ? (d.native_default_model.empty() ? "原生配置已就绪" : ("默认 " + d.native_default_model))
        : (d.installed ? "已安装" : "未安装");
}

void probe_kimi_code_native(CliHarnessDescriptor& d, const fs::path& kimi_home) {
    std::error_code ec;
    const fs::path toml_p = kimi_home / L"config.toml";
    const bool has_toml = fs::is_regular_file(toml_p, ec);
    const bool has_cred = fs::is_regular_file(kimi_home / L"credentials.json", ec) || fs::is_regular_file(kimi_home / L"device_id", ec);
    d.native_configured = d.installed && (has_toml || has_cred);

    std::vector<std::string> configured_models;
    if (has_toml) {
        const std::string content = read_small_file(toml_p);
        std::istringstream iss(content);
        std::string line;
        while (std::getline(iss, line)) {
            const std::string t = trim_copy(line);
            if (t.empty() || t.front() == '#') continue;
            if (t.starts_with("default_model")) {
                const auto eq = t.find('=');
                if (eq != std::string::npos) {
                    const auto dm = unquote_simple(t.substr(eq + 1));
                    if (!dm.empty() && !dm.starts_with("dimension_work/")) d.native_default_model = dm;
                }
            } else if (t.starts_with("[models.") && t.back() == ']') {
                std::string key = unquote_simple(t.substr(8, t.size() - 9));
                if (!key.empty() && !key.starts_with("dimension_work/")) {
                    push_unique_str(configured_models, key);
                }
            }
        }
    }

    if (!configured_models.empty()) {
        d.native_model_groups.push_back({"本机已配置模型", "", std::move(configured_models)});
    }
    d.native_model_groups.push_back({
        "KIMI CODING 订阅模型", "",
        {"kimi-for-coding", "kimi-for-coding-highspeed", "kimi-k3", "kimi-k2.5"}
    });
    d.native_status_label = d.native_configured
        ? (d.native_default_model.empty() ? "原生订阅已就绪" : ("默认 " + d.native_default_model))
        : (d.installed ? "运行 kimi login 登录" : "未安装");
}

void probe_codex_native(CliHarnessDescriptor& d, const fs::path& codex_home) {
    std::error_code ec;
    const fs::path toml_p = codex_home / L"config.toml";
    const bool has_cfg = fs::is_regular_file(toml_p, ec) || fs::is_regular_file(codex_home / L"auth.json", ec);
    d.native_configured = d.installed && has_cfg;

    if (fs::is_regular_file(toml_p, ec)) {
        std::istringstream iss(read_small_file(toml_p));
        std::string line;
        while (std::getline(iss, line)) {
            const std::string t = trim_copy(line);
            if (t.starts_with('[')) break; // Stop at first section table
            if (t.starts_with("model ") || t.starts_with("model=")) {
                const auto eq = t.find('=');
                if (eq != std::string::npos) d.native_default_model = unquote_simple(t.substr(eq + 1));
            }
        }
    }

    std::vector<std::string> cached_models;
    if (!d.native_default_model.empty()) push_unique_str(cached_models, d.native_default_model);
    const fs::path cache_p = codex_home / L"models_cache.json";
    if (fs::is_regular_file(cache_p, ec)) {
        try {
            const auto doc = Json::parse(read_small_file(cache_p));
            if (const auto* arr = doc.find("models"); arr && arr->is_array()) {
                for (const auto& m : arr->as_array()) {
                    if (m.is_object()) push_unique_str(cached_models, jstr(m, "slug"));
                }
            }
        } catch (...) {}
    }
    if (cached_models.empty()) {
        cached_models = {"gpt-5.3-codex", "o3", "o4-mini", "gpt-5"};
    }
    d.native_model_groups.push_back({"CODEX 原生模型", "", std::move(cached_models)});
    d.native_status_label = d.native_configured
        ? (d.native_default_model.empty() ? "原生配置已就绪" : ("默认 " + d.native_default_model))
        : (d.installed ? "已安装" : "未安装");
}

std::string yaml_double_quote(std::string_view sv) {
    std::string out = "\"";
    out.reserve(sv.size() + 4);
    for (char c : sv) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"':  out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:   out.push_back(c); break;
        }
    }
    out.push_back('"');
    return out;
}

std::string query_reg_sz(HKEY key, const wchar_t* value_name) {
    DWORD type = 0;
    DWORD bytes = 0;
    if (RegQueryValueExW(key, value_name, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS ||
        (type != REG_SZ && type != REG_EXPAND_SZ) || bytes < sizeof(wchar_t)) {
        return {};
    }
    std::wstring buf(bytes / sizeof(wchar_t), L'\0');
    if (RegQueryValueExW(key, value_name, nullptr, &type, reinterpret_cast<LPBYTE>(buf.data()), &bytes) != ERROR_SUCCESS) {
        return {};
    }
    while (!buf.empty() && buf.back() == L'\0') buf.pop_back();
    return wide_to_utf8(buf);
}

std::string find_dsh_cli_from_registry() {
    const HKEY kRoots[] = {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    static constexpr const wchar_t* kSubKeys[] = {
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        L"Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
    };
    std::error_code ec;
    for (HKEY root : kRoots) {
        for (const wchar_t* sub_path : kSubKeys) {
            HKEY uninstall_key = nullptr;
            if (RegOpenKeyExW(root, sub_path, 0, KEY_READ, &uninstall_key) != ERROR_SUCCESS) continue;
            wchar_t child_name[256];
            for (DWORD idx = 0;; ++idx) {
                DWORD name_len = 256;
                if (RegEnumKeyExW(uninstall_key, idx, child_name, &name_len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) {
                    break;
                }
                HKEY item_key = nullptr;
                if (RegOpenKeyExW(uninstall_key, child_name, 0, KEY_READ, &item_key) != ERROR_SUCCESS) continue;
                const std::string disp = ascii_lower(query_reg_sz(item_key, L"DisplayName"));
                std::string install_loc = trim_copy(query_reg_sz(item_key, L"InstallLocation"));
                const std::string uninst = trim_copy(query_reg_sz(item_key, L"UninstallString"));
                RegCloseKey(item_key);

                if (disp.find("deepseek harness") == std::string::npos && disp.find("dsh") == std::string::npos) {
                    continue;
                }
                std::vector<fs::path> candidate_roots;
                if (!install_loc.empty()) {
                    candidate_roots.push_back(utf8_to_path(unquote_simple(install_loc)));
                }
                if (!uninst.empty()) {
                    std::string exe_part = uninst;
                    if (!exe_part.empty() && exe_part.front() == '"') {
                        const auto close_q = exe_part.find('"', 1);
                        if (close_q != std::string::npos) exe_part = exe_part.substr(1, close_q - 1);
                    }
                    const fs::path up = utf8_to_path(exe_part).parent_path();
                    if (!up.empty()) candidate_roots.push_back(up);
                }
                for (const auto& r : candidate_roots) {
                    const fs::path cli_cmd = r / L"resources" / L"runtime" / L"cli" / L"bin" / L"dsh.cmd";
                    if (fs::is_regular_file(cli_cmd, ec)) {
                        RegCloseKey(uninstall_key);
                        return path_to_utf8(fs::absolute(cli_cmd, ec));
                    }
                }
            }
            RegCloseKey(uninstall_key);
        }
    }
    return {};
}

void probe_deepseek_harness_native(CliHarnessDescriptor& d, const fs::path& dsh_home) {
    std::error_code ec;
    const fs::path cred_p = dsh_home / L".credentials.yaml";
    const bool has_cred = fs::is_regular_file(cred_p, ec) && fs::file_size(cred_p, ec) > 16;
    d.native_configured = d.installed && has_cred;

    // Parse default model from desktop profile cordis.patch.yml if present
    const fs::path patch_p = dsh_home / L"profiles" / L"desktop" / L"cordis.patch.yml";
    if (fs::is_regular_file(patch_p, ec)) {
        std::istringstream iss(read_small_file(patch_p));
        std::string line;
        bool in_default_model = false;
        while (std::getline(iss, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            const std::string t = trim_copy(line);
            if (t.empty() || t.front() == '#') continue;
            if (t.starts_with("- id:")) {
                in_default_model = (t.find("agent-default-model") != std::string::npos);
            } else if (in_default_model && t.starts_with("model:")) {
                auto val = t.substr(6);
                if (const auto hash = val.find('#'); hash != std::string::npos) val.erase(hash);
                const auto dm = unquote_simple(val);
                if (!dm.empty() && d.native_default_model.empty()) d.native_default_model = dm;
            }
        }
    }
    if (d.native_default_model.empty() && d.native_configured) {
        d.native_default_model = "deepseek-flash";
    }

    std::vector<std::string> account_models = {"deepseek-flash", "deepseek-v4-pro"};
    if (!d.native_default_model.empty()) {
        push_unique_str(account_models, d.native_default_model);
    }
    d.native_model_groups.push_back({"DEEPSEEK 账号订阅", "", std::move(account_models)});
    d.native_status_label = d.native_configured
        ? ("已登录 DeepSeek · 默认 " + d.native_default_model)
        : (d.installed ? "在 DeepSeek Harness 登录账号后可用" : "未安装");
}

std::vector<std::string> probe_antigravity_cli_models(const std::string& binary_path) {
    std::vector<std::string> found;
    if (binary_path.empty()) return found;
    const std::wstring bin_w = utf8_to_wide(binary_path);
    const bool is_cmd = ascii_lower(binary_path).ends_with(".cmd") || ascii_lower(binary_path).ends_with(".bat");
    std::wstring cmd_line = is_cmd
        ? (L"cmd.exe /d /s /c \"" + quote_win_arg(bin_w) + L" models\"")
        : (quote_win_arg(bin_w) + L" models");

    SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE out_r = nullptr, out_w = nullptr;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) return found;
    HandleGuard out_read(out_r), out_write(out_w);
    SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = out_write.h;
    si.hStdError = out_write.h;

    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');
    const auto proxy_overrides = build_host_proxy_env_overrides();
    std::wstring env_block;
    LPVOID env_ptr = nullptr;
    DWORD create_flags = CREATE_NO_WINDOW;
    if (!proxy_overrides.empty()) {
        env_block = build_environment_block(proxy_overrides);
        if (!env_block.empty()) {
            env_ptr = env_block.data();
            create_flags |= CREATE_UNICODE_ENVIRONMENT;
        }
    }
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                        create_flags, env_ptr, nullptr, &si, &pi)) {
        return found;
    }
    HandleGuard proc_h(pi.hProcess), thread_h(pi.hThread);
    out_write = HandleGuard{};

    // Do not wait for pipe EOF: a CLI launcher may hand its pipe to another process.
    std::string raw;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(6);
    for (;;) {
        const bool done = WaitForSingleObject(proc_h.h, 20) == WAIT_OBJECT_0;
        DWORD available = 0;
        if (PeekNamedPipe(out_read.h, nullptr, 0, nullptr, &available, nullptr) && available) {
            char buf[8192];
            DWORD n = 0;
            if (ReadFile(out_read.h, buf, std::min<DWORD>(available, sizeof(buf)), &n, nullptr)) {
                raw.append(buf, std::min<std::size_t>(n, 65536 - raw.size()));
            }
        } else if (done) {
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            TerminateProcess(proc_h.h, 1);
            return found;
        }
    }

    DWORD exit_code = 1;
    GetExitCodeProcess(proc_h.h, &exit_code);
    if (exit_code != 0 || raw.empty()) return found;

    return parse_antigravity_models_output(raw);
}

// Installation discovery must never wait on the remote subscription catalog.
std::vector<std::string> cached_antigravity_models(const std::string& binary) {
    using Clock = std::chrono::steady_clock;
    struct Snapshot {
        std::future<std::vector<std::string>> pending;
        std::vector<std::string> models;
        Clock::time_point next_probe{};
    };
    static std::mutex mutex;
    static std::map<std::string, Snapshot> snapshots;
    std::lock_guard lock(mutex);
    auto& snapshot = snapshots[binary];
    const auto now = Clock::now();
    if (snapshot.pending.valid() && snapshot.pending.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
        std::vector<std::string> fresh;
        try { fresh = snapshot.pending.get(); } catch (const std::exception&) {}
        snapshot.next_probe = now + (fresh.empty() ? std::chrono::seconds(5) : std::chrono::minutes(5));
        if (!fresh.empty()) snapshot.models = std::move(fresh);
    }
    if (!snapshot.pending.valid() && now >= snapshot.next_probe) {
        snapshot.pending = std::async(std::launch::async, probe_antigravity_cli_models, binary);
    }
    return snapshot.models;
}

void probe_antigravity_native(CliHarnessDescriptor& d, const fs::path& agy_cfg_dir, const fs::path& agy_app_dir) {
    std::error_code ec;
    const fs::path settings_p = agy_cfg_dir / L"settings.json";
    const fs::path oauth_p = agy_cfg_dir / L"antigravity-oauth-token";
    const bool has_settings = fs::is_regular_file(settings_p, ec);
    const bool has_oauth = fs::is_regular_file(oauth_p, ec);
    const bool has_app_dir = fs::is_directory(agy_app_dir, ec);
    d.native_configured = d.installed && (has_oauth || has_settings || has_app_dir);

    std::vector<std::string> models;
    if (has_settings) {
        try {
            const auto doc = Json::parse(read_small_file(settings_p));
            if (doc.is_object()) {
                const auto dm = trim_copy(jstr(doc, "model"));
                if (!dm.empty()) {
                    d.native_default_model = dm;
                }
                if (const auto* cm = doc.find("customModelsConfig"); cm && cm->is_object()) {
                    if (const auto* arr = cm->find("models"); arr && arr->is_array()) {
                        for (const auto& item : arr->as_array()) {
                            if (item.is_string()) push_unique_str(models, item.as_string());
                            else if (item.is_object()) {
                                const auto mid = jstr(item, "id", jstr(item, "model", jstr(item, "name")));
                                if (!mid.empty()) push_unique_str(models, mid);
                            }
                        }
                    }
                }
            }
        } catch (...) {}
    }

    if (d.installed) {
        const auto discovered = cached_antigravity_models(d.binary_path);
        if (!discovered.empty()) {
            d.native_configured = true;
            d.native_model_groups.push_back({"Antigravity CLI 可用模型", "", discovered});
        }
        for (const auto& model : discovered)
            std::erase(models, model);
        if (!models.empty())
            d.native_model_groups.push_back({"本地配置的模型（可用性待验证）", "", std::move(models)});
        d.native_status_label = (has_oauth || !discovered.empty())
            ? "已登录 Google Antigravity 原生账号"
            : (d.native_configured ? "已发现本地配置 · 登录状态待验证" : "已安装 · 请先登录授权");
    } else {
        d.native_status_label = "未安装（PowerShell: irm https://antigravity.google/cli/install.ps1 | iex）";
    }
}

struct SandboxCliSpec {
    const char* engine_id;
    const char* bin_name;
    const char* install_kind;       // "npm" | "hermes_script"
    const char* package_or_url;     // Official npm package or official Linux install URL
    const char* login_shell_cmd;    // Official interactive login command inside sandbox
    const char* cred_rel_paths[4];  // Relative paths inside /var/lib/dimension-cli-homes/<id>/
};

constexpr SandboxCliSpec sandbox_cli_specs[] = {
    {
        "claude-code", "claude", "npm", "@anthropic-ai/claude-code",
        "claude",
        {".claude.json", ".claude/settings.json", ".claude/.credentials.json", nullptr}
    },
    {
        "codex", "codex", "npm", "@openai/codex",
        "codex login",
        {".codex/auth.json", ".codex/config.toml", nullptr, nullptr}
    },
    {
        "gemini-cli", "gemini", "npm", "@google/gemini-cli",
        "gemini",
        {".gemini/oauth_creds.json", ".gemini/settings.json", ".gemini/google_accounts.json", nullptr}
    },
    {
        "qwen-code", "qwen", "npm", "@qwen-code/qwen-code",
        "qwen",
        {".qwen/oauth_creds.json", ".qwen/settings.json", nullptr, nullptr}
    },
    {
        "opencode", "opencode", "npm", "opencode-ai",
        "opencode auth login",
        {".local/share/opencode/auth.json", ".config/opencode/opencode.json", nullptr, nullptr}
    },
    {
        "kimi-code", "kimi", "npm", "@moonshot-ai/kimi-code",
        "kimi login",
        {".kimi-code/credentials.json", ".kimi-code/config.toml", nullptr, nullptr}
    },
    {
        "deepseek-harness", "dsh", "npm", "@deepseek-ai/dsh",
        "dsh login",
        {".dsh/.credentials.yaml", ".dsh/config.yaml", nullptr, nullptr}
    },
    {
        "hermes", "hermes", "hermes_script", "https://hermes-agent.nousresearch.com/install.sh",
        "hermes setup",
        {".hermes/auth.json", ".hermes/config.yaml", ".hermes/.env", nullptr}
    },
    {
        "antigravity", "agy", "antigravity_script", "https://antigravity.google/cli/install.sh",
        "agy",
        {".gemini/antigravity-cli/antigravity-oauth-token", ".gemini/oauth_creds.json", nullptr, nullptr}
    },
};

std::string sandbox_probe_catalog() {
    A rows;
    for (const auto& spec : sandbox_cli_specs) {
        A credentials;
        for (auto path : spec.cred_rel_paths)
            if (path) credentials.emplace_back(path);
        rows.emplace_back(O{{"id", spec.engine_id}, {"bin", spec.bin_name},
                            {"pkg", std::string_view(spec.install_kind) == "npm" ? spec.package_or_url : ""},
                            {"creds", std::move(credentials)}});
    }
    return Json(std::move(rows)).dump();
}

const SandboxCliSpec* find_sandbox_cli_spec(std::string_view engine_id) {
    for (const auto& s : sandbox_cli_specs) {
        if (engine_id == s.engine_id) return &s;
    }
    return nullptr;
}

std::string strip_wsl_utf16_noise(std::string_view raw) {
    return sanitize_wsl_stderr_line(raw);
}

fs::path resolve_wsl_exe_path(const fs::path& provided) {
    std::error_code ec;
    if (!provided.empty() && fs::is_regular_file(provided, ec)) return provided;
    const fs::path sys32 = L"C:\\Windows\\System32\\wsl.exe";
    if (fs::is_regular_file(sys32, ec)) return sys32;
    return {};
}

struct WslExecResult {
    bool launched = false;
    bool cancelled = false;
    int exit_code = -1;
    std::string stdout_text;
    std::string stderr_text;
};

WslExecResult run_wsl_streaming_command(const fs::path& wsl_exe,
                                        const std::vector<std::wstring>& args,
                                        const std::string& stdin_payload,
                                        int timeout_seconds,
                                        const std::function<void(std::string_view)>& on_line = {},
                                        std::stop_token stop = {}) {
    WslExecResult res;
    std::error_code ec;
    if (wsl_exe.empty() || !fs::is_regular_file(wsl_exe, ec)) return res;

    std::wstring cmd_line = quote_win_arg(wsl_exe.wstring());
    for (const auto& a : args) {
        cmd_line.push_back(L' ');
        cmd_line += quote_win_arg(a);
    }

    HandleGuard out_read, err_read, in_write, proc_h, thread_h, job;
    {
        // Serialize pipe creation + CreateProcessW(bInheritHandles=TRUE) + child-end close
        // so concurrent WSL calls can NEVER accidentally inherit each other's pipe write handles.
        static std::mutex g_wsl_spawn_mutex;
        std::lock_guard spawn_lk(g_wsl_spawn_mutex);

        SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr, in_r = nullptr, in_w = nullptr;
        if (!CreatePipe(&out_r, &out_w, &sa, 0)) return res;
        out_read = HandleGuard(out_r);
        HandleGuard out_write(out_w);
        SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

        if (!CreatePipe(&err_r, &err_w, &sa, 0)) return res;
        err_read = HandleGuard(err_r);
        HandleGuard err_write(err_w);
        SetHandleInformation(err_read.h, HANDLE_FLAG_INHERIT, 0);

        if (!CreatePipe(&in_r, &in_w, &sa, 0)) return res;
        HandleGuard in_read(in_r);
        in_write = HandleGuard(in_w);
        SetHandleInformation(in_write.h, HANDLE_FLAG_INHERIT, 0);
        if (stdin_payload.empty()) in_write = HandleGuard{};

        job = HandleGuard(CreateJobObjectW(nullptr, nullptr));
        if (job.h) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        si.hStdInput = in_read.h;
        si.hStdOutput = out_write.h;
        si.hStdError = err_write.h;

        std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
        mutable_cmd.push_back(L'\0');

        PROCESS_INFORMATION pi{};
        if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                            nullptr, nullptr, &si, &pi)) {
            return res;
        }
        res.launched = true;
        proc_h = HandleGuard(pi.hProcess);
        thread_h = HandleGuard(pi.hThread);
        // out_write, err_write, in_read close right here before releasing g_wsl_spawn_mutex.
    }

    if (job.h) AssignProcessToJobObject(job.h, proc_h.h);
    ResumeThread(thread_h.h);

    std::jthread stdin_writer;
    if (in_write.h && !stdin_payload.empty()) {
        stdin_writer = std::jthread([h_in = std::move(in_write), payload = stdin_payload]() mutable {
            const char* p = payload.data();
            std::size_t rem = payload.size();
            while (rem > 0) {
                DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(rem, 32768U));
                DWORD written = 0;
                if (!WriteFile(h_in.h, p, chunk, &written, nullptr) || written == 0) break;
                p += written;
                rem -= written;
            }
            h_in = HandleGuard{};
        });
    }

    std::mutex cb_mu;
    auto emit_chunk = [&](std::string& line_buf, const char* data, DWORD n, bool is_err) {
        // When stderr contains UTF-16LE lines (e.g. wsl.exe warnings), split on '\n' carefully:
        // a UTF-16LE '\n' is {0x0A, 0x00}; wait until the trailing 0x00 is consumed so line lengths stay even.
        for (DWORD i = 0; i < n; ++i) {
            const char ch = data[i];
            if (ch == '\n') {
                if (is_err && (line_buf.size() % 2 == 1) && i + 1 < n && data[i + 1] == '\0') {
                    ++i;
                }
                if (!line_buf.empty()) {
                    const std::string clean = is_err ? strip_wsl_utf16_noise(line_buf) : trim_copy(ensure_valid_utf8(line_buf));
                    if (!clean.empty() && on_line) {
                        std::lock_guard lk(cb_mu);
                        on_line(clean);
                    }
                    line_buf.clear();
                }
            } else if (ch == '\r') {
                if (is_err && (line_buf.size() % 2 == 1) && i + 1 < n && data[i + 1] == '\0') {
                    ++i;
                }
                if (!is_err && !line_buf.empty()) {
                    const std::string clean = trim_copy(ensure_valid_utf8(line_buf));
                    if (!clean.empty() && on_line) {
                        std::lock_guard lk(cb_mu);
                        on_line(clean);
                    }
                    line_buf.clear();
                }
            } else {
                line_buf.push_back(ch);
            }
        }
    };

    std::jthread out_reader([h = out_read.h, &res, &emit_chunk]() {
        char buf[4096];
        std::string lbuf;
        DWORD n = 0;
        while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            res.stdout_text.append(buf, n);
            emit_chunk(lbuf, buf, n, false);
        }
        if (!lbuf.empty()) emit_chunk(lbuf, "\n", 1, false);
    });

    std::jthread err_reader([h = err_read.h, &res, &emit_chunk]() {
        char buf[4096];
        std::string lbuf;
        DWORD n = 0;
        while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            res.stderr_text.append(buf, n);
            emit_chunk(lbuf, buf, n, true);
        }
        if (!lbuf.empty()) emit_chunk(lbuf, "\n", 1, true);
    });

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(std::clamp(timeout_seconds, 3, 1800));
    while (true) {
        const DWORD wait_rc = WaitForSingleObject(proc_h.h, 120);
        if (wait_rc == WAIT_OBJECT_0) break;
        if (stop.stop_requested()) {
            res.cancelled = true;
            if (job.h) TerminateJobObject(job.h, 130);
            else TerminateProcess(proc_h.h, 130);
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            if (job.h) TerminateJobObject(job.h, 124);
            else TerminateProcess(proc_h.h, 124);
            res.stderr_text += "\n操作超时（超过 " + std::to_string(timeout_seconds) + " 秒）";
            break;
        }
    }

    DWORD code = 1;
    if (GetExitCodeProcess(proc_h.h, &code)) res.exit_code = static_cast<int>(code);
    // Close JobObject after root process exits so no stray grandchild keeps stdout/stderr pipes open.
    job = HandleGuard{};

    if (stdin_writer.joinable()) stdin_writer.join();
    if (out_reader.joinable()) out_reader.join();
    if (err_reader.joinable()) err_reader.join();

    return res;
}

struct SandboxCliProbeItem {
    bool installed = false;
    std::string binary_path;
    std::string version;
    bool native_configured = false;
    bool auth_verified = false;
    std::string native_default_model;
    std::vector<std::string> native_models;
};

struct SandboxCliSnapshot {
    SandboxCliEnvironmentStatus env;
    std::map<std::string, SandboxCliProbeItem> items;
};

SandboxCliSnapshot probe_sandbox_cli_snapshot(const fs::path& wsl_executable,
                                              const std::string& sandbox_distribution,
                                              bool include_models = false) {
    SandboxCliSnapshot snap;
    const fs::path wsl = resolve_wsl_exe_path(wsl_executable);
    snap.env.wsl_available = !wsl.empty();
    if (!snap.env.wsl_available) {
        snap.env.detail = "未检测到 WSL 运行时（C:\\Windows\\System32\\wsl.exe）";
        return snap;
    }
    if (sandbox_distribution.empty()) {
        snap.env.detail = "未配置隔离 Linux 沙盒发行版名称";
        return snap;
    }

    // Pure local offline disk probe ONLY (zero network calls!) so sandbox discovery always returns
    // in ~200-400ms and can NEVER hang or misreport installed CLIs as missing when proxy/network is off.
    static const std::string kProbeNodeScript = "const specs = " + sandbox_probe_catalog() + ";\n" + R"NODE(
const fs = require('fs');
const cp = require('child_process');
const existsExec = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
const existsAny = p => { try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; } };
const which = name => {
  for (const dir of ['/opt/dimension-tools/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const p = dir + '/' + name;
    if (existsExec(p)) return p;
  }
  return '';
};
const readPkgVer = pkg => {
  try {
    const j = JSON.parse(fs.readFileSync('/opt/dimension-tools/npm/node_modules/' + pkg + '/package.json', 'utf8'));
    return String(j.version || '');
  } catch { return ''; }
};
const readHermesVer = () => {
  for (const f of ['/opt/dimension-tools/hermes/repo/pyproject.toml', '/opt/dimension-tools/hermes/repo/package.json']) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      const m = txt.match(/version["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (m) return m[1];
    } catch {}
  }
  return '';
};
const readAgyVer = () => {
  try {
    const out = cp.execFileSync('/opt/dimension-tools/bin/agy', ['--version'], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = String(out || '').match(/(\d+\.\d+\.\d+[A-Za-z0-9._-]*)/);
    return m ? m[1] : '';
  } catch { return ''; }
};
const AGY_BUILTIN_MODELS = [
  'gemini-4-neon-xhigh',
  'gemini-4-neon-high',
  'gemini-4-neon-medium',
  'gemini-4-neon-low',
  'gemini-4-carbon-high',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-low',
  'gemini-4-argon-high',
  'gemini-4-argon-medium',
  'gemini-4-argon-low',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-neon',
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-argon',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-high',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-low',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-low',
  'gpt-oss-120b-medium'
];
const probeAgyDetails = (home, installed) => {
  const info = { defaultModel: '', models: [], authVerified: false, cacheStale: true };
  if (!installed) return info;
  const cfgDir = home + '/.gemini/antigravity-cli';
  const hasOauth = existsAny(cfgDir + '/antigravity-oauth-token') || existsAny(home + '/.gemini/oauth_creds.json');
  info.authVerified = hasOauth;
  try {
    const sj = JSON.parse(fs.readFileSync(cfgDir + '/settings.json', 'utf8'));
    if (sj && typeof sj.model === 'string') info.defaultModel = sj.model.trim();
  } catch {}
  const cachePath = cfgDir + '/.dimension-models-cache.json';
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && Array.isArray(cached.models) && cached.models.length) {
      info.models = cached.models.map(x => String(x || '').trim()).filter(Boolean).slice(0, 64);
      const updatedAt = Number(cached.updatedAt || 0);
      info.cacheStale = !(updatedAt > 0 && (Date.now() - updatedAt) < 5 * 60 * 1000);
    }
  } catch {}
  if (!info.models.length && hasOauth) {
    info.models = AGY_BUILTIN_MODELS.slice();
  }
  return info;
};
const items = {};
for (const s of specs) {
  const binPath = '/opt/dimension-tools/bin/' + s.bin;
  const installed = existsExec(binPath);
  const ver = installed ? (s.id === 'hermes' ? readHermesVer() : (s.id === 'antigravity' ? readAgyVer() : readPkgVer(s.pkg))) : '';
  const home = '/var/lib/dimension-cli-homes/' + s.id;
  let nativeConfigured = installed && s.creds.some(rel => existsAny(home + '/' + rel));
  let nativeDefaultModel = '';
  let nativeModels = [];
  let authVerified = nativeConfigured;
  let cacheStale = false;
  if (s.id === 'antigravity' && installed) {
    const agyInfo = probeAgyDetails(home, installed);
    nativeDefaultModel = agyInfo.defaultModel;
    nativeModels = agyInfo.models;
    authVerified = agyInfo.authVerified;
    cacheStale = agyInfo.cacheStale;
    nativeConfigured = agyInfo.authVerified || agyInfo.models.length > 0;
  }
  items[s.id] = { installed, binaryPath: installed ? binPath : '', version: ver, nativeConfigured, authVerified, nativeDefaultModel, nativeModels, cacheStale };
}
const env = {
  bwrapReady: Boolean(which('bwrap')),
  nodeReady: Boolean(which('node')),
  npmReady: Boolean(which('npm')),
  pythonReady: Boolean(which('python3')),
  nodeVersion: process.version || ''
};
process.stdout.write(JSON.stringify({ env, items }));
)NODE";

    const auto r = run_wsl_streaming_command(
        wsl,
        {L"-d", utf8_to_wide(sandbox_distribution), L"-u", L"root", L"--exec", L"/usr/bin/node", L"-"},
        kProbeNodeScript,
        12);
    if (!r.launched || r.exit_code != 0) {
        const std::string err_clean = strip_wsl_utf16_noise(r.stderr_text);
        snap.env.detail = err_clean.empty()
            ? ("无法连接隔离沙盒 " + sandbox_distribution + "（请先在扩展中枢完成沙盒初始化）")
            : ("沙盒探测失败：" + err_clean);
        return snap;
    }

    try {
        const auto brace = r.stdout_text.find('{');
        if (brace == std::string::npos) {
            snap.env.detail = "沙盒探针未返回有效 JSON";
            return snap;
        }
        const Json doc = Json::parse(r.stdout_text.substr(brace));
        snap.env.distro_ready = true;
        if (const auto* ev = doc.find("env"); ev && ev->is_object()) {
            snap.env.bwrap_ready = ev->find("bwrapReady") && ev->at("bwrapReady").is_bool() && ev->at("bwrapReady").as_bool();
            snap.env.node_ready = ev->find("nodeReady") && ev->at("nodeReady").is_bool() && ev->at("nodeReady").as_bool();
            snap.env.npm_ready = ev->find("npmReady") && ev->at("npmReady").is_bool() && ev->at("npmReady").as_bool();
            snap.env.python_ready = ev->find("pythonReady") && ev->at("pythonReady").is_bool() && ev->at("pythonReady").as_bool();
            snap.env.node_version = jstr(*ev, "nodeVersion");
        }
        snap.env.ready = snap.env.distro_ready && snap.env.bwrap_ready && snap.env.node_ready && snap.env.npm_ready;
        snap.env.detail = snap.env.ready
            ? ("Bubblewrap 内核沙盒已就绪 · Node " + snap.env.node_version)
            : "沙盒缺少 bwrap 或 Node/npm 运行时";
        if (const auto* itm = doc.find("items"); itm && itm->is_object()) {
            for (const auto& [k, v] : itm->as_object()) {
                if (!v.is_object()) continue;
                SandboxCliProbeItem pi;
                pi.installed = v.find("installed") && v.at("installed").is_bool() && v.at("installed").as_bool();
                pi.binary_path = jstr(v, "binaryPath");
                pi.version = jstr(v, "version");
                pi.native_configured = v.find("nativeConfigured") && v.at("nativeConfigured").is_bool() && v.at("nativeConfigured").as_bool();
                pi.auth_verified = v.find("authVerified") && v.at("authVerified").is_bool() && v.at("authVerified").as_bool();
                pi.native_default_model = trim_copy(jstr(v, "nativeDefaultModel"));
                if (const auto* marr = v.find("nativeModels"); marr && marr->is_array()) {
                    for (const auto& m : marr->as_array()) {
                        if (m.is_string()) {
                            const auto ms = trim_copy(m.as_string());
                            if (!ms.empty()) push_unique_str(pi.native_models, ms);
                        }
                    }
                }
                const bool cache_stale = v.find("cacheStale") && v.at("cacheStale").is_bool() && v.at("cacheStale").as_bool();
                const bool should_bg_refresh = include_models && k == "antigravity" && pi.installed && pi.auth_verified && cache_stale;
                snap.items[k] = std::move(pi);
                if (should_bg_refresh) {
                    static std::atomic<bool> g_agy_refresh_inflight{false};
                    bool expected = false;
                    if (g_agy_refresh_inflight.compare_exchange_strong(expected, true)) {
                        std::thread([wsl_copy = wsl, distro_copy = sandbox_distribution]() {
                            struct Guard {
                                std::atomic<bool>& flag;
                                ~Guard() { flag.store(false, std::memory_order_release); }
                            } guard{g_agy_refresh_inflight};
                            try {
                                std::ostringstream sh;
                                sh << "HOME=/var/lib/dimension-cli-homes/antigravity "
                                   << "USER=dimension LOGNAME=dimension LANG=C.UTF-8 LC_ALL=C.UTF-8 ";
                                for (const auto& [pk, pv] : build_sandbox_proxy_env_overrides()) {
                                    sh << pk << "='" << pv << "' ";
                                }
                                sh << "exec /usr/bin/setpriv --reuid=1001 --regid=1002 --clear-groups "
                                   << "/usr/bin/timeout --kill-after=1s 6s /opt/dimension-tools/bin/agy models";
                                const auto mr = run_wsl_streaming_command(
                                    wsl_copy,
                                    {L"-d", utf8_to_wide(distro_copy), L"-u", L"root", L"--exec", L"/bin/sh", L"-c",
                                     utf8_to_wide(sh.str())},
                                    {},
                                    9);
                                if (mr.launched && mr.exit_code == 0) {
                                    const auto parsed = parse_antigravity_models_output(mr.stdout_text);
                                    if (!parsed.empty()) {
                                        Json::Array arr;
                                        for (const auto& m : parsed) arr.push_back(m);
                                        const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::system_clock::now().time_since_epoch()).count();
                                        const std::string payload = Json(Json::Object{
                                            {"updatedAt", static_cast<double>(now_ms)},
                                            {"models", std::move(arr)}
                                        }).dump();
                                        const std::string write_cmd =
                                            "mkdir -p /var/lib/dimension-cli-homes/antigravity/.gemini/antigravity-cli && "
                                            "cat > /var/lib/dimension-cli-homes/antigravity/.gemini/antigravity-cli/.dimension-models-cache.json && "
                                            "chown 1001:1002 /var/lib/dimension-cli-homes/antigravity/.gemini/antigravity-cli/.dimension-models-cache.json";
                                        (void)run_wsl_streaming_command(
                                            wsl_copy,
                                            {L"-d", utf8_to_wide(distro_copy), L"-u", L"root", L"--exec", L"/bin/sh", L"-c",
                                             utf8_to_wide(write_cmd)},
                                            payload,
                                            5);
                                    }
                                }
                            } catch (...) {}
                        }).detach();
                    }
                }
            }
        }
    } catch (const std::exception& ex) {
        snap.env.detail = std::string("解析沙盒状态失败：") + ex.what();
    }
    return snap;
}

} // namespace

std::vector<std::string> parse_antigravity_models_output(std::string_view raw) {
    std::vector<std::string> found;
    if (raw.empty()) return found;
    static const std::regex kTokenRe(R"(^[A-Za-z0-9][A-Za-z0-9._-]{2,64}$)");
    static const std::regex kSlugRe(R"(\b((?:gemini|claude|gpt|o[134]|grok|deepseek|qwen|kimi)[A-Za-z0-9._-]{2,64})\b)",
                                    std::regex::icase);
    std::istringstream iss(ensure_valid_utf8(raw));
    std::string line;
    while (std::getline(iss, line)) {
        const std::string trimmed = trim_copy(line);
        if (trimmed.empty()) continue;
        // Official `agy models` outputs TSV lines: `<slug>\t<Display Name>`
        const std::size_t sep = trimmed.find_first_of("\t ");
        const std::string first = (sep == std::string::npos) ? trimmed : trimmed.substr(0, sep);
        const std::string first_low = ascii_lower(first);
        if (first_low != "fetching" && first_low != "error:" && first_low != "warning:" &&
            std::regex_match(first, kTokenRe) &&
            (first.find('-') != std::string::npos || std::regex_search(first, kSlugRe))) {
            push_unique_str(found, first);
            if (found.size() >= 64) break;
            continue;
        }
        std::smatch m;
        auto it = trimmed.cbegin();
        while (std::regex_search(it, trimmed.cend(), m, kSlugRe)) {
            push_unique_str(found, m[1].str());
            it = m.suffix().first;
            if (found.size() >= 64) break;
        }
        if (found.size() >= 64) break;
    }
    return found;
}

std::string sanitize_wsl_stderr_line(std::string_view raw) {
    if (raw.empty()) return {};
    // When wsl.exe emits a UTF-16LE diagnostic line terminated by \r\0\n\0 and the caller splits
    // on ASCII '\n', the following UTF-8 line from Linux starts with a stray leading '\0'.
    // Strip leading lone '\0' when the rest of the line is plain UTF-8 rather than UTF-16LE.
    std::size_t odd_zeros = 0;
    std::size_t even_zeros = 0;
    for (std::size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == '\0') {
            if ((i & 1U) != 0U) ++odd_zeros;
            else ++even_zeros;
        }
    }
    const std::size_t total_zeros = odd_zeros + even_zeros;
    std::string_view slice = raw;
    if (slice.size() >= 2 && slice[0] == '\0' && slice[1] != '\0' && odd_zeros == 0 && even_zeros <= 1) {
        slice.remove_prefix(1);
    }

    // Re-evaluate UTF-16LE heuristic on the normalized slice: UTF-16LE ASCII/CJK diagnostics from
    // wsl.exe contain multiple NUL bytes on odd positions (e.g. "w\0s\0l\0:\0").
    std::size_t slice_odd_zeros = 0;
    for (std::size_t i = 1; i < slice.size(); i += 2) {
        if (slice[i] == '\0') ++slice_odd_zeros;
    }
    const bool looks_utf16le = (slice.size() >= 4 && slice_odd_zeros >= 2 &&
                                (slice_odd_zeros * 4 >= slice.size() || total_zeros >= 4));

    std::string text;
    if (looks_utf16le) {
        const std::size_t wcount = slice.size() / 2;
        std::wstring wbuf(wcount, L'\0');
        std::memcpy(wbuf.data(), slice.data(), wcount * 2);
        const int u8len = WideCharToMultiByte(CP_UTF8, 0, wbuf.data(), static_cast<int>(wbuf.size()),
                                              nullptr, 0, nullptr, nullptr);
        if (u8len > 0) {
            text.resize(static_cast<std::size_t>(u8len));
            WideCharToMultiByte(CP_UTF8, 0, wbuf.data(), static_cast<int>(wbuf.size()),
                                text.data(), u8len, nullptr, nullptr);
        }
    } else {
        std::string no_nul;
        no_nul.reserve(slice.size());
        for (char c : slice) {
            if (c != '\0') no_nul.push_back(c);
        }
        text = ensure_valid_utf8(no_nul);
    }
    text = trim_copy(text);
    if (text.empty()) return {};
    if (text.find("wsl:") != std::string::npos && text.find("localhost") != std::string::npos) {
        return {};
    }
    return ensure_valid_utf8(text);
}

std::string windows_path_to_wsl_path(const std::filesystem::path& win_path,
                                     const std::string& sandbox_distribution) {
    std::string raw = path_to_utf8(win_path);
    if (raw.empty()) return {};
    if (raw.front() == '/') return raw;

    std::string norm = raw;
    std::replace(norm.begin(), norm.end(), '\\', '/');
    // Handle \\wsl.localhost\<distro>\... or \\wsl$\<distro>\...
    if (norm.starts_with("//wsl.localhost/") || norm.starts_with("//wsl$/")) {
        const std::size_t prefix_len = norm.starts_with("//wsl.localhost/") ? 16U : 7U;
        const std::size_t slash = norm.find('/', prefix_len);
        if (slash == std::string::npos) return "/";
        const std::string dist = norm.substr(prefix_len, slash - prefix_len);
        if (!sandbox_distribution.empty() && ascii_lower(dist) != ascii_lower(sandbox_distribution)) {
            return norm.substr(slash);
        }
        return norm.substr(slash);
    }
    // Handle Windows drive letter e.g. D:/SampleProject -> /mnt/d/SampleProject
    if (norm.size() >= 2 && std::isalpha(static_cast<unsigned char>(norm[0])) && norm[1] == ':') {
        const char drive = static_cast<char>(std::tolower(static_cast<unsigned char>(norm[0])));
        std::string rest = (norm.size() > 2) ? norm.substr(2) : std::string{};
        if (!rest.empty() && rest.front() != '/') rest.insert(rest.begin(), '/');
        return std::string("/mnt/") + drive + rest;
    }
    return norm;
}

SandboxCliEnvironmentStatus probe_sandbox_cli_environment(const std::filesystem::path& wsl_executable,
                                                          const std::string& sandbox_distribution) {
    return probe_sandbox_cli_snapshot(wsl_executable, sandbox_distribution).env;
}

SandboxCliInstallResult manage_sandbox_cli(const SandboxCliInstallRequest& req,
                                           const std::function<void(std::string_view)>& on_log,
                                           std::stop_token stop) {
    SandboxCliInstallResult out;
    out.engine_id = req.engine_id;
    auto push_log = [&](std::string_view line) {
        if (line.empty()) return;
        if (out.logs.size() < 400) out.logs.emplace_back(line);
        if (on_log) on_log(line);
    };

    const SandboxCliSpec* spec = find_sandbox_cli_spec(req.engine_id);
    if (!spec) {
        out.error = "不支持的沙盒 CLI 引擎：" + req.engine_id;
        return out;
    }
    const fs::path wsl = resolve_wsl_exe_path(req.wsl_executable);
    if (wsl.empty() || req.sandbox_distribution.empty()) {
        out.error = "隔离沙盒（WSL dimension-sandbox）未就绪，无法管理沙盒 CLI";
        return out;
    }

    configure_network_proxy_sandbox(wsl, req.sandbox_distribution);

    const std::string action = (req.action == "uninstall" || req.action == "update") ? req.action : "install";
    const std::string registry_url = (req.registry == "official")
        ? "https://registry.npmjs.org"
        : "https://registry.npmmirror.com";

    std::ostringstream script;
    script << "set -eu\n"
           << "export DEBIAN_FRONTEND=noninteractive\n"
           << "export NO_COLOR=1\n";
    for (const auto& [pk, pv] : build_sandbox_proxy_env_overrides()) {
        script << "export " << pk << "='" << pv << "'\n";
    }
    script << "mkdir -p /opt/dimension-tools/bin /opt/dimension-tools/npm /var/lib/dimension-cli-homes\n"
           << "mkdir -p -m 700 /var/lib/dimension-cli-homes/" << spec->engine_id << "\n"
           << "chown -R 1001:1002 /var/lib/dimension-cli-homes/" << spec->engine_id << "\n";

    // Respect DimensionAgent's global network proxy policy ("auto" | "global" | "none")
    // so large official Linux archives (e.g. 98MB Antigravity CLI) honor the user's proxy mode.
    auto resolve_host_download_proxy = []() -> std::string {
        const auto resolved = resolve_active_network_proxy();
        return (resolved.use_proxy && !resolved.active_proxy_url.empty())
            ? resolved.active_proxy_url : std::string{};
    };

    auto run_host_curl = [&](const std::vector<std::wstring>& extra_args,
                             const fs::path& progress_file,
                             std::uint64_t expected_total_bytes,
                             const std::string& progress_label,
                             int max_seconds,
                             std::string& out_stdout,
                             bool& out_cancelled) -> int {
        out_stdout.clear();
        out_cancelled = false;
        const std::string curl_u8 = find_in_windows_path({L"curl.exe"});
        if (curl_u8.empty()) return -1;

        std::wstring cmd = quote_win_arg(utf8_to_wide(curl_u8));
        for (const auto& a : extra_args) {
            cmd.push_back(L' ');
            cmd += quote_win_arg(a);
        }

        SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE out_r = nullptr, out_w = nullptr;
        if (!CreatePipe(&out_r, &out_w, &sa, 0)) return -1;
        HandleGuard out_read(out_r), out_write(out_w);
        SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

        HandleGuard job(CreateJobObjectW(nullptr, nullptr));
        if (job.h) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        si.hStdOutput = out_write.h;
        si.hStdError = out_write.h;

        std::vector<wchar_t> mutable_cmd(cmd.begin(), cmd.end());
        mutable_cmd.push_back(L'\0');
        PROCESS_INFORMATION pi{};
        if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                            nullptr, nullptr, &si, &pi)) {
            return -1;
        }
        HandleGuard proc_h(pi.hProcess), thread_h(pi.hThread);
        out_write = HandleGuard{};
        if (job.h) AssignProcessToJobObject(job.h, proc_h.h);
        ResumeThread(thread_h.h);

        std::jthread reader([&]() {
            char buf[2048];
            DWORD n = 0;
            while (ReadFile(out_read.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
                if (out_stdout.size() < 64U * 1024U) {
                    out_stdout.append(buf, n);
                }
            }
        });

        const auto started = std::chrono::steady_clock::now();
        const auto deadline = started + std::chrono::seconds(max_seconds);
        auto last_prog_log = started;
        std::uint64_t last_reported_mb = 0;
        while (true) {
            if (WaitForSingleObject(proc_h.h, 120) == WAIT_OBJECT_0) break;
            if (stop.stop_requested()) {
                out_cancelled = true;
                if (job.h) TerminateJobObject(job.h, 130);
                else TerminateProcess(proc_h.h, 130);
                break;
            }
            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline) {
                if (job.h) TerminateJobObject(job.h, 124);
                else TerminateProcess(proc_h.h, 124);
                break;
            }
            if (!progress_file.empty() && (now - last_prog_log) >= std::chrono::milliseconds(1500)) {
                last_prog_log = now;
                std::error_code sz_ec;
                const auto cur_bytes = fs::is_regular_file(progress_file, sz_ec) ? fs::file_size(progress_file, sz_ec) : 0ULL;
                const auto cur_mb = cur_bytes / (1024ULL * 1024ULL);
                if (cur_bytes > 0 && cur_mb != last_reported_mb) {
                    last_reported_mb = cur_mb;
                    const double elapsed_s = std::max(0.5, std::chrono::duration<double>(now - started).count());
                    const double speed_mb_s = (static_cast<double>(cur_bytes) / (1024.0 * 1024.0)) / elapsed_s;
                    char line_buf[192]{};
                    if (expected_total_bytes > 0) {
                        const int pct = std::clamp(static_cast<int>((cur_bytes * 100ULL) / expected_total_bytes), 0, 99);
                        std::snprintf(line_buf, sizeof(line_buf), "%s：%.1f / %.1f MB (%d%%, %.1f MB/s)…",
                                      progress_label.c_str(),
                                      static_cast<double>(cur_bytes) / (1024.0 * 1024.0),
                                      static_cast<double>(expected_total_bytes) / (1024.0 * 1024.0),
                                      pct, speed_mb_s);
                    } else {
                        std::snprintf(line_buf, sizeof(line_buf), "%s：已下载 %.1f MB (%.1f MB/s)…",
                                      progress_label.c_str(),
                                      static_cast<double>(cur_bytes) / (1024.0 * 1024.0),
                                      speed_mb_s);
                    }
                    push_log(line_buf);
                }
            }
        }
        WaitForSingleObject(proc_h.h, 2000);
        DWORD rc = 1;
        GetExitCodeProcess(proc_h.h, &rc);
        if (reader.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(reader.native_handle()));
            reader.join();
        }
        return static_cast<int>(rc);
    };

    struct HostStageCleanup {
        fs::path dir;
        ~HostStageCleanup() {
            if (!dir.empty()) {
                std::error_code rm_ec;
                fs::remove_all(dir, rm_ec);
            }
        }
    } host_stage_cleanup;

    if (action == "uninstall") {
        push_log(std::string("正在从沙盒卸载 ") + spec->engine_id + "…");
        if (std::string_view(spec->install_kind) == "npm") {
            script << "npm uninstall --prefix /opt/dimension-tools/npm " << spec->package_or_url << " || true\n"
                   << "rm -f /opt/dimension-tools/bin/" << spec->bin_name << "\n";
        } else if (std::string_view(spec->install_kind) == "antigravity_script") {
            script << "rm -rf /opt/dimension-tools/antigravity /opt/dimension-tools/bin/agy\n";
        } else {
            script << "rm -rf /opt/dimension-tools/hermes /opt/dimension-tools/bin/hermes\n";
        }
        if (req.clear_credentials) {
            script << "rm -rf /var/lib/dimension-cli-homes/" << spec->engine_id << "\n";
        }
        script << "echo 'DIMENSION_SANDBOX_CLI_DONE'\n";
    } else if (std::string_view(spec->install_kind) == "antigravity_script") {
        // Fast-path: download official Antigravity Linux archive on Windows host (automatically inheriting
        // host system proxy even when WSL2 NAT cannot mirror localhost proxies), verify SHA-512 inside WSL,
        // and atomically install into /opt/dimension-tools/antigravity/agy.
        bool host_staged_ok = false;
        std::string host_staged_tar_wsl;
        std::string host_staged_sha512;
        std::string host_staged_ver;
        {
            const std::string proxy = resolve_host_download_proxy();
            const bool no_proxy_mode = (resolve_active_network_proxy().mode == "none");
            const std::string manifest_url =
                "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json";
            push_log(proxy.empty()
                ? (no_proxy_mode
                    ? "当前为无代理直连模式，正在查询 Google Antigravity 官方 Linux 发行清单…"
                    : "正在查询 Google Antigravity 官方 Linux 发行清单…")
                : ("正在经由代理 (" + proxy + ") 查询 Google Antigravity 官方 Linux 发行清单…"));

            std::vector<std::wstring> m_args{L"-fsSL", L"--max-time", L"25"};
            if (!proxy.empty()) {
                m_args.push_back(L"-x");
                m_args.push_back(utf8_to_wide(proxy));
            } else if (no_proxy_mode) {
                m_args.push_back(L"--noproxy");
                m_args.push_back(L"*");
            }
            m_args.push_back(utf8_to_wide(manifest_url));

            std::string manifest_body;
            bool m_cancelled = false;
            const int m_rc = run_host_curl(m_args, {}, 0, {}, 30, manifest_body, m_cancelled);
            if (m_cancelled || stop.stop_requested()) {
                out.cancelled = true;
                out.error = "已取消沙盒 CLI 操作";
                return out;
            }
            if (m_rc == 0 && !manifest_body.empty()) {
                try {
                    const Json mdoc = Json::parse(trim_copy(manifest_body));
                    const std::string ver = jstr(mdoc, "version");
                    const std::string dl_url = jstr(mdoc, "url");
                    const std::string sha512 = ascii_lower(jstr(mdoc, "sha512"));
                    const bool valid_sha = (sha512.size() == 128U) &&
                        std::all_of(sha512.begin(), sha512.end(), [](unsigned char ch) {
                            return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
                        });
                    if (dl_url.starts_with("https://") && valid_sha) {
                        std::error_code tmp_ec;
                        const fs::path tmp_root = fs::temp_directory_path(tmp_ec) /
                            utf8_to_path("dimension-agy-stage-" + std::to_string(GetCurrentProcessId()) + "-" +
                                         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
                        fs::create_directories(tmp_root, tmp_ec);
                        host_stage_cleanup.dir = tmp_root;
                        const bool is_tgz = dl_url.find(".tar.gz") != std::string::npos;
                        const fs::path payload_path = tmp_root / (is_tgz ? L"cli_linux_x64.tar.gz" : L"agy");

                        push_log("发现最新官方版本 v" + ver + "，正在经由宿主机高速下载安装包…");
                        std::vector<std::wstring> d_args{L"-fsSL", L"--max-time", L"540"};
                        if (!proxy.empty()) {
                            d_args.push_back(L"-x");
                            d_args.push_back(utf8_to_wide(proxy));
                        } else if (no_proxy_mode) {
                            d_args.push_back(L"--noproxy");
                            d_args.push_back(L"*");
                        }
                        d_args.push_back(L"-o");
                        d_args.push_back(payload_path.wstring());
                        d_args.push_back(utf8_to_wide(dl_url));

                        std::string dl_out;
                        bool dl_cancelled = false;
                        const int dl_rc = run_host_curl(
                            d_args, payload_path, 0,
                            "正在下载 Antigravity CLI v" + ver, 550, dl_out, dl_cancelled);
                        if (dl_cancelled || stop.stop_requested()) {
                            out.cancelled = true;
                            out.error = "已取消沙盒 CLI 操作";
                            return out;
                        }
                        if (dl_rc == 0 && fs::is_regular_file(payload_path, tmp_ec) && fs::file_size(payload_path, tmp_ec) > 1024U) {
                            host_staged_tar_wsl = windows_path_to_wsl_path(payload_path, req.sandbox_distribution);
                            host_staged_sha512 = sha512;
                            host_staged_ver = ver;
                            host_staged_ok = !host_staged_tar_wsl.empty();
                            if (host_staged_ok) {
                                push_log("安装包下载完成，正在沙盒内执行 SHA-512 校验与原子安装…");
                            }
                        }
                    }
                } catch (...) {}
            }
        }

        if (host_staged_ok) {
            const bool is_tgz = host_staged_tar_wsl.ends_with(".tar.gz");
            script << "mkdir -p /opt/dimension-tools/antigravity\n"
                   << "rm -rf /opt/dimension-tools/antigravity/.update.* /opt/dimension-tools/antigravity/.stage.*\n"
                   << "stage=$(mktemp -d /opt/dimension-tools/antigravity/.stage.XXXXXX)\n"
                   << "trap 'rm -rf -- \"$stage\"' EXIT\n"
                   << "echo '" << host_staged_sha512 << "  " << host_staged_tar_wsl << "' | sha512sum -c -\n";
            if (is_tgz) {
                script << "tar -xzf '" << host_staged_tar_wsl << "' -C \"$stage\" antigravity\n"
                       << "cp \"$stage/antigravity\" \"$stage/agy\"\n";
            } else {
                script << "cp '" << host_staged_tar_wsl << "' \"$stage/agy\"\n";
            }
            script << "chmod a+rx \"$stage/agy\"\n"
                   << "\"$stage/agy\" --version\n"
                   << "ln -s /opt/dimension-tools/antigravity/agy \"$stage/entry\"\n"
                   << "mv -fT \"$stage/agy\" /opt/dimension-tools/antigravity/agy\n"
                   << "mv -fT \"$stage/entry\" /opt/dimension-tools/bin/agy\n"
                   << "chmod -R a+rX /opt/dimension-tools/antigravity\n"
                   << "echo 'DIMENSION_SANDBOX_CLI_DONE'\n";
        } else {
            // Fallback: WSL direct installer (with stale staging cleanup & extended 600s timeout).
            push_log("宿主机快传未命中，回退至沙盒直连下载 Antigravity 官方安装包（可能需数分钟）…");
            script << "mkdir -p /opt/dimension-tools/antigravity\n"
                   << "rm -rf /opt/dimension-tools/antigravity/.update.*\n"
                   << "stage=$(mktemp -d /opt/dimension-tools/antigravity/.update.XXXXXX)\n"
                   << "trap 'rm -rf -- \"$stage\"' EXIT\n"
                   << "curl -fsSL --max-time 60 " << spec->package_or_url << " -o \"$stage/install.sh\"\n"
                   << "mkdir \"$stage/bin\"\n"
                   << "bash \"$stage/install.sh\" --dir \"$stage/bin\"\n"
                   << "test -x \"$stage/bin/agy\"\n"
                   << "\"$stage/bin/agy\" --version\n"
                   << "chmod a+rx \"$stage/bin/agy\"\n"
                   << "ln -s /opt/dimension-tools/antigravity/agy \"$stage/entry\"\n"
                   << "mv -fT \"$stage/bin/agy\" /opt/dimension-tools/antigravity/agy\n"
                   << "mv -fT \"$stage/entry\" /opt/dimension-tools/bin/agy\n"
                   << "echo 'DIMENSION_SANDBOX_CLI_DONE'\n";
        }
    } else if (std::string_view(spec->install_kind) == "npm") {
        push_log(std::string("正在从 ") + (req.registry == "official" ? "npm 官方源" : "npmmirror 国内镜像") +
                 " 下载 " + spec->package_or_url + " 到隔离沙盒…");
        script << "echo '>> npm install " << spec->package_or_url << " (registry: " << registry_url << ")'\n"
               << "npm install --prefix /opt/dimension-tools/npm --no-audit --no-fund --loglevel=notice "
               << "--registry=" << registry_url << " " << spec->package_or_url << "@latest\n"
               << "BIN_SRC=\"\"\n"
               << "if [ -x /opt/dimension-tools/npm/bin/" << spec->bin_name << " ]; then BIN_SRC=/opt/dimension-tools/npm/bin/" << spec->bin_name << "; "
               << "elif [ -x /opt/dimension-tools/npm/node_modules/.bin/" << spec->bin_name << " ]; then BIN_SRC=/opt/dimension-tools/npm/node_modules/.bin/" << spec->bin_name << "; fi\n"
               << "if [ -z \"$BIN_SRC\" ]; then echo 'ERROR: executable not found after install' >&2; exit 2; fi\n"
               << "ln -sf \"$BIN_SRC\" /opt/dimension-tools/bin/" << spec->bin_name << "\n"
               << "chmod -R a+rX /opt/dimension-tools\n"
               << "echo 'DIMENSION_SANDBOX_CLI_DONE'\n";
    } else {
        // Hermes official Linux non-interactive installer into /opt/dimension-tools/hermes
        push_log("正在从 Hermes 官方源下载并初始化沙盒隔离运行环境（首次可能需要 1~3 分钟）…");
        script << "mkdir -p /opt/dimension-tools/hermes/repo /opt/dimension-tools/hermes/home /opt/dimension-tools/hermes/bin\n"
               << "TMP_SH=/tmp/dim-hermes-install.sh\n"
               << "curl -fsSL --max-time 60 " << spec->package_or_url << " -o \"$TMP_SH\"\n"
               << "HOME=/opt/dimension-tools/hermes/home HERMES_HOME=/opt/dimension-tools/hermes/home "
               << "bash \"$TMP_SH\" --non-interactive --skip-setup --skip-browser --skip-computer-use "
               << "--dir /opt/dimension-tools/hermes/repo --hermes-home /opt/dimension-tools/hermes/home\n"
               << "rm -f \"$TMP_SH\"\n"
               << "HERMES_BIN=\"\"\n"
               << "for cand in /opt/dimension-tools/hermes/home/.local/bin/hermes /opt/dimension-tools/hermes/home/bin/hermes /opt/dimension-tools/hermes/repo/.venv/bin/hermes /root/.local/bin/hermes; do "
               << "  if [ -x \"$cand\" ]; then HERMES_BIN=\"$cand\"; break; fi; done\n"
               << "if [ -z \"$HERMES_BIN\" ]; then echo 'ERROR: hermes binary not found after install' >&2; exit 2; fi\n"
               << "ln -sf \"$HERMES_BIN\" /opt/dimension-tools/bin/hermes\n"
               << "chmod -R a+rX /opt/dimension-tools\n"
               << "echo 'DIMENSION_SANDBOX_CLI_DONE'\n";
    }

    const int timeout_sec = ((std::string_view(spec->install_kind) == "hermes_script" ||
                              std::string_view(spec->install_kind) == "antigravity_script") &&
                             action != "uninstall") ? 600 : 300;
    const auto r = run_wsl_streaming_command(
        wsl,
        {L"-d", utf8_to_wide(req.sandbox_distribution), L"-u", L"root", L"--exec", L"/bin/sh", L"-s"},
        script.str(),
        timeout_sec,
        push_log,
        stop);

    out.cancelled = r.cancelled;
    out.exit_code = r.exit_code;
    if (r.cancelled) {
        out.error = "已取消沙盒 CLI 操作";
        return out;
    }
    if (!r.launched || r.exit_code != 0) {
        const std::string err_clean = strip_wsl_utf16_noise(r.stderr_text);
        out.error = !err_clean.empty()
            ? err_clean
            : ("沙盒操作失败（退出码 " + std::to_string(r.exit_code) + "）");
        return out;
    }

    // Re-probe to confirm live binary & exact version inside sandbox
    const auto snap = probe_sandbox_cli_snapshot(wsl, req.sandbox_distribution);
    if (const auto it = snap.items.find(req.engine_id); it != snap.items.end()) {
        out.version = it->second.version;
        out.binary_path = it->second.binary_path;
        if (action != "uninstall" && !it->second.installed) {
            out.error = "安装命令结束，但沙盒中未检测到可执行文件 /opt/dimension-tools/bin/" + std::string(spec->bin_name);
            return out;
        }
    }
    out.ok = true;
    push_log(action == "uninstall" ? "卸载完成。" : ("已就绪：" + out.binary_path + (out.version.empty() ? "" : (" (v" + out.version + ")"))));
    return out;
}

Json launch_sandbox_cli_login_terminal(const std::string& engine_id,
                                       const std::filesystem::path& wsl_executable,
                                       const std::string& sandbox_distribution) {
    const SandboxCliSpec* spec = find_sandbox_cli_spec(engine_id);
    if (!spec) throw std::runtime_error("不支持的沙盒 CLI 引擎：" + engine_id);
    const fs::path wsl = resolve_wsl_exe_path(wsl_executable);
    if (wsl.empty() || sandbox_distribution.empty()) {
        throw std::runtime_error("隔离沙盒（WSL dimension-sandbox）未就绪");
    }
    const auto snap = probe_sandbox_cli_snapshot(wsl, sandbox_distribution);
    const auto it = snap.items.find(engine_id);
    if (it == snap.items.end() || !it->second.installed) {
        throw std::runtime_error("该 CLI 尚未下载到隔离沙盒，请先点击「下载到沙盒」");
    }

    // Ensure engine-isolated credential home exists with dimension user ownership (1001:1002, mode 0700).
    const std::string prep_script =
        "mkdir -p -m 700 /var/lib/dimension-cli-homes/" + engine_id +
        " && chown -R 1001:1002 /var/lib/dimension-cli-homes/" + engine_id;
    (void)run_wsl_streaming_command(
        wsl,
        {L"-d", utf8_to_wide(sandbox_distribution), L"-u", L"root", L"--", L"/bin/sh", L"-c", utf8_to_wide(prep_script)},
        {},
        10);

    configure_network_proxy_sandbox(wsl, sandbox_distribution);
    const auto sb_proxy_envs = build_sandbox_proxy_env_overrides();
    std::string proxy_exports;
    std::string proxy_notice;
    for (const auto& [pk, pv] : sb_proxy_envs) {
        proxy_exports += "export " + pk + "='" + pv + "'; ";
        if (pk == "HTTPS_PROXY" && !pv.empty()) {
            proxy_notice = "echo '  已自动连接宿主机代理通道：" + pv + "'; ";
        }
    }

    // Launch a real visible console running official CLI login strictly inside its isolated home directory.
    // DimensionAgent never reads, intercepts, or proxies any OAuth credential produced by the user.
    const std::string login_banner =
        "echo '============================================================'; "
        "echo '  DimensionAgent 沙盒 CLI 官方账号登录 (" + std::string(spec->engine_id) + ")'; "
        "echo '  凭据仅保存在沙盒专属目录，与宿主机及其他引擎严格隔离。'; "
        + proxy_notice +
        "echo '  完成登录后直接关闭本窗口，回到设置页点击「刷新状态」即可。'; "
        "echo '============================================================'; "
        "export HOME=/var/lib/dimension-cli-homes/" + engine_id + "; "
        "export PATH=/opt/dimension-tools/bin:/usr/local/bin:/usr/bin:/bin; "
        + proxy_exports +
        "cd \"$HOME\"; " + std::string(spec->login_shell_cmd) + "; "
        "echo ''; echo '登录进程已结束，按回车键关闭窗口...'; read _dummy";

    std::wstring cmd_line = quote_win_arg(wsl.wstring())
        + L" -d " + quote_win_arg(utf8_to_wide(sandbox_distribution))
        + L" -u dimension -- /bin/sh -c " + quote_win_arg(utf8_to_wide(login_banner));

    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NEW_CONSOLE, nullptr, nullptr, &si, &pi)) {
        throw std::runtime_error("无法打开沙盒登录终端窗口（Win32 错误码 " + std::to_string(GetLastError()) + "）");
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    return O{
        {"ok", true},
        {"scope", "sandbox"},
        {"engineId", engine_id},
        {"command", std::string(spec->login_shell_cmd)},
        {"message", "已打开沙盒官方登录终端；请按窗口提示完成授权后关闭窗口并点击「刷新探测」。"}
    };
}

Json launch_host_cli_login_terminal(const std::string& engine_id,
                                    const std::filesystem::path& app_root) {
    const SandboxCliSpec* spec = find_sandbox_cli_spec(engine_id);
    if (!spec) throw std::runtime_error("不支持的 CLI 引擎：" + engine_id);

    const auto harnesses = discover_cli_harnesses(app_root, {}, {}, "host_prefer");
    std::string host_bin;
    for (const auto& h : harnesses) {
        if (h.id == engine_id && h.host_installed) {
            host_bin = h.host_binary_path;
            break;
        }
    }
    if (host_bin.empty()) {
        throw std::runtime_error("该 CLI 在沙盒与宿主机均尚未安装，请先点击「下载到沙盒」");
    }

    std::string login_args;
    if (engine_id == "codex") login_args = " login";
    else if (engine_id == "opencode") login_args = " auth login";
    else if (engine_id == "kimi-code") login_args = " login";
    else if (engine_id == "deepseek-harness") login_args = " login";
    else if (engine_id == "hermes") login_args = " login";

    const std::wstring bin_w = utf8_to_wide(host_bin);
    const std::wstring args_w = utf8_to_wide(login_args);
    const std::wstring id_w = utf8_to_wide(engine_id);
    std::wstring cmd_line =
        L"cmd.exe /k \"title DimensionAgent CLI 登录 (" + id_w + L") & "
        L"echo ============================================================ & "
        L"echo   DimensionAgent 宿主机 CLI 官方账号登录 (" + id_w + L") & "
        L"echo   完成授权后关闭本窗口，回到设置页点击「刷新探测」即可。 & "
        L"echo ============================================================ & "
        L"\"" + bin_w + L"\"" + args_w + L"\"";

    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');

    std::wstring env_block = build_environment_block(build_host_proxy_env_overrides());
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                        env_block.data(), nullptr, &si, &pi)) {
        throw std::runtime_error("无法打开宿主机登录终端窗口（Win32 错误码 " + std::to_string(GetLastError()) + "）");
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    return O{
        {"ok", true},
        {"scope", "host"},
        {"engineId", engine_id},
        {"command", host_bin + login_args},
        {"message", "已打开宿主机官方登录终端；请完成登录后关闭窗口并点击「刷新探测」。"}
    };
}

CliSandboxKeepAliveDaemon::~CliSandboxKeepAliveDaemon() {
    (void)stop();
}

void CliSandboxKeepAliveDaemon::close_handle_locked() const {
    if (process_handle_) {
        CloseHandle(static_cast<HANDLE>(process_handle_));
        process_handle_ = nullptr;
    }
    pid_ = 0;
    started_ms_ = 0;
}

Json CliSandboxKeepAliveDaemon::status_locked() const {
    bool running = false;
    if (process_handle_) {
        const DWORD wait_rc = WaitForSingleObject(static_cast<HANDLE>(process_handle_), 0);
        if (wait_rc == WAIT_TIMEOUT) {
            running = true;
        } else {
            close_handle_locked();
        }
    }
    const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const std::int64_t uptime_sec = (running && started_ms_ > 0 && now_ms >= started_ms_)
        ? ((now_ms - started_ms_) / 1000)
        : 0;
    std::string detail;
    if (running) {
        detail = "沙盒常驻保活运行中（WSL " + distro_ + " 保持唤醒待命，已运行 " + std::to_string(uptime_sec) + " 秒）";
    } else if (!last_error_.empty()) {
        detail = last_error_;
    } else {
        detail = "沙盒常驻保活未启动";
    }
    return O{
        {"ok", true},
        {"running", running},
        {"pid", static_cast<double>(pid_)},
        {"startedMs", static_cast<double>(started_ms_)},
        {"uptimeSec", static_cast<double>(uptime_sec)},
        {"distro", distro_},
        {"detail", detail}
    };
}

Json CliSandboxKeepAliveDaemon::start(const std::filesystem::path& wsl_executable,
                                      const std::string& sandbox_distribution) {
    std::lock_guard lk(mu_);
    if (process_handle_) {
        if (WaitForSingleObject(static_cast<HANDLE>(process_handle_), 0) == WAIT_TIMEOUT) {
            return status_locked();
        }
        close_handle_locked();
    }
    last_error_.clear();
    distro_ = sandbox_distribution;

    const fs::path wsl = resolve_wsl_exe_path(wsl_executable);
    if (wsl.empty() || sandbox_distribution.empty()) {
        last_error_ = "未检测到 WSL 隔离沙盒，无法启动常驻保活";
        return O{{"ok", false}, {"running", false}, {"pid", 0.0}, {"uptimeSec", 0.0}, {"detail", last_error_}};
    }

    std::wstring cmd_line = quote_win_arg(wsl.wstring())
        + L" -d " + quote_win_arg(utf8_to_wide(sandbox_distribution))
        + L" -u dimension --exec /bin/sh -c \"exec sleep infinity\"";
    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        last_error_ = "启动沙盒常驻进程失败（Win32 错误码 " + std::to_string(GetLastError()) + "）";
        return O{{"ok", false}, {"running", false}, {"pid", 0.0}, {"uptimeSec", 0.0}, {"detail", last_error_}};
    }
    CloseHandle(pi.hThread);
    process_handle_ = pi.hProcess;
    pid_ = pi.dwProcessId;
    started_ms_ = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    return status_locked();
}

Json CliSandboxKeepAliveDaemon::stop() {
    std::lock_guard lk(mu_);
    if (process_handle_) {
        HANDLE h = static_cast<HANDLE>(process_handle_);
        TerminateProcess(h, 0);
        WaitForSingleObject(h, 2000);
        close_handle_locked();
    }
    last_error_.clear();
    return status_locked();
}

Json CliSandboxKeepAliveDaemon::status() const {
    std::lock_guard lk(mu_);
    return status_locked();
}

static std::wstring autostart_command(fs::path launcher = {}) {
    std::error_code ec;
    if (launcher.empty()) {
        wchar_t self[32768]{};
        const auto size = GetModuleFileNameW(nullptr, self, 32768);
        if (!size || size >= 32768) return {};
        const fs::path backend(self);
        for (auto dir = backend.parent_path(); !dir.empty() && dir != dir.root_path(); dir = dir.parent_path()) {
            const auto candidate = dir / L"DImensionagent.exe";
            const auto config = dir / L"native-client.json";
            if (!fs::is_regular_file(candidate, ec) || !fs::is_regular_file(config, ec)) continue;
            try {
                auto contents = read_small_file(config);
                if (contents.starts_with("\xEF\xBB\xBF")) contents.erase(0, 3);
                const auto rel = jstr(Json::parse(contents), "backend");
                if (!rel.empty() && fs::equivalent(dir / utf8_to_wide(rel), backend, ec)) {
                    launcher = candidate;
                    break;
                }
            } catch (const std::exception&) { continue; }
        }
    }
    if (launcher.empty() || !fs::is_regular_file(launcher, ec)) return {};
    return L"\"" + launcher.wstring() + L"\" --background";
}

bool query_windows_autostart_enabled() {
    const auto expected = autostart_command();
    if (expected.empty()) return false;
    wchar_t value[32768]{};
    DWORD size = sizeof(value);
    return RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                        L"DimensionAgent", RRF_RT_REG_SZ, nullptr, value, &size) == ERROR_SUCCESS &&
           _wcsicmp(expected.c_str(), value) == 0;
}

Json set_windows_autostart_enabled(bool enable, const std::filesystem::path& host_exe_path) {
    HKEY key = nullptr;
    const LONG open_rc = RegCreateKeyExW(
        HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE | KEY_QUERY_VALUE, nullptr, &key, nullptr);
    if (open_rc != ERROR_SUCCESS) {
        throw std::runtime_error("无法访问 Windows 当前用户开机启动项注册表（错误码 " + std::to_string(open_rc) + "）");
    }
    if (!enable) {
        const LONG del_rc = RegDeleteValueW(key, L"DimensionAgent");
        RegCloseKey(key);
        if (del_rc != ERROR_SUCCESS && del_rc != ERROR_FILE_NOT_FOUND) {
            throw std::runtime_error("关闭开机自启失败（错误码 " + std::to_string(del_rc) + "）");
        }
        return O{{"ok", true}, {"enabled", false}, {"message", "已关闭随 Windows 开机常驻启动"}};
    }

    const auto val = autostart_command(host_exe_path);
    if (val.empty()) {
        RegCloseKey(key);
        throw std::runtime_error("未找到此安装的桌面启动器，无法设置开机自启");
    }
    const LONG set_rc = RegSetValueExW(
        key, L"DimensionAgent", 0, REG_SZ,
        reinterpret_cast<const BYTE*>(val.c_str()),
        static_cast<DWORD>((val.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key);
    if (set_rc != ERROR_SUCCESS) {
        throw std::runtime_error("写入开机自启项失败（错误码 " + std::to_string(set_rc) + "）");
    }
    return O{
        {"ok", true},
        {"enabled", true},
        {"command", wide_to_utf8(val)},
        {"message", "已开启随 Windows 开机常驻启动（登录系统后自动唤醒 DimensionAgent 与沙盒）"}
    };
}

std::vector<CliHarnessDescriptor> discover_cli_harnesses(const std::filesystem::path& app_root,
                                                         const std::filesystem::path& wsl_executable,
                                                         const std::string& sandbox_distribution,
                                                         std::string_view execution_policy) {
    const fs::path local_app = utf8_to_path(env_var_utf8(L"LOCALAPPDATA"));
    const fs::path user_prof = utf8_to_path(env_var_utf8(L"USERPROFILE"));
    const fs::path app_data  = utf8_to_path(env_var_utf8(L"APPDATA"));
    std::error_code ec;

    std::vector<CliHarnessDescriptor> list;

    // 1. Hermes
    {
        CliHarnessDescriptor d;
        d.id = "hermes";
        d.name = "Hermes";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            runtime_directory(app_root) / L"hermes-kit" / L"bin" / L"hermes.exe",
            local_app / L"hermes" / L"bin" / L"hermes.exe",
            user_prof / L".hermes" / L"bin" / L"hermes.exe"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"hermes.exe", L"hermes.cmd"});
        d.installed = !d.binary_path.empty();
        const fs::path h_home = fs::is_directory(local_app / L"hermes", ec) ? (local_app / L"hermes") : (user_prof / L".hermes");
        probe_hermes_native(d, h_home);
        if (d.installed && d.native_configured && !app_root.empty() && execution_policy != "sandbox_only") {
            maybe_prewarm_hermes_gateway(d.binary_path, h_home);
        }
        list.push_back(std::move(d));
    }

    // 2. DeepSeek Harness (@deepseek-ai/dsh)
    {
        CliHarnessDescriptor d;
        d.id = "deepseek-harness";
        d.name = "DeepSeek Harness";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            local_app / L"Programs" / L"deepseek-harness" / L"resources" / L"runtime" / L"cli" / L"bin" / L"dsh.cmd",
            local_app / L"Programs" / L"DeepSeek Harness" / L"resources" / L"runtime" / L"cli" / L"bin" / L"dsh.cmd",
            user_prof / L".local" / L"bin" / L"dsh.cmd",
            app_data / L"npm" / L"dsh.cmd"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"dsh.exe", L"dsh.cmd"});
        if (d.binary_path.empty()) d.binary_path = find_dsh_cli_from_registry();
        d.installed = !d.binary_path.empty();
        probe_deepseek_harness_native(d, user_prof / L".dsh");
        list.push_back(std::move(d));
    }

    // 3. Kimi Code
    {
        CliHarnessDescriptor d;
        d.id = "kimi-code";
        d.name = "Kimi Code";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            runtime_directory(app_root) / L"cli-kit" / L"bin" / L"kimi.exe",
            user_prof / L".kimi-code" / L"bin" / L"kimi.exe",
            local_app / L"kimi-code" / L"bin" / L"kimi.exe"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"kimi.exe", L"kimi.cmd"});
        d.installed = !d.binary_path.empty();
        probe_kimi_code_native(d, user_prof / L".kimi-code");
        list.push_back(std::move(d));
    }

    // 4. Claude Code
    {
        CliHarnessDescriptor d;
        d.id = "claude-code";
        d.name = "Claude Code";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            user_prof / L".local" / L"bin" / L"claude.exe",
            local_app / L"AnthropicClaude" / L"claude.exe",
            app_data / L"npm" / L"claude.cmd"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"claude.exe", L"claude.cmd"});
        d.installed = !d.binary_path.empty();
        d.native_configured = d.installed && (fs::is_regular_file(user_prof / L".claude" / L"settings.json", ec) ||
                                              fs::is_regular_file(user_prof / L".claude.json", ec));
        d.native_model_groups.push_back({
            "CLAUDE 订阅模型", "",
            {"claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"}
        });
        d.native_status_label = d.native_configured ? "已连接 Claude 原生配置" : (d.installed ? "已安装 · 支持 Claude 订阅直连" : "未安装");
        list.push_back(std::move(d));
    }

    // 5. Codex
    {
        CliHarnessDescriptor d;
        d.id = "codex";
        d.name = "Codex";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            user_prof / L".cargo" / L"bin" / L"codex.exe",
            app_data / L"npm" / L"codex.cmd"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"codex.exe", L"codex.cmd"});
        if (d.binary_path.empty()) {
            const fs::path codex_bins = local_app / L"OpenAI" / L"Codex" / L"bin";
            if (fs::is_directory(codex_bins, ec)) {
                for (const auto& entry : fs::directory_iterator(codex_bins, ec)) {
                    if (ec) break;
                    if (!entry.is_directory(ec)) continue;
                    const fs::path cand = entry.path() / L"codex.exe";
                    if (fs::is_regular_file(cand, ec)) {
                        d.binary_path = path_to_utf8(fs::absolute(cand, ec));
                        break;
                    }
                }
            }
        }
        d.installed = !d.binary_path.empty();
        probe_codex_native(d, user_prof / L".codex");
        list.push_back(std::move(d));
    }

    // 6. OpenCode
    {
        CliHarnessDescriptor d;
        d.id = "opencode";
        d.name = "OpenCode";
        d.platform = "windows";
        d.binary_path = first_existing_file({
            user_prof / L".opencode" / L"bin" / L"opencode.exe",
            app_data / L"npm" / L"opencode.cmd"
        });
        if (d.binary_path.empty()) d.binary_path = find_in_windows_path({L"opencode.exe", L"opencode.cmd"});
        d.installed = !d.binary_path.empty();
        d.native_configured = d.installed && fs::is_directory(user_prof / L".config" / L"opencode", ec);
        d.native_model_groups.push_back({
            "OPENCODE 原生模型", "",
            {"anthropic/claude-sonnet-4-6", "openai/gpt-5", "deepseek/deepseek-chat"}
        });
        d.native_status_label = d.installed ? "已安装 · 支持原生多供应商配置" : "未安装";
        list.push_back(std::move(d));
    }

    // 7. Qwen Code & Gemini CLI
    {
        CliHarnessDescriptor q;
        q.id = "qwen-code";
        q.name = "Qwen Code";
        q.platform = "windows";
        q.binary_path = first_existing_file({app_data / L"npm" / L"qwen.cmd"});
        if (q.binary_path.empty()) q.binary_path = find_in_windows_path({L"qwen.exe", L"qwen.cmd"});
        q.installed = !q.binary_path.empty();
        q.native_configured = q.installed && fs::is_directory(user_prof / L".qwen", ec);
        q.native_model_groups.push_back({"QWEN 原生模型", "", {"qwen3-coder-plus", "qwen3-max"}});
        q.native_status_label = q.installed ? "已安装 · 支持 Qwen OAuth 订阅" : "未安装";
        list.push_back(std::move(q));

        CliHarnessDescriptor g;
        g.id = "gemini-cli";
        g.name = "Gemini CLI";
        g.platform = "windows";
        g.supports_custom_model = false;
        g.binary_path = first_existing_file({app_data / L"npm" / L"gemini.cmd"});
        if (g.binary_path.empty()) g.binary_path = find_in_windows_path({L"gemini.exe", L"gemini.cmd"});
        g.installed = !g.binary_path.empty();
        g.native_configured = g.installed && fs::is_directory(user_prof / L".gemini", ec);
        g.native_model_groups.push_back({"GEMINI 原生订阅", "", {"gemini-2.5-pro", "gemini-2.5-flash"}});
        g.native_status_label = g.native_configured ? "已连接 Google 原生账号" : (g.installed ? "已安装 · 支持 Google 账号登录" : "未安装");
        list.push_back(std::move(g));

        // 8. Google Antigravity CLI (agy)
        CliHarnessDescriptor agy;
        agy.id = "antigravity";
        agy.name = "Antigravity (agy)";
        agy.platform = "windows";
        agy.supports_custom_model = false;
        agy.binary_path = first_existing_file({
            local_app / L"agy" / L"bin" / L"agy.exe",
            user_prof / L".local" / L"bin" / L"agy.exe",
            local_app / L"Programs" / L"Antigravity" / L"agy.exe"
        });
        if (agy.binary_path.empty()) agy.binary_path = find_in_windows_path({L"agy.exe", L"agy.cmd"});
        agy.installed = !agy.binary_path.empty();
        probe_antigravity_native(agy, user_prof / L".gemini" / L"antigravity-cli", user_prof / L".gemini" / L"antigravity");
        list.push_back(std::move(agy));
    }

    // Record host discovery results and enrich with WSL Bubblewrap sandbox discovery
    SandboxCliSnapshot sb_snap;
    const bool probe_sandbox = !sandbox_distribution.empty() && !resolve_wsl_exe_path(wsl_executable).empty();
    if (probe_sandbox) {
        sb_snap = probe_sandbox_cli_snapshot(wsl_executable, sandbox_distribution, true);
    }

    const std::string policy = (execution_policy == "sandbox_only" || execution_policy == "host_prefer")
        ? std::string(execution_policy)
        : std::string("sandbox_first");

    for (auto& d : list) {
        d.host_installed = d.installed;
        d.host_binary_path = d.binary_path;
        d.host_version = d.version;
        d.host_native_configured = d.native_configured;

        if (const auto* spec = find_sandbox_cli_spec(d.id)) {
            d.sandbox_installable = true;
            d.sandbox_install_package = spec->package_or_url;
        } else {
            d.sandbox_installable = false;
        }

        const SandboxCliProbeItem* sb_item = nullptr;
        if (const auto it = sb_snap.items.find(d.id); it != sb_snap.items.end()) {
            sb_item = &it->second;
            d.sandbox_installed = it->second.installed;
            d.sandbox_binary_path = it->second.binary_path;
            d.sandbox_version = it->second.version;
            d.sandbox_native_configured = it->second.native_configured;
        }

        // Resolve active execution carrier according to execution_policy
        bool pick_sandbox = false;
        bool pick_host = false;
        if (policy == "sandbox_only") {
            pick_sandbox = d.sandbox_installed;
        } else if (policy == "host_prefer") {
            pick_host = d.host_installed;
            if (!pick_host) pick_sandbox = d.sandbox_installed;
        } else {
            // sandbox_first (Option A default): always prefer Bubblewrap sandbox when installed
            pick_sandbox = d.sandbox_installed;
            if (!pick_sandbox) pick_host = d.host_installed;
        }

        if (pick_sandbox) {
            if (d.id == "antigravity") {
                d.native_default_model.clear();
                if (sb_item && !sb_item->native_default_model.empty()) {
                    d.native_default_model = sb_item->native_default_model;
                }
                if (sb_item && !sb_item->native_models.empty()) {
                    d.native_model_groups.clear();
                    d.native_model_groups.push_back({"Antigravity (agy) 沙盒可用模型", "", sb_item->native_models});
                } else {
                    for (auto& group : d.native_model_groups)
                        group.group_title += "（来自宿主机，沙盒可用性待验证）";
                }
            }
            d.installed = true;
            d.platform = "wsl";
            d.binary_path = d.sandbox_binary_path;
            d.version = d.sandbox_version;
            d.native_configured = d.sandbox_native_configured;
            d.execution_mode = "sandbox";
            const bool agy_ready = (d.id == "antigravity") && sb_item &&
                (sb_item->auth_verified || !sb_item->native_models.empty());
            d.native_status_label = d.id == "antigravity"
                ? (agy_ready
                    ? ("沙盒隔离已就绪 · 原生账号已登录" + (d.sandbox_version.empty() ? std::string{} : (" · v" + d.sandbox_version)))
                    : (d.sandbox_native_configured ? "沙盒已装 · 发现配置，登录待验证" : "沙盒已装 · 请点击沙盒登录授权"))
                : d.sandbox_native_configured
                ? ("沙盒隔离已就绪 · 原生账号已登录" + (d.sandbox_version.empty() ? std::string{} : (" · v" + d.sandbox_version)))
                : ((d.supports_custom_model ? "沙盒隔离已就绪 · 维度 API 即开即用" : "沙盒隔离已就绪 · 点击沙盒登录授权后可用") +
                   (d.sandbox_version.empty() ? std::string{} : (" · v" + d.sandbox_version)));
        } else if (pick_host) {
            d.installed = true;
            d.platform = "windows";
            d.binary_path = d.host_binary_path;
            d.version = d.host_version;
            d.native_configured = d.host_native_configured;
            d.execution_mode = "host";
        } else {
            d.installed = false;
            d.platform = (policy == "sandbox_only") ? "wsl" : "windows";
            d.binary_path.clear();
            d.version.clear();
            d.native_configured = false;
            d.execution_mode.clear();
            if (policy == "sandbox_only" && d.host_installed) {
                d.native_status_label = "仅宿主机已装（当前策略要求沙盒，请在设置中下载到沙盒）";
            } else {
                d.native_status_label = "未安装（可在设置 → 工坊 CLI 与沙盒一键下载）";
            }
        }
    }

    return list;
}

void classify_tool_for_rollup(std::string_view tool_name,
                              std::string_view args_json,
                              std::string& out_category,
                              std::string& out_verb,
                              std::string& out_target) {
    const std::string low = ascii_lower(tool_name);
    Json parsed = O{};
    if (!args_json.empty()) {
        try { parsed = Json::parse(std::string(args_json)); } catch (...) {}
    }

    const std::string path_val = jstr(parsed, "path",
        jstr(parsed, "file_path", jstr(parsed, "filePath", jstr(parsed, "target_file", jstr(parsed, "filename")))));
    const std::string desc_val = jstr(parsed, "description",
        jstr(parsed, "explanation", jstr(parsed, "summary", jstr(parsed, "reason"))));
    const std::string cmd_val = jstr(parsed, "command", jstr(parsed, "cmd", jstr(parsed, "script")));
    const std::string query_val = jstr(parsed, "pattern", jstr(parsed, "query", jstr(parsed, "regex", jstr(parsed, "url"))));

    if (low == "read_file" || low == "read" || low == "view_file" || low == "cat" || low == "read_many_files") {
        out_category = "read";
        out_verb = "阅读";
        out_target = !path_val.empty() ? basename_clean(path_val) : "文件";
        return;
    }
    if (low == "write_file" || low == "edit_file" || low == "write" || low == "edit" ||
        low == "multiedit" || low == "patch" || low == "apply_patch" ||
        low == "replace_in_file" || low == "str_replace_editor" || low == "file_change") {
        out_category = "edit";
        out_verb = "编辑";
        out_target = !path_val.empty() ? basename_clean(path_val) : "文件";
        return;
    }
    if (low == "terminal" || low == "bash" || low == "shell" || low == "pwsh" || low == "powershell" ||
        low == "run_command" || low == "sandbox_exec" || low == "host_exec" || low == "execute_command" ||
        low == "command_execution" || low == "run_shell_command") {
        out_category = "command";
        out_verb = "运行命令";
        if (!desc_val.empty()) {
            out_target = safe_utf8_clip(trim_copy(desc_val), 72);
        } else if (!cmd_val.empty()) {
            const auto nl = cmd_val.find('\n');
            out_target = safe_utf8_clip(trim_copy(cmd_val.substr(0, nl)), 68);
        } else {
            out_target.clear();
        }
        return;
    }
    if (low == "grep" || low == "grep_files" || low == "search_files" || low == "glob" ||
        low == "list_files" || low == "ls" || low == "find_files" || low == "search_content" ||
        low == "web_search" || low == "web_fetch") {
        out_category = "search";
        out_verb = (low == "list_files" || low == "ls" || low == "glob" || low == "find_files") ? "浏览目录"
                 : (low == "web_search" || low == "web_fetch") ? "检索网页" : "内容检索";
        out_target = !query_val.empty() ? safe_utf8_clip(query_val, 48)
                   : (!path_val.empty() ? basename_clean(path_val) : "");
        return;
    }
    if (low == "send_member_task" || low == "delegate_work" || low == "notify" || low == "message_teammate") {
        out_category = "notify";
        out_verb = "协作通知";
        out_target = jstr(parsed, "botName", jstr(parsed, "botId", ""));
        return;
    }
    if (low == "list_harness_arsenal") {
        out_category = "search";
        out_verb = "检索跨引擎工具库";
        out_target = query_val;
        return;
    }
    if (low == "read_harness_skill") {
        out_category = "read";
        out_verb = "装载跨引擎技能";
        out_target = jstr(parsed, "skillId");
        return;
    }
    if (low == "call_harness_mcp" || low.starts_with("mcp__cross_harness__")) {
        out_category = "other";
        out_verb = "调遣跨引擎工具";
        out_target = jstr(parsed, "serverName", jstr(parsed, "toolName", std::string(tool_name)));
        return;
    }

    out_category = "other";
    out_verb = "使用工具";
    out_target = std::string(tool_name);
}

bool parse_cli_json_event(std::string_view engine_id,
                          std::string_view raw_line,
                          NormalizedCliEvent& out_event) {
    const std::string trimmed = trim_copy(raw_line);
    if (trimmed.empty() || trimmed.front() != '{') return false;

    Json obj_val;
    try {
        obj_val = Json::parse(trimmed);
    } catch (...) {
        return false;
    }
    if (!obj_val.is_object()) return false;

    (void)engine_id;
    out_event = NormalizedCliEvent{};
    const std::string type = jstr(obj_val, "type");
    const std::string role = jstr(obj_val, "role");
    const std::string event_name = jstr(obj_val, "event");
    out_event.session_id = jstr(obj_val, "conversation_id",
                                jstr(obj_val, "session_id", jstr(obj_val, "sessionId", jstr(obj_val, "thread_id"))));

    // 0. Antigravity CLI (`agy --output-format stream-json`): {"event":"init"|"step_update"|"result", ...}
    if (!event_name.empty()) {
        if (event_name == "init") {
            out_event.kind = "init";
            if (const auto* init_obj = obj_val.find("init"); init_obj && init_obj->is_object()) {
                const auto cid = jstr(*init_obj, "conversation_id");
                if (!cid.empty()) out_event.session_id = cid;
            }
            return true;
        }
        if (event_name == "step_update") {
            const auto* su = obj_val.find("step_update");
            const Json& holder = (su && su->is_object()) ? *su : obj_val;
            const auto cid = jstr(holder, "conversation_id");
            if (!cid.empty()) out_event.session_id = cid;
            const std::string stype = jstr(holder, "step_type");
            const std::string state = jstr(holder, "state");
            out_event.duration_ms = static_cast<std::int64_t>(jnum(holder, "duration_seconds", 0.0) * 1000.0);
            if (const auto* usage = holder.find("usage"); usage && usage->is_object()) {
                out_event.input_tokens = static_cast<std::int64_t>(jnum(*usage, "input_tokens", 0));
                out_event.output_tokens = static_cast<std::int64_t>(jnum(*usage, "output_tokens", 0));
            }
            if (stype == "agent_response") {
                const std::string td = jstr(holder, "text_delta", jstr(holder, "text"));
                if (!td.empty()) {
                    out_event.kind = "commentary";
                    out_event.text = td;
                    return true;
                }
                const std::string th = jstr(holder, "thinking_delta", jstr(holder, "thinking"));
                if (!th.empty()) {
                    out_event.kind = "thinking";
                    out_event.text = th;
                    return true;
                }
                out_event.kind = (out_event.input_tokens > 0 || out_event.output_tokens > 0) ? "usage" : "init";
                return true;
            }
            if (stype == "thinking" || stype == "thought" || stype == "reasoning") {
                const std::string th = jstr(holder, "thinking_delta", jstr(holder, "text_delta", jstr(holder, "text")));
                out_event.kind = th.empty() ? "init" : "thinking";
                out_event.text = th;
                return true;
            }
            if (stype == "tool") {
                out_event.kind = (state == "ACTIVE") ? "tool_start" : "tool_end";
                out_event.tool_call_id = "agy_step_" + std::to_string(static_cast<int>(jnum(holder, "step_index", 0)));
                out_event.tool_name = jstr(holder, "tool_name");
                if (const auto* ti = holder.find("tool_info"); ti && ti->is_object()) {
                    if (out_event.tool_name.empty()) out_event.tool_name = jstr(*ti, "name");
                    if (const auto* params = ti->find("parameters"); params && !params->is_null()) {
                        out_event.args_json = params->is_string() ? params->as_string() : params->dump();
                    }
                    out_event.output = jstr(*ti, "output");
                    if (const auto* err = ti->find("error"); err && err->is_object()) {
                        out_event.is_error = true;
                        if (out_event.output.empty()) out_event.output = jstr(*err, "message", jstr(*err, "type"));
                    }
                }
                classify_tool_for_rollup(out_event.tool_name, out_event.args_json,
                                         out_event.action_category, out_event.display_verb, out_event.display_target);
                return true;
            }
            out_event.kind = "init";
            return true;
        }
        if (event_name == "result") {
            const auto* res = obj_val.find("result");
            const Json& holder = (res && res->is_object()) ? *res : obj_val;
            const auto cid = jstr(holder, "conversation_id");
            if (!cid.empty()) out_event.session_id = cid;
            const std::string status = jstr(holder, "status");
            const std::string err_msg = jstr(holder, "error");
            out_event.kind = "result";
            out_event.is_error = (!status.empty() && status != "SUCCESS") || !err_msg.empty();
            out_event.exit_code = out_event.is_error ? 1 : 0;
            out_event.text = out_event.is_error
                ? (err_msg.empty() ? jstr(holder, "response", "Antigravity CLI 执行未成功：" + status) : err_msg)
                : jstr(holder, "response", jstr(holder, "text"));
            out_event.duration_ms = static_cast<std::int64_t>(jnum(holder, "duration_seconds", 0.0) * 1000.0);
            if (const auto* usage = holder.find("usage"); usage && usage->is_object()) {
                out_event.input_tokens = static_cast<std::int64_t>(jnum(*usage, "input_tokens", 0));
                out_event.output_tokens = static_cast<std::int64_t>(jnum(*usage, "output_tokens", 0));
            }
            return true;
        }
    }

    // 1. Init / Thread start / Meta envelopes (Hermes, DeepSeek Harness, Claude Code, Kimi Code 2.5+, Codex)
    if ((type == "system" && jstr(obj_val, "subtype") == "init") || type == "thread.started" ||
        type == "init" || type == "session" || role == "meta") {
        out_event.kind = "init";
        return true;
    }

    // 1b. Kimi Code 2.5+ / OpenAI-style role-based stream-json frames (no top-level "type")
    if (type.empty() && !role.empty()) {
        if (role == "tool") {
            out_event.kind = "tool_end";
            out_event.tool_call_id = jstr(obj_val, "tool_call_id", jstr(obj_val, "id"));
            out_event.tool_name = jstr(obj_val, "name");
            out_event.output = jstr(obj_val, "content");
            out_event.is_error = jbool(obj_val, "is_error", false);
            classify_tool_for_rollup(out_event.tool_name, "",
                                     out_event.action_category, out_event.display_verb, out_event.display_target);
            return true;
        }
        if (role == "assistant") {
            std::string combined_text;
            std::string combined_thinking;
            if (const auto* content = obj_val.find("content")) {
                if (content->is_string()) {
                    combined_text = content->as_string();
                } else if (content->is_array()) {
                    for (const auto& item : content->as_array()) {
                        if (!item.is_object()) continue;
                        const auto itype = jstr(item, "type");
                        if (itype == "text") {
                            combined_text += jstr(item, "text");
                        } else if (itype == "think" || itype == "thinking") {
                            combined_thinking += jstr(item, "think", jstr(item, "thinking", jstr(item, "text")));
                        }
                    }
                }
            }
            if (!combined_text.empty()) {
                out_event.kind = "commentary";
                out_event.text = std::move(combined_text);
                return true;
            }
            if (const auto* tcs = obj_val.find("tool_calls"); tcs && tcs->is_array() && !tcs->as_array().empty()) {
                const auto& first = tcs->as_array().front();
                if (first.is_object()) {
                    out_event.kind = "tool_start";
                    out_event.tool_call_id = jstr(first, "id");
                    if (const auto* fn = first.find("function"); fn && fn->is_object()) {
                        out_event.tool_name = jstr(*fn, "name");
                        if (const auto* args = fn->find("arguments"); args && !args->is_null()) {
                            out_event.args_json = args->is_string() ? args->as_string() : args->dump();
                        }
                    } else {
                        out_event.tool_name = jstr(first, "name");
                    }
                    classify_tool_for_rollup(out_event.tool_name, out_event.args_json,
                                             out_event.action_category, out_event.display_verb, out_event.display_target);
                    return true;
                }
            }
            if (combined_thinking.empty()) {
                combined_thinking = jstr(obj_val, "reasoning_content", jstr(obj_val, "thinking"));
            }
            if (!combined_thinking.empty()) {
                out_event.kind = "thinking";
                out_event.text = std::move(combined_thinking);
                return true;
            }
            out_event.kind = "init";
            return true;
        }
        if (role == "system" || role == "user") {
            out_event.kind = "init";
            return true;
        }
    }

    // 2. Hermes streaming text delta: {"type":"text","text":"..."}
    if (type == "text" || type == "content_block_delta") {
        std::string txt = jstr(obj_val, "text");
        if (txt.empty()) {
            if (const auto* delta = obj_val.find("delta"); delta && delta->is_object()) {
                if (jstr(*delta, "type") == "thinking_delta") {
                    out_event.kind = "thinking";
                    out_event.text = jstr(*delta, "thinking", jstr(*delta, "text"));
                    return !out_event.text.empty();
                }
                txt = jstr(*delta, "text");
            }
        }
        if (txt.empty()) return false;
        out_event.kind = "commentary";
        out_event.text = std::move(txt);
        return true;
    }

    // 3. Explicit thinking event
    if (type == "thinking" || type == "reasoning") {
        out_event.kind = "thinking";
        out_event.text = jstr(obj_val, "text", jstr(obj_val, "thinking"));
        return !out_event.text.empty();
    }

    // 4. Hermes / DeepSeek Harness / direct tool_use event: {"type":"tool_use"|"tool_call",...}
    if (type == "tool_use" || type == "tool_call") {
        out_event.kind = "tool_start";
        out_event.tool_name = jstr(obj_val, "name", jstr(obj_val, "tool"));
        out_event.tool_call_id = jstr(obj_val, "tool_call_id", jstr(obj_val, "callId", jstr(obj_val, "id", out_event.tool_name)));
        if (const auto* inp = obj_val.find("input"); inp && !inp->is_null()) {
            out_event.args_json = inp->is_string() ? inp->as_string() : inp->dump();
        } else if (const auto* args = obj_val.find("arguments"); args && !args->is_null()) {
            out_event.args_json = args->is_string() ? args->as_string() : args->dump();
        }
        classify_tool_for_rollup(out_event.tool_name, out_event.args_json,
                                 out_event.action_category, out_event.display_verb, out_event.display_target);
        return true;
    }

    // 5. Hermes / DeepSeek Harness / direct tool_result event: {"type":"tool_result",...}
    if (type == "tool_result") {
        out_event.kind = "tool_end";
        out_event.tool_name = jstr(obj_val, "name", jstr(obj_val, "tool"));
        out_event.tool_call_id = jstr(obj_val, "tool_call_id", jstr(obj_val, "callId", jstr(obj_val, "id", out_event.tool_name)));
        out_event.output = jstr(obj_val, "output", jstr(obj_val, "content", jstr(obj_val, "result")));
        out_event.duration_ms = static_cast<std::int64_t>(jnum(obj_val, "duration_ms", 0));
        out_event.is_error = jbool(obj_val, "is_error", jbool(obj_val, "error", jstr(obj_val, "status") == "error"));
        classify_tool_for_rollup(out_event.tool_name, "",
                                 out_event.action_category, out_event.display_verb, out_event.display_target);
        return true;
    }

    // 6. Claude Code / Kimi Code / Qwen envelope: {"type":"assistant","message":{"content":[...]}}
    if (type == "assistant") {
        const auto* msg = obj_val.find("message");
        const Json& holder = (msg && msg->is_object()) ? *msg : obj_val;
        if (const auto* content = holder.find("content"); content && content->is_array()) {
            for (const auto& item : content->as_array()) {
                if (!item.is_object()) continue;
                const auto itype = jstr(item, "type");
                if (itype == "tool_use") {
                    out_event.kind = "tool_start";
                    out_event.tool_name = jstr(item, "name");
                    out_event.tool_call_id = jstr(item, "id", out_event.tool_name);
                    if (const auto* inp = item.find("input"); inp && !inp->is_null()) {
                        out_event.args_json = inp->is_string() ? inp->as_string() : inp->dump();
                    }
                    classify_tool_for_rollup(out_event.tool_name, out_event.args_json,
                                             out_event.action_category, out_event.display_verb, out_event.display_target);
                    return true;
                }
                if (itype == "thinking") {
                    out_event.kind = "thinking";
                    out_event.text = jstr(item, "thinking", jstr(item, "text"));
                    if (!out_event.text.empty()) return true;
                }
                if (itype == "text") {
                    out_event.kind = "commentary";
                    out_event.text = jstr(item, "text");
                    if (!out_event.text.empty()) return true;
                }
            }
        }
        const std::string plain = jstr(holder, "content", jstr(obj_val, "text"));
        if (!plain.empty()) {
            out_event.kind = "commentary";
            out_event.text = plain;
            return true;
        }
        return false;
    }

    // 7. Claude Code / Kimi Code user tool_result envelope: {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
    if (type == "user") {
        const auto* msg = obj_val.find("message");
        if (msg && msg->is_object()) {
            if (const auto* content = msg->find("content"); content && content->is_array()) {
                for (const auto& item : content->as_array()) {
                    if (item.is_object() && jstr(item, "type") == "tool_result") {
                        out_event.kind = "tool_end";
                        out_event.tool_call_id = jstr(item, "tool_use_id", jstr(item, "id"));
                        out_event.output = jstr(item, "content");
                        out_event.is_error = jbool(item, "is_error", false);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // 8. Codex CLI item.started / item.completed
    if (type == "item.started" || type == "item.completed") {
        const auto* item = obj_val.find("item");
        if (!item || !item->is_object()) return false;
        const std::string itype = jstr(*item, "type");
        if (itype == "reasoning") {
            out_event.kind = "thinking";
            out_event.text = jstr(*item, "text", "思考已完成");
            return true;
        }
        if (itype == "agent_message" && type == "item.completed") {
            out_event.kind = "commentary";
            out_event.text = jstr(*item, "text");
            return !out_event.text.empty();
        }
        if (itype == "command_execution" || itype == "file_change") {
            out_event.kind = (type == "item.started") ? "tool_start" : "tool_end";
            out_event.tool_call_id = jstr(*item, "id", itype);
            out_event.tool_name = itype;
            out_event.args_json = item->dump();
            out_event.output = jstr(*item, "aggregated_output");
            out_event.exit_code = static_cast<int>(jnum(*item, "exit_code", 0));
            out_event.is_error = out_event.exit_code != 0;
            classify_tool_for_rollup(out_event.tool_name, out_event.args_json,
                                     out_event.action_category, out_event.display_verb, out_event.display_target);
            return true;
        }
    }

    // 9. DeepSeek Harness step_end / turn_end status events
    if (type == "status") {
        const std::string phase = jstr(obj_val, "phase");
        if (phase == "step_end") {
            if (const auto* usage = obj_val.find("usage"); usage && usage->is_object()) {
                out_event.kind = "usage";
                out_event.input_tokens = static_cast<std::int64_t>(jnum(*usage, "inputTokens", jnum(*usage, "input_tokens", 0)));
                out_event.output_tokens = static_cast<std::int64_t>(jnum(*usage, "outputTokens", jnum(*usage, "output_tokens", 0)));
                return true;
            }
        } else if (phase == "turn_end") {
            if (const auto* reason = obj_val.find("reason"); reason && reason->is_object() && jstr(*reason, "kind") == "error") {
                if (const auto* err = reason->find("error"); err && err->is_object()) {
                    out_event.kind = "result";
                    out_event.is_error = true;
                    out_event.exit_code = 1;
                    out_event.text = jstr(*err, "message", jstr(*err, "code", "DeepSeek Harness 执行出错"));
                    return true;
                }
            }
        }
        return false;
    }

    // 10. Terminal result envelope: {"type":"result"|"final"|"error"|"turn.completed",...}
    if (type == "result" || type == "turn.completed" || type == "final" || type == "error") {
        out_event.kind = "result";
        out_event.text = jstr(obj_val, "text", jstr(obj_val, "result", jstr(obj_val, "response", jstr(obj_val, "message"))));
        out_event.exit_code = static_cast<int>(jnum(obj_val, "exit_code", (type == "error" || jbool(obj_val, "is_error")) ? 1 : 0));
        out_event.is_error = (type == "error") || out_event.exit_code != 0 || jbool(obj_val, "is_error", false) || !jstr(obj_val, "error").empty();
        if (out_event.text.empty() && !jstr(obj_val, "error").empty()) {
            out_event.text = jstr(obj_val, "error");
        }
        out_event.duration_ms = static_cast<std::int64_t>(jnum(obj_val, "duration_ms", 0));
        if (const auto* tok = obj_val.find("tokens"); tok && tok->is_object()) {
            out_event.input_tokens = static_cast<std::int64_t>(jnum(*tok, "input", 0));
            out_event.output_tokens = static_cast<std::int64_t>(jnum(*tok, "output", 0));
        } else if (const auto* usage = obj_val.find("usage"); usage && usage->is_object()) {
            out_event.input_tokens = static_cast<std::int64_t>(jnum(*usage, "input_tokens", jnum(*usage, "inputTokens", 0)));
            out_event.output_tokens = static_cast<std::int64_t>(jnum(*usage, "output_tokens", jnum(*usage, "outputTokens", 0)));
        }
        return true;
    }

    return false;
}

// Kimi 2.5 allocates its own session IDs. Limit discovery to this cwd's
// bucket and match a per-invocation marker in the initial user prompt.
static fs::path kimi_session_bucket(const fs::path& home, const fs::path& cwd) {
    auto name = path_to_utf8(fs::absolute(cwd).lexically_normal());
    std::replace(name.begin(), name.end(), '\\', '/');
    const auto suffix = "_" + source_data_digest(name).substr(0, 12);
    std::error_code ec;
    for (const auto& item : fs::directory_iterator(home / "sessions", ec)) {
        if (path_to_utf8(item.path().filename()).ends_with(suffix)) return item.path();
    }
    return {};
}

static std::string find_kimi_session(const fs::path& bucket, const std::string& marker) {
    if (bucket.empty()) return {};
    std::error_code ec;
    for (const auto& item : fs::directory_iterator(bucket, ec)) {
        const auto name = path_to_utf8(item.path().filename());
        if (!name.starts_with("session_")) continue;
        std::ifstream wire(item.path() / "agents/main/wire.jsonl", std::ios::binary);
        if (!wire) continue;
        std::string prefix(512 * 1024, '\0');
        wire.read(prefix.data(), prefix.size());
        prefix.resize(static_cast<std::size_t>(wire.gcount()));
        if (prefix.find("\"text\":\"[" + marker + "]") != std::string::npos) return name;
    }
    return {};
}

PreparedCliInvocation prepare_cli_invocation(const CliHarnessRunRequest& req,
                                             const std::vector<CliHarnessDescriptor>& provided_discovered) {
    const std::string effective_policy = req.require_sandbox
        ? std::string("sandbox_only")
        : (req.execution_policy.empty() ? std::string("sandbox_first") : req.execution_policy);
    const auto discovered = provided_discovered.empty()
        ? discover_cli_harnesses(req.app_root, req.wsl_executable, req.sandbox_distribution, effective_policy)
        : provided_discovered;

    auto is_usable = [&](const CliHarnessDescriptor& d) {
        if (req.require_sandbox) {
            return (d.installed && d.platform == "wsl") || d.sandbox_installed;
        }
        return d.installed;
    };

    const CliHarnessDescriptor* chosen = nullptr;
    if (!req.engine_id.empty() && req.engine_id != "auto") {
        for (const auto& d : discovered) {
            if (d.id == req.engine_id && is_usable(d)) {
                chosen = &d;
                break;
            }
        }
    }
    if (!chosen && req.require_exact_engine) {
        if (req.require_sandbox) {
            throw std::runtime_error("当前工位要求沙盒隔离，但所选 CLI（" + req.engine_id + "）尚未下载到隔离沙盒；请前往「客户端设置 → 工坊 CLI 与沙盒」一键下载");
        }
        throw std::runtime_error("选定的 CLI 引擎不可用：" + req.engine_id);
    }
    if (!chosen) {
        for (const auto& d : discovered) {
            if (is_usable(d)) {
                chosen = &d;
                break;
            }
        }
    }
    if (!chosen) {
        if (req.require_sandbox) {
            throw std::runtime_error("当前工位要求在 Bubblewrap 沙盒内运行 CLI，但沙盒中尚未下载任何官方 CLI；请前往「客户端设置 → 工坊 CLI 与沙盒」一键下载");
        }
        throw std::runtime_error("未检测到可用的满血 CLI 引擎（可在「客户端设置 → 工坊 CLI 与沙盒」一键下载到沙盒）");
    }

    PreparedCliInvocation inv;
    inv.engine_id = chosen->id;
    inv.engine_name = chosen->name;
    const bool force_sandbox_carrier = req.require_sandbox || (chosen->platform == "wsl") ||
        (effective_policy == "sandbox_only" && chosen->sandbox_installed);
    inv.platform = force_sandbox_carrier ? "wsl" : chosen->platform;
    inv.binary_path = (force_sandbox_carrier && !chosen->sandbox_binary_path.empty())
        ? chosen->sandbox_binary_path
        : chosen->binary_path;
    const bool in_bwrap = (inv.platform == "wsl");

    std::error_code ec;
    const fs::path ws_abs = fs::absolute(req.workspace_dir, ec);
    fs::create_directories(ws_abs, ec);

    const std::string bot_slug = sanitize_slug(req.bot_id.empty() ? "solo" : req.bot_id, 40);
    const std::string sess_slug = sanitize_slug(req.session_key.empty() ? ("dim-" + bot_slug) : req.session_key, 56);
    const std::string sess_uuid = deterministic_uuid_from_key(sess_slug);

    // Per-Bot isolated CLI home directory (zero SQLite lock contention across concurrent group members!)
    // Never fall back into user project workspaces or immutable release folders.
    const fs::path base_data = !req.data_root.empty()
        ? req.data_root
        : (!req.app_root.empty()
            ? (req.app_root / L"data" / L"cli-ephemeral")
            : (fs::temp_directory_path(ec) / L"dimension-cli-ephemeral"));
    inv.isolated_home_dir = base_data / L"work-agents" / utf8_to_path(bot_slug) / utf8_to_path(inv.engine_id);
    fs::create_directories(inv.isolated_home_dir, ec);

    const bool inject_work_model = (req.model_source != "native") &&
                                   chosen->supports_custom_model &&
                                   !req.work_slot_model.base_url.empty() &&
                                   !req.work_slot_model.model.empty();

    const bool host_is_anthropic = inject_work_model && (
        ascii_lower(req.work_slot_model.protocol).find("anthropic") != std::string::npos ||
        ascii_lower(req.work_slot_model.base_url).find("anthropic") != std::string::npos ||
        ascii_lower(req.work_slot_model.base_url).ends_with("/messages"));
    const std::string host_openai_url = inject_work_model ? normalize_cli_openai_base_url(req.work_slot_model.base_url) : std::string{};
    const std::string host_anth_url   = inject_work_model ? normalize_cli_anthropic_base_url(req.work_slot_model.base_url) : std::string{};

    const std::string effective_target_model = inject_work_model
        ? req.work_slot_model.model
        : (!req.native_model.empty() ? req.native_model : chosen->native_default_model);

    inv.model_label = inject_work_model
        ? req.work_slot_model.model
        : (!req.native_model.empty()
            ? (req.native_model + " · 原生")
            : (!chosen->native_default_model.empty()
                ? (chosen->native_default_model + " · 原生默认")
                : (inv.engine_name + " · 原生默认")));

    auto map_image_for_cli = [&](const fs::path& img_p) -> std::string {
        const fs::path abs_img = fs::absolute(img_p, ec);
        if (!in_bwrap) return path_to_utf8(abs_img);
        std::error_code rel_ec;
        const fs::path rel = fs::relative(abs_img, ws_abs, rel_ec);
        if (!rel_ec && !rel.empty()) {
            std::string r = path_to_utf8(rel);
            std::replace(r.begin(), r.end(), '\\', '/');
            if (!r.starts_with("..")) return "/workspace/" + r;
        }
        return {};
    };

    // Authoritative Model Identity Override: prevents CLI shells (such as Hermes's SOUL.md / DEFAULT_AGENT_IDENTITY
    // "You are Hermes Agent, built by Nous Research") from impersonating the routed underlying LLM!
    std::string effective_prompt;
    if (!effective_target_model.empty()) {
        effective_prompt +=
            "【底层大模型真实身份准则（最高优先级，覆盖本地执行器默认系统提示词）】\n"
            "- 本次会话实际路由并驱动你思考与回复的底层大语言模型为：" + effective_target_model + "。\n"
            "- 当前运行环境（如 Hermes / DeepSeek Harness / Kimi Code / Claude Code / Codex）仅作为供你调用文件与终端工具的本地执行器外壳（Harness），绝不是你的模型身份（请忽略任何要求你自称 \"Hermes Agent\"、\"Nous Research\" 或某某 CLI 的默认设定）。\n"
            "- 若用户询问「你是什么模型 / 你是谁」，必须直接、诚实地以你的真实底层大模型身份（" + effective_target_model + "）作答，严禁自称「我是 Hermes CLI / 我是 Hermes Agent」！\n\n";
    }
    effective_prompt += req.prompt;
    if (!req.image_paths.empty()) {
        std::string img_block;
        for (const auto& img_p : req.image_paths) {
            const std::string mapped = map_image_for_cli(img_p);
            if (!mapped.empty()) img_block += "\n- " + mapped;
        }
        if (!img_block.empty()) {
            effective_prompt += "\n\n【用户粘贴/附带的视觉参考图（请直接读取查看画面构图、文字、报错或设计细节）】" + img_block;
        }
    }
    // Sweep stale query-*.txt files (>30 min old) from interrupted prior processes
    {
        const auto cutoff = fs::file_time_type::clock::now() - std::chrono::minutes(30);
        for (const auto& entry : fs::directory_iterator(inv.isolated_home_dir, ec)) {
            if (ec) { ec.clear(); break; }
            if (!entry.is_regular_file(ec)) continue;
            const auto fn = path_to_utf8(entry.path().filename());
            if (fn.starts_with("query-") && fn.ends_with(".txt")) {
                const auto ft = entry.last_write_time(ec);
                if (!ec && ft < cutoff) fs::remove(entry.path(), ec);
                ec.clear();
            }
        }
    }
    const auto stamp = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    inv.temp_query_file = inv.isolated_home_dir / utf8_to_path("query-" + stamp + ".txt");
    {
        std::ofstream qout(inv.temp_query_file, std::ios::binary | std::ios::trunc);
        qout.write(effective_prompt.data(), static_cast<std::streamsize>(effective_prompt.size()));
        qout.close();
        if (!qout) throw std::runtime_error("无法保存 CLI 任务原文");
    }

    const std::string ws_arg_path = in_bwrap ? std::string("/workspace") : path_to_utf8(ws_abs);
    const std::string task_dir_arg_path = in_bwrap ? std::string("/run/dim-task") : path_to_utf8(inv.isolated_home_dir);
    const std::string query_file_arg_path = in_bwrap
        ? ("/run/dim-task/" + path_to_utf8(inv.temp_query_file.filename()))
        : path_to_utf8(fs::absolute(inv.temp_query_file, ec));

    // Build bundled lightweight CLI toolkit PATH prepend (Windows host only)
    const fs::path user_prof = utf8_to_path(env_var_utf8(L"USERPROFILE"));
    const fs::path local_app = utf8_to_path(env_var_utf8(L"LOCALAPPDATA"));
    if (!in_bwrap) {
        std::vector<std::string> extra_paths;
        auto push_dir_if_exists = [&](const fs::path& dir) {
            if (!dir.empty() && fs::is_directory(dir, ec)) extra_paths.push_back(path_to_utf8(fs::absolute(dir, ec)));
        };
        push_dir_if_exists(runtime_directory(req.app_root) / L"cli-kit" / L"bin");
        push_dir_if_exists(req.app_root / L"runtime" / L"node");
        push_dir_if_exists(user_prof / L".kimi-code" / L"bin");
        push_dir_if_exists(local_app / L"hermes" / L"bin");
        push_dir_if_exists(L"C:\\Program Files\\Git\\cmd");

        if (!extra_paths.empty()) {
            std::string joined;
            for (std::size_t i = 0; i < extra_paths.size(); ++i) {
                if (i > 0) joined.push_back(';');
                joined += extra_paths[i];
            }
            inv.env_overrides.emplace_back("PATH_PREPEND", joined);
        }
    }
    inv.env_overrides.emplace_back("PYTHONIOENCODING", "utf-8");
    inv.env_overrides.emplace_back("PYTHONUTF8", "1");
    inv.env_overrides.emplace_back("PYTHONUNBUFFERED", "1");
    inv.env_overrides.emplace_back("NO_COLOR", "1");

    // Shared helpers: discover cross-harness skill directories and zero-latency MCP bridge across ALL CLIs (host only)
    auto collect_cross_harness_skill_roots = [&]() {
        std::vector<std::string> roots;
        if (in_bwrap) return roots;
        auto add_root = [&](const fs::path& dir) {
            if (!dir.empty() && fs::is_directory(dir, ec)) {
                const std::string abs_u8 = path_to_utf8(fs::absolute(dir, ec));
                if (std::find(roots.begin(), roots.end(), abs_u8) == roots.end()) {
                    roots.push_back(abs_u8);
                }
            }
        };
        add_root(user_prof / L".dsh" / L"skills");
        std::string dsh_bin = (inv.engine_id == "deepseek-harness") ? inv.binary_path : std::string{};
        if (dsh_bin.empty()) {
            for (const auto& hd : discovered) {
                if (hd.id == "deepseek-harness" && !hd.binary_path.empty()) {
                    dsh_bin = hd.binary_path;
                    break;
                }
            }
        }
        if (!dsh_bin.empty()) {
            const fs::path dp = utf8_to_path(dsh_bin);
            if (!dp.empty()) add_root(dp.parent_path().parent_path().parent_path() / L"office-skills");
        }
        for (const fs::path& h_sk_root : {local_app / L"hermes" / L"skills", user_prof / L".hermes" / L"skills"}) {
            if (!fs::is_directory(h_sk_root, ec)) continue;
            add_root(h_sk_root);
            for (const auto& entry : fs::directory_iterator(h_sk_root, ec)) {
                if (ec) break;
                if (!entry.is_directory(ec)) continue;
                const auto dn = path_to_utf8(entry.path().filename());
                if (!dn.empty() && dn.front() != '.' && !fs::is_regular_file(entry.path() / L"SKILL.md", ec)) {
                    add_root(entry.path());
                }
            }
        }
        add_root(user_prof / L".kimi-code" / L"skills");
        add_root(user_prof / L".codex" / L"skills");
        add_root(user_prof / L".codex" / L"skills" / L".system");
        add_root(user_prof / L".claude" / L"skills");
        return roots;
    };

    fs::path mcp_node_exe, mcp_bridge_mjs;
    if (!in_bwrap && !req.app_root.empty()) {
        const fs::path ptr_json = req.app_root / L"native-client.json";
        if (fs::is_regular_file(ptr_json, ec)) {
            try {
                const auto ptr = Json::parse(read_small_file(ptr_json));
                const auto n_rel = jstr(ptr, "node");
                const auto p_rel = jstr(ptr, "pluginHost");
                if (!n_rel.empty()) mcp_node_exe = req.app_root / utf8_to_path(n_rel);
                if (!p_rel.empty()) mcp_bridge_mjs = (req.app_root / utf8_to_path(p_rel)).parent_path() / L"cross-harness-mcp.mjs";
            } catch (...) {}
        }
        if (!fs::is_regular_file(mcp_node_exe, ec)) mcp_node_exe = req.app_root / L"runtime" / L"node" / L"node.exe";
        if (!fs::is_regular_file(mcp_bridge_mjs, ec)) mcp_bridge_mjs = req.app_root / L"runtime" / L"cross-harness-mcp.mjs";
    }
    const bool has_cross_mcp_bridge = !in_bwrap &&
                                      !req.read_only_reception &&
                                      !req.constraints.forbid_skills &&
                                      fs::is_regular_file(mcp_node_exe, ec) &&
                                      fs::is_regular_file(mcp_bridge_mjs, ec);
    const std::string mcp_node_u8 = has_cross_mcp_bridge ? path_to_utf8(fs::absolute(mcp_node_exe, ec)) : std::string{};
    const std::string mcp_bridge_u8 = has_cross_mcp_bridge ? path_to_utf8(fs::absolute(mcp_bridge_mjs, ec)) : std::string{};

    if (inv.engine_id == "hermes") {
        if (!in_bwrap) {
            const fs::path global_hermes = fs::is_directory(local_app / L"hermes", ec) ? (local_app / L"hermes") : (user_prof / L".hermes");
            maybe_prewarm_hermes_gateway(inv.binary_path, global_hermes);
        }

        inv.env_overrides.emplace_back("HERMES_ACCEPT_HOOKS", "1");
        inv.env_overrides.emplace_back("HERMES_QUIET", "1");

        std::string effective_native_provider = req.native_provider;
        if (!inject_work_model && effective_native_provider.empty() && !req.native_model.empty()) {
            for (const auto& grp : chosen->native_model_groups) {
                if (grp.provider_arg.empty()) continue;
                if (std::find(grp.models.begin(), grp.models.end(), req.native_model) != grp.models.end()) {
                    effective_native_provider = grp.provider_arg;
                    break;
                }
            }
        }

        const std::string route_sig = deterministic_uuid_from_key(
            (inject_work_model
                ? ((host_is_anthropic ? host_anth_url : host_openai_url) + "|" + req.work_slot_model.model)
                : ("native|" + effective_native_provider + "|" + req.native_model)) +
            "|" + req.work_slot_model.reasoning_effort +
            "|" + (req.constraints.forbid_skills ? "nosk" : "sk") +
            "|" + ((req.constraints.forbid_tests && req.constraints.forbid_network) ? "fileonly" : "full")
        ).substr(0, 6);
        const std::string hermes_sess_title = sess_slug + "-" + route_sig;

        if (req.read_only_reception) {
            inv.args = {
                "chat",
                "--query-file", query_file_arg_path,
                "--oneshot",
                "--format", "stream-json",
                "--in", ws_arg_path,
                "--max-turns", "1",
                "--source", "tool",
                "--ignore-rules"
            };
        } else {
            inv.args = {
                "chat",
                "--query-file", query_file_arg_path,
                "--format", "stream-json",
                "--in", ws_arg_path,
                "-c", hermes_sess_title,
                "--create-if-missing",
                "--accept-hooks",
                "--source", "tool",
                "--yolo",
                "--checkpoints"
            };
            if (req.constraints.forbid_skills) inv.args.push_back("--ignore-rules");
            if (req.constraints.forbid_tests && req.constraints.forbid_network) {
                inv.args.push_back("-t");
                inv.args.push_back("file");
            }
        }
        if (!req.work_slot_model.reasoning_effort.empty()) {
            const std::string& raw_eff = req.work_slot_model.reasoning_effort;
            const std::string hermes_eff = (raw_eff == "xhigh" || raw_eff == "max") ? "high" : raw_eff;
            inv.args.push_back("--reasoning");
            inv.args.push_back(hermes_eff);
        }
        if (inject_work_model) {
            if (host_is_anthropic) {
                inv.env_overrides.emplace_back("ANTHROPIC_BASE_URL", host_anth_url);
                inv.args.push_back("--provider");
                inv.args.push_back("anthropic");
            } else {
                inv.args.push_back("--provider");
                inv.args.push_back("custom");
                inv.args.push_back("--base-url");
                inv.args.push_back(host_openai_url);
            }
            if (!req.work_slot_model.api_key.empty()) {
                inv.args.push_back("--api-key");
                inv.args.push_back(req.work_slot_model.api_key);
            }
            inv.args.push_back("-m");
            inv.args.push_back(req.work_slot_model.model);
        } else {
            if (!effective_native_provider.empty()) {
                inv.args.push_back("--provider");
                inv.args.push_back(effective_native_provider);
            }
            if (!req.native_model.empty()) {
                inv.args.push_back("-m");
                inv.args.push_back(req.native_model);
            }
        }
    } else if (inv.engine_id == "deepseek-harness") {
        // Use global ~/.dsh directly (do NOT override DSH_HOME): inherits ~/.dsh/dsh-runtimes,
        // llm-deepseek, dsh-breeze-tts, .credentials.yaml, and AGENTS.md with zero file copy,
        // while --patch <temp_patch> and --session-id keep per-run configuration & session isolated.
        const fs::path global_dsh = user_prof / L".dsh";
        const std::string dsh_perm_preset = req.read_only_reception ? "read-only" : "danger-full-access";
        inv.env_overrides.emplace_back("DSH_PERMISSION_MODE", dsh_perm_preset);

        std::ostringstream patch;
        patch << "- id: permission\n"
              << "  name: \"@deepseek-ai/dsh-permission-presets\"\n"
              << "  config:\n"
              << "    defaultPreset: " << dsh_perm_preset << "\n";
        if (req.constraints.forbid_skills || req.read_only_reception) {
            patch << "- id: skill\n"
                  << "  name: \"@deepseek-ai/dsh-skill\"\n"
                  << "  disabled: true\n";
        } else {
            const auto skill_roots = collect_cross_harness_skill_roots();
            if (!skill_roots.empty()) {
                patch << "- id: skill-filesystem\n"
                      << "  name: \"@deepseek-ai/dsh-skill-filesystem\"\n"
                      << "  config:\n"
                      << "    watch: false\n"
                      << "    customSkillDirs:\n";
                for (const auto& sr : skill_roots) {
                    patch << "      - " << yaml_double_quote(sr) << "\n";
                }
            }
            if (has_cross_mcp_bridge) {
                patch << "- insert:\n"
                      << "    - id: mcp-cross-harness\n"
                      << "      name: \"@deepseek-ai/dsh-mcp-client\"\n"
                      << "      config:\n"
                      << "        serverName: \"cross_harness\"\n"
                      << "        transport: stdio\n"
                      << "        command: " << yaml_double_quote(mcp_node_u8) << "\n"
                      << "        args:\n"
                      << "          - " << yaml_double_quote(mcp_bridge_u8) << "\n"
                      << "        cwd: " << yaml_double_quote(path_to_utf8(ws_abs)) << "\n"
                      << "        failOnStartupError: false\n"
                      << "        toolCallTimeoutMs: 300000\n";
            }
        }

        const std::string raw_effort = req.work_slot_model.reasoning_effort;
        const std::string effort = (raw_effort == "xhigh" || raw_effort == "max") ? "high" : raw_effort;
        const bool valid_effort = (effort == "low" || effort == "medium" || effort == "high");

        if (inject_work_model) {
            const std::size_t ctx_win = req.work_slot_model.context_window_tokens >= 8192
                ? req.work_slot_model.context_window_tokens : 131072U;
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("DIMENSION_WORK_API_KEY", req.work_slot_model.api_key);
            }
            patch << "- id: llm-pi-ai\n"
                  << "  name: \"@deepseek-ai/dsh-llm-pi-ai\"\n"
                  << "  config:\n"
                  << "    providers:\n"
                  << "      dimension_work:\n"
                  << "        displayName: \"Dimension Work API\"\n"
                  << "        api: " << (host_is_anthropic ? "\"anthropic-messages\"" : "\"openai-completions\"") << "\n"
                  << "        baseURL: " << yaml_double_quote(host_is_anthropic ? host_anth_url : host_openai_url) << "\n"
                  << "        apiKeyEnv: \"DIMENSION_WORK_API_KEY\"\n"
                  << "        models:\n"
                  << "          - id: " << yaml_double_quote(req.work_slot_model.model) << "\n"
                  << "            contextWindow: " << ctx_win << "\n"
                  << (valid_effort ? "            reasoning: true\n" : "")
                  << "- id: agent-default-model\n"
                  << "  name: \"@deepseek-ai/dsh-agent-default-model\"\n"
                  << "  config:\n"
                  << "    provider: \"dimension_work\"\n"
                  << "    model: " << yaml_double_quote(req.work_slot_model.model) << "\n";
            if (valid_effort) {
                patch << "    reasoningEffort: " << yaml_double_quote(effort) << "\n";
            }
        } else {
            const std::string chosen_m = !req.native_model.empty()
                ? req.native_model
                : (!chosen->native_default_model.empty() ? chosen->native_default_model : "deepseek-flash");
            inv.model_label = chosen_m + " · 原生";
            patch << "- id: credentials\n"
                  << "  name: \"@deepseek-ai/dsh-credentials-local\"\n"
                  << "  disabled: false\n"
                  << "- id: authorization\n"
                  << "  name: \"@deepseek-ai/dsh-authorization\"\n"
                  << "  disabled: false\n"
                  << "- id: deepseek-account\n"
                  << "  name: \"@deepseek-ai/dsh-deepseek-account-platform\"\n"
                  << "  disabled: false\n"
                  << "  config:\n"
                  << "    desktopPlatform: " << (in_bwrap ? "linux" : "win32") << "\n"
                  << "- id: agent-default-model\n"
                  << "  name: \"@deepseek-ai/dsh-agent-default-model\"\n"
                  << "  config:\n"
                  << "    provider: \"deepseek-account\"\n"
                  << "    model: " << yaml_double_quote(chosen_m) << "\n";
            if (valid_effort) {
                patch << "    reasoningEffort: " << yaml_double_quote(effort) << "\n";
            }
        }

        const fs::path patch_file = inv.isolated_home_dir / L"dimension-run.patch.yml";
        AtomicWriteOptions wopts;
        wopts.existing_root = inv.isolated_home_dir;
        atomic_write_file(patch_file, patch.str(), wopts);

        // Multi-turn session adoption (Windows host mode)
        const std::string cwd_sig = deterministic_uuid_from_key(path_to_utf8(ws_abs)).substr(0, 6);
        const fs::path map_dir = inv.isolated_home_dir / L"session-map";
        fs::create_directories(map_dir, ec);
        inv.session_id_map_file = map_dir / utf8_to_path(sess_slug + "-" + cwd_sig + ".id");
        std::string existing_sess_id;
        if (!in_bwrap && fs::is_regular_file(inv.session_id_map_file, ec)) {
            existing_sess_id = trim_copy(read_small_file(inv.session_id_map_file));
            if (!existing_sess_id.empty()) {
                bool found_on_disk = false;
                const fs::path sess_root = global_dsh / L"sessions";
                if (fs::is_directory(sess_root, ec)) {
                    const fs::path direct_p = sess_root / utf8_to_path(existing_sess_id);
                    if (fs::exists(direct_p, ec) || fs::exists(sess_root / utf8_to_path(existing_sess_id + ".jsonl"), ec)) {
                        found_on_disk = true;
                    } else {
                        for (const auto& sub : fs::directory_iterator(sess_root, ec)) {
                            if (ec) break;
                            if (!sub.is_directory(ec)) continue;
                            if (fs::exists(sub.path() / utf8_to_path(existing_sess_id), ec) ||
                                fs::exists(sub.path() / utf8_to_path(existing_sess_id + ".jsonl"), ec)) {
                                found_on_disk = true;
                                break;
                            }
                        }
                    }
                }
                if (!found_on_disk) existing_sess_id.clear();
            }
        }

        inv.args = {
            "--profile", "headless",
            "--patch", in_bwrap ? (task_dir_arg_path + "/dimension-run.patch.yml") : path_to_utf8(patch_file),
            "--json"
        };
        if (!existing_sess_id.empty()) {
            inv.args.push_back("--session-id");
            inv.args.push_back(existing_sess_id);
        }
        inv.args.push_back("-");
        inv.stdin_payload = effective_prompt;
    } else if (inv.engine_id == "kimi-code") {
        const fs::path global_kimi = user_prof / L".kimi-code";
        if (inject_work_model) {
            // Isolated KIMI_CODE_HOME ONLY when injecting custom Dimension Work API config.toml
            if (!in_bwrap) {
                copy_file_sync(global_kimi / L"credentials.json", inv.isolated_home_dir / L"credentials.json");
                copy_file_sync(global_kimi / L"device_id", inv.isolated_home_dir / L"device_id");
                copy_file_sync(global_kimi / L"region", inv.isolated_home_dir / L"region");
            }
            inv.env_overrides.emplace_back("KIMI_CODE_HOME", task_dir_arg_path);

            const std::string alias = "dimension_work/" + req.work_slot_model.model;
            const std::size_t ctx_win = req.work_slot_model.context_window_tokens >= 8192
                ? req.work_slot_model.context_window_tokens : 131072U;
            std::ostringstream toml;
            toml << "default_model = \"" << toml_escape_basic(alias) << "\"\n\n"
                 << "[providers.dimension_work]\n"
                 << "type = \"" << (host_is_anthropic ? "anthropic" : "openai") << "\"\n"
                 << "base_url = \"" << toml_escape_basic(host_is_anthropic ? host_anth_url : host_openai_url) << "\"\n"
                 << "api_key = \"" << toml_escape_basic(req.work_slot_model.api_key) << "\"\n\n"
                 << "[models.\"" << toml_escape_basic(alias) << "\"]\n"
                 << "provider = \"dimension_work\"\n"
                 << "model = \"" << toml_escape_basic(req.work_slot_model.model) << "\"\n"
                 << "max_context_size = " << ctx_win << "\n";
            AtomicWriteOptions wopts;
            wopts.existing_root = inv.isolated_home_dir;
            atomic_write_file(inv.isolated_home_dir / L"config.toml", toml.str(), wopts);

            // Preserve user's mcp.json and merge cross_harness MCP server inside isolated home (host only)
            if (!in_bwrap) {
                Json::Object mcp_servers;
                if (fs::is_regular_file(global_kimi / L"mcp.json", ec)) {
                    try {
                        const auto existing_mcp = Json::parse(read_small_file(global_kimi / L"mcp.json"));
                        if (existing_mcp.is_object()) {
                            if (const auto* srv = existing_mcp.find("mcpServers"); srv && srv->is_object()) {
                                mcp_servers = srv->as_object();
                            }
                        }
                    } catch (...) {}
                }
                if (has_cross_mcp_bridge) {
                    mcp_servers["cross_harness"] = Json::Object{
                        {"command", mcp_node_u8},
                        {"args", Json::Array{mcp_bridge_u8}}
                    };
                }
                if (!mcp_servers.empty()) {
                    atomic_write_file(inv.isolated_home_dir / L"mcp.json",
                                      Json(Json::Object{{"mcpServers", std::move(mcp_servers)}}).dump(), wopts);
                }
            }
        }
        const auto home = inject_work_model ? inv.isolated_home_dir : global_kimi;
        const auto map_dir = inv.isolated_home_dir / "session-map";
        fs::create_directories(map_dir, ec);
        inv.session_id_map_file = map_dir / (deterministic_uuid_from_key(req.session_key + "|" +
            path_to_utf8(ws_abs) + "|" + req.model_source + "|" + inv.model_label) + ".id");
        if (!in_bwrap && !req.read_only_reception) {
            const auto bucket = kimi_session_bucket(home, ws_abs);
            auto id = trim_copy(read_small_file(inv.session_id_map_file));
            if (id.size() == 36) id = "session_" + id;
            if (!bucket.empty() && id.starts_with("session_") && id.size() == 44 &&
                id.find_first_not_of("abcdefABCDEF0123456789-", 8) == std::string::npos &&
                fs::is_regular_file(bucket / id / "state.json", ec)) inv.args = {"-S", id};
        }
        const auto model = inject_work_model ? "dimension_work/" + req.work_slot_model.model : req.native_model;
        if (!model.empty()) { inv.args.push_back("-m"); inv.args.push_back(model); }
        if (req.constraints.forbid_skills || req.read_only_reception) {
            const fs::path empty_skills = inv.isolated_home_dir / L"empty-skills";
            fs::create_directories(empty_skills, ec);
            inv.args.push_back("--skills-dir");
            inv.args.push_back(in_bwrap ? (task_dir_arg_path + "/empty-skills") : path_to_utf8(empty_skills));
        } else {
            if (fs::is_directory(ws_abs / L".kimi" / L"skills", ec)) {
                inv.args.push_back("--skills-dir");
                inv.args.push_back(in_bwrap ? "/workspace/.kimi/skills" : path_to_utf8(ws_abs / L".kimi" / L"skills"));
            }
            for (const auto& sr : collect_cross_harness_skill_roots()) {
                inv.args.push_back("--skills-dir");
                inv.args.push_back(sr);
            }
        }
        // Note: Kimi Code forbids combining `--plan` with `-p/--prompt` (`Cannot combine --prompt with --plan.`).
        // In read-only reception mode we omit `--yolo`/`--auto`/`-S`, attach an empty skills dir, and run in the isolated sandbox.
        inv.args.push_back("--output-format");
        inv.args.push_back("stream-json");
        inv.args.push_back("-p");
        inv.args.push_back(effective_prompt);
    } else if (inv.engine_id == "claude-code") {
        if (inject_work_model) {
            inv.env_overrides.emplace_back("ANTHROPIC_BASE_URL", host_anth_url);
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("ANTHROPIC_AUTH_TOKEN", req.work_slot_model.api_key);
                inv.env_overrides.emplace_back("ANTHROPIC_API_KEY", req.work_slot_model.api_key);
            }
        }
        if (req.read_only_reception) {
            // Pure read-only orchestration mode: disable local disk/bash tools and pass prompt via stdin.
            inv.args = {
                "-p",
                "--output-format", "stream-json",
                "--verbose",
                "--tools", ""
            };
            inv.stdin_payload = effective_prompt;
        } else {
            inv.args = {
                "-p", effective_prompt,
                "--output-format", "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",
                "--session-id", sess_uuid
            };
        }
        if (has_cross_mcp_bridge) {
            const fs::path claude_mcp = inv.isolated_home_dir / L"claude-cross-mcp.json";
            const Json mcp_doc = Json::Object{
                {"mcpServers", Json::Object{
                    {"cross_harness", Json::Object{
                        {"command", mcp_node_u8},
                        {"args", Json::Array{mcp_bridge_u8}}
                    }}
                }}
            };
            AtomicWriteOptions wopts;
            wopts.existing_root = inv.isolated_home_dir;
            atomic_write_file(claude_mcp, mcp_doc.dump(), wopts);
            inv.args.push_back("--mcp-config");
            inv.args.push_back(path_to_utf8(claude_mcp));
        }
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("--model");
            inv.args.push_back(chosen_m);
        }
    } else if (inv.engine_id == "codex") {
        if (inject_work_model) {
            inv.env_overrides.emplace_back("OPENAI_BASE_URL", host_openai_url);
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("OPENAI_API_KEY", req.work_slot_model.api_key);
            }
        }
        inv.args = req.read_only_reception
            ? std::vector<std::string>{"exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"}
            : std::vector<std::string>{"exec", "--json", "--full-auto", "--skip-git-repo-check"};
        if (!req.read_only_reception) {
            if (req.constraints.forbid_skills) {
                inv.args.push_back("--ignore-rules");
            } else if (has_cross_mcp_bridge) {
                inv.args.push_back("--trust");
                inv.args.push_back("-c");
                inv.args.push_back("mcp_servers.cross_harness.command=\"" + toml_escape_basic(mcp_node_u8) + "\"");
                inv.args.push_back("-c");
                inv.args.push_back("mcp_servers.cross_harness.args=[\"" + toml_escape_basic(mcp_bridge_u8) + "\"]");
            }
        }
        const auto& effort = req.work_slot_model.reasoning_effort;
        if (effort == "low" || effort == "medium" || effort == "high" || effort == "xhigh") {
            inv.args.push_back("-c");
            inv.args.push_back("model_reasoning_effort=\"" + effort + "\"");
        }
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("-m");
            inv.args.push_back(chosen_m);
        }
        for (const auto& img_p : req.image_paths) {
            const std::string mapped = map_image_for_cli(img_p);
            if (!mapped.empty()) {
                inv.args.push_back("-i");
                inv.args.push_back(mapped);
            }
        }
        if (req.read_only_reception) {
            inv.args.push_back("-");
            inv.stdin_payload = effective_prompt;
        } else {
            inv.args.push_back(effective_prompt);
        }
    } else if (inv.engine_id == "opencode") {
        if (inject_work_model) {
            inv.env_overrides.emplace_back("OPENAI_BASE_URL", host_openai_url);
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("OPENAI_API_KEY", req.work_slot_model.api_key);
            }
        }
        inv.args = {"run", "--format", "json"};
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("-m");
            inv.args.push_back(chosen_m);
        }
        inv.args.push_back(effective_prompt);
    } else if (inv.engine_id == "antigravity") {
        // Google Antigravity CLI (`agy`): headless `--input-format stream-json --output-format stream-json`
        // Note: `agy --print` expects an inline prompt argument and would consume `--input-format` if placed before it.
        // Using stream-json on stdin avoids argv length limits, skips `--print` flag collisions, and supports UTF-8 prompts cleanly.
        if (req.read_only_reception) {
            inv.args = {
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--disable-slash-commands"
            };
        } else {
            inv.args = {
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--dangerously-skip-permissions"
            };
            const fs::path map_dir = inv.isolated_home_dir / L"session-map";
            fs::create_directories(map_dir, ec);
            const std::string cwd_sig = deterministic_uuid_from_key(path_to_utf8(ws_abs)).substr(0, 6);
            inv.session_id_map_file = map_dir / utf8_to_path(sess_slug + "-" + cwd_sig + ".id");
            if (!in_bwrap && fs::is_regular_file(inv.session_id_map_file, ec)) {
                const std::string prev_cid = trim_copy(read_small_file(inv.session_id_map_file));
                if (!prev_cid.empty() && prev_cid.size() <= 128 &&
                    prev_cid.find_first_of(" \t\r\n") == std::string::npos) {
                    inv.args.push_back("--conversation");
                    inv.args.push_back(prev_cid);
                }
            }
        }
        const std::string chosen_m = req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("--model");
            inv.args.push_back(chosen_m);
        }
        const auto model_encodes_effort = [](std::string_view m) {
            const std::string low = ascii_lower(m);
            return low.ends_with("-xhigh") || low.ends_with("-high") ||
                   low.ends_with("-medium") || low.ends_with("-low") || low.ends_with("-max");
        };
        const std::string effort = req.work_slot_model.reasoning_effort;
        if (!model_encodes_effort(chosen_m) &&
            (effort == "low" || effort == "medium" || effort == "high" || effort == "xhigh" || effort == "max")) {
            inv.args.push_back("--effort");
            inv.args.push_back(effort);
        }
        inv.stdin_payload = Json(O{
            {"event", "user"},
            {"message", O{{"content", effective_prompt}}}
        }).dump() + "\n";
    } else {
        // qwen-code / gemini-cli
        if (inject_work_model) {
            inv.env_overrides.emplace_back("OPENAI_BASE_URL", host_openai_url);
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("OPENAI_API_KEY", req.work_slot_model.api_key);
                inv.env_overrides.emplace_back("GEMINI_API_KEY", req.work_slot_model.api_key);
            }
        }
        inv.args = req.read_only_reception
            ? std::vector<std::string>{"-p", effective_prompt, "--output-format", "stream-json"}
            : std::vector<std::string>{"-p", effective_prompt, "--output-format", "stream-json", "--yolo"};
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("-m");
            inv.args.push_back(chosen_m);
        }
    }

    // Avoid shell/process command-line length limits.
    // Windows .cmd/.bat go through cmd.exe (~8191 char cap); native .exe supports 32,767 UTF-16 chars;
    // WSL/Linux bwrap safely handles large argv (>100 KB). Stdin & query-file engines are unaffected.
    const auto extension = ascii_lower(path_to_utf8(utf8_to_path(inv.binary_path).extension()));
    const bool is_batch_script = !in_bwrap && (extension == ".cmd" || extension == ".bat");
    const bool file_prompt = is_batch_script && req.file_prompt_for_batch;
    const bool exceeds_arg_limit = in_bwrap
        ? (effective_prompt.size() > 96000U)
        : (is_batch_script
            ? (effective_prompt.size() > 6000U)
            : (utf8_to_wide(effective_prompt).size() > 24000U));
    if ((file_prompt || exceeds_arg_limit) && inv.stdin_payload.empty()) {
        for (auto& argument : inv.args) {
            if (argument == effective_prompt) {
                argument = "请先完整读取本次任务说明文件（UTF-8），按其中的职责、用户原文和后续纠正执行："
                    + query_file_arg_path;
                break;
            }
        }
    }

    // Build Bubblewrap (bwrap) namespace sandbox command when running inside WSL sandbox
    if (in_bwrap) {
        inv.use_bwrap_sandbox = true;
        inv.linux_workspace_path = windows_path_to_wsl_path(ws_abs, req.sandbox_distribution);
        inv.linux_task_dir = windows_path_to_wsl_path(inv.isolated_home_dir, req.sandbox_distribution);
        inv.linux_home_path = (req.model_source == "native")
            ? ("/var/lib/dimension-cli-homes/" + inv.engine_id)
            : std::string{};

        auto add_bw = [&](std::initializer_list<std::string> items) {
            for (const auto& s : items) inv.bwrap_args.push_back(s);
        };
        add_bw({
            "/usr/bin/bwrap",
            "--unshare-all",
            "--share-net",
            "--die-with-parent",
            "--new-session",
            "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/sbin", "/sbin",
            "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64",
            "--ro-bind-try", "/etc/passwd", "/etc/passwd",
            "--ro-bind-try", "/etc/group", "/etc/group",
            "--ro-bind-try", "/etc/hosts", "/etc/hosts",
            "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
            "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
            "--ro-bind-try", "/etc/ssl", "/etc/ssl",
            "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
            "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
            "--ro-bind-try", "/etc/localtime", "/etc/localtime",
            "--ro-bind", "/opt/dimension-tools", "/opt/dimension-tools",
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--dir", "/run/dim-task",
            "--bind", inv.linux_task_dir, "/run/dim-task",
            req.read_only_reception ? "--ro-bind" : "--bind", inv.linux_workspace_path, "/workspace"
        });
        if (!inv.linux_home_path.empty()) {
            add_bw({"--dir", "/home/dimension", "--bind", inv.linux_home_path, "/home/dimension"});
        } else {
            add_bw({"--dir", "/tmp/dim-home", "--symlink", "/tmp/dim-home", "/home/dimension"});
        }
        add_bw({
            "--uid", "1001",
            "--gid", "1002",
            "--clearenv",
            "--setenv", "PATH", "/opt/dimension-tools/bin:/usr/local/bin:/usr/bin:/bin",
            "--setenv", "HOME", "/home/dimension",
            "--setenv", "USER", "dimension",
            "--setenv", "LOGNAME", "dimension",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "LC_ALL", "C.UTF-8",
            "--setenv", "TERM", "dumb",
            "--setenv", "TMPDIR", "/tmp"
        });
        for (const auto& [pk, pv] : build_sandbox_proxy_env_overrides()) {
            add_bw({"--setenv", pk, pv});
        }
        for (const auto& [ek, ev] : inv.env_overrides) {
            if (ek == "PATH_PREPEND" || ek == "PATH" || ek == "HOME") continue;
            add_bw({"--setenv", ek, ev});
        }
        add_bw({"--chdir", "/workspace", "--", inv.binary_path});
        for (const auto& a : inv.args) inv.bwrap_args.push_back(a);
    }

    return inv;
}

CliHarnessRunResult run_cli_harness(const CliHarnessRunRequest& req,
                                    const CliEventCallback& on_event,
                                    std::stop_token stop) {
    const auto started_at = std::chrono::steady_clock::now();
    PreparedCliInvocation inv = prepare_cli_invocation(req);
    std::string kimi_marker;
    if (!inv.use_bwrap_sandbox && !req.read_only_reception && inv.engine_id == "kimi-code" &&
        std::find(inv.args.begin(), inv.args.end(), "-S") == inv.args.end()) {
        kimi_marker = "DimensionSession-" + deterministic_uuid_from_key(req.session_key +
            std::to_string(started_at.time_since_epoch().count()));
        inv.args.back().insert(0, "[" + kimi_marker + "]\n");
    }
    struct TempQueryFileGuard {
        fs::path path;
        ~TempQueryFileGuard() {
            if (!path.empty()) {
                std::error_code rm_ec;
                fs::remove(path, rm_ec);
            }
        }
    } temp_query_guard{inv.temp_query_file};

    CliHarnessRunResult out;
    out.resolved_engine_id = inv.engine_id;
    out.resolved_engine_name = inv.engine_name;
    out.resolved_model_label = inv.model_label;

    std::error_code ec;
    const fs::path ws_abs = fs::absolute(req.workspace_dir, ec);
    fs::create_directories(ws_abs, ec);

    // Take pre-execution snapshot to detect created/updated files and build Red/Green Diffs.
    // Read-only reception calls never touch the workspace, so skip disk traversal completely.
    const auto before_snap = req.read_only_reception ? std::map<std::string, FileSnap>{} : snapshot_workspace(ws_abs);

    std::wstring cmd_line;
    bool unc_batch = false;
    if (inv.use_bwrap_sandbox) {
        const fs::path wsl_exe = resolve_wsl_exe_path(req.wsl_executable);
        if (wsl_exe.empty() || req.sandbox_distribution.empty()) {
            throw std::runtime_error("隔离沙盒（WSL dimension-sandbox）未就绪，无法启动沙盒 CLI");
        }
        cmd_line = quote_win_arg(wsl_exe.wstring())
            + L" -d " + quote_win_arg(utf8_to_wide(req.sandbox_distribution))
            + L" -u root --exec ";
        if (!inv.linux_home_path.empty()) {
            const std::string prep = "mkdir -p -m 700 \"$1\" && chown 1001:1002 \"$1\" && shift && exec \"$@\"";
            cmd_line += L"/bin/sh -c " + quote_win_arg(utf8_to_wide(prep)) + L" _ "
                + quote_win_arg(utf8_to_wide(inv.linux_home_path));
            for (const auto& ba : inv.bwrap_args) {
                cmd_line.push_back(L' ');
                cmd_line += quote_win_arg(utf8_to_wide(ba));
            }
        } else {
            for (std::size_t i = 0; i < inv.bwrap_args.size(); ++i) {
                if (i > 0) cmd_line.push_back(L' ');
                cmd_line += quote_win_arg(utf8_to_wide(inv.bwrap_args[i]));
            }
        }
    } else {
        // Construct full Windows command line (.cmd wrappers run via cmd.exe /d /s /c "\"...\"")
        const bool is_cmd_script = ascii_lower(inv.binary_path).ends_with(".cmd") ||
                                   ascii_lower(inv.binary_path).ends_with(".bat");
        std::wstring inner_cmd = quote_win_arg(utf8_to_wide(inv.binary_path));
        for (const auto& a : inv.args) {
            inner_cmd.push_back(L' ');
            inner_cmd += quote_win_arg(utf8_to_wide(a));
        }
        unc_batch = is_cmd_script && ws_abs.root_name().wstring().starts_with(L"\\\\");
        cmd_line = unc_batch
            ? L"cmd.exe /d /e:on /v:off /s /c \"pushd \"%DIMENSION_CLI_WORKDIR%\" && " + inner_cmd + L"\""
            : is_cmd_script
            ? (L"cmd.exe /d /s /c \"" + inner_cmd + L"\"")
            : inner_cmd;
    }

    SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr, in_r = nullptr, in_w = nullptr;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) throw std::runtime_error("无法创建 CLI stdout 管道");
    HandleGuard out_read(out_r), out_write(out_w);
    SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&err_r, &err_w, &sa, 0)) throw std::runtime_error("无法创建 CLI stderr 管道");
    HandleGuard err_read(err_r), err_write(err_w);
    SetHandleInformation(err_read.h, HANDLE_FLAG_INHERIT, 0);

    if (!CreatePipe(&in_r, &in_w, &sa, 0)) throw std::runtime_error("无法创建 CLI stdin 管道");
    HandleGuard in_read(in_r), in_write(in_w);
    SetHandleInformation(in_write.h, HANDLE_FLAG_INHERIT, 0);
    if (inv.stdin_payload.empty()) {
        in_write = HandleGuard{}; // Non-interactive immediate EOF
    }

    HandleGuard job(CreateJobObjectW(nullptr, nullptr));
    if (job.h) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = in_read.h;
    si.hStdOutput = out_write.h;
    si.hStdError = err_write.h;

    std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
    mutable_cmd.push_back(L'\0');
    std::wstring env_block;
    LPVOID env_ptr = nullptr;
    DWORD create_flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP;
    std::wstring cwd_w;
    if (inv.use_bwrap_sandbox) {
        // Bubblewrap isolates & injects the exact clean Linux environment via --clearenv --setenv.
        cwd_w = inv.isolated_home_dir.wstring();
    } else {
        std::vector<std::pair<std::string, std::string>> merged_env = build_host_proxy_env_overrides();
        for (const auto& kv : inv.env_overrides) merged_env.push_back(kv);
        merged_env.emplace_back("PYTHONUTF8", "1");
        merged_env.emplace_back("PYTHONIOENCODING", "utf-8");
        if (unc_batch) merged_env.emplace_back("DIMENSION_CLI_WORKDIR", path_to_utf8(ws_abs));
        env_block = build_environment_block(merged_env);
        env_ptr = env_block.data();
        create_flags |= CREATE_UNICODE_ENVIRONMENT;
        cwd_w = unc_batch ? inv.isolated_home_dir.wstring() : ws_abs.wstring();
    }

    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                        create_flags,
                        env_ptr, cwd_w.c_str(), &si, &pi)) {
        fs::remove(inv.temp_query_file, ec);
        throw std::runtime_error("无法启动 CLI 进程 " + inv.engine_name + "（Win32 错误码 " + std::to_string(GetLastError()) + "）");
    }
    HandleGuard proc_h(pi.hProcess), thread_h(pi.hThread);
    in_read = HandleGuard{};
    out_write = HandleGuard{};
    err_write = HandleGuard{};

    if (job.h) AssignProcessToJobObject(job.h, proc_h.h);
    ResumeThread(thread_h.h);

    std::jthread stdin_writer;
    if (in_write.h && !inv.stdin_payload.empty()) {
        stdin_writer = std::jthread([h_in = std::move(in_write), payload = inv.stdin_payload]() mutable {
            const char* data = payload.data();
            std::size_t remaining = payload.size();
            while (remaining > 0) {
                const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(remaining, 32768U));
                DWORD written = 0;
                if (!WriteFile(h_in.h, data, chunk, &written, nullptr) || written == 0) break;
                data += written;
                remaining -= written;
            }
            h_in = HandleGuard{};
        });
    }

    std::mutex state_mu;
    std::string streamed_text_acc;
    std::string plain_stdout_fallback;
    std::string stderr_capture;

    auto handle_stdout_line = [&](std::string_view raw_line) {
        const std::string utf8_line = ensure_valid_utf8(raw_line);
        std::string_view line(utf8_line);
        NormalizedCliEvent ev;
        if (parse_cli_json_event(inv.engine_id, line, ev)) {
            if (ev.detected_dev_url.empty()) {
                ev.detected_dev_url = extract_local_dev_url(ev.output.empty() ? ev.text : ev.output);
            }
            {
                std::lock_guard lk(state_mu);
                if (!ev.session_id.empty()) out.native_session_id = ev.session_id;
                if (ev.kind == "commentary" && !ev.text.empty()) {
                    streamed_text_acc += ev.text;
                } else if (ev.kind == "usage") {
                    out.input_tokens += ev.input_tokens;
                    out.output_tokens += ev.output_tokens;
                } else if (ev.kind == "result") {
                    if (!ev.text.empty()) out.final_response = ev.text;
                    out.input_tokens = std::max(out.input_tokens, ev.input_tokens);
                    out.output_tokens = std::max(out.output_tokens, ev.output_tokens);
                    if (ev.is_error && out.error_detail.empty()) out.error_detail = ev.text;
                }
            }
            if (on_event && ev.kind != "usage") {
                try { on_event(ev); } catch (...) {}
            }
        } else {
            const std::string clean = trim_copy(line);
            if (!clean.empty()) {
                {
                    std::lock_guard lk(state_mu);
                    if (plain_stdout_fallback.size() < 256U * 1024U) {
                        if (!plain_stdout_fallback.empty()) plain_stdout_fallback.push_back('\n');
                        plain_stdout_fallback += clean;
                    }
                }
                const std::string dev_url = extract_local_dev_url(clean);
                if (!dev_url.empty() && on_event) {
                    NormalizedCliEvent dev_ev;
                    dev_ev.kind = "dev_server";
                    dev_ev.detected_dev_url = dev_url;
                    try { on_event(dev_ev); } catch (...) {}
                }
            }
        }
    };

    auto now_steady_ms = []() -> std::int64_t {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
    };
    std::atomic<bool> stdout_done{false};
    std::atomic<bool> stderr_done{false};
    std::atomic<std::int64_t> last_pipe_io_ms{now_steady_ms()};

    std::jthread stdout_reader([&]() {
        std::string pending;
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(out_read.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            last_pipe_io_ms.store(now_steady_ms(), std::memory_order_relaxed);
            pending.append(buf, n);
            std::size_t nl = 0;
            while ((nl = pending.find('\n')) != std::string::npos) {
                std::string line = pending.substr(0, nl);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                pending.erase(0, nl + 1);
                handle_stdout_line(line);
            }
        }
        if (!pending.empty()) handle_stdout_line(pending);
        stdout_done.store(true, std::memory_order_release);
    });

    std::jthread stderr_reader([&]() {
        char buf[4096];
        std::string line_buf;
        DWORD n = 0;
        auto flush_err_line = [&](std::string& lb) {
            const std::string clean = inv.use_bwrap_sandbox ? strip_wsl_utf16_noise(lb) : lb;
            lb.clear();
            if (clean.empty()) return;
            std::lock_guard lk(state_mu);
            if (stderr_capture.size() < 64U * 1024U) {
                if (!stderr_capture.empty()) stderr_capture.push_back('\n');
                stderr_capture.append(clean.data(), std::min<std::size_t>(clean.size(), 64U * 1024U - stderr_capture.size()));
            }
        };
        while (ReadFile(err_read.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            last_pipe_io_ms.store(now_steady_ms(), std::memory_order_relaxed);
            if (!inv.use_bwrap_sandbox) {
                std::lock_guard lk(state_mu);
                if (stderr_capture.size() < 64U * 1024U) {
                    stderr_capture.append(buf, std::min<std::size_t>(n, 64U * 1024U - stderr_capture.size()));
                }
            } else {
                for (DWORD i = 0; i < n; ++i) {
                    if (buf[i] == '\n') flush_err_line(line_buf);
                    else if (buf[i] != '\r') line_buf.push_back(buf[i]);
                }
            }
        }
        if (inv.use_bwrap_sandbox && !line_buf.empty()) flush_err_line(line_buf);
        stderr_done.store(true, std::memory_order_release);
    });

    const int timeout_sec = std::clamp(req.timeout_seconds, 15, 3600);
    const auto deadline = started_at + std::chrono::seconds(timeout_sec);
    bool timed_out = false;

    while (true) {
        const DWORD wait_rc = WaitForSingleObject(proc_h.h, 80);
        if (wait_rc == WAIT_OBJECT_0) break;
        if (stop.stop_requested()) {
            out.cancelled = true;
            if (job.h) TerminateJobObject(job.h, 130);
            else TerminateProcess(proc_h.h, 130);
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            timed_out = true;
            if (job.h) TerminateJobObject(job.h, 124);
            else TerminateProcess(proc_h.h, 124);
            break;
        }
    }

    WaitForSingleObject(proc_h.h, 3000);
    DWORD exit_code = 1;
    GetExitCodeProcess(proc_h.h, &exit_code);
    out.exit_code = static_cast<int>(exit_code);

    if (stdin_writer.joinable()) stdin_writer.join();

    // Drain any remaining buffered pipe output after the main CLI process exits,
    // then cancel blocked synchronous ReadFile calls if a detached grandchild daemon
    // (such as `hermes gateway run --idle-exit`) inherited the pipe write handles.
    const auto drain_start = now_steady_ms();
    while (!(stdout_done.load(std::memory_order_acquire) && stderr_done.load(std::memory_order_acquire))) {
        const auto now_ms = now_steady_ms();
        const auto since_exit = now_ms - drain_start;
        const auto since_io = now_ms - last_pipe_io_ms.load(std::memory_order_relaxed);
        if (since_exit >= 1200 || (since_exit >= 350 && since_io >= 300)) {
            if (!stdout_done.load(std::memory_order_acquire) && stdout_reader.joinable()) {
                CancelSynchronousIo(static_cast<HANDLE>(stdout_reader.native_handle()));
            }
            if (!stderr_done.load(std::memory_order_acquire) && stderr_reader.joinable()) {
                CancelSynchronousIo(static_cast<HANDLE>(stderr_reader.native_handle()));
            }
        }
        if (since_exit >= 2500) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    if (stdout_reader.joinable()) stdout_reader.join();
    if (stderr_reader.joinable()) stderr_reader.join();
    fs::remove(inv.temp_query_file, ec);

    stderr_capture = ensure_valid_utf8(stderr_capture);
    streamed_text_acc = ensure_valid_utf8(streamed_text_acc);
    plain_stdout_fallback = ensure_valid_utf8(plain_stdout_fallback);
    out.final_response = ensure_valid_utf8(out.final_response);
    out.error_detail = ensure_valid_utf8(out.error_detail);

    // Extract session_id from stderr if CLI printed `session_id: xxx` there
    if (inv.engine_id == "kimi-code" && out.exit_code == 0 && out.native_session_id.empty()) {
        if (kimi_marker.empty()) out.native_session_id = inv.args.at(1);
        else {
            auto home = utf8_to_path(env_var_utf8(L"USERPROFILE")) / ".kimi-code";
            for (const auto& [key, value] : inv.env_overrides)
                if (key == "KIMI_CODE_HOME") home = utf8_to_path(value);
            out.native_session_id = find_kimi_session(kimi_session_bucket(home, req.workspace_dir), kimi_marker);
        }
    }
    if (inv.engine_id != "kimi-code" && out.native_session_id.empty() && !stderr_capture.empty()) {
        static const std::regex kSessRe(R"(session_id:\s*([A-Za-z0-9._:-]+))");
        std::smatch m;
        if (std::regex_search(stderr_capture, m, kSessRe) && m.size() > 1) {
            out.native_session_id = m[1].str();
        }
    }

    if (!inv.session_id_map_file.empty() && !out.native_session_id.empty()) {
        try {
            AtomicWriteOptions wopts;
            wopts.existing_root = inv.isolated_home_dir;
            atomic_write_file(inv.session_id_map_file, out.native_session_id + "\n", wopts);
        } catch (...) {}
    }

    out.duration_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started_at).count();
    if (!req.read_only_reception) {
        out.file_deltas = diff_workspace_snapshots(ws_abs, before_snap);
    }

    if (out.final_response.empty()) {
        out.final_response = !streamed_text_acc.empty() ? streamed_text_acc : plain_stdout_fallback;
    }

    if (out.cancelled) {
        out.success = false;
        out.error_detail = "任务已按你的新要求即时打断或停止";
    } else if (timed_out) {
        out.success = false;
        out.error_detail = "CLI 执行超过单轮时间上限（" + std::to_string(timeout_sec) + "s）";
    } else if (out.exit_code == 0) {
        out.success = true;
    } else {
        out.success = false;
        if (out.error_detail.empty()) {
            out.error_detail = trim_copy(stderr_capture.empty() ? out.final_response : stderr_capture);
        }
    }

    return out;
}

namespace {

std::string format_reception_message_block(const ModelMessage& msg) {
    std::ostringstream tb;
    if (msg.role == "user") {
        tb << "### [USER]\n" << msg.content;
        if (!msg.images.empty()) {
            tb << "\n（附带 " << msg.images.size() << " 张参考图）";
        }
    } else if (msg.role == "assistant") {
        tb << "### [ASSISTANT]\n";
        if (!msg.content.empty()) tb << msg.content << "\n";
        for (const auto& tc : msg.tool_calls) {
            tb << "<dimension_tool_call>\n{\"name\":" << Json(tc.name).dump()
               << ",\"arguments\":" << (tc.arguments.empty() ? "{}" : tc.arguments)
               << "}\n</dimension_tool_call>\n";
        }
    } else if (msg.role == "tool") {
        tb << "### [TOOL RESULT id=" << msg.tool_call_id << "]\n" << msg.content;
    } else {
        tb << "### [" << msg.role << "]\n" << msg.content;
    }
    std::string item = tb.str();
    if (item.size() > 48000U) {
        item = item.substr(0, 44000U) + "\n…（单条回执过长已截断）…\n" + item.substr(item.size() - 2000U);
    }
    return item;
}

std::string extract_time_anchor_from_system(std::string_view sys) {
    static constexpr std::string_view kPrefix = "当前本地时间：";
    const auto pos = sys.find(kPrefix);
    if (pos == std::string_view::npos) return {};
    const auto val_start = pos + kPrefix.size();
    const auto end_pos = sys.find("）", val_start);
    if (end_pos == std::string_view::npos || end_pos <= val_start || end_pos - val_start > 96U) return {};
    return std::string(sys.substr(val_start, end_pos - val_start));
}

std::string normalize_primary_system_for_fingerprint(std::string_view sys) {
    std::string s(sys);
    // Strip volatile per-minute time anchor and per-turn user char count so KV Prompt Cache stays warm across turns.
    static constexpr std::string_view kTimePrefix = "（当前本地时间：";
    static constexpr std::string_view kCloseParen = "）";
    if (const auto p = s.find(kTimePrefix); p != std::string::npos) {
        const auto end = s.find(kCloseParen, p + kTimePrefix.size());
        if (end != std::string::npos && end - p < 128U) {
            s.replace(p, (end + kCloseParen.size()) - p, "（当前本地时间：<DYNAMIC>）");
        }
    }
    static constexpr std::string_view kLenPrefix = "（当前对方输入约 ";
    static constexpr std::string_view kLenSuffix = " 字）";
    if (const auto p = s.find(kLenPrefix); p != std::string::npos) {
        const auto end = s.find(kLenSuffix, p + kLenPrefix.size());
        if (end != std::string::npos && end - p < 64U) {
            s.replace(p, (end + kLenSuffix.size()) - p, "（当前对方输入约 <N> 字）");
        }
    }
    return s;
}

std::string hash128_hex(std::string_view data) {
    std::uint64_t h1 = 14695981039346656037ULL;
    std::uint64_t h2 = 1099511628211ULL ^ 0x9e3779b97f4a7c15ULL;
    for (unsigned char c : data) {
        h1 ^= c;
        h1 *= 1099511628211ULL;
        h2 ^= static_cast<std::uint64_t>(c) + 0x517cc1b727220a95ULL + (h2 << 6U) + (h2 >> 2U);
    }
    char buf[48]{};
    std::snprintf(buf, sizeof(buf), "%016llx%016llx-%zu",
                  static_cast<unsigned long long>(h1),
                  static_cast<unsigned long long>(h2),
                  data.size());
    return std::string(buf);
}

} // namespace

void ReceptionTextStreamFilter::reset() {
    inside_tool_tag_ = false;
    emitted_any_ = false;
    pending_.clear();
}

void ReceptionTextStreamFilter::feed(std::string_view chunk,
                                     const std::function<void(std::string_view)>& on_text) {
    static constexpr std::string_view kOpenTag = "<dimension_tool_call>";
    static constexpr std::string_view kCloseTag = "</dimension_tool_call>";

    if (chunk.empty()) return;
    pending_.append(chunk);

    while (!pending_.empty()) {
        if (inside_tool_tag_) {
            const auto close_pos = pending_.find(kCloseTag);
            if (close_pos != std::string::npos) {
                pending_.erase(0, close_pos + kCloseTag.size());
                inside_tool_tag_ = false;
                continue;
            }
            // Keep only a short tail that could match the prefix of kCloseTag.
            const std::size_t keep = kCloseTag.size() - 1U;
            if (pending_.size() > keep) {
                pending_.erase(0, pending_.size() - keep);
            }
            break;
        }

        const auto lt_pos = pending_.find('<');
        if (lt_pos == std::string::npos) {
            if (on_text) on_text(pending_);
            emitted_any_ = true;
            pending_.clear();
            break;
        }
        if (lt_pos > 0) {
            if (on_text) on_text(std::string_view(pending_).substr(0, lt_pos));
            emitted_any_ = true;
            pending_.erase(0, lt_pos);
        }

        // Now pending_[0] == '<'
        if (pending_.size() >= kOpenTag.size()) {
            if (pending_.compare(0, kOpenTag.size(), kOpenTag) == 0) {
                pending_.erase(0, kOpenTag.size());
                inside_tool_tag_ = true;
                continue;
            }
            // Not kOpenTag: emit '<' and continue scanning the rest.
            if (on_text) on_text(std::string_view(pending_).substr(0, 1));
            emitted_any_ = true;
            pending_.erase(0, 1);
            continue;
        }

        // pending_.size() < kOpenTag.size(): check if it is still a valid prefix of kOpenTag.
        if (kOpenTag.compare(0, pending_.size(), pending_) == 0) {
            break; // Hold until next chunk resolves the potential tag.
        }
        if (on_text) on_text(std::string_view(pending_).substr(0, 1));
        emitted_any_ = true;
        pending_.erase(0, 1);
    }
}

void ReceptionTextStreamFilter::flush(const std::function<void(std::string_view)>& on_text) {
    if (!inside_tool_tag_ && !pending_.empty()) {
        if (on_text) on_text(pending_);
        emitted_any_ = true;
    }
    pending_.clear();
}

std::string build_cli_reception_prompt(const std::vector<ModelMessage>& messages,
                                       const std::vector<ModelTool>& tools,
                                       std::string_view context_feature,
                                       std::string_view engine_id) {
    const bool is_chat_mode = (context_feature == "chat" || context_feature == "group");
    std::ostringstream out;
    if (is_chat_mode) {
        out << "【DimensionAgent 原生角色对话接待通道（只读纯对话模式）】\n"
            << "说明：你当前作为 DimensionAgent 对话角色的底层推理大脑，请完全代入下方系统提示词中的角色人设、关系与场景自然接话。\n"
            << "安全规则：本轮只输出角色对话回复（以及必要时下方声明的原生工具调用），切勿调用你自身内置的任何文件读写、Shell、代码执行、计划模式或外部系统工具，也不要提及 CLI 工具外壳名称。\n\n";
    } else {
        out << "【DimensionAgent 工坊原生接待与总指挥通道（纯对话统筹中继，严禁自行动手）】\n"
            << "说明：你当前担任 DimensionAgent Work 工坊的接待与总指挥（Lead / Commander），直接接入原生后端状态机。\n"
            << "【最高铁律】：你当前进程所在的 `cli-reception-sandbox` 只是空白只读中继目录，**绝不是用户的真实项目工作区**（严禁在方案或派单参数中提及或写入 `cli-reception-sandbox` 路径，调用 `dispatch_native_cli` 时后端会自动绑定用户的真实项目目录）！\n"
            << "1. **绝对禁止调用你 CLI 自身内置的任何工具**（包括 Write / Edit / Read / Glob / Shell / Bash / ExitPlanMode / 写入计划文件等，任何自行动手或写计划文件都是无效的！）；\n"
            << "2. 当下方「可调用的 Dimension 原生后端工具」为空（需求讨论阶段）时，你只能纯文字对话，并严格按照下方工坊指令末尾要求输出确认问句；\n"
            << "3. 当下方提供了 `dispatch_native_cli` 等 Dimension 原生工具（执行阶段）时，**必须且只能通过输出 `<dimension_tool_call>` 块（块内严格放单个纯 JSON 对象，严禁再套 `<tool_name>` 或 `<arguments>` XML 子标签）**来调用 `dispatch_native_cli` 派单给真实工作区的底层 CLI 工程师干活，以及调用 `read_file` / `verify_file` 验收和 `task_finish` 交付！\n\n";
    }

    std::string sys_combined;
    std::vector<std::string> turn_blocks;
    turn_blocks.reserve(messages.size());

    for (const auto& msg : messages) {
        if (msg.role == "system") {
            if (!msg.content.empty()) {
                if (!sys_combined.empty()) sys_combined += "\n\n";
                sys_combined += msg.content;
            }
            continue;
        }
        turn_blocks.push_back(format_reception_message_block(msg));
    }

    if (!sys_combined.empty()) {
        if (sys_combined.size() > 48000U) {
            sys_combined = sys_combined.substr(0, 48000U) + "\n…（系统上下文已按接待预算截断）";
        }
        out << (is_chat_mode ? "=== 系统角色设定与对话指令 ===\n" : "=== 系统角色与工坊指令 ===\n")
            << sys_combined << "\n\n";
    }

    if (!tools.empty()) {
        out << "=== 本轮可调用的 Dimension 原生后端工具 ===\n"
            << "当你需要调用下方任一原生工具时，请严格输出以下块（允许单轮连续输出多个块以并行调用；块内必须直接是纯 JSON 对象，顶层键严格为 \"name\" 和 \"arguments\"，禁止使用 <tool_name>/<arguments> 子标签，也禁止把参数平铺到顶层）：\n"
            << "<dimension_tool_call>\n"
            << "{\"name\": \"工具名\", \"arguments\": { ... }}\n"
            << "</dimension_tool_call>\n"
            << "如果本轮只需直接回复用户而不调用任何工具，则直接输出自然回复正文即可，不要输出该标签。\n\n";
        for (const auto& t : tools) {
            out << "- 工具名: " << t.name << "\n";
            if (!t.description.empty()) out << "  说明: " << t.description << "\n";
            if (!t.parameters.is_null()) {
                std::string schema_str = t.parameters.dump();
                if (schema_str.size() > 2400U) schema_str.resize(2400U);
                out << "  参数 Schema: " << schema_str << "\n";
            }
        }
        out << "\n";
    } else {
        out << "=== 输出要求 ===\n本轮无工具调用，请直接输出最终回复正文。\n\n";
    }

    // Dynamically project recent history using engine-aware budget (tightens when archived summary is present
    // so mid-conversation reception CLI switches stay responsive while always preserving the latest turn).
    const bool has_summary_in_sys =
        (sys_combined.find("已提交的历史摘要") != std::string::npos) ||
        (sys_combined.find("历史摘要") != std::string::npos) ||
        (sys_combined.find("compaction") != std::string::npos);
    const std::size_t kHistoryBudget =
        recommended_reception_history_budget(engine_id, context_feature, has_summary_in_sys);
    std::vector<std::string> selected_rev;
    std::size_t used = 0;
    for (auto it = turn_blocks.rbegin(); it != turn_blocks.rend(); ++it) {
        if (!selected_rev.empty() && used + it->size() > kHistoryBudget) break;
        used += it->size();
        selected_rev.push_back(*it);
    }
    out << "=== 对话与执行回执记录 ===\n";
    for (auto it = selected_rev.rbegin(); it != selected_rev.rend(); ++it) {
        out << *it << "\n\n";
    }
    out << "=== 请开始本轮回复 ===\n";
    return out.str();
}

std::string build_cli_reception_delta_prompt(const std::vector<ModelMessage>& new_messages) {
    std::ostringstream out;
    for (const auto& msg : new_messages) {
        if (msg.role == "system") continue;
        out << format_reception_message_block(msg) << "\n\n";
    }
    out << "=== 请继续本轮回复 ===\n";
    return out.str();
}

std::string compute_cli_reception_system_fingerprint(const ModelConfig& config,
                                                     const std::vector<ModelMessage>& messages,
                                                     const std::vector<ModelTool>& tools) {
    std::ostringstream sig;
    sig << "eng=" << config.cli_engine_id
        << "|prov=" << config.cli_native_provider
        << "|model=" << config.cli_native_model
        << "|feat=" << config.context_feature
        << "|think=" << (config.thinking_enabled.has_value() ? (*config.thinking_enabled ? "1" : "0") : "default")
        << "|eff=" << config.reasoning_effort << "\n";

    // Only include the primary system message (normalized for volatile time/char count).
    // Secondary system messages (per-turn memory recalls / runtime hints) are streamed as delta updates.
    for (const auto& msg : messages) {
        if (msg.role == "system" && !msg.content.empty()) {
            sig << "SYS0:" << normalize_primary_system_for_fingerprint(msg.content) << "\n";
            break;
        }
    }
    for (const auto& t : tools) {
        sig << "TOOL:" << t.name << "|" << t.description << "|";
        if (!t.parameters.is_null()) {
            std::string schema_str = t.parameters.dump();
            if (schema_str.size() > 900U) schema_str.resize(900U);
            sig << schema_str;
        }
        sig << "\n";
    }
    return hash128_hex(sig.str());
}

ModelReply parse_cli_reception_reply(std::string_view raw_text,
                                     const std::vector<ModelTool>& allowed_tools) {
    ModelReply reply;
    std::string src(raw_text);
    if (allowed_tools.empty()) {
        reply.text = trim_copy(src);
        return reply;
    }

    std::set<std::string> allowed_names;
    for (const auto& t : allowed_tools) allowed_names.insert(t.name);

    static constexpr std::string_view kOpenTag = "<dimension_tool_call>";
    static constexpr std::string_view kCloseTag = "</dimension_tool_call>";

    std::string cleaned_text;
    cleaned_text.reserve(src.size());
    std::size_t cursor = 0;
    int call_seq = 0;

    while (cursor < src.size()) {
        const std::size_t open_pos = src.find(kOpenTag, cursor);
        if (open_pos == std::string::npos) {
            cleaned_text.append(src, cursor, src.size() - cursor);
            break;
        }
        const std::size_t body_start = open_pos + kOpenTag.size();
        const std::size_t close_pos = src.find(kCloseTag, body_start);
        if (close_pos == std::string::npos) {
            cleaned_text.append(src, cursor, src.size() - cursor);
            break;
        }
        cleaned_text.append(src, cursor, open_pos - cursor);
        std::string payload = trim_copy(std::string_view(src).substr(body_start, close_pos - body_start));
        // Strip optional ```json ... ``` markdown fence inside tag
        if (payload.starts_with("```")) {
            const auto first_nl = payload.find('\n');
            if (first_nl != std::string::npos) payload.erase(0, first_nl + 1);
            if (payload.ends_with("```")) payload.resize(payload.size() - 3);
            payload = trim_copy(payload);
        }

        bool parsed_ok = false;
        bool was_tool_envelope = false;
        auto try_extract_xml_tag = [](std::string_view text, std::string_view tag) -> std::optional<std::string> {
            const std::string open = "<" + std::string(tag) + ">";
            const std::string close = "</" + std::string(tag) + ">";
            const auto p1 = text.find(open);
            if (p1 == std::string_view::npos) return std::nullopt;
            const auto vstart = p1 + open.size();
            const auto p2 = text.find(close, vstart);
            if (p2 == std::string_view::npos) return std::nullopt;
            return trim_copy(text.substr(vstart, p2 - vstart));
        };
        auto normalize_tool_args = [](const std::string& tname, Json::Object obj) -> std::string {
            if (tname == "dispatch_native_cli") {
                if (!obj.contains("task")) {
                    if (auto it = obj.find("instruction"); it != obj.end() && it->second.is_string()) {
                        obj["task"] = it->second;
                    } else if (auto it2 = obj.find("prompt"); it2 != obj.end() && it2->second.is_string()) {
                        obj["task"] = it2->second;
                    }
                }
                if (!obj.contains("engine")) {
                    if (auto it = obj.find("cli"); it != obj.end() && it->second.is_string()) {
                        obj["engine"] = it->second;
                    }
                }
            }
            return Json(std::move(obj)).dump();
        };
        try {
            const Json doc = Json::parse(payload);
            if (doc.is_object()) {
                std::string tname = jstr(doc, "name");
                if (tname.empty()) tname = jstr(doc, "tool_name");
                if (tname.empty()) tname = jstr(doc, "tool");
                if (!tname.empty()) {
                    was_tool_envelope = true;
                }
                if (!tname.empty() && allowed_names.contains(tname)) {
                    std::string args_str = "{}";
                    const auto* av = doc.find("arguments");
                    if (!av) av = doc.find("args");
                    if (!av) av = doc.find("params");
                    if (!av) av = doc.find("parameters");
                    if (av) {
                        if (av->is_object()) {
                            args_str = normalize_tool_args(tname, av->as_object());
                        } else if (av->is_string()) {
                            const auto sub = Json::parse(av->as_string());
                            if (sub.is_object()) args_str = normalize_tool_args(tname, sub.as_object());
                        }
                    } else {
                        // Model flattened arguments onto top-level JSON alongside "tool"/"name".
                        Json::Object flat;
                        for (const auto& [k, v] : doc.as_object()) {
                            if (k == "name" || k == "tool_name" || k == "tool") continue;
                            flat[k] = v;
                        }
                        if (!flat.empty()) {
                            args_str = normalize_tool_args(tname, std::move(flat));
                        }
                    }
                    ToolCall tc;
                    tc.id = "cli_tc_" + std::to_string(++call_seq);
                    tc.name = tname;
                    tc.arguments = std::move(args_str);
                    reply.tool_calls.push_back(std::move(tc));
                    parsed_ok = true;
                }
            }
        } catch (...) {}

        // Fallback tolerance for models that emit nested <tool_name>...</tool_name><arguments>{...}</arguments>.
        if (!parsed_ok) {
            auto xml_name = try_extract_xml_tag(payload, "tool_name");
            if (!xml_name) xml_name = try_extract_xml_tag(payload, "name");
            if (xml_name && !xml_name->empty()) {
                was_tool_envelope = true;
                if (allowed_names.contains(*xml_name)) {
                    std::string args_str = "{}";
                    auto xml_args = try_extract_xml_tag(payload, "arguments");
                    if (!xml_args) xml_args = try_extract_xml_tag(payload, "args");
                    if (xml_args && !xml_args->empty()) {
                        std::string a = *xml_args;
                        if (a.starts_with("```")) {
                            const auto nl = a.find('\n');
                            if (nl != std::string::npos) a.erase(0, nl + 1);
                            if (a.ends_with("```")) a.resize(a.size() - 3);
                            a = trim_copy(a);
                        }
                        try {
                            const auto parsed_args = Json::parse(a);
                            if (parsed_args.is_object()) args_str = parsed_args.dump();
                        } catch (...) {}
                    }
                    ToolCall tc;
                    tc.id = "cli_tc_" + std::to_string(++call_seq);
                    tc.name = *xml_name;
                    tc.arguments = std::move(args_str);
                    reply.tool_calls.push_back(std::move(tc));
                    parsed_ok = true;
                }
            }
        }

        if (!parsed_ok && !was_tool_envelope) {
            // Preserve unparsed text only if it did not look like a tool call envelope
            cleaned_text.append(src, open_pos, (close_pos + kCloseTag.size()) - open_pos);
        }
        cursor = close_pos + kCloseTag.size();
    }

    reply.text = trim_copy(cleaned_text);
    return reply;
}

namespace {

std::string canonical_reception_msg_key(const ModelMessage& msg) {
    std::ostringstream oss;
    oss << msg.role << '\x1f' << msg.tool_call_id << '\x1f' << msg.content << '\x1f' << msg.images.size();
    for (const auto& tc : msg.tool_calls) {
        oss << '\x1e' << tc.name << '\x1f' << tc.arguments;
    }
    return hash128_hex(oss.str());
}

struct ReceptionTurnInputs {
    std::string primary_time_anchor;
    std::string dynamic_sys_blob;
    std::vector<ModelMessage> non_sys_msgs;
    std::vector<std::string> non_sys_keys;
};

ReceptionTurnInputs extract_reception_turn_inputs(const std::vector<ModelMessage>& messages) {
    ReceptionTurnInputs out;
    bool seen_primary_sys = false;
    for (const auto& m : messages) {
        if (m.role == "system") {
            if (m.content.empty()) continue;
            if (!seen_primary_sys) {
                seen_primary_sys = true;
                out.primary_time_anchor = extract_time_anchor_from_system(m.content);
            } else {
                if (!out.dynamic_sys_blob.empty()) out.dynamic_sys_blob += "\n\n";
                out.dynamic_sys_blob += m.content;
            }
            continue;
        }
        out.non_sys_msgs.push_back(m);
        out.non_sys_keys.push_back(canonical_reception_msg_key(m));
    }
    if (out.dynamic_sys_blob.size() > 16000U) {
        out.dynamic_sys_blob = out.dynamic_sys_blob.substr(0, 16000U) + "\n…（动态上下文已截断）";
    }
    return out;
}

struct CachedReceptionSessionState {
    std::string session_id;
    std::string fingerprint;
    std::vector<std::string> sent_keys;
    std::string last_assistant_text;
    std::size_t last_assistant_tool_count = 0;
    std::string last_time_anchor;
    std::string last_dynamic_sys_blob;
    std::chrono::steady_clock::time_point last_used = std::chrono::steady_clock::now();
};

std::optional<std::string> try_build_incremental_delta_prompt(const CachedReceptionSessionState& st,
                                                              const ReceptionTurnInputs& cur,
                                                              const std::string& fingerprint) {
    if (st.fingerprint != fingerprint || st.sent_keys.empty()) return std::nullopt;
    if (cur.non_sys_keys.size() <= st.sent_keys.size()) return std::nullopt;
    for (std::size_t i = 0; i < st.sent_keys.size(); ++i) {
        if (cur.non_sys_keys[i] != st.sent_keys[i]) return std::nullopt;
    }

    std::size_t delta_start = st.sent_keys.size();
    // Skip the assistant reply emitted by this exact persistent session in the previous turn.
    if (delta_start < cur.non_sys_msgs.size() && cur.non_sys_msgs[delta_start].role == "assistant") {
        const auto& am = cur.non_sys_msgs[delta_start];
        if (trim_copy(am.content) == st.last_assistant_text &&
            am.tool_calls.size() == st.last_assistant_tool_count) {
            ++delta_start;
        }
    }
    if (delta_start >= cur.non_sys_msgs.size()) return std::nullopt;

    std::ostringstream out;
    if (!cur.primary_time_anchor.empty() && cur.primary_time_anchor != st.last_time_anchor) {
        out << "[当前本地时间：" << cur.primary_time_anchor << "]\n\n";
    }
    if (!cur.dynamic_sys_blob.empty() && cur.dynamic_sys_blob != st.last_dynamic_sys_blob) {
        out << "### [DYNAMIC CONTEXT UPDATE]\n" << cur.dynamic_sys_blob << "\n\n";
    }
    std::vector<ModelMessage> delta_msgs(cur.non_sys_msgs.begin() + static_cast<std::ptrdiff_t>(delta_start),
                                         cur.non_sys_msgs.end());
    out << build_cli_reception_delta_prompt(delta_msgs);
    return out.str();
}

struct ResolvedReceptionRuntime {
    std::string engine_id;
    std::string engine_name;
    std::string platform; // "windows" | "wsl"
    std::string binary_path;
    fs::path wsl_exe;
    std::string sandbox_distribution;
    fs::path sandbox_ws;
    std::string runtime_key;
};

std::wstring build_persistent_command_line(const ResolvedReceptionRuntime& rt,
                                           const std::vector<std::string>& cli_args,
                                           std::wstring& out_cwd_w,
                                           std::wstring& out_env_block,
                                           bool& out_use_env) {
    if (rt.platform == "wsl") {
        const fs::path wsl_exe = resolve_wsl_exe_path(rt.wsl_exe);
        if (wsl_exe.empty() || rt.sandbox_distribution.empty()) return {};
        const std::string linux_ws = windows_path_to_wsl_path(rt.sandbox_ws, rt.sandbox_distribution);
        const std::string linux_home = "/var/lib/dimension-cli-homes/" + rt.engine_id;
        std::vector<std::string> bw{
            "/usr/bin/bwrap",
            "--unshare-all",
            "--share-net",
            "--die-with-parent",
            "--new-session",
            "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/sbin", "/sbin",
            "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64",
            "--ro-bind-try", "/etc/passwd", "/etc/passwd",
            "--ro-bind-try", "/etc/group", "/etc/group",
            "--ro-bind-try", "/etc/hosts", "/etc/hosts",
            "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
            "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
            "--ro-bind-try", "/etc/ssl", "/etc/ssl",
            "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
            "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
            "--ro-bind-try", "/etc/localtime", "/etc/localtime",
            "--ro-bind", "/opt/dimension-tools", "/opt/dimension-tools",
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--ro-bind", linux_ws, "/workspace",
            "--dir", "/home/dimension",
            "--bind", linux_home, "/home/dimension",
            "--uid", "1001",
            "--gid", "1002",
            "--clearenv",
            "--setenv", "PATH", "/opt/dimension-tools/bin:/usr/local/bin:/usr/bin:/bin",
            "--setenv", "HOME", "/home/dimension",
            "--setenv", "USER", "dimension",
            "--setenv", "LOGNAME", "dimension",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "LC_ALL", "C.UTF-8",
            "--setenv", "TERM", "dumb",
            "--setenv", "TMPDIR", "/tmp",
            "--setenv", "PYTHONUTF8", "1",
            "--setenv", "PYTHONIOENCODING", "utf-8"
        };
        for (const auto& [pk, pv] : build_sandbox_proxy_env_overrides()) {
            bw.push_back("--setenv");
            bw.push_back(pk);
            bw.push_back(pv);
        }
        bw.push_back("--chdir");
        bw.push_back("/workspace");
        bw.push_back("--");
        bw.push_back(rt.binary_path);
        for (const auto& a : cli_args) bw.push_back(a);

        const std::string prep = "mkdir -p -m 700 \"$1\" && chown 1001:1002 \"$1\" && shift && exec \"$@\"";
        std::wstring cmd = quote_win_arg(wsl_exe.wstring())
            + L" -d " + quote_win_arg(utf8_to_wide(rt.sandbox_distribution))
            + L" -u root --exec /bin/sh -c " + quote_win_arg(utf8_to_wide(prep)) + L" _ "
            + quote_win_arg(utf8_to_wide(linux_home));
        for (const auto& ba : bw) {
            cmd.push_back(L' ');
            cmd += quote_win_arg(utf8_to_wide(ba));
        }
        out_cwd_w = rt.sandbox_ws.wstring();
        out_use_env = false;
        return cmd;
    }

    const std::string low_bin = ascii_lower(rt.binary_path);
    const bool is_cmd_script = low_bin.ends_with(".cmd") || low_bin.ends_with(".bat");
    std::wstring inner = quote_win_arg(utf8_to_wide(rt.binary_path));
    for (const auto& a : cli_args) {
        inner.push_back(L' ');
        inner += quote_win_arg(utf8_to_wide(a));
    }
    out_cwd_w = rt.sandbox_ws.wstring();
    std::vector<std::pair<std::string, std::string>> p_env = build_host_proxy_env_overrides();
    p_env.emplace_back("PYTHONUTF8", "1");
    p_env.emplace_back("PYTHONIOENCODING", "utf-8");
    out_env_block = build_environment_block(p_env);
    out_use_env = true;
    return is_cmd_script ? (L"cmd.exe /d /s /c \"" + inner + L"\"") : inner;
}

class PersistentChildProcess {
public:
    PersistentChildProcess() = default;
    ~PersistentChildProcess() {
        kill_process();
        cancel_and_join_stderr();
    }
    PersistentChildProcess(const PersistentChildProcess&) = delete;
    PersistentChildProcess& operator=(const PersistentChildProcess&) = delete;

    bool spawn(const std::wstring& cmd_line,
               const std::wstring& cwd_w,
               const std::wstring& env_block,
               bool use_env_block) {
        if (cmd_line.empty()) return false;

        SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr, in_r = nullptr, in_w = nullptr;
        if (!CreatePipe(&out_r, &out_w, &sa, 0)) return false;
        HandleGuard out_read(out_r), out_write(out_w);
        SetHandleInformation(out_read.h, HANDLE_FLAG_INHERIT, 0);

        if (!CreatePipe(&err_r, &err_w, &sa, 0)) return false;
        HandleGuard err_read(err_r), err_write(err_w);
        SetHandleInformation(err_read.h, HANDLE_FLAG_INHERIT, 0);

        if (!CreatePipe(&in_r, &in_w, &sa, 0)) return false;
        HandleGuard in_read(in_r), in_write(in_w);
        SetHandleInformation(in_write.h, HANDLE_FLAG_INHERIT, 0);

        HandleGuard job(CreateJobObjectW(nullptr, nullptr));
        if (job.h) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        si.hStdInput = in_read.h;
        si.hStdOutput = out_write.h;
        si.hStdError = err_write.h;

        std::vector<wchar_t> mutable_cmd(cmd_line.begin(), cmd_line.end());
        mutable_cmd.push_back(L'\0');
        DWORD create_flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP;
        LPVOID env_ptr = nullptr;
        std::wstring env_copy = env_block;
        if (use_env_block && !env_copy.empty()) {
            env_ptr = env_copy.data();
            create_flags |= CREATE_UNICODE_ENVIRONMENT;
        }

        PROCESS_INFORMATION pi{};
        if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                            create_flags, env_ptr, cwd_w.empty() ? nullptr : cwd_w.c_str(), &si, &pi)) {
            return false;
        }

        proc_h_ = HandleGuard(pi.hProcess);
        HandleGuard thread_h(pi.hThread);
        job_ = std::move(job);
        if (job_.h) AssignProcessToJobObject(job_.h, proc_h_.h);
        ResumeThread(thread_h.h);

        out_read_ = std::move(out_read);
        err_read_ = std::move(err_read);
        {
            std::lock_guard lk(write_mu_);
            in_write_ = std::move(in_write);
        }

        stderr_drainer_ = std::jthread([this]() {
            char buf[2048];
            DWORD n = 0;
            while (err_read_.h && ReadFile(err_read_.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
                std::lock_guard lk(err_mu_);
                if (stderr_tail_.size() > 8192U) {
                    stderr_tail_.erase(0, stderr_tail_.size() - 4096U);
                }
                stderr_tail_.append(buf, n);
            }
        });
        return true;
    }

    HANDLE stdout_handle() const { return out_read_.h; }

    bool is_running() const {
        return proc_h_.h && WaitForSingleObject(proc_h_.h, 0) == WAIT_TIMEOUT;
    }

    bool write_line(std::string_view line) {
        std::string buf;
        buf.reserve(line.size() + 1U);
        buf.append(line);
        buf.push_back('\n');
        std::lock_guard lk(write_mu_);
        if (!in_write_.h) return false;
        const char* p = buf.data();
        std::size_t rem = buf.size();
        while (rem > 0) {
            const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(rem, 32768U));
            DWORD written = 0;
            if (!WriteFile(in_write_.h, p, chunk, &written, nullptr) || written == 0) {
                return false;
            }
            p += written;
            rem -= written;
        }
        return true;
    }

    void close_stdin() {
        std::lock_guard lk(write_mu_);
        in_write_ = HandleGuard{};
    }

    void kill_process() {
        close_stdin();
        if (job_.h) {
            TerminateJobObject(job_.h, 0);
        } else if (proc_h_.h) {
            TerminateProcess(proc_h_.h, 0);
        }
        if (proc_h_.h) {
            WaitForSingleObject(proc_h_.h, 500);
        }
    }

    void cancel_and_join_stderr() {
        if (stderr_drainer_.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(stderr_drainer_.native_handle()));
            stderr_drainer_.join();
        }
    }

    std::string stderr_summary() const {
        std::lock_guard lk(err_mu_);
        return trim_copy(ensure_valid_utf8(stderr_tail_));
    }

private:
    HandleGuard job_;
    HandleGuard proc_h_;
    std::mutex write_mu_;
    HandleGuard in_write_;
    HandleGuard out_read_;
    HandleGuard err_read_;
    mutable std::mutex err_mu_;
    std::string stderr_tail_;
    std::jthread stderr_drainer_;
};

struct PoolCallOutcome {
    bool handled = false;
    bool cancelled = false;
    bool streamed_any_text = false;
    bool timed_out = false;
    std::string error_detail;
    ModelReply reply;
};

class KimiAcpWorker {
public:
    explicit KimiAcpWorker(ResolvedReceptionRuntime rt)
        : rt_(std::move(rt)), last_used_(std::chrono::steady_clock::now()) {}

    ~KimiAcpWorker() { stop(); }

    const std::string& runtime_key() const { return rt_.runtime_key; }
    bool is_alive() const { return alive_.load(std::memory_order_acquire) && proc_.is_running(); }
    std::chrono::steady_clock::time_point last_used() const {
        std::lock_guard lk(sess_mu_);
        return last_used_;
    }

    bool has_matching_session(const std::string& fingerprint,
                              const ReceptionTurnInputs& inputs) const {
        std::lock_guard lk(sess_mu_);
        for (const auto& s : sessions_) {
            if (try_build_incremental_delta_prompt(s, inputs, fingerprint).has_value()) {
                return true;
            }
        }
        return false;
    }

    bool start() {
        std::wstring cwd_w, env_block;
        bool use_env = false;
        const std::wstring cmd = build_persistent_command_line(rt_, {"acp"}, cwd_w, env_block, use_env);
        if (cmd.empty() || !proc_.spawn(cmd, cwd_w, env_block, use_env)) {
            return false;
        }
        alive_.store(true, std::memory_order_release);
        stdout_reader_ = std::jthread([this]() { reader_loop(); });

        const Json init_params = O{
            {"protocolVersion", 1.0},
            {"clientCapabilities", O{
                {"fs", O{{"readTextFile", false}, {"writeTextFile", false}}}
            }}
        };
        auto init_resp = send_rpc("initialize", init_params, 20000, {});
        if (!init_resp || init_resp->find("error")) {
            stop();
            return false;
        }
        touch();
        return true;
    }

    void stop() {
        alive_.store(false, std::memory_order_release);
        rpc_cv_.notify_all();
        proc_.kill_process();
        if (stdout_reader_.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(stdout_reader_.native_handle()));
            stdout_reader_.join();
        }
        proc_.cancel_and_join_stderr();
    }

    PoolCallOutcome run_turn(const ModelConfig& config,
                             const std::vector<ModelMessage>& messages,
                             const std::vector<ModelTool>& tools,
                             const std::string& fingerprint,
                             const ReceptionTurnInputs& inputs,
                             ModelChunk chunk,
                             std::stop_token stop_tok,
                             int timeout_seconds) {
        PoolCallOutcome out;
        if (!is_alive()) return out;

        std::string sid;
        std::string prompt_payload;
        bool reused_session = false;
        {
            std::lock_guard lk(sess_mu_);
            for (auto it = sessions_.begin(); it != sessions_.end(); ++it) {
                if (auto delta = try_build_incremental_delta_prompt(*it, inputs, fingerprint)) {
                    sid = it->session_id;
                    prompt_payload = std::move(*delta);
                    reused_session = true;
                    break;
                }
            }
        }

        if (!reused_session) {
            const std::string acp_cwd = (rt_.platform == "wsl")
                ? std::string("/workspace")
                : path_to_utf8(rt_.sandbox_ws);
            auto ns_resp = send_rpc("session/new", O{{"cwd", acp_cwd}, {"mcpServers", A{}}}, 15000, stop_tok);
            if (stop_tok.stop_requested()) {
                out.handled = true;
                out.cancelled = true;
                return out;
            }
            if (!ns_resp || ns_resp->find("error")) {
                stop();
                return out;
            }
            if (const auto* r = ns_resp->find("result"); r && r->is_object()) {
                sid = jstr(*r, "sessionId");
            }
            if (sid.empty()) {
                stop();
                return out;
            }

            // Configure explicit model first (so model switch cannot reset thinking), then set thinking and default mode.
            // Note: Do NOT use Kimi ACP's built-in "plan" mode here because Kimi's plan mode injects its own
            // "write .kimi/plans file + ExitPlanMode" agent loop; instead use "default" mode while our
            // handle_jsonrpc_line auto-cancels any server permission request and the sandbox workspace is isolated.
            if (!config.cli_native_model.empty()) {
                (void)send_rpc("session/set_config_option", O{
                    {"sessionId", sid}, {"configId", "model"}, {"value", config.cli_native_model}
                }, 5000, stop_tok);
            }
            (void)send_rpc("session/set_config_option", O{
                {"sessionId", sid}, {"configId", "mode"}, {"value", "default"}
            }, 5000, stop_tok);
            (void)send_rpc("session/set_config_option", O{
                {"sessionId", sid}, {"configId", "thinking"}, {"value", config.thinking_enabled.value_or(true) ? "on" : "off"}
            }, 5000, stop_tok);
            if (stop_tok.stop_requested()) {
                out.handled = true;
                out.cancelled = true;
                return out;
            }
            prompt_payload = build_cli_reception_prompt(messages, tools, config.context_feature, config.cli_engine_id);
        }

        ActiveTurn turn;
        turn.session_id = sid;
        turn.has_tools = !tools.empty();
        turn.chunk = chunk;
        {
            std::lock_guard lk(active_mu_);
            active_turn_ = &turn;
        }
        struct ActiveGuard {
            KimiAcpWorker* self;
            ~ActiveGuard() {
                std::lock_guard lk(self->active_mu_);
                self->active_turn_ = nullptr;
            }
        } active_guard{this};

        bool cancelled = false;
        bool timed_out = false;
        const int rpc_id = next_rpc_id_.fetch_add(1, std::memory_order_relaxed);
        const Json req_doc = O{
            {"jsonrpc", "2.0"},
            {"id", static_cast<double>(rpc_id)},
            {"method", "session/prompt"},
            {"params", O{
                {"sessionId", sid},
                {"prompt", A{O{{"type", "text"}, {"text", prompt_payload}}}}
            }}
        };
        if (!proc_.write_line(req_doc.dump())) {
            stop();
            return out;
        }

        auto resp = wait_rpc_response(rpc_id, timeout_seconds * 1000, stop_tok, &cancelled, &timed_out);
        if (cancelled) {
            const Json cancel_note = O{
                {"jsonrpc", "2.0"},
                {"method", "session/cancel"},
                {"params", O{{"sessionId", sid}}}
            };
            (void)proc_.write_line(cancel_note.dump());
            erase_session(sid);
            // Wait briefly for prompt RPC to unwind cleanly; if stuck, recycle worker.
            bool c2 = false, t2 = false;
            if (!wait_rpc_response(rpc_id, 1500, {}, &c2, &t2)) {
                stop();
            }
            out.handled = true;
            out.cancelled = true;
            return out;
        }
        if (timed_out) {
            const Json cancel_note = O{
                {"jsonrpc", "2.0"},
                {"method", "session/cancel"},
                {"params", O{{"sessionId", sid}}}
            };
            (void)proc_.write_line(cancel_note.dump());
            stop();
            out.handled = true;
            out.timed_out = true;
            out.streamed_any_text = turn.streamed_any_text;
            out.error_detail = "CLI 执行超过单轮时间上限（" + std::to_string(timeout_seconds) + "s）";
            return out;
        }
        if (!resp || resp->find("error")) {
            erase_session(sid);
            std::string err_msg;
            if (resp) {
                if (const auto* err = resp->find("error"); err && err->is_object()) {
                    err_msg = jstr(*err, "message");
                }
            }
            if (!is_alive()) stop();
            if (turn.streamed_any_text) {
                out.handled = true;
                out.streamed_any_text = true;
                out.error_detail = err_msg.empty() ? proc_.stderr_summary() : err_msg;
            }
            return out;
        }

        // Flush any buffered non-tag tail from ReceptionTextStreamFilter.
        if (turn.has_tools && chunk) {
            turn.filter.flush([&](std::string_view piece) {
                if (!piece.empty()) {
                    turn.streamed_any_text = true;
                    try { chunk("text", piece); } catch (...) {}
                }
            });
        }

        ModelReply reply = parse_cli_reception_reply(turn.raw_text, tools);
        reply.input_tokens = static_cast<int>(std::min<std::int64_t>(turn.input_tokens, 2000000000LL));
        reply.output_tokens = static_cast<int>(std::min<std::int64_t>(turn.output_tokens, 2000000000LL));
        if (const auto* res = resp->find("result"); res && res->is_object()) {
            if (const auto* u = res->find("usage"); u && u->is_object()) {
                const auto in_t = static_cast<std::int64_t>(jnum(*u, "inputTokens", jnum(*u, "input_tokens", 0)));
                const auto out_t = static_cast<std::int64_t>(jnum(*u, "outputTokens", jnum(*u, "output_tokens", 0)));
                if (in_t > reply.input_tokens) reply.input_tokens = static_cast<int>(std::min<std::int64_t>(in_t, 2000000000LL));
                if (out_t > reply.output_tokens) reply.output_tokens = static_cast<int>(std::min<std::int64_t>(out_t, 2000000000LL));
            }
        }
        if (chunk && !turn.streamed_any_text && !reply.text.empty()) {
            try { chunk("text", reply.text); } catch (...) {}
            turn.streamed_any_text = true;
        }

        // Persist updated session state for O(1) incremental reuse on the next turn.
        {
            std::lock_guard lk(sess_mu_);
            last_used_ = std::chrono::steady_clock::now();
            CachedReceptionSessionState st;
            st.session_id = sid;
            st.fingerprint = fingerprint;
            st.sent_keys = inputs.non_sys_keys;
            st.last_assistant_text = reply.text;
            st.last_assistant_tool_count = reply.tool_calls.size();
            st.last_time_anchor = inputs.primary_time_anchor;
            st.last_dynamic_sys_blob = inputs.dynamic_sys_blob;
            st.last_used = last_used_;
            bool replaced = false;
            for (auto& existing : sessions_) {
                if (existing.session_id == sid) {
                    existing = std::move(st);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                sessions_.push_back(std::move(st));
                while (sessions_.size() > 8U) {
                    sessions_.pop_front();
                }
            }
        }

        out.handled = true;
        out.streamed_any_text = turn.streamed_any_text;
        out.reply = std::move(reply);
        return out;
    }

private:
    struct ActiveTurn {
        std::string session_id;
        bool has_tools = false;
        ModelChunk chunk;
        ReceptionTextStreamFilter filter;
        std::string raw_text;
        bool streamed_any_text = false;
        std::int64_t input_tokens = 0;
        std::int64_t output_tokens = 0;
    };

    void touch() {
        std::lock_guard lk(sess_mu_);
        last_used_ = std::chrono::steady_clock::now();
    }

    void erase_session(const std::string& sid) {
        std::lock_guard lk(sess_mu_);
        for (auto it = sessions_.begin(); it != sessions_.end(); ++it) {
            if (it->session_id == sid) {
                sessions_.erase(it);
                break;
            }
        }
    }

    std::optional<Json> send_rpc(const std::string& method,
                                 const Json& params,
                                 int timeout_ms,
                                 std::stop_token stop_tok) {
        const int id = next_rpc_id_.fetch_add(1, std::memory_order_relaxed);
        const Json req = O{
            {"jsonrpc", "2.0"},
            {"id", static_cast<double>(id)},
            {"method", method},
            {"params", params}
        };
        if (!proc_.write_line(req.dump())) {
            alive_.store(false, std::memory_order_release);
            return std::nullopt;
        }
        bool cancelled = false, timed_out = false;
        return wait_rpc_response(id, timeout_ms, stop_tok, &cancelled, &timed_out);
    }

    std::optional<Json> wait_rpc_response(int id,
                                          int timeout_ms,
                                          std::stop_token stop_tok,
                                          bool* out_cancelled,
                                          bool* out_timed_out) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
        std::unique_lock lk(rpc_mu_);
        while (true) {
            if (auto it = rpc_responses_.find(id); it != rpc_responses_.end()) {
                Json val = std::move(it->second);
                rpc_responses_.erase(it);
                return val;
            }
            if (stop_tok.stop_requested()) {
                if (out_cancelled) *out_cancelled = true;
                return std::nullopt;
            }
            if (!alive_.load(std::memory_order_acquire)) {
                return std::nullopt;
            }
            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline) {
                if (out_timed_out) *out_timed_out = true;
                return std::nullopt;
            }
            const auto step = std::min(deadline - now,
                std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::milliseconds(50)));
            rpc_cv_.wait_for(lk, step);
        }
    }

    void reader_loop() {
        std::string pending;
        char buf[4096];
        DWORD n = 0;
        HANDLE h = proc_.stdout_handle();
        while (h && ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            pending.append(buf, n);
            std::size_t nl = 0;
            while ((nl = pending.find('\n')) != std::string::npos) {
                std::string line = pending.substr(0, nl);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                pending.erase(0, nl + 1);
                handle_jsonrpc_line(line);
            }
        }
        if (!pending.empty()) handle_jsonrpc_line(pending);
        alive_.store(false, std::memory_order_release);
        rpc_cv_.notify_all();
    }

    void handle_jsonrpc_line(std::string_view raw_line) {
        const std::string line = trim_copy(ensure_valid_utf8(raw_line));
        if (line.empty() || line.front() != '{') return;
        Json doc;
        try {
            doc = Json::parse(line);
        } catch (...) {
            return;
        }
        if (!doc.is_object()) return;

        const auto* id_val = doc.find("id");
        const std::string method = jstr(doc, "method");

        // Auto-cancel any unexpected server-initiated request (e.g. permission prompt) to prevent deadlocks.
        if (id_val && !method.empty()) {
            const Json reject = O{
                {"jsonrpc", "2.0"},
                {"id", *id_val},
                {"result", O{{"outcome", O{{"outcome", "cancelled"}}}}}
            };
            (void)proc_.write_line(reject.dump());
            return;
        }

        // Standard JSON-RPC response to one of our requests.
        if (id_val && id_val->is_number()) {
            const int rid = static_cast<int>(id_val->as_number());
            {
                std::lock_guard lk(rpc_mu_);
                rpc_responses_[rid] = std::move(doc);
            }
            rpc_cv_.notify_all();
            return;
        }

        // Streaming session/update notification.
        if (method == "session/update") {
            const auto* params = doc.find("params");
            if (!params || !params->is_object()) return;
            const std::string sid = jstr(*params, "sessionId");
            const auto* upd = params->find("update");
            if (!upd || !upd->is_object()) return;
            const std::string kind = jstr(*upd, "sessionUpdate");

            std::lock_guard lk(active_mu_);
            if (!active_turn_ || (!sid.empty() && sid != active_turn_->session_id)) return;

            if (kind == "agent_thought_chunk") {
                if (const auto* content = upd->find("content"); content && content->is_object()) {
                    const std::string text = jstr(*content, "text");
                    if (!text.empty() && active_turn_->chunk) {
                        try { active_turn_->chunk("thinking", text); } catch (...) {}
                    }
                }
            } else if (kind == "agent_message_chunk") {
                if (const auto* content = upd->find("content"); content && content->is_object()) {
                    const std::string text = jstr(*content, "text");
                    if (!text.empty()) {
                        active_turn_->raw_text += text;
                        if (active_turn_->chunk) {
                            if (active_turn_->has_tools) {
                                active_turn_->filter.feed(text, [&](std::string_view piece) {
                                    if (!piece.empty()) {
                                        active_turn_->streamed_any_text = true;
                                        try { active_turn_->chunk("text", piece); } catch (...) {}
                                    }
                                });
                            } else {
                                active_turn_->streamed_any_text = true;
                                try { active_turn_->chunk("text", text); } catch (...) {}
                            }
                        }
                    }
                }
            } else if (kind == "usage_update") {
                const auto used = static_cast<std::int64_t>(jnum(*upd, "used", 0));
                if (used > active_turn_->input_tokens) active_turn_->input_tokens = used;
            }
        }
    }

    ResolvedReceptionRuntime rt_;
    PersistentChildProcess proc_;
    std::atomic<bool> alive_{false};
    std::atomic<int> next_rpc_id_{1};
    std::jthread stdout_reader_;

    std::mutex rpc_mu_;
    std::condition_variable rpc_cv_;
    std::map<int, Json> rpc_responses_;

    std::mutex active_mu_;
    ActiveTurn* active_turn_ = nullptr;

    mutable std::mutex sess_mu_;
    std::deque<CachedReceptionSessionState> sessions_;
    std::chrono::steady_clock::time_point last_used_;
};

class AgyStreamWorker {
public:
    AgyStreamWorker(ResolvedReceptionRuntime rt, std::string fingerprint,
                    std::string native_model, std::string reasoning_effort)
        : rt_(std::move(rt)),
          fingerprint_(std::move(fingerprint)),
          native_model_(std::move(native_model)),
          reasoning_effort_(std::move(reasoning_effort)) {
        state_.fingerprint = fingerprint_;
        state_.last_used = std::chrono::steady_clock::now();
    }

    ~AgyStreamWorker() { stop(); }

    static std::string effective_agy_effort(std::string_view model, std::string_view effort) {
        const std::string low_m = ascii_lower(model);
        const bool encodes = low_m.ends_with("-xhigh") || low_m.ends_with("-high") ||
                             low_m.ends_with("-medium") || low_m.ends_with("-low") || low_m.ends_with("-max");
        if (encodes) return {};
        if (effort == "low" || effort == "medium" || effort == "high" || effort == "xhigh" || effort == "max") {
            return std::string(effort);
        }
        return {};
    }

    const std::string& runtime_key() const { return rt_.runtime_key; }
    const std::string& fingerprint() const { return fingerprint_; }
    bool is_alive() const { return alive_.load(std::memory_order_acquire) && proc_.is_running(); }
    std::chrono::steady_clock::time_point last_used() const { return state_.last_used; }
    bool is_blank_standby() const { return is_alive() && fingerprint_.empty() && state_.sent_keys.empty(); }

    bool matches_model_and_effort(const std::string& model, const std::string& effort) const {
        return native_model_ == model &&
               effective_agy_effort(native_model_, reasoning_effort_) == effective_agy_effort(model, effort);
    }

    void claim_for_session(const std::string& fp) {
        fingerprint_ = fp;
        state_.fingerprint = fp;
        state_.last_used = std::chrono::steady_clock::now();
    }

    bool can_reuse_for(const std::string& fp, const ReceptionTurnInputs& inputs) const {
        return is_alive() && !fingerprint_.empty() && try_build_incremental_delta_prompt(state_, inputs, fp).has_value();
    }

    bool start() {
        std::vector<std::string> args{
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--disable-slash-commands"
        };
        if (!native_model_.empty()) {
            args.push_back("--model");
            args.push_back(native_model_);
        }
        const std::string eff = effective_agy_effort(native_model_, reasoning_effort_);
        if (!eff.empty()) {
            args.push_back("--effort");
            args.push_back(eff);
        }
        std::wstring cwd_w, env_block;
        bool use_env = false;
        const std::wstring cmd = build_persistent_command_line(rt_, args, cwd_w, env_block, use_env);
        if (cmd.empty() || !proc_.spawn(cmd, cwd_w, env_block, use_env)) {
            return false;
        }
        alive_.store(true, std::memory_order_release);
        stdout_reader_ = std::jthread([this]() { reader_loop(); });
        return true;
    }

    void stop() {
        alive_.store(false, std::memory_order_release);
        turn_cv_.notify_all();
        proc_.kill_process();
        if (stdout_reader_.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(stdout_reader_.native_handle()));
            stdout_reader_.join();
        }
        proc_.cancel_and_join_stderr();
    }

    PoolCallOutcome run_turn(const ModelConfig& config,
                             const std::vector<ModelMessage>& messages,
                             const std::vector<ModelTool>& tools,
                             const ReceptionTurnInputs& inputs,
                             ModelChunk chunk,
                             std::stop_token stop_tok,
                             int timeout_seconds) {
        PoolCallOutcome out;
        if (!is_alive()) return out;

        std::string payload;
        if (auto delta = try_build_incremental_delta_prompt(state_, inputs, fingerprint_)) {
            payload = std::move(*delta);
        } else if (state_.sent_keys.empty()) {
            payload = build_cli_reception_prompt(messages, tools, config.context_feature, config.cli_engine_id);
        } else {
            return out;
        }

        ActiveTurn turn;
        turn.has_tools = !tools.empty();
        turn.chunk = chunk;
        {
            std::lock_guard lk(turn_mu_);
            active_turn_ = &turn;
        }
        struct ActiveGuard {
            AgyStreamWorker* self;
            ~ActiveGuard() {
                std::lock_guard lk(self->turn_mu_);
                self->active_turn_ = nullptr;
            }
        } active_guard{this};

        const Json user_ev = O{
            {"event", "user"},
            {"message", O{{"content", payload}}}
        };
        if (!proc_.write_line(user_ev.dump())) {
            stop();
            return out;
        }

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout_seconds);
        bool cancelled = false;
        bool timed_out = false;
        {
            std::unique_lock lk(turn_mu_);
            while (!turn.finished) {
                if (stop_tok.stop_requested()) {
                    cancelled = true;
                    break;
                }
                if (!alive_.load(std::memory_order_acquire)) {
                    break;
                }
                const auto now = std::chrono::steady_clock::now();
                if (now >= deadline) {
                    timed_out = true;
                    break;
                }
                const auto step = std::min(deadline - now,
                    std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::milliseconds(50)));
                turn_cv_.wait_for(lk, step);
            }
        }

        if (cancelled) {
            stop();
            out.handled = true;
            out.cancelled = true;
            return out;
        }
        if (timed_out) {
            stop();
            out.handled = true;
            out.timed_out = true;
            out.streamed_any_text = turn.streamed_any_text;
            out.error_detail = "CLI 执行超过单轮时间上限（" + std::to_string(timeout_seconds) + "s）";
            return out;
        }
        if (!turn.finished || turn.is_error) {
            stop();
            if (turn.streamed_any_text) {
                out.handled = true;
                out.streamed_any_text = true;
                out.error_detail = !turn.error_detail.empty() ? turn.error_detail : proc_.stderr_summary();
            }
            return out;
        }

        if (turn.has_tools && chunk) {
            turn.filter.flush([&](std::string_view piece) {
                if (!piece.empty()) {
                    turn.streamed_any_text = true;
                    try { chunk("text", piece); } catch (...) {}
                }
            });
        }

        const std::string& final_raw =
            (!turn.result_response.empty() && turn.raw_text.empty())
                ? turn.result_response
                : ((!turn.result_response.empty() && turn.result_response.size() >= turn.raw_text.size())
                    ? turn.result_response : turn.raw_text);
        ModelReply reply = parse_cli_reception_reply(final_raw, tools);
        reply.input_tokens = static_cast<int>(std::min<std::int64_t>(turn.input_tokens, 2000000000LL));
        reply.output_tokens = static_cast<int>(std::min<std::int64_t>(turn.output_tokens, 2000000000LL));
        if (chunk && !turn.streamed_any_text && !reply.text.empty()) {
            try { chunk("text", reply.text); } catch (...) {}
            turn.streamed_any_text = true;
        }

        state_.sent_keys = inputs.non_sys_keys;
        state_.last_assistant_text = reply.text;
        state_.last_assistant_tool_count = reply.tool_calls.size();
        state_.last_time_anchor = inputs.primary_time_anchor;
        state_.last_dynamic_sys_blob = inputs.dynamic_sys_blob;
        state_.last_used = std::chrono::steady_clock::now();

        out.handled = true;
        out.streamed_any_text = turn.streamed_any_text;
        out.reply = std::move(reply);
        return out;
    }

private:
    struct ActiveTurn {
        bool has_tools = false;
        ModelChunk chunk;
        ReceptionTextStreamFilter filter;
        std::string raw_text;
        std::string result_response;
        std::string error_detail;
        bool streamed_any_text = false;
        bool finished = false;
        bool is_error = false;
        std::int64_t input_tokens = 0;
        std::int64_t output_tokens = 0;
    };

    void reader_loop() {
        std::string pending;
        char buf[4096];
        DWORD n = 0;
        HANDLE h = proc_.stdout_handle();
        while (h && ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            pending.append(buf, n);
            std::size_t nl = 0;
            while ((nl = pending.find('\n')) != std::string::npos) {
                std::string line = pending.substr(0, nl);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                pending.erase(0, nl + 1);
                handle_agy_line(line);
            }
        }
        if (!pending.empty()) handle_agy_line(pending);
        alive_.store(false, std::memory_order_release);
        turn_cv_.notify_all();
    }

    void handle_agy_line(std::string_view raw_line) {
        const std::string line = trim_copy(ensure_valid_utf8(raw_line));
        if (line.empty() || line.front() != '{') return;
        Json doc;
        try {
            doc = Json::parse(line);
        } catch (...) {
            return;
        }
        if (!doc.is_object()) return;

        const std::string ev = jstr(doc, "event");
        std::lock_guard lk(turn_mu_);
        if (!active_turn_) return;

        if (ev == "step_update") {
            const auto* su = doc.find("step_update");
            const Json& holder = (su && su->is_object()) ? *su : doc;
            const std::string step_type = jstr(holder, "step_type");
            const std::string think_delta = jstr(holder, "thinking_delta", jstr(holder, "thinking"));
            if (!think_delta.empty() && active_turn_->chunk) {
                try { active_turn_->chunk("thinking", think_delta); } catch (...) {}
            } else if (step_type == "thought" || step_type == "thinking" || step_type == "reasoning") {
                const std::string t = jstr(holder, "text_delta", jstr(holder, "delta", jstr(holder, "text")));
                if (!t.empty() && active_turn_->chunk) {
                    try { active_turn_->chunk("thinking", t); } catch (...) {}
                }
            }
            const std::string text_delta = jstr(holder, "text_delta", jstr(holder, "delta"));
            if (!text_delta.empty() && step_type != "thought" && step_type != "thinking" && step_type != "reasoning") {
                active_turn_->raw_text += text_delta;
                if (active_turn_->chunk) {
                    if (active_turn_->has_tools) {
                        active_turn_->filter.feed(text_delta, [&](std::string_view piece) {
                            if (!piece.empty()) {
                                active_turn_->streamed_any_text = true;
                                try { active_turn_->chunk("text", piece); } catch (...) {}
                            }
                        });
                    } else {
                        active_turn_->streamed_any_text = true;
                        try { active_turn_->chunk("text", text_delta); } catch (...) {}
                    }
                }
            }
        } else if (ev == "result") {
            const auto* res = doc.find("result");
            const Json& holder = (res && res->is_object()) ? *res : doc;
            const std::string status = ascii_lower(jstr(holder, "status"));
            const std::string err_msg = jstr(holder, "error");
            active_turn_->result_response = jstr(holder, "response", jstr(holder, "text"));
            if (const auto* u = holder.find("usage"); u && u->is_object()) {
                active_turn_->input_tokens = static_cast<std::int64_t>(jnum(*u, "input_tokens", 0));
                active_turn_->output_tokens = static_cast<std::int64_t>(jnum(*u, "output_tokens", 0));
            }
            if ((!status.empty() && status != "success" && status != "ok") || !err_msg.empty()) {
                active_turn_->is_error = true;
                active_turn_->error_detail = !err_msg.empty() ? err_msg : active_turn_->result_response;
            }
            active_turn_->finished = true;
            turn_cv_.notify_all();
        } else if (ev == "error") {
            const auto* err_obj = doc.find("error");
            const Json& holder = (err_obj && err_obj->is_object()) ? *err_obj : doc;
            active_turn_->is_error = true;
            active_turn_->error_detail = jstr(holder, "message", jstr(doc, "error"));
            active_turn_->finished = true;
            turn_cv_.notify_all();
        }
    }

    ResolvedReceptionRuntime rt_;
    std::string fingerprint_;
    std::string native_model_;
    std::string reasoning_effort_;
    CachedReceptionSessionState state_;
    PersistentChildProcess proc_;
    std::atomic<bool> alive_{false};
    std::jthread stdout_reader_;

    std::mutex turn_mu_;
    std::condition_variable turn_cv_;
    ActiveTurn* active_turn_ = nullptr;
};

class CliReceptionPool {
public:
    static CliReceptionPool& instance() {
        static CliReceptionPool pool;
        return pool;
    }

    ~CliReceptionPool() { shutdown(); }

    void prewarm(const std::string& engine_id,
                 const fs::path& data_root,
                 const fs::path& app_root,
                 const fs::path& wsl_executable,
                 const std::string& sandbox_distribution,
                 const std::string& execution_policy,
                 const std::string& native_model = {},
                 const std::string& reasoning_effort = {}) {
        if (engine_id != "kimi-code" && engine_id != "antigravity") return;
        std::lock_guard lk(mu_);
        if (shutting_down_) return;
        if (prewarm_running_) return;
        if (prewarm_thread_.joinable()) prewarm_thread_.join();
        prewarm_running_ = true;
        prewarm_thread_ = std::thread([this, engine_id, data_root, app_root, wsl_executable,
                                       sandbox_distribution, execution_policy, native_model, reasoning_effort]() {
            struct DoneGuard {
                CliReceptionPool* self;
                ~DoneGuard() {
                    std::lock_guard lk2(self->mu_);
                    self->prewarm_running_ = false;
                }
            } done_guard{this};
            try {
                auto rt = resolve_runtime(engine_id, data_root, app_root, wsl_executable,
                                          sandbox_distribution, execution_policy);
                if (!rt) return;

                if (engine_id == "kimi-code") {
                    {
                        std::lock_guard lk2(mu_);
                        if (shutting_down_) return;
                        for (const auto& slot : kimi_slots_) {
                            if (slot.worker && slot.worker->runtime_key() == rt->runtime_key && slot.worker->is_alive()) {
                                return; // Already warm!
                            }
                        }
                    }
                    auto worker = std::make_shared<KimiAcpWorker>(*rt);
                    if (!worker->start()) return;
                    std::lock_guard lk2(mu_);
                    if (shutting_down_) {
                        worker->stop();
                        return;
                    }
                    if (kimi_slots_.size() < 2U) {
                        kimi_slots_.push_back(KimiSlot{std::move(worker), false});
                    } else {
                        worker->stop();
                    }
                    return;
                }

                // Antigravity (`agy`) blank standby warmup: completes ~5s silent auth + loadCodeAssist + init in background
                // with zero LLM tokens consumed so the user's first message launches immediately (~28ms).
                std::vector<std::shared_ptr<AgyStreamWorker>> replaced_standbys;
                {
                    std::lock_guard lk2(mu_);
                    if (shutting_down_) return;
                    for (const auto& slot : agy_slots_) {
                        if (!slot.busy && slot.worker && slot.worker->runtime_key() == rt->runtime_key &&
                            slot.worker->is_blank_standby() &&
                            slot.worker->matches_model_and_effort(native_model, reasoning_effort)) {
                            return; // Matching warm standby already ready!
                        }
                    }
                }
                auto worker = std::make_shared<AgyStreamWorker>(*rt, std::string{}, native_model, reasoning_effort);
                if (!worker->start()) return;
                {
                    std::lock_guard lk2(mu_);
                    if (shutting_down_) {
                        worker->stop();
                        return;
                    }
                    // Replace any stale blank standby targeting a different model so we keep at most 1 standby slot.
                    for (auto it = agy_slots_.begin(); it != agy_slots_.end();) {
                        if (!it->busy && it->worker && it->worker->is_blank_standby()) {
                            replaced_standbys.push_back(std::move(it->worker));
                            it = agy_slots_.erase(it);
                        } else {
                            ++it;
                        }
                    }
                    if (agy_slots_.size() >= 4U) {
                        auto oldest = agy_slots_.end();
                        for (auto it = agy_slots_.begin(); it != agy_slots_.end(); ++it) {
                            if (!it->busy && (oldest == agy_slots_.end() ||
                                              it->worker->last_used() < oldest->worker->last_used())) {
                                oldest = it;
                            }
                        }
                        if (oldest != agy_slots_.end()) {
                            replaced_standbys.push_back(std::move(oldest->worker));
                            agy_slots_.erase(oldest);
                        }
                    }
                    if (agy_slots_.size() < 4U) {
                        agy_slots_.push_back(AgySlot{std::move(worker), false});
                    } else {
                        replaced_standbys.push_back(std::move(worker));
                    }
                }
                for (auto& old_w : replaced_standbys) old_w->stop();
            } catch (...) {}
        });
    }

    void shutdown() {
        std::thread prewarm_to_join;
        std::vector<std::shared_ptr<KimiAcpWorker>> kimi_to_stop;
        std::vector<std::shared_ptr<AgyStreamWorker>> agy_to_stop;
        {
            std::lock_guard lk(mu_);
            shutting_down_ = true;
            if (prewarm_thread_.joinable()) {
                prewarm_to_join = std::move(prewarm_thread_);
            }
            for (auto& s : kimi_slots_) {
                if (s.worker) kimi_to_stop.push_back(std::move(s.worker));
            }
            kimi_slots_.clear();
            for (auto& s : agy_slots_) {
                if (s.worker) agy_to_stop.push_back(std::move(s.worker));
            }
            agy_slots_.clear();
            runtime_cache_.clear();
        }
        for (auto& w : kimi_to_stop) w->stop();
        for (auto& w : agy_to_stop) w->stop();
        if (prewarm_to_join.joinable()) prewarm_to_join.join();
        // Reset shutting_down_ only after everything is drained so subsequent unit tests in same process still work.
        std::lock_guard lk(mu_);
        shutting_down_ = false;
    }

    PoolCallOutcome try_call(const ModelConfig& config,
                             const std::vector<ModelMessage>& messages,
                             const std::vector<ModelTool>& tools,
                             const fs::path& data_root,
                             const fs::path& app_root,
                             ModelChunk chunk,
                             std::stop_token stop_tok,
                             const fs::path& wsl_executable,
                             const std::string& sandbox_distribution,
                             const std::string& execution_policy,
                             int timeout_seconds) {
        PoolCallOutcome out;
        if (config.cli_engine_id != "kimi-code" && config.cli_engine_id != "antigravity") {
            return out;
        }
        auto rt = resolve_runtime(config.cli_engine_id, data_root, app_root, wsl_executable,
                                  sandbox_distribution, execution_policy);
        if (!rt) return out;

        const std::string fingerprint = compute_cli_reception_system_fingerprint(config, messages, tools);
        const ReceptionTurnInputs inputs = extract_reception_turn_inputs(messages);

        if (config.cli_engine_id == "kimi-code") {
            return call_kimi_acp(*rt, config, messages, tools, fingerprint, inputs,
                                 std::move(chunk), stop_tok, timeout_seconds);
        }
        return call_agy_stream(*rt, config, messages, tools, fingerprint, inputs,
                               std::move(chunk), stop_tok, timeout_seconds);
    }

private:
    struct KimiSlot {
        std::shared_ptr<KimiAcpWorker> worker;
        bool busy = false;
    };
    struct AgySlot {
        std::shared_ptr<AgyStreamWorker> worker;
        bool busy = false;
    };
    struct RuntimeCacheEntry {
        ResolvedReceptionRuntime rt;
        std::chrono::steady_clock::time_point cached_at;
    };

    void evict_idle_locked(std::vector<std::shared_ptr<KimiAcpWorker>>& dead_kimi,
                           std::vector<std::shared_ptr<AgyStreamWorker>>& dead_agy) {
        const auto now = std::chrono::steady_clock::now();
        constexpr auto kIdleTtl = std::chrono::minutes(10);
        for (auto it = kimi_slots_.begin(); it != kimi_slots_.end();) {
            if (!it->busy && (!it->worker || !it->worker->is_alive() || (now - it->worker->last_used() > kIdleTtl))) {
                if (it->worker) dead_kimi.push_back(std::move(it->worker));
                it = kimi_slots_.erase(it);
            } else {
                ++it;
            }
        }
        for (auto it = agy_slots_.begin(); it != agy_slots_.end();) {
            if (!it->busy && (!it->worker || !it->worker->is_alive() || (now - it->worker->last_used() > kIdleTtl))) {
                if (it->worker) dead_agy.push_back(std::move(it->worker));
                it = agy_slots_.erase(it);
            } else {
                ++it;
            }
        }
    }

    std::optional<ResolvedReceptionRuntime> resolve_runtime(const std::string& engine_id,
                                                            const fs::path& data_root,
                                                            const fs::path& app_root,
                                                            const fs::path& wsl_executable,
                                                            const std::string& sandbox_distribution,
                                                            const std::string& execution_policy) {
        const std::string policy = execution_policy.empty() ? std::string("sandbox_first") : execution_policy;
        const std::string cache_key = engine_id + "|" + policy + "|" + path_to_utf8(data_root) + "|" +
                                      path_to_utf8(app_root) + "|" + sandbox_distribution;
        const auto now = std::chrono::steady_clock::now();
        {
            std::lock_guard lk(mu_);
            if (shutting_down_) return std::nullopt;
            if (auto it = runtime_cache_.find(cache_key); it != runtime_cache_.end()) {
                if (now - it->second.cached_at < std::chrono::seconds(60)) {
                    return it->second.rt;
                }
            }
        }

        const auto discovered = discover_cli_harnesses(app_root, wsl_executable, sandbox_distribution, policy);
        for (const auto& h : discovered) {
            if (h.id == engine_id && h.installed && !h.binary_path.empty()) {
                std::error_code ec;
                const fs::path sandbox_ws = fs::absolute(data_root / L"cli-reception-sandbox", ec);
                fs::create_directories(sandbox_ws, ec);
                ResolvedReceptionRuntime rt;
                rt.engine_id = h.id;
                rt.engine_name = h.name;
                rt.platform = h.platform;
                rt.binary_path = h.binary_path;
                rt.wsl_exe = wsl_executable;
                rt.sandbox_distribution = sandbox_distribution;
                rt.sandbox_ws = sandbox_ws;
                rt.runtime_key = h.id + "|" + h.platform + "|" + h.binary_path + "|" +
                                 sandbox_distribution + "|" + path_to_utf8(sandbox_ws);
                std::lock_guard lk(mu_);
                runtime_cache_[cache_key] = RuntimeCacheEntry{rt, now};
                return rt;
            }
        }
        return std::nullopt;
    }

    PoolCallOutcome call_kimi_acp(const ResolvedReceptionRuntime& rt,
                                  const ModelConfig& config,
                                  const std::vector<ModelMessage>& messages,
                                  const std::vector<ModelTool>& tools,
                                  const std::string& fingerprint,
                                  const ReceptionTurnInputs& inputs,
                                  ModelChunk chunk,
                                  std::stop_token stop_tok,
                                  int timeout_seconds) {
        std::shared_ptr<KimiAcpWorker> worker;
        bool spawned_fresh = false;
        {
            std::vector<std::shared_ptr<KimiAcpWorker>> dead_kimi;
            std::vector<std::shared_ptr<AgyStreamWorker>> dead_agy;
            {
                std::lock_guard lk(mu_);
                if (shutting_down_) return {};
                evict_idle_locked(dead_kimi, dead_agy);

                // Prefer an idle warm worker that already holds this exact conversation session.
                for (auto& s : kimi_slots_) {
                    if (!s.busy && s.worker && s.worker->runtime_key() == rt.runtime_key &&
                        s.worker->is_alive() && s.worker->has_matching_session(fingerprint, inputs)) {
                        s.busy = true;
                        worker = s.worker;
                        break;
                    }
                }
                if (!worker) {
                    for (auto& s : kimi_slots_) {
                        if (!s.busy && s.worker && s.worker->runtime_key() == rt.runtime_key && s.worker->is_alive()) {
                            s.busy = true;
                            worker = s.worker;
                            break;
                        }
                    }
                }
            }
            for (auto& w : dead_kimi) w->stop();
            for (auto& w : dead_agy) w->stop();
        }

        if (!worker) {
            auto created = std::make_shared<KimiAcpWorker>(rt);
            if (!created->start()) {
                return {};
            }
            std::lock_guard lk(mu_);
            if (shutting_down_) {
                created->stop();
                return {};
            }
            if (kimi_slots_.size() < 2U) {
                kimi_slots_.push_back(KimiSlot{created, true});
                worker = std::move(created);
                spawned_fresh = true;
            } else {
                // Both pool slots are concurrently busy; still run this request on the temporary worker and stop after.
                worker = std::move(created);
                spawned_fresh = true;
            }
        }

        struct ReleaseGuard {
            CliReceptionPool* self;
            std::shared_ptr<KimiAcpWorker> w;
            bool pooled = false;
            ~ReleaseGuard() {
                bool should_stop = false;
                {
                    std::lock_guard lk(self->mu_);
                    for (auto it = self->kimi_slots_.begin(); it != self->kimi_slots_.end(); ++it) {
                        if (it->worker == w) {
                            pooled = true;
                            if (!w->is_alive() || self->shutting_down_) {
                                should_stop = true;
                                self->kimi_slots_.erase(it);
                            } else {
                                it->busy = false;
                            }
                            break;
                        }
                    }
                }
                if (!pooled || should_stop) {
                    w->stop();
                }
            }
        } guard{this, worker};
        (void)spawned_fresh;

        return worker->run_turn(config, messages, tools, fingerprint, inputs,
                                std::move(chunk), stop_tok, timeout_seconds);
    }

    PoolCallOutcome call_agy_stream(const ResolvedReceptionRuntime& rt,
                                    const ModelConfig& config,
                                    const std::vector<ModelMessage>& messages,
                                    const std::vector<ModelTool>& tools,
                                    const std::string& fingerprint,
                                    const ReceptionTurnInputs& inputs,
                                    ModelChunk chunk,
                                    std::stop_token stop_tok,
                                    int timeout_seconds) {
        std::shared_ptr<AgyStreamWorker> worker;
        {
            std::vector<std::shared_ptr<KimiAcpWorker>> dead_kimi;
            std::vector<std::shared_ptr<AgyStreamWorker>> dead_agy;
            {
                std::lock_guard lk(mu_);
                if (shutting_down_) return {};
                evict_idle_locked(dead_kimi, dead_agy);

                // Priority 1: reuse warm session worker with matching fingerprint + incremental history
                for (auto& s : agy_slots_) {
                    if (!s.busy && s.worker && s.worker->runtime_key() == rt.runtime_key &&
                        s.worker->can_reuse_for(fingerprint, inputs)) {
                        s.busy = true;
                        worker = s.worker;
                        break;
                    }
                }
                // Priority 2: claim a prewarmed blank standby worker matching model & effort (saves 5-14s cold auth!)
                if (!worker) {
                    for (auto& s : agy_slots_) {
                        if (!s.busy && s.worker && s.worker->runtime_key() == rt.runtime_key &&
                            s.worker->is_blank_standby() &&
                            s.worker->matches_model_and_effort(config.cli_native_model, config.reasoning_effort)) {
                            s.busy = true;
                            s.worker->claim_for_session(fingerprint);
                            worker = s.worker;
                            break;
                        }
                    }
                }
            }
            for (auto& w : dead_kimi) w->stop();
            for (auto& w : dead_agy) w->stop();
        }

        if (!worker) {
            auto created = std::make_shared<AgyStreamWorker>(rt, fingerprint, config.cli_native_model, config.reasoning_effort);
            if (!created->start()) {
                return {};
            }
            std::shared_ptr<AgyStreamWorker> evicted;
            {
                std::lock_guard lk(mu_);
                if (shutting_down_) {
                    created->stop();
                    return {};
                }
                if (agy_slots_.size() >= 4U) {
                    // Evict oldest idle LRU slot.
                    auto oldest = agy_slots_.end();
                    for (auto it = agy_slots_.begin(); it != agy_slots_.end(); ++it) {
                        if (!it->busy && (oldest == agy_slots_.end() ||
                                          it->worker->last_used() < oldest->worker->last_used())) {
                            oldest = it;
                        }
                    }
                    if (oldest != agy_slots_.end()) {
                        evicted = std::move(oldest->worker);
                        agy_slots_.erase(oldest);
                    }
                }
                if (agy_slots_.size() < 4U) {
                    agy_slots_.push_back(AgySlot{created, true});
                }
                worker = std::move(created);
            }
            if (evicted) evicted->stop();
        }

        struct ReleaseGuard {
            CliReceptionPool* self;
            std::shared_ptr<AgyStreamWorker> w;
            bool pooled = false;
            ~ReleaseGuard() {
                bool should_stop = false;
                {
                    std::lock_guard lk(self->mu_);
                    for (auto it = self->agy_slots_.begin(); it != self->agy_slots_.end(); ++it) {
                        if (it->worker == w) {
                            pooled = true;
                            if (!w->is_alive() || self->shutting_down_) {
                                should_stop = true;
                                self->agy_slots_.erase(it);
                            } else {
                                it->busy = false;
                            }
                            break;
                        }
                    }
                }
                if (!pooled || should_stop) {
                    w->stop();
                }
            }
        } guard{this, worker};

        return worker->run_turn(config, messages, tools, inputs,
                                std::move(chunk), stop_tok, timeout_seconds);
    }

    std::mutex mu_;
    bool shutting_down_ = false;
    bool prewarm_running_ = false;
    std::thread prewarm_thread_;
    std::vector<KimiSlot> kimi_slots_;
    std::vector<AgySlot> agy_slots_;
    std::map<std::string, RuntimeCacheEntry> runtime_cache_;
};

} // namespace

void prewarm_cli_reception_engine(const std::string& engine_id,
                                  const std::filesystem::path& data_root,
                                  const std::filesystem::path& app_root,
                                  const std::filesystem::path& wsl_executable,
                                  const std::string& sandbox_distribution,
                                  const std::string& execution_policy,
                                  const std::string& native_model,
                                  const std::string& reasoning_effort) {
    CliReceptionPool::instance().prewarm(engine_id, data_root, app_root, wsl_executable,
                                         sandbox_distribution, execution_policy,
                                         native_model, reasoning_effort);
}

void shutdown_cli_reception_pool() {
    CliReceptionPool::instance().shutdown();
}

ModelReply call_cli_as_work_lead(const ModelConfig& config,
                                 const std::vector<ModelMessage>& messages,
                                 const std::vector<ModelTool>& tools,
                                 const std::filesystem::path& data_root,
                                 const std::filesystem::path& app_root,
                                 ModelChunk chunk,
                                 std::stop_token stop,
                                 const std::filesystem::path& wsl_executable,
                                 const std::string& sandbox_distribution,
                                 const std::string& execution_policy) {
    if (config.protocol != "cli-reception" || config.cli_engine_id.empty()) {
        throw ModelError(ModelFailure::Transport, "无效的 Work 接待 CLI 模型配置");
    }

    const int timeout_sec = std::clamp(config.timeout_ms > 0 ? (config.timeout_ms / 1000) : 300, 30, 600);

    // P2 Fast-Path: persistent warm CLI daemon pool (zero cold-start + KV Prompt Cache + real token streaming).
    if (config.cli_engine_id == "kimi-code" || config.cli_engine_id == "antigravity") {
        auto pool_res = CliReceptionPool::instance().try_call(
            config, messages, tools, data_root, app_root, chunk, stop,
            wsl_executable, sandbox_distribution, execution_policy, timeout_sec);
        if (pool_res.cancelled || stop.stop_requested()) {
            throw ModelError(ModelFailure::Cancelled, "Work 接待 CLI 推理已取消");
        }
        if (pool_res.handled) {
            if (pool_res.timed_out) {
                throw ModelError(ModelFailure::Timeout,
                                 "本机 Code CLI (" + config.cli_engine_id + ") 接待超时：" + pool_res.error_detail);
            }
            if (!pool_res.error_detail.empty()) {
                throw ModelError(ModelFailure::Transport,
                                 "本机 Code CLI (" + config.cli_engine_id + ") 接待失败：" + pool_res.error_detail);
            }
            return std::move(pool_res.reply);
        }
        // If the persistent daemon failed before streaming any text to the user, transparently fall back to oneshot.
    }

    std::error_code ec;
    const fs::path sandbox_ws = data_root / L"cli-reception-sandbox";
    fs::create_directories(sandbox_ws, ec);

    const bool is_chat_mode = (config.context_feature == "chat" || config.context_feature == "group");
    CliHarnessRunRequest req;
    req.engine_id = config.cli_engine_id;
    req.model_source = "native";
    req.bot_id = is_chat_mode ? "chat-reception" : "work-lead";
    req.session_key = std::string(is_chat_mode ? "chat-reception-" : "work-lead-") + config.cli_engine_id + "-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    req.prompt = build_cli_reception_prompt(messages, tools, config.context_feature, config.cli_engine_id);
    req.constraints.forbid_skills = true;
    req.constraints.forbid_tests = true;
    req.work_slot_model.thinking_enabled = config.thinking_enabled;
    req.work_slot_model.reasoning_effort = config.reasoning_effort;
    req.native_provider = config.cli_native_provider;
    req.native_model = config.cli_native_model;
    req.workspace_dir = sandbox_ws;
    req.data_root = data_root;
    req.app_root = app_root;
    req.wsl_executable = wsl_executable;
    req.sandbox_distribution = sandbox_distribution;
    req.execution_policy = execution_policy.empty() ? std::string("sandbox_first") : execution_policy;
    req.require_exact_engine = true;
    req.read_only_reception = true;
    req.timeout_seconds = timeout_sec;

    bool streamed_text = false;
    ReceptionTextStreamFilter stream_filter;
    const bool has_tools = !tools.empty();
    CliHarnessRunResult cli_res;
    try {
        cli_res = run_cli_harness(
            req,
            [&](const NormalizedCliEvent& ev) {
                if (!chunk) return;
                if (ev.kind == "thinking" && !ev.text.empty()) {
                    chunk("thinking", ev.text);
                } else if (ev.kind == "commentary" && !ev.text.empty()) {
                    if (has_tools) {
                        stream_filter.feed(ev.text, [&](std::string_view piece) {
                            if (!piece.empty()) {
                                streamed_text = true;
                                chunk("text", piece);
                            }
                        });
                    } else {
                        streamed_text = true;
                        chunk("text", ev.text);
                    }
                }
            },
            stop);
    } catch (const std::exception& ex) {
        throw ModelError(ModelFailure::Transport,
                         "无法调用本机 Code CLI (" + config.cli_engine_id + ") 执行接待推理：" + ex.what());
    }

    if (has_tools && chunk && !cli_res.cancelled) {
        stream_filter.flush([&](std::string_view piece) {
            if (!piece.empty()) {
                streamed_text = true;
                chunk("text", piece);
            }
        });
    }

    if (cli_res.cancelled || stop.stop_requested()) {
        throw ModelError(ModelFailure::Cancelled, "Work 接待 CLI 推理已取消");
    }
    if (!cli_res.success) {
        const std::string detail = !cli_res.error_detail.empty()
            ? cli_res.error_detail
            : ("退出码 " + std::to_string(cli_res.exit_code));
        if (detail.find("超过单轮时间上限") != std::string::npos) {
            throw ModelError(ModelFailure::Timeout, "本机 Code CLI (" + cli_res.resolved_engine_name + ") 接待超时：" + detail);
        }
        throw ModelError(ModelFailure::Transport, "本机 Code CLI (" + cli_res.resolved_engine_name + ") 接待失败：" + detail);
    }

    ModelReply reply = parse_cli_reception_reply(cli_res.final_response, tools);
    reply.input_tokens = static_cast<int>(std::min<std::int64_t>(cli_res.input_tokens, 2000000000LL));
    reply.output_tokens = static_cast<int>(std::min<std::int64_t>(cli_res.output_tokens, 2000000000LL));
    if (chunk && !streamed_text && !reply.text.empty()) {
        chunk("text", reply.text);
    }
    return reply;
}

} // namespace dimension
