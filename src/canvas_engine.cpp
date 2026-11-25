#include "dimension/canvas_engine.hpp"
#include "dimension/atomic_file.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <queue>
#include <set>
#include <sstream>
#include <stdexcept>

namespace dimension {
namespace {

namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

std::string jstr(const Json& j, std::string_view key, std::string fallback = {}) {
    if (!j.is_object()) return fallback;
    if (const auto* v = j.find(key); v && v->is_string()) return v->as_string();
    return fallback;
}

bool jbool(const Json& j, std::string_view key, bool fallback = false) {
    if (!j.is_object()) return fallback;
    if (const auto* v = j.find(key); v && v->is_bool()) return v->as_bool();
    return fallback;
}

double jnum(const Json& j, std::string_view key, double fallback = 0.0) {
    if (!j.is_object()) return fallback;
    if (const auto* v = j.find(key); v && v->is_number()) return v->as_number();
    return fallback;
}

int jint(const Json& j, std::string_view key, int fallback = 0) {
    return static_cast<int>(std::llround(jnum(j, key, static_cast<double>(fallback))));
}

std::int64_t now_epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string trim_copy(std::string_view s) {
    std::size_t a = 0;
    while (a < s.size() && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
    std::size_t b = s.size();
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
    return std::string(s.substr(a, b - a));
}

std::string ascii_lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

void replace_all(std::string& text, std::string_view from, std::string_view to) {
    if (from.empty()) return;
    std::size_t pos = 0;
    while ((pos = text.find(from, pos)) != std::string::npos) {
        text.replace(pos, from.size(), to);
        pos += to.size();
    }
}

std::string sanitize_id(std::string_view raw, std::string_view prefix) {
    std::string out;
    out.reserve(raw.size());
    for (char c : raw) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_') {
            out.push_back(c);
        }
    }
    if (out.empty()) {
        out = std::string(prefix) + "-" + std::to_string(now_epoch_ms());
    }
    if (out.size() > 72) out.resize(72);
    return out;
}

std::string read_text_file_bounded(const fs::path& p, std::size_t max_bytes, bool& out_truncated, std::uintmax_t& out_total_bytes) {
    out_truncated = false;
    out_total_bytes = 0;
    std::error_code ec;
    if (!fs::is_regular_file(p, ec)) return {};
    out_total_bytes = fs::file_size(p, ec);
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    const std::size_t to_read = static_cast<std::size_t>(std::min<std::uintmax_t>(out_total_bytes, max_bytes));
    std::string buf(to_read, '\0');
    if (to_read > 0) in.read(buf.data(), static_cast<std::streamsize>(to_read));
    buf.resize(static_cast<std::size_t>(in.gcount()));
    if (out_total_bytes > to_read) out_truncated = true;
    // Strip UTF-8 BOM if present
    if (buf.size() >= 3 && static_cast<unsigned char>(buf[0]) == 0xEF &&
        static_cast<unsigned char>(buf[1]) == 0xBB && static_cast<unsigned char>(buf[2]) == 0xBF) {
        buf.erase(0, 3);
    }
    return buf;
}

const CanvasNode* find_node(const CanvasGraph& g, std::string_view id) {
    for (const auto& n : g.nodes) {
        if (n.id == id) return &n;
    }
    return nullptr;
}

const CanvasEdge* find_edge(const CanvasGraph& g, std::string_view id) {
    for (const auto& e : g.edges) {
        if (e.id == id) return &e;
    }
    return nullptr;
}

bool is_feedback_edge(const CanvasEdge& e) {
    return e.wire_kind == "feedback" || e.from_port == "loop";
}

bool is_logic_gate(const CanvasNode& n) {
    return n.type == "gate" &&
           (n.gate_mode == "bool_switch" || n.gate_mode == "logic_and" || n.gate_mode == "logic_or");
}

bool evaluate_text_as_bool(std::string_view raw) {
    const std::string t = trim_copy(raw);
    if (t.empty()) return false;
    const std::string low = ascii_lower(t);
    if (low == "false" || low == "0" || low == "no" || low == "off" || low == "fail" || low == "failed" ||
        t == "否" || t == "假" || t == "不通过" || t == "失败" || t == "关闭") {
        return false;
    }
    if (low == "true" || low == "1" || low == "yes" || low == "on" || low == "pass" || low == "ok" ||
        t == "是" || t == "真" || t == "通过" || t == "成功" || t == "开启") {
        return true;
    }
    if (low.starts_with("false") || low.starts_with("[false]") || low.starts_with("[fail]")) return false;
    if (low.starts_with("true") || low.starts_with("[true]") || low.starts_with("[pass]")) return true;
    const bool has_fail = low.find("[fail]") != std::string::npos;
    const bool has_pass = low.find("[pass]") != std::string::npos;
    if (has_fail && !has_pass) return false;
    return true;
}

bool evaluate_condition_rule(const CanvasConditionRule& r, std::string_view text, std::string& out_desc) {
    const std::string low_txt = ascii_lower(text);
    const std::string val = trim_copy(r.value);
    const std::string low_val = ascii_lower(val);
    if (r.op == "not_contains") {
        const bool ok = low_val.empty() ? true : (low_txt.find(low_val) == std::string::npos);
        out_desc = "不包含「" + val + "」";
        return ok;
    }
    if (r.op == "equals") {
        const bool ok = ascii_lower(trim_copy(text)) == low_val;
        out_desc = "等于「" + val + "」";
        return ok;
    }
    if (r.op == "not_empty") {
        const bool ok = !trim_copy(text).empty();
        out_desc = "内容不为空";
        return ok;
    }
    if (r.op == "is_true") {
        out_desc = "布尔判定为真";
        return evaluate_text_as_bool(text);
    }
    if (r.op == "is_false") {
        out_desc = "布尔判定为假";
        return !evaluate_text_as_bool(text);
    }
    if (r.op == "gt_len") {
        int threshold = 0;
        try { threshold = std::stoi(val); } catch (...) { threshold = 0; }
        const bool ok = static_cast<int>(trim_copy(text).size()) > threshold;
        out_desc = "长度大于 " + std::to_string(threshold);
        return ok;
    }
    const bool ok = low_val.empty() ? !trim_copy(text).empty() : (low_txt.find(low_val) != std::string::npos);
    out_desc = "包含「" + val + "」";
    return ok;
}

// Recursively collects all source nodes attached onto target_edge_id (parallel supplements).
void collect_edge_supplement_sources(const CanvasGraph& graph,
                                     const std::string& target_edge_id,
                                     std::set<std::string>& visited_edges,
                                     std::vector<std::string>& out_nodes) {
    if (!visited_edges.insert(target_edge_id).second) return;
    std::vector<const CanvasEdge*> attached;
    for (const auto& e : graph.edges) {
        if (is_feedback_edge(e)) continue;
        if (e.target_kind == "edge" && e.target_id == target_edge_id) {
            attached.push_back(&e);
        }
    }
    std::sort(attached.begin(), attached.end(), [](const CanvasEdge* a, const CanvasEdge* b) {
        if (a->attach_t != b->attach_t) return a->attach_t < b->attach_t;
        return a->id < b->id;
    });
    for (const auto* se : attached) {
        if (std::find(out_nodes.begin(), out_nodes.end(), se->from_node_id) == out_nodes.end()) {
            out_nodes.push_back(se->from_node_id);
        }
        collect_edge_supplement_sources(graph, se->id, visited_edges, out_nodes);
    }
}

void render_edge_supplements_markdown(const CanvasGraph& graph,
                                      const std::string& parent_edge_id,
                                      const std::string& parent_source_title,
                                      const std::map<std::string, std::string>& node_outputs,
                                      const std::map<std::string, std::vector<std::string>>& node_artifacts,
                                      int depth,
                                      std::set<std::string>& visited_edges,
                                      std::ostringstream& out) {
    if (!visited_edges.insert(parent_edge_id).second) return;
    std::vector<const CanvasEdge*> attached;
    for (const auto& e : graph.edges) {
        if (is_feedback_edge(e)) continue;
        if (e.target_kind == "edge" && e.target_id == parent_edge_id) {
            attached.push_back(&e);
        }
    }
    std::sort(attached.begin(), attached.end(), [](const CanvasEdge* a, const CanvasEdge* b) {
        if (a->attach_t != b->attach_t) return a->attach_t < b->attach_t;
        return a->id < b->id;
    });
    const std::string hashes(static_cast<std::size_t>(std::min(depth + 3, 6)), '#');
    for (const auto* se : attached) {
        const auto* sn = find_node(graph, se->from_node_id);
        const std::string s_title = (sn && !sn->title.empty()) ? sn->title : se->from_node_id;
        out << "\n" << hashes << " ↳ 针对「" << parent_source_title << "」的并行补充信息（汇入连线，来自「"
            << s_title << "」" << (!se->label.empty() ? (" · " + se->label) : "") << "）\n";
        if (const auto it = node_outputs.find(se->from_node_id); it != node_outputs.end() && !it->second.empty()) {
            out << it->second << "\n";
        } else {
            out << "（该补充节点无正文输出）\n";
        }
        if (const auto ait = node_artifacts.find(se->from_node_id); ait != node_artifacts.end() && !ait->second.empty()) {
            out << "相关产物：";
            for (std::size_t i = 0; i < ait->second.size(); ++i) {
                if (i > 0) out << "、";
                out << ait->second[i];
            }
            out << "\n";
        }
        render_edge_supplements_markdown(graph, se->id, s_title, node_outputs, node_artifacts, depth + 1, visited_edges, out);
    }
}

bool check_function_recursion(const CanvasGraph& graph,
                              const std::map<std::string, CanvasGraph>& functions,
                              std::vector<std::string>& stack,
                              int depth,
                              std::string& out_error) {
    if (depth > 4) {
        out_error = "蓝图函数嵌套深度超过上限（最多 4 层）";
        return false;
    }
    for (const auto& n : graph.nodes) {
        if (n.type != "function_call") continue;
        if (n.function_id.empty()) {
            out_error = "蓝图函数芯片「" + (n.title.empty() ? n.id : n.title) + "」尚未绑定目标函数";
            return false;
        }
        if (std::find(stack.begin(), stack.end(), n.function_id) != stack.end()) {
            out_error = "检测到蓝图函数循环递归引用：" + n.function_id;
            return false;
        }
        const auto it = functions.find(n.function_id);
        if (it == functions.end()) {
            out_error = "蓝图函数芯片引用的函数不存在：" + n.function_id;
            return false;
        }
        stack.push_back(n.function_id);
        const bool ok = check_function_recursion(it->second, functions, stack, depth + 1, out_error);
        stack.pop_back();
        if (!ok) return false;
    }
    return true;
}

} // namespace

// ============================================================================
// JSON Serialization
// ============================================================================

Json CanvasConditionRule::to_json() const {
    return O{{"op", op}, {"value", value}};
}

CanvasConditionRule CanvasConditionRule::from_json(const Json& j) {
    CanvasConditionRule r;
    const auto op = jstr(j, "op", "contains");
    if (op == "contains" || op == "not_contains" || op == "equals" ||
        op == "not_empty" || op == "is_true" || op == "is_false" || op == "gt_len") {
        r.op = op;
    } else {
        r.op = "contains";
    }
    r.value = jstr(j, "value");
    return r;
}

Json CanvasNode::to_json() const {
    A rules_arr;
    for (const auto& r : condition_rules) rules_arr.push_back(r.to_json());
    return O{
        {"id", id},
        {"type", type},
        {"title", title},
        {"x", x},
        {"y", y},
        {"botMode", bot_mode},
        {"botId", bot_id},
        {"inlineName", inline_name},
        {"inlinePersona", inline_persona},
        {"engineKind", engine_kind},
        {"providerId", provider_id},
        {"model", model},
        {"cliEngineId", cli_engine_id},
        {"cliModelSource", cli_model_source},
        {"cliNativeProvider", cli_native_provider},
        {"cliNativeModel", cli_native_model}, {"requiresWorkspace", requires_workspace}, {"assignmentLocked", assignment_locked},
        {"reasoningEffort", reasoning_effort},
        {"readOnly", read_only},
        {"prompt", prompt},
        {"contextMode", context_mode},
        {"includeMemory", include_memory},
        {"refMode", ref_mode},
        {"refText", ref_text},
        {"filePath", file_path},
        {"maxInlineChars", static_cast<double>(max_inline_chars)},
        {"forceFullText", force_full_text},
        {"compressMode", compress_mode},
        {"maxOutputChars", static_cast<double>(max_output_chars)},
        {"gateMode", gate_mode},
        {"passKeyword", pass_keyword},
        {"failKeyword", fail_keyword},
        {"maxIterations", static_cast<double>(max_iterations)},
        {"approvalHint", approval_hint},
        {"boolSource", bool_source},
        {"boolValue", bool_value},
        {"invertResult", invert_result},
        {"conditionRules", std::move(rules_arr)},
        {"functionId", function_id},
        {"paramNote", param_note},
        {"actionKind", action_kind},
        {"actionTarget", action_target},
        {"actionArgs", action_args},
        {"actionTimeoutSec", static_cast<double>(action_timeout_sec)}
    };
}

