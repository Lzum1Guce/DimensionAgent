#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/file_ops.hpp"
#include "dimension/atomic_file.hpp"

#include <windows.h>
#include <shellapi.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cwctype>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

constexpr std::size_t kMaxEditableBytes = 2U * 1024U * 1024U;

std::wstring extended_path(const fs::path& p) {
    auto value = fs::absolute(p).lexically_normal().wstring();
    if (value.starts_with(L"\\\\?\\")) return value;
    if (value.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}

std::string to_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

fs::path from_utf8(std::string_view s) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

std::wstring lock_key_for(const fs::path& p) {
    auto norm = fs::absolute(p).lexically_normal().wstring();
    for (auto& ch : norm) {
        if (ch == L'/') ch = L'\\';
        else ch = static_cast<wchar_t>(std::towlower(ch));
    }
    return norm;
}

class FileLockRegistry {
public:
    static FileLockRegistry& instance() {
        static FileLockRegistry reg;
        return reg;
    }

    std::shared_ptr<std::mutex> mutex_for(const fs::path& target) {
        const auto key = lock_key_for(target);
        std::lock_guard guard(mutex_);
        if (locks_.size() > 512) {
            for (auto it = locks_.begin(); it != locks_.end();) {
                if (it->second.use_count() == 1) it = locks_.erase(it);
                else ++it;
            }
        }
        auto& ptr = locks_[key];
        if (!ptr) ptr = std::make_shared<std::mutex>();
        return ptr;
    }

private:
    std::mutex mutex_;
    std::map<std::wstring, std::shared_ptr<std::mutex>> locks_;
};

std::string read_bounded(const fs::path& p, std::size_t limit) {
    const auto ext = extended_path(p);
    const auto attrs = GetFileAttributesW(ext.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES)
        throw std::runtime_error("目标文件不存在");
    if (attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("目标路径不是普通文件或包含符号链接");
    const auto sz = fs::file_size(ext);
    if (sz > limit)
        throw std::runtime_error("文件体积超过可编辑上限 (2 MiB)");
    std::ifstream in(ext, std::ios::binary);
    if (!in) throw std::runtime_error("无法读取目标文件");
    std::string out(static_cast<std::size_t>(sz), '\0');
    if (sz > 0) {
        in.read(out.data(), static_cast<std::streamsize>(sz));
        if (!in) throw std::runtime_error("读取目标文件内容不完整");
    }
    return out;
}

std::string lf_to_crlf(std::string_view text) {
    std::string out;
    out.reserve(text.size() + text.size() / 16);
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '\r' && i + 1 < text.size() && text[i + 1] == '\n') {
            out += "\r\n";
            ++i;
        } else if (text[i] == '\n') {
            out += "\r\n";
        } else {
            out.push_back(text[i]);
        }
    }
    return out;
}

std::size_t count_occurrences(std::string_view haystack, std::string_view needle) {
    if (needle.empty()) return 0;
    std::size_t count = 0, pos = 0;
    while ((pos = haystack.find(needle, pos)) != std::string_view::npos) {
        ++count;
        pos += needle.size();
    }
    return count;
}

std::string replace_occurrences(std::string_view haystack, std::string_view needle,
                                std::string_view replacement, bool replace_all) {
    std::string out;
    out.reserve(haystack.size() + replacement.size());
    std::size_t pos = 0;
    while (true) {
        const auto next = haystack.find(needle, pos);
        if (next == std::string_view::npos) {
            out.append(haystack.substr(pos));
            break;
        }
        out.append(haystack.substr(pos, next - pos));
        out.append(replacement);
        pos = next + needle.size();
        if (!replace_all) {
            out.append(haystack.substr(pos));
            break;
        }
    }
    return out;
}

bool should_skip_dir(std::string_view name) {
    static const std::set<std::string_view> kIgnored{
        ".git", ".hg", ".svn", "node_modules", "build", "out", "dist", "target",
        ".venv", "venv", ".vs", ".idea", "__pycache__", ".next", ".nuxt", ".cache",
        "webview-profile", "stage-verify-tests"
    };
    return kIgnored.contains(name);
}

