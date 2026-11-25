#include "dimension/cli_context_bus.hpp"
#include "dimension/atomic_file.hpp"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <mutex>
#include <set>
#include <sstream>

namespace dimension {
namespace {

namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

std::mutex& ledger_mutex() {
    static std::mutex m;
    return m;
}

std::int64_t now_epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string jstr(const Json& j, std::string_view key, std::string def = {}) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return (p && p->is_string()) ? p->as_string() : def;
}

double jnum(const Json& j, std::string_view key, double def = 0.0) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return (p && p->is_number()) ? p->as_number() : def;
}

bool jbool(const Json& j, std::string_view key, bool def = false) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return (p && p->is_bool()) ? p->as_bool() : def;
}

std::string trim_copy(std::string_view s) {
    std::size_t b = 0;
    std::size_t e = s.size();
    while (b < e && static_cast<unsigned char>(s[b]) <= 0x20U) ++b;
    while (e > b && static_cast<unsigned char>(s[e - 1]) <= 0x20U) --e;
    return std::string(s.substr(b, e - b));
}

std::string clip_utf8_safe(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    if (max_bytes < 4U) return {};
    std::size_t end = max_bytes - 3U;
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0U) == 0x80U) --end;
    return std::string(s.substr(0, end)) + "…";
}

std::string collapse_single_line(std::string_view s, std::size_t max_bytes) {
    std::string out;
    out.reserve(std::min(s.size(), max_bytes + 8U));
    bool prev_ws = false;
    for (char ch : s) {
        if (ch == '\r' || ch == '\n' || ch == '\t' || ch == ' ') {
            if (!out.empty() && !prev_ws) out.push_back(' ');
            prev_ws = true;
        } else {
            out.push_back(ch);
            prev_ws = false;
        }
        if (out.size() >= max_bytes + 16U) break;
    }
    return clip_utf8_safe(trim_copy(out), max_bytes);
}

std::string sanitize_ledger_filename(std::string_view raw) {
    std::string out;
    out.reserve(std::min<std::size_t>(raw.size(), 80U));
    for (unsigned char ch : raw) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            (ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
            out.push_back(static_cast<char>(ch));
        } else {
            out.push_back('_');
        }
        if (out.size() >= 80U) break;
    }
    return out.empty() ? std::string("default") : out;
}

fs::path ledger_dir(const fs::path& data_root) {
    return data_root / "cli-context-bus";
}

fs::path ledger_file_path(const fs::path& data_root, std::string_view ledger_id) {
    return ledger_dir(data_root) / (sanitize_ledger_filename(ledger_id) + ".json");
}

std::vector<std::string_view> split_lines(std::string_view text) {
    std::vector<std::string_view> lines;
    if (text.empty()) return lines;
    std::size_t start = 0;
    while (start <= text.size()) {
        const auto nl = text.find('\n', start);
        std::string_view line = (nl == std::string_view::npos)
            ? text.substr(start)
            : text.substr(start, nl - start);
        if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
        lines.push_back(line);
        if (nl == std::string_view::npos) break;
        start = nl + 1;
    }
    if (!lines.empty() && lines.back().empty() && !text.empty() && text.back() == '\n') {
        lines.pop_back();
    }
    return lines;
}

CliHandoffLedger load_ledger_unlocked(const fs::path& data_root, std::string_view ledger_id) {
    CliHandoffLedger out;
    out.ledger_id = std::string(ledger_id);
    if (data_root.empty() || ledger_id.empty()) return out;

    std::error_code ec;
    const fs::path p = ledger_file_path(data_root, ledger_id);
    if (!fs::is_regular_file(p, ec)) return out;

    std::ifstream in(p, std::ios::binary);
    if (!in) return out;
    std::ostringstream oss;
    oss << in.rdbuf();
    try {
        const Json doc = Json::parse(oss.str());
        if (doc.is_object()) {
            out = CliHandoffLedger::from_json(doc);
            if (out.ledger_id.empty()) out.ledger_id = std::string(ledger_id);
        }
    } catch (...) {}
    return out;
}

