#include "dimension/scheduler.hpp"

#include <algorithm>
#include <exception>
#include <limits>
#include <optional>
#include <set>
#include <stdexcept>
#include <thread>
#include <utility>

namespace dimension {
namespace {

bool terminal(JobState state) noexcept {
    return state == JobState::completed || state == JobState::failed ||
           state == JobState::blocked || state == JobState::cancelled;
}

bool pending(JobState state) noexcept {
    return state == JobState::queued || state == JobState::waiting;
}

struct Graph {
    std::vector<std::vector<std::size_t>> prerequisites;
    std::vector<std::size_t> downstream_length;
    std::vector<std::size_t> order;
};

Graph validate(const std::vector<Job>& jobs, std::size_t max_parallel) {
    if (jobs.size() > max_plan_jobs) {
        throw std::invalid_argument("plan exceeds the 256-job limit");
    }
    if (max_parallel == 0) {
        throw std::invalid_argument("max_parallel must be positive");
    }

    const auto count = jobs.size();
    std::map<std::string, std::size_t> indices;
    for (std::size_t i = 0; i < count; ++i) {
        if (jobs[i].id.empty() || jobs[i].bot_id.empty()) {
            throw std::invalid_argument("job id and bot_id must be nonempty");
        }
        if (!indices.emplace(jobs[i].id, i).second) {
            throw std::invalid_argument("duplicate job id: " + jobs[i].id);
        }
    }

    Graph graph{std::vector<std::vector<std::size_t>>(count),
                std::vector<std::size_t>(count, 0), {}};
    std::vector<std::vector<std::size_t>> successors(count);
    std::vector<std::size_t> remaining(count, 0);
    for (std::size_t i = 0; i < count; ++i) {
        std::set<std::size_t> seen;
        for (const auto& dependency : jobs[i].dependencies) {
            const auto found = indices.find(dependency);
            if (found == indices.end()) {
                throw std::invalid_argument("unknown dependency for " + jobs[i].id + ": " + dependency);
            }
            const auto source = found->second;
            if (source == i) {
                throw std::invalid_argument("self dependency: " + jobs[i].id);
            }
            if (!seen.insert(source).second) {
                throw std::invalid_argument("duplicate dependency for " + jobs[i].id + ": " + dependency);
            }
            graph.prerequisites[i].push_back(source);
            successors[source].push_back(i);
            ++remaining[i];
        }
    }

    auto& order = graph.order;
    order.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        if (remaining[i] == 0) {
            order.push_back(i);
        }
    }
    for (std::size_t cursor = 0; cursor < order.size(); ++cursor) {
        for (const auto successor : successors[order[cursor]]) {
            if (--remaining[successor] == 0) {
                order.push_back(successor);
            }
        }
    }
    if (order.size() != count) {
        throw std::invalid_argument("dependency cycle in plan");
    }
    for (auto item = order.rbegin(); item != order.rend(); ++item) {
        for (const auto successor : successors[*item]) {
            graph.downstream_length[*item] = std::max(
                graph.downstream_length[*item], graph.downstream_length[successor] + 1);
        }
    }
    return graph;
}

// Declared after the thread collection, so cancellation precedes its joining
// destructors even if coordination exits through an unexpected exception.
struct StopBeforeJoin {
    std::stop_source& source;
    ~StopBeforeJoin() { source.request_stop(); }
};

} // namespace

std::vector<std::size_t> job_dependency_order(const std::vector<Job>& jobs) {
    return validate(jobs, 1).order;
}

const char* job_state_name(JobState state) noexcept {
    switch (state) {
    case JobState::queued: return "queued";
    case JobState::waiting: return "waiting";
    case JobState::running: return "running";
    case JobState::completed: return "completed";
    case JobState::failed: return "failed";
    case JobState::blocked: return "blocked";
    case JobState::cancelled: return "cancelled";
    }
    return "unknown";
}

