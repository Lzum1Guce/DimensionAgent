#pragma once

#include "dimension/json.hpp"
#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>

namespace dimension {

class ProactiveReminderError final : public std::runtime_error {
public:
    ProactiveReminderError(int status, std::string message)
        : std::runtime_error(std::move(message)), status(status) {}
    int status;
};

struct ProactiveReminderOptions {
    std::filesystem::path storage_file;
    // Injectable Unix-epoch milliseconds. Tests never need to sleep.
    std::function<std::int64_t()> now;
    // The only delivery callback. Draft rules do not invoke it.
    std::function<void(const Json&)> notify;
    // Quiet time drops the current occurrence without charging budget or replaying it.
    std::function<bool()> do_not_disturb;
    // Opt-in bounded extensions wired by Application: read-only project change
    // inspection, live progress digest, and explicitly authorized queued Work.
    bool enable_extended_modes = false;
    std::function<Json(const std::string& project_path, const std::string& previous_digest)> inspect_project;
    std::function<Json(const Json& scope, const std::string& previous_digest)> dynamic_progress;
    std::function<std::string(const Json& rule, const std::string& detail)> dispatch_work;
};

// Small, explicitly scoped reminder rules. This class has no model, Work, file-tool,
// network or external-delivery dependency. Its only writes are atomic replacements
// of storage_file; scheduler events enter through observe() as read-only snapshots.
class ProactiveReminderService {
public:
    explicit ProactiveReminderService(ProactiveReminderOptions options);

    Json capabilities() const;
    Json rules() const;
    Json rule(const std::string& id) const;
    Json create(const Json& input);
    Json update(const std::string& id, const Json& input);
    Json set_enabled(const std::string& id, bool enabled, const Json& input = Json(Json::Object{}));
    Json remove(const std::string& id, const Json& input = Json(Json::Object{}));

    // Both methods persist trigger/dedup state before any notification callback.
    void observe(const Json& scheduler_event);
    void tick();

private:
    ProactiveReminderOptions options_;
    std::filesystem::path storage_file_;
    Json document_;
    mutable std::mutex mutex_;

    std::int64_t now() const;
    void load();
    Json normalized_rule(const Json& input, const Json* existing = nullptr) const;
    void deliver(const Json& rule, std::int64_t event_time, std::int64_t missed,
                 const std::string& event_key) const;
};

} // namespace dimension