std::string lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string safe_utf8_preview(std::string_view line, std::size_t max_bytes = 240) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
        line.remove_suffix(1);
    if (line.size() <= max_bytes) return std::string(line);
    std::size_t end = max_bytes;
    while (end > 0 && (static_cast<unsigned char>(line[end]) & 0xC0U) == 0x80U)
        --end;
    return std::string(line.substr(0, end)) + " …";
}

} // namespace

std::string sha256_hex(std::string_view bytes) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
        throw std::runtime_error("无法初始化 SHA-256 提供程序");
    struct AlgGuard {
        BCRYPT_ALG_HANDLE h;
        ~AlgGuard() { if (h) BCryptCloseAlgorithmProvider(h, 0); }
    } guard{alg};

    DWORD obj_len = 0, cb = 0;
    if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&obj_len), sizeof(obj_len), &cb, 0) < 0)
        throw std::runtime_error("无法读取 SHA-256 参数");
    std::vector<unsigned char> obj(obj_len);
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptCreateHash(alg, &hash, obj.data(), obj_len, nullptr, 0, 0) < 0)
        throw std::runtime_error("无法创建 SHA-256 句柄");
    struct HashGuard {
        BCRYPT_HASH_HANDLE h;
        ~HashGuard() { if (h) BCryptDestroyHash(h); }
    } hguard{hash};

    std::array<unsigned char, 32> digest{};
    if (BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),
                       static_cast<ULONG>(bytes.size()), 0) < 0 ||
        BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
        throw std::runtime_error("SHA-256 计算失败");
    }
    std::ostringstream oss;
    for (unsigned char b : digest)
        oss << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(b);
    return oss.str();
}

FileEditResult edit_file_locked(const FileEditRequest& request,
                                const BeforeFileWriteHook& on_before_write,
                                std::stop_token stop) {
    if (request.target_text.empty())
        return {false, 0, {}, {}, {}, "edit_file 的 target 不能为空"};
    if (request.target_text.size() > 512U * 1024U || request.replacement_text.size() > kMaxEditableBytes)
        return {false, 0, {}, {}, {}, "target 或 replacement 超过单次局部替换大小上限"};

    auto file_mutex = FileLockRegistry::instance().mutex_for(request.target_path);
    std::lock_guard<std::mutex> file_lock(*file_mutex);

    if (stop.stop_requested())
        throw std::runtime_error("任务已取消");

    const std::string original = read_bounded(request.target_path, kMaxEditableBytes);
    const std::string before_sha = sha256_hex(original);
    const bool has_crlf = original.find("\r\n") != std::string::npos;
    const std::string eol_name = has_crlf ? "CRLF" : "LF";

    if (!request.expected_sha256.empty() && request.expected_sha256 != before_sha) {
        return {false, 0, before_sha, before_sha, eol_name,
                "并发冲突：文件已被其他队友任务或外部编辑器修改，请先调用 read_file 读取最新内容后再做局部修改"};
    }

    std::string effective_target = request.target_text;
    std::string effective_replacement = request.replacement_text;
    std::size_t count = count_occurrences(original, effective_target);

    if (count == 0 && has_crlf && effective_target.find("\r\n") == std::string::npos &&
        effective_target.find('\n') != std::string::npos) {
        effective_target = lf_to_crlf(request.target_text);
        effective_replacement = lf_to_crlf(request.replacement_text);
        count = count_occurrences(original, effective_target);
    } else if (count > 0 && has_crlf && effective_replacement.find("\r\n") == std::string::npos &&
               effective_replacement.find('\n') != std::string::npos) {
        effective_replacement = lf_to_crlf(request.replacement_text);
    }

    if (count == 0) {
        return {false, 0, before_sha, before_sha, eol_name,
                "未在文件中找到完全匹配的 target 文本（请检查缩进空格或先调用 read_file / grep_files 核对最新原文）"};
    }
    if (count > 1 && !request.replace_all) {
        return {false, 0, before_sha, before_sha, eol_name,
                "target 在文件中匹配到了 " + std::to_string(count) +
                " 处；为防止误改其他段落，请在 target 中多包含几行上下文使其唯一，或显式传 replaceAll=true"};
    }

    const std::string updated = replace_occurrences(original, effective_target, effective_replacement, request.replace_all);
    if (updated.size() > kMaxEditableBytes)
        return {false, 0, before_sha, before_sha, eol_name, "替换后文件体积超过 2 MiB 上限"};

    const std::string after_sha = sha256_hex(updated);
    if (on_before_write)
        on_before_write(original, updated);

    AtomicWriteOptions write_opts;
    if (!request.root.empty()) write_opts.existing_root = request.root;
    atomic_write_file(request.target_path, updated, write_opts, stop);

    const std::size_t applied = request.replace_all ? count : 1U;
    return {true, applied, before_sha, after_sha, eol_name,
            "已精准替换 " + request.relative_path + "（共 " + std::to_string(applied) + " 处，保持 " + eol_name + " 换行）"};
}