CanvasNode CanvasNode::from_json(const Json& j) {
    CanvasNode n;
    n.id = sanitize_id(jstr(j, "id"), "node");
    n.type = jstr(j, "type", "agent");
    if (n.type != "input" && n.type != "action" && n.type != "reference" && n.type != "agent" &&
        n.type != "compress" && n.type != "gate" && n.type != "function_call") {
        n.type = "agent";
    }
    n.title = jstr(j, "title");
    n.x = jnum(j, "x", 0.0);
    n.y = jnum(j, "y", 0.0);
    n.bot_mode = jstr(j, "botMode", "existing") == "inline" ? "inline" : "existing";
    n.bot_id = jstr(j, "botId");
    n.inline_name = jstr(j, "inlineName");
    n.inline_persona = jstr(j, "inlinePersona");
    n.engine_kind = jstr(j, "engineKind", "api") == "cli" ? "cli" : "api";
    n.provider_id = jstr(j, "providerId");
    n.model = jstr(j, "model");
    n.cli_engine_id = jstr(j, "cliEngineId", "auto");
    n.cli_model_source = jstr(j, "cliModelSource", "work") == "native" ? "native" : "work";
    n.cli_native_provider = jstr(j, "cliNativeProvider");
    n.cli_native_model = jstr(j, "cliNativeModel");
    n.requires_workspace = jbool(j,"requiresWorkspace");
    n.assignment_locked = jbool(j,"assignmentLocked");
    n.reasoning_effort = jstr(j, "reasoningEffort");
    n.read_only = jbool(j, "readOnly", false);
    n.prompt = jstr(j, "prompt");
    const auto cm = jstr(j, "contextMode", "handoff");
    n.context_mode = (cm == "full_chain" || cm == "template_only") ? cm : "handoff";
    n.include_memory = jbool(j, "includeMemory", false);
    n.ref_mode = jstr(j, "refMode", "text") == "file" ? "file" : "text";
    n.ref_text = jstr(j, "refText");
    n.file_path = jstr(j, "filePath");
    n.max_inline_chars = std::clamp(jint(j, "maxInlineChars", 12000), 500, 500000);
    n.force_full_text = jbool(j, "forceFullText", false);
    const auto cpm = jstr(j, "compressMode", "handoff_card");
    n.compress_mode = (cpm == "summary" || cpm == "custom") ? cpm : "handoff_card";
    n.max_output_chars = std::clamp(jint(j, "maxOutputChars", 2400), 200, 32000);
    const auto gm = jstr(j, "gateMode", "approval");
    if (gm == "auto_condition" || gm == "bool_switch" || gm == "logic_and" || gm == "logic_or") {
        n.gate_mode = gm;
    } else {
        n.gate_mode = "approval";
    }
    n.pass_keyword = jstr(j, "passKeyword", "PASS");
    n.fail_keyword = jstr(j, "failKeyword", "FAIL");
    n.max_iterations = std::clamp(jint(j, "maxIterations", 3), 1, 20);
    n.approval_hint = jstr(j, "approvalHint");
    n.bool_source = jstr(j, "boolSource", "auto") == "fixed" ? "fixed" : "auto";
    n.bool_value = jbool(j, "boolValue", true);
    n.invert_result = jbool(j, "invertResult", false);
    if (const auto* arr = j.find("conditionRules"); arr && arr->is_array()) {
        for (const auto& item : arr->as_array()) {
            if (item.is_object()) n.condition_rules.push_back(CanvasConditionRule::from_json(item));
        }
    }
    n.function_id = jstr(j, "functionId");
    n.param_note = jstr(j, "paramNote");
    const auto ak = jstr(j, "actionKind", "read_file");
    if (ak == "open_app" || ak == "open_url" || ak == "read_file" || ak == "fetch_url" || ak == "run_command") {
        n.action_kind = ak;
    } else {
        n.action_kind = "read_file";
    }
    n.action_target = jstr(j, "actionTarget");
    n.action_args = jstr(j, "actionArgs");
    n.action_timeout_sec = std::clamp(jint(j, "actionTimeoutSec", 30), 3, 300);
    return n;
}

Json CanvasEdge::to_json() const {
    return O{
        {"id", id},
        {"fromNodeId", from_node_id},
        {"fromPort", from_port},
        {"targetKind", target_kind},
        {"targetId", target_id},
        {"attachT", attach_t},
        {"wireKind", wire_kind},
        {"label", label}
    };
}

CanvasEdge CanvasEdge::from_json(const Json& j) {
    CanvasEdge e;
    e.id = sanitize_id(jstr(j, "id"), "edge");
    e.from_node_id = jstr(j, "fromNodeId");
    const auto fp = jstr(j, "fromPort", "out");
    e.from_port = (fp == "pass" || fp == "loop") ? fp : "out";
    e.target_kind = jstr(j, "targetKind", "node") == "edge" ? "edge" : "node";
    e.target_id = jstr(j, "targetId");
    e.attach_t = std::clamp(jnum(j, "attachT", 0.5), 0.15, 0.85);
    const auto wk = jstr(j, "wireKind", "main");
    if (e.target_kind == "edge") e.wire_kind = "supplement";
    else if (e.from_port == "loop" || wk == "feedback") e.wire_kind = "feedback";
    else e.wire_kind = "main";
    e.label = jstr(j, "label");
    return e;
}

Json CanvasGraph::to_json() const {
    A ns, es;
    for (const auto& n : nodes) ns.push_back(n.to_json());
    for (const auto& e : edges) es.push_back(e.to_json());
    return O{
        {"id", id},
        {"name", name},
        {"description", description},
        {"kind", kind},
        {"category", category},
        {"builtin", builtin},
        {"updatedAt", static_cast<double>(updated_at)},
        {"nodes", std::move(ns)},
        {"edges", std::move(es)}
    };
}

CanvasGraph CanvasGraph::from_json(const Json& j) {
    CanvasGraph g;
    g.id = sanitize_id(jstr(j, "id"), "canvas");
    g.name = trim_copy(jstr(j, "name", "未命名画布"));
    if (g.name.empty()) g.name = "未命名画布";
    g.description = jstr(j, "description");
    g.kind = jstr(j, "kind", "canvas") == "function" ? "function" : "canvas";
    g.category = jstr(j, "category");
    g.builtin = jbool(j, "builtin", false);
    g.updated_at = static_cast<std::int64_t>(jnum(j, "updatedAt", static_cast<double>(now_epoch_ms())));
    if (const auto* ns = j.find("nodes"); ns && ns->is_array()) {
        for (const auto& item : ns->as_array()) {
            if (item.is_object()) g.nodes.push_back(CanvasNode::from_json(item));
        }
    }
    if (const auto* es = j.find("edges"); es && es->is_array()) {
        for (const auto& item : es->as_array()) {
            if (item.is_object()) g.edges.push_back(CanvasEdge::from_json(item));
        }
    }
    return g;
}

// ============================================================================
// Pure Topology, Edge Attachment & Context Assembly Algorithms
// ============================================================================

std::string resolve_edge_host_node(const CanvasGraph& graph, const std::string& edge_id) {
    std::set<std::string> visited;
    std::string cur = edge_id;
    while (!cur.empty()) {
        if (!visited.insert(cur).second) return {};
        const auto* e = find_edge(graph, cur);
        if (!e) return {};
        if (e->target_kind == "node") return e->target_id;
        cur = e->target_id;
    }
    return {};
}

CanvasValidationResult validate_canvas_graph(const CanvasGraph& graph,
                                             const std::map<std::string, CanvasGraph>& functions) {
    CanvasValidationResult res;
    if (graph.nodes.empty()) {
        res.ok = false;
        res.error = "画布至少需要包含一个节点";
        return res;
    }
    std::set<std::string> node_ids;
    for (const auto& n : graph.nodes) {
        if (n.id.empty() || !node_ids.insert(n.id).second) {
            res.ok = false;
            res.error = "节点 ID 为空或重复：" + n.id;
            return res;
        }
    }
    std::set<std::string> edge_ids;
    for (const auto& e : graph.edges) {
        if (e.id.empty() || !edge_ids.insert(e.id).second) {
            res.ok = false;
            res.error = "连线 ID 为空或重复：" + e.id;
            return res;
        }
        if (!node_ids.contains(e.from_node_id)) {
            res.ok = false;
            res.error = "连线起点节点不存在：" + e.from_node_id;
            return res;
        }
        if (e.target_kind == "node") {
            if (!node_ids.contains(e.target_id)) {
                res.ok = false;
                res.error = "连线终点节点不存在：" + e.target_id;
                return res;
            }
            if (e.from_node_id == e.target_id && !is_feedback_edge(e)) {
                res.ok = false;
                res.error = "非闭环主干连线不能直接自环到自身节点";
                return res;
            }
        }
    }
    // Validate edge attachments and build forward adjacency for DAG cycle check
    std::map<std::string, std::vector<std::string>> fwd_adj;
    for (const auto& e : graph.edges) {
        if (e.target_kind == "edge") {
            if (!edge_ids.contains(e.target_id)) {
                res.ok = false;
                res.error = "附着支流指向的目标连线不存在：" + e.target_id;
                return res;
            }
            const std::string host = resolve_edge_host_node(graph, e.id);
            if (host.empty() || !node_ids.contains(host)) {
                res.ok = false;
                res.error = "检测到非法或循环的边附着支流：" + e.id;
                return res;
            }
            if (host == e.from_node_id) {
                res.ok = false;
                res.error = "附着支流不能附着在指向自身节点的连线上：" + e.id;
                return res;
            }
            fwd_adj[e.from_node_id].push_back(host);
        } else if (!is_feedback_edge(e)) {
            fwd_adj[e.from_node_id].push_back(e.target_id);
        }
    }

    // 3-color DFS cycle check on forward (non-feedback) edges
    std::map<std::string, int> color; // 0=unvisited, 1=visiting, 2=done
    std::function<bool(const std::string&)> dfs = [&](const std::string& u) -> bool {
        color[u] = 1;
        for (const auto& v : fwd_adj[u]) {
            const int c = color[v];
            if (c == 1) return false;
            if (c == 0 && !dfs(v)) return false;
        }
        color[u] = 2;
        return true;
    };
    for (const auto& n : graph.nodes) {
        if (color[n.id] == 0 && !dfs(n.id)) {
            res.ok = false;
            res.error = "正向主干/补充连线存在循环死锁；如需不满意后重做闭环，请从判断/确认步骤的「✗ / ↻」引脚拉回上游";
            return res;
        }
    }

    if (!functions.empty()) {
        std::vector<std::string> stack;
        if (graph.kind == "function") stack.push_back(graph.id);
        std::string fn_err;
        if (!check_function_recursion(graph, functions, stack, 0, fn_err)) {
            res.ok = false;
            res.error = fn_err;
            return res;
        }
    }
    return res;
}

std::vector<std::string> collect_forward_dependencies(const CanvasGraph& graph,
                                                      const std::string& target_node_id) {
    std::vector<std::string> deps;
    std::set<std::string> visited_edges;
    for (const auto& e : graph.edges) {
        if (is_feedback_edge(e)) continue;
        if (e.target_kind == "node" && e.target_id == target_node_id) {
            if (std::find(deps.begin(), deps.end(), e.from_node_id) == deps.end()) {
                deps.push_back(e.from_node_id);
            }
            // All tributary nodes attached onto edge (A -> B) are parallel dependencies of B!
            collect_edge_supplement_sources(graph, e.id, visited_edges, deps);
        }
    }
    return deps;
}

std::string assemble_canvas_node_context(const CanvasGraph& graph,
                                         const std::string& target_node_id,
                                         const std::string& flow_input,
                                         const std::map<std::string, std::string>& node_outputs,
                                         const std::map<std::string, std::vector<std::string>>& node_artifacts,
                                         const std::string& feedback_note,
                                         const std::string& prev_self_output,
                                         int iteration,
                                         int max_iterations) {
    const auto* self = find_node(graph, target_node_id);

    // 1. Render structured upstream handoff strictly following line rules:
    //    Main direct edges (A -> B) are primary payloads; edges attached onto (A -> B) are nested under A!
    std::ostringstream prev_ss;
    std::vector<const CanvasEdge*> main_incoming;
    for (const auto& e : graph.edges) {
        if (is_feedback_edge(e)) continue;
        if (e.target_kind == "node" && e.target_id == target_node_id) {
            main_incoming.push_back(&e);
        }
    }
    std::set<std::string> visited_supp_edges;
    for (const auto* me : main_incoming) {
        const auto* src_node = find_node(graph, me->from_node_id);
        const std::string src_title = (src_node && !src_node->title.empty()) ? src_node->title : me->from_node_id;
        prev_ss << "### 【主干上游交付】来自「" << src_title << "」"
                << (!me->label.empty() ? (" · " + me->label) : "") << "\n";
        if (const auto it = node_outputs.find(me->from_node_id); it != node_outputs.end() && !it->second.empty()) {
            prev_ss << it->second << "\n";
        } else {
            prev_ss << "（上游已完成，无额外正文输出）\n";
        }
        if (const auto ait = node_artifacts.find(me->from_node_id); ait != node_artifacts.end() && !ait->second.empty()) {
            prev_ss << "产出文件：";
            for (std::size_t i = 0; i < ait->second.size(); ++i) {
                if (i > 0) prev_ss << "、";
                prev_ss << ait->second[i];
            }
            prev_ss << "\n";
        }
        render_edge_supplements_markdown(graph, me->id, src_title, node_outputs, node_artifacts, 1, visited_supp_edges, prev_ss);
        prev_ss << "\n";
    }
    const std::string prev_block = trim_copy(prev_ss.str());

    // 2. Variable interpolation in node prompt
    std::string user_prompt = self ? self->prompt : std::string{};
    const bool prompt_used_prev = (user_prompt.find("{{prev}}") != std::string::npos);
    const bool prompt_used_input = (user_prompt.find("{{input}}") != std::string::npos);
    replace_all(user_prompt, "{{input}}", flow_input);
    replace_all(user_prompt, "{{prev}}", prev_block);
    replace_all(user_prompt, "{{feedback}}", feedback_note);
    for (const auto& [nid, out_txt] : node_outputs) {
        replace_all(user_prompt, "{{node:" + nid + "}}", out_txt);
        if (const auto* np = find_node(graph, nid); np && !np->title.empty()) {
            replace_all(user_prompt, "{{title:" + np->title + "}}", out_txt);
        }
    }

    if (self && self->context_mode == "template_only") {
        std::ostringstream tmpl_out;
        tmpl_out << user_prompt;
        if (!feedback_note.empty() && self->prompt.find("{{feedback}}") == std::string::npos) {
            tmpl_out << "\n\n【闭环反馈意见（第 " << iteration << "/" << std::max(1, max_iterations) << " 轮）】\n"
                     << feedback_note;
        }
        return trim_copy(tmpl_out.str());
    }

    std::ostringstream out;
    if (!flow_input.empty() && !prompt_used_input) {
        out << "【本轮原始总委托（不可篡改基准）】\n" << flow_input << "\n\n";
    }

    if (self && self->type == "compress") {
        out << "【信息压缩器任务】\n";
        if (self->compress_mode == "summary") {
            out << "请将下方上游交付与补充信息精炼为高密度要点摘要，保留所有关键结论、接口/文件路径与风险项，去除过程废话，总字数控制在 "
                << self->max_output_chars << " 字以内。\n";
        } else if (self->compress_mode == "handoff_card") {
            out << "请将下方上游内容压缩为标准【结构化交接单】，固定包含：1) 核心目标；2) 已完成成果与关键文件路径；3) 未决问题与风险；4) 下一节点执行建议。总字数控制在 "
                << self->max_output_chars << " 字以内。\n";
        }
        if (!user_prompt.empty()) out << "额外提取规则：" << user_prompt << "\n";
        out << "\n";
    } else if (!user_prompt.empty()) {
        out << "【本节点专属职责指令】\n" << user_prompt << "\n\n";
    }

    if (!prev_block.empty() && !prompt_used_prev) {
        out << "【按画布连线规则传入的上游上下文】\n" << prev_block << "\n\n";
    }

    if (self && self->context_mode == "full_chain") {
        // Attach compact index of earlier non-direct completed nodes in this graph
        std::set<std::string> direct_set;
        for (const auto& d : collect_forward_dependencies(graph, target_node_id)) direct_set.insert(d);
        std::ostringstream anc;
        for (const auto& n : graph.nodes) {
            if (n.id == target_node_id || direct_set.contains(n.id)) continue;
            if (const auto it = node_outputs.find(n.id); it != node_outputs.end() && !it->second.empty()) {
                std::string snippet = it->second;
                if (snippet.size() > 1200) snippet = snippet.substr(0, 1200) + "…（已按链路预算截断）";
                anc << "- [" << (n.title.empty() ? n.id : n.title) << "]：" << snippet << "\n";
            }
        }
        const std::string anc_str = trim_copy(anc.str());
        if (!anc_str.empty()) {
            out << "【更早链路节点参考摘要】\n" << anc_str << "\n\n";
        }
    }

    if (iteration > 1 || !feedback_note.empty()) {
        out << "【返工重做指令（第 " << iteration << "/" << std::max(1, max_iterations) << " 轮）】\n";
        if (!prev_self_output.empty()) {
            std::string prev_trim = prev_self_output;
            if (prev_trim.size() > 6000) prev_trim = prev_trim.substr(0, 6000) + "\n…（上一轮输出已截断）";
            out << "你上一轮的产出：\n" << prev_trim << "\n\n";
        }
        if (!feedback_note.empty()) {
            out << "本轮反馈 / 审校驳回意见（请针对性修复改进）：\n" << feedback_note << "\n";
        }
    }

    return trim_copy(out.str());
}

