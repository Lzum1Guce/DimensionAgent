#include "dimension/scheduler.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <latch>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace dimension;

void check(bool condition, const char* expression, int line) {
    if (!condition) {
        throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
    }
}

#define CHECK(expression) check(static_cast<bool>(expression), #expression, __LINE__)

template <class Function>
void expect_invalid(Function function) {
    bool rejected = false;
    try {
        function();
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    CHECK(rejected);
}

void check_completed(const std::map<std::string, Result>& results) {
    for (const auto& [id, result] : results) {
        if (result.state != JobState::completed) {
            throw std::runtime_error(id + " ended " + job_state_name(result.state) + ": " + result.detail);
        }
    }
}

void update_peak(std::atomic<int>& peak, int value) {
    auto seen = peak.load();
    while (seen < value && !peak.compare_exchange_weak(seen, value)) {
    }
}

void validation_happens_before_callbacks() {
    std::atomic<int> calls = 0;
    int events = 0;
    const auto worker = [&](const Job&, std::stop_token) {
        ++calls;
        return Result{JobState::completed, "ok"};
    };
    const auto event = [&](const std::string&, JobState, const std::string&) { ++events; };
    const std::vector<std::vector<Job>> invalid_plans{
        {{"same", "a", {}}, {"same", "b", {}}},
        {{"known", "a", {}}, {"other", "b", {"missing"}}},
        {{"self", "a", {"self"}}},
        {{"independent", "a", {}}, {"a", "b", {"c"}},
         {"b", "c", {"a"}}, {"c", "d", {"b"}}},
        {{"", "a", {}}},
        {{"a", "", {}}},
        {{"a", "a", {}}, {"b", "b", {"a", "a"}}}
    };
    for (const auto& jobs : invalid_plans) {
        expect_invalid([&] { execute_plan(jobs, worker, event); });
        expect_invalid([&] { dimension::job_dependency_order(jobs); });
    }
    const std::vector<Job> reversed{{"review","a",{"draft"}},{"draft","b",{"research"}},{"research","c",{}}};
    const std::vector<std::size_t> expected{2, 1, 0};
    CHECK(dimension::job_dependency_order(reversed) == expected);
    std::vector<Job> too_many;
    for (std::size_t i = 0; i <= max_plan_jobs; ++i) {
        too_many.push_back({std::to_string(i), "bot", {}});
    }
    expect_invalid([&] { execute_plan(too_many, worker, event); });
    expect_invalid([&] { execute_plan({{"a", "a", {}}}, worker, event, {}, 0); });
    expect_invalid([&] { execute_plan({{"a", "a", {}}}, {}, event); });
    CHECK(calls == 0);
    CHECK(events == 0);
    CHECK(execute_plan({}, {}).empty());
}

void independent_jobs_overlap_and_events_stay_on_coordinator() {
    std::latch both_entered(2);
    std::atomic<int> active = 0;
    std::atomic<int> peak = 0;
    const auto coordinator = std::this_thread::get_id();
    std::vector<std::string> events;
    const auto results = execute_plan({{"one", "bot-one", {}}, {"two", "bot-two", {}}},
        [&](const Job&, std::stop_token) {
            CHECK(std::this_thread::get_id() != coordinator);
            update_peak(peak, ++active);
            both_entered.count_down();
            both_entered.wait();
            --active;
            return Result{JobState::completed, "overlapped"};
        },
        [&](const std::string& id, JobState state, const std::string&) {
            CHECK(std::this_thread::get_id() == coordinator);
            events.push_back(id + ":" + job_state_name(state));
        }, {}, 2);
    check_completed(results);
    CHECK(active == 0);
    CHECK(peak == 2);
    CHECK(events.size() == 6);
}

void concurrency_limit_is_respected() {
    std::latch first_pair_entered(2);
    std::mutex mutex;
    std::condition_variable release_changed;
    bool released = false;
    std::atomic<int> entered = 0;
    std::atomic<int> active = 0;
    std::atomic<int> peak = 0;
    int dispatched = 0;
    std::jthread releaser([&] {
        first_pair_entered.wait();
        {
            std::lock_guard lock(mutex);
            released = true;
        }
        release_changed.notify_all();
    });
    const auto results = execute_plan({{"a", "a", {}}, {"b", "b", {}},
                                       {"c", "c", {}}, {"d", "d", {}}},
        [&](const Job&, std::stop_token) {
            update_peak(peak, ++active);
            if (entered.fetch_add(1) < 2) {
                first_pair_entered.count_down();
            }
            {
                std::unique_lock lock(mutex);
                release_changed.wait(lock, [&] { return released; });
            }
            --active;
            return Result{JobState::completed, "ok"};
        },
        [&](const std::string&, JobState state, const std::string&) {
            if (state == JobState::running) {
                ++dispatched;
                CHECK(dispatched <= 2);
            } else if (state == JobState::completed) {
                --dispatched;
            }
        }, {}, 2);
    releaser.join();
    check_completed(results);
    CHECK(entered == 4);
    CHECK(active == 0);
    CHECK(peak == 2);
    CHECK(dispatched == 0);
}

void same_bot_is_serial_and_equal_priorities_are_stable() {
    std::atomic<int> active = 0;
    std::vector<std::string> order;
    std::mutex mutex;
    int event_active = 0;
    const auto results = execute_plan({{"third-name", "bot", {}}, {"first-name", "bot", {}},
                                       {"second-name", "bot", {}}},
        [&](const Job& job, std::stop_token) {
            const int previous = active.fetch_add(1);
            {
                std::lock_guard lock(mutex);
                order.push_back(job.id);
            }
            --active;
            CHECK(previous == 0);
            return Result{JobState::completed, "ok"};
        },
        [&](const std::string&, JobState state, const std::string&) {
            if (state == JobState::running) {
                CHECK(event_active == 0);
                ++event_active;
            } else if (state == JobState::completed) {
                CHECK(event_active == 1);
                --event_active;
            }
        }, {}, 8);
    check_completed(results);
    CHECK(active == 0);
    CHECK(event_active == 0);
    CHECK((order == std::vector<std::string>{"third-name", "first-name", "second-name"}));
}

void dependencies_start_without_waiting_for_a_wave() {
    std::latch slow_entered(1);
    std::latch child_entered(1);
    std::atomic<bool> fast_returned = false;
    bool fast_completed_event = false;
    const auto results = execute_plan({{"slow", "slow-bot", {}}, {"fast", "fast-bot", {}},
                                       {"child", "child-bot", {"fast"}}},
        [&](const Job& job, std::stop_token) {
            if (job.id == "slow") {
                slow_entered.count_down();
                child_entered.wait();
            } else if (job.id == "fast") {
                fast_returned = true;
            } else {
                slow_entered.wait();
                CHECK(fast_returned.load());
                child_entered.count_down();
            }
            return Result{JobState::completed, "ok"};
        },
        [&](const std::string& id, JobState state, const std::string&) {
            if (id == "fast" && state == JobState::completed) {
                fast_completed_event = true;
            }
            if (id == "child" && state == JobState::running) {
                CHECK(fast_completed_event);
            }
        }, {}, 2);
    check_completed(results);
}

void all_prerequisites_are_required() {
    std::latch roots_entered(2);
    std::atomic<int> roots_finished = 0;
    int root_completion_events = 0;
    const auto results = execute_plan({{"left", "a", {}}, {"right", "b", {}},
                                       {"join", "c", {"left", "right"}}},
        [&](const Job& job, std::stop_token) {
            if (job.id == "join") {
                CHECK(roots_finished == 2);
            } else {
                roots_entered.count_down();
                roots_entered.wait();
                ++roots_finished;
            }
            return Result{JobState::completed, "ok"};
        },
        [&](const std::string& id, JobState state, const std::string&) {
            if (id != "join" && state == JobState::completed) {
                ++root_completion_events;
            }
            if (id == "join" && state == JobState::running) {
                CHECK(root_completion_events == 2);
            }
        }, {}, 2);
    check_completed(results);
}

void longest_downstream_chain_wins() {
    std::vector<std::string> order;
    std::mutex mutex;
    const auto results = execute_plan({{"short-first", "bot", {}}, {"short-second", "bot", {}},
                                       {"long", "bot", {}}, {"middle", "bot", {"long"}},
                                       {"tail", "bot", {"middle"}}},
        [&](const Job& job, std::stop_token) {
            std::lock_guard lock(mutex);
            order.push_back(job.id);
            return Result{JobState::completed, "ok"};
        }, {}, {}, 8);
    check_completed(results);
    CHECK((order == std::vector<std::string>{"long", "middle", "short-first", "short-second", "tail"}));
}

void worker_failures_block_only_their_descendants() {
    std::mutex mutex;
    std::set<std::string> called;
    const auto results = execute_plan({{"failure", "a", {}}, {"child", "b", {"failure"}},
                                       {"grandchild", "c", {"child"}}, {"independent", "d", {}},
                                       {"unknown-exception", "e", {}}, {"bad-state", "f", {}}},
        [&](const Job& job, std::stop_token) -> Result {
            {
                std::lock_guard lock(mutex);
                called.insert(job.id);
            }
            if (job.id == "failure") {
                throw std::runtime_error("worker failure");
            }
            if (job.id == "unknown-exception") {
                throw 42;
            }
            if (job.id == "bad-state") {
                return {JobState::running, "invalid"};
            }
            return {JobState::completed, "ok"};
        });
    CHECK(results.at("failure").state == JobState::failed);
    CHECK(results.at("failure").detail.find("worker failure") != std::string::npos);
    CHECK(results.at("child").state == JobState::blocked);
    CHECK(results.at("grandchild").state == JobState::blocked);
    CHECK(results.at("independent").state == JobState::completed);
    CHECK(results.at("unknown-exception").state == JobState::failed);
    CHECK(results.at("bad-state").state == JobState::failed);
    CHECK(!called.contains("child"));
    CHECK(!called.contains("grandchild"));
    CHECK(called.size() == 4);
}

void event_exceptions_become_results_and_workers_are_joined() {
    std::latch completion_event(1);
    std::atomic<int> slow_active = 0;
    const auto coordinator = std::this_thread::get_id();
    const auto results = execute_plan({{"event-failure", "a", {}},
                                       {"child", "b", {"event-failure"}}, {"slow", "c", {}},
                                       {"startup-failure", "d", {}}, {"queued-failure", "e", {}}},
        [&](const Job& job, std::stop_token) {
            CHECK(job.id != "startup-failure");
            CHECK(job.id != "queued-failure");
            CHECK(job.id != "child");
            if (job.id == "slow") {
                ++slow_active;
                completion_event.wait();
                --slow_active;
            }
            return Result{JobState::completed, "ok"};
        },
        [&](const std::string& id, JobState state, const std::string&) {
            CHECK(std::this_thread::get_id() == coordinator);
            if (id == "event-failure" && state == JobState::completed) {
                completion_event.count_down();
                throw std::runtime_error("event failure");
            }
            if (id == "startup-failure" && state == JobState::running) {
                throw 7;
            }
            if (id == "queued-failure" && state == JobState::queued) {
                throw std::runtime_error("initial event failure");
            }
        });
    CHECK(results.at("event-failure").state == JobState::failed);
    CHECK(results.at("event-failure").detail.find("event failure") != std::string::npos);
    CHECK(results.at("child").state == JobState::blocked);
    CHECK(results.at("slow").state == JobState::completed);
    CHECK(results.at("startup-failure").state == JobState::failed);
    CHECK(results.at("queued-failure").state == JobState::failed);
    CHECK(slow_active == 0);
}

void cancellation_stops_dispatch_and_reaches_running_workers() {
    std::stop_source source;
    std::latch roots_entered(2);
    std::mutex mutex;
    std::condition_variable_any stopped;
    std::atomic<int> active = 0;
    std::atomic<int> called = 0;
    std::atomic<int> saw_stop = 0;
    std::jthread canceller([&] {
        roots_entered.wait();
        source.request_stop();
    });
    const auto results = execute_plan({{"a", "a-bot", {}}, {"b", "b-bot", {}},
                                       {"same-bot-pending", "a-bot", {}}, {"child", "c", {"a"}}},
        [&](const Job& job, std::stop_token stop) {
            CHECK(job.id == "a" || job.id == "b");
            ++called;
            ++active;
            roots_entered.count_down();
            {
                std::unique_lock lock(mutex);
                stopped.wait(lock, stop, [] { return false; });
            }
            if (stop.stop_requested()) {
                ++saw_stop;
            }
            --active;
            return Result{JobState::cancelled, "worker observed cancellation"};
        }, {}, source.get_token(), 2);
    canceller.join();
    CHECK(called == 2);
    CHECK(saw_stop == 2);
    CHECK(active == 0);
    for (const auto& [id, result] : results) {
        CHECK(result.state == JobState::cancelled);
    }
}

void cancellation_before_dispatch_and_inside_event() {
    std::stop_source already_stopped;
    already_stopped.request_stop();
    std::atomic<int> called = 0;
    const auto worker = [&](const Job&, std::stop_token) {
        ++called;
        return Result{JobState::completed, "ok"};
    };
    auto results = execute_plan({{"a", "a", {}}, {"b", "b", {"a"}}},
        worker, {}, already_stopped.get_token());
    CHECK(results.at("a").state == JobState::cancelled);
    CHECK(results.at("b").state == JobState::cancelled);
    CHECK(called == 0);

    std::stop_source from_event;
    results = execute_plan({{"a", "a", {}}, {"b", "b", {}}}, worker,
        [&](const std::string&, JobState state, const std::string&) {
            if (state == JobState::running) {
                from_event.request_stop();
            }
        }, from_event.get_token());
    CHECK(results.at("a").state == JobState::cancelled);
    CHECK(results.at("b").state == JobState::cancelled);
    CHECK(called == 0);
}

void inbox_retains_data_per_subscriber() {
    InputInbox inbox;
    CHECK(inbox.latest_sequence() == 0);
    CHECK(inbox.publish("first") == 1);
    CHECK(inbox.publish("second") == 2);
    InputInbox::Cursor first_cursor = 0;
    InputInbox::Cursor second_cursor = 0;
    const auto first = inbox.read_after(first_cursor);
    const auto second = inbox.read_after(second_cursor);
    CHECK(first.size() == 2);
    CHECK(second.size() == 2);
    CHECK(first[0].sequence == 1 && first[0].text == "first");
    CHECK(second[1].sequence == 2 && second[1].text == "second");
    CHECK(first_cursor == 2 && second_cursor == 2);
    CHECK(inbox.read_after(first_cursor).empty());
    CHECK(first_cursor == 2);
    auto future_cursor = inbox.latest_sequence();
    CHECK(inbox.publish("") == 3);
    const auto future = inbox.wait_after(future_cursor);
    CHECK(future.size() == 1 && future[0].sequence == 3 && future[0].text.empty());
    CHECK(future_cursor == 3);
    auto invalid_cursor = inbox.latest_sequence() + 1;
    expect_invalid([&] { inbox.read_after(invalid_cursor); });
    expect_invalid([&] { inbox.wait_after(invalid_cursor); });
    CHECK(invalid_cursor == 4);
}

void inbox_broadcasts_interruptions_to_each_running_worker() {
    InputInbox inbox;
    std::latch entered(2);
    std::latch first_handled(2);
    std::jthread publisher([&] {
        entered.wait();
        inbox.publish("revise the request");
        first_handled.wait();
        inbox.publish("finish with the revision");
    });
    const auto results = execute_plan({{"a", "a", {}}, {"b", "b", {}}},
        [&](const Job&, std::stop_token stop) {
            InputInbox::Cursor cursor = 0;
            entered.count_down();
            const auto first = inbox.wait_after(cursor, stop);
            CHECK(first.size() == 1 && first[0].sequence == 1);
            CHECK(first[0].text == "revise the request");
            first_handled.count_down();
            const auto second = inbox.wait_after(cursor, stop);
            CHECK(second.size() == 1 && second[0].sequence == 2);
            CHECK(second[0].text == "finish with the revision");
            CHECK(cursor == 2);
            CHECK(inbox.read_after(cursor).empty());
            return Result{JobState::completed, "received both revisions"};
        }, {}, {}, 2);
    publisher.join();
    check_completed(results);
}

void inbox_wait_is_cancellable_without_consuming_input() {
    InputInbox inbox;
    std::stop_source source;
    std::latch entered(1);
    InputInbox::Cursor cursor = 0;
    std::vector<InputMessage> received;
    std::jthread reader([&] {
        entered.count_down();
        received = inbox.wait_after(cursor, source.get_token());
    });
    entered.wait();
    source.request_stop();
    reader.join();
    CHECK(received.empty());
    CHECK(cursor == 0);
    inbox.publish("still available");
    CHECK(inbox.wait_after(cursor, source.get_token()).empty());
    CHECK(cursor == 0);
    received = inbox.read_after(cursor);
    CHECK(received.size() == 1 && received[0].text == "still available");
    CHECK(cursor == 1);
}

void inbox_concurrent_publishers_keep_a_single_sequence() {
    InputInbox inbox;
    std::latch ready(4);
    std::vector<std::jthread> publishers;
    for (int publisher = 0; publisher < 4; ++publisher) {
        publishers.emplace_back([&, publisher] {
            ready.count_down();
            ready.wait();
            for (int item = 0; item < 32; ++item) {
                inbox.publish(std::to_string(publisher) + ":" + std::to_string(item));
            }
        });
    }
    for (auto& publisher : publishers) {
        publisher.join();
    }
    InputInbox::Cursor cursor = 0;
    const auto messages = inbox.read_after(cursor);
    CHECK(messages.size() == 128);
    std::set<std::string> payloads;
    for (std::size_t i = 0; i < messages.size(); ++i) {
        CHECK(messages[i].sequence == i + 1);
        payloads.insert(messages[i].text);
    }
    CHECK(payloads.size() == 128);
    CHECK(cursor == 128);
    CHECK(inbox.latest_sequence() == 128);
}

} // namespace

