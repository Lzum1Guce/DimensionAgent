#define NOMINMAX
#include "dimension/work_checkpoints.hpp"
#include "dimension/atomic_file.hpp"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <set>
#include <sstream>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

constexpr std::size_t kMaxFilesPerCheckpoint = 320;
constexpr std::uintmax_t kMaxSingleFileBytes = 2U * 1024U * 1024U;     // 2 MiB per file
constexpr std::uintmax_t kMaxTotalSnapshotBytes = 24U * 1024U * 1024U; // 24 MiB total cap
constexpr std::size_t kMaxCheckpointsPerRun = 24;

std::int64_t now_epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

std::string to_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

fs::path from_utf8(std::string_view s) {
    const std::u8string u8(reinterpret_cast<const char8_t*>(s.data()), s.size());
    return fs::path(u8);
}

std::string ascii_low(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string safe_clip(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t end = max_bytes;
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0U) == 0x80U) --end;
    return std::string(s.substr(0, end)) + "…";
}

std::string normalize_rel(std::string s) {
    std::replace(s.begin(), s.end(), '\\', '/');
    while (s.starts_with("./")) s.erase(0, 2);
    while (!s.empty() && s.front() == '/') s.erase(0, 1);
    return s;
}

bool is_safe_relative(std::string_view rel) {
    if (rel.empty() || rel.find(':') != std::string_view::npos) return false;
    if (rel.starts_with("/") || rel.starts_with("\\") || rel.find("..") != std::string_view::npos) return false;
    return true;
}

bool should_skip_dir(std::string_view name) {
    const auto low = ascii_low(name);
    return low == ".git" || low == "node_modules" || low == "build" || low == "dist-cache" ||
           low == ".venv" || low == "venv" || low == "__pycache__" || low == "target" ||
           low == ".next" || low == "scratch" || low == "sandbox-snapshots" ||
           low == "plugin-adaptation" || low == ".dimension-cli-tmp";
}

std::string read_bytes_file(const fs::path& p) {
    std::ifstream ifs(p, std::ios::binary);
    if (!ifs) return {};
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

void write_bytes_atomic(const fs::path& p, std::string_view data) {
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    const auto abs_p = fs::absolute(p, ec);
    atomic_write_file(ec ? p : abs_p, data);
}

std::string jstr(const Json& j, std::string_view k, std::string def = {}) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_string()) ? p->as_string() : def;
}

double jnum(const Json& j, std::string_view k, double def = 0.0) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_number()) ? p->as_number() : def;
}

bool jbool(const Json& j, std::string_view k, bool def = false) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_bool()) ? p->as_bool() : def;
}

} // namespace

Json CheckpointEntryInfo::to_json() const {
    return O{
        {"id", id},
        {"version", static_cast<double>(version_number)},
        {"versionTag", "v" + std::to_string(version_number)},
        {"label", label},
        {"createdAtMs", static_cast<double>(created_at_ms)},
        {"fileCount", static_cast<double>(file_count)},
        {"totalBytes", static_cast<double>(total_bytes)},
        {"primaryHtmlRel", primary_html_rel}
    };
}

Json CheckpointRestoreResult::to_json() const {
    return O{
        {"ok", ok},
        {"checkpointId", checkpoint_id},
        {"version", static_cast<double>(version_number)},
        {"restoredFiles", static_cast<double>(restored_files)},
        {"removedExtraFiles", static_cast<double>(removed_extra_files)},
        {"backupCheckpointId", backup_checkpoint_id}
    };
}

WorkCheckpointService::WorkCheckpointService(std::filesystem::path storage_root)
    : storage_root_(std::move(storage_root)) {
    std::error_code ec;
    fs::create_directories(storage_root_, ec);
}