fs::path handoff_relative_path(std::string_view ledger_id) {
    return fs::path(".dimension") / "handoffs" / (sanitize_ledger_filename(ledger_id) + ".md");
}

const char* command_status(const CliCommandReceipt& cmd) {
    return !cmd.result_known ? "UNKNOWN" : cmd.failed ? "FAIL" : "PASS";
}

const char* turn_status(const CliTurnLedgerEntry& turn) {
    return turn.cancelled ? "已取消（部分完成）" : turn.success ? "成功" : "失败";
}

void write_workspace_handoff_markdown(const fs::path& workspace_dir, const CliHandoffLedger& ledger) {
    if (workspace_dir.empty()) return;
    std::error_code ec;
    if (!fs::is_directory(workspace_dir, ec)) return;

    const fs::path dim_dir = workspace_dir / ".dimension";
    fs::create_directories(dim_dir / "handoffs", ec);
    if (ec) return;

    std::ostringstream md;
    md << "# DimensionAgent 跨 CLI 工程交接详单\n\n";
    md << "- Ledger ID: `" << ledger.ledger_id << "`\n";
    md << "- 已完成棒次: " << ledger.turns.size() << "\n";
    md << "- 累计改动文件: " << ledger.files.size() << "\n\n";

    if (!ledger.hard_constraints.empty()) {
        md << "## 用户不可违背的硬约束\n";
        for (const auto& hc : ledger.hard_constraints) {
            md << "- " << hc << "\n";
        }
        md << "\n";
    }

    if (!ledger.turns.empty()) {
        md << "## 执行接力轨迹\n";
        for (const auto& t : ledger.turns) {
            md << "### 第 " << t.turn_index << " 棒 · " << (t.bot_name.empty() ? t.bot_id : t.bot_name)
               << " (" << (t.engine_name.empty() ? t.engine_id : t.engine_name);
            if (!t.model_label.empty()) md << " / " << t.model_label;
            md << ") · " << turn_status(t) << "\n";
            if (!t.task_summary.empty()) md << "- 任务：" << t.task_summary << "\n";
            if (!t.outcome_summary.empty()) md << "- 结果：" << t.outcome_summary << "\n";
            if (!t.touched_files.empty()) {
                md << "- 改动文件：";
                for (std::size_t i = 0; i < t.touched_files.size(); ++i) {
                    if (i > 0) md << ", ";
                    md << "`" << t.touched_files[i] << "`";
                }
                md << "\n";
            }
            if (!t.commands.empty()) {
                md << "- 验证命令：\n";
                for (const auto& cmd : t.commands) {
                    md << "  - `" << cmd.command << "` -> " << command_status(cmd);
                    if (!cmd.output_excerpt.empty()) md << " (" << cmd.output_excerpt << ")";
                    md << "\n";
                }
            }
            md << "\n";
        }
    }

    if (!ledger.files.empty()) {
        md << "## 文件变更与精简 Diff\n";
        for (const auto& [rel, f] : ledger.files) {
            md << "### `" << rel << "` (" << (f.created ? "新建" : "修改")
               << ", " << f.bytes << "B";
            if (f.added_lines > 0 || f.removed_lines > 0) {
                md << ", +" << f.added_lines << "/-" << f.removed_lines;
            }
            md << ", 最近经手: " << (f.last_engine_name.empty() ? f.last_engine_id : f.last_engine_name) << ")\n";
            if (!f.diff_excerpt.empty()) {
                md << "```diff\n" << f.diff_excerpt << "\n```\n";
            }
            md << "\n";
        }
    }

    try {
        AtomicWriteOptions wopts;
        wopts.existing_root = dim_dir;
        atomic_write_file(workspace_dir / handoff_relative_path(ledger.ledger_id), md.str(), wopts);
    } catch (...) {}
}