// ============================================================================
// UE Blueprint-style Collapse Selection to Function
// ============================================================================

CanvasCollapseResult collapse_nodes_to_blueprint_function(const CanvasGraph& canvas,
                                                          const std::vector<std::string>& selected_node_ids,
                                                          const std::string& function_name,
                                                          const std::string& function_description) {
    std::set<std::string> sel(selected_node_ids.begin(), selected_node_ids.end());
    if (sel.empty()) throw std::runtime_error("请先框选至少一个要封装的节点");

    std::vector<CanvasNode> inner_nodes;
    double sum_x = 0.0, sum_y = 0.0;
    double min_x = 1e9, min_y = 1e9;
    for (const auto& n : canvas.nodes) {
        if (!sel.contains(n.id)) continue;
        if (n.type == "input") {
            throw std::runtime_error("委托入口节点不能被折叠进子函数，请仅选择内部执行/资料/判断节点");
        }
        inner_nodes.push_back(n);
        sum_x += n.x;
        sum_y += n.y;
        min_x = std::min(min_x, n.x);
        min_y = std::min(min_y, n.y);
    }
    if (inner_nodes.empty()) throw std::runtime_error("未找到有效的已选节点");

    static std::atomic<std::uint64_t> g_collapse_seq{0};
    const std::string stamp = std::to_string(now_epoch_ms()) + "-" + std::to_string(++g_collapse_seq);
    const std::string fn_id = sanitize_id("fn-" + stamp, "fn");
    const std::string chip_id = sanitize_id("chip-" + stamp, "chip");

    // Create Blueprint Function graph with an explicit "In" entry node
    CanvasGraph fn;
    fn.id = fn_id;
    fn.name = trim_copy(function_name).empty() ? ("蓝图函数 " + stamp.substr(stamp.size() > 4 ? stamp.size() - 4 : 0)) : trim_copy(function_name);
    fn.description = function_description.empty() ? ("从画布「" + canvas.name + "」封装的可复用蓝图函数") : function_description;
    fn.kind = "function";
    fn.category = "自定义函数";
    fn.updated_at = now_epoch_ms();

    CanvasNode fn_in;
    fn_in.id = "fn-in";
    fn_in.type = "input";
    fn_in.title = "函数输入 In";
    fn_in.x = 60.0;
    fn_in.y = 160.0;
    fn.nodes.push_back(fn_in);

    for (auto n : inner_nodes) {
        n.x = std::max(280.0, n.x - min_x + 280.0);
        n.y = std::max(60.0, n.y - min_y + 80.0);
        fn.nodes.push_back(std::move(n));
    }

    // Build updated parent canvas with a single function_call chip replacing sel
    CanvasGraph updated = canvas;
    updated.updated_at = now_epoch_ms();
    updated.nodes.erase(
        std::remove_if(updated.nodes.begin(), updated.nodes.end(), [&](const CanvasNode& n) { return sel.contains(n.id); }),
        updated.nodes.end());

    CanvasNode chip;
    chip.id = chip_id;
    chip.type = "function_call";
    chip.title = fn.name;
    chip.function_id = fn.id;
    double chip_x = std::round(sum_x / static_cast<double>(inner_nodes.size()));
    double chip_y = std::round(sum_y / static_cast<double>(inner_nodes.size()));
    // Ensure collapsed Blueprint chip never overlaps upstream kept nodes
    double min_safe_x = chip_x;
    for (const auto& e : canvas.edges) {
        if (sel.contains(e.from_node_id)) continue;
        const std::string host = (e.target_kind == "node") ? e.target_id : resolve_edge_host_node(canvas, e.id);
        if (!host.empty() && sel.contains(host)) {
            if (const auto* up = find_node(canvas, e.from_node_id)) {
                min_safe_x = std::max(min_safe_x, up->x + 312.0);
            }
        }
    }
    // Also avoid colliding with any remaining non-selected node at close Y
    for (const auto& kept : updated.nodes) {
        if (std::abs(kept.y - chip_y) < 110.0 && std::abs(kept.x - min_safe_x) < 260.0) {
            min_safe_x = std::max(min_safe_x, kept.x + 312.0);
        }
    }
    chip.x = std::round(min_safe_x);
    chip.y = chip_y;
    updated.nodes.push_back(chip);

    // Partition edges:
    // - Completely internal (from in sel AND host in sel) -> move into fn
    // - External -> Internal -> rewire to chip in parent, and connect fn-in -> internal target inside fn
    // - Internal -> External -> rewire from chip in parent
    // - Completely external -> keep in parent
    std::vector<CanvasEdge> next_parent_edges;
    std::set<std::string> fn_in_targets;
    std::set<std::string> parent_in_dedup;
    std::set<std::string> parent_out_dedup;
    int fn_edge_seq = 1;

    for (const auto& e : canvas.edges) {
        const bool from_in = sel.contains(e.from_node_id);
        const std::string host = (e.target_kind == "node") ? e.target_id : resolve_edge_host_node(canvas, e.id);
        const bool to_in = !host.empty() && sel.contains(host);

        if (from_in && to_in) {
            fn.edges.push_back(e);
        } else if (!from_in && !to_in) {
            next_parent_edges.push_back(e);
        } else if (!from_in && to_in) {
            // External feeding into the collapsed region
            if (e.target_kind == "node") {
                const std::string dedup = e.from_node_id + "|" + e.from_port + "|" + e.wire_kind;
                if (parent_in_dedup.insert(dedup).second) {
                    CanvasEdge pe = e;
                    pe.target_id = chip_id;
                    next_parent_edges.push_back(std::move(pe));
                }
                if (!is_feedback_edge(e) && fn_in_targets.insert(e.target_id).second) {
                    CanvasEdge fe;
                    fe.id = "fne-" + std::to_string(fn_edge_seq++);
                    fe.from_node_id = "fn-in";
                    fe.from_port = "out";
                    fe.target_kind = "node";
                    fe.target_id = e.target_id;
                    fe.wire_kind = "main";
                    fn.edges.push_back(std::move(fe));
                }
            } else {
                // External supplement attached onto an internal edge: wire into chip in parent
                CanvasEdge pe = e;
                pe.target_kind = "node";
                pe.target_id = chip_id;
                pe.wire_kind = "main";
                next_parent_edges.push_back(std::move(pe));
            }
        } else {
            // Internal flowing out to external node/edge
            const std::string dedup = e.target_kind + "|" + e.target_id + "|" + e.wire_kind;
            if (parent_out_dedup.insert(dedup).second) {
                CanvasEdge pe = e;
                pe.from_node_id = chip_id;
                if (pe.from_port != "loop") pe.from_port = "out";
                next_parent_edges.push_back(std::move(pe));
            }
        }
    }

    // Ensure every entry node inside fn without internal forward incoming edges gets fed by fn-in
    // (skip standalone reference cards unless no other entry exists)
    for (const auto& n : fn.nodes) {
        if (n.id == "fn-in" || n.type == "reference") continue;
        const auto deps = collect_forward_dependencies(fn, n.id);
        if (deps.empty() && fn_in_targets.insert(n.id).second) {
            CanvasEdge fe;
            fe.id = "fne-" + std::to_string(fn_edge_seq++);
            fe.from_node_id = "fn-in";
            fe.from_port = "out";
            fe.target_kind = "node";
            fe.target_id = n.id;
            fe.wire_kind = "main";
            fn.edges.push_back(std::move(fe));
        }
    }

    updated.edges = std::move(next_parent_edges);

    CanvasCollapseResult out;
    out.updated_canvas = std::move(updated);
    out.created_function = std::move(fn);
    out.chip_node_id = chip_id;
    return out;
}

// ============================================================================
// Deterministic Circuit Execution Service
// ============================================================================

static std::string planned_canvas_route(const CanvasNode& n) {
    if (n.type!="agent" && n.type!="compress") return {};
    const bool native = n.engine_kind=="cli" && n.cli_model_source=="native";
    const auto& model = native ? n.cli_native_model : n.model;
    const auto& provider = native ? n.cli_native_provider : n.provider_id;
    return (n.engine_kind=="cli" ? n.cli_engine_id : "API") + std::string(" / ") +
        (provider.empty() ? "" : provider+" / ") + (model.empty() ? "默认模型" : model);
}
struct CanvasRuntimeService::RunRecord {
    std::string request_id;
    std::string run_id;
    std::string canvas_id;
    std::string canvas_name;
    std::string input_text;
    std::string workspace_dir;
    std::string bot_id;
    int gate_reviews = 0;
    int gate_rejections = 0;
    std::string review_work_run;
    std::string status = "running"; // "running" | "waiting_approval" | "completed" | "failed" | "cancelled"
    std::string error;
    std::string final_output;
    std::vector<std::string> final_artifacts;
    std::int64_t created_at = 0;
    std::int64_t updated_at = 0;
    std::int64_t finished_at = 0;

    struct NodeState {
        std::string key;                 // frame_prefix + node_id
        std::string frame_prefix;
        std::string node_id;
        std::string title;
        std::string type;
        std::string status = "pending";  // pending | running | waiting_approval | completed | failed | cancelled
        std::string output;
        std::string error;
        std::string progress_note;
        std::string model_label;
        std::string approval_hint;
        std::string planned_route;
        std::string gate_decision;       // "" | "pass" | "loop"
        std::vector<std::string> artifacts;
        int iteration = 0;
        int max_iterations = 1;
        std::int64_t started_at = 0;
        std::int64_t finished_at = 0;
    };

    struct PendingGateDecision {
        bool decided = false;
        bool approved = false;
        std::string comment;
    };

    mutable std::mutex mu;
    std::condition_variable_any cv;
    std::map<std::string, NodeState> nodes;
    std::map<std::string, int> loop_counts;      // frame_prefix + edge_id -> trigger count
    std::map<std::string, PendingGateDecision> gate_decisions;
    std::vector<std::string> active_edges;       // Currently pulsing edge keys for UI circuit animation
    std::vector<std::string> event_logs;
    std::jthread worker;

    Json to_json() const {
        std::lock_guard lk(mu);
        O nodes_obj;
        A waiting_gates;
        for (const auto& [k, ns] : nodes) {
            A arts;
            for (const auto& a : ns.artifacts) arts.push_back(a);
            O item{
                {"key", ns.key},
                {"framePrefix", ns.frame_prefix},
                {"nodeId", ns.node_id},
                {"title", ns.title},
                {"type", ns.type},
                {"status", ns.status},
                {"output", ns.output},
                {"error", ns.error},
                {"progressNote", ns.progress_note},
                {"modelLabel", ns.model_label}, {"plannedRoute", ns.planned_route},
                {"approvalHint", ns.approval_hint},
                {"gateDecision", ns.gate_decision},
                {"artifacts", std::move(arts)},
                {"iteration", static_cast<double>(ns.iteration)},
                {"maxIterations", static_cast<double>(ns.max_iterations)},
                {"startedAt", static_cast<double>(ns.started_at)},
                {"finishedAt", static_cast<double>(ns.finished_at)}
            };
            if (ns.status == "waiting_approval") {
                waiting_gates.push_back(item);
            }
            nodes_obj[k] = std::move(item);
        }
        O loops_obj;
        for (const auto& [ek, cnt] : loop_counts) loops_obj[ek] = static_cast<double>(cnt);
        A act_edges;
        for (const auto& ae : active_edges) act_edges.push_back(ae);
        A logs;
        for (const auto& l : event_logs) logs.push_back(l);
        A f_arts;
        for (const auto& fa : final_artifacts) f_arts.push_back(fa);

        return O{
            {"gateReviews",gate_reviews}, {"gateRejections",gate_rejections},
            {"requestId", request_id}, {"runId", run_id},
            {"canvasId", canvas_id},
            {"canvasName", canvas_name},
            {"inputText", input_text},
            {"workspaceDir", workspace_dir},
            {"botId", bot_id},
            {"status", status},
            {"error", error},
            {"finalOutput", final_output},
            {"finalArtifacts", std::move(f_arts)},
            {"createdAt", static_cast<double>(created_at)},
            {"updatedAt", static_cast<double>(updated_at)},
            {"finishedAt", static_cast<double>(finished_at)},
            {"nodes", std::move(nodes_obj)},
            {"waitingGates", std::move(waiting_gates)},
            {"loopCounts", std::move(loops_obj)},
            {"activeEdges", std::move(act_edges)},
            {"logs", std::move(logs)}
        };
    }

