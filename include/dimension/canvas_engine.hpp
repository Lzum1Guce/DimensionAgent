#pragma once

#include "dimension/json.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stop_token>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace dimension {

std::string canvas_text_prefix(std::string_view text, std::size_t byte_budget);

struct CanvasConditionRule {
    // "contains" | "not_contains" | "equals" | "not_empty" | "is_true" | "is_false" | "gt_len"
    std::string op = "contains";
    std::string value;

    Json to_json() const;
    static CanvasConditionRule from_json(const Json& j);
};

struct CanvasNode {
    std::string id;
    // "input" | "action" | "reference" | "agent" | "compress" | "gate" | "function_call"
    std::string type = "agent";
    std::string title;
    double x = 0.0;
    double y = 0.0;

    // Agent role configuration (existing resident bot OR canvas-scoped ephemeral persona)
    std::string bot_mode = "existing";   // "existing" | "inline"
    std::string bot_id;
    std::string inline_name;
    std::string inline_persona;

    // Model / CLI execution configuration (for "agent" and "compress")
    std::string engine_kind = "api";     // "api" | "cli"
    std::string provider_id;
    std::string model;
    std::string cli_engine_id = "auto";
    std::string cli_model_source = "work"; // "work" | "native"
    std::string cli_native_provider;
    std::string cli_native_model;
    bool requires_workspace = false;
    bool assignment_locked = false;
    std::string reasoning_effort;        // "" | "low" | "medium" | "high"
    bool read_only = false;

    // Prompt & context assembly
    std::string prompt;
    std::string context_mode = "handoff"; // "handoff" | "full_chain" | "template_only"
    bool include_memory = false;

    // Reference (.txt / .md / inline text) node configuration
    std::string ref_mode = "text";       // "text" | "file"
    std::string ref_text;
    std::string file_path;
    int max_inline_chars = 12000;
    bool force_full_text = false;

    // Compression node configuration
    std::string compress_mode = "handoff_card"; // "summary" | "handoff_card" | "custom"
    int max_output_chars = 2400;

    // Gate (human approval, keyword check, OR boolean / AND / OR logic conditions)
    // "approval" | "auto_condition" | "bool_switch" | "logic_and" | "logic_or"
    std::string gate_mode = "approval";
    std::string pass_keyword = "PASS";
    std::string fail_keyword = "FAIL";
    bool require_pass = false;
    int max_iterations = 3;              // Circuit breaker fuse (1..20)
    std::string approval_hint;
    std::string bool_source = "auto";    // "auto" (read upstream truthiness) | "fixed" (manual true/false switch)
    bool bool_value = true;              // Manual boolean switch value when bool_source == "fixed"
    bool invert_result = false;          // Logical NOT inversion
    std::vector<CanvasConditionRule> condition_rules; // Structured rules for logic_and / logic_or

    // Reusable sub-flow ("组合步骤") reference
    std::string function_id;
    std::string param_note;

    // Practical desktop/web action step (for type == "action"):
    // "open_app" | "open_url" | "read_file" | "fetch_url" | "run_command"
    std::string action_kind = "read_file";
    std::string action_target;
    std::string action_args;
    int action_timeout_sec = 30;

    Json to_json() const;
    static CanvasNode from_json(const Json& j);
};

struct CanvasEdge {
    std::string id;
    std::string from_node_id;
    // "out" | "pass" | "loop"
    std::string from_port = "out";
    // First-class edge attachment: target may be a node OR another edge (parallel supplement tributary!)
    std::string target_kind = "node";    // "node" | "edge"
    std::string target_id;
    double attach_t = 0.5;               // Junction position along target edge [0.15..0.85]
    // "main" | "supplement" | "feedback"
    std::string wire_kind = "main";
    std::string label;

    Json to_json() const;
    static CanvasEdge from_json(const Json& j);
};

struct CanvasGraph {
    std::string id;
    std::string name;
    std::string description;
    std::string kind = "canvas";         // "canvas" | "function"
    std::string category;
    bool builtin = false;
    std::int64_t updated_at = 0;
    std::vector<CanvasNode> nodes;
    std::vector<CanvasEdge> edges;

    Json to_json() const;
    static CanvasGraph from_json(const Json& j);
};

struct CanvasValidationResult {
    bool ok = true;
    std::string error;
};

// Validates node/edge integrity, edge-attachment host resolution, acyclic forward DAG,
// and bounded UE-Blueprint function nesting (max depth 4, no self-recursion).
CanvasValidationResult validate_canvas_graph(const CanvasGraph& graph,
                                             const std::map<std::string, CanvasGraph>& functions = {});

// Resolves the ultimate destination node ID for an edge (recursively traversing edge attachments).
std::string resolve_edge_host_node(const CanvasGraph& graph, const std::string& edge_id);

