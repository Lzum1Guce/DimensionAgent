#pragma once

#include "dimension/model.hpp"
#include "dimension/model_routing.hpp"
#include "dimension/store.hpp"
#include "dimension/work_compaction.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <stop_token>
#include <stdexcept>
#include <string>
#include <vector>

namespace dimension {

struct WorkRouteUnavailable : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct RunExecutionContext {
    std::string run_id;
    std::string bot_id;
    std::string group_id;
    unsigned attempt = 1;
};

// Evidence comes from the trusted executor, never from model prose. An artifact
// may be a local path, record ID or URL that the executor actually produced.
struct ToolExecution {
    std::string result;
    bool error = false;
    Json metadata;
    std::vector<std::string> artifacts;
    std::string verification;
    // Attempt-local model input only: never serialized into receipts or events.
    std::vector<ModelImage> images;
    // Trusted executor control, bounded to 2000 UTF-8 bytes. After preserving
    // this result, interrupt the current input revision for explicit resume.
    // Reused receipts and results from a stale input revision cannot pause.
    std::string pause_reason;
};

using RunModelCaller = std::function<ModelReply(
    const ModelConfig&, const std::vector<ModelMessage>&,
    const std::vector<ModelTool>&, ModelChunk, std::stop_token)>;

struct RunCallbacks {
    RunModelCaller model; // Empty selects dimension::call_model.
    // Called only after a new event is durably committed. Loading old runs never
    // replays this callback; exceptions are isolated from task execution.
    std::function<void(const Json&)> event;
    std::function<ModelConfig(const RunExecutionContext&)> configuration;
    std::function<std::vector<ModelTool>(const RunExecutionContext&)> tools;
    std::function<ToolExecution(const ToolCall&, const RunExecutionContext&,
                                std::stop_token)> execute_tool;
    // Optional gate wrapper. Preferred over execute_tool when supplied. The
    // fourth token ALWAYS combines lifecycle + input steering for approval
    // waiting; the third preserves the configured actual-tool interruption
    // policy. Existing successful/uncertain receipts bypass both callbacks.
    std::function<ToolExecution(const ToolCall&, const RunExecutionContext&,
                                std::stop_token, std::stop_token)> authorize_and_execute_tool;
    std::function<std::string(const RunExecutionContext&)> system_prompt;
    std::function<std::string(const RunExecutionContext&)> memory;
    // Optional native multi-turn conversation history injected before the new user input
    // when starting a fresh Chat run, avoiding flat-text transcript stuffing.
    std::function<std::vector<ModelMessage>(const RunExecutionContext&)> initial_history;
    // Default false: repeated successful name+canonical-arguments are receipts,
    // not a second external action. Mark only known read-only tools true.
    std::function<bool(std::string_view)> is_read_only_tool;
    // Default false. A trusted narrow allowlist may repeat a completed action
    // with a NEW call ID (for example rebuilding changed project sources).
    // The same call ID always reuses its original receipt; any same-fingerprint
    // started/uncertain action still blocks a new execution. Only these tools
    // may mark an error finished using trusted metadata.execution_outcome_known
    // (a confirmed process exit). This never implies no_side_effects.
    std::function<bool(std::string_view)> repeat_completed_tool;
    // Optional durable action identity; default is name + '\n' + canonical JSON
    // arguments. Use to keep aliases/wrappers compatible with existing receipts.
    // Called outside the service lock after JSON validation, never for task_finish.
    // Must be deterministic, do no I/O, and return 1..131072 bytes. Exceptions or
    // invalid identities block execution. The original call/transcript is retained.
    std::function<std::string(const ToolCall&)> tool_fingerprint;
    // Default false preserves legacy file/plugin behavior. Selected tools receive
    // a token stopped by either lifecycle cancellation or this model generation's
    // steering. Their actual returned result still becomes a durable receipt.
    std::function<bool(std::string_view)> interrupt_tool_on_steer;
    // Optional attempt-frozen plan. Only explicitly configured higher routes
    // may follow the initial route. No tool calls are retried by escalation.
    std::function<Json(const RunExecutionContext&, const ModelRoute&, const std::vector<ModelMessage>&,
                       const std::string&, std::stop_token)> propose_routes;
    std::function<std::vector<ModelRoute>(const RunExecutionContext&)> model_routes;
    // Opt-in Work-only projection. The service preserves original messages and
    // receipts, commits summaries only for the current input revision, and
    // never invokes tools while summarizing. No callback means legacy behavior.
    std::function<WorkCompactionLimits(const RunExecutionContext&, const ModelConfig&)> compaction_limits;
    std::function<ModelConfig(const RunExecutionContext&, const ModelConfig&, const Json& last_successful_route)> compaction_configuration;
    RunModelCaller compaction_model;
    std::function<bool(const RunExecutionContext&)> direct_cli;
};

struct RunOptions {
    std::size_t max_context_chars = 120000;
    std::size_t max_saved_chars = 1800000;
    std::size_t max_input_chars = 64000;
    std::size_t max_tool_result_chars = 131072;
    // Zero explicitly disables the per-attempt round cap (Work). Generic/Chat
    // callers retain 24 unless they choose another finite cap or opt out.
    std::size_t max_tool_rounds = 24;
    std::size_t max_lanes = 128;
    bool require_verified_finish = true;
    // Defer all dispatch until start(), allowing an owning application to assign
    // its service pointer before callbacks from persisted queued work can run.
    bool start_paused = false;
    // Opt-in Work recovery, at most one discarded output-limit response per
    // explicit attempt. It keeps the configured token budget and never retries
    // tools or runs while an external side effect has an uncertain receipt.
    std::size_t max_output_limit_retries = 0;
    // Model text is separate from tool-result/argument budgets. Work may opt
    // into a larger bounded reply; this is a UTF-8 byte limit, not token count.
    std::size_t max_model_reply_chars = 131072;
    // Optional large Work storage profile. Defaults preserve the legacy/Chat
    // bounds. With a larger snapshot cap, max_saved_chars counts serialized
    // transcript bytes, including JSON escaping, rather than decoded text.
    std::size_t max_snapshot_bytes = 4U * 1024U * 1024U - 1024U;
    // Zero preserves legacy count-only pagination/full list text. A Work page
    // may contain one event larger than the target, never a partial event.
    std::size_t max_event_page_bytes = 0;
    std::size_t list_preview_chars = 0;
    // Opt-in 0.4.6 performance enhancements (default false preserves legacy unit test contracts):
    bool enable_parallel_readonly_tools = false;
    bool lazy_terminal_hydration = false;
    bool conversational_mode = false;
    bool auto_bind_verified_receipts = false;
};

struct RunSubmission {
    std::string run_id;
    unsigned attempt = 1;
    bool created = false;
    bool duplicate = false;
    bool steered = false;
    Json json() const;
};

// Owns its workers independently of HTTP/SSE observers. Callbacks run on lane
// workers and must cooperate with stop_token. A bot is serial across all groups;
// different bots execute concurrently. All callbacks finish before destruction.
// The module never starts a shell/process or invokes a tool without injection.
class RunService {
public:
    RunService(std::filesystem::path root, RunCallbacks callbacks,
               RunOptions options = {});
    ~RunService();
    RunService(const RunService&) = delete;
    RunService& operator=(const RunService&) = delete;