void prune_stale_ledgers_unlocked(const fs::path& dir) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return;
    const auto now = fs::file_time_type::clock::now();
    constexpr auto kMaxAge = std::chrono::hours(24 * 14);
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        const auto mtime = entry.last_write_time(ec);
        if (!ec && now > mtime && (now - mtime) > kMaxAge) {
            fs::remove(entry.path(), ec);
        }
    }
}

} // namespace

void CliCommandTracker::observe(const NormalizedCliEvent& event) {
    if (event.kind == "tool_end") {
        const auto it = pending_.find(event.tool_call_id);
        if (it != pending_.end()) {
            auto& receipt = receipts_[it->second];
            receipt.result_known = true;
            receipt.failed = event.is_error;
            receipt.output_excerpt = clip_utf8_safe(event.output, 360U);
            pending_.erase(it);
            return;
        }
    }
    if (event.action_category != "command" || (event.kind != "tool_start" && event.kind != "tool_end")) return;
    const auto& command = event.display_target.empty() ? event.args_json : event.display_target;
    if (command.empty()) return;
    const bool finished = event.kind == "tool_end";
    receipts_.push_back({command, finished && event.is_error, finished ? clip_utf8_safe(event.output, 360U) : "", finished});
    if (!finished && !event.tool_call_id.empty()) pending_[event.tool_call_id] = receipts_.size() - 1;
}

std::vector<CliCommandReceipt> CliCommandTracker::take() {
    pending_.clear();
    return std::move(receipts_);
}

Json CliCommandReceipt::to_json() const {
    return O{
        {"command", command},
        {"failed", failed},
        {"resultKnown", result_known},
        {"outputExcerpt", output_excerpt}
    };
}

CliCommandReceipt CliCommandReceipt::from_json(const Json& j) {
    CliCommandReceipt out;
    out.command = jstr(j, "command");
    out.failed = jbool(j, "failed");
    out.result_known = jbool(j, "resultKnown", out.failed);
    out.output_excerpt = jstr(j, "outputExcerpt");
    return out;
}

Json CliFileLedgerEntry::to_json() const {
    return O{
        {"relativePath", relative_path},
        {"created", created},
        {"bytes", static_cast<double>(bytes)},
        {"addedLines", static_cast<double>(added_lines)},
        {"removedLines", static_cast<double>(removed_lines)},
        {"diffExcerpt", diff_excerpt},
        {"lastEngineId", last_engine_id},
        {"lastEngineName", last_engine_name},
        {"lastBotName", last_bot_name},
        {"updatedAtMs", static_cast<double>(updated_at_ms)}
    };
}

CliFileLedgerEntry CliFileLedgerEntry::from_json(const Json& j) {
    CliFileLedgerEntry out;
    out.relative_path = jstr(j, "relativePath");
    out.created = jbool(j, "created");
    out.bytes = static_cast<std::uintmax_t>(std::max(0.0, jnum(j, "bytes", 0.0)));
    out.added_lines = static_cast<int>(jnum(j, "addedLines", 0.0));
    out.removed_lines = static_cast<int>(jnum(j, "removedLines", 0.0));
    out.diff_excerpt = jstr(j, "diffExcerpt");
    out.last_engine_id = jstr(j, "lastEngineId");
    out.last_engine_name = jstr(j, "lastEngineName");
    out.last_bot_name = jstr(j, "lastBotName");
    out.updated_at_ms = static_cast<std::int64_t>(jnum(j, "updatedAtMs", 0.0));
    return out;
}

