#pragma once

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <stop_token>
#include <string>
#include <vector>

namespace dimension {

struct Job {
    std::string id;
    std::string bot_id;
    std::vector<std::string> dependencies;
};

enum class JobState {
    queued,
    waiting,
    running,
    completed,
    failed,
    blocked,
    cancelled
};

struct Result {
    JobState state;
    std::string detail;
};

using Worker = std::function<Result(const Job&, std::stop_token)>;
using Event = std::function<void(const std::string&, JobState, const std::string&)>;

inline constexpr std::size_t max_plan_jobs = 256;

// Validates the complete plan before any job is submitted.
std::vector<std::size_t> job_dependency_order(const std::vector<Job>& jobs);

const char* job_state_name(JobState state) noexcept;

// Synchronous coordination: callbacks run on this function's calling thread;
// workers run concurrently. All worker threads are joined before return.
std::map<std::string, Result> execute_plan(
    const std::vector<Job>& jobs,
    Worker worker,
    Event event = {},
    std::stop_token stop = {},
    std::size_t max_parallel = 8);

struct InputMessage {
    std::uint64_t sequence;
    std::string text;
};

// An append-only in-memory broadcast log. Give each subscriber its own cursor.
// Cursor 0 reads all retained input; latest_sequence() subscribes to future input.
// Cursors must not be shared between concurrently reading threads.
class InputInbox {
public:
    using Cursor = std::uint64_t;

    InputInbox() = default;
    InputInbox(const InputInbox&) = delete;
    InputInbox& operator=(const InputInbox&) = delete;

    std::uint64_t publish(std::string text);
    std::uint64_t latest_sequence() const;

    // Return every message after cursor, then advance it to the last message.
    // A cursor beyond the current sequence is invalid.
    std::vector<InputMessage> read_after(Cursor& cursor) const;

    // Wait for data or cancellation without polling. Cancellation returns an
    // empty vector and leaves cursor unchanged, including when data is present.
    std::vector<InputMessage> wait_after(Cursor& cursor, std::stop_token stop = {});

private:
    std::vector<InputMessage> read_locked(Cursor& cursor) const;

    mutable std::mutex mutex_;
    std::condition_variable_any available_;
    std::vector<InputMessage> messages_;
    std::uint64_t latest_ = 0;
};

} // namespace dimension
