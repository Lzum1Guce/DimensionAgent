#include "dimension/task_handoff.hpp"
#include "dimension/message_context.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <limits>
#include <set>
#include <utility>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
constexpr std::size_t hard_file = 8U * 1024U * 1024U;
[[noreturn]] void fail(int status, const char* code) { throw TaskHandoffError(status, code); }
std::string utf8(const fs::path& p) { const auto v = p.u8string(); return {v.begin(), v.end()}; }
fs::path path8(const std::string& v) { return fs::path(std::u8string(v.begin(), v.end())); }
std::wstring native(const fs::path& p) { auto v = p.wstring(); std::replace(v.begin(), v.end(), L'/', L'\\'); if(v.starts_with(L"\\\\?\\"))return v;if(v.starts_with(L"\\\\"))return L"\\\\?\\UNC\\"+v.substr(2);return L"\\\\?\\" + v; }
std::string lower(std::string v) { for (auto& c : v) if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; return v; }
bool ascii_letter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
bool word(char c) { return ascii_letter(c) || (c >= '0' && c <= '9') || c == '_'; }
bool valid_utf8(std::string_view value) {
    for (std::size_t i = 0; i < value.size();) {
        const auto c = static_cast<unsigned char>(value[i++]);
        if (c < 0x80) continue;
        unsigned count = 0, scalar = 0, minimum = 0;
        if (c >= 0xc2 && c <= 0xdf) { count = 1; scalar = c & 31; minimum = 0x80; }
        else if (c >= 0xe0 && c <= 0xef) { count = 2; scalar = c & 15; minimum = 0x800; }
        else if (c >= 0xf0 && c <= 0xf4) { count = 3; scalar = c & 7; minimum = 0x10000; }
        else return false;
        if (i + count > value.size()) return false;
        while (count--) { const auto next = static_cast<unsigned char>(value[i++]); if ((next & 0xc0) != 0x80) return false; scalar = (scalar << 6) | (next & 63); }
        if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) return false;
    }
    return true;
}
std::string str(const Json& v, const char* key, bool required = false) {
    const auto* p = v.find(key); if (!p) { if (required) fail(409, "handoff_incomplete_source"); return {}; }
    if (!p->is_string()) fail(409, "handoff_invalid_source_field"); return p->as_string();
}
bool flag(const Json& v, const char* key) { const auto* p = v.find(key); return p && p->is_bool() && p->as_bool(); }
std::string decimal(const Json& v, const char* key) {
    const auto* p = v.find(key); if (!p) return "0";
    if (!p->is_number() || !std::isfinite(p->as_number()) || p->as_number() < 0 || p->as_number() > 9007199254740991.0 || std::floor(p->as_number()) != p->as_number()) fail(409, "handoff_invalid_source_number");
    return std::to_string(static_cast<std::uint64_t>(p->as_number()));
}
bool protected_relative(const fs::path& p) {
    static const std::set<std::string> forbidden{"accounts", "account", "browser", "profile", "profiles", "webview-profile", "chrome", "cookies", "credentials", "secrets", "work-runs", "chat-runs", "tool-receipts", "receipts", "events", "conversation-services"};
    static const std::set<std::string> filenames{"settings.json", "native-client.json", "snapshot.json", "credentials.json", "secrets.json", "login data", "local state", "cookies.sqlite"};
    for (const auto& part : p) {
        const auto name = lower(utf8(part));
        if (name.empty() || name.front() == '.' || forbidden.contains(name) || filenames.contains(name)) return true;
        for (const auto* extension : {".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".log", ".jsonl"}) if (name.ends_with(extension)) return true;
    }
    const auto file = lower(utf8(p.filename()));
    if (file.size() == 69 && file.ends_with(".json") && std::all_of(file.begin(), file.begin() + 64, [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) return true;
    return false;
}
fs::path relative_path(const std::string& value) {
    if (value.empty() || value.size() > 4096 || !valid_utf8(value)) fail(400, "handoff_invalid_relative_path");
    auto portable = value; std::replace(portable.begin(), portable.end(), '\\', '/');
    for (unsigned char c : portable) if (c < 32 || c == 127 || c == ':' || c == '?' || c == '*' || c == '"' || c == '<' || c == '>' || c == '|') fail(400, "handoff_invalid_relative_path");
    const auto p = path8(portable);
    if (p.is_absolute() || p.has_root_name() || p.has_root_directory() || portable.front() == '/' || portable.back() == '/') fail(400, "handoff_invalid_relative_path");
    for (const auto& part : p) { const auto item = utf8(part); if (item.empty() || item == "." || item == ".." || item.ends_with('.') || item.ends_with(' ')) fail(400, "handoff_invalid_relative_path"); }
    if (portable.find("//") != std::string::npos) fail(400, "handoff_invalid_relative_path");
    return p;
}
struct Span { std::size_t first, last; bool credential; };
class Redactor {
public:
    explicit Redactor(const std::vector<std::string>& values, std::size_t maximum) : secrets(values), budget(maximum) {
        if (secrets.size() > 256) fail(413, "handoff_redaction_limit");
        for (const auto& value : secrets) if (value.size() < 4 || value.size() > 16384) fail(400, "handoff_invalid_redaction_literal");
    }
    std::vector<Span> scan(const std::string& text) const {
        std::vector<Span> result;
        auto add = [&](std::size_t first, std::size_t last, bool secret) { if (last > first) { if (result.size() >= 16384) fail(413, "handoff_redaction_limit"); result.push_back({first, last, secret}); } };
        for (const auto& value : secrets) {
            const bool local_path = (value.size() > 2 && ascii_letter(value[0]) && value[1] == ':' && (value[2] == '/' || value[2] == '\\')) || value.starts_with("/") || value.starts_with("\\\\");
            for (std::size_t pos = 0; (pos = text.find(value, pos)) != text.npos; pos += value.size()) add(pos, pos + value.size(), !local_path);
        }
        const auto small = lower(text);
        const auto end_token = [&](std::size_t pos) { while (pos < text.size()) { const auto c = static_cast<unsigned char>(text[pos]); if (c <= 32 || c == 127 || c == '"' || c == '\'' || c == '<' || c == '>' || c == '(' || c == ')' || c == '{' || c == '}' || c == '[' || c == ']' || c == ',' || c == ';') break; ++pos; } return pos; };
        static const std::array<std::string_view, 12> prefixes{"file://", "http://127.0.0.1", "https://127.0.0.1", "http://localhost", "https://localhost", "/home/", "/users/", "/mnt/", "/private/", "/root/", "/tmp/", "/var/"};
        static const std::array<std::string_view, 15> keys{"api_key", "api-key", "apikey", "authorization", "access_token", "accesstoken", "refresh_token", "refreshtoken", "client_secret", "clientsecret", "password", "secretvalue", "protectedkey", "secret", "token"};
        for (std::size_t i = 0; i < text.size(); ++i) {
            const auto remaining = std::string_view(small).substr(i);
            bool absolute = i + 2 < text.size() && ascii_letter(text[i]) && text[i + 1] == ':' && (text[i + 2] == '/' || text[i + 2] == '\\');
            absolute = absolute || (i + 2 < text.size() && text[i] == '\\' && text[i + 1] == '\\' && text[i + 2] != '\\');
            absolute = absolute || std::any_of(prefixes.begin(), prefixes.end(), [&](auto prefix) { return remaining.starts_with(prefix); });
            if (absolute) { const auto end = end_token(i); add(i, end, false); if (end > i) i = end - 1; continue; }
            if (remaining.starts_with("bearer ") || remaining.starts_with("bearer\t") || remaining.starts_with("basic ") || remaining.starts_with("basic\t")) { auto start = i + (remaining.starts_with("basic") ? 6 : 7); while (start < text.size() && (text[start] == ' ' || text[start] == '\t')) ++start; add(start, end_token(start), true); }
            if (remaining.starts_with("http://") || remaining.starts_with("https://")) {
                const auto begin = i + (remaining.starts_with("https") ? 8 : 7), end = end_token(begin);
                const auto slash = text.find_first_of("/?#", begin), at = text.find('@', begin);
                if (at != text.npos && at < end && (slash == text.npos || at < slash)) add(i, end_token(i), true);
            }
            if (remaining.starts_with("sk-")) { const auto end = end_token(i); if (end - i >= 12) add(i, end, true); }
            if (i && word(text[i - 1])) continue;
            for (const auto key : keys) {
                if (!remaining.starts_with(key)) continue;
                auto pos = i + key.size(); if (pos < text.size() && word(text[pos])) continue;
                while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '"' || text[pos] == '\'')) ++pos;
                if (pos >= text.size() || (text[pos] != ':' && text[pos] != '=')) continue;
                const char sep = text[pos];
                ++pos; while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\t')) ++pos;
                if (pos < text.size() && (text[pos] == '"' || text[pos] == '\'')) { const char quote = text[pos++]; auto end = pos; while (end < text.size() && text[end] != quote && text[end] != '\n' && text[end] != '\r') ++end; add(pos, end, true); }
                else {
                    const auto end = end_token(pos);
                    if (sep == ':' && end > pos) {
                        std::string_view tok = std::string_view(small).substr(pos, end - pos);
                        if (!tok.empty() && tok.back() == ':') tok.remove_suffix(1);
                        static const std::array<std::string_view, 12> kTypeNames{
                            "str", "string", "int", "integer", "float", "double",
                            "bool", "boolean", "bytes", "none", "any", "optional"};
                        if (std::find(kTypeNames.begin(), kTypeNames.end(), tok) != kTypeNames.end()) continue;
                    }
                    add(pos, end, true);
                }
            }
        }
        std::sort(result.begin(), result.end(), [](const Span& a, const Span& b) { return a.first < b.first || (a.first == b.first && a.last > b.last); });
        std::vector<Span> merged;
        for (const auto& span : result) { if (!merged.empty() && span.first < merged.back().last) { merged.back().last = std::max(merged.back().last, span.last); merged.back().credential = merged.back().credential || span.credential; } else merged.push_back(span); }
        return merged;
    }
    std::string clean(const std::string& value) {
        if (value.size() > budget || used > budget - value.size()) fail(413, "handoff_text_limit");
        used += value.size(); if (!valid_utf8(value) || value.find('\0') != value.npos) fail(409, "handoff_invalid_source_text");
        std::string result; std::size_t pos = 0;
        for (const auto& span : scan(value)) { result.append(value, pos, span.first - pos); result += span.credential ? "[redacted credential]" : "[redacted local path]"; pos = span.last; if (span.credential) ++credentials; else ++paths; }
        result.append(value, pos, value.size() - pos); return result;
    }
    std::size_t credentials{}, paths{};
private:
    const std::vector<std::string>& secrets;
    std::size_t budget, used{};
};
std::string base64(const std::string& value) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; out.reserve(((value.size() + 2) / 3) * 4);
    for (std::size_t i = 0; i < value.size(); i += 3) {
        const auto a = static_cast<unsigned char>(value[i]); const auto b = i + 1 < value.size() ? static_cast<unsigned char>(value[i + 1]) : 0; const auto c = i + 2 < value.size() ? static_cast<unsigned char>(value[i + 2]) : 0;
        out += alphabet[a >> 2]; out += alphabet[((a & 3) << 4) | (b >> 4)]; out += i + 1 < value.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '='; out += i + 2 < value.size() ? alphabet[c & 63] : '=';
    }
    return out;
}
std::string now() { SYSTEMTIME time{}; GetSystemTime(&time); char buffer[40]{}; sprintf_s(buffer, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds); return buffer; }
std::string safe_name(const TaskHandoffArtifact& file, std::size_t index) {
    auto name = file.name.empty() ? utf8(path8(file.relative).filename()) : file.name;
    const auto small = lower(name);
    const auto stem = small.substr(0, small.find('.'));
    const bool reserved = stem == "con" || stem == "nul" || stem == "aux" || stem == "prn" ||
        (stem.size() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem[3] >= '1' && stem[3] <= '9');
    if (name.empty() || name.size() > 240 || !valid_utf8(name) || name.front() == '.' || name.back() == '.' || name.back() == ' ' ||
        name.find_first_of("/\\:*?\"<>|\r\n\t") != name.npos || std::any_of(name.begin(), name.end(), [](unsigned char c) { return c < 32 || c == 127; }) ||
        reserved) name = "artifact-" + std::to_string(index) + ".bin";
    return name;
}
}

TaskHandoffError::TaskHandoffError(int value, std::string code) : std::runtime_error(std::move(code)), status(value) {}
struct HandoffFileReader::Impl {
    std::vector<HANDLE> handles;
    HANDLE file = INVALID_HANDLE_VALUE;
    std::size_t bytes{};
    ~Impl() { for (auto handle : handles) CloseHandle(handle); }
    HANDLE pin(const fs::path& path, bool directory) {
        auto handle = CreateFileW(native(path).c_str(), directory ? (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES) : GENERIC_READ,
            directory ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr);
        if (handle == INVALID_HANDLE_VALUE) fail(409, "handoff_file_unavailable");
        handles.push_back(handle); BY_HANDLE_FILE_INFORMATION info{};
        if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory || (!directory && info.nNumberOfLinks != 1)) fail(409, "handoff_unsafe_file");
        return handle;
    }
};
HandoffFileReader::HandoffFileReader(const fs::path& supplied, const std::string& relative, std::size_t maximum) : impl_(std::make_unique<Impl>()) {
    if (!maximum || maximum > hard_file) fail(400, "handoff_invalid_file_limit");
    const auto root = supplied.lexically_normal();
    if (!supplied.is_absolute() || supplied != root || root.root_name().wstring().size() != 2 || root.root_name().wstring()[1] != L':' || !ascii_letter(static_cast<char>(root.root_name().wstring()[0]))) fail(400, "handoff_invalid_root");
    for (const auto& part : root.relative_path()) if (part == L"." || part == L".." || part.wstring().find(L':') != std::wstring::npos) fail(400, "handoff_invalid_root");
    const auto rel = relative_path(relative); if (protected_relative(rel)) fail(403, "handoff_protected_artifact");
    auto current = root.root_path(); impl_->pin(current, true);
    for (const auto& part : root.relative_path()) { current /= part; impl_->pin(current, true); }
    for (const auto& part : rel.parent_path()) { current /= part; impl_->pin(current, true); }
    impl_->file = impl_->pin(current / rel.filename(), false); LARGE_INTEGER size{};
    if (!GetFileSizeEx(impl_->file, &size) || size.QuadPart < 0) fail(409, "handoff_file_size_unavailable");
    if (static_cast<unsigned long long>(size.QuadPart) > maximum) fail(413, "handoff_file_too_large");
    impl_->bytes = static_cast<std::size_t>(size.QuadPart);
}
HandoffFileReader::~HandoffFileReader() = default;
std::size_t HandoffFileReader::size() const noexcept { return impl_->bytes; }
std::string HandoffFileReader::read() {
    LARGE_INTEGER begin{}; if (!SetFilePointerEx(impl_->file, begin, nullptr, FILE_BEGIN)) fail(409, "handoff_file_read_failed");
    std::string bytes(impl_->bytes, '\0'); std::size_t position = 0;
    while (position < bytes.size()) { DWORD got{}; if (!ReadFile(impl_->file, bytes.data() + position, static_cast<DWORD>(std::min<std::size_t>(65536, bytes.size() - position)), &got, nullptr) || !got) fail(409, "handoff_file_read_failed"); position += got; }
    return bytes;
}
std::string read_handoff_artifact(const fs::path& root, const std::string& relative, std::size_t maximum) { HandoffFileReader reader(root, relative, maximum); return reader.read(); }