std::optional<CheckpointEntryInfo> WorkCheckpointService::capture(
    const std::string& root_run_id,
    std::string_view label,
    const std::filesystem::path& workspace_dir,
    bool is_auto_backup) {
    if (root_run_id.empty() || workspace_dir.empty()) return std::nullopt;
    std::error_code ec;
    if (!fs::is_directory(workspace_dir, ec)) return std::nullopt;

    struct CapturedFile {
        std::string rel;
        fs::path src_path;
        std::uintmax_t size = 0;
    };
    std::vector<CapturedFile> collected;
    std::uintmax_t total_sz = 0;

    for (fs::recursive_directory_iterator it(workspace_dir, fs::directory_options::skip_permission_denied, ec), end;
         !ec && it != end && collected.size() < kMaxFilesPerCheckpoint;
         it.increment(ec)) {
        if (it->is_directory(ec)) {
            if (should_skip_dir(to_utf8(it->path().filename()))) {
                it.disable_recursion_pending();
            }
            continue;
        }
        if (!it->is_regular_file(ec) || it->is_symlink(ec)) continue;
        const auto sz = it->file_size(ec);
        if (ec || sz > kMaxSingleFileBytes) continue;
        if (total_sz + sz > kMaxTotalSnapshotBytes) break;

        const auto rel = normalize_rel(to_utf8(fs::relative(it->path(), workspace_dir, ec)));
        if (ec || !is_safe_relative(rel)) continue;
        // Skip incoming uploaded attachments to avoid duplicating static user inputs
        if (rel.starts_with("incoming/")) continue;

        total_sz += sz;
        collected.push_back({rel, it->path(), sz});
    }

    if (collected.empty() && !is_auto_backup) {
        return std::nullopt;
    }

    std::lock_guard lk(mutex_);
    const fs::path run_dir = storage_root_ / from_utf8(root_run_id);
    const fs::path index_path = run_dir / L"index.json";
    fs::create_directories(run_dir, ec);

    A existing_items;
    int max_ver = 0;
    int seq_counter = 0;
    if (fs::is_regular_file(index_path, ec)) {
        try {
            const auto doc = Json::parse(read_bytes_file(index_path));
            seq_counter = static_cast<int>(jnum(doc, "nextSeq", 0));
            if (const auto* arr = doc.find("checkpoints"); arr && arr->is_array()) {
                existing_items = arr->as_array();
                for (const auto& item : existing_items) {
                    if (!jbool(item, "autoBackup", false)) {
                        max_ver = std::max(max_ver, static_cast<int>(jnum(item, "version", 0)));
                    }
                }
            }
        } catch (...) {}
    }

    ++seq_counter;
    const std::string cp_id = (is_auto_backup ? "backup-" : "cp-") + std::to_string(seq_counter);
    const int ver_num = is_auto_backup ? 0 : (max_ver + 1);
    const fs::path files_store = run_dir / from_utf8(cp_id) / L"files";
    fs::create_directories(files_store, ec);

    std::string primary_html;
    A manifest_files;
    for (const auto& cf : collected) {
        const fs::path dst = files_store / from_utf8(cf.rel);
        fs::create_directories(dst.parent_path(), ec);
        fs::copy_file(cf.src_path, dst, fs::copy_options::overwrite_existing, ec);
        manifest_files.push_back(cf.rel);

        const auto low_rel = ascii_low(cf.rel);
        if (low_rel.ends_with(".html") || low_rel.ends_with(".htm") || low_rel.ends_with(".svg")) {
            if (primary_html.empty() || low_rel.ends_with("index.html")) {
                primary_html = cf.rel;
            }
        }
    }

    CheckpointEntryInfo info;
    info.id = cp_id;
    info.version_number = ver_num;
    info.label = safe_clip(label, 120);
    info.created_at_ms = now_epoch_ms();
    info.file_count = collected.size();
    info.total_bytes = total_sz;
    info.primary_html_rel = primary_html;

    O record = info.to_json().as_object();
    record["autoBackup"] = is_auto_backup;
    record["files"] = std::move(manifest_files);
    existing_items.push_back(std::move(record));

    // Prune oldest checkpoints if exceeding cap
    while (existing_items.size() > kMaxCheckpointsPerRun) {
        const auto oldest_id = jstr(existing_items.front(), "id");
        if (!oldest_id.empty()) {
            fs::remove_all(run_dir / from_utf8(oldest_id), ec);
        }
        existing_items.erase(existing_items.begin());
    }

    write_bytes_atomic(index_path, Json(O{
        {"runId", root_run_id},
        {"nextSeq", static_cast<double>(seq_counter)},
        {"checkpoints", std::move(existing_items)}
    }).dump());

    return info;
}

std::vector<CheckpointEntryInfo> WorkCheckpointService::list(const std::string& root_run_id) const {
    std::vector<CheckpointEntryInfo> out;
    if (root_run_id.empty()) return out;
    std::lock_guard lk(mutex_);
    const fs::path index_path = storage_root_ / from_utf8(root_run_id) / L"index.json";
    std::error_code ec;
    if (!fs::is_regular_file(index_path, ec)) return out;
    try {
        const auto doc = Json::parse(read_bytes_file(index_path));
        if (const auto* arr = doc.find("checkpoints"); arr && arr->is_array()) {
            for (const auto& item : arr->as_array()) {
                if (jbool(item, "autoBackup", false)) continue;
                CheckpointEntryInfo info;
                info.id = jstr(item, "id");
                info.version_number = static_cast<int>(jnum(item, "version", 1));
                info.label = jstr(item, "label");
                info.created_at_ms = static_cast<std::int64_t>(jnum(item, "createdAtMs", 0));
                info.file_count = static_cast<std::size_t>(jnum(item, "fileCount", 0));
                info.total_bytes = static_cast<std::uintmax_t>(jnum(item, "totalBytes", 0));
                info.primary_html_rel = jstr(item, "primaryHtmlRel");
                out.push_back(std::move(info));
            }
        }
    } catch (...) {}
    return out;
}