// Computes all direct and edge-attached (parallel supplement) upstream dependency node IDs for target_node_id.
// Feedback edges are excluded from forward barrier dependencies.
std::vector<std::string> collect_forward_dependencies(const CanvasGraph& graph,
                                                      const std::string& target_node_id);

// Builds the structured prompt delivered to target_node_id strictly honoring edge attachment semantics:
// Primary upstream deliveries come from main edges (A -> B), while nodes attached onto edge (A -> B)
// are nested directly beneath A as "并行补充信息 (针对 A)".
std::string assemble_canvas_node_context(const CanvasGraph& graph,
                                         const std::string& target_node_id,
                                         const std::string& flow_input,
                                         const std::map<std::string, std::string>& node_outputs,
                                         const std::map<std::string, std::vector<std::string>>& node_artifacts = {},
                                         const std::string& feedback_note = {},
                                         const std::string& prev_self_output = {},
                                         int iteration = 1,
                                         int max_iterations = 1);

// UE Blueprint-style "Collapse Selected Nodes to Function":
// Extracts selected_node_ids into a reusable CanvasGraph(kind="function") with an "In" entry node,
// and rewires external incoming/outgoing edges (including edge-attached supplements) onto a new function_call chip.
struct CanvasCollapseResult {
    CanvasGraph updated_canvas;
    CanvasGraph created_function;
    std::string chip_node_id;
};

CanvasCollapseResult collapse_nodes_to_blueprint_function(const CanvasGraph& canvas,
                                                          const std::vector<std::string>& selected_node_ids,
                                                          const std::string& function_name,
                                                          const std::string& function_description = {});

// Execution callback injected by Application (or mock in unit tests) to run agent/compress/reference nodes.
struct CanvasNodeExecRequest {
    std::string run_id;
    std::string frame_prefix;            // "" for root canvas, "chipId::..." for nested blueprint functions
    std::string workspace_dir;
    std::string flow_input;
    CanvasNode node;
    std::string assembled_prompt;
    int iteration = 1;
    std::string canvas_id;
    std::string review_work_run;
};

struct CanvasNodeExecResult {
    bool ok = false;
    bool cancelled = false;
    std::string output;
    std::string error;
    std::vector<std::string> artifacts;
    std::string model_label;
};

using CanvasNodeExecutor = std::function<CanvasNodeExecResult(
    const CanvasNodeExecRequest&,
    const std::function<void(std::string_view)>& on_progress,
    std::stop_token)>;

struct CanvasRunStartRequest {
    std::string canvas_id;
    std::string input_text;
    std::string workspace_dir;
    std::string bot_id;                  // Active Work bot context (used for default workspace/API fallback)
    std::string request_id;
    std::string review_work_run;
};

class CanvasRuntimeService {
public:
    CanvasRuntimeService(std::filesystem::path data_root, CanvasNodeExecutor executor);
    ~CanvasRuntimeService();

    CanvasRuntimeService(const CanvasRuntimeService&) = delete;
    CanvasRuntimeService& operator=(const CanvasRuntimeService&) = delete;

    void shutdown();

    // Library CRUD (canvases & UE Blueprint functions)
    Json list_library() const;
    CanvasGraph get_graph(const std::string& id) const;
    CanvasGraph save_graph(const CanvasGraph& graph, bool generated = false);
    void delete_graph(const std::string& id);
    CanvasCollapseResult collapse_to_function(const std::string& canvas_id,
                                              const std::vector<std::string>& selected_node_ids,
                                              const std::string& function_name,
                                              const std::string& function_description = {});

    // Deterministic circuit execution runtime
    Json start_run(const CanvasRunStartRequest& req);
    Json get_run(const std::string& run_id) const;
    Json list_runs(std::size_t limit = 30) const;
    Json decide_gate(const std::string& run_id,
                     const std::string& gate_key,
                     bool approved,
                     const std::string& comment = {});
    Json cancel_run(const std::string& run_id);

private:
    struct RunRecord;

    void load_library_locked();
    void persist_library_locked() const;
    void seed_builtin_templates_locked();
    void load_recent_runs_locked();
    void persist_run(const RunRecord& rec) const;

    bool execute_graph_frame(const std::shared_ptr<RunRecord>& rec,
                             const CanvasGraph& graph,
                             const std::map<std::string, CanvasGraph>& fn_map,
                             const std::string& frame_prefix,
                             const std::string& frame_input,
                             int depth,
                             std::string& out_final_text,
                             std::vector<std::string>& out_artifacts,
                             std::stop_token stop);

    std::filesystem::path data_root_;
    CanvasNodeExecutor executor_;
    mutable std::mutex lib_mutex_;
    std::map<std::string, CanvasGraph> canvases_;
    std::map<std::string, CanvasGraph> functions_;

    mutable std::mutex runs_mutex_;
    std::map<std::string, std::shared_ptr<RunRecord>> runs_;
    std::map<std::string, std::string> request_runs_;
    std::atomic<bool> stopping_{false};
};

} // namespace dimension
