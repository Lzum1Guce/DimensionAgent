#include "dimension/runs.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

namespace {
using namespace dimension;
using namespace std::chrono_literals;

void check(bool condition, const char* expression, int line) {
    if (!condition) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(expression) check(static_cast<bool>(expression), #expression, __LINE__)

struct Gate {
    std::mutex mutex;
    std::condition_variable_any condition;
    int entered = 0;
    bool released = false;
    void arrive() { std::unique_lock lock(mutex); ++entered; condition.notify_all(); }
    bool wait(std::stop_token stop = {}) {
        std::unique_lock lock(mutex);
        return condition.wait_for(lock, stop, 5s, [&] { return released; });
    }
    void expect(int count) {
        std::unique_lock lock(mutex);
        CHECK(condition.wait_for(lock, 5s, [&] { return entered >= count; }));
    }
    void release() { std::unique_lock lock(mutex); released = true; condition.notify_all(); }
};

RunOptions chat_options() { RunOptions options; options.require_verified_finish = false; return options; }
ModelReply text_reply(std::string text) { return {std::move(text), {}, 10, 20}; }
ModelReply tool_reply(std::vector<ToolCall> calls) { return {"", std::move(calls), 10, 20}; }
ToolCall finish_call(std::string id = "finish") {
    return {std::move(id), "task_finish", R"({"summary":"Verified delivery","artifacts":["artifact:test"],"verification":"read-back passed"})"};
}
RunCallbacks base_callbacks() {
    RunCallbacks callbacks;
    callbacks.configuration = [](const RunExecutionContext& context) {
        ModelConfig config; config.model = context.bot_id; return config;
    };
    callbacks.tools = [](const RunExecutionContext&) {
        return std::vector<ModelTool>{{"write_artifact", "Write a fixture artifact", Json::Object{{"type", "object"}}},
                                      {"read_artifact", "Read a fixture artifact", Json::Object{{"type", "object"}}}};
    };
    return callbacks;
}

std::string status(const Json& run) { return run.at("status").as_string(); }
Json settled(RunService& service, const std::string& id) {
    const auto deadline = std::chrono::steady_clock::now() + 8s;
    std::uint64_t cursor = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        auto run = service.brief_json(id);
        if (run.at("terminal").as_bool() && !run.at("executing").as_bool()) return run;
        const auto page = service.wait_events(id, cursor, 100ms);
        cursor = static_cast<std::uint64_t>(page.at("after").as_number());
        if (run.at("terminal").as_bool()) std::this_thread::sleep_for(1ms);
    }
    throw std::runtime_error("Run did not settle: " + id);
}

std::vector<Json> all_events(RunService& service, const std::string& id) {
    std::vector<Json> events;
    std::uint64_t after = 0;
    for (;;) {
        const auto page = service.events_after(id, after, 17);
        for (const auto& event : page.at("events").as_array()) {
            CHECK(event.at("seq").as_number() > static_cast<double>(after));
            after = static_cast<std::uint64_t>(event.at("seq").as_number());
            events.push_back(event);
        }
        if (after == static_cast<std::uint64_t>(page.at("latest").as_number())) break;
        CHECK(!page.at("events").as_array().empty());
    }
    return events;
}

void assert_pairs(const std::vector<ModelMessage>& messages) {
    std::set<std::string> pending;
    for (const auto& message : messages) {
        if (message.role == "tool") { CHECK(pending.erase(message.tool_call_id) == 1); continue; }
        CHECK(pending.empty());
        for (const auto& call : message.tool_calls) CHECK(pending.insert(call.id).second);
    }
    CHECK(pending.empty());
}

void steering_and_idempotency(const std::filesystem::path& root) {
    Gate calls;
    auto callbacks = base_callbacks();
    std::mutex observed_mutex;
    std::vector<ModelMessage> observed;
    RunService* read_service = nullptr;
    std::string read_id;
    std::atomic<int> cancellation_callbacks = 0;
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages,
                           const std::vector<ModelTool>&, ModelChunk chunk, std::stop_token stop) {
        std::stop_callback readable_stop(stop, [&] {
            CHECK(read_service->get(read_id).at("id").as_string() == read_id);
            ++cancellation_callbacks;
        });
        calls.arrive();
        if (!calls.wait(stop) || stop.stop_requested()) throw std::runtime_error("stopped");
        { std::unique_lock lock(observed_mutex); observed = messages; }
        chunk("thinking", "separate analysis"); chunk("text", "visible answer");
        return text_reply("visible answer");
    };
    RunService service(root, callbacks, chat_options());
    read_service = &service;
    const auto run = service.submit("bot", "group", "initial", "request-0");
    read_id = run.run_id;
    calls.expect(1);
    for (int i = 1; i <= 12; ++i) {
        const auto steered = service.submit("bot", "group", "supplement-" + std::to_string(i), "request-" + std::to_string(i));
        CHECK(steered.run_id == run.run_id); CHECK(steered.steered); CHECK(!steered.created);
    }
    const auto duplicate = service.submit("bot", "group", "must not append", "request-12");
    CHECK(duplicate.duplicate); CHECK(duplicate.run_id == run.run_id);
    calls.release();
    CHECK(status(settled(service, run.run_id)) == "completed");
    const auto full = service.get(run.run_id);
    CHECK(full.at("inputs").as_array().size() == 13);
    std::string joined;
    for (const auto& message : observed) joined += message.content + '\n';
    CHECK(joined.find("supplement-12") != std::string::npos);
    CHECK(joined.find("supplement-1\n") != std::string::npos);
    CHECK(joined.find("separate analysis") == std::string::npos);
    bool text = false, thinking = false;
    for (const auto& event : all_events(service, run.run_id)) {
        text |= event.at("type").as_string() == "model_text_delta";
        thinking |= event.at("type").as_string() == "model_thinking_delta";
    }
    CHECK(text && thinking);
    CHECK(cancellation_callbacks > 0);
    CHECK(service.submit("bot", "group", "different", "request-0").duplicate);
}

void cancel_blocks_returned_tools(const std::filesystem::path& root) {
    Gate model;
    std::atomic<int> tools = 0;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token stop) {
        model.arrive(); model.wait(stop);
        return tool_reply({{"late", "write_artifact", "{}"}});
    };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) { ++tools; return ToolExecution{"bad"}; };
    RunService service(root, callbacks);
    const auto run = service.submit("bot", "group", "cancel task", "cancel-request");
    model.expect(1);
    CHECK(status(service.cancel(run.run_id)) == "cancelled");
    CHECK(status(settled(service, run.run_id)) == "cancelled");
    CHECK(tools == 0);
    CHECK(service.cancel(run.run_id).at("status").as_string() == "cancelled");
    bool terminal_seen = false;
    for (const auto& event : all_events(service, run.run_id)) {
        if (event.at("status").as_string() == "cancelled") terminal_seen = true;
        if (terminal_seen) CHECK(event.at("status").as_string() == "cancelled");
    }
}

void cancel_during_tool_batch(const std::filesystem::path& root) {
    Gate tool;
    std::atomic<int> tools = 0;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) {
        return tool_reply({{"one", "write_artifact", "{\"n\":1}"}, {"two", "write_artifact", "{\"n\":2}"}});
    };
    callbacks.execute_tool = [&](const auto&, const auto&, std::stop_token stop) {
        ++tools; tool.arrive(); tool.wait(stop);
        return ToolExecution{"artifact created before cancellation", false, {}, {"artifact:test"}, "read-back passed"};
    };
    RunService service(root, callbacks);
    const auto run = service.submit("bot", "group", "cancel batch", "batch");
    tool.expect(1); service.cancel(run.run_id);
    CHECK(status(settled(service, run.run_id)) == "cancelled"); CHECK(tools == 1);
    const auto full = service.get(run.run_id);
    CHECK(full.at("tools").as_array().size() == 1);
    CHECK(full.at("artifacts").as_array().size() == 1);
    std::vector<ModelMessage> messages;
    for (const auto& message : full.at("messages").as_array()) {
        ModelMessage item{message.at("role").as_string(), message.at("content").as_string()};
        item.tool_call_id = message.at("tool_call_id").as_string();
        for (const auto& call : message.at("tool_calls").as_array()) item.tool_calls.push_back({call.at("id").as_string(), call.at("name").as_string(), call.at("arguments").as_string()});
        messages.push_back(item);
    }
    assert_pairs(messages);
}

void solo_cli_before_model(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    callbacks.direct_cli = [](const auto&) { return true; };
    callbacks.tools = [](const auto&) {
        return std::vector<ModelTool>{{"dispatch_native_cli", "CLI", Json::Object{{"type", "object"}}}};
    };
    std::atomic<int> executions = 0, interpretations = 0;
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        CHECK(call.name == "dispatch_native_cli");
        CHECK(Json::parse(call.arguments).at("inputCount").as_number() == 1);
        CHECK(interpretations == 0);
        ++executions;
        return ToolExecution{"created", false, {}, {"artifact:test"}, "read-back passed"};
    };
    callbacks.model = [&](const auto&, const auto& messages, const auto& tools, ModelChunk, auto) {
        CHECK(executions == 1);
        CHECK(messages.back().role == "tool");
        CHECK(tools.size() == 1 && tools.front().name == "task_finish");
        ++interpretations;
        return tool_reply({finish_call()});
    };
    RunService service(root, callbacks);
    const std::string text = "Preserve x || y exactly.";
    const auto id = service.submit("bot", "", text, "direct").run_id;
    CHECK(status(settled(service, id)) == "completed");
    CHECK(service.cli_input(id, 1) == text);
    CHECK(executions == 1 && interpretations == 1);

    callbacks.execute_tool = [](const auto&, const auto&, auto) {
        return ToolExecution{"provider unavailable", true};
    };
    callbacks.model = [](const auto&, const auto& messages, const auto& tools, ModelChunk, auto) {
        CHECK(tools.empty() && messages.back().role == "tool");
        return text_reply("Provider unavailable, no delivery.");
    };
    RunService failing(root / "failed", callbacks);
    const auto failed = settled(failing, failing.submit("bot", "", text, "failure").run_id);
    CHECK(status(failed) == "failed");
    CHECK(failed.at("error").as_string() == "Provider unavailable, no delivery.");
}

