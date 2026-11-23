#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <mutex>
#include <string>
#include <vector>

namespace dimension {

struct CollaborationOutcome {
    std::string from_bot_id;
    std::string to_bot_id;
    std::string group_id;
    std::string run_id;
    std::string status; // "completed" | "partial" | "failed"
    std::string task_summary;
    std::vector<std::string> artifact_names;
};

// Manages per-Bot workstation capability cards (role tags, specialties,
// equipped CLI/software tools, handoff contract) and directed cross-Bot
// collaboration records (Plan Section 9).
class BotCapabilityService {
public:
    explicit BotCapabilityService(std::filesystem::path storage_file);

    Json get_all() const;
    Json get_card(const std::string& bot_id) const;
    Json save_card(const std::string& bot_id, const Json& card);

    void record_collaboration(const CollaborationOutcome& outcome);
    Json add_collaboration_note(const std::string& from_bot_id,
                                const std::string& to_bot_id,
                                const std::string& note);

    // Builds a bounded (< 1200 bytes) prompt snippet summarizing each group
    // member's equipped workstation tools, specialties, and recent handoff
    // track record with `lead_bot_id`.
    std::string group_dispatch_prompt(const std::string& lead_bot_id,
                                      const std::vector<std::string>& member_ids) const;

private:
    std::filesystem::path storage_file_;
    mutable std::mutex mutex_;
    Json document_;

    void load();
    void save_unlocked() const;
};

} // namespace dimension