void write_file_locked(const fs::path& root,
                       const fs::path& target_path,
                       std::string_view content,
                       const BeforeFileWriteHook& on_before_write,
                       std::stop_token stop) {
    auto file_mutex = FileLockRegistry::instance().mutex_for(target_path);
    std::lock_guard<std::mutex> file_lock(*file_mutex);

    if (stop.stop_requested())
        throw std::runtime_error("任务已取消");

    std::string before;
    const auto ext = extended_path(target_path);
    const auto attrs = GetFileAttributesW(ext.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
        std::error_code ec;
        const auto sz = fs::file_size(ext, ec);
        if (!ec && sz <= kMaxEditableBytes) {
            std::ifstream in(ext, std::ios::binary);
            before.resize(static_cast<std::size_t>(sz));
            if (sz > 0) in.read(before.data(), static_cast<std::streamsize>(sz));
        }
    }
    if (on_before_write)
        on_before_write(before, content);

    AtomicWriteOptions write_opts;
    if (!root.empty()) write_opts.existing_root = root;
    atomic_write_file(target_path, content, write_opts, stop);
}

Json grep_files(const fs::path& root, const GrepOptions& options, std::stop_token stop) {
    if (options.pattern.empty() || options.pattern.size() > 512)
        throw std::runtime_error("grep_files 搜索词长度须在 1 到 512 字节之间");

    const std::size_t limit = std::clamp<std::size_t>(options.max_matches, 1, 200);
    fs::path start_dir = root;
    if (!options.sub_path.empty() && options.sub_path != ".") {
        auto rel = from_utf8(options.sub_path);
        if (rel.is_absolute() || rel.has_root_name())
            throw std::runtime_error("subPath 必须为工作区内相对路径");
        start_dir = (root / rel).lexically_normal();
        const auto root_norm = lock_key_for(root);
        const auto start_norm = lock_key_for(start_dir);
        if (!start_norm.starts_with(root_norm))
            throw std::runtime_error("subPath 超出工作区根目录范围");
    }

    std::optional<std::regex> compiled_regex;
    if (options.use_regex) {
        auto flags = std::regex::ECMAScript;
        if (!options.case_sensitive) flags |= std::regex::icase;
        try {
            compiled_regex.emplace(options.pattern, flags);
        } catch (const std::exception&) {
            throw std::runtime_error("正则表达式语法无效");
        }
    }
    const std::string needle = options.case_sensitive ? options.pattern : lower_ascii(options.pattern);
    const std::string filter_lower = lower_ascii(options.file_filter);

    A matches;
    std::size_t files_scanned = 0;
    bool truncated = false;

    auto scan_one_file = [&](const fs::path& file_path) {
        if (stop.stop_requested()) return;
        std::error_code ec;
        const auto ext = extended_path(file_path);
        const auto attrs = GetFileAttributesW(ext.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
            return;
        const auto sz = fs::file_size(ext, ec);
        if (ec || sz == 0 || sz > kMaxEditableBytes) return;

        const auto rel_path = fs::relative(file_path, root, ec);
        std::string rel_str = ec ? to_utf8(file_path.filename()) : to_utf8(rel_path);
        std::replace(rel_str.begin(), rel_str.end(), '\\', '/');
        if (!filter_lower.empty() && lower_ascii(rel_str).find(filter_lower) == std::string::npos)
            return;

        std::ifstream in(ext, std::ios::binary);
        if (!in) return;
        std::array<char, 4096> probe{};
        in.read(probe.data(), static_cast<std::streamsize>(std::min<std::uintmax_t>(sz, probe.size())));
        const auto probed = static_cast<std::size_t>(in.gcount());
        if (std::memchr(probe.data(), '\0', probed) != nullptr)
            return; // Skip binary files.

        in.clear();
        in.seekg(0, std::ios::beg);
        ++files_scanned;

        std::string line;
        std::size_t line_no = 0;
        while (std::getline(in, line)) {
            ++line_no;
            bool hit = false;
            if (compiled_regex) {
                hit = std::regex_search(line, *compiled_regex);
            } else if (options.case_sensitive) {
                hit = line.find(needle) != std::string::npos;
            } else {
                hit = lower_ascii(line).find(needle) != std::string::npos;
            }
            if (hit) {
                matches.push_back(O{
                    {"path", rel_str},
                    {"line", static_cast<double>(line_no)},
                    {"text", safe_utf8_preview(line)}
                });
                if (matches.size() >= limit) {
                    truncated = true;
                    return;
                }
            }
        }
    };

    std::error_code ec;
    if (fs::is_regular_file(extended_path(start_dir), ec)) {
        scan_one_file(start_dir);
    } else if (fs::is_directory(extended_path(start_dir), ec)) {
        fs::recursive_directory_iterator it(start_dir, fs::directory_options::skip_permission_denied, ec), end;
        for (; it != end && !truncated && !stop.stop_requested(); it.increment(ec)) {
            if (ec) { ec.clear(); continue; }
            const auto& entry_path = it->path();
            if (it->is_symlink(ec)) {
                if (it->is_directory(ec)) it.disable_recursion_pending();
                continue;
            }
            if (it->is_directory(ec)) {
                if (should_skip_dir(to_utf8(entry_path.filename()))) {
                    it.disable_recursion_pending();
                }
                continue;
            }
            if (files_scanned >= 5000) {
                truncated = true;
                break;
            }
            scan_one_file(entry_path);
        }
    }

    return O{
        {"ok", true},
        {"count", static_cast<double>(matches.size())},
        {"filesScanned", static_cast<double>(files_scanned)},
        {"truncated", truncated},
        {"matches", std::move(matches)}
    };
}

Json recycle_windows_path(const fs::path& target_path) {
    const auto abs = fs::absolute(target_path).lexically_normal();
    const auto drive = abs.root_name().wstring();
    const bool is_local = drive.size() == 2 && drive[1] == L':' &&
        ((drive[0] >= L'A' && drive[0] <= L'Z') || (drive[0] >= L'a' && drive[0] <= L'z'));
    if (!is_local || abs == abs.root_path() || abs.relative_path().empty())
        throw std::runtime_error("仅支持将本机磁盘上的具体文件或子文件夹移入系统回收站");

    const auto low = lock_key_for(abs);
    for (const wchar_t* sys_prefix : {L"c:\\windows", L"c:\\program files", L"c:\\program files (x86)", L"c:\\programdata", L"c:\\users\\default"}) {
        const std::wstring pref(sys_prefix);
        if (low == pref || low.starts_with(pref + L"\\"))
            throw std::runtime_error("安全保护：禁止将系统核心目录移入回收站");
    }

    const auto ext = extended_path(abs);
    const auto attrs = GetFileAttributesW(ext.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES)
        throw std::runtime_error("待移入回收站的目标不存在");
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT)
        throw std::runtime_error("安全保护：不支持直接对符号链接/目录联接执行回收操作");

    std::wstring double_null = abs.wstring();
    if (double_null.size() >= MAX_PATH - 2)
        throw std::runtime_error("路径长度超过 Windows Shell 回收站接口上限");
    double_null.push_back(L'\0');
    double_null.push_back(L'\0');

    SHFILEOPSTRUCTW op{};
    op.wFunc = FO_DELETE;
    op.pFrom = double_null.c_str();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;

    const int rc = SHFileOperationW(&op);
    if (rc != 0 || op.fAnyOperationsAborted) {
        throw std::runtime_error("移入 Windows 回收站失败（错误码 " + std::to_string(rc) + "，目标可能正被其他进程占用）");
    }
    return O{
        {"ok", true},
        {"recycledPath", to_utf8(abs)},
        {"recoverableInRecycleBin", true}
    };
}

} // namespace dimension