void cli_receipt_delivery(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    callbacks.direct_cli = [](const auto&) { return true; };
    callbacks.tools = [](const auto&) {
        return std::vector<ModelTool>{{"dispatch_native_cli", "CLI", Json::Object{{"type", "object"}}}};
    };
    int dispatches = 0;
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        CHECK(call.name == "dispatch_native_cli");
        ++dispatches;
        return ToolExecution{R"({"response":"Raw verified report"})", false, {},
            dispatches == 1 ? std::vector<std::string>{"result.txt"} : std::vector<std::string>{}, "exit=0"};
    };
    callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, auto) -> ModelReply {
        switch (dispatches) {
        case 1: return tool_reply({{"finish", "task_finish", R"({"summary":"Created result.txt","evidenceCallIds":[]})"}});
        case 2: return text_reply("One test passed");
        case 3: throw std::runtime_error("Summary provider unavailable");
        case 4: return tool_reply({{"unexpected", "write_file", "{}"}});
        case 5: return text_reply("");
        default: return text_reply("Done");
        }
    };
    RunService service(root, callbacks);
    const auto id = service.submit("bot", "", "create result.txt", "first").run_id;
    CHECK(settled(service, id).at("response").as_string() == "Created result.txt");
    for (int turn = 2; turn <= 5; ++turn) {
        service.resume(id, "retest-" + std::to_string(turn), "Only rerun the earlier test");
        const auto done = settled(service, id);
        CHECK(status(done) == "completed");
        CHECK(done.at("response").as_string().find(turn == 2 ? "One test passed" : "Raw verified report") != std::string::npos);
        CHECK(dispatches == turn);
    }
    service.resume(id, "missing", "create missing.txt");
    const auto denied = settled(service, id);
    CHECK(status(denied) == "interrupted");
    CHECK(denied.at("error").as_string().find("missing_requested_artifact") != std::string::npos);
    CHECK(dispatches == 6);
    service.resume(id, "continue", "Continue");
    CHECK(status(settled(service, id)) == "interrupted");
    CHECK(dispatches == 7);
}

void resume_does_not_replay_success(const std::filesystem::path& root) {
    std::atomic<int> writes = 0;
    std::string id;
    std::uint64_t old_sequence = 0;
    Gate waiting;
    {
        auto callbacks = base_callbacks();
        callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages,
                               const auto&, ModelChunk, std::stop_token stop) {
            assert_pairs(messages);
            if (std::none_of(messages.begin(), messages.end(), [](const auto& message) { return message.role == "tool"; })) {
                return tool_reply({{"write-first", "write_artifact", R"({"value":1})"}});
            }
            waiting.arrive(); waiting.wait(stop); throw std::runtime_error("interrupted model");
        };
        callbacks.execute_tool = [&](const auto&, const auto&, auto) {
            ++writes;
            std::ofstream file(root / "produced.txt"); file << "verified artifact"; file.close();
            CHECK(std::filesystem::file_size(root / "produced.txt") == 17);
            return ToolExecution{"created", false, {}, {"artifact:test"}, "read-back passed"};
        };
        RunService service(root, callbacks);
        id = service.submit("bot", "group", "create artifact", "original").run_id;
        waiting.expect(1); service.shutdown();
        CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(writes == 1);
        old_sequence = static_cast<std::uint64_t>(service.brief_json(id).at("lastSeq").as_number());
    }
    std::atomic<int> calls = 0;
    {
        auto callbacks = base_callbacks();
        callbacks.model = [&](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token) {
            assert_pairs(messages);
            if (++calls == 1) return tool_reply({{"new-call-id", "write_artifact", R"({"value": 1})"}});
            return tool_reply({finish_call()});
        };
        callbacks.execute_tool = [&](const auto&, const auto&, auto) { ++writes; return ToolExecution{"unexpected duplicate"}; };
        RunService service(root, callbacks);
        CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(calls == 0);
        CHECK(service.submit("bot", "group", "duplicate", "original").duplicate);
        CHECK(service.resume(id, "resume").attempt == 2);
        const auto done = settled(service, id);
        CHECK(status(done) == "completed"); CHECK(writes == 1); CHECK(calls == 2);
        CHECK(done.at("inputCount").as_number() == 1);
        CHECK(service.resume(id, "resume").duplicate);
        const auto page = service.events_after(id, old_sequence);
        CHECK(!page.at("events").as_array().empty());
        CHECK(page.at("events").as_array().front().at("type").as_string() == "run_resumed");
        bool reused = false;
        for (const auto& event : all_events(service, id)) reused |= event.at("type").as_string() == "tool_reused";
        CHECK(reused);
        CHECK(service.erase(id).at("deleted").as_bool());
        CHECK(service.list().as_array().empty());
    }
    {
        auto callbacks = base_callbacks();
        callbacks.model = [](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) -> ModelReply { throw std::runtime_error("deleted run executed"); };
        RunService service(root, callbacks);
        CHECK(service.list().as_array().empty());
        CHECK(service.submit("bot", "group", "retry erased request", "original").duplicate);
    }
}

void repeat_completed_execution(const std::filesystem::path& root, const std::string& outcome,
                                bool whitelisted = true) {
    const std::string name = whitelisted ? "sandbox_exec" : "write_artifact";
    const std::string arguments = R"({"argv":["/usr/bin/node","build.js"]})";
    const bool uncertain = outcome == "timeout" || outcome == "unknown" || !whitelisted;
    std::atomic<int> executions = 0;
    std::string run_id;
    auto callbacks_for = [&](bool restarted) {
        auto cb = base_callbacks();
        cb.tools = [name](const auto&) { return std::vector<ModelTool>{
            {name, "Synthetic build executor", Json::Object{{"type", "object"}}},
            {"read_artifact", "Read the actual fixture log", Json::Object{{"type", "object"}}}}; };
        cb.is_read_only_tool = [](std::string_view tool) { return tool == "read_artifact"; };
        cb.repeat_completed_tool = [](std::string_view tool) { return tool == "sandbox_exec"; };
        cb.model = [&, restarted, turn = 0](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token) mutable {
            assert_pairs(messages);
            if (++turn == 1) return tool_reply({{"build-original", name, arguments}});
            if (turn == 2 && !restarted) return tool_reply({{"build-original", name, arguments}});
            if (turn == (restarted ? 2 : 3)) return tool_reply({{restarted ? "build-after-restart" : "build-new-id", name, arguments}});
            if (turn == (restarted ? 3 : 4)) return tool_reply({{"build-original", name, R"({"argv":["/usr/bin/node","different.js"]})"}});
            if (turn == (restarted ? 4 : 5)) return tool_reply({{restarted ? "inspect-restored" : "inspect", "read_artifact", "{}"}});
            return tool_reply({finish_call(restarted ? "finish-restored" : "finish-first")});
        };
        cb.execute_tool = [&](const ToolCall& call, const auto&, auto) {
            if (call.name == "read_artifact") {
                std::ifstream input(root / "executions.txt");
                const std::string content(std::istreambuf_iterator<char>(input), {});
                CHECK(static_cast<int>(std::count(content.begin(), content.end(), '\n')) == executions.load());
                return ToolExecution{"Read actual execution log", false, {}, {"artifact:test"}, "read-back passed"};
            }
            const auto count = ++executions;
            std::ofstream output(root / "executions.txt", std::ios::app); output << "execution " << count << '\n'; output.close();
            CHECK(output.good());
            if (count == 1 && outcome != "success") {
                Json::Object metadata{{"no_side_effects", false}};
                if (outcome == "exit7") { metadata["execution_outcome_known"] = true; metadata["exitCode"] = 7; }
                if (outcome == "timeout") metadata["timedOut"] = true;
                return ToolExecution{"Synthetic executor outcome: " + outcome, true, metadata};
            }
            return ToolExecution{"Actual fixture execution " + std::to_string(count), false, {}, {"artifact:test"}, "read-back passed"};
        };
        return cb;
    };
    {
        RunService service(root, callbacks_for(false));
        run_id = service.submit("bot", "", "Build twice after a source change", "repeat-exec").run_id;
        CHECK(status(settled(service, run_id)) == "completed");
        CHECK(executions == (uncertain ? 1 : 2));
        const auto all = service.get(run_id); const auto& rows = all.at("tools").as_array();
        CHECK(rows.front().at("state").as_string() == (uncertain ? "uncertain" : "finished"));
        CHECK(rows[1].at("execution").at("result").as_string().find(uncertain ? "uncertain_tool_execution" : outcome == "exit7" ? "exit7" : "execution 1") != std::string::npos);
        CHECK(rows[2].at("execution").at("error").as_bool() == uncertain);
        CHECK(rows[3].at("execution").at("result").as_string().find("tool_call_id_conflict") != std::string::npos);
        if (outcome != "success") CHECK(!rows.front().at("execution").at("metadata").at("no_side_effects").as_bool());
    }
    {
        RunService service(root, callbacks_for(true));
        CHECK(service.resume(run_id, "resume-exec").attempt == 2);
        CHECK(status(settled(service, run_id)) == "completed");
        CHECK(executions == (uncertain ? 1 : 3));
        const auto all = service.get(run_id); const auto& rows = all.at("tools").as_array();
        CHECK(rows.front().at("state").as_string() == (uncertain ? "uncertain" : "finished"));
    }
}

ToolCall plugin_write_call(bool wrapped, std::string id, bool reordered = false) {
    const auto arguments = reordered ? R"({"label":"fixture", "value":1})" : R"({"value":1,"label":"fixture"})";
    return {std::move(id), wrapped ? "call_plugin_tool" : "mcp__fixture__write",
            wrapped ? std::string(R"({"name":"mcp__fixture__write","args":)") + arguments + "}" : arguments};
}

