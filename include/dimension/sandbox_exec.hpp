#pragma once
#include "dimension/json.hpp"
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <stop_token>
#include <string>
#include <vector>
namespace dimension {
struct SandboxExecOptions {
    std::filesystem::path data, wsl, helper;
    std::string distribution;
    bool allow_network_mode = false;
    std::size_t max_concurrency = 1;
};
struct SandboxOutputFile {
    std::filesystem::path path;
    std::uint64_t size_bytes = 0;
};
// Diagnostic verifier for tests and pre-download checks. Execution itself copies
// from an open verified source handle into a task snapshot; it never validates a
// pathname and then reopens that pathname as the artifact source.
SandboxOutputFile verify_sandbox_output(const std::filesystem::path& project,
                                        const std::string& relative);
// Merge the peer result with the final host-owned transport exit. Exposed for
// deterministic cleanup_failed/process_exit fault-injection tests.
Json normalize_sandbox_transport(const Json& result, const Json& transport_exit);
// Every call gets a fresh PID/mount namespace and volatile HOME. Network access
// is not available: the payload always receives an isolated loopback namespace.
// A root supervisor applies per-execution cgroup-v2 memory/swap, CPU and PID
// limits. Workspace writes still have no aggregate quota and are not claimed to.
class SandboxExecutor {
public:
    explicit SandboxExecutor(SandboxExecOptions options);
    bool available() const;
    Json execute(const std::filesystem::path& project, bool network,
                 const Json& request, std::stop_token stop = {},
                 const std::filesystem::path& task_snapshot_root = {}, bool wait_for_slot = true);
private:
    SandboxExecOptions options_;
    std::mutex admission_mutex_;
    std::condition_variable_any admission_changed_;
    std::size_t active_executions_ = 0;
};
}