std::optional<std::string> WorkCheckpointService::read_checkpoint_file(
    const std::string& root_run_id,
    const std::string& checkpoint_id,
    std::string_view relative_path) const {
    const std::string norm = normalize_rel(std::string(relative_path));
    if (root_run_id.empty() || checkpoint_id.empty() || !is_safe_relative(norm)) {
        return std::nullopt;
    }
    if (!is_safe_relative(checkpoint_id)) return std::nullopt;
    std::lock_guard lk(mutex_);
    const fs::path target = storage_root_ / from_utf8(root_run_id) / from_utf8(checkpoint_id) / L"files" / from_utf8(norm);
    std::error_code ec;
    if (!fs::is_regular_file(target, ec)) return std::nullopt;
    return read_bytes_file(target);
}

CheckpointRestoreResult WorkCheckpointService::restore(
    const std::string& root_run_id,
    const std::string& checkpoint_id,
    const std::filesystem::path& workspace_dir) {
    CheckpointRestoreResult res;
    res.checkpoint_id = checkpoint_id;
    if (root_run_id.empty() || checkpoint_id.empty() || !is_safe_relative(checkpoint_id) || workspace_dir.empty()) {
        return res;
    }

    // 1. Capture safety backup before mutating workspace
    const auto safety = capture(root_run_id, "回退前自动保护快照", workspace_dir, true);
    if (safety) res.backup_checkpoint_id = safety->id;

    std::lock_guard lk(mutex_);
    const fs::path run_dir = storage_root_ / from_utf8(root_run_id);
    const fs::path index_path = run_dir / L"index.json";
    const fs::path files_store = run_dir / from_utf8(checkpoint_id) / L"files";
    std::error_code ec;
    if (!fs::is_regular_file(index_path, ec) || !fs::is_directory(files_store, ec)) {
        return res;
    }

    std::set<std::string> target_rels;
    try {
        const auto doc = Json::parse(read_bytes_file(index_path));
        if (const auto* arr = doc.find("checkpoints"); arr && arr->is_array()) {
            bool found = false;
            for (const auto& item : arr->as_array()) {
                if (jstr(item, "id") == checkpoint_id) {
                    found = true;
                    res.version_number = static_cast<int>(jnum(item, "version", 0));
                    if (const auto* farr = item.find("files"); farr && farr->is_array()) {
                        for (const auto& f : farr->as_array()) {
                            if (f.is_string() && is_safe_relative(f.as_string())) {
                                target_rels.insert(normalize_rel(f.as_string()));
                            }
                        }
                    }
                    break;
                }
            }
            if (!found) return res;
        }
    } catch (...) {
        return res;
    }

    // 2. Remove extra files created in later turns (excluding skipped dirs and incoming/)
    if (fs::is_directory(workspace_dir, ec)) {
        std::vector<fs::path> to_remove;
        for (fs::recursive_directory_iterator it(workspace_dir, fs::directory_options::skip_permission_denied, ec), end;
             !ec && it != end;
             it.increment(ec)) {
            if (it->is_directory(ec)) {
                if (should_skip_dir(to_utf8(it->path().filename()))) {
                    it.disable_recursion_pending();
                }
                continue;
            }
            if (!it->is_regular_file(ec) || it->is_symlink(ec)) continue;
            const auto rel = normalize_rel(to_utf8(fs::relative(it->path(), workspace_dir, ec)));
            if (ec || !is_safe_relative(rel) || rel.starts_with("incoming/")) continue;
            if (!target_rels.contains(rel)) {
                to_remove.push_back(it->path());
            }
        }
        for (const auto& dead : to_remove) {
            if (fs::remove(dead, ec)) ++res.removed_extra_files;
        }
    }

    // 3. Restore all files from snapshot atomically
    fs::create_directories(workspace_dir, ec);
    for (const auto& rel : target_rels) {
        const fs::path src = files_store / from_utf8(rel);
        if (!fs::is_regular_file(src, ec)) continue;
        const fs::path dst = workspace_dir / from_utf8(rel);
        write_bytes_atomic(dst, read_bytes_file(src));
        ++res.restored_files;
    }

    res.ok = true;
    return res;
}

} // namespace dimension