std::map<std::string, Result> execute_plan(
    const std::vector<Job>& jobs,
    Worker worker,
    Event event,
    std::stop_token stop,
    std::size_t max_parallel) {
    const auto graph = validate(jobs, max_parallel);
    if (!jobs.empty() && !worker) {
        throw std::invalid_argument("worker callback is required");
    }
    const auto count = jobs.size();
    std::vector<Result> results(count, Result{JobState::queued, "queued"});
    std::mutex completion_mutex;
    std::condition_variable completion_available;
    std::vector<std::optional<Result>> completions(count);
    std::stop_source plan_stop;
    std::vector<std::jthread> threads(count);
    StopBeforeJoin stop_before_join{plan_stop};
    std::stop_callback forward_stop(stop, [&] {
        plan_stop.request_stop();
        // Pair with the coordinator's wait lock, including the interval
        // between its predicate check and entering the wait.
        {
            std::lock_guard lock(completion_mutex);
        }
        completion_available.notify_one();
    });
    std::set<std::string> busy_bots;
    std::size_t active = 0;
    bool cancellation_handled = false;

    const auto transition = [&](std::size_t index, Result result) {
        results[index] = std::move(result);
        if (!event) {
            return;
        }
        try {
            event(jobs[index].id, results[index].state, results[index].detail);
        } catch (const std::exception& error) {
            results[index] = {JobState::failed, "event callback threw: " + std::string(error.what())};
        } catch (...) {
            results[index] = {JobState::failed, "event callback threw an unknown exception"};
        }
    };

    const auto cancelled = [&] {
        return plan_stop.stop_requested() || stop.stop_requested();
    };

    // Propagate terminal failures and readiness until no more states change.
    // This also handles an event callback failing during a readiness event.
    const auto settle_pending = [&] {
        bool changed;
        do {
            changed = false;
            for (std::size_t i = 0; i < count; ++i) {
                if (!pending(results[i].state)) {
                    continue;
                }
                bool ready = true;
                std::optional<std::size_t> unsuccessful;
                for (const auto prerequisite : graph.prerequisites[i]) {
                    const auto state = results[prerequisite].state;
                    if (terminal(state) && state != JobState::completed) {
                        unsuccessful = prerequisite;
                        break;
                    }
                    ready = ready && state == JobState::completed;
                }
                if (unsuccessful) {
                    transition(i, {JobState::blocked,
                                   "dependency did not complete: " + jobs[*unsuccessful].id});
                    changed = true;
                } else if (ready && results[i].state == JobState::waiting) {
                    transition(i, {JobState::queued, "dependencies completed"});
                    changed = true;
                } else if (!ready && results[i].state == JobState::queued) {
                    transition(i, {JobState::waiting, "waiting for dependencies"});
                    changed = true;
                }
            }
        } while (changed);
    };

    for (std::size_t i = 0; i < count; ++i) {
        transition(i, {JobState::queued, "queued"});
    }

    while (true) {
        // Read only available completions; an unrelated slow job never holds
        // back a finished job's dependents.
        for (std::size_t i = 0; i < count; ++i) {
            std::optional<Result> finished;
            {
                std::lock_guard lock(completion_mutex);
                finished.swap(completions[i]);
            }
            if (finished) {
                threads[i].join();
                --active;
                busy_bots.erase(jobs[i].bot_id);
                transition(i, std::move(*finished));
            }
        }

        if (cancelled() && !cancellation_handled) {
            plan_stop.request_stop();
            cancellation_handled = true;
            for (std::size_t i = 0; i < count; ++i) {
                if (pending(results[i].state)) {
                    transition(i, {JobState::cancelled, "plan cancelled before execution"});
                }
            }
        }
        if (!cancellation_handled) {
            settle_pending();
        }

        while (active < max_parallel && !cancelled()) {
            settle_pending();
            if (cancelled()) {
                break;
            }
            std::optional<std::size_t> next;
            for (std::size_t i = 0; i < count; ++i) {
                if (results[i].state != JobState::queued || busy_bots.contains(jobs[i].bot_id)) {
                    continue;
                }
                if (!next || graph.downstream_length[i] > graph.downstream_length[*next]) {
                    next = i;
                }
            }
            if (!next) {
                break;
            }
            const auto index = *next;
            transition(index, {JobState::running, "running"});
            if (results[index].state != JobState::running) {
                continue;
            }
            // A synchronous event is allowed to request cancellation.
            if (cancelled()) {
                transition(index, {JobState::cancelled, "plan cancelled before execution"});
                break;
            }
            busy_bots.insert(jobs[index].bot_id);
            try {
                threads[index] = std::jthread([&, index] {
                    Result result{JobState::cancelled, "plan cancelled before worker started"};
                    if (!plan_stop.stop_requested() && !stop.stop_requested()) {
                        try {
                            result = worker(jobs[index], plan_stop.get_token());
                            if (!terminal(result.state)) {
                                result = {JobState::failed, "worker returned a nonterminal state"};
                            }
                        } catch (const std::exception& error) {
                            result = {JobState::failed, "worker callback threw: " + std::string(error.what())};
                        } catch (...) {
                            result = {JobState::failed, "worker callback threw an unknown exception"};
                        }
                    }
                    {
                        std::lock_guard lock(completion_mutex);
                        completions[index] = std::move(result);
                    }
                    completion_available.notify_one();
                });
                ++active;
            } catch (const std::exception& error) {
                busy_bots.erase(jobs[index].bot_id);
                transition(index, {JobState::failed, "could not start worker: " + std::string(error.what())});
            } catch (...) {
                busy_bots.erase(jobs[index].bot_id);
                transition(index, {JobState::failed, "could not start worker: unknown exception"});
            }
        }

        if (active == 0) {
            const bool all_terminal = std::all_of(results.begin(), results.end(),
                [](const Result& result) { return terminal(result.state); });
            if (all_terminal) {
                break;
            }
            // Cancellation may have arrived during dispatch or its event.
            if (cancelled()) {
                continue;
            }
            throw std::logic_error("validated plan has pending jobs but no runnable work");
        }

        std::unique_lock lock(completion_mutex);
        completion_available.wait(lock, [&] {
            return (!cancellation_handled && cancelled()) ||
                   std::any_of(completions.begin(), completions.end(),
                       [](const auto& completion) { return completion.has_value(); });
        });
    }

    std::map<std::string, Result> result_by_id;
    for (std::size_t i = 0; i < count; ++i) {
        result_by_id.emplace(jobs[i].id, std::move(results[i]));
    }
    return result_by_id;
}