    void start(); // Idempotently enables dispatch after start_paused construction.

    // request_id is mandatory and idempotent within (bot,group). Default submit
    // steers a running/queued task in the lane; queue=true creates a later task.
    RunSubmission submit(const std::string& bot_id, const std::string& group_id,
                         const std::string& text, const std::string& request_id,
                         bool queue = false, Json input_context = {}, Json assigned_route = {}, bool plan_first = false);
    RunSubmission steer(const std::string& run_id, const std::string& text,
                        const std::string& request_id, Json input_context = {});
    Json cancel(const std::string& run_id);
    // Cancels every private run for this Bot without a history page limit.
    // Other Bots and group runs are untouched. A return only acknowledges the
    // stop request; use has_bot_activity to detect callbacks still unwinding.
    void cancel_private_bot(const std::string& bot_id);
    // Only terminal, stopped runs can be erased. Requests and tool fingerprints
    // remain as a tombstone so repeated submission cannot replay external work.
    Json erase(const std::string& run_id);
    // Terminal runs become a new attempt. Inputs, context and tool receipts stay.
    // An old callback must first have returned; otherwise resume rejects.
    RunSubmission resume(const std::string& run_id, const std::string& request_id,
                         const std::string& text = {}, Json input_context = {}, unsigned plan_attempt = 0, bool user_work = false);