void wrapped_receipt_recovery(const std::filesystem::path& root, bool first_wrapped, bool uncertain) {
    const auto expected = std::string("mcp__fixture__write\n") + R"({"label":"fixture","value":1})";
    std::atomic<int> writes = 0, reads = 0, fingerprints = 0;
    std::string id;
    RunService* owner = nullptr;
    auto callbacks_for = [&](bool wrapped) {
        auto callbacks = base_callbacks();
        callbacks.tools = [wrapped](const auto&) {
            return std::vector<ModelTool>{{wrapped ? "call_plugin_tool" : "mcp__fixture__write", "Synthetic action", Json::Object{{"type", "object"}}},
                                          {"read_artifact", "Inspect fixture", Json::Object{{"type", "object"}}}};
        };
        callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
        if (wrapped) {
            callbacks.tool_fingerprint = [&](const ToolCall& call) {
                // Reading memory-backed service state proves the hook is outside
                // the service lock; no external action or filesystem I/O here.
                CHECK(owner->brief_json(id).at("id").as_string() == id);
                CHECK(call.name != "task_finish");
                ++fingerprints;
                const auto arguments = Json::parse(call.arguments);
                if (call.name == "call_plugin_tool") {
                    return arguments.at("name").as_string() + "\n" + arguments.at("args").dump();
                }
                return call.name + "\n" + arguments.dump();
            };
        }
        return callbacks;
    };
    RunOptions options; options.start_paused = true;
    {
        Gate waiting;
        int model_calls = 0;
        auto callbacks = callbacks_for(first_wrapped);
        callbacks.model = [&](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token stop) -> ModelReply {
            assert_pairs(messages);
            if (++model_calls == 1) return tool_reply({plugin_write_call(first_wrapped, "initial-action")});
            waiting.arrive(); waiting.wait(stop); throw std::runtime_error("restart fixture");
        };
        callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
            CHECK(call.name == (first_wrapped ? "call_plugin_tool" : "mcp__fixture__write"));
            ++writes;
            std::ofstream artifact(root / "produced.txt"); artifact << "external action happened"; artifact.close();
            if (uncertain) return ToolExecution{"connection lost after external action", true};
            return ToolExecution{"created", false, {}, {"artifact:test"}, "read-back passed"};
        };
        RunService service(root, callbacks, options); owner = &service;
        id = service.submit("bot", "group", "create artifact", "initial").run_id;
        service.start(); waiting.expect(1); service.shutdown();
        CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(writes == 1);
        const auto first = service.get(id).at("tools").as_array().front();
        CHECK(first.at("fingerprint").as_string() == expected);
        CHECK(first.at("state").as_string() == (uncertain ? "uncertain" : "finished"));
        CHECK(first.at("call").at("name").as_string() == plugin_write_call(first_wrapped, "initial-action").name);
    }
    {
        int model_calls = 0;
        auto callbacks = callbacks_for(!first_wrapped);
        callbacks.model = [&](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token) {
            assert_pairs(messages);
            if (++model_calls == 1) return tool_reply({plugin_write_call(!first_wrapped, "retry-action", true)});
            if (uncertain && model_calls == 2) return tool_reply({{"verify", "read_artifact", "{}"}});
            return tool_reply({finish_call()});
        };
        callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
            if (call.name != "read_artifact") { ++writes; return ToolExecution{"unexpected duplicate"}; }
            ++reads;
            CHECK(std::filesystem::file_size(root / "produced.txt") == 24);
            return ToolExecution{"artifact inspected", false, {}, {"artifact:test"}, "read-back passed"};
        };
        RunService service(root, callbacks, options); owner = &service;
        CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(model_calls == 0);
        CHECK(service.resume(id, "resume").attempt == 2); service.start();
        CHECK(status(settled(service, id)) == "completed"); CHECK(writes == 1);
        CHECK(reads == (uncertain ? 1 : 0)); CHECK(model_calls == (uncertain ? 3 : 2));
        const auto full = service.get(id);
        const auto& receipts = full.at("tools").as_array();
        CHECK(receipts.size() == (uncertain ? 4u : 3u));
        CHECK(receipts[0].at("fingerprint").as_string() == expected);
        CHECK(receipts[1].at("fingerprint").as_string() == expected);
        CHECK(receipts[1].at("call").at("name").as_string() == plugin_write_call(!first_wrapped, "retry-action").name);
        CHECK(receipts[1].at("execution").at("error").as_bool() == uncertain);
        CHECK(receipts[1].at("execution").at("result").as_string().find(uncertain ? "uncertain_tool_execution" : "created") != std::string::npos);
        bool reused = false;
        for (const auto& event : all_events(service, id)) {
            if (event.at("type").as_string() == "tool_reused" && event.at("data").at("call").at("id").as_string() == "retry-action") reused = true;
        }
        CHECK(reused);
        CHECK(fingerprints == ((!first_wrapped && uncertain) ? 2 : 1));
    }
}

void invalid_fingerprints_block_execution(const std::filesystem::path& root) {
    std::atomic<int> model_calls = 0, hooks = 0, executions = 0;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages);
        if (++model_calls == 1) return tool_reply({{"invalid-json", "write_artifact", "{"},
            {"empty", "write_artifact", "{}"}, {"oversized", "write_artifact", "{}"},
            {"throws", "write_artifact", "{}"}, {"unavailable", "no_such_tool", "{}"}, finish_call("reserved")});
        return text_reply("cannot complete");
    };
    callbacks.tool_fingerprint = [&](const ToolCall& call) -> std::string {
        ++hooks;
        if (call.id == "empty") return {};
        if (call.id == "oversized") return std::string(131073, 'x');
        if (call.id == "throws") throw std::runtime_error("PRIVATE_CALLBACK_DETAIL");
        throw std::runtime_error("hook called for an invalid, unavailable or reserved tool");
    };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) { ++executions; return ToolExecution{"must not execute"}; };
    RunService service(root, callbacks);
    const auto id = service.submit("bot", "group", "reject invalid identities", "invalid").run_id;
    CHECK(status(settled(service, id)) == "failed"); CHECK(executions == 0); CHECK(hooks == 3);
    const auto full = service.get(id);
    const auto& receipts = full.at("tools").as_array();
    CHECK(receipts.size() == 6);
    for (const auto& receipt : receipts) CHECK(receipt.at("execution").at("error").as_bool());
    CHECK(receipts[0].at("execution").at("result").as_string() == "Tool arguments are not valid JSON");
    CHECK(receipts[1].at("fingerprint").as_string().empty()); CHECK(receipts[2].at("fingerprint").as_string().empty());
    CHECK(receipts[1].at("execution").at("result").as_string().starts_with("tool_fingerprint_rejected"));
    CHECK(receipts[2].at("execution").at("result").as_string().starts_with("tool_fingerprint_rejected"));
    CHECK(receipts[3].at("execution").at("result").as_string().starts_with("tool_fingerprint_failed"));
    CHECK(receipts[4].at("execution").at("result").as_string() == "Unknown or unavailable tool");
    CHECK(receipts[5].at("fingerprint").as_string().starts_with("task_finish\n"));
    CHECK(receipts[5].at("execution").at("result").as_string().starts_with("completion_rejected"));
    CHECK(full.dump().find("PRIVATE_CALLBACK_DETAIL") == std::string::npos);
}

ModelImage fixture_image(unsigned char red, std::size_t padding = 0) {
    const auto be32 = [](std::string& bytes, std::uint32_t value) {
        for (int shift = 24; shift >= 0; shift -= 8) bytes.push_back(static_cast<char>((value >> shift) & 255U));
    };
    std::string png("\x89PNG\r\n\x1a\n", 8);
    const auto chunk = [&](std::string_view type, const std::string& payload) {
        be32(png, static_cast<std::uint32_t>(payload.size()));
        std::string data(type); data += payload;
        png += data;
        std::uint32_t crc = 0xffffffffU;
        for (unsigned char byte : data) {
            crc ^= byte;
            for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1U) ^ ((crc & 1U) ? 0xedb88320U : 0U);
        }
        be32(png, crc ^ 0xffffffffU);
    };
    std::string header(13, '\0'); header[3] = 1; header[7] = 1; header[8] = 8; header[9] = 6;
    chunk("IHDR", header);
    if (padding) chunk("tEXt", std::string("Fixture\0", 8) + std::string(padding, 'z'));
    const std::string pixels{char(0), static_cast<char>(red), char(0), char(-1), char(-1)};
    std::string compressed("\x78\x01\x01\x05\x00\xfa\xff", 7); compressed += pixels;
    std::uint32_t a = 1, b = 0;
    for (unsigned char byte : pixels) { a = (a + byte) % 65521U; b = (b + a) % 65521U; }
    be32(compressed, (b << 16U) | a); chunk("IDAT", compressed); chunk("IEND", {});
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string encoded;
    for (std::size_t i = 0; i < png.size(); i += 3) {
        const auto first = static_cast<unsigned char>(png[i]);
        const auto second = i + 1 < png.size() ? static_cast<unsigned char>(png[i + 1]) : 0U;
        const auto third = i + 2 < png.size() ? static_cast<unsigned char>(png[i + 2]) : 0U;
        const auto bits = (static_cast<unsigned>(first) << 16U) | (second << 8U) | third;
        encoded += alphabet[(bits >> 18U) & 63U]; encoded += alphabet[(bits >> 12U) & 63U];
        encoded += i + 1 < png.size() ? alphabet[(bits >> 6U) & 63U] : '=';
        encoded += i + 2 < png.size() ? alphabet[bits & 63U] : '=';
    }
    return {"image/png", std::move(encoded), 1, 1};
}