    void append_log_locked(const std::string& msg) {
        if (event_logs.size() >= 200) event_logs.erase(event_logs.begin());
        event_logs.push_back(msg);
        updated_at = now_epoch_ms();
    }
};

CanvasRuntimeService::CanvasRuntimeService(std::filesystem::path data_root, CanvasNodeExecutor executor)
    : data_root_(std::move(data_root)), executor_(std::move(executor)) {
    std::error_code ec;
    fs::create_directories(data_root_ / L"canvas-runs", ec);
    {
        std::lock_guard lk(lib_mutex_);
        load_library_locked();
        seed_builtin_templates_locked();
        persist_library_locked();
    }
    {
        std::lock_guard lk(runs_mutex_);
        load_recent_runs_locked();
    }
}

CanvasRuntimeService::~CanvasRuntimeService() {
    shutdown();
}

void CanvasRuntimeService::shutdown() {
    stopping_.store(true, std::memory_order_release);
    std::vector<std::shared_ptr<RunRecord>> all;
    {
        std::lock_guard lk(runs_mutex_);
        for (const auto& [_, r] : runs_) all.push_back(r);
    }
    for (auto& r : all) {
        {
            std::lock_guard lk(r->mu);
            r->cv.notify_all();
        }
        if (r->worker.joinable()) {
            r->worker.request_stop();
            r->worker.join();
        }
    }
}

void CanvasRuntimeService::load_library_locked() {
    const fs::path p = data_root_ / L"model-canvases.json";
    std::error_code ec;
    if (!fs::is_regular_file(p, ec)) return;
    try {
        std::ifstream in(p, std::ios::binary);
        std::string txt((std::istreambuf_iterator<char>(in)), {});
        const Json doc = Json::parse(txt);
        if (const auto* cs = doc.find("canvases"); cs && cs->is_array()) {
            for (const auto& item : cs->as_array()) {
                if (!item.is_object()) continue;
                auto g = CanvasGraph::from_json(item);
                g.kind = "canvas";
                canvases_[g.id] = std::move(g);
            }
        }
        if (const auto* fns = doc.find("functions"); fns && fns->is_array()) {
            for (const auto& item : fns->as_array()) {
                if (!item.is_object()) continue;
                auto g = CanvasGraph::from_json(item);
                g.kind = "function";
                functions_[g.id] = std::move(g);
            }
        }
    } catch (...) {}
}

void CanvasRuntimeService::persist_library_locked() const {
    A cs, fns;
    for (const auto& [_, g] : canvases_) cs.push_back(g.to_json());
    for (const auto& [_, g] : functions_) fns.push_back(g.to_json());
    const Json doc = O{
        {"version", 1.0},
        {"canvases", std::move(cs)},
        {"functions", std::move(fns)}
    };
    AtomicWriteOptions opts;
    opts.existing_root = data_root_;
    std::error_code ec;
    fs::create_directories(data_root_, ec);
    try {
        atomic_write_file(data_root_ / L"model-canvases.json", doc.dump(), opts);
    } catch (...) {}
}

