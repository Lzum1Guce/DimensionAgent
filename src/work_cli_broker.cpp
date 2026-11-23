#include "dimension/message_context.hpp"
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/work_cli_broker.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/managed_workspaces.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
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
           low == ".dimension-cli-tmp" || low == "target" || low == ".next" || low == "dist-cache";
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
        if (rel.empty() || rel.starts_with("..") || rel.starts_with(".dimension-cli-tmp/")) continue;
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
        {"nativeModelGroups", std::move(groups)}
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

} // namespace

std::vector<CliHarnessDescriptor> discover_cli_harnesses(const std::filesystem::path& app_root,
                                                         const std::filesystem::path& wsl_executable,
                                                         const std::string& sandbox_distribution) {
    (void)wsl_executable;
    (void)sandbox_distribution;

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
        if (d.installed && d.native_configured && !app_root.empty()) {
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

    // 2. Kimi Code
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

    // 3. Claude Code
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

    // 4. Codex
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

    // 5. OpenCode
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

    // 6. Qwen Code & Gemini CLI
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

    out_event = NormalizedCliEvent{};
    const std::string type = jstr(obj_val, "type");
    out_event.session_id = jstr(obj_val, "session_id", jstr(obj_val, "sessionId", jstr(obj_val, "thread_id")));

    // 1. Init / Thread start (Hermes, DeepSeek Harness, Claude Code, Kimi Code, Codex)
    if ((type == "system" && jstr(obj_val, "subtype") == "init") || type == "thread.started" ||
        type == "init" || type == "session" ||
        (engine_id == "kimi-code" && type == "session.resume_hint" && jstr(obj_val, "role") == "meta")) {
        out_event.kind = "init";
        return true;
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
    const auto discovered = provided_discovered.empty()
        ? discover_cli_harnesses(req.app_root, req.wsl_executable, req.sandbox_distribution)
        : provided_discovered;

    const CliHarnessDescriptor* chosen = nullptr;
    if (!req.engine_id.empty() && req.engine_id != "auto") {
        for (const auto& d : discovered) {
            if (d.id == req.engine_id && d.installed) {
                chosen = &d;
                break;
            }
        }
    }
    if (!chosen && req.require_exact_engine) throw std::runtime_error("选定的 CLI 引擎不可用：" + req.engine_id);
    if (!chosen) {
        // Auto fallback priority: Hermes -> Kimi Code -> Claude Code -> Codex -> OpenCode -> Qwen -> Gemini
        for (const auto& d : discovered) {
            if (d.installed) {
                chosen = &d;
                break;
            }
        }
    }
    if (!chosen) {
        throw std::runtime_error("未检测到可用的满血 CLI 引擎（请确认 Hermes 或 Kimi Code 已就绪）");
    }

    PreparedCliInvocation inv;
    inv.engine_id = chosen->id;
    inv.engine_name = chosen->name;
    inv.platform = chosen->platform;
    inv.binary_path = chosen->binary_path;

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
        effective_prompt += "\n\n【用户粘贴/附带的视觉参考图（请直接读取查看画面构图、文字、报错或设计细节）】";
        for (const auto& img_p : req.image_paths) {
            effective_prompt += "\n- " + path_to_utf8(fs::absolute(img_p, ec));
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

    // Build bundled lightweight CLI toolkit PATH prepend
    std::vector<std::string> extra_paths;
    auto push_dir_if_exists = [&](const fs::path& dir) {
        if (!dir.empty() && fs::is_directory(dir, ec)) extra_paths.push_back(path_to_utf8(fs::absolute(dir, ec)));
    };
    push_dir_if_exists(runtime_directory(req.app_root) / L"cli-kit" / L"bin");
    push_dir_if_exists(req.app_root / L"runtime" / L"node");
    const fs::path user_prof = utf8_to_path(env_var_utf8(L"USERPROFILE"));
    const fs::path local_app = utf8_to_path(env_var_utf8(L"LOCALAPPDATA"));
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
    inv.env_overrides.emplace_back("PYTHONIOENCODING", "utf-8");
    inv.env_overrides.emplace_back("PYTHONUTF8", "1");
    inv.env_overrides.emplace_back("PYTHONUNBUFFERED", "1");
    inv.env_overrides.emplace_back("NO_COLOR", "1");

    // Shared helpers: discover cross-harness skill directories and zero-latency MCP bridge across ALL CLIs
    auto collect_cross_harness_skill_roots = [&]() {
        std::vector<std::string> roots;
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
    if (!req.app_root.empty()) {
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
    const bool has_cross_mcp_bridge = !req.constraints.forbid_skills &&
                                      fs::is_regular_file(mcp_node_exe, ec) &&
                                      fs::is_regular_file(mcp_bridge_mjs, ec);
    const std::string mcp_node_u8 = has_cross_mcp_bridge ? path_to_utf8(fs::absolute(mcp_node_exe, ec)) : std::string{};
    const std::string mcp_bridge_u8 = has_cross_mcp_bridge ? path_to_utf8(fs::absolute(mcp_bridge_mjs, ec)) : std::string{};

    if (inv.engine_id == "hermes") {
        // Use global native HERMES_HOME directly (do NOT set an external HERMES_HOME):
        // External HERMES_HOME triggers Hermes's _prepare_borrowed_launch -> 160s+ full uv venv rebuild
        // and spawns an isolated cold Gateway per Bot. Using the native home shares the single installed
        // Python environment (0s sync) and the warm Multiplex Gateway (0s cold start), while `-c <title>`
        // keeps every Bot & thread session strictly isolated.
        const fs::path global_hermes = fs::is_directory(local_app / L"hermes", ec) ? (local_app / L"hermes") : (user_prof / L".hermes");
        maybe_prewarm_hermes_gateway(inv.binary_path, global_hermes);

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

        inv.args = {
            "chat",
            "--query-file", path_to_utf8(inv.temp_query_file),
            "--format", "stream-json",
            "--in", path_to_utf8(ws_abs),
            "-c", hermes_sess_title,
            "--create-if-missing",
            "--accept-hooks",
            "--yolo",
            "--checkpoints",
            "--source", "tool"
        };
        if (req.constraints.forbid_skills) inv.args.push_back("--ignore-rules");
        if (req.constraints.forbid_tests && req.constraints.forbid_network) {
            inv.args.push_back("-t");
            inv.args.push_back("file");
        }
        if (!req.work_slot_model.reasoning_effort.empty()) {
            inv.args.push_back("--reasoning");
            inv.args.push_back(req.work_slot_model.reasoning_effort);
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
        inv.env_overrides.emplace_back("DSH_PERMISSION_MODE", "danger-full-access");

        std::ostringstream patch;
        patch << "- id: permission\n"
              << "  name: \"@deepseek-ai/dsh-permission-presets\"\n"
              << "  config:\n"
              << "    defaultPreset: danger-full-access\n";
        if (req.constraints.forbid_skills) {
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

        const std::string effort = req.work_slot_model.reasoning_effort;
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
                  << "    desktopPlatform: win32\n"
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

        // Multi-turn session adoption: verify persisted session inside ~/.dsh/sessions/--<cwd>--/<session-id>
        const std::string cwd_sig = deterministic_uuid_from_key(path_to_utf8(ws_abs)).substr(0, 6);
        const fs::path map_dir = inv.isolated_home_dir / L"session-map";
        fs::create_directories(map_dir, ec);
        inv.session_id_map_file = map_dir / utf8_to_path(sess_slug + "-" + cwd_sig + ".id");
        std::string existing_sess_id;
        if (fs::is_regular_file(inv.session_id_map_file, ec)) {
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
            "--patch", path_to_utf8(patch_file),
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
            copy_file_sync(global_kimi / L"credentials.json", inv.isolated_home_dir / L"credentials.json");
            copy_file_sync(global_kimi / L"device_id", inv.isolated_home_dir / L"device_id");
            copy_file_sync(global_kimi / L"region", inv.isolated_home_dir / L"region");
            inv.env_overrides.emplace_back("KIMI_CODE_HOME", path_to_utf8(inv.isolated_home_dir));

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

            // Preserve user's mcp.json and merge cross_harness MCP server inside isolated home
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
        const auto home = inject_work_model ? inv.isolated_home_dir : global_kimi;
        const auto map_dir = inv.isolated_home_dir / "session-map";
        fs::create_directories(map_dir, ec);
        inv.session_id_map_file = map_dir / (deterministic_uuid_from_key(req.session_key + "|" +
            path_to_utf8(ws_abs) + "|" + req.model_source + "|" + inv.model_label) + ".id");
        const auto bucket = kimi_session_bucket(home, ws_abs);
        auto id = trim_copy(read_small_file(inv.session_id_map_file));
        if (id.size() == 36) id = "session_" + id;
        if (!bucket.empty() && id.starts_with("session_") && id.size() == 44 &&
            id.find_first_not_of("abcdefABCDEF0123456789-", 8) == std::string::npos &&
            fs::is_regular_file(bucket / id / "state.json", ec)) inv.args = {"-S", id};
        const auto model = inject_work_model ? "dimension_work/" + req.work_slot_model.model : req.native_model;
        if (!model.empty()) { inv.args.push_back("-m"); inv.args.push_back(model); }
        if (req.constraints.forbid_skills) {
            const fs::path empty_skills = inv.isolated_home_dir / L"empty-skills";
            fs::create_directories(empty_skills, ec);
            inv.args.push_back("--skills-dir");
            inv.args.push_back(path_to_utf8(empty_skills));
        } else {
            if (fs::is_directory(ws_abs / L".kimi" / L"skills", ec)) {
                inv.args.push_back("--skills-dir");
                inv.args.push_back(path_to_utf8(ws_abs / L".kimi" / L"skills"));
            }
            for (const auto& sr : collect_cross_harness_skill_roots()) {
                inv.args.push_back("--skills-dir");
                inv.args.push_back(sr);
            }
        }
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
        inv.args = {
            "-p", effective_prompt,
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
            "--session-id", sess_uuid
        };
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
        inv.args = {"exec", "--json", "--full-auto", "--skip-git-repo-check"};
        if (req.constraints.forbid_skills) {
            inv.args.push_back("--ignore-rules");
        } else if (has_cross_mcp_bridge) {
            inv.args.push_back("--trust");
            inv.args.push_back("-c");
            inv.args.push_back("mcp_servers.cross_harness.command=\"" + toml_escape_basic(mcp_node_u8) + "\"");
            inv.args.push_back("-c");
            inv.args.push_back("mcp_servers.cross_harness.args=[\"" + toml_escape_basic(mcp_bridge_u8) + "\"]");
        }
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("-m");
            inv.args.push_back(chosen_m);
        }
        for (const auto& img_p : req.image_paths) {
            inv.args.push_back("-i");
            inv.args.push_back(path_to_utf8(fs::absolute(img_p, ec)));
        }
        inv.args.push_back(effective_prompt);
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
    } else {
        // qwen-code / gemini-cli
        if (inject_work_model) {
            inv.env_overrides.emplace_back("OPENAI_BASE_URL", host_openai_url);
            if (!req.work_slot_model.api_key.empty()) {
                inv.env_overrides.emplace_back("OPENAI_API_KEY", req.work_slot_model.api_key);
                inv.env_overrides.emplace_back("GEMINI_API_KEY", req.work_slot_model.api_key);
            }
        }
        inv.args = {"-p", effective_prompt, "--output-format", "stream-json", "--yolo"};
        const std::string chosen_m = inject_work_model ? req.work_slot_model.model : req.native_model;
        if (!chosen_m.empty()) {
            inv.args.push_back("-m");
            inv.args.push_back(chosen_m);
        }
    }

    // Avoid the Windows argument limit. stdin and query-file engines already
    // receive the full text without putting it on their command line.
    const auto extension = ascii_lower(path_to_utf8(utf8_to_path(inv.binary_path).extension()));
    const bool file_prompt = req.file_prompt_for_batch && (extension == ".cmd" || extension == ".bat");
    if ((file_prompt || effective_prompt.size() > 6000) && inv.stdin_payload.empty()) {
        for (auto& argument : inv.args) {
            if (argument == effective_prompt) {
                argument = "请先完整读取本次任务说明文件（UTF-8），按其中的职责、用户原文和后续纠正执行："
                    + path_to_utf8(fs::absolute(inv.temp_query_file));
                break;
            }
        }
    }
    return inv;
}

CliHarnessRunResult run_cli_harness(const CliHarnessRunRequest& req,
                                    const CliEventCallback& on_event,
                                    std::stop_token stop) {
    const auto started_at = std::chrono::steady_clock::now();
    PreparedCliInvocation inv = prepare_cli_invocation(req);
    std::string kimi_marker;
    if (inv.engine_id == "kimi-code" && std::find(inv.args.begin(), inv.args.end(), "-S") == inv.args.end()) {
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

    // Take pre-execution snapshot to detect created/updated files and build Red/Green Diffs
    const auto before_snap = snapshot_workspace(ws_abs);

    // Construct full Windows command line (.cmd wrappers run via cmd.exe /d /s /c "\"...\"")
    const bool is_cmd_script = ascii_lower(inv.binary_path).ends_with(".cmd") ||
                               ascii_lower(inv.binary_path).ends_with(".bat");
    std::wstring inner_cmd = quote_win_arg(utf8_to_wide(inv.binary_path));
    for (const auto& a : inv.args) {
        inner_cmd.push_back(L' ');
        inner_cmd += quote_win_arg(utf8_to_wide(a));
    }
    const bool unc_batch = is_cmd_script && ws_abs.root_name().wstring().starts_with(L"\\\\");
    std::wstring cmd_line = unc_batch
        ? L"cmd.exe /d /e:on /v:off /s /c \"pushd \"%DIMENSION_CLI_WORKDIR%\" && " + inner_cmd + L"\""
        : is_cmd_script
        ? (L"cmd.exe /d /s /c \"" + inner_cmd + L"\"")
        : inner_cmd;

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
    std::vector<std::pair<std::string, std::string>> merged_env = inv.env_overrides;
    merged_env.emplace_back("PYTHONUTF8", "1");
    merged_env.emplace_back("PYTHONIOENCODING", "utf-8");
    if (unc_batch) merged_env.emplace_back("DIMENSION_CLI_WORKDIR", path_to_utf8(ws_abs));
    std::wstring env_block = build_environment_block(merged_env);
    const std::wstring cwd_w = unc_batch ? inv.isolated_home_dir.wstring() : ws_abs.wstring();

    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
                        env_block.data(), cwd_w.c_str(), &si, &pi)) {
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

    std::jthread stdout_reader([&]() {
        std::string pending;
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(out_read.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
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
    });

    std::jthread stderr_reader([&]() {
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(err_read.h, buf, sizeof(buf), &n, nullptr) && n > 0) {
            std::lock_guard lk(state_mu);
            if (stderr_capture.size() < 64U * 1024U) {
                stderr_capture.append(buf, std::min<std::size_t>(n, 64U * 1024U - stderr_capture.size()));
            }
        }
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
    out.file_deltas = diff_workspace_snapshots(ws_abs, before_snap);

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

} // namespace dimension