Json CliTurnLedgerEntry::to_json() const {
    A touched;
    for (const auto& f : touched_files) touched.push_back(f);
    A cmds;
    for (const auto& c : commands) cmds.push_back(c.to_json());
    return O{
        {"turnIndex", static_cast<double>(turn_index)},
        {"botId", bot_id},
        {"botName", bot_name},
        {"engineId", engine_id},
        {"engineName", engine_name},
        {"modelLabel", model_label},
        {"nativeSessionId", native_session_id},
        {"taskSummary", task_summary},
        {"outcomeSummary", outcome_summary},
        {"success", success},
        {"cancelled", cancelled},
        {"durationMs", static_cast<double>(duration_ms)},
        {"completedAtMs", static_cast<double>(completed_at_ms)},
        {"touchedFiles", std::move(touched)},
        {"commands", std::move(cmds)}
    };
}

CliTurnLedgerEntry CliTurnLedgerEntry::from_json(const Json& j) {
    CliTurnLedgerEntry out;
    out.turn_index = static_cast<int>(jnum(j, "turnIndex", 0.0));
    out.bot_id = jstr(j, "botId");
    out.bot_name = jstr(j, "botName");
    out.engine_id = jstr(j, "engineId");
    out.engine_name = jstr(j, "engineName");
    out.model_label = jstr(j, "modelLabel");
    out.native_session_id = jstr(j, "nativeSessionId");
    out.task_summary = jstr(j, "taskSummary");
    out.outcome_summary = jstr(j, "outcomeSummary");
    out.success = jbool(j, "success");
    out.cancelled = jbool(j, "cancelled");
    out.duration_ms = static_cast<std::int64_t>(jnum(j, "durationMs", 0.0));
    out.completed_at_ms = static_cast<std::int64_t>(jnum(j, "completedAtMs", 0.0));
    if (const auto* tf = j.find("touchedFiles"); tf && tf->is_array()) {
        for (const auto& item : tf->as_array()) {
            if (item.is_string()) out.touched_files.push_back(item.as_string());
        }
    }
    if (const auto* cs = j.find("commands"); cs && cs->is_array()) {
        for (const auto& item : cs->as_array()) {
            if (item.is_object()) out.commands.push_back(CliCommandReceipt::from_json(item));
        }
    }
    return out;
}

Json CliHandoffLedger::to_json() const {
    A hc;
    for (const auto& c : hard_constraints) hc.push_back(c);
    A ts;
    for (const auto& t : turns) ts.push_back(t.to_json());
    O fs_map;
    for (const auto& [k, v] : files) fs_map[k] = v.to_json();
    return O{
        {"schemaVersion", 1.0},
        {"ledgerId", ledger_id},
        {"hardConstraints", std::move(hc)},
        {"turns", std::move(ts)},
        {"files", std::move(fs_map)}
    };
}

CliHandoffLedger CliHandoffLedger::from_json(const Json& j) {
    CliHandoffLedger out;
    out.ledger_id = jstr(j, "ledgerId");
    if (const auto* hc = j.find("hardConstraints"); hc && hc->is_array()) {
        for (const auto& item : hc->as_array()) {
            if (item.is_string()) out.hard_constraints.push_back(item.as_string());
        }
    }
    if (const auto* ts = j.find("turns"); ts && ts->is_array()) {
        for (const auto& item : ts->as_array()) {
            if (item.is_object()) out.turns.push_back(CliTurnLedgerEntry::from_json(item));
        }
    }
    if (const auto* fm = j.find("files"); fm && fm->is_object()) {
        for (const auto& [k, v] : fm->as_object()) {
            if (v.is_object()) {
                auto e = CliFileLedgerEntry::from_json(v);
                if (e.relative_path.empty()) e.relative_path = k;
                out.files[k] = std::move(e);
            }
        }
    }
    return out;
}

Json CliHandoffPrepared::to_event_json() const {
    return O{
        {"injected", injected},
        {"crossEngine", cross_engine},
        {"crossMember", cross_member},
        {"previousEngineId", previous_engine_id},
        {"previousEngineName", previous_engine_name},
        {"previousBotName", previous_bot_name},
        {"handedOffFiles", static_cast<double>(handed_off_files)},
        {"handedOffTurns", static_cast<double>(handed_off_turns)}
    };
}