void CanvasRuntimeService::seed_builtin_templates_locked() {
    const auto ts = now_epoch_ms();

    // Builtin Reusable Group 1: 自动编码与自检
    if (!functions_.contains("fn-craft-review-loop")) {
        CanvasGraph fn;
        fn.id = "fn-craft-review-loop";
        fn.name = "自动编码与自检";
        fn.description = "把「沙盒写代码 → 复核检查 → 未通过自动返工」打包好的常用组合步骤，可在任意流程里重复使用。";
        fn.kind = "function";
        fn.category = "常用组合";
        fn.builtin = true;
        fn.updated_at = ts;

        CanvasNode n_in; n_in.id = "fn-in"; n_in.type = "input"; n_in.title = "收到上游任务"; n_in.x = 40; n_in.y = 140;
        CanvasNode n_code; n_code.id = "fn-code"; n_code.type = "agent"; n_code.title = "让沙盒编码实现";
        n_code.bot_mode = "inline"; n_code.inline_name = "沙盒编码工匠";
        n_code.inline_persona = "严谨务实的高级全栈工程师，先读代码再动手，保证最小清晰改动与自测通过。";
        n_code.engine_kind = "cli"; n_code.cli_engine_id = "auto"; n_code.cli_model_source = "work";
        n_code.prompt = "请严格按方案完成代码实现与验证，并在结尾列出修改的文件与验证结果。";
        n_code.x = 350; n_code.y = 140;

        CanvasNode n_std; n_std.id = "fn-std"; n_std.type = "reference"; n_std.title = "读取检查标准.txt";
        n_std.ref_mode = "text";
        n_std.ref_text = "1. 不得遗漏错误处理与边界条件；\n2. 严禁修改无关文件或引入明文密钥；\n3. 结论必须以 [PASS] 或 [FAIL] 明确标注。";
        n_std.x = 490; n_std.y = 320;

        CanvasNode n_rev; n_rev.id = "fn-rev"; n_rev.type = "agent"; n_rev.title = "让伙伴复核检查";
        n_rev.bot_mode = "inline"; n_rev.inline_name = "代码审校官";
        n_rev.inline_persona = "挑剔冷静的 Principal Reviewer，专注逻辑漏洞、边界隐患与规范一致性。";
        n_rev.engine_kind = "api"; n_rev.read_only = true;
        n_rev.prompt = "逐项核验上游编码实现与补充检查标准。若达标请输出 [PASS] 与验收总结；若有问题请输出 [FAIL] 并逐条列出需修复点。";
        n_rev.x = 670; n_rev.y = 140;

        CanvasNode n_gate; n_gate.id = "fn-gate"; n_gate.type = "gate"; n_gate.title = "自动检查是否通过";
        n_gate.gate_mode = "auto_condition"; n_gate.pass_keyword = "PASS"; n_gate.fail_keyword = "FAIL";
        n_gate.max_iterations = 3;
        n_gate.x = 990; n_gate.y = 140;

        fn.nodes = {n_in, n_code, n_std, n_rev, n_gate};
        fn.edges = {
            {"fe1", "fn-in", "out", "node", "fn-code", 0.5, "main", "任务要求"},
            {"fe2", "fn-code", "out", "node", "fn-rev", 0.5, "main", "完成结果"},
            {"fe3", "fn-std", "out", "edge", "fe2", 0.56, "supplement", "顺带补充标准"},
            {"fe4", "fn-rev", "out", "node", "fn-gate", 0.5, "main", "检查结论"},
            {"fe5", "fn-gate", "loop", "node", "fn-code", 0.5, "feedback", "未通过自动重做"}
        };
        functions_[fn.id] = std::move(fn);
    }

    // Builtin Reusable Group 2: 提炼与整理汇报
    if (!functions_.contains("fn-brief-polish")) {
        CanvasGraph fn;
        fn.id = "fn-brief-polish";
        fn.name = "整理压缩与汇总汇报";
        fn.description = "先把冗长过程提炼成精简要点，再由伙伴整理成通俗清晰的最终汇报。";
        fn.kind = "function";
        fn.category = "常用组合";
        fn.builtin = true;
        fn.updated_at = ts;

        CanvasNode n_in; n_in.id = "fn-in"; n_in.type = "input"; n_in.title = "收到原始资料"; n_in.x = 60; n_in.y = 160;
        CanvasNode n_cmp; n_cmp.id = "fn-cmp"; n_cmp.type = "compress"; n_cmp.title = "提炼核心要点";
        n_cmp.compress_mode = "handoff_card"; n_cmp.max_output_chars = 1800; n_cmp.x = 360; n_cmp.y = 160;
        CanvasNode n_pol; n_pol.id = "fn-pol"; n_pol.type = "agent"; n_pol.title = "整理最终汇报";
        n_pol.bot_mode = "inline"; n_pol.inline_name = "交付汇总官";
        n_pol.inline_persona = "表达清晰干练的技术文档编辑，擅长将进展整理成条理分明的大白话汇报。";
        n_pol.engine_kind = "api"; n_pol.read_only = true;
        n_pol.prompt = "基于上游提炼好的要点，输出最终清晰的交付总结（包含成果、文件清单与下一步建议）。";
        n_pol.x = 670; n_pol.y = 160;

        fn.nodes = {n_in, n_cmp, n_pol};
        fn.edges = {
            {"fp1", "fn-in", "out", "node", "fn-cmp", 0.5, "main", "下一步"},
            {"fp2", "fn-cmp", "out", "node", "fn-pol", 0.5, "main", "精简要点"}
        };
        functions_[fn.id] = std::move(fn);
    }

    // Builtin DimensionImage 0 (Default): 打开资料与获取信息自动化工作流
    if (!canvases_.contains("tpl-action-info-flow")) {
        CanvasGraph c;
        c.id = "tpl-action-info-flow";
        c.name = "打开资料与获取信息工作流";
        c.description = "DimensionImage 直观示范：读取本地文件/目录 + 并行顺带补充文档与网页信息 → 整理要点 → 伙伴生成报告 → 等我确认（不满意重做）→ 自动打开结果网页/软件。";
        c.kind = "canvas";
        c.category = "日常自动化";
        c.builtin = true;
        c.updated_at = ts;

        CanvasNode n_in; n_in.id = "a-in"; n_in.type = "input"; n_in.title = "开始任务"; n_in.x = 40; n_in.y = 140;
        CanvasNode n_read; n_read.id = "a-read"; n_read.type = "action"; n_read.title = "读取项目目录/文件";
        n_read.action_kind = "read_file"; n_read.action_target = ""; n_read.x = 340; n_read.y = 140;

        CanvasNode n_ref; n_ref.id = "a-ref"; n_ref.type = "reference"; n_ref.title = "补充背景说明.txt";
        n_ref.ref_mode = "text";
        n_ref.ref_text = "请重点提炼目录结构、核心功能亮点与待优化项，用通俗易懂的要点呈现。";
        n_ref.x = 450; n_ref.y = 330;

        CanvasNode n_cmp; n_cmp.id = "a-cmp"; n_cmp.type = "compress"; n_cmp.title = "提炼整理信息";
        n_cmp.compress_mode = "handoff_card"; n_cmp.max_output_chars = 2200; n_cmp.x = 670; n_cmp.y = 140;

        CanvasNode n_bot; n_bot.id = "a-bot"; n_bot.type = "agent"; n_bot.title = "让伙伴生成结论";
        n_bot.bot_mode = "existing"; n_bot.bot_id = "ai-claude"; n_bot.engine_kind = "api"; n_bot.read_only = true;
        n_bot.prompt = "根据读取到的项目信息与顺带补充的背景要求，输出一份清晰易读的分析与执行建议。";
        n_bot.x = 990; n_bot.y = 140;

        CanvasNode n_gate; n_gate.id = "a-gate"; n_gate.type = "gate"; n_gate.title = "等我确认成果";
        n_gate.gate_mode = "approval"; n_gate.max_iterations = 4;
        n_gate.approval_hint = "查看伙伴整理好的成果：满意点「通过继续」，不满意写下意见点「重做」让伙伴修改。";
        n_gate.x = 1310; n_gate.y = 140;

        CanvasNode n_open; n_open.id = "a-open"; n_open.type = "action"; n_open.title = "打开项目文件夹";
        n_open.action_kind = "open_app"; n_open.action_target = ""; n_open.x = 1630; n_open.y = 140;

        c.nodes = {n_in, n_read, n_ref, n_cmp, n_bot, n_gate, n_open};
        c.edges = {
            {"ae1", "a-in", "out", "node", "a-read", 0.5, "main", "任务目标"},
            {"ae2", "a-read", "out", "node", "a-cmp", 0.5, "main", "读取到的信息"},
            {"ae3", "a-ref", "out", "edge", "ae2", 0.56, "supplement", "顺带补充说明"},
            {"ae4", "a-cmp", "out", "node", "a-bot", 0.5, "main", "精简要点"},
            {"ae5", "a-bot", "out", "node", "a-gate", 0.5, "main", "成果初稿"},
            {"ae6", "a-gate", "loop", "node", "a-bot", 0.5, "feedback", "不满意重做"},
            {"ae7", "a-gate", "pass", "node", "a-open", 0.5, "main", "确认后打开"}
        };
        canvases_[c.id] = std::move(c);
    }

    // Builtin DimensionImage 1: 研发交付全流程（顺带补充 + 人工确认重做 + 组合步骤复用）
    if (!canvases_.contains("tpl-engineering-circuit")) {
        CanvasGraph c;
        c.id = "tpl-engineering-circuit";
        c.name = "标准研发交付流程";
        c.description = "包含「读取项目约定（顺带补充）→ 让伙伴出方案 → 等我确认（不满意重做）→ 组合步骤自动编码自检 → 组合步骤汇总汇报」完整示范。";
        c.kind = "canvas";
        c.category = "工程研发";
        c.builtin = true;
        c.updated_at = ts;

        CanvasNode n_in; n_in.id = "n-in"; n_in.type = "input"; n_in.title = "开始任务"; n_in.x = 40; n_in.y = 140;
        CanvasNode n_ref; n_ref.id = "n-ref"; n_ref.type = "reference"; n_ref.title = "读取项目约定.txt";
        n_ref.ref_mode = "text";
        n_ref.ref_text = "技术栈约束：保持增量改动、遵循既有代码风格、不破坏向后兼容。";
        n_ref.x = 170; n_ref.y = 330;

        CanvasNode n_arch; n_arch.id = "n-arch"; n_arch.type = "agent"; n_arch.title = "让伙伴出实现方案";
        n_arch.bot_mode = "existing"; n_arch.bot_id = "ai-claude"; n_arch.engine_kind = "api"; n_arch.read_only = true;
        n_arch.prompt = "请结合需求与补充约定，输出清晰可执行的实现方案（涉及文件、核心数据结构、风险点与测试计划）。";
        n_arch.x = 350; n_arch.y = 140;

        CanvasNode n_gate; n_gate.id = "n-gate"; n_gate.type = "gate"; n_gate.title = "等我确认方案";
        n_gate.gate_mode = "approval"; n_gate.max_iterations = 5;
        n_gate.approval_hint = "请确认实现方案是否满足预期；点「通过」进入自动编码组合步骤，点「不满意重做」打回修改。";
        n_gate.x = 670; n_gate.y = 140;

        CanvasNode n_fn; n_fn.id = "n-fn"; n_fn.type = "function_call"; n_fn.title = "自动编码与自检";
        n_fn.function_id = "fn-craft-review-loop";
        n_fn.param_note = "严格按照确认后的方案在沙盒内执行编码与自检。";
        n_fn.x = 990; n_fn.y = 140;

        CanvasNode n_out; n_out.id = "n-out"; n_out.type = "function_call"; n_out.title = "整理压缩与汇总汇报";
        n_out.function_id = "fn-brief-polish";
        n_out.x = 1310; n_out.y = 140;

        c.nodes = {n_in, n_ref, n_arch, n_gate, n_fn, n_out};
        c.edges = {
            {"e1", "n-in", "out", "node", "n-arch", 0.5, "main", "原始需求"},
            {"e2", "n-ref", "out", "edge", "e1", 0.58, "supplement", "顺带补充约定"},
            {"e3", "n-arch", "out", "node", "n-gate", 0.5, "main", "实现方案"},
            {"e4", "n-gate", "loop", "node", "n-arch", 0.5, "feedback", "不满意重做"},
            {"e5", "n-gate", "pass", "node", "n-fn", 0.5, "main", "确认放行"},
            {"e6", "n-fn", "out", "node", "n-out", 0.5, "main", "验收成果"}
        };
        canvases_[c.id] = std::move(c);
    }

    // Builtin DimensionImage 2: 双路并行顺带补充与定稿
    if (!canvases_.contains("tpl-parallel-supplement")) {
        CanvasGraph c;
        c.id = "tpl-parallel-supplement";
        c.name = "双路并行补充与定稿";
        c.description = "清晰演示「A 走主线交给下游，C 挂在 A 的连线上并行执行并顺带补充信息」+ 提炼整理 + 最终定稿。";
        c.kind = "canvas";
        c.category = "协同范式";
        c.builtin = true;
        c.updated_at = ts;

        CanvasNode n_in; n_in.id = "p-in"; n_in.type = "input"; n_in.title = "开始任务"; n_in.x = 40; n_in.y = 160;
        CanvasNode n_a; n_a.id = "p-a"; n_a.type = "agent"; n_a.title = "主方案推演 (A)";
        n_a.bot_mode = "existing"; n_a.bot_id = "ai-claude"; n_a.engine_kind = "api"; n_a.read_only = true;
        n_a.prompt = "围绕用户需求提出主攻方案与核心步骤。";
        n_a.x = 340; n_a.y = 90;

        CanvasNode n_c; n_c.id = "p-c"; n_c.type = "agent"; n_c.title = "风险与背景补充 (C)";
        n_c.bot_mode = "existing"; n_c.bot_id = "ai-deepseek"; n_c.engine_kind = "api"; n_c.read_only = true;
        n_c.prompt = "与主方案同时运行，专门补充常见踩坑、边界约束与注意事项。";
        n_c.x = 430; n_c.y = 320;

        CanvasNode n_cmp; n_cmp.id = "p-cmp"; n_cmp.type = "compress"; n_cmp.title = "汇合提炼整理";
        n_cmp.compress_mode = "handoff_card"; n_cmp.max_output_chars = 2200;
        n_cmp.x = 680; n_cmp.y = 150;

        CanvasNode n_b; n_b.id = "p-b"; n_b.type = "agent"; n_b.title = "汇总定稿 (B)";
        n_b.bot_mode = "existing"; n_b.bot_id = "ai-gemini"; n_b.engine_kind = "api"; n_b.read_only = true;
        n_b.prompt = "吸收主方案 A 与顺带补充的 C 信息，产出最终落地结论。";
        n_b.x = 1000; n_b.y = 150;

        c.nodes = {n_in, n_a, n_c, n_cmp, n_b};
        c.edges = {
            {"pe1", "p-in", "out", "node", "p-a", 0.5, "main", ""},
            {"pe2", "p-in", "out", "node", "p-c", 0.5, "main", ""},
            {"pe3", "p-a", "out", "node", "p-cmp", 0.5, "main", "主线 A"},
            {"pe4", "p-c", "out", "edge", "pe3", 0.55, "supplement", "顺带补充 A"},
            {"pe5", "p-cmp", "out", "node", "p-b", 0.5, "main", "整理要点"}
        };
        canvases_[c.id] = std::move(c);
    }

    // Builtin DimensionImage 3: 读设定 + 人工拍板反复精修
    if (!canvases_.contains("tpl-creative-loop")) {
        CanvasGraph c;
        c.id = "tpl-creative-loop";
        c.name = "读资料参考 + 人工拍板精修";
        c.description = "读取 `.txt` 资料为初稿顺带补充设定，经挑刺审稿与人工确认反复打磨直到满意。";
        c.kind = "canvas";
        c.category = "内容共创";
        c.builtin = true;
        c.updated_at = ts;

        CanvasNode n_in; n_in.id = "c-in"; n_in.type = "input"; n_in.title = "输入创作主题"; n_in.x = 40; n_in.y = 160;
        CanvasNode n_txt; n_txt.id = "c-txt"; n_txt.type = "reference"; n_txt.title = "读取设定与文风.txt";
        n_txt.ref_mode = "text";
        n_txt.ref_text = "文风要求：克制细腻、画面感强、避免空泛抒情和套话；人物对话自然有个性。";
        n_txt.x = 160; n_txt.y = 340;

        CanvasNode n_wr; n_wr.id = "c-wr"; n_wr.type = "agent"; n_wr.title = "让主笔撰写初稿";
        n_wr.bot_mode = "inline"; n_wr.inline_name = "主笔写手";
        n_wr.inline_persona = "擅长叙事节奏与细节描写的资深创作者。";
        n_wr.engine_kind = "api"; n_wr.read_only = true;
        n_wr.prompt = "结合主题与顺带补充的文风设定完成高质量成稿；若收到修改意见请逐条精修。";
        n_wr.x = 340; n_wr.y = 160;

        CanvasNode n_ed; n_ed.id = "c-ed"; n_ed.type = "agent"; n_ed.title = "让编辑挑刺审稿";
        n_ed.bot_mode = "inline"; n_ed.inline_name = "毒舌审稿编辑";
        n_ed.inline_persona = "直言不讳、眼里揉不得沙子的资深文学编辑。";
        n_ed.engine_kind = "api"; n_ed.read_only = true;
        n_ed.prompt = "指出初稿的逻辑硬伤、节奏拖沓处与具体改写建议，附带一份亮点清单。";
        n_ed.x = 660; n_ed.y = 160;

        CanvasNode n_gate; n_gate.id = "c-gate"; n_gate.type = "gate"; n_gate.title = "等我最终拍板";
        n_gate.gate_mode = "approval"; n_gate.max_iterations = 6;
        n_gate.approval_hint = "对照审稿意见决定：点「通过」直接定稿，点「不满意重做」可附修改意见让主笔再改一版！";
        n_gate.x = 980; n_gate.y = 160;

        c.nodes = {n_in, n_txt, n_wr, n_ed, n_gate};
        c.edges = {
            {"ce1", "c-in", "out", "node", "c-wr", 0.5, "main", "主题"},
            {"ce2", "c-txt", "out", "edge", "ce1", 0.5, "supplement", "顺带补充设定"},
            {"ce3", "c-wr", "out", "node", "c-ed", 0.5, "main", "成稿"},
            {"ce4", "c-ed", "out", "node", "c-gate", 0.5, "main", "审稿意见"},
            {"ce5", "c-gate", "loop", "node", "c-wr", 0.5, "feedback", "不满意重做"}
        };
        canvases_[c.id] = std::move(c);
    }

    // Builtin DimensionImage 4: 布尔值 + 和(AND) / 或(OR) 逻辑条件分流示范
    if (!canvases_.contains("tpl-logic-branch")) {
        CanvasGraph c;
        c.id = "tpl-logic-branch";
        c.name = "布尔值 + 和/或 条件分流示范";
        c.description = "直观示范「布尔开关（真/假）」「全部满足（和 / AND）」「任一满足（或 / OR）」如何控制满足与不满足双路分支。";
        c.kind = "canvas";
        c.category = "条件逻辑";
        c.builtin = true;
        c.updated_at = ts;

        CanvasNode b1; b1.id = "lb-1"; b1.type = "gate"; b1.title = "布尔开关 A（条件 1）";
        b1.gate_mode = "bool_switch"; b1.bool_source = "fixed"; b1.bool_value = true; b1.x = 40; b1.y = 80;

        CanvasNode b2; b2.id = "lb-2"; b2.type = "gate"; b2.title = "布尔开关 B（条件 2）";
        b2.gate_mode = "bool_switch"; b2.bool_source = "fixed"; b2.bool_value = false; b2.x = 40; b2.y = 260;

        CanvasNode g_or; g_or.id = "lb-or"; g_or.type = "gate"; g_or.title = "或条件（A 或 B 为真）";
        g_or.gate_mode = "logic_or"; g_or.x = 360; g_or.y = 80;

        CanvasNode g_and; g_and.id = "lb-and"; g_and.type = "gate"; g_and.title = "和条件（全部满足）";
        g_and.gate_mode = "logic_and";
        g_and.condition_rules = {{"not_empty", ""}, {"is_true", ""}};
        g_and.x = 680; g_and.y = 80;

        CanvasNode ok_act; ok_act.id = "lb-ok"; ok_act.type = "action"; ok_act.title = "满足时：读取当前目录";
        ok_act.action_kind = "read_file"; ok_act.action_target = ""; ok_act.x = 1000; ok_act.y = 60;

        CanvasNode else_ref; else_ref.id = "lb-else"; else_ref.type = "reference"; else_ref.title = "不满足时：提示说明";
        else_ref.ref_mode = "text"; else_ref.ref_text = "逻辑条件未满足，已自动走备用分支。"; else_ref.x = 1000; else_ref.y = 250;

        c.nodes = {b1, b2, g_or, g_and, ok_act, else_ref};
        c.edges = {
            {"le1", "lb-1", "pass", "node", "lb-or", 0.5, "main", "信号 A"},
            {"le2", "lb-2", "pass", "node", "lb-or", 0.5, "main", "信号 B"},
            {"le3", "lb-or", "pass", "node", "lb-and", 0.5, "main", "任一为真"},
            {"le4", "lb-and", "pass", "node", "lb-ok", 0.5, "main", "✓ 满足执行"},
            {"le5", "lb-and", "loop", "node", "lb-else", 0.5, "feedback", "✗ 不满足分支"}
        };
        canvases_[c.id] = std::move(c);
    }
}

void CanvasRuntimeService::load_recent_runs_locked() {
    const fs::path dir = data_root_ / L"canvas-runs";
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return;
    for (const auto& ent : fs::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!ent.is_regular_file(ec) || ent.path().extension() != L".json") continue;
        try {
            std::ifstream in(ent.path(), std::ios::binary);
            std::string txt((std::istreambuf_iterator<char>(in)), {});
            const Json doc = Json::parse(txt);
            auto r = std::make_shared<RunRecord>();
            r->run_id = jstr(doc, "runId");
            if (r->run_id.empty()) continue;
            r->canvas_id = jstr(doc, "canvasId");
            r->canvas_name = jstr(doc, "canvasName");
            r->input_text = jstr(doc, "inputText");
            r->workspace_dir = jstr(doc, "workspaceDir");
            r->bot_id = jstr(doc, "botId");
            r->gate_reviews = static_cast<int>(jnum(doc,"gateReviews",-1));
            r->gate_rejections = static_cast<int>(jnum(doc,"gateRejections",-1));
            r->status = jstr(doc, "status", "cancelled");
            // Any previously in-flight run after a restart is marked interrupted cleanly
            if (r->status == "running" || r->status == "waiting_approval") {
                r->status = "cancelled";
                r->error = "服务重启，上次未完成的蓝图流程已安全中止";
            }
            r->error = jstr(doc, "error", r->error);
            r->final_output = jstr(doc, "finalOutput");
            r->created_at = static_cast<std::int64_t>(jnum(doc, "createdAt"));
            r->updated_at = static_cast<std::int64_t>(jnum(doc, "updatedAt"));
            r->finished_at = static_cast<std::int64_t>(jnum(doc, "finishedAt"));
            if (const auto* nd = doc.find("nodes"); nd && nd->is_object()) {
                for (const auto& [k, nv] : nd->as_object()) {
                    if (!nv.is_object()) continue;
                    RunRecord::NodeState ns;
                    ns.key = jstr(nv, "key", k);
                    ns.frame_prefix = jstr(nv, "framePrefix");
                    ns.node_id = jstr(nv, "nodeId");
                    ns.title = jstr(nv, "title");
                    ns.type = jstr(nv, "type");
                    ns.status = jstr(nv, "status", "pending");
                    ns.output = jstr(nv, "output");
                    ns.error = jstr(nv, "error");
                    ns.model_label = jstr(nv, "modelLabel");
                    ns.planned_route = jstr(nv,"plannedRoute");
                    ns.iteration = jint(nv, "iteration", 0);
                    ns.max_iterations = jint(nv, "maxIterations", 1);
                    r->nodes[k] = std::move(ns);
                }
            }
            r->request_id = jstr(doc, "requestId");
            if (!r->request_id.empty()) request_runs_[r->request_id] = r->run_id;
            runs_[r->run_id] = std::move(r);
        } catch (...) {}
    }
}