std::size_t images_count(const std::vector<ModelMessage>& messages) {
    std::size_t count = 0;
    for (const auto& message : messages) count += message.images.size();
    return count;
}
void assert_private_images(const std::filesystem::path& root, RunService& service, const std::string& id) {
    CHECK(service.get(id).dump().find("iVBORw0KGgo") == std::string::npos);
    for (const auto& event : all_events(service, id)) CHECK(event.dump().find("iVBORw0KGgo") == std::string::npos);
    for (const auto& entry : std::filesystem::recursive_directory_iterator(root)) {
        if (!entry.is_regular_file() || (entry.path().extension() != ".json" && entry.path().extension() != ".jsonl")) continue;
        std::ifstream file(entry.path(), std::ios::binary);
        const std::string bytes((std::istreambuf_iterator<char>(file)), {});
        CHECK(bytes.find("iVBORw0KGgo") == std::string::npos);
    }
}

void ephemeral_images_and_context(const std::filesystem::path& root) {
    const auto first = fixture_image(20, 150000), second = fixture_image(80);
    CHECK(first.base64_data.size() > 131072);
    validate_model_images({first, second});
    int rounds = 0, reads = 0;
    bool trimmed = false;
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages);
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& item) {
            return item.role == "user" && item.images.empty() && item.content.starts_with("REAL_USER_TASK");
        }));
        ++rounds;
        if (rounds == 2 || rounds == 3 || rounds == 5 || rounds == 7) {
            CHECK(images_count(messages) == 1); CHECK(messages.back().role == "user");
            CHECK(messages.back().content.find("untrusted interface content") != std::string::npos);
            CHECK(messages.back().content.find("not a new user task") != std::string::npos);
            CHECK(messages.back().content.find("Source call id: shot-") != std::string::npos);
            CHECK(messages.back().images.front().base64_data == (rounds == 3 || rounds == 7 ? second : first).base64_data);
            CHECK(messages[messages.size() - 2].role == "tool");
        } else CHECK(images_count(messages) == 0);
        if (rounds == 1) return tool_reply({{"shot-one", "read_artifact", R"({"shot":1})"}});
        if (rounds == 2) return tool_reply({{"shot-two", "read_artifact", R"({"shot":2})"}, {"shot-three", "read_artifact", R"({"shot":3})"}});
        if (rounds == 3) {
            trimmed = std::none_of(messages.begin(), messages.end(), [](const auto& item) {
                return std::any_of(item.tool_calls.begin(), item.tool_calls.end(), [](const auto& call) { return call.id == "shot-one"; });
            });
            return tool_reply({{"shot-three", "read_artifact", R"({"shot":3})"}}); // Receipt reuse must clear images.
        }
        if (rounds == 4) return tool_reply({{"shot-four", "read_artifact", R"({"shot":4})"}});
        if (rounds == 5) return tool_reply({{"status", "read_artifact", R"({"shot":5})"}});
        if (rounds == 6) return tool_reply({{"shot-six", "read_artifact", R"({"shot":6})"}});
        if (rounds == 7) return tool_reply({{"failed-status", "read_artifact", R"({"shot":7})"}});
        return text_reply("observations handled");
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        ++reads;
        const auto shot = static_cast<int>(Json::parse(call.arguments).at("shot").as_number());
        ToolExecution result{"short screenshot result " + std::string(256, 's')};
        if (shot != 5) result.images = {shot == 3 || shot == 6 ? second : first};
        if (shot == 7) result.error = true;
        return result;
    };
    auto options = chat_options(); options.max_tool_result_chars = 1024; options.max_context_chars = 11000;
    RunService service(root, callbacks, options);
    const auto id = service.submit("bot", "group", "REAL_USER_TASK " + std::string(500, 'u'), "vision").run_id;
    CHECK(status(settled(service, id)) == "completed"); CHECK(rounds == 8); CHECK(reads == 7); CHECK(trimmed);
    assert_private_images(root, service, id);
}

void images_pause_resume_and_reuse(const std::filesystem::path& root, bool reopen) {
    const auto picture = fixture_image(31), fresh = fixture_image(97);
    const std::string pause_reason = reopen ? std::string(1999, 'p') + "\xe7\x95\x8c" : "Waiting for explicit human continuation";
    const std::string expected_pause = reopen ? std::string(1999, 'p') : pause_reason;
    std::atomic<int> rounds = 0, writes = 0, reads = 0;
    std::string id;
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages);
        const auto round = ++rounds;
        if (round <= 2) CHECK(images_count(messages) == 0);
        if (round == 1) return tool_reply({{"initial-action", "write_artifact", R"({"value":1})"}, {"must-not-run", "read_artifact", "{}"}});
        if (round == 2) {
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& item) { return item.content.find("fresh screenshot/observe") != std::string::npos; }));
            return tool_reply({{"repeat-action", "write_artifact", R"({"value":1})"}, {"fresh-observe", "read_artifact", "{}"}});
        }
        CHECK(images_count(messages) == 1); CHECK(messages.back().images.front().base64_data == fresh.base64_data);
        return tool_reply({finish_call()});
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        ToolExecution result{"verified", false, {}, {"artifact:test"}, "read-back passed"};
        if (call.name == "write_artifact") { ++writes; result.images = {picture}; result.pause_reason = pause_reason; }
        else { ++reads; result.images = {fresh}; }
        return result;
    };
    auto service = std::make_unique<RunService>(root, callbacks);
    id = service->submit("bot", "group", "perform then wait", "initial").run_id;
    CHECK(status(settled(*service, id)) == "interrupted"); CHECK(writes == 1); CHECK(reads == 0);
    const auto paused = service->get(id);
    CHECK(paused.at("tools").as_array().size() == 1);
    CHECK(paused.at("error").as_string() == expected_pause);
    CHECK(paused.at("tools").as_array().front().at("execution").at("pauseReason").as_string() == expected_pause);
    assert_private_images(root, *service, id);
    if (reopen) { service.reset(); service = std::make_unique<RunService>(root, callbacks); }
    CHECK(service->resume(id, "resume").attempt == 2);
    CHECK(status(settled(*service, id)) == "completed"); CHECK(writes == 1); CHECK(reads == 1); CHECK(rounds == 3);
    assert_private_images(root, *service, id);
}

void invalid_images_preserve_action_receipt(const std::filesystem::path& root) {
    int rounds = 0, writes = 0;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages); CHECK(images_count(messages) == 0);
        if (++rounds <= 2) return tool_reply({{rounds == 1 ? "image-action" : "retry-image-action", "write_artifact", "{}"}});
        return tool_reply({finish_call()});
    };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        ++writes;
        return ToolExecution{"actual verified action", false, {}, {"artifact:test"}, "read-back passed",
            {{"image/png", "PRIVATE_INVALID_IMAGE_BYTES", 1, 1}}};
    };
    RunService service(root, callbacks);
    const auto id = service.submit("bot", "group", "invalid image fixture", "initial").run_id;
    CHECK(status(settled(service, id)) == "interrupted");
    const auto full = service.get(id);
    CHECK(full.at("error").as_string().starts_with("tool_images_rejected"));
    CHECK(full.at("tools").as_array().front().at("state").as_string() == "finished");
    CHECK(!full.at("tools").as_array().front().at("execution").at("error").as_bool());
    CHECK(full.dump().find("PRIVATE_INVALID_IMAGE_BYTES") == std::string::npos);
    service.resume(id, "retry"); CHECK(status(settled(service, id)) == "completed"); CHECK(writes == 1);
}

void steering_during_tool(const std::filesystem::path& root, bool interruptible, bool completed_after_stop = false) {
    Gate executing;
    std::stop_token observed_token;
    std::atomic<int> writes = 0, reads = 0, cancellations = 0;
    int rounds = 0;
    std::string id;
    RunService* owner = nullptr;
    const auto image = fixture_image(45);
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.interrupt_tool_on_steer = [&, interruptible](std::string_view name) {
        CHECK(owner->brief_json(id).at("id").as_string() == id); // The predicate is outside the service lock.
        return interruptible && name == "write_artifact";
    };
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages);
        if (++rounds == 1) return tool_reply({{"in-flight", "write_artifact", "{}"}, {"stale-batch", "write_artifact", R"({"late":true})"}});
        if (rounds == 2) {
            CHECK(images_count(messages) == 0);
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) { return message.content == "steered instruction"; }));
            return tool_reply({{"repeated-after-steer", "write_artifact", "{}"}, {"fresh-observe", "read_artifact", "{}"}});
        }
        CHECK(images_count(messages) == 1); return tool_reply({finish_call()});
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, std::stop_token stop) {
        if (call.name == "read_artifact") { ++reads; return ToolExecution{"fresh read", false, {}, {"artifact:test"}, "read-back passed", {image}}; }
        ++writes; observed_token = stop;
        std::stop_callback stopped(stop, [&] {
            CHECK(owner->get(id).at("id").as_string() == id); ++cancellations;
        });
        executing.arrive(); executing.wait(stop);
        if (stop.stop_requested()) {
            if (completed_after_stop) return ToolExecution{"action completed before cancellation was acknowledged; obtain a fresh observation", false,
                Json::Object{{"actionCompleted", true}, {"observationRequired", true}}, {"artifact:test"}, "read-back passed"};
            return ToolExecution{"external action may have begun before interruption", true};
        }
        return ToolExecution{"completed original action", false, {}, {"artifact:test"}, "read-back passed", {image}};
    };
    RunOptions options; options.start_paused = true;
    RunService service(root, callbacks, options); owner = &service;
    id = service.submit("bot", "group", "initial", "initial").run_id; service.start(); executing.expect(1);
    if (interruptible) service.steer(id, "steered instruction", "supplement");
    else service.submit("bot", "group", "steered instruction", "supplement");
    CHECK(observed_token.stop_requested() == interruptible);
    CHECK(cancellations == (interruptible ? 1 : 0));
    if (!interruptible) executing.release();
    CHECK(status(settled(service, id)) == "completed"); CHECK(writes == 1); CHECK(reads == 1);
    const auto full = service.get(id);
    const bool uncertain = interruptible && !completed_after_stop;
    CHECK(full.at("tools").as_array().front().at("state").as_string() == (uncertain ? "uncertain" : "finished"));
    CHECK(full.at("tools").as_array()[2].at("execution").at("error").as_bool() == uncertain);
    if (completed_after_stop) CHECK(full.at("tools").as_array().front().at("execution").at("metadata").at("actionCompleted").as_bool());
    assert_private_images(root, service, id);
}