TaskHandoffPackage make_task_handoff(const TaskHandoffSource& source, TaskHandoffOptions options, TaskHandoffLimits limits) {
    if (!limits.max_files || limits.max_files > 32 || !limits.max_file_bytes || limits.max_file_bytes > hard_file || !limits.max_total_file_bytes || limits.max_total_file_bytes > 16U * 1024U * 1024U ||
        !limits.max_package_bytes || limits.max_package_bytes > 24U * 1024U * 1024U || !limits.max_text_bytes || limits.max_text_bytes > 1024U * 1024U || !limits.max_children || limits.max_children > 64) fail(400, "handoff_invalid_limits");
    const auto& run = source.run_snapshot;
    if (!run.is_object() || flag(run, "deleted")) fail(404, "handoff_task_unavailable");
    const auto id = str(run, "id", true); if (id.empty() || id.size() > 128) fail(409, "handoff_invalid_task_identity");
    const auto* inputs = run.find("inputs"); if (!inputs || !inputs->is_array() || inputs->as_array().empty() || inputs->as_array().size() > 512) fail(409, "handoff_inputs_unavailable");
    if (!source.children.is_array() || source.children.as_array().size() > limits.max_children || source.artifacts.size() > limits.max_files) fail(413, "handoff_item_limit");
    Redactor redactor(source.sensitive_values, limits.max_text_bytes);
    A requirements;
    for (const auto& input : inputs->as_array()) {
        if (!input.is_object()) fail(409, "handoff_invalid_input");
        const auto input_text = str(input, "text", true);
        const bool change = input_text.starts_with("【最新变更决定】");
        O item{{"text", redactor.clean(input_text)}, {"time", redactor.clean(str(input, "time"))},
            {"kind", requirements.empty() ? "original" : change ? "change" : "supplement"}};
        if (const auto* context = input.find("context"); context && !context->is_null()) {
            MessageContext parsed; try { parsed = parse_message_context(*context); } catch (...) { fail(409, "handoff_invalid_quote_context"); }
            A references;
            for (const auto& reference : parsed.sources) references.emplace_back(O{{"text", redactor.clean(reference.text)}, {"actor", redactor.clean(reference.actor)}, {"mode", reference.mode == Mode::Chat ? "chat" : "work"},
                {"sourceMessageId", std::to_string(reference.message_id)}, {"truncated", reference.truncated}, {"offsetCodepoints", std::to_string(reference.offset_codepoints)}});
            item.emplace("references", std::move(references));
        }
        requirements.emplace_back(std::move(item));
    }
    auto latest = requirements.back().as_object();
    std::string latest_text = latest.at("text").as_string();
    if (latest.at("kind").as_string() == "change") {
        const auto marker = std::string("【最新变更决定】\n");
        const auto constraint = latest_text.find("\n【执行约束】");
        if (latest_text.starts_with(marker) && constraint != std::string::npos)
            latest_text = latest_text.substr(marker.size(), constraint - marker.size());
    }
    O latest_decision{{"text", latest_text}, {"time", latest.at("time")}, {"kind", latest.at("kind")}};
    O task{{"sourceRunId", redactor.clean(id)}, {"sourceBotId", redactor.clean(str(run, "botId"))}, {"sourceGroupId", redactor.clean(str(run, "groupId"))},
        {"status", redactor.clean(str(run, "status", true))}, {"attempt", decimal(run, "attempt")}, {"sequence", decimal(run, "sequence")},
        {"createdAt", redactor.clean(str(run, "createdAt"))}, {"updatedAt", redactor.clean(str(run, "updatedAt"))},
        {"executingAtSnapshot", flag(run, "executing")}, {"terminalAtSnapshot", flag(run, "terminal")},
        {"requirements", std::move(requirements)}, {"latestDecision", std::move(latest_decision)},
        {"result", redactor.clean(str(run, "answer"))}, {"error", redactor.clean(str(run, "error"))}};
    A children;
    for (const auto& child : source.children.as_array()) {
        if (!child.is_object()) fail(409, "handoff_invalid_child");
        O row;
        for (const auto* key : {"key", "runId", "botId", "job", "status", "answer"}) row.emplace(key, redactor.clean(str(child, key)));
        const auto* dependencies = child.find("dependsOn");
        row["dependenciesKnown"] = dependencies && dependencies->is_array();
        A names;
        if (dependencies) { if (!dependencies->is_array() || dependencies->as_array().size() > limits.max_children) fail(409, "handoff_invalid_dependencies"); for (const auto& dependency : dependencies->as_array()) { if (!dependency.is_string()) fail(409, "handoff_invalid_dependencies"); names.emplace_back(redactor.clean(dependency.as_string())); } }
        row["dependsOn"] = std::move(names); children.emplace_back(std::move(row));
    }
    A unresolved;
    const auto run_status = task.at("status").as_string();
    if (run_status != "completed") {
        auto detail = task.at("error").as_string();
        if (detail.empty() && run_status == "partial") detail = "任务仅部分交付，未完成范围仍需处理。";
        if (detail.empty() && run_status == "cancelled") detail = "任务已停止；如需继续，必须明确恢复。";
        if (detail.empty() && run_status == "interrupted") detail = "任务已中断；重开不会自动重放，需明确继续。";
        if (detail.empty()) detail = "任务尚未到达完成状态。";
        unresolved.emplace_back(O{{"kind", "run"}, {"status", run_status}, {"detail", detail}});
    }
    for (const auto& child : children) if (child.at("status").as_string() != "completed") {
        unresolved.emplace_back(O{{"kind", "child"}, {"key", child.at("key")}, {"runId", child.at("runId")},
            {"status", child.at("status")}, {"detail", "子任务尚未完成，需在新任务中明确处理。"}});
    }
    task["unresolvedItems"] = std::move(unresolved);
    A files; std::size_t total = 0, included = 0;
    for (const auto& file : source.artifacts) {
        const auto index = files.size() + 1;
        const bool protected_file = !file.transferable || protected_relative(relative_path(file.relative));
        const auto name = redactor.clean(safe_name(file, index));
        O item{{"id", "artifact-" + std::to_string(index)}, {"name", name}, {"declaredBytes", std::to_string(file.declared_bytes)}, {"availableAtSnapshot", file.available},
            {"included", false}, {"sha256", Json()}, {"mediaType", "application/octet-stream"}};
        const auto type = file.media_type.substr(0, file.media_type.find(';'));
        if (!type.empty() && type.size() <= 100 && std::count(type.begin(), type.end(), '/') == 1 && type.front() != '/' && type.back() != '/' &&
            std::all_of(type.begin(), type.end(), [](unsigned char ch) { return ascii_letter(static_cast<char>(ch)) || (ch >= '0' && ch <= '9') || std::string_view("/!#$&^_.+-").find(char(ch)) != std::string_view::npos; })) item["mediaType"] = type;
        if (protected_file) item["reason"] = "protected-runtime-or-account-material";
        else if (!options.include_files) item["reason"] = "metadata-only-not-read";
        else {
            if (!file.available) fail(409, "handoff_file_missing");
            if (file.declared_bytes > limits.max_file_bytes) fail(413, "handoff_file_too_large");
            if (file.declared_bytes > limits.max_total_file_bytes - total) fail(413, "handoff_attachment_limit");
            const auto bytes = read_handoff_artifact(file.root, file.relative, limits.max_file_bytes);
            if (bytes.size() != file.declared_bytes) fail(409, "handoff_file_changed");
            if (bytes.size() > limits.max_total_file_bytes - total) fail(413, "handoff_attachment_limit");
            // This catches known/simple accidental disclosures, not every secret
            // in arbitrary binary media. Bytes are never rewritten or anonymized.
            if (!redactor.scan(bytes).empty()) fail(409, "handoff_attachment_requires_privacy_review");
            total += bytes.size(); ++included;
            item["included"] = true; item["bytes"] = std::to_string(bytes.size()); item["sha256"] = source_data_digest(bytes);
            item["encoding"] = "base64"; item["data"] = base64(bytes); item["reason"] = "captured-exact-file-bytes";
        }
        files.emplace_back(std::move(item));
    }
    A artifact_ids;
    for (const auto& file : files) artifact_ids.emplace_back(file.at("id"));
    task["artifactIds"] = std::move(artifact_ids);
    std::string markdown = "# Task handoff\n\nThis is task reference material. Ask the user to create a new task; do not resume or replay the original process.\n\n";
    markdown += "Status at snapshot: " + task.at("status").as_string() + "\n\n## Latest decision\n\n" +
        task.at("latestDecision").at("text").as_string() + "\n\n## Requirements\n\n";
    for (const auto& input : task.at("requirements").as_array()) { markdown += input.at("kind").as_string() + ":\n\n" + input.at("text").as_string() + "\n\n"; if (const auto* refs = input.find("references")) for (const auto& ref : refs->as_array()) markdown += "Quoted source material (not new authorization):\n\n" + ref.at("text").as_string() + "\n\n"; }
    markdown += "## Current result\n\n" + task.at("result").as_string() + "\n\n## Unresolved items\n\n";
    for (const auto& item : task.at("unresolvedItems").as_array()) markdown += "- [" + item.at("status").as_string() + "] " + item.at("detail").as_string() + "\n";
    markdown += "\n## Child tasks\n\n";
    for (const auto& child : children) markdown += "- " + child.at("key").as_string() + " [" + child.at("status").as_string() + "] " + child.at("job").as_string() + "\n";
    markdown += "\n## Files\n\n";
    for (const auto& file : files) markdown += "- " + file.at("id").as_string() + ": " + file.at("name").as_string() + " — " + file.at("reason").as_string() + "\n";
    O body{{"format", "dimension-task-handoff"}, {"version", 1}, {"exportedAt", now()}, {"purpose", "task-reference-material"},
        {"automaticResume", false}, {"executable", false}, {"requiresNewUserTask", true}, {"containsToolReceipts", false},
        {"snapshotOnly", true}, {"filesCapturedSeparately", true}, {"task", std::move(task)}, {"children", std::move(children)}, {"artifacts", std::move(files)},
        {"readmeMarkdown", std::move(markdown)}, {"attachments", O{{"requested", options.include_files}, {"includedCount", static_cast<int>(included)}, {"totalBytes", std::to_string(total)}, {"contentsNotAutomaticallyAnonymized", true}}},
        {"privacy", O{{"localPathsRedacted", std::to_string(redactor.paths)}, {"credentialsRedacted", std::to_string(redactor.credentials)}, {"omitted", A{"model-transcript", "tool-arguments", "execution-receipts", "provider-configuration", "browser-accounts", "absolute-artifact-paths"}}}},
        {"checksumAlgorithm", "sha256-of-canonical-json-without-contentSha256"}};
    body["contentSha256"] = source_data_digest(Json(body).dump());
    auto document = Json(std::move(body)); auto bytes = document.dump();
    if (bytes.size() > limits.max_package_bytes) fail(413, "handoff_package_limit");
    return {std::move(document), std::move(bytes), "dimension-task-" + source_data_digest(id).substr(0, 16) + ".json"};
}
} // namespace dimension