    bool wait_until_terminal(const std::string& run_id, std::chrono::milliseconds timeout, std::stop_token stop) const;
    std::string cli_input(const std::string& run_id, std::size_t count) const;
    std::vector<std::string> input_texts(const std::string& run_id) const;
    Json brief_json(const std::string& run_id) const;
    Json get(const std::string& run_id) const;
    // Last measured Work projection or provider-reported Chat input usage.
    // JSON null means unknown. This never scans history or dispatches a model.
    Json context_usage(const std::string& run_id) const;
    // Trusted gate event only; does not change scheduling status. An obsolete
    // attempt cannot append UI approval events to a newer/terminal attempt.
    void approval_event(const RunExecutionContext&, const std::string& approval_id, bool waiting);
    // Appends a live sub-step event (e.g. native CLI stream step, broker enrichment, or member whisper)
    // to an active run attempt without altering scheduling state.
    void custom_event(const RunExecutionContext&, const std::string& type, Json data);
    Json list(const std::string& bot_id = {}, const std::string& group_id = {},
              std::size_t limit = 100) const;
    // Exact group match across all runs, including queued work and a callback
    // still unwinding after terminal status. Independent of history page caps.
    bool has_group_activity(const std::string& group_id) const;
    // Complete Bot-wide activity, including its groups, queued work, and a
    // callback still unwinding after terminal status. No history page cap.
    bool has_bot_activity(const std::string& bot_id) const;
    // One lock-consistent representative per Bot in this exact group. Active
    // work wins over newer history; callbacks still exiting report stopping.
    // Includes queuedCount and a step label derived from the real last event.
    Json group_status(const std::string& group_id) const;
    // Complete live selection for one Bot plus at most ten recent terminal
    // records. No history cap can hide an eligible private control target.
    Json bot_status(const std::string& bot_id) const;
    // Bounded private conversation snapshot, including every recorded public
    // response across explicit task continuations. No tools/thinking/receipts.
    // Unlike list(), this never silently applies the sidebar pagination limit.
    [[nodiscard]] std::vector<Message> private_conversation(const std::string& bot_id,
        std::size_t max_messages = 20000, std::size_t max_bytes = 4U * 1024U * 1024U) const;
    [[nodiscard]] bool request_applied(const std::string& run_id, const std::string& request_id) const;
    // nullopt means unused request; JSON null means a request without a quote.
    [[nodiscard]] std::optional<Json> request_context(const std::string& bot_id,
        const std::string& group_id, const std::string& request_id) const;
    // {events:[{seq,runId,attempt,type,status,time,data}], after, latest, terminal}.
    // after is exclusive. Segmented JSONL reads are bounded by limit (max 512).
    Json events_after(const std::string& run_id, std::uint64_t after = 0,
                      std::size_t limit = 256) const;
    Json wait_events(const std::string& run_id, std::uint64_t after,
                     std::chrono::milliseconds timeout = std::chrono::seconds(25),
                     std::stop_token stop = {}, std::size_t limit = 256) const;

    // Pausing affects queued work only. Reorder requires all currently queued
    // IDs for the lane exactly once; the running task is never preempted.
    Json pause_queue(const std::string& bot_id, const std::string& group_id,
                     bool paused);
    Json reorder_queue(const std::string& bot_id, const std::string& group_id,
                       const std::vector<std::string>& run_ids);

    // Requests cooperative interruption, joins workers, persists interrupted.
    // Subsequent work-creating operations reject. Safe to call repeatedly.
    void shutdown();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