void pause_cannot_override_cancel(const std::filesystem::path& root) {
    Gate executing;
    auto callbacks = base_callbacks();
    callbacks.interrupt_tool_on_steer = [](std::string_view) { return true; };
    callbacks.model = [](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) {
        return tool_reply({{"wait", "write_artifact", "{}"}});
    };
    callbacks.execute_tool = [&](const auto&, const auto&, std::stop_token stop) {
        executing.arrive(); executing.wait(stop);
        return ToolExecution{"no action started", true, Json::Object{{"no_side_effects", true}}, {}, {}, {}, "Wait for a human"};
    };
    RunService service(root, callbacks);
    const auto id = service.submit("bot", "group", "cancel", "initial").run_id;
    executing.expect(1); service.cancel(id);
    CHECK(status(settled(service, id)) == "cancelled");
    for (const auto& event : all_events(service, id)) CHECK(event.at("type").as_string() != "run_interrupted");
}

void steering_ignores_stale_pause(const std::filesystem::path& root) {
    Gate executing;
    int rounds = 0, reads = 0;
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.interrupt_tool_on_steer = [](std::string_view) { return true; };
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages); CHECK(images_count(messages) == 0);
        if (++rounds == 1) return tool_reply({{"old-desktop-observe", "read_artifact", "{}"},
            {"stale-batch-observe", "read_artifact", R"({"followup":true})"}});
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) {
            return message.role == "user" && message.content == "Answer the new text request without the desktop";
        }));
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) {
            return message.role == "tool" && message.tool_call_id == "old-desktop-observe" &&
                Json::parse(message.content).at("pauseReason").as_string() == "The old desktop request needs human control";
        }));
        return text_reply("The new instruction completed");
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, std::stop_token stop) {
        CHECK(call.id == "old-desktop-observe"); ++reads;
        executing.arrive(); executing.wait(stop); CHECK(stop.stop_requested());
        return ToolExecution{"Desktop observation paused for human control", true,
            Json::Object{{"no_side_effects", true}}, {}, {}, {}, "The old desktop request needs human control"};
    };
    RunService service(root, callbacks, chat_options());
    const auto id = service.submit("bot", "group", "Inspect the old desktop request", "initial").run_id;
    executing.expect(1);
    service.steer(id, "Answer the new text request without the desktop", "new-instruction");
    CHECK(status(settled(service, id)) == "completed"); CHECK(rounds == 2); CHECK(reads == 1);
    const auto run = service.get(id);
    CHECK(run.at("response").as_string() == "The new instruction completed");
    CHECK(run.at("tools").as_array().front().at("execution").at("pauseReason").as_string() == "The old desktop request needs human control");
    for (const auto& event : all_events(service, id)) CHECK(event.at("type").as_string() != "run_interrupted");
}

void fake_finish_cannot_complete(const std::filesystem::path& root) {
    std::atomic<int> calls = 0;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) {
        if (++calls == 1) return tool_reply({finish_call("forged")});
        return text_reply("I completed it, trust me");
    };
    RunService service(root, callbacks);
    const auto run = service.submit("bot", "group", "work", "fake-finish");
    CHECK(status(settled(service, run.run_id)) == "failed");
    const auto full = service.get(run.run_id);
    CHECK(full.at("tools").as_array().front().at("execution").at("error").as_bool());
    CHECK(full.at("error").as_string().find("unverified_text_completion") != std::string::npos);
}

void completion_modes_and_reasoning_receipts(const std::filesystem::path& root) {
    {
        auto callbacks = base_callbacks();
        callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
            return text_reply("直接给出的文本答案");
        };
        RunService service(root / "text-only", callbacks);
        const auto run = service.submit("bot", "group", "不要写文件，结果里直接给答案", "text-only");
        CHECK(status(settled(service, run.run_id)) == "completed");
        CHECK(service.brief_json(run.run_id).at("response").as_string() == "直接给出的文本答案");

        const auto qa_run = service.submit("bot", "group", "你是什么模型", "qa-inquiry");
        CHECK(status(settled(service, qa_run.run_id)) == "completed");
        CHECK(service.brief_json(qa_run.run_id).at("response").as_string() == "直接给出的文本答案");

        const auto unverified_build = service.submit("bot", "group", "创建一个 HTML 页面", "unverified-build");
        CHECK(status(settled(service, unverified_build.run_id)) == "failed");
    }
    {
        auto callbacks = base_callbacks();
        std::atomic<int> calls = 0;
        callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
        callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
            if (++calls == 1) return tool_reply({{"read-facts", "read_artifact", "{}"}});
            return text_reply("基于真实读取结果的研究结论");
        };
        callbacks.execute_tool = [](const auto&, const auto&, auto) {
            return ToolExecution{"actual facts", false};
        };
        RunService service(root / "readonly", callbacks);
        const auto run = service.submit("bot", "group", "读取资料后给出研究结论", "readonly");
        CHECK(status(settled(service, run.run_id)) == "completed");
    }
    {
        auto callbacks = base_callbacks();
        std::atomic<int> calls = 0;
        callbacks.model = [&](const auto&, const auto& messages, const auto&, ModelChunk, std::stop_token) {
            if (++calls == 1) {
                auto reply = tool_reply({{"verify-call", "write_artifact", "{}"}});
                reply.reasoning_content = "reasoning attached to tool turn";
                return reply;
            }
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) {
                return message.role == "assistant" && message.reasoning_content == "reasoning attached to tool turn";
            }));
            return tool_reply({{"finish-evidence", "task_finish",
                R"({"summary":"Evidence ID delivery","evidenceCallIds":["verify-call"],"deliveryMode":"complete"})"}});
        };
        callbacks.execute_tool = [](const auto&, const auto&, auto) {
            return ToolExecution{"verified", false, {}, {"artifact:test"}, "read-back passed"};
        };
        RunService service(root / "evidence-ids", callbacks);
        const auto run = service.submit("bot", "group", "create and verify artifact", "evidence-ids");
        const auto done = settled(service, run.run_id);
        CHECK(status(done) == "completed");
        CHECK(done.at("artifacts").as_array().front().as_string() == "artifact:test");
        const auto full = service.get(run.run_id);
        CHECK(std::any_of(full.at("messages").as_array().begin(), full.at("messages").as_array().end(), [](const auto& message) {
            return message.at("role").as_string() == "assistant" &&
                message.at("reasoning_content").as_string() == "reasoning attached to tool turn";
        }));
    }
}

void same_bot_serial_other_bots_parallel(const std::filesystem::path& root) {
    Gate gate;
    std::mutex mutex;
    std::map<std::string, int> active;
    std::atomic<int> total = 0, peak = 0;
    RunService* observed_service = nullptr;
    auto callbacks = base_callbacks();
    callbacks.configuration = [&](const RunExecutionContext& context) {
        CHECK(observed_service->get(context.run_id).at("botId").as_string() == context.bot_id);
        ModelConfig config; config.model = context.bot_id; return config;
    };
    callbacks.model = [&](const ModelConfig& config, const auto&, const auto&, ModelChunk, std::stop_token stop) {
        { std::unique_lock lock(mutex); CHECK(++active[config.model] == 1); }
        const auto now = ++total; peak.store(std::max(peak.load(), now));
        gate.arrive(); CHECK(gate.wait(stop));
        --total;
        { std::unique_lock lock(mutex); --active[config.model]; }
        return text_reply("done");
    };
    RunService service(root, callbacks, chat_options()); observed_service = &service;
    const auto a = service.submit("a", "group-1", "a1", "a1"); gate.expect(1);
    const auto a2 = service.submit("a", "group-2", "a2", "a2");
    const auto b = service.submit("b", "group-1", "b1", "b1"); gate.expect(2);
    CHECK(peak == 2); gate.release();
    CHECK(status(settled(service, a.run_id)) == "completed");
    CHECK(status(settled(service, a2.run_id)) == "completed");
    CHECK(status(settled(service, b.run_id)) == "completed");
}

void queue_pause_reorder(const std::filesystem::path& root) {
    std::mutex mutex;
    std::vector<std::string> order;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
        std::unique_lock lock(mutex); order.push_back(messages.back().content); return text_reply("done");
    };
    RunService service(root, callbacks, chat_options());
    service.pause_queue("bot", "group", true);
    const auto first = service.submit("bot", "group", "first", "first", true);
    const auto second = service.submit("bot", "group", "second", "second", true);
    CHECK(service.has_group_activity("group"));
    CHECK(!service.has_group_activity("unrelated-group"));
    CHECK(service.brief_json(first.run_id).at("status").as_string() == "queued");
    service.reorder_queue("bot", "group", {second.run_id, first.run_id});
    service.pause_queue("bot", "group", false);
    CHECK(status(settled(service, first.run_id)) == "completed");
    CHECK(status(settled(service, second.run_id)) == "completed");
    CHECK(order == std::vector<std::string>({"second", "first"}));
    CHECK(!service.has_group_activity("group"));
}

void group_activity_waits_for_callback(const std::filesystem::path& root) {
    Gate model;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) {
        model.arrive(); model.wait(); return text_reply("late result");
    };
    RunService service(root, callbacks, chat_options());
    const auto run = service.submit("bot", "group", "wait for callback", "guard-request");
    model.expect(1);
    CHECK(service.has_group_activity("group"));
    CHECK(status(service.cancel(run.run_id)) == "cancelled");
    CHECK(service.has_group_activity("group"));
    model.release();
    CHECK(status(settled(service, run.run_id)) == "cancelled");
    CHECK(!service.has_group_activity("group"));
}

