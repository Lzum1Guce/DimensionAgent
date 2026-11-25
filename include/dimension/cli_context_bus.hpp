#pragma once

#include "dimension/json.hpp"
#include "dimension/work_cli_broker.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

// Command execution receipt captured from NormalizedCliEvent stream (action_category == "command").
struct CliCommandReceipt {
    std::string command;
    bool failed = false;
    std::string output_excerpt;
    bool result_known = true;
    Json to_json() const;
    static CliCommandReceipt from_json(const Json& j);
};

// Pair terminal events by invocation ID even when their native format omits the tool name.
class CliCommandTracker {
public:
    void observe(const NormalizedCliEvent& event);
    std::vector<CliCommandReceipt> take();
private:
    std::map<std::string, std::size_t> pending_;
    std::vector<CliCommandReceipt> receipts_;
};

// Ground-truth per-file delta aggregated across multiple CLI engines and group members.
struct CliFileLedgerEntry {
    std::string relative_path;
    bool created = false;
    std::uintmax_t bytes = 0;
    int added_lines = 0;
    int removed_lines = 0;
    std::string diff_excerpt;
    std::string last_engine_id;
    std::string last_engine_name;
    std::string last_bot_name;
    std::int64_t updated_at_ms = 0;
    Json to_json() const;
    static CliFileLedgerEntry from_json(const Json& j);
};

// One completed CLI dispatch turn in a run (solo or group shared workspace).
struct CliTurnLedgerEntry {
    int turn_index = 0;
    std::string bot_id;
    std::string bot_name;
    std::string engine_id;
    std::string engine_name;
    std::string model_label;
    std::string native_session_id;
    std::string task_summary;
    std::string outcome_summary;
    bool success = false;
    bool cancelled = false;
    std::int64_t duration_ms = 0;
    std::int64_t completed_at_ms = 0;
    std::vector<std::string> touched_files;
    std::vector<CliCommandReceipt> commands;
    Json to_json() const;
    static CliTurnLedgerEntry from_json(const Json& j);
};

// Engine-agnostic canonical handoff ledger persisted by DimensionAgent (Single Source of Truth).
struct CliHandoffLedger {
    std::string ledger_id;
    std::vector<std::string> hard_constraints;
    std::vector<CliTurnLedgerEntry> turns;
    std::map<std::string, CliFileLedgerEntry> files;
    Json to_json() const;
    static CliHandoffLedger from_json(const Json& j);
};

struct CliHandoffPrepareRequest {
    std::filesystem::path data_root;
    std::filesystem::path workspace_dir;
    std::string ledger_id;                // Usually root_run_id (shared by solo rework & group members)
    std::string bot_id;
    std::string target_engine_id;
    std::string target_engine_name;
    std::string target_model_label;
    bool target_has_existing_session = false;
    std::size_t max_inline_bytes = 3400U; // Compact inline card budget; full detail lives in .dimension/handoffs/<ledger>.md
};

struct CliHandoffPrepared {
    bool injected = false;
    bool cross_engine = false;
    bool cross_member = false;
    std::string previous_engine_id;
    std::string previous_engine_name;
    std::string previous_bot_name;
    std::size_t handed_off_files = 0;
    std::size_t handed_off_turns = 0;
    std::string prompt_prefix;
    std::filesystem::path detail_file_path;
    Json to_event_json() const;
};

struct CliHandoffRecordRequest {
    std::filesystem::path data_root;
    std::filesystem::path workspace_dir;
    std::string ledger_id;
    std::string bot_id;
    std::string bot_name;
    std::string task_prompt;
    PreservedConstraintSet constraints;
    CliHarnessRunResult run_result;
    std::vector<CliCommandReceipt> commands;
};

// Computes a fast O(N) compact line-level diff excerpt suitable for cross-CLI handoff cards.
std::string build_compact_line_diff(std::string_view before,
                                    std::string_view after,
                                    int& out_added,
                                    int& out_removed,
                                    std::size_t max_bytes = 900U);

// Inspects the canonical ledger before dispatching a CLI turn:
// - Skips redundant injection when same (bot, engine, model) resumes its own live native session.
// - Automatically synthesizes a compact cross-engine / cross-member handoff envelope otherwise.
CliHandoffPrepared prepare_cli_context_handoff(const CliHandoffPrepareRequest& req);

// Records ground-truth file deltas, command receipts, hard constraints, and outcome into the
// canonical ledger JSON (under data_root/cli-context-bus/) and refreshes <workspace>/.dimension/handoffs/<ledger>.md.
void record_cli_context_outcome(const CliHandoffRecordRequest& req);

// Loads the persisted canonical ledger for inspection or testing.
CliHandoffLedger load_cli_handoff_ledger(const std::filesystem::path& data_root,
                                         std::string_view ledger_id);

// Returns a responsive history byte budget for front-desk reception CLI prompt projection.
// When an archived summary is already present in system context (e.g. after switching reception CLI
// mid-conversation), tightens raw turn replay budget so first-turn prefill stays fast.
std::size_t recommended_reception_history_budget(std::string_view engine_id,
                                                 std::string_view context_feature,
                                                 bool has_summary_in_system);

} // namespace dimension