void CanvasRuntimeService::persist_run(const RunRecord& rec) const {
    const fs::path dir = data_root_ / L"canvas-runs";
    std::error_code ec;
    fs::create_directories(dir, ec);
    AtomicWriteOptions opts;
    opts.existing_root = dir;
    try {
        atomic_write_file(dir / (sanitize_id(rec.run_id, "run") + ".json"), rec.to_json().dump(), opts);
    } catch (...) {}
}

Json CanvasRuntimeService::list_library() const {
    std::lock_guard lk(lib_mutex_);
    A cs, fns;
    for (const auto& [_, g] : canvases_) cs.push_back(g.to_json());
    for (const auto& [_, g] : functions_) fns.push_back(g.to_json());
    return O{
        {"ok", true},
        {"canvases", std::move(cs)},
        {"functions", std::move(fns)}
    };
}

CanvasGraph CanvasRuntimeService::get_graph(const std::string& id) const {
    std::lock_guard lk(lib_mutex_);
    if (const auto it = canvases_.find(id); it != canvases_.end()) return it->second;
    if (const auto it = functions_.find(id); it != functions_.end()) return it->second;
    throw std::runtime_error("未找到画布或蓝图函数：" + id);
}

CanvasGraph CanvasRuntimeService::save_graph(const CanvasGraph& incoming, bool generated) {
    CanvasGraph g = incoming;
    if (g.id.empty()) g.id = sanitize_id((g.kind == "function" ? "fn-" : "canvas-") + std::to_string(now_epoch_ms()), "canvas");
    g.updated_at = now_epoch_ms();

    std::lock_guard lk(lib_mutex_);
    if (const auto prior=canvases_.find(g.id); generated && prior!=canvases_.end()) {
        for (const auto& old : prior->second.nodes) {
            if (!old.assignment_locked) continue;
            auto next=std::find_if(g.nodes.begin(),g.nodes.end(),[&](const CanvasNode& n){return n.id==old.id;});
            if (next==g.nodes.end() || next->type!=old.type || next->prompt!=old.prompt || next->bot_id!=old.bot_id ||
                next->engine_kind!=old.engine_kind || next->cli_model_source!=old.cli_model_source ||
                next->cli_engine_id!=old.cli_engine_id || next->cli_native_provider!=old.cli_native_provider ||
                next->cli_native_model!=old.cli_native_model || next->provider_id!=old.provider_id || next->model!=old.model)
                throw std::runtime_error("重新分配与已锁定节点「"+old.title+"」冲突。原蓝图已保留，请调整或解锁该节点后重新确认。");
            next->assignment_locked=true;
        }
    }
    auto fns_preview = functions_;
    if (g.kind == "function") fns_preview[g.id] = g;
    const auto v = validate_canvas_graph(g, fns_preview);
    if (!v.ok) throw std::runtime_error(v.error);

    if (g.kind == "function") functions_[g.id] = g;
    else canvases_[g.id] = g;
    persist_library_locked();
    return g;
}

void CanvasRuntimeService::delete_graph(const std::string& id) {
    std::lock_guard lk(lib_mutex_);
    if (const auto it = canvases_.find(id); it != canvases_.end()) {
        canvases_.erase(it);
        persist_library_locked();
        return;
    }
    if (const auto it = functions_.find(id); it != functions_.end()) {
        // Ensure no canvas or other function still references this function
        for (const auto& [cid, cg] : canvases_) {
            for (const auto& n : cg.nodes) {
                if (n.type == "function_call" && n.function_id == id) {
                    throw std::runtime_error("蓝图函数仍被画布「" + cg.name + "」引用，请先移除引用芯片再删除");
                }
            }
        }
        for (const auto& [fid, fg] : functions_) {
            if (fid == id) continue;
            for (const auto& n : fg.nodes) {
                if (n.type == "function_call" && n.function_id == id) {
                    throw std::runtime_error("蓝图函数仍被函数「" + fg.name + "」引用，请先移除引用后再删除");
                }
            }
        }
        functions_.erase(it);
        persist_library_locked();
        return;
    }
    throw std::runtime_error("未找到要删除的画布或函数：" + id);
}

CanvasCollapseResult CanvasRuntimeService::collapse_to_function(const std::string& canvas_id,
                                                                const std::vector<std::string>& selected_node_ids,
                                                                const std::string& function_name,
                                                                const std::string& function_description) {
    std::lock_guard lk(lib_mutex_);
    const bool is_fn_parent = functions_.contains(canvas_id);
    const CanvasGraph* src = is_fn_parent
        ? &functions_.at(canvas_id)
        : (canvases_.contains(canvas_id) ? &canvases_.at(canvas_id) : nullptr);
    if (!src) throw std::runtime_error("未找到目标画布或蓝图函数：" + canvas_id);

    auto collapsed = collapse_nodes_to_blueprint_function(*src, selected_node_ids, function_name, function_description);
    auto fns_preview = functions_;
    fns_preview[collapsed.created_function.id] = collapsed.created_function;
    if (is_fn_parent) fns_preview[collapsed.updated_canvas.id] = collapsed.updated_canvas;

    const auto v1 = validate_canvas_graph(collapsed.created_function, fns_preview);
    if (!v1.ok) throw std::runtime_error("封装后的蓝图函数校验失败：" + v1.error);
    const auto v2 = validate_canvas_graph(collapsed.updated_canvas, fns_preview);
    if (!v2.ok) throw std::runtime_error("更新后的主画布校验失败：" + v2.error);

    functions_[collapsed.created_function.id] = collapsed.created_function;
    if (is_fn_parent) functions_[collapsed.updated_canvas.id] = collapsed.updated_canvas;
    else canvases_[collapsed.updated_canvas.id] = collapsed.updated_canvas;
    persist_library_locked();
    return collapsed;
}

Json CanvasRuntimeService::start_run(const CanvasRunStartRequest& req) {
    CanvasGraph graph;
    std::map<std::string, CanvasGraph> fn_snapshot;
    {
        std::lock_guard lk(lib_mutex_);
        const auto it = canvases_.find(req.canvas_id);
        if (it == canvases_.end()) throw std::runtime_error("未找到要运行的画布：" + req.canvas_id);
        graph = it->second;
        fn_snapshot = functions_;
    }
    const auto valid = validate_canvas_graph(graph, fn_snapshot);
    if (!valid.ok) throw std::runtime_error("画布校验失败：" + valid.error);

    static std::atomic<std::uint64_t> g_run_seq{0};
    auto rec = std::make_shared<RunRecord>();
    rec->run_id = "crun-" + std::to_string(now_epoch_ms()) + "-" + std::to_string(++g_run_seq);
    rec->request_id = req.request_id;
    rec->review_work_run = req.review_work_run;
    rec->canvas_id = graph.id;
    rec->canvas_name = graph.name;
    rec->input_text = req.input_text;
    rec->workspace_dir = req.workspace_dir;
    rec->bot_id = req.bot_id;
    rec->status = "running";
    rec->created_at = now_epoch_ms();
    rec->updated_at = rec->created_at;

    {
        std::lock_guard lk(rec->mu);
        for (const auto& n : graph.nodes) {
            RunRecord::NodeState ns;
            ns.key = n.id;
            ns.node_id = n.id;
            ns.title = n.title.empty() ? n.id : n.title;
            ns.type = n.type;
            ns.max_iterations = n.max_iterations;
            ns.planned_route = planned_canvas_route(n); ns.approval_hint = n.approval_hint;
            rec->nodes[ns.key] = std::move(ns);
        }
        rec->append_log_locked("流程启动：「" + graph.name + "」");
    }

    {
        std::lock_guard lk(runs_mutex_);
        if (!req.request_id.empty()) {
            auto [it, inserted] = request_runs_.emplace(req.request_id, rec->run_id);
            if (!inserted) {
                const auto& prior = runs_.at(it->second);
                if (prior->canvas_id != req.canvas_id || prior->input_text != req.input_text ||
                    prior->workspace_dir != req.workspace_dir || prior->bot_id != req.bot_id)
                    throw std::runtime_error("请求编号已用于其他画布任务");
                return prior->to_json();
            }
        }
        runs_[rec->run_id] = rec;
    }
    persist_run(*rec);

    rec->worker = std::jthread([this, rec, graph = std::move(graph), fn_snapshot = std::move(fn_snapshot)](std::stop_token st) {
        std::string final_text;
        std::vector<std::string> final_arts;
        bool ok = false;
        try {
            ok = execute_graph_frame(rec, graph, fn_snapshot, "", rec->input_text, 0, final_text, final_arts, st);
        } catch (const std::exception& ex) {
            std::lock_guard lk(rec->mu);
            rec->status = "failed";
            rec->error = ex.what();
            rec->finished_at = now_epoch_ms();
            rec->append_log_locked(std::string("流程执行异常：") + ex.what());
        }
        {
            std::lock_guard lk(rec->mu);
            rec->active_edges.clear();
            if (st.stop_requested() || stopping_.load(std::memory_order_acquire)) {
                rec->status = "cancelled";
                if (rec->error.empty()) rec->error = "运行已手动停止";
            } else if (ok) {
                rec->status = "completed";
                rec->final_output = final_text;
                rec->final_artifacts = final_arts;
                rec->append_log_locked("流程执行完成，所有命中步骤均已交付。");
            } else if (rec->status == "running" || rec->status == "waiting_approval") {
                rec->status = "failed";
                if (rec->error.empty()) rec->error = "流程步骤执行失败";
            }
            rec->finished_at = now_epoch_ms();
            rec->updated_at = rec->finished_at;
        }
        persist_run(*rec);
    });

    return rec->to_json();
}