void observer_disconnect_does_not_cancel(const std::filesystem::path& root) {
    Gate model, observer;
    auto callbacks = base_callbacks();
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token stop) {
        model.arrive(); CHECK(model.wait(stop)); return text_reply("survived disconnect");
    };
    RunService service(root, callbacks, chat_options());
    const auto run = service.submit("bot", "group", "work", "observer"); model.expect(1);
    const auto cursor = static_cast<std::uint64_t>(service.brief_json(run.run_id).at("lastSeq").as_number());
    std::jthread connection([&](std::stop_token stop) {
        observer.arrive(); service.wait_events(run.run_id, cursor, 5s, stop);
    });
    observer.expect(1); connection.request_stop(); connection.join();
    CHECK(status(service.brief_json(run.run_id)) == "running");
    model.release(); CHECK(status(settled(service, run.run_id)) == "completed");
}

void queued_restart_requires_resume_and_start(const std::filesystem::path& root) {
    std::string id;
    std::atomic<int> calls = 0;
    RunService* owner = nullptr;
    auto callbacks = base_callbacks();
    callbacks.configuration = [&](const RunExecutionContext& context) {
        CHECK(owner != nullptr);
        CHECK(owner->get(context.run_id).at("id").as_string() == context.run_id);
        return ModelConfig{};
    };
    callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) { ++calls; return text_reply("explicitly resumed"); };
    auto options = chat_options(); options.start_paused = true;
    {
        RunService service(root, callbacks, options); owner = &service;
        id = service.submit("bot", "group", "queued before restart", "initial").run_id;
        CHECK(status(service.brief_json(id)) == "queued"); CHECK(calls == 0);
        service.shutdown();
    }
    owner = nullptr;
    {
        RunService service(root, callbacks, options);
        CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(calls == 0);
        owner = &service;
        service.resume(id, "explicit-resume");
        CHECK(status(service.brief_json(id)) == "queued"); CHECK(calls == 0);
        service.start(); service.start();
        CHECK(status(settled(service, id)) == "completed"); CHECK(calls == 1);
    }
}

void bounded_context_and_segmented_events(const std::filesystem::path& root) {
    {
        std::atomic<int> calls = 0;
        auto callbacks = base_callbacks();
        callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk, std::stop_token) { ++calls; return text_reply("bad"); };
        auto options = chat_options(); options.max_context_chars = 800;
        RunService service(root / "oversize", callbacks, options);
        const auto run = service.submit("bot", "group", std::string(1000, 'x'), "oversize");
        CHECK(status(settled(service, run.run_id)) == "failed"); CHECK(calls == 0);
        CHECK(service.get(run.run_id).at("error").as_string().find("context_budget_exceeded") != std::string::npos);
    }
    std::string id;
    std::uint64_t sequence = 0;
    {
        auto callbacks = base_callbacks();
        callbacks.model = [&](const ModelConfig&, const auto&, const auto&, ModelChunk chunk, std::stop_token) {
            for (int i = 0; i < 140; ++i) chunk("text", std::string(256, 'a'));
            return text_reply("many persisted chunks");
        };
        RunService service(root / "segments", callbacks, chat_options());
        id = service.submit("bot", "group", "stream", "stream").run_id;
        sequence = static_cast<std::uint64_t>(settled(service, id).at("lastSeq").as_number());
        CHECK(sequence > 128);
        CHECK(all_events(service, id).size() == sequence);
        const auto page = service.events_after(id, 128, 3);
        CHECK(page.at("events").as_array().front().at("seq").as_number() == 129);
    }
    {
        auto callbacks = base_callbacks();
        RunService service(root / "segments", callbacks, chat_options());
        CHECK(static_cast<std::uint64_t>(service.get(id).at("lastSeq").as_number()) == sequence);
        CHECK(all_events(service, id).size() == sequence);
    }
    {
        int rounds = 0;
        auto callbacks = base_callbacks();
        callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
        callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, std::stop_token) {
            assert_pairs(messages);
            if (++rounds <= 6) return tool_reply({{"read-" + std::to_string(rounds), "read_artifact", "{}"}});
            CHECK(messages.size() < 14); return text_reply("read complete");
        };
        callbacks.execute_tool = [](const auto&, const auto&, auto) { return ToolExecution{std::string(500, 'x')}; };
        auto options = chat_options(); options.max_context_chars = 1900;
        RunService service(root / "pairs", callbacks, options);
        id = service.submit("bot", "group", "read", "pairs").run_id;
        CHECK(status(settled(service, id)) == "completed");
        CHECK(service.get(id).at("messages").as_array().size() >= 15);
    }
}

#ifdef _WIN32
int crash_child(const std::filesystem::path& root, bool during_tool) {
    auto callbacks = base_callbacks();
    callbacks.model = [](const ModelConfig&, const std::vector<ModelMessage>& messages,
                          const auto&, ModelChunk, std::stop_token) {
        if (std::any_of(messages.begin(), messages.end(), [](const auto& message) { return message.role == "tool"; })) std::_Exit(0);
        return tool_reply({{"crash-write", "write_artifact", R"({"value":1})"}});
    };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        std::ofstream output(root / "crash-artifact.txt"); output << "external action happened"; output.close();
        if (during_tool) std::_Exit(0);
        return ToolExecution{"created", false, {}, {"artifact:test"}, "read-back passed"};
    };
    RunService service(root, callbacks);
    service.submit("bot", "group", "crash task", "crash-request");
    // This is a deliberately abrupt process-level fixture. No service destructor
    // runs; the child exits only after the selected durable/uncertain boundary.
    Gate never;
    never.wait();
    return 7;
}

void crash_recovery(const std::filesystem::path& root, bool during_tool) {
    std::filesystem::create_directories(root);
    wchar_t executable[32768]{};
    const auto size = GetModuleFileNameW(nullptr, executable, 32768);
    CHECK(size > 0 && size < 32768);
    std::wstring command = L"\"" + std::wstring(executable) + L"\" " +
        (during_tool ? L"--crash-during-tool" : L"--crash-after-result") + L" \"" + root.wstring() + L"\"";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    CHECK(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, root.c_str(), &startup, &process));
    const auto waited = WaitForSingleObject(process.hProcess, 10000);
    if (waited != WAIT_OBJECT_0) TerminateProcess(process.hProcess, 8);
    DWORD exit_code = 0; GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CHECK(waited == WAIT_OBJECT_0); CHECK(exit_code == 0);
    CHECK(std::filesystem::exists(root / "crash-artifact.txt"));
    int model_calls = 0, writes = 0, reads = 0;
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.model = [&](const ModelConfig&, const auto& messages, const auto&, ModelChunk, std::stop_token) {
        assert_pairs(messages);
        if (++model_calls == 1) return tool_reply({{"retry-with-new-id", "write_artifact", R"({"value":1})"}});
        if (during_tool && model_calls == 2) return tool_reply({{"verify-crash", "read_artifact", "{}"}});
        return tool_reply({finish_call()});
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        if (call.name == "write_artifact") ++writes; else ++reads;
        return ToolExecution{"artifact inspected", false, {}, {"artifact:test"}, "read-back passed"};
    };
    RunService service(root, callbacks);
    const auto runs = service.list(); CHECK(runs.as_array().size() == 1);
    const auto id = runs.as_array().front().at("id").as_string();
    CHECK(status(service.brief_json(id)) == "interrupted"); CHECK(model_calls == 0);
    CHECK(service.get(id).at("tools").as_array().front().at("state").as_string() == (during_tool ? "uncertain" : "finished"));
    service.resume(id, "resume-after-crash");
    CHECK(status(settled(service, id)) == "completed"); CHECK(writes == 0);
    CHECK(reads == (during_tool ? 1 : 0));
}
#endif

