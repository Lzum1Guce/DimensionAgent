#pragma once
#include "dimension/runs.hpp"
#include <filesystem>
#include <functional>
#include <memory>
#include <stdexcept>

namespace dimension {
class ApplicationBridgeError : public std::runtime_error {
  public:
    int status;
    bool no_side_effects;
    ApplicationBridgeError(int status, std::string message, bool no_side_effects = false)
        : std::runtime_error(std::move(message)), status(status), no_side_effects(no_side_effects) {}
};
struct ApplicationBridgeCallbacks {
    std::function<Json(const std::string&, std::stop_token)> status;
    std::function<Json(const std::string&, const Json&, std::stop_token)> action;
    std::function<Json(const std::string&, const Json&, std::stop_token)> downloads;
    // A real queued application job with its current blockers. Called before
    // the executor waits, so resource feedback is timely and evidence-based.
    std::function<void(const Json&)> waiting;
    // Actual decoder validation; returns mime/width/height. No URL fetching.
    std::function<Json(std::string_view)> inspect_image;
};
// Shared application accounts have their own desktop identity. Bot identities,
// private browser profiles and source accounts are never reused or copied.
class ApplicationBridge {
  public:
    ApplicationBridge(std::filesystem::path root, std::filesystem::path workspaces, ApplicationBridgeCallbacks);
    ~ApplicationBridge();
    Json list() const;
    Json app(const std::string&) const;
    Json register_app(const Json&);
    Json update_app(const std::string&, const Json&);
    Json status(const std::string&, std::stop_token = {});
    std::string desktop_id(const std::string&) const;
    Json job(const std::string&) const;
    Json resume(const std::string&);
    Json cancel(const std::string&);
    // Called from the owner's existing harvest loop with actual run snapshots.
    void reconcile(const std::function<Json(const std::string&)>& run_state);
    std::filesystem::path file(const std::string&, std::size_t) const;
    std::vector<ModelTool> tools() const;
    ToolExecution execute(const ToolCall&, const RunExecutionContext&, std::stop_token);
    void shutdown();
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