bool CanvasRuntimeService::execute_graph_frame(const std::shared_ptr<RunRecord>& rec,
                                               const CanvasGraph& graph,
                                               const std::map<std::string, CanvasGraph>& fn_map,
                                               const std::string& frame_prefix,
                                               const std::string& frame_input,
                                               int depth,
                                               std::string& out_final_text,
                                               std::vector<std::string>& out_artifacts,
                                               std::stop_token stop) {
    if (depth > 4) {
        std::lock_guard lk(rec->mu);
        rec->error = "蓝图函数嵌套深度超过 4 层安全上限";
        return false;
    }

    // Initialize node states in this frame
    {
        std::lock_guard lk(rec->mu);
        for (const auto& n : graph.nodes) {
            const std::string key = frame_prefix + n.id;
            auto& ns = rec->nodes[key];
            ns.key = key;
            ns.frame_prefix = frame_prefix;
            ns.node_id = n.id;
            ns.title = n.title.empty() ? n.id : n.title;
            ns.type = n.type;
            ns.status = "pending";
            ns.output.clear();
            ns.error.clear();
            ns.gate_decision.clear();
            ns.artifacts.clear();
            ns.iteration = 0;
            ns.max_iterations = n.max_iterations;
            ns.planned_route = planned_canvas_route(n); ns.approval_hint = n.approval_hint;
        }
    }

    std::map<std::string, std::string> local_status;
    std::map<std::string, std::string> local_outputs;
    std::map<std::string, std::vector<std::string>> local_artifacts;
    std::map<std::string, std::string> local_gate_outcome; // node_id -> "pass" | "loop"
    std::map<std::string, std::string> pending_feedback;   // node_id -> feedback note for next iteration
    std::map<std::string, std::string> prev_self_outputs;  // node_id -> last output before loop reset
    std::map<std::string, int> local_iterations;
    std::map<std::string, int> local_loop_counts;          // edge_id -> triggered count

    for (const auto& n : graph.nodes) {
        local_status[n.id] = "pending";
        local_iterations[n.id] = 0;
    }

    // Precompute forward reachability for loop resets (following both direct main edges and edge-attached host nodes)
    auto reachable_downstream = [&](const std::string& start_id) -> std::set<std::string> {
        std::set<std::string> vis;
        std::queue<std::string> q;
        vis.insert(start_id);
        q.push(start_id);
        while (!q.empty()) {
            const std::string u = q.front();
            q.pop();
            for (const auto& e : graph.edges) {
                if (is_feedback_edge(e) || e.from_node_id != u) continue;
                const std::string dst = (e.target_kind == "node") ? e.target_id : resolve_edge_host_node(graph, e.id);
                if (!dst.empty() && vis.insert(dst).second) q.push(dst);
            }
        }
        return vis;
    };

    auto is_else_branch_edge = [&](const CanvasEdge& e) -> bool {
        if (!is_feedback_edge(e) || e.target_kind != "node") return false;
        return !reachable_downstream(e.target_id).contains(e.from_node_id);
    };

    enum class Readiness { waiting, ready, skipped };
    auto readiness = [&](const CanvasNode& n) {
        bool has_input = false;
        bool selected = false;
        bool has_control = false;
        bool control_selected = false;
        for (const auto& dep : collect_forward_dependencies(graph, n.id)) {
            if (local_status[dep] != "completed" && local_status[dep] != "skipped")
                return Readiness::waiting;
        }
        for (const auto& e : graph.edges) {
            if (e.target_kind != "node" || e.target_id != n.id) continue;
            const bool otherwise = is_else_branch_edge(e);
            if (is_feedback_edge(e) && !otherwise) continue;
            has_input = true;
            const auto& status = local_status[e.from_node_id];
            if (status == "skipped") continue;
            if (status != "completed") return Readiness::waiting;
            const auto* source = find_node(graph, e.from_node_id);
            if (otherwise || (source->type == "gate" && !(is_logic_gate(n) && is_logic_gate(*source)))) {
                has_control = true;
                control_selected |= local_gate_outcome[e.from_node_id] == (otherwise ? "loop" : "pass");
            } else {
                selected = true;
            }
        }
        const bool enabled = has_control ? control_selected : (!has_input || selected);
        return enabled ? Readiness::ready : Readiness::skipped;
    };

    auto trigger_feedback_edge = [&](const CanvasEdge& fb_edge, int max_iter, const std::string& reason_note) -> bool {
        const int used = local_loop_counts[fb_edge.id];
        const int limit = std::clamp(max_iter, 1, 20);
        if (used >= limit) {
            return false; // Fuse tripped!
        }
        local_loop_counts[fb_edge.id] = used + 1;
        const std::string target_id = fb_edge.target_id;
        const auto reset_set = reachable_downstream(target_id);

        if (const auto it = local_outputs.find(target_id); it != local_outputs.end()) {
            prev_self_outputs[target_id] = it->second;
        }
        pending_feedback[target_id] = reason_note;

        {
            std::lock_guard lk(rec->mu);
            rec->loop_counts[frame_prefix + fb_edge.id] = used + 1;
            for (const auto& rid : reset_set) {
                local_status[rid] = "pending";
                local_gate_outcome.erase(rid);
                auto& ns = rec->nodes[frame_prefix + rid];
                ns.status = "pending";
                ns.gate_decision.clear();
                ns.progress_note = (rid == target_id)
                    ? ("已收到闭环反馈，准备进入第 " + std::to_string(used + 2) + " 轮迭代")
                    : "等待上游闭环重新流入";
            }
            rec->append_log_locked("↻ 触发重做回跳：" + fb_edge.from_node_id + " → " + target_id +
                                   "（第 " + std::to_string(used + 1) + "/" + std::to_string(limit) + " 次重做）");
        }
        persist_run(*rec);
        return true;
    };

    bool any_failed = false;

    while (!stop.stop_requested() && !stopping_.load(std::memory_order_acquire)) {
        std::vector<CanvasNode> ready_batch;
        bool skipped_any = false;
        bool waiting = false;
        for (const auto& n : graph.nodes) {
            if (local_status[n.id] != "pending") continue;
            const auto state = readiness(n);
            if (state == Readiness::ready) {
                ready_batch.push_back(n);
            } else if (state == Readiness::skipped) {
                local_status[n.id] = "skipped";
                local_outputs.erase(n.id);
                local_artifacts.erase(n.id);
                std::lock_guard lk(rec->mu);
                auto& ns = rec->nodes[frame_prefix + n.id];
                ns.status = "skipped";
                ns.progress_note = "未选中此分支";
                skipped_any = true;
            } else {
                waiting = true;
            }
        }
        if (ready_batch.empty()) {
            if (skipped_any) continue;
            if (waiting) {
                std::lock_guard lk(rec->mu);
                rec->error = "蓝图仍有节点等待无法满足的依赖";
                return false;
            }
            break;
        }

        // Highlight active incoming edges for UI circuit pulse
        {
            std::lock_guard lk(rec->mu);
            rec->active_edges.clear();
            for (const auto& rn : ready_batch) {
                for (const auto& e : graph.edges) {
                    if (is_feedback_edge(e)) continue;
                    const std::string host = (e.target_kind == "node") ? e.target_id : resolve_edge_host_node(graph, e.id);
                    if (host == rn.id) rec->active_edges.push_back(frame_prefix + e.id);
                }
            }
        }

        // Execute all ready nodes in this wave CONCURRENTLY (true parallel supplement & parallel branches!)
        struct WaveResult {
            CanvasNode node;
            bool ok = false;
            std::string output;
            std::string error;
            std::string model_label;
            std::vector<std::string> artifacts;
            std::string gate_decision; // "pass" | "loop"
            std::string gate_comment;
        };
        std::vector<WaveResult> wave_results(ready_batch.size());
        std::vector<std::jthread> wave_threads;
        wave_threads.reserve(ready_batch.size());

        // Snapshot immutable upstream maps for concurrent readers in this wave
        const auto snap_outputs = local_outputs;
        const auto snap_artifacts = local_artifacts;
        const auto snap_feedback = pending_feedback;
        const auto snap_prev_self = prev_self_outputs;
        const auto snap_gate_outcome = local_gate_outcome;

        for (std::size_t idx = 0; idx < ready_batch.size(); ++idx) {
            const CanvasNode node = ready_batch[idx];
            const int iter_num = ++local_iterations[node.id];
            local_status[node.id] = "running";
            const std::string nkey = frame_prefix + node.id;

            {
                std::lock_guard lk(rec->mu);
                auto& ns = rec->nodes[nkey];
                ns.status = "running";
                ns.iteration = iter_num;
                ns.started_at = now_epoch_ms();
                ns.error.clear();
                ns.progress_note = "正在运行…";
                rec->append_log_locked("▶ 节点启动：「" + ns.title + "」（第 " + std::to_string(iter_num) + " 轮）");
            }

            wave_threads.emplace_back([&, idx, node, iter_num, nkey]() {
                WaveResult wr;
                wr.node = node;
                const std::string fb_note = snap_feedback.contains(node.id) ? snap_feedback.at(node.id) : std::string{};
                const std::string prev_self = snap_prev_self.contains(node.id) ? snap_prev_self.at(node.id) : std::string{};

                if (node.type == "input") {
                    wr.ok = true;
                    wr.output = frame_input;
                    wr.model_label = "开始任务";
                } else if (node.type == "action" && node.action_kind == "read_file") {
                    std::string target = trim_copy(node.action_target);
                    replace_all(target, "{{input}}", frame_input);
                    fs::path p;
                    if (target.empty()) {
                        p = rec->workspace_dir.empty()
                            ? fs::current_path()
                            : fs::path(std::u8string(reinterpret_cast<const char8_t*>(rec->workspace_dir.data()), rec->workspace_dir.size()));
                    } else {
                        fs::path raw(std::u8string(reinterpret_cast<const char8_t*>(target.data()), target.size()));
                        if (raw.is_relative() && !rec->workspace_dir.empty()) {
                            fs::path ws(std::u8string(reinterpret_cast<const char8_t*>(rec->workspace_dir.data()), rec->workspace_dir.size()));
                            p = ws / raw;
                        } else {
                            p = raw;
                        }
                    }
                    std::error_code ec;
                    if (fs::is_directory(p, ec)) {
                        std::ostringstream oss;
                        const auto p8 = p.u8string();
                        oss << "【已读取目录信息】" << std::string(reinterpret_cast<const char*>(p8.data()), p8.size()) << "\n";
                        int shown = 0;
                        int total = 0;
                        for (const auto& ent : fs::directory_iterator(p, ec)) {
                            if (ec) break;
                            ++total;
                            if (shown < 80) {
                                const auto n8 = ent.path().filename().u8string();
                                const std::string name(reinterpret_cast<const char*>(n8.data()), n8.size());
                                if (ent.is_directory(ec)) {
                                    oss << "- [文件夹] " << name << "/\n";
                                } else {
                                    const auto sz = ent.file_size(ec);
                                    oss << "- [文件] " << name << " (" << sz << " 字节)\n";
                                }
                                ++shown;
                            }
                        }
                        if (total > shown) oss << "…（共 " << total << " 项，已展示前 " << shown << " 项）\n";
                        if (total == 0) oss << "（该目录当前为空）\n";
                        wr.ok = true;
                        wr.output = oss.str();
                        wr.model_label = "读取目录";
                    } else if (fs::is_regular_file(p, ec)) {
                        bool truncated = false;
                        std::uintmax_t total_bytes = 0;
                        const std::size_t cap = static_cast<std::size_t>(std::clamp(node.max_inline_chars, 500, 500000));
                        std::string content = read_text_file_bounded(p, cap, truncated, total_bytes);
                        if (truncated) {
                            content += "\n\n[已按预算读取前 " + std::to_string(cap) + " / " + std::to_string(total_bytes) + " 字节]";
                        }
                        wr.ok = true;
                        wr.output = std::move(content);
                        wr.model_label = "读取文件";
                    } else {
                        wr.ok = false;
                        wr.error = "找不到要读取的文件或目录：" + (target.empty() ? rec->workspace_dir : target);
                    }
                } else if (node.type == "reference") {
                    if (node.ref_mode == "file") {
                        const fs::path p = fs::path(std::u8string(reinterpret_cast<const char8_t*>(node.file_path.data()), node.file_path.size()));
                        std::error_code ec;
                        if (!fs::is_regular_file(p, ec)) {
                            wr.ok = false;
                            wr.error = "找不到指定的参考资料文件：" + node.file_path;
                        } else {
                            bool truncated = false;
                            std::uintmax_t total_bytes = 0;
                            const std::size_t cap = node.force_full_text
                                ? (2U * 1024U * 1024U)
                                : static_cast<std::size_t>(std::clamp(node.max_inline_chars, 500, 500000));
                            std::string content = read_text_file_bounded(p, cap, truncated, total_bytes);
                            if (truncated) {
                                content += "\n\n[资料防爆提示：原文件 " + node.file_path + " 共 " +
                                           std::to_string(total_bytes) + " 字节，已按节点上下文预算截取前 " +
                                           std::to_string(cap) + " 字节。需要全文细节时可通过文件工具按路径检索。]";
                            }
                            wr.ok = true;
                            wr.output = std::move(content);
                            wr.model_label = "本地资料文件";
                        }
                    } else {
                        std::string content = node.ref_text;
                        if (!node.force_full_text && static_cast<int>(content.size()) > node.max_inline_chars) {
                            content = content.substr(0, static_cast<std::size_t>(node.max_inline_chars)) +
                                      "\n\n[资料已按节点预算截断]";
                        }
                        wr.ok = true;
                        wr.output = std::move(content);
                        wr.model_label = "文本资料卡";
                    }
                } else if (node.type == "gate") {
                    const std::string upstream_ctx = assemble_canvas_node_context(
                        graph, node.id, frame_input, snap_outputs, snap_artifacts, fb_note, prev_self, iter_num, node.max_iterations);
                    if (node.gate_mode == "bool_switch" || node.gate_mode == "logic_and" || node.gate_mode == "logic_or") {
                        const auto deps = collect_forward_dependencies(graph, node.id);
                        std::string combined_up;
                        for (const auto& d : deps) {
                            if (const auto it = snap_outputs.find(d); it != snap_outputs.end() && !it->second.empty()) {
                                if (!combined_up.empty()) combined_up += "\n";
                                combined_up += it->second;
                            }
                        }
                        const std::string eval_text = combined_up.empty() ? frame_input : combined_up;

                        auto dep_truth = [&](const std::string& dep_id) -> bool {
                            if (const auto git = snap_gate_outcome.find(dep_id); git != snap_gate_outcome.end()) {
                                return git->second == "pass";
                            }
                            const auto oit = snap_outputs.find(dep_id);
                            return oit != snap_outputs.end() ? evaluate_text_as_bool(oit->second) : false;
                        };

                        bool passed = false;
                        std::ostringstream detail;
                        if (node.gate_mode == "bool_switch") {
                            wr.model_label = "布尔值判断";
                            if (node.bool_source == "fixed") {
                                passed = node.bool_value;
                                detail << "固定布尔开关 = " << (passed ? "真 (True)" : "假 (False)");
                            } else if (!deps.empty()) {
                                passed = dep_truth(deps.front());
                                detail << "自动读取上游真假 = " << (passed ? "真 (True)" : "假 (False)");
                            } else {
                                passed = evaluate_text_as_bool(frame_input);
                                detail << "自动判断输入真假 = " << (passed ? "真 (True)" : "假 (False)");
                            }
                        } else {
                            const bool is_and = (node.gate_mode == "logic_and");
                            wr.model_label = is_and ? "和条件 (AND)" : "或条件 (OR)";
                            if (!node.condition_rules.empty()) {
                                passed = is_and ? true : false;
                                detail << (is_and ? "和条件（全部满足才为真）：" : "或条件（任一满足即为真）：");
                                for (std::size_t ri = 0; ri < node.condition_rules.size(); ++ri) {
                                    std::string rdesc;
                                    const bool rok = evaluate_condition_rule(node.condition_rules[ri], eval_text, rdesc);
                                    detail << "\n  " << (rok ? "✓ " : "✗ ") << "条件" << (ri + 1) << "：" << rdesc;
                                    if (is_and) passed = passed && rok;
                                    else passed = passed || rok;
                                }
                            } else if (!deps.empty()) {
                                passed = is_and ? true : false;
                                detail << (is_and ? "多路汇聚【和 / AND】（全部上游为真）：" : "多路汇聚【或 / OR】（任一上游为真）：");
                                for (const auto& d : deps) {
                                    const auto* dn = find_node(graph, d);
                                    const std::string dname = (dn && !dn->title.empty()) ? dn->title : d;
                                    const bool dok = dep_truth(d);
                                    detail << "\n  " << (dok ? "✓ " : "✗ ") << dname << " = " << (dok ? "真" : "假");
                                    if (is_and) passed = passed && dok;
                                    else passed = passed || dok;
                                }
                            } else {
                                passed = evaluate_text_as_bool(eval_text);
                                detail << (is_and ? "和条件" : "或条件") << "默认判断 = " << (passed ? "真" : "假");
                            }
                        }
                        if (node.invert_result) {
                            passed = !passed;
                            detail << "\n  ↺ 已启用取反（非 NOT），最终结果 = " << (passed ? "真 (True)" : "假 (False)");
                        }
                        wr.ok = true;
                        wr.gate_decision = passed ? "pass" : "loop";
                        wr.gate_comment = detail.str();
                        wr.output = std::string(passed ? "TRUE" : "FALSE") + "\n" + detail.str() +
                                    (combined_up.empty() ? "" : ("\n\n" + combined_up));
                    } else if (node.gate_mode == "auto_condition") {
                        // Evaluate condition against direct upstream outputs
                        std::string combined_up;
                        for (const auto& d : collect_forward_dependencies(graph, node.id)) {
                            if (const auto it = snap_outputs.find(d); it != snap_outputs.end()) {
                                combined_up += "\n" + it->second;
                            }
                        }
                        const std::string low_up = ascii_lower(combined_up);
                        const std::string low_pass = ascii_lower(trim_copy(node.pass_keyword));
                        const std::string low_fail = ascii_lower(trim_copy(node.fail_keyword));
                        const bool hit_fail = !low_fail.empty() && low_up.find(low_fail) != std::string::npos;
                        const bool hit_pass = !low_pass.empty() && low_up.find(low_pass) != std::string::npos;

                        bool passed = hit_pass && !hit_fail;
                        if (low_pass.empty() && !low_fail.empty()) passed = !hit_fail;

                        wr.ok = true;
                        wr.model_label = "自动条件门";
                        wr.gate_decision = passed ? "pass" : "loop";
                        wr.gate_comment = passed
                            ? ("条件命中通过（关键词：" + node.pass_keyword + "）")
                            : ("审校未通过，触发闭环返工：\n" + trim_copy(combined_up));
                        wr.output = upstream_ctx;
                    } else {
                        // Human approval gate: pause cleanly and wait on condition_variable!
                        {
                            std::lock_guard lk(rec->mu);
                            rec->status = "waiting_approval";
                            auto& ns = rec->nodes[nkey];
                            ns.status = "waiting_approval";
                            ns.output = upstream_ctx;
                            ns.progress_note = "等待人工审批（可选择通过、带批注通过或驳回返工）";
                            rec->gate_decisions.erase(nkey);
                            rec->append_log_locked("⏸ 等待人工审批：「" + ns.title + "」");
                        }
                        persist_run(*rec);

                        RunRecord::PendingGateDecision decision;
                        {
                            std::unique_lock lk(rec->mu);
                            rec->cv.wait(lk, stop, [&]() {
                                return stopping_.load(std::memory_order_acquire) ||
                                       (rec->gate_decisions.contains(nkey) && rec->gate_decisions[nkey].decided);
                            });
                            if (rec->gate_decisions.contains(nkey) && rec->gate_decisions[nkey].decided) {
                                decision = rec->gate_decisions[nkey];
                                rec->gate_decisions.erase(nkey);
                            }
                            if (rec->status == "waiting_approval") rec->status = "running";
                        }

                        if (stop.stop_requested() || stopping_.load(std::memory_order_acquire) || !decision.decided) {
                            wr.ok = false;
                            wr.error = "审批已取消";
                        } else {
                            wr.ok = true;
                            wr.model_label = "人工审批门";
                            wr.gate_decision = decision.approved ? "pass" : "loop";
                            wr.gate_comment = decision.comment;
                            wr.output = upstream_ctx;
                            if (decision.approved && !decision.comment.empty()) {
                                wr.output += "\n\n【审批人放行批注】\n" + decision.comment;
                            }
                        }
                    }
                } else if (node.type == "function_call") {
                    const auto fit = fn_map.find(node.function_id);
                    if (fit == fn_map.end()) {
                        wr.ok = false;
                        wr.error = "未找到蓝图函数：" + node.function_id;
                    } else {
                        std::string sub_in = assemble_canvas_node_context(
                            graph, node.id, frame_input, snap_outputs, snap_artifacts, fb_note, prev_self, iter_num, node.max_iterations);
                        if (!node.param_note.empty()) {
                            sub_in = "【蓝图函数入参说明】\n" + node.param_note + "\n\n" + sub_in;
                        }
                        std::string sub_out;
                        std::vector<std::string> sub_arts;
                        const bool sub_ok = execute_graph_frame(
                            rec, fit->second, fn_map, frame_prefix + node.id + "::", sub_in, depth + 1, sub_out, sub_arts, stop);
                        wr.ok = sub_ok;
                        wr.output = std::move(sub_out);
                        wr.artifacts = std::move(sub_arts);
                        wr.model_label = "蓝图函数 · " + fit->second.name;
                        if (!sub_ok) wr.error = "蓝图函数「" + fit->second.name + "」内部执行未完成";
                    }
                } else {
                    // "agent" or "compress" node executed via injected executor_
                    const std::string prompt = assemble_canvas_node_context(
                        graph, node.id, frame_input, snap_outputs, snap_artifacts, fb_note, prev_self, iter_num, node.max_iterations);
                    if (!executor_) {
                        wr.ok = false;
                        wr.error = "未配置画布节点执行器";
                    } else {
                        CanvasNodeExecRequest ereq;
                        ereq.run_id = rec->run_id;
                        ereq.frame_prefix = frame_prefix;
                        ereq.workspace_dir = rec->workspace_dir;
                        ereq.flow_input = frame_input;
                        ereq.node = node;
                        ereq.canvas_id = rec->canvas_id;
                        ereq.review_work_run = rec->review_work_run;
                        ereq.assembled_prompt = prompt;
                        ereq.iteration = iter_num;

                        const auto eres = executor_(
                            ereq,
                            [&](std::string_view prog) {
                                std::lock_guard lk(rec->mu);
                                rec->nodes[nkey].progress_note = std::string(prog);
                                rec->updated_at = now_epoch_ms();
                            },
                            stop);
                        wr.ok = eres.ok && !eres.cancelled;
                        wr.output = eres.output;
                        wr.error = eres.error;
                        wr.artifacts = eres.artifacts;
                        wr.model_label = eres.model_label;
                    }
                }

                wave_results[idx] = std::move(wr);
            });
        }

        for (auto& t : wave_threads) {
            if (t.joinable()) t.join();
        }

        // Commit wave results and process any circuit feedback loops cleanly on coordinator thread
        for (const auto& wr : wave_results) {
            const std::string nkey = frame_prefix + wr.node.id;
            pending_feedback.erase(wr.node.id);

            if (!wr.ok) {
                any_failed = true;
                local_status[wr.node.id] = "failed";
                std::lock_guard lk(rec->mu);
                auto& ns = rec->nodes[nkey];
                ns.status = stop.stop_requested() ? "cancelled" : "failed";
                ns.error = wr.error;
                ns.output = wr.output;
                ns.artifacts = wr.artifacts;
                ns.model_label = wr.model_label;
                ns.finished_at = now_epoch_ms();
                ns.progress_note = wr.error;
                if (rec->error.empty()) rec->error = "节点「" + ns.title + "」失败：" + wr.error;
                rec->append_log_locked("✖ 节点失败：「" + ns.title + "」" + (wr.error.empty() ? "" : (" — " + wr.error)));
                continue;
            }

            local_status[wr.node.id] = "completed";
            local_outputs[wr.node.id] = wr.output;
            local_artifacts[wr.node.id] = wr.artifacts;

            // Update RunRecord node snapshot
            {
                std::lock_guard lk(rec->mu);
                auto& ns = rec->nodes[nkey];
                ns.status = "completed";
                ns.output = wr.output;
                ns.artifacts = wr.artifacts;
                ns.model_label = wr.model_label;
                ns.gate_decision = wr.gate_decision;
                ns.finished_at = now_epoch_ms();
                ns.progress_note = wr.node.type == "gate"
                    ? (wr.gate_decision == "pass" ? "已放行" : "触发闭环返工")
                    : "已完成";
                rec->append_log_locked("✔ 节点完成：「" + ns.title + "」");
            }

            // Check circuit feedback edges originating from this node
            std::vector<const CanvasEdge*> fb_edges;
            for (const auto& e : graph.edges) {
                if (is_feedback_edge(e) && e.from_node_id == wr.node.id && e.target_kind == "node") {
                    fb_edges.push_back(&e);
                }
            }

            if (wr.node.type == "gate") {
                const bool is_logic = is_logic_gate(wr.node);
                if (wr.gate_decision == "loop") {
                    std::vector<const CanvasEdge*> real_loops;
                    bool has_else_branch = false;
                    for (const auto* fbe : fb_edges) {
                        if (is_else_branch_edge(*fbe)) has_else_branch = true;
                        else real_loops.push_back(fbe);
                    }
                    bool looped = false;
                    for (const auto* fbe : real_loops) {
                        if (trigger_feedback_edge(*fbe, wr.node.max_iterations, wr.gate_comment)) {
                            looped = true;
                        }
                    }
                    if (looped || has_else_branch || is_logic) {
                        local_gate_outcome[wr.node.id] = "loop";
                        if (is_logic && !looped) {
                            std::lock_guard lk(rec->mu);
                            rec->nodes[nkey].progress_note = has_else_branch ? "判定为假 ✗（走不满足分支）" : "判定为假 ✗";
                        }
                    } else if (wr.node.gate_mode != "auto_condition") {
                        any_failed = true;
                        local_status[wr.node.id] = "failed";
                        std::lock_guard lk(rec->mu);
                        auto& ns = rec->nodes[nkey];
                        ns.status = "failed";
                        ns.error = fb_edges.empty() ? "人工审批已驳回，没有返工连线" : "人工审批已驳回，已达到返工轮次上限";
                        ns.progress_note = ns.error;
                        rec->error = ns.error;
                        rec->append_log_locked(ns.error);
                    } else {
                        local_gate_outcome[wr.node.id] = "pass";
                        local_outputs[wr.node.id] += "\n\n[安全上限：已达最大重做次数 " +
                            std::to_string(wr.node.max_iterations) + " 轮，已自动放行]";
                        std::lock_guard lk(rec->mu);
                        rec->nodes[nkey].gate_decision = "pass";
                        rec->nodes[nkey].output = local_outputs[wr.node.id];
                        rec->nodes[nkey].progress_note = "已达熔断上限，自动放行";
                        rec->append_log_locked("⚡ 触发保险丝熔断：「" + wr.node.title + "」达到最大 " +
                                               std::to_string(wr.node.max_iterations) + " 轮，安全放行。");
                    }
                } else {
                    local_gate_outcome[wr.node.id] = "pass";
                    if (is_logic) {
                        std::lock_guard lk(rec->mu);
                        rec->nodes[nkey].progress_note = "判定为真 ✓";
                    }
                }
            } else if (!fb_edges.empty()) {
                // Direct tail-to-head circuit loop without explicit gate: repeats up to max_iterations
                for (const auto* fbe : fb_edges) {
                    (void)trigger_feedback_edge(*fbe, wr.node.max_iterations, wr.output);
                }
            }
        }

        persist_run(*rec);
        if (any_failed) return false;
    }

    if (stop.stop_requested() || stopping_.load(std::memory_order_acquire) || any_failed) {
        return false;
    }

    // Collect terminal outputs (completed non-reference nodes with no forward outgoing edge in this frame)
    std::ostringstream final_ss;
    std::set<std::string> seen_art;
    for (const auto& n : graph.nodes) {
        if (local_status[n.id] != "completed" || n.type == "reference") continue;
        bool has_fwd_out = false;
        for (const auto& e : graph.edges) {
            if (!is_feedback_edge(e) && e.from_node_id == n.id) {
                has_fwd_out = true;
                break;
            }
        }
        if (!has_fwd_out) {
            if (const auto it = local_outputs.find(n.id); it != local_outputs.end() && !it->second.empty()) {
                if (final_ss.tellp() > 0) final_ss << "\n\n---\n\n";
                final_ss << it->second;
            }
        }
        if (const auto ait = local_artifacts.find(n.id); ait != local_artifacts.end()) {
            for (const auto& a : ait->second) {
                if (seen_art.insert(a).second) out_artifacts.push_back(a);
            }
        }
    }
    out_final_text = trim_copy(final_ss.str());
    return true;
}

Json CanvasRuntimeService::get_run(const std::string& run_id) const {
    std::shared_ptr<RunRecord> rec;
    {
        std::lock_guard lk(runs_mutex_);
        const auto it = runs_.find(run_id);
        if (it == runs_.end()) throw std::runtime_error("未找到画布运行记录：" + run_id);
        rec = it->second;
    }
    return rec->to_json();
}

Json CanvasRuntimeService::list_runs(std::size_t limit) const {
    std::vector<std::shared_ptr<RunRecord>> all;
    {
        std::lock_guard lk(runs_mutex_);
        for (const auto& [_, r] : runs_) all.push_back(r);
    }
    std::sort(all.begin(), all.end(), [](const auto& a, const auto& b) {
        return a->created_at > b->created_at;
    });
    A arr;
    for (std::size_t i = 0; i < all.size() && i < limit; ++i) {
        arr.push_back(all[i]->to_json());
    }
    return O{{"ok", true}, {"runs", std::move(arr)}};
}

Json CanvasRuntimeService::decide_gate(const std::string& run_id,
                                       const std::string& gate_key,
                                       bool approved,
                                       const std::string& comment) {
    std::shared_ptr<RunRecord> rec;
    {
        std::lock_guard lk(runs_mutex_);
        const auto it = runs_.find(run_id);
        if (it == runs_.end()) throw std::runtime_error("未找到画布运行记录：" + run_id);
        rec = it->second;
    }
    {
        std::lock_guard lk(rec->mu);
        const auto nit = rec->nodes.find(gate_key);
        if (nit == rec->nodes.end() || nit->second.status != "waiting_approval") {
            throw std::runtime_error("该审批节点当前不在等待审批状态：" + gate_key);
        }
        ++rec->gate_reviews;
        if (!approved) ++rec->gate_rejections;
        rec->gate_decisions[gate_key] = RunRecord::PendingGateDecision{true, approved, comment};
        nit->second.status = "running";
        nit->second.progress_note = approved ? "审批已通过，正在推进下一节点…" : "已驳回，正在触发闭环返工…";
        bool any_other_waiting = false;
        for (const auto& [k, ns] : rec->nodes) {
            if (ns.status == "waiting_approval") { any_other_waiting = true; break; }
        }
        if (!any_other_waiting && rec->status == "waiting_approval") {
            rec->status = "running";
        }
        rec->append_log_locked(std::string(approved ? "✔ 人工审批通过：" : "↻ 人工审批驳回返工：") +
                               nit->second.title + (comment.empty() ? "" : ("（" + comment + "）")));
        rec->cv.notify_all();
    }
    return rec->to_json();
}

Json CanvasRuntimeService::cancel_run(const std::string& run_id) {
    std::shared_ptr<RunRecord> rec;
    {
        std::lock_guard lk(runs_mutex_);
        const auto it = runs_.find(run_id);
        if (it == runs_.end()) throw std::runtime_error("未找到画布运行记录：" + run_id);
        rec = it->second;
    }
    {
        std::lock_guard lk(rec->mu);
        if (rec->worker.joinable()) rec->worker.request_stop();
        rec->cv.notify_all();
    }
    return rec->to_json();
}

} // namespace dimension