void private_conversation_snapshot(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    std::atomic_int calls{};
    callbacks.system_prompt = [](const auto&) { return "INTERNAL_SYSTEM_NOT_EXPORTED"; };
    callbacks.model = [&](const auto&, const auto&, const auto&, auto chunk, auto) {
        chunk("thinking", "INTERNAL_THINKING_NOT_EXPORTED");
        return text_reply("public-answer-" + std::to_string(++calls));
    };
    std::vector<Message> before;
    {
        RunService service(root, callbacks, chat_options());
        const auto one = service.submit("private-owner", "", "原始要求", "private-first");
        CHECK(status(settled(service, one.run_id)) == "completed");
        service.resume(one.run_id, "private-next", "补充要求");
        CHECK(status(settled(service, one.run_id)) == "completed");
        const auto grouped = service.submit("private-owner", "group-private", "GROUP_MUST_NOT_APPEAR", "group-only");
        CHECK(status(settled(service, grouped.run_id)) == "completed");
        const auto other = service.submit("private-other", "", "OTHER_MUST_NOT_APPEAR", "other-only");
        CHECK(status(settled(service, other.run_id)) == "completed");
        const auto erased = service.submit("private-owner", "", "ERASED_MUST_NOT_APPEAR", "erased-only");
        CHECK(status(settled(service, erased.run_id)) == "completed"); service.erase(erased.run_id);
        before = service.private_conversation("private-owner");
        CHECK(before.size() == 4);
        CHECK(before[0].text == "原始要求" && before[1].text == "public-answer-1");
        CHECK(before[2].text == "补充要求" && before[3].text == "public-answer-2");
        for (const auto& row : before) {
            CHECK(row.bot_id == "private-owner" && row.group_id.empty() && row.mode == Mode::Work);
            CHECK(row.created_at_ms > 0 && !row.context);
            CHECK(row.text.find("INTERNAL_") == std::string::npos);
        }
        bool limited = false;
        try { (void)service.private_conversation("private-owner", 3); }
        catch (const StoreError& error) { limited = error.code() == StoreErrorCode::LimitExceeded; }
        CHECK(limited); limited = false;
        try { (void)service.private_conversation("private-owner", 20000, 8); }
        catch (const StoreError& error) { limited = error.code() == StoreErrorCode::LimitExceeded; }
        CHECK(limited);
        CHECK(service.private_conversation("empty-owner").empty());
    }
    RunService reopened(root, callbacks, chat_options());
    const auto after = reopened.private_conversation("private-owner"); CHECK(after.size() == before.size());
    for (std::size_t i = 0; i < after.size(); ++i) {
        CHECK(after[i].text == before[i].text && after[i].actor == before[i].actor && after[i].created_at_ms == before[i].created_at_ms);
    }
    CHECK(calls == 5);
}
void work_compaction_lifecycle(const std::filesystem::path& root, const std::string& scenario) {
    Gate summarizing;
    std::atomic_int model_calls{0}, summary_calls{0}, reads{0};
    auto callbacks = base_callbacks();
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "read_artifact"; };
    callbacks.compaction_limits = [&](const auto&, const auto&) {
        WorkCompactionLimits limits;
        limits.context_tokens = scenario == "overflow" || scenario == "missing-old-provider" ? 1048576 : 32768;
        limits.output_tokens = 8192; limits.buffer_tokens = 8192;
        if (scenario == "large-output-cap") { limits.output_tokens = 30000; limits.buffer_tokens = 65536; }
        limits.summary_output_tokens = 2048; return limits;
    };
    callbacks.compaction_configuration = [&](const auto&, const ModelConfig& current, const Json& previous) {
        if (scenario == "missing-old-provider") throw std::runtime_error("Removed provider, not needed for a small request");
        if (model_calls >= 1) {
            CHECK(previous.is_object() && previous.at("model").as_string() == "bot");
            CHECK(!previous.find("apiKey") && !previous.find("api_key") && !previous.find("baseUrl"));
        }
        return current;
    };
    callbacks.compaction_model = [&](const auto&, const auto& messages, const auto& tools, ModelChunk, std::stop_token stop) {
        CHECK(tools.empty()); CHECK(!messages.empty());
        const auto pass = ++summary_calls;
        if ((scenario == "cancel" || scenario == "steer") && pass == 1) {
            summarizing.arrive(); (void)summarizing.wait(stop);
            return text_reply("STALE_SUMMARY: a result from before the input revision changed.");
        }
        if (scenario == "failure") throw std::runtime_error("Untrusted upstream error must not be persisted");
        return text_reply("FRESH_SUMMARY: Three earlier read operations were performed; their original receipts remain authoritative.");
    };
    callbacks.execute_tool = [&](const auto& call, const auto&, auto) {
        CHECK(call.name == "read_artifact"); ++reads;
        return ToolExecution{"Actual synthetic read", false, {}, {"artifact:test"}, "read-back passed"};
    };
    callbacks.model = [&](const ModelConfig&, const std::vector<ModelMessage>& messages, const auto&, ModelChunk, auto) {
        assert_pairs(messages);
        const auto pass = ++model_calls;
        if (scenario == "missing-old-provider") return text_reply("Small request completed without old provider");
        if (scenario == "large-output-cap") {
            CHECK(work_context_tokens(messages) > 2768);
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) { return message.content == std::string(19000, 'u'); }));
            return text_reply("Request completed with adjustable output reservation");
        }
        if (pass <= 3) {
            auto reply = tool_reply({{"read-" + std::to_string(pass), "read_artifact", "{\"pass\":" + std::to_string(pass) + "}"}});
            reply.text = std::string(28000, static_cast<char>('a' + pass)); return reply;
        }
        if (scenario == "overflow") throw ModelError(ModelFailure::ContextWindowExceeded, "Model context window exceeded");
        CHECK(scenario == "steer" || scenario == "failure");
        if (scenario == "steer")
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& m) { return m.role == "user" && m.content == "new instruction"; }));
        else
            CHECK(std::count_if(messages.begin(), messages.end(), [](const auto& m) { return m.role == "assistant" && m.content.size() == 28000; }) == 3);
        CHECK(std::none_of(messages.begin(), messages.end(), [](const auto& m) { return m.content.find("STALE_SUMMARY") != std::string::npos; }));
        return tool_reply({finish_call()});
    };
    auto options = RunOptions{};
    options.start_paused = true;
    if (scenario == "missing-old-provider" || scenario == "large-output-cap") options.require_verified_finish = false;
    std::string id;
    {
        RunService service(root, callbacks, options);
        id = service.submit("bot", "", scenario == "large-output-cap" ? std::string(19000, 'u') : "original instruction", "initial").run_id;
        CHECK(service.context_usage(id).is_null());
        CHECK(model_calls == 0 && summary_calls == 0);
        service.start();
        if (scenario == "steer" || scenario == "cancel") {
            summarizing.expect(1);
            const auto usage = service.context_usage(id);
            CHECK(usage.at("compacting").as_bool());
            CHECK(usage.at("inputTokens").as_number() > 21000);
            CHECK(usage.at("contextWindow").as_number() == 32768);
            if (scenario == "cancel") (void)service.cancel(id);
            else (void)service.steer(id, "new instruction", "steer");
        }
        const auto final = settled(service, id);
        CHECK(status(final) == (scenario == "cancel" ? "cancelled" : scenario == "overflow" ? "interrupted" : "completed"));
        const auto full = service.get(id);
        const auto usage = service.context_usage(id);
        CHECK(usage.dump() == full.at("contextUsage").dump());
        CHECK(usage.at("inputTokens").as_number() > 0);
        CHECK(!usage.at("compacting").as_bool() && !usage.at("providerReported").as_bool());
        CHECK(usage.at("seq").as_number() <= full.at("sequence").as_number());
        CHECK(usage.dump().find("SUMMARY") == std::string::npos);
        if (scenario == "steer" || scenario == "overflow") CHECK(usage.at("inputTokens").as_number() < 12000);
        if (scenario == "failure") CHECK(usage.at("inputTokens").as_number() > 21000);
        const auto saved_state = work_compaction_state_from_json(full.at("workCompaction"));
        if (scenario == "missing-old-provider" || scenario == "large-output-cap") { CHECK(model_calls == 1); CHECK(summary_calls == 0); }
        else {
            CHECK(reads == 3);
            std::size_t original_segments = 0;
            for (const auto& row : full.at("messages").as_array())
                if (row.at("role").as_string() == "assistant" && row.at("content").as_string().size() == 28000) ++original_segments;
            CHECK(original_segments == 3);
            if (scenario == "steer" || scenario == "overflow") CHECK(saved_state.summary.find("FRESH_SUMMARY") != std::string::npos);
            else CHECK(saved_state.summary.empty());
            if (scenario == "steer") CHECK(summary_calls == 2 && model_calls == 4);
            if (scenario == "cancel") CHECK(summary_calls == 1 && model_calls == 3);
            if (scenario == "failure") CHECK(summary_calls == 1 && model_calls == 4);
            if (scenario == "overflow") CHECK(summary_calls == 1 && model_calls == 5);
            for (const auto& event : all_events(service, id)) {
                CHECK(event.dump().find("STALE_SUMMARY") == std::string::npos);
                CHECK(event.dump().find("Untrusted upstream error") == std::string::npos);
            }
        }
    }
    if (scenario == "cancel") {
        const auto path = root / "runs" / id / "snapshot.json";
        std::ifstream input(path, std::ios::binary);
        const std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        input.close();
        auto snapshot = Json::parse(bytes).as_object();
        snapshot["workCompaction"] = Json::Object{{"version", 999}, {"summary", "Invalid derived cache"}};
        auto usage = snapshot.at("contextUsage").as_object();
        usage["compacting"] = true; usage["privateField"] = "must not be exposed";
        snapshot["contextUsage"] = std::move(usage);
        std::ofstream output(path, std::ios::binary | std::ios::trunc); output << Json(std::move(snapshot)).dump();
    }
    const auto before = model_calls.load();
    {
        RunService restored(root, callbacks, options);
        const auto full = restored.get(id);
        CHECK(model_calls == before);
        CHECK(!restored.context_usage(id).at("compacting").as_bool());
        CHECK(!restored.context_usage(id).find("privateField"));
        const auto saved_state = work_compaction_state_from_json(full.at("workCompaction"));
        if (scenario == "steer" || scenario == "overflow") CHECK(saved_state.summary.find("FRESH_SUMMARY") != std::string::npos);
        else CHECK(saved_state.summary.empty());
    }
}
void provider_context_telemetry(const std::filesystem::path& root, bool reported) {
    auto callbacks = base_callbacks();
    std::atomic_int calls{0};
    callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, auto) {
        ++calls; return ModelReply{"Final private answer", {}, reported ? 3210 : 0, 50};
    };
    auto options = chat_options(); options.start_paused = true;
    std::string id;
    {
        RunService service(root, callbacks, options);
        id = service.submit("bot", "", "Private source text", "request").run_id;
        for (int i = 0; i < 10; ++i) CHECK(service.context_usage(id).is_null());
        CHECK(calls == 0);
        service.start(); CHECK(status(settled(service, id)) == "completed");
        const auto usage = service.context_usage(id);
        if (reported) {
            CHECK(usage.at("inputTokens").as_number() == 3210);
            CHECK(usage.at("contextWindow").as_number() == 0);
            CHECK(usage.at("providerReported").as_bool() && !usage.at("compacting").as_bool());
            CHECK(usage.dump().find("private") == std::string::npos);
        } else CHECK(usage.is_null());
    }
    RunService restored(root, callbacks, options);
    CHECK(calls == 1);
    if (reported) CHECK(restored.context_usage(id).at("inputTokens").as_number() == 3210);
    else CHECK(restored.context_usage(id).is_null());
}
void partial_finish_evidence(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    callbacks.tools = [](const auto&) {
        return std::vector<ModelTool>{{"team_status", "Synthetic partial team evidence", Json::Object{{"type", "object"}}}};
    };
    int calls = 0;
    callbacks.model = [&](const auto&, const auto&, const auto&, auto, auto) {
        ++calls;
        if (calls == 1) return tool_reply({{"status", "team_status", "{}"}});
        if (calls == 2) return tool_reply({{"finish-complete", "task_finish",
            R"({"summary":"Incorrect complete claim","artifacts":["artifact:partial"],"verification":"team partial evidence","deliveryMode":"complete"})"}});
        return tool_reply({{"finish-partial", "task_finish",
            R"({"summary":"部分交付：仅已完成成果","artifacts":["artifact:partial"],"verification":"team partial evidence","deliveryMode":"partial"})"}});
    };
    callbacks.is_read_only_tool = [](std::string_view name) { return name == "team_status"; };
    callbacks.execute_tool = [](const ToolCall& call, const auto&, auto) {
        CHECK(call.name == "team_status");
        return ToolExecution{"partial team state", false, Json::Object{{"deliveryState", "partial"}},
            {"artifact:partial"}, "team partial evidence"};
    };
    RunService service(root, callbacks, chat_options());
    const auto id = service.submit("alpha", "group", "Partial group result", "partial").run_id;
    const auto run = settled(service, id);
    CHECK(status(run) == "partial");
    CHECK(run.at("response").as_string().find("部分交付") != std::string::npos);
    CHECK(run.at("error").as_string().empty());
    CHECK(run.at("artifacts").as_array().size() == 1);
    const auto full = service.get(id);
    bool rejected_complete = false, accepted_partial = false;
    for (const auto& receipt : full.at("tools").as_array()) {
        if (receipt.at("call").at("name").as_string() != "task_finish") continue;
        if (receipt.at("call").at("id").as_string() == "finish-complete" && receipt.at("execution").at("error").as_bool()) rejected_complete = true;
        if (receipt.at("call").at("id").as_string() == "finish-partial" && !receipt.at("execution").at("error").as_bool()) accepted_partial = true;
    }
    CHECK(rejected_complete && accepted_partial);
}
void named_file_delivery(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    int round = 0;
    callbacks.model = [&](const auto&, const auto&, const auto&, auto, auto) {
        if (++round == 1) return tool_reply({{"notes", "write_artifact", "{}"}});
        if (round > 4) throw std::runtime_error("Missing output did not stop the run");
        return tool_reply({{"finish-" + std::to_string(round), "task_finish",
            R"({"summary":"Failure documented","evidenceCallIds":["notes"]})"}});
    };
    callbacks.execute_tool = [](const auto&, const auto&, auto) {
        return ToolExecution{"notes saved", false, {}, {"scratch/notes.md"}, "notes verified"};
    };
    RunOptions options;
    options.auto_bind_verified_receipts = true;
    RunService service(root, callbacks, options);
    const auto id = service.submit("worker", "", "读取 input.txt 后创建 “deliveries/report.txt”。", "start").run_id;
    const auto result = settled(service, id);
    CHECK(status(result) == "interrupted");
    CHECK(result.at("error").as_string().find("deliveries/report.txt") != std::string::npos);
    CHECK(round == 4);
}