std::string build_compact_line_diff(std::string_view before,
                                    std::string_view after,
                                    int& out_added,
                                    int& out_removed,
                                    std::size_t max_bytes) {
    out_added = 0;
    out_removed = 0;
    const auto old_lines = split_lines(before);
    const auto new_lines = split_lines(after);

    if (old_lines.empty() && !new_lines.empty()) {
        out_added = static_cast<int>(new_lines.size());
        std::ostringstream oss;
        const std::size_t preview_lines = std::min<std::size_t>(new_lines.size(), 12U);
        for (std::size_t i = 0; i < preview_lines; ++i) {
            oss << "+ " << clip_utf8_safe(new_lines[i], 140U) << "\n";
            if (oss.tellp() >= static_cast<std::streamoff>(max_bytes)) break;
        }
        if (new_lines.size() > preview_lines) {
            oss << "+ …（共新建 " << new_lines.size() << " 行）";
        }
        return clip_utf8_safe(trim_copy(oss.str()), max_bytes);
    }

    std::size_t prefix = 0;
    const std::size_t min_len = std::min(old_lines.size(), new_lines.size());
    while (prefix < min_len && old_lines[prefix] == new_lines[prefix]) ++prefix;

    std::size_t old_end = old_lines.size();
    std::size_t new_end = new_lines.size();
    while (old_end > prefix && new_end > prefix && old_lines[old_end - 1] == new_lines[new_end - 1]) {
        --old_end;
        --new_end;
    }

    const auto m = old_end - prefix;
    const auto n = new_end - prefix;
    if (!m && !n) return {};
    // Bound work while the ledger lock is held. Large regions are explicitly labelled, not counted as edits.
    constexpr std::size_t cell_budget = 1'000'000;
    if (m && n && (m + 1 > cell_budget / (n + 1))) {
        return "差异覆盖范围：旧文件从第 " + std::to_string(prefix + 1) + " 行起 " +
               std::to_string(m) + " 行，新文件对应 " + std::to_string(n) + " 行（未统计实际增删）";
    }
    std::vector<unsigned> lcs;
    const auto index = [n](std::size_t i, std::size_t j) { return i * (n + 1) + j; };
    if (m && n) {
        lcs.resize((m + 1) * (n + 1));
        for (auto i = m; i-- > 0;) {
            for (auto j = n; j-- > 0;) {
                lcs[index(i,j)] = old_lines[prefix+i] == new_lines[prefix+j]
                    ? 1U + lcs[index(i+1,j+1)]
                    : std::max(lcs[index(i+1,j)], lcs[index(i,j+1)]);
            }
        }
    }
    std::ostringstream excerpt;
    std::size_t i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && old_lines[prefix+i] == new_lines[prefix+j]) {
            ++i;
            ++j;
        } else if (i < m && (j == n || lcs[index(i+1,j)] >= lcs[index(i,j+1)])) {
            if (++out_removed <= 6) excerpt << "- " << clip_utf8_safe(old_lines[prefix+i], 120U) << "\n";
            ++i;
        } else {
            if (++out_added <= 8) excerpt << "+ " << clip_utf8_safe(new_lines[prefix+j], 120U) << "\n";
            ++j;
        }
    }
    return clip_utf8_safe("@@ L" + std::to_string(prefix + 1) + " (-" + std::to_string(out_removed) +
        "/+" + std::to_string(out_added) + ") @@\n" + trim_copy(excerpt.str()), max_bytes);
}

