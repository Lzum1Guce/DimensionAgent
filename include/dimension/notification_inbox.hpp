#pragma once
#include "dimension/json.hpp"
#include <cstddef>
#include <filesystem>
#include <mutex>
#include <string>
#include <vector>

namespace dimension {

// Durable, bounded history of trusted Work notification events. Records are
// newest-first. Persistence is committed before the in-memory snapshot changes.
class NotificationInbox {
public:
    static constexpr std::size_t default_limit = 500;

    explicit NotificationInbox(std::filesystem::path file, std::size_t limit = default_limit);

    // Returns false when this exact real event ID is already retained.
    bool add(const Json& notification);
    // Resolve only existing resource/takeover records; never creates a record.
    std::size_t resolve_waiting(const std::string& run_id, const std::string& time);
    bool mark_read(const std::string& event_id);
    std::size_t mark_all_read();

    Json list(bool unread_only = false) const;
    std::size_t unread_count() const;
    std::size_t size() const;

private:
    void load();
    void persist(const std::vector<Json>& records) const;

    std::filesystem::path file_;
    std::size_t limit_;
    mutable std::mutex mutex_;
    std::vector<Json> records_;
};

} // namespace dimension
