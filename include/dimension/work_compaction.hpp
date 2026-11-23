#pragma once

#include "dimension/model.hpp"
#include <cstddef>
#include <functional>
#include <stop_token>
#include <string>
#include <vector>

namespace dimension {

// Local heuristic only, never a provider tokenizer/billing claim. Text uses
// ceil(UTF-8 bytes / 4) plus fixed message/call envelopes; images use the same
// validated-image reserve as model transport. The full tool schema is counted.
// work_tool_tokens always includes a fixed 512-token protocol reserve, including
// the empty catalog. work_context_tokens adds it exactly once.
std::size_t work_message_tokens(const ModelMessage& message);
std::size_t work_tool_tokens(const std::vector<ModelTool>& tools);
std::size_t work_context_tokens(const std::vector<ModelMessage>& messages,
                                const std::vector<ModelTool>& tools = {});

struct WorkCompactionLimits {
    bool enabled = true;
    std::size_t context_tokens = 1048576;
    std::size_t output_tokens = 262144;
    std::size_t buffer_tokens = 65536;
    std::size_t summary_output_tokens = 65536;
    // Zero means the current context_tokens. Set the actual summarizer's
    // capacity when using the last successful model after a route change.
    std::size_t summary_context_tokens = 0;
    std::size_t tool_tokens = 512;
    // Optional additional UTF-8 request bound (not a token window).
    std::size_t context_chars = 0;
    // Independent text + thinking byte bound, not a tokenizer conversion.
    std::size_t max_summary_chars = 1024U * 1024U;
};

// Indices refer to the ORIGINAL append-only transcript. Neither that transcript
// nor any tool receipt is ever rewritten by this module. Persist this value
// alongside the original transcript in the same durable snapshot transaction.
struct WorkCompactionState {
    std::size_t summarized_through = 0;
    std::size_t pruned_through = 0;
    std::string summary;
    std::string prefix_digest;
    // A failed/no-gain source is not sent repeatedly. A different source/policy
    // may be tried; steering cancellation never installs an attempted marker.
    std::string last_attempt_digest;
};

Json work_compaction_state_json(const WorkCompactionState& state);
WorkCompactionState work_compaction_state_from_json(const Json& value);

// A bad/stale saved prefix is ignored, never substituted into different work.
// Does not invoke a model, tool, file, or other external action.
std::vector<ModelMessage> work_compacted_messages(const std::vector<ModelMessage>& source,
                                                 const WorkCompactionState& state);

enum class WorkCompactionMode { Automatic, ContextOverflow };
using WorkCompactionCaller = std::function<ModelReply(
    const ModelConfig&, const std::vector<ModelMessage>&,
    const std::vector<ModelTool>&, ModelChunk, std::stop_token)>;

struct WorkCompactionResult {
    // disabled/not_needed/pruned/summarized/no_progress/failed/cancelled/
    // invalid_policy/invalid_context. Provider exceptions are fixed reasons,
    // never copied verbatim to a task event or durable summary.
    std::string status = "not_needed", reason;
    WorkCompactionState state;
    std::vector<ModelMessage> messages;
    bool changed = false;
    bool within_budget = true;
    std::size_t before_tokens = 0, after_tokens = 0;
    std::size_t trigger_tokens = 0, input_limit_tokens = 0;
    std::size_t pruned_results = 0, model_calls = 0;
};

// Automatic trigger: floor(min(0.8 W, W-O-B)); recent complete-unit tail:
// floor(0.16 (W-O)). Under pressure first prune tool result strings >8192
// Unicode code points to 4096 head + our own marker + 1024 tail. If that is
// enough no summarizer runs. Otherwise summarize an old balanced prefix, with
// at most one additional pass. Summary requests have NO tools. System messages,
// the first/latest user requirements, the latest image-bearing user message,
// and recent tool batches remain exact.
// Exact provider overflow caps that tail at 16% of current history, since the
// real window may be smaller than configured; the newest unit remains intact.
// A summary is an explicitly delimited USER history-reference message, not new
// authority. Empty, over-budget, truncated, tool-bearing, and nonshrinking model
// replies are rejected without altering the original transcript/state.
// Reduction includes image reserves. Added summary text is allowed when it
// reduces estimated tokens and does not introduce/worsen a UTF-8 byte overflow.
//
// RunService must snapshot source/revision under its lock, call this OUTSIDE the
// lock using its steer+lifecycle stop token, and commit result.state only if the
// same revision/attempt is still current. Cancellation returns the prior state.
// A failed summarizer must not fail or replay the original task. A hard context
// overflow retry is the caller's responsibility, only once and only if changed.
WorkCompactionResult compact_work_context(const std::vector<ModelMessage>& source,
    const WorkCompactionState& prior, const WorkCompactionLimits& limits,
    const ModelConfig& summary_config, const WorkCompactionCaller& caller,
    std::stop_token stop = {}, WorkCompactionMode mode = WorkCompactionMode::Automatic);

} // namespace dimension