CliHandoffPrepared prepare_cli_context_handoff(const CliHandoffPrepareRequest& req) {
    CliHandoffPrepared out;
    if (req.data_root.empty() || req.ledger_id.empty()) return out;

    CliHandoffLedger ledger;
    {
        std::lock_guard lk(ledger_mutex());
        ledger = load_ledger_unlocked(req.data_root, req.ledger_id);
    }
    if (ledger.turns.empty()) return out;

    const auto& last = ledger.turns.back();
    out.previous_engine_id = last.engine_id;
    out.previous_engine_name = last.engine_name.empty() ? last.engine_id : last.engine_name;
    out.previous_bot_name = last.bot_name.empty() ? last.bot_id : last.bot_name;
    out.cross_engine = (!req.target_engine_id.empty() && last.engine_id != req.target_engine_id);
    out.cross_member = (!req.bot_id.empty() && !last.bot_id.empty() && last.bot_id != req.bot_id);

    const bool same_model = req.target_model_label.empty() || last.model_label.empty() ||
                            (last.model_label == req.target_model_label);
    // Zero-overhead fast path: same member + same CLI engine + same model + live native session.
    if (!last.cancelled && !out.cross_engine && !out.cross_member && same_model && req.target_has_existing_session) {
        return out;
    }

    // Check if this exact bot/engine already saw all turns (e.g. session existed from the latest turn).
    // Otherwise synthesize a high-signal engine-agnostic handoff card.
    out.injected = true;
    out.handed_off_turns = ledger.turns.size();
    out.handed_off_files = ledger.files.size();
    if (!req.workspace_dir.empty()) {
        out.detail_file_path = req.workspace_dir / handoff_relative_path(req.ledger_id);
    }

    std::ostringstream card;
    if (!out.detail_file_path.empty()) {
        std::error_code ec;
        if (!fs::is_regular_file(out.detail_file_path, ec)) write_workspace_handoff_markdown(req.workspace_dir, ledger);
        if (fs::is_regular_file(out.detail_file_path, ec)) card << "交接详单：" << handoff_relative_path(req.ledger_id).generic_string() << "\n";
    }
    card << "【DimensionAgent 跨 CLI 权威工程交接上下文（由系统客观采集，请在现有成果上继续，严禁推倒重写）】\n";
    if (out.cross_engine && out.cross_member) {
        card << "- 接力说明：前序由成员「" << out.previous_bot_name << "」使用 " << out.previous_engine_name
             << " 执行，现由你接力使用 " << (req.target_engine_name.empty() ? req.target_engine_id : req.target_engine_name) << " 继续。\n";
    } else if (out.cross_engine) {
        card << "- 接力说明：前序由 " << out.previous_engine_name
             << " 执行，现已切换引擎为 " << (req.target_engine_name.empty() ? req.target_engine_id : req.target_engine_name)
             << " 接手同一任务。\n";
    } else if (out.cross_member) {
        card << "- 接力说明：前序由成员「" << out.previous_bot_name << "」在同一共享工作区完成以下进展，现由你接棒。\n";
    } else {
        card << "- 接力说明：原生 CLI 会话已重建，系统已自动为你恢复本任务前序客观成果与验证记录。\n";
    }

    if (!ledger.hard_constraints.empty()) {
        card << "- 不可违背的硬约束：";
        for (std::size_t i = 0; i < ledger.hard_constraints.size() && i < 6U; ++i) {
            if (i > 0) card << "；";
            card << ledger.hard_constraints[i];
        }
        card << "\n";
    }

    // Include up to the 4 most recent turns for trajectory continuity.
    const std::size_t start_turn = (ledger.turns.size() > 4U) ? (ledger.turns.size() - 4U) : 0U;
    if (last.cancelled)
        card << "上轮已取消。先核对现有文件和最后成功的命令，再说明仍缺的验收步骤；状态未知的命令须先检查效果，避免重复执行。\n";
    card << "\n### 前序接力进展\n";
    for (std::size_t i = start_turn; i < ledger.turns.size(); ++i) {
        const auto& t = ledger.turns[i];
        card << t.turn_index << ". [" << (t.bot_name.empty() ? t.bot_id : t.bot_name)
             << " · " << (t.engine_name.empty() ? t.engine_id : t.engine_name)
             << " · " << turn_status(t) << "] ";
        if (!t.task_summary.empty()) card << "任务=" << clip_utf8_safe(t.task_summary, 140U) << " | ";
        if (!t.outcome_summary.empty()) card << "结论=" << clip_utf8_safe(t.outcome_summary, 200U);
        card << "\n";
        for (const auto& cmd : t.commands) {
            card << "   - 命令 `" << clip_utf8_safe(cmd.command, 100U) << "` => "
                 << command_status(cmd);
            if (!cmd.output_excerpt.empty()) {
                card << "：" << clip_utf8_safe(cmd.output_excerpt, 140U);
            }
            card << "\n";
        }
    }

    if (!ledger.files.empty()) {
        card << "\n### 已落盘改动文件账单（共 " << ledger.files.size() << " 个）\n";
        // Sort files by most recently updated first so the freshest changes always fit within budget.
        std::vector<const CliFileLedgerEntry*> sorted_files;
        sorted_files.reserve(ledger.files.size());
        for (const auto& [_, entry] : ledger.files) sorted_files.push_back(&entry);
        std::sort(sorted_files.begin(), sorted_files.end(), [](const auto* a, const auto* b) {
            return a->updated_at_ms > b->updated_at_ms;
        });

        std::size_t shown = 0;
        for (const auto* f : sorted_files) {
            if (shown >= 8U) break;
            card << "- `" << f->relative_path << "`（" << (f->created ? "新建" : "修改")
                 << "，" << f->bytes << "B";
            if (f->added_lines > 0 || f->removed_lines > 0) {
                card << "，+" << f->added_lines << "/-" << f->removed_lines << " 行";
            }
            card << "，经手：" << (f->last_engine_name.empty() ? f->last_engine_id : f->last_engine_name) << "）\n";
            if (shown < 3U && !f->diff_excerpt.empty()) {
                card << "```diff\n" << clip_utf8_safe(f->diff_excerpt, 360U) << "\n```\n";
            }
            ++shown;
        }
        if (sorted_files.size() > shown) {
            card << "- …其余 " << (sorted_files.size() - shown) << " 个改动文件见详单。\n";
        }
    }

    card << "【交接上下文结束，以下为本棒具体指令】\n\n";

    const std::size_t budget = std::clamp<std::size_t>(req.max_inline_bytes, 1024U, 8192U);
    out.prompt_prefix = clip_utf8_safe(card.str(), budget);
    return out;
}