void failed_acceptance(const std::filesystem::path& root) {
    auto cb = base_callbacks();
    auto original_tools = cb.tools;
    cb.tools = [original_tools](const auto& ctx) {
        auto list = original_tools(ctx);
        list.push_back({"sandbox_exec", "Run test", Json::Object{}});
        return list;
    };
    int round = 0;
    cb.model = [&](const auto&, const auto&, const auto&, auto, auto) {
        switch (++round) {
        case 1: return tool_reply({{"test", "sandbox_exec", R"({"argv":["npm","test"],"acceptanceCheck":true})"}});
        case 2: return tool_reply({{"file", "write_artifact", "{}"}});
        case 3: return tool_reply({{"bad", "task_finish", R"({"summary":"done","evidenceCallIds":["file"]})"}});
        case 4: return tool_reply({{"retry", "sandbox_exec", R"({"argv":["npm","test"],"cwd":"."})"}});
        case 5: return tool_reply({{"done", "task_finish", R"({"summary":"done","evidenceCallIds":["retry"]})"}});
        default: throw std::runtime_error("Unexpected extra round");
        }
    };
    cb.execute_tool = [](const ToolCall& call, const auto&, auto) {
        const bool failed = call.id == "test";
        if (call.name == "sandbox_exec")
            return ToolExecution{"test", failed, Json::Object{{"no_side_effects",true}}, {}, failed ? "" : "exit 0"};
        return ToolExecution{"verified", false, {}, {"result.txt"}, "verified"};
    };
    RunService service(root, cb);
    auto id = service.submit("worker", "", "Fix the regression and run tests", "start").run_id;
    CHECK(status(settled(service, id)) == "completed");
    CHECK(round == 5);
    const auto run = service.get(id);
    CHECK(run.at("tools").as_array().at(2).at("execution").at("result").as_string().starts_with("unresolved_acceptance_check:"));
}
void resumed_delivery(const std::filesystem::path& root) {
    auto callbacks = base_callbacks();
    int calls = 0, executions = 0;
    callbacks.model = [&](const auto&, const auto&, const auto&, auto, auto) {
        switch (++calls) {
        case 1: return tool_reply({{"draft", "write_artifact", R"({"stage":1})"}});
        case 2: return tool_reply({{"pause", "task_finish",
            R"({"summary":"Draft ready","deliveryMode":"partial","evidenceCallIds":["draft"]})"}});
        case 3: return tool_reply({{"final", "write_artifact", R"({"stage":2})"}});
        case 4: return tool_reply({{"bad-id", "task_finish",
            R"({"summary":"Bad citation","evidenceCallIds":["missing"]})"}});
        case 5: return tool_reply({{"done", "task_finish",
            R"({"summary":"Final ready","evidenceCallIds":["final"]})"}});
        default: throw std::runtime_error("Unexpected extra model round");
        }
    };
    callbacks.execute_tool = [&](const ToolCall& call, const auto&, auto) {
        ++executions;
        const bool draft = call.id == "draft";
        return ToolExecution{"verified", false, Json::Object{{"deliveryState", draft ? "partial" : "complete"}},
            {draft ? "draft.txt" : "final.txt"}, draft ? "draft checked" : "final checked"};
    };
    RunOptions options;
    options.auto_bind_verified_receipts = true;
    RunService service(root, callbacks, options);
    const auto id = service.submit("alpha", "group", "Prepare a report", "start").run_id;
    CHECK(status(settled(service, id)) == "partial");
    service.resume(id, "continue", "Finish the report");
    const auto done = settled(service, id);
    CHECK(status(done) == "completed");
    CHECK(done.at("response").as_string() == "Final ready");
    CHECK(calls == 5 && executions == 2);
    const auto full = service.get(id);
    const auto& receipts = full.at("tools").as_array();
    CHECK(receipts.at(3).at("execution").at("error").as_bool());
    CHECK(receipts.back().at("execution").at("verification").as_string() == "final checked");
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
    try {
#ifdef _WIN32
        if (argc == 3) {
            const std::wstring mode = argv[1];
            if (mode == L"--crash-during-tool" || mode == L"--crash-after-result") {
                return crash_child(std::filesystem::path(argv[2]), mode == L"--crash-during-tool");
            }
        }
#endif
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const std::filesystem::path root = std::filesystem::path(argv[1]) /
            ("runs-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);
        solo_cli_before_model(root / "solo-cli");
        cli_receipt_delivery(root / "cli-receipt-delivery");
        steering_and_idempotency(root / "steering");
        cancel_blocks_returned_tools(root / "cancel-model");
        cancel_during_tool_batch(root / "cancel-tool");
        resume_does_not_replay_success(root / "resume");
        repeat_completed_execution(root / "repeat-build", "success");
        repeat_completed_execution(root / "repeat-exit7", "exit7");
        repeat_completed_execution(root / "repeat-timeout", "timeout");
        repeat_completed_execution(root / "repeat-unknown", "unknown");
        repeat_completed_execution(root / "repeat-not-allowlisted", "exit7", false);
        wrapped_receipt_recovery(root / "direct-to-wrapper-success", false, false);
        wrapped_receipt_recovery(root / "wrapper-to-direct-success", true, false);
        wrapped_receipt_recovery(root / "direct-to-wrapper-uncertain", false, true);
        wrapped_receipt_recovery(root / "wrapper-to-direct-uncertain", true, true);
        invalid_fingerprints_block_execution(root / "invalid-fingerprints");
        ephemeral_images_and_context(root / "ephemeral-images");
        images_pause_resume_and_reuse(root / "images-resume", false);
        images_pause_resume_and_reuse(root / "images-restart", true);
        invalid_images_preserve_action_receipt(root / "invalid-images");
        steering_during_tool(root / "interrupt-tool", true);
        steering_during_tool(root / "legacy-tool", false);
        steering_during_tool(root / "interrupt-tool-completed", true, true);
        pause_cannot_override_cancel(root / "pause-cancel");
        steering_ignores_stale_pause(root / "pause-steering");
        fake_finish_cannot_complete(root / "fake-finish");
        failed_acceptance(root / "failed-acceptance");
        named_file_delivery(root / "named-delivery");
        resumed_delivery(root / "resumed-delivery");
        partial_finish_evidence(root / "partial-finish");
        completion_modes_and_reasoning_receipts(root / "completion-modes");
        same_bot_serial_other_bots_parallel(root / "parallel");
        queue_pause_reorder(root / "queue");
        group_activity_waits_for_callback(root / "group-activity");
        observer_disconnect_does_not_cancel(root / "observer");
        queued_restart_requires_resume_and_start(root / "queued-restart");
        bounded_context_and_segmented_events(root / "budgets-events");
#ifdef _WIN32
        crash_recovery(root / "crash-after-result", false);
        crash_recovery(root / "crash-during-tool", true);
#endif
        private_conversation_snapshot(root / "private-conversation-export");
        for (const auto* scenario : {"steer", "cancel", "failure", "overflow", "missing-old-provider", "large-output-cap"})
            work_compaction_lifecycle(root / (std::string("work-compaction-") + scenario), scenario);
        provider_context_telemetry(root / "chat-context-reported", true);
        provider_context_telemetry(root / "chat-context-unknown", false);
        std::cout << "runs tests passed (injected models/tools, private conversation export, repeatable completed builds, real worker threads and crash recovery)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "runs test failed: " << error.what() << '\n'; return 1;
    }
}