std::uint64_t InputInbox::publish(std::string text) {
    std::uint64_t sequence;
    {
        std::lock_guard lock(mutex_);
        if (latest_ == std::numeric_limits<std::uint64_t>::max()) {
            throw std::overflow_error("input sequence exhausted");
        }
        sequence = latest_ + 1;
        messages_.push_back({sequence, std::move(text)});
        latest_ = sequence;
    }
    available_.notify_all();
    return sequence;
}

std::uint64_t InputInbox::latest_sequence() const {
    std::lock_guard lock(mutex_);
    return latest_;
}

std::vector<InputMessage> InputInbox::read_locked(Cursor& cursor) const {
    if (cursor > latest_) {
        throw std::invalid_argument("input cursor is beyond the latest sequence");
    }
    const auto begin = std::upper_bound(messages_.begin(), messages_.end(), cursor,
        [](std::uint64_t sequence, const InputMessage& message) {
            return sequence < message.sequence;
        });
    std::vector<InputMessage> result(begin, messages_.end());
    if (!result.empty()) {
        cursor = result.back().sequence;
    }
    return result;
}

std::vector<InputMessage> InputInbox::read_after(Cursor& cursor) const {
    std::lock_guard lock(mutex_);
    return read_locked(cursor);
}

std::vector<InputMessage> InputInbox::wait_after(Cursor& cursor, std::stop_token stop) {
    std::unique_lock lock(mutex_);
    if (cursor > latest_) {
        throw std::invalid_argument("input cursor is beyond the latest sequence");
    }
    available_.wait(lock, stop, [&] { return latest_ > cursor; });
    if (stop.stop_requested()) {
        return {};
    }
    return read_locked(cursor);
}

} // namespace dimension