void record_cli_context_outcome(const CliHandoffRecordRequest& req) {
    if (req.data_root.empty() || req.ledger_id.empty()) return;
    if (req.run_result.cancelled && req.run_result.file_deltas.empty() && req.commands.empty()) return;

    std::lock_guard lk(ledger_mutex());
    CliHandoffLedger ledger = load_ledger_unlocked(req.data_root, req.ledger_id);
    if (ledger.ledger_id.empty()) ledger.ledger_id = req.ledger_id;

    // Merge hard constraints deterministically without duplicates.
    std::set<std::string> seen_hc(ledger.hard_constraints.begin(), ledger.hard_constraints.end());
    for (const auto& hc : req.constraints.hard_constraints) {
        const std::string clean = collapse_single_line(hc, 200U);
        if (!clean.empty() && seen_hc.insert(clean).second) {
            ledger.hard_constraints.push_back(clean);
        }
    }

    const auto ts_ms = now_epoch_ms();
    CliTurnLedgerEntry turn;
    turn.turn_index = ledger.turns.empty() ? 1 : (ledger.turns.back().turn_index + 1);
    turn.bot_id = req.bot_id;
    turn.bot_name = req.bot_name.empty() ? req.bot_id : req.bot_name;
    turn.engine_id = req.run_result.resolved_engine_id;
    turn.engine_name = req.run_result.resolved_engine_name.empty()
        ? req.run_result.resolved_engine_id : req.run_result.resolved_engine_name;
    turn.model_label = req.run_result.resolved_model_label;
    turn.native_session_id = req.run_result.native_session_id;
    turn.task_summary = collapse_single_line(req.task_prompt, 360U);
    const std::string raw_outcome = req.run_result.success
        ? req.run_result.final_response
        : (!req.run_result.error_detail.empty() ? req.run_result.error_detail : req.run_result.final_response);
    turn.outcome_summary = collapse_single_line(raw_outcome, 520U);
    turn.success = req.run_result.success && !req.run_result.cancelled;
    turn.cancelled = req.run_result.cancelled;
    turn.duration_ms = req.run_result.duration_ms;
    turn.completed_at_ms = ts_ms;

    // Keep up to the 4 most informative recent command receipts (prefer failures + final checks).
    if (!req.commands.empty()) {
        const std::size_t keep_start = req.commands.size() > 4U ? (req.commands.size() - 4U) : 0U;
        for (std::size_t i = keep_start; i < req.commands.size(); ++i) {
            CliCommandReceipt c;
            c.command = collapse_single_line(req.commands[i].command, 180U);
            c.failed = req.commands[i].failed;
            c.result_known = req.commands[i].result_known;
            c.output_excerpt = collapse_single_line(req.commands[i].output_excerpt, 360U);
            if (!c.command.empty()) turn.commands.push_back(std::move(c));
        }
    }

    // Record ground-truth file deltas & compact diffs.
    for (const auto& d : req.run_result.file_deltas) {
        if (d.relative_path.empty() || d.relative_path.starts_with(".dimension/")) continue;
        turn.touched_files.push_back(d.relative_path);

        CliFileLedgerEntry entry;
        entry.relative_path = d.relative_path;
        entry.created = d.created;
        entry.bytes = d.bytes;
        entry.last_engine_id = turn.engine_id;
        entry.last_engine_name = turn.engine_name;
        entry.last_bot_name = turn.bot_name;
        entry.updated_at_ms = ts_ms;
        if (!d.before_content.empty() || !d.after_content.empty()) {
            entry.diff_excerpt = build_compact_line_diff(
                d.before_content, d.after_content, entry.added_lines, entry.removed_lines, 900U);
        }
        ledger.files[d.relative_path] = std::move(entry);
    }

    ledger.turns.push_back(std::move(turn));
    while (ledger.turns.size() > 20U) {
        ledger.turns.erase(ledger.turns.begin());
    }

    // Persist canonical JSON ledger atomically.
    std::error_code ec;
    const fs::path dir = ledger_dir(req.data_root);
    fs::create_directories(dir, ec);
    try {
        AtomicWriteOptions wopts;
        wopts.existing_root = dir;
        atomic_write_file(ledger_file_path(req.data_root, req.ledger_id), ledger.to_json().dump(), wopts);
    } catch (...) {}

    // Refresh workspace .dimension/handoff.md so any CLI can inspect full details on demand.
    write_workspace_handoff_markdown(req.workspace_dir, ledger);
    prune_stale_ledgers_unlocked(dir);
}

CliHandoffLedger load_cli_handoff_ledger(const fs::path& data_root, std::string_view ledger_id) {
    std::lock_guard lk(ledger_mutex());
    return load_ledger_unlocked(data_root, ledger_id);
}

std::size_t recommended_reception_history_budget(std::string_view engine_id,
                                                 std::string_view context_feature,
                                                 bool has_summary_in_system) {
    const bool is_chat = (context_feature == "chat" || context_feature == "group");
    if (is_chat && has_summary_in_system) {
        // Summary already anchors long-term history; keep recent turns crisp (~36 KiB) for fast cross-CLI switching.
        return 36U * 1024U;
    }
    if (is_chat) {
        // Even without an archived summary, keep conversational reception snappy when switching engines.
        return 72U * 1024U;
    }
    // Work lead / commander keeps generous budget while respecting smaller CLI defaults.
    if (engine_id == "qwen-code" || engine_id == "opencode") {
        return 96U * 1024U;
    }
    return 140U * 1024U;
}

} // namespace dimension