int main() {
    // The timeout is a suite deadlock guard, not a performance expectation.
    // Overlap, order, and wakeups above are checked through synchronization.
    std::mutex watchdog_mutex;
    std::condition_variable_any watchdog_condition;
    std::jthread watchdog([&](std::stop_token stop) {
        std::unique_lock lock(watchdog_mutex);
        watchdog_condition.wait_for(lock, stop, std::chrono::seconds(60), [] { return false; });
        if (!stop.stop_requested()) {
            std::cerr << "scheduler tests deadlocked\n";
            std::abort();
        }
    });
    try {
        const std::vector<std::pair<const char*, void (*)()>> tests{
            {"validation", validation_happens_before_callbacks},
            {"independent concurrency and event thread", independent_jobs_overlap_and_events_stay_on_coordinator},
            {"parallel limit", concurrency_limit_is_respected},
            {"per-bot serialization and stable ties", same_bot_is_serial_and_equal_priorities_are_stable},
            {"streaming dependency dispatch", dependencies_start_without_waiting_for_a_wave},
            {"all prerequisites", all_prerequisites_are_required},
            {"critical chain priority", longest_downstream_chain_wins},
            {"worker failures and isolation", worker_failures_block_only_their_descendants},
            {"event exceptions and joining", event_exceptions_become_results_and_workers_are_joined},
            {"running cancellation", cancellation_stops_dispatch_and_reaches_running_workers},
            {"early and event cancellation", cancellation_before_dispatch_and_inside_event},
            {"inbox cursors and history", inbox_retains_data_per_subscriber},
            {"inbox broadcast to workers", inbox_broadcasts_interruptions_to_each_running_worker},
            {"inbox cancellation", inbox_wait_is_cancellable_without_consuming_input},
            {"concurrent inbox publishers", inbox_concurrent_publishers_keep_a_single_sequence}
        };
        for (const auto& [name, test] : tests) {
            test();
            std::cout << "PASS " << name << '\n';
        }
        std::cout << tests.size() << " scheduler tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    } catch (...) {
        std::cerr << "FAIL unknown test exception\n";
        return 1;
    }
}
