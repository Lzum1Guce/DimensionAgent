#pragma once

#include "dimension/json.hpp"

#include <chrono>
#include <cstddef>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <string_view>

namespace dimension {

enum class ApprovalMode { Full, Auto, Ask };
enum class ApprovalState { Pending, Approved, Rejected, Cancelled, Stale };

ApprovalMode approval_mode(std::string_view value);
std::string approval_mode_name(ApprovalMode value);
std::string approval_state_name(ApprovalState value);

class ApprovalError final : public std::runtime_error {
public:
    ApprovalError(int status, std::string code, std::string message);
    int status() const noexcept { return status_; }
    const std::string& code() const noexcept { return code_; }
private:
    int status_;
    std::string code_;
};

struct ApprovalLimits {
    // Active rows only; retired records keep immutable, keyed replay tombstones.
    std::size_t max_records = 256;
    std::size_t max_pending = 64;
    std::size_t max_snapshot_bytes = 4U * 1024U * 1024U;
    std::size_t max_arguments_bytes = 128U * 1024U;
    std::size_t max_display_bytes = 4096;
    std::size_t max_result_bytes = 4096;
    std::chrono::milliseconds lifetime = std::chrono::minutes(15);
};

struct ApprovalRequest {
    std::string bot_id;
    std::string run_id;
    unsigned attempt = 1;
    // Stable identity of this invocation, e.g. ToolCall.id, NOT a filename.
    std::string action_id;
    std::string tool;
    std::string arguments; // Object JSON; canonicalized and SHA-256 hashed.
    // Classified by the trusted executor. Model/UI action.risk is display only.
    bool high_risk = true;
    // Bounded, redacted UI summary. The service overwrites its "tool" field.
    Json action = Json::Object{};
};

struct ApprovalTicket {
    std::string id;
    std::string binding;
    // Process instance binding, deliberately never serialized or sent over HTTP.
    std::string session;
};

struct ApprovalGrant {
    bool allowed = false;
    ApprovalState state = ApprovalState::Stale;
    std::string reason;
    Json record;
};

// Windows native store. The absolute LOCAL data directory is supplied only by
// trusted application configuration. Its ancestors are pinned against renaming;
// junctions/reparse points, multi-link files and a second writer are rejected.
// Uses fixed approvals.json / approvals.lock, immutable archive/by-id + by-action
// records with validated/hash filenames, and owned random temporary files.
// This module NEVER invokes a tool, starts a process or treats UI approval as a
// substitute for the executor's existing path/sandbox/ownership checks.
class ApprovalService {
public:
    explicit ApprovalService(std::filesystem::path root, ApprovalLimits limits = {});
    ~ApprovalService();
    ApprovalService(const ApprovalService&) = delete;
    ApprovalService& operator=(const ApprovalService&) = delete;

    // A stoppable token is required and MUST combine run stop + input steering.
    // Idempotent within bot/run/attempt/action_id. Changed tool/args/risk/mode or
    // display under the same invocation is a conflict, never a new authorization.
    ApprovalTicket request(const ApprovalRequest&, ApprovalMode, std::stop_token);

    // Waits without holding application/RunService locks. Only the first matching
    // caller can durably consume an approved permit. Every other caller returns
    // allowed=false, including retries after a successful claim. A stop after
    // this linearization point cannot undo an already started external action.
    ApprovalGrant wait_and_consume(const ApprovalTicket&, const ApprovalRequest& expected,
                                  std::stop_token stop = {});

    // HTTP decision only; never runs the tool. Exact pending id + owning Bot.
    // Same decision retry is idempotent; conflicting/expired decisions reject.
    Json decide(std::string_view id, std::string_view bot_id, bool allow);
    Json get(std::string_view id, std::string_view bot_id);
    // Returns an ARRAY; HTTP wraps this as {"pending": service.list(bot)}.
    // pending_only=false includes active rows, not the retired on-disk archive.
    // Individual archived IDs remain available through get().
    Json list(std::string_view bot_id, bool pending_only = true);

    // Revoke unconsumed requests/decisions. Does not erase consumed action audit
    // or pretend an already claimed action has been rolled back.
    std::size_t invalidate_run(std::string_view bot_id, std::string_view run_id,
                              std::optional<unsigned> attempt = {},
                              ApprovalState state = ApprovalState::Stale);

    // Optional bounded trusted execution summary (not full model/tool logs).
    // Must follow a successful consume in this process. Idempotent same result.
    Json complete(const ApprovalTicket&, const ApprovalRequest& expected, const Json& outcome);

    // Persist cancellation and wake waiters. Call before draining workers.
    // Destructor requires callers/waiters already joined; it does not auto-allow
    // or erase pending records. Reopening makes old pending/approved records stale.
    void shutdown();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension

