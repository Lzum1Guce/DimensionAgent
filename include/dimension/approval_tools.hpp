#pragma once
#include "dimension/approvals.hpp"

namespace dimension {
// Bounded adapter for the retained UI's explicit new-file write operation.
// No shell/model invocation. A pending response is acceptance, not completion.
// ApprovalService outlives this queue; shutdown joins every owned worker.
class ApprovalToolQueue {
public:
    explicit ApprovalToolQueue(ApprovalService&);
    ~ApprovalToolQueue();
    ApprovalToolQueue(const ApprovalToolQueue&) = delete;
    ApprovalToolQueue& operator=(const ApprovalToolQueue&) = delete;
    Json write(const std::string& bot, const std::filesystem::path& project_root,
               const std::string& relative, const std::string& content, ApprovalMode,
               const std::string& request_id);
    void shutdown() noexcept;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension

