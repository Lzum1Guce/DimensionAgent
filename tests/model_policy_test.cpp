#include "dimension/model_catalog.hpp"
#include "dimension/model_routing.hpp"
#include "dimension/runs.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
int checks = 0;
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(x) check(static_cast<bool>(x), #x, __LINE__)
template<class Fn> void rejects(Fn fn) {
    bool caught = false;
    try { fn(); } catch (const std::exception&) { caught = true; }
    CHECK(caught);
}
Json catalog(std::initializer_list<const char*> ids) {
    Json::Array values;
    for (const auto* id : ids) values.emplace_back(Json::Object{{"id", id}});
    return Json::Object{{"data", std::move(values)}};
}
ProviderCatalogQuery query(std::string id = "provider") {
    return {std::move(id), "1", ModelConfig{"http://127.0.0.1:1/v1", "synthetic", "manual"}, {"manual"}};
}
ModelRoute route(std::string tier, std::string model) {
    return {std::move(tier), "fixture-provider", ModelConfig{"http://127.0.0.1:1/v1", "synthetic", std::move(model)}};
}
void catalog_policy() {
    CHECK(normalize_model_catalog(catalog({"b", "a", "a"})) == std::vector<std::string>({"a", "b"}));
    CHECK(normalize_model_catalog(catalog({})).empty());
    rejects([] { (void)normalize_model_catalog(Json::Object{{"models", Json::Array{}}}); });
    rejects([] { (void)normalize_model_catalog(Json::Object{{"data", Json::Array{Json::Object{{"id", "bad\nname"}}}}}); });
    Json::Array too_many;
    for (int i = 0; i < 513; ++i) too_many.emplace_back(Json::Object{{"id", std::to_string(i)}});
    rejects([&] { (void)normalize_model_catalog(Json::Object{{"data", too_many}}); });
    int calls = 0, fail = 0;
    Json body = catalog({"discovered", "manual"});
    ModelCatalogService service([&](const ModelConfig&, std::stop_token) {
        ++calls;
        if (fail == 1) throw ModelError(ModelFailure::Http, "DO_NOT_EXPOSE_SECRET", 404);
        if (fail == 2) throw ModelError(ModelFailure::Http, "DO_NOT_EXPOSE_SECRET", 401);
        if (fail == 3) throw std::runtime_error("DO_NOT_EXPOSE_SECRET");
        return body;
    });
    auto input = query();
    CHECK(service.query(input, false).models == std::vector<std::string>{"manual"} && calls == 0);
    auto view = service.query(input, true);
    CHECK(view.status == "ready" && view.cached && !view.updated_at.empty());
    CHECK(view.models == std::vector<std::string>({"discovered", "manual"}));
    CHECK(service.query(input, false).models == view.models && calls == 1);
    for (fail = 1; fail <= 3; ++fail) {
        const auto error = service.query(input, true);
        CHECK(error.models == view.models && error.cached);
        CHECK(error.status == (fail == 1 ? "unsupported" : "error"));
        CHECK(error.json().dump().find("DO_NOT_EXPOSE_SECRET") == std::string::npos);
    }
    input.revision = "2";
    CHECK(service.query(input, false).models == std::vector<std::string>{"manual"});
    fail = 0; body = catalog({"new-model"});
    CHECK(service.query(input, true).models == std::vector<std::string>({"manual", "new-model"}));
}
void catalog_concurrency() {
    std::atomic_int active{0}, maximum{0}, calls{0};
    ModelCatalogService service([&](const ModelConfig&, std::stop_token) {
        ++calls;
        const int now = ++active;
        auto peak = maximum.load();
        while (peak < now && !maximum.compare_exchange_weak(peak, now)) {}
        std::this_thread::sleep_for(8ms); --active;
        return catalog({"actual"});
    });
    std::vector<ProviderCatalogQuery> queries;
    for (int i = 0; i < 70; ++i) queries.push_back(query("provider-" + std::to_string(i)));
    const auto values = service.query_all(queries, true);
    CHECK(calls == 64 && maximum <= 4 && maximum >= 2 && values.size() == 70);
    for (std::size_t i = 0; i < values.size(); ++i) CHECK(values[i].status == (i < 64 ? "ready" : "deferred"));
    std::promise<void> entered, release;
    auto released = release.get_future().share();
    std::atomic_int repeated{0};
    ModelCatalogService coalesced([&](const ModelConfig&, std::stop_token) {
        ++repeated; entered.set_value(); released.wait(); return catalog({"actual"});
    });
    auto first = std::async(std::launch::async, [&] { return coalesced.query(query(), true); });
    CHECK(entered.get_future().wait_for(2s) == std::future_status::ready);
    CHECK(coalesced.query(query(), true).status == "refreshing" && repeated == 1);
    release.set_value(); CHECK(first.get().status == "ready");
}
void routing_policy() {
    for (int code : {408, 429, 500, 503, 599})
        CHECK(!model_upgrade_reason(std::make_exception_ptr(ModelError(ModelFailure::Http, "secret", code))).empty());
    for (int code : {400, 401, 403, 404})
        CHECK(model_upgrade_reason(std::make_exception_ptr(ModelError(ModelFailure::Http, "secret", code))).empty());
    CHECK(model_upgrade_reason(std::make_exception_ptr(ModelError(ModelFailure::Cancelled, "cancelled"))).empty());
    CHECK(model_upgrade_reason(std::make_exception_ptr(ModelError(ModelFailure::OutputLimit, "limited"))).empty());
    CHECK(model_upgrade_reason(std::make_exception_ptr(std::runtime_error("Model HTTP error 503"))).empty());
    ModelRoutePolicy policy({route("simple", "small"), route("standard", "middle"), route("complex", "large")});
    CHECK(!policy.note_round(true, false, false));
    CHECK(!policy.note_round(true, false, true));
    CHECK(!policy.note_round(true, false, false));
    CHECK(policy.note_round(true, false, false));
    CHECK(policy.upgrade("verification_failed").at("to").at("model").as_string() == "middle");
    CHECK(policy.upgrade("model_http_503").at("to").at("model").as_string() == "large");
    CHECK(!policy.can_upgrade() && policy.upgrade("model_timeout").is_null());
    ModelRoutePolicy duplicate({route("simple", "same"), route("standard", "same"), route("complex", "same")});
    CHECK(!duplicate.can_upgrade());
    rejects([] { ModelRoutePolicy bad({route("complex", "a"), route("simple", "b")}); });
    rejects([] { ModelRoutePolicy bad({}); });
}
Json settled(RunService& service, const std::string& id) {
    const auto deadline = std::chrono::steady_clock::now() + 30s;
    while (std::chrono::steady_clock::now() < deadline) {
        const auto value = service.brief_json(id);
        if (value.at("terminal").as_bool() && !value.at("executing").as_bool()) return value;
        std::this_thread::sleep_for(5ms);
    }
    throw std::runtime_error("Synthetic routing run did not settle: " + service.brief_json(id).dump());
}
std::vector<Json> events(RunService& service, const std::string& id, const std::string& type) {
    std::vector<Json> result;
    std::uint64_t after = 0;
    for (;;) {
        const auto page = service.events_after(id, after, 100);
        for (const auto& event : page.at("events").as_array()) {
            after = static_cast<std::uint64_t>(event.at("seq").as_number());
            if (event.at("type").as_string() == type) result.push_back(event);
        }
        if (after == static_cast<std::uint64_t>(page.at("latest").as_number())) return result;
    }
}
ModelReply tool(std::string id, std::string name, std::string args = "{}") {
    return {"", {{std::move(id), std::move(name), std::move(args)}}, 1, 1};
}
void run_routing(const fs::path& root, const std::string& scenario) {
    std::atomic_int calls{0}, writes{0}, plans{0};
    std::vector<std::string> models;
    RunCallbacks callbacks;
    callbacks.model_routes = [&](const auto&) {
        ++plans;
        std::vector<ModelRoute> plan{route("simple", "small")};
        if (scenario != "no-higher") plan.push_back(route("standard", "middle"));
        if (scenario == "bounded") plan.push_back(route("complex", "large"));
        return plan;
    };
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"write_file", "Synthetic write", Json::Object{{"type", "object"}}}}; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        ++writes;
        if (scenario == "uncertain") return ToolExecution{"Synthetic uncertain effect", true};
        return ToolExecution{"Synthetic successful effect", false, {}, {"artifact:fixture"}, "verified by synthetic executor"};
    };
    callbacks.model = [&](const ModelConfig& config, const auto& messages, const auto&, ModelChunk, auto) {
        const int call = ++calls; models.push_back(config.model);
        if (scenario == "bounded") throw ModelError(ModelFailure::Http, "Synthetic temporary failure", 503);
        if (call == 1) return tool("write-first", "write_file");
        if (scenario == "difficulty" && call <= 3)
            return tool("invalid-finish-" + std::to_string(call), "task_finish",
                R"({"summary":"not verified","artifacts":["missing"],"verification":"invented"})");
        if (scenario != "difficulty" && call == 2)
            throw ModelError(ModelFailure::Http, "Synthetic model failure", scenario == "auth" ? 401 : 503);
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& message) {
            return message.role == "tool" && message.content.find("Synthetic successful effect") != std::string::npos;
        }));
        if (call == (scenario == "difficulty" ? 4 : 3)) return tool("write-repeated-new-id", "write_file");
        return tool("finish", "task_finish",
            R"({"summary":"Verified delivery","artifacts":["artifact:fixture"],"verification":"verified by synthetic executor"})");
    };
    std::string id;
    {
        RunService service(root, callbacks);
        id = service.submit("bot", "", "Synthetic routing", "request").run_id;
        const auto final = settled(service, id);
        const bool success = scenario == "transient" || scenario == "difficulty";
        CHECK(final.at("status").as_string() == (success ? "completed" : "failed"));
        CHECK(plans == 1 && writes == (scenario == "bounded" ? 0 : 1));
        const auto changes = events(service, id, "model_upgraded");
        CHECK(changes.size() == (scenario == "bounded" ? 2U : success ? 1U : 0U));
        if (success) {
            CHECK(models.front() == "small" && models.back() == "middle");
            CHECK(events(service, id, "tool_reused").size() == 1);
            CHECK(changes.front().at("data").at("reason").as_string() ==
                (scenario == "difficulty" ? "verification_failed" : "model_http_503"));
        }
        if (scenario == "bounded") CHECK(calls == 3);
    }
    const int previous = calls;
    RunService restored(root, callbacks);
    CHECK(restored.brief_json(id).at("terminal").as_bool() && calls == previous);
    CHECK(events(restored, id, "model_upgraded").size() ==
        (scenario == "bounded" ? 2U : scenario == "transient" || scenario == "difficulty" ? 1U : 0U));
}
void output_limit_recovery(const fs::path& root, const std::string& scenario) {
    int calls = 0, writes = 0;
    RunCallbacks callbacks;
    callbacks.configuration = [](const auto&) { auto config = route("simple", "small").config; config.max_output_tokens = 1700; return config; };
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"write_file", "Synthetic action", Json::Object{{"type", "object"}}}}; };
    callbacks.repeat_completed_tool = [](std::string_view) { return true; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        ++writes;
        if (scenario == "uncertain") return ToolExecution{"Uncertain external state", true};
        return ToolExecution{"Durable completed action", false, {}, {"artifact:fixture"}, "verified synthetic result"};
    };
    callbacks.model = [&](const ModelConfig& config, const auto& messages, const auto&, ModelChunk chunk, auto) {
        const auto call = ++calls;
        CHECK(config.max_output_tokens == 1700); // Retry never expands an explicit budget.
        CHECK(std::none_of(messages.begin(), messages.end(), [](const auto& row) {
            return row.content.find("PARTIAL_MUST_NOT_COMPLETE") != std::string::npos;
        }));
        if (call == 1) return tool("write-first", "write_file");
        if (call == 2 || scenario == "bounded" || (scenario == "again" && call == 4)) {
            chunk("text", "PARTIAL_MUST_NOT_COMPLETE");
            throw ModelError(ModelFailure::OutputLimit, "Synthetic output truncated");
        }
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& row) {
            return row.role == "system" && row.content.find("output token limit") != std::string::npos;
        }));
        CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& row) {
            return row.role == "tool" && row.content.find("Durable completed action") != std::string::npos;
        }));
        if (call == 3) return tool("same-action-new-id", "write_file");
        return tool("finish", "task_finish", R"({"summary":"Verified delivery","artifacts":["artifact:fixture"],"verification":"verified synthetic result"})");
    };
    RunOptions options; options.max_output_limit_retries = scenario == "chat" ? 0 : 1;
    std::string id;
    {
        RunService service(root, callbacks, options);
        id = service.submit("bot", "", "Synthetic output limit", "request").run_id;
        const auto result = settled(service, id);
        CHECK(result.at("status").as_string() == (scenario == "recover" ? "completed" : "interrupted"));
        CHECK(writes == 1); // Includes normally repeatable actions in the recovery response.
        CHECK(events(service, id, "model_retry").size() == (scenario == "uncertain" || scenario == "chat" ? 0U : 1U));
        CHECK(events(service, id, "model_upgraded").empty());
        CHECK(events(service, id, "model_discarded").size() == (scenario == "bounded" || scenario == "again" ? 2U : 1U));
        CHECK(calls == (scenario == "recover" || scenario == "again" ? 4 : scenario == "bounded" ? 3 : 2));
        if (scenario != "recover") CHECK(result.at("error").as_string().find("model_output_limit_reached") != std::string::npos);
        if (scenario == "recover" || scenario == "again") CHECK(events(service, id, "tool_reused").size() == 1);
        if (scenario == "bounded") {
            const auto before = calls;
            CHECK(service.submit("bot", "", "Synthetic output limit", "request").duplicate);
            CHECK(calls == before); // Replays never receive a new retry allowance.
        }
    }
    const auto before = calls;
    RunService restored(root, callbacks, options);
    CHECK(restored.brief_json(id).at("terminal").as_bool() && calls == before);
    if (scenario == "bounded") {
        CHECK(restored.resume(id, "explicit-continue").attempt == 2);
        CHECK(settled(restored, id).at("status").as_string() == "interrupted");
        CHECK(calls == before + 2 && writes == 1);
    }
}
void round_budget_resume(const fs::path& root) {
    int calls = 0, reads = 0;
    bool resumed = false;
    RunCallbacks callbacks;
    callbacks.configuration = [](const auto&) { return route("simple", "small").config; };
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"inspect", "Synthetic desktop observation", Json::Object{{"type", "object"}}}}; };
    callbacks.is_read_only_tool = [](std::string_view) { return true; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) { ++reads; return ToolExecution{"Observed", false, {}, {"artifact:fixture"}, "verified inspection"}; };
    callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, auto) {
        ++calls;
        if (resumed) return tool("finish", "task_finish", R"({"summary":"Verified delivery","artifacts":["artifact:fixture"],"verification":"verified inspection"})");
        return tool("inspect-" + std::to_string(calls), "inspect");
    };
    RunOptions options; options.max_tool_rounds = 96;
    RunService service(root, callbacks, options);
    const auto id = service.submit("bot", "", "Synthetic desktop rounds", "request").run_id;
    const auto stopped = settled(service, id);
    CHECK(stopped.at("status").as_string() == "interrupted");
    CHECK(stopped.at("error").as_string().find("tool_round_limit_exceeded") != std::string::npos);
    CHECK(calls == 96 && reads == 96 && service.get(id).at("tools").as_array().size() == 96);
    CHECK(service.submit("bot", "", "Synthetic desktop rounds", "request").duplicate && calls == 96);
    resumed = true;
    CHECK(service.resume(id, "explicit-continue").attempt == 2);
    CHECK(settled(service, id).at("status").as_string() == "completed");
    CHECK(calls == 97 && reads == 96);
}
void unlimited_rounds(const fs::path& root, bool cancel) {
    std::atomic_int calls{0}, reads{0};
    std::promise<void> reached;
    RunCallbacks callbacks;
    callbacks.configuration = [](const auto&) { return route("simple", "small").config; };
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"inspect", "Synthetic observation", Json::Object{{"type", "object"}}}}; };
    callbacks.is_read_only_tool = [](std::string_view) { return true; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) { ++reads; return ToolExecution{"Observed", false, {}, {"artifact:fixture"}, "verified inspection"}; };
    callbacks.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token stop) {
        const int round = ++calls;
        if (round > 110) {
            if (cancel) {
                reached.set_value();
                while (!stop.stop_requested()) std::this_thread::sleep_for(1ms);
                throw ModelError(ModelFailure::Cancelled, "Synthetic cancellation after 110 rounds");
            }
            return tool("finish", "task_finish", R"({"summary":"Verified delivery","artifacts":["artifact:fixture"],"verification":"verified inspection"})");
        }
        return tool("inspect-" + std::to_string(round), "inspect");
    };
    RunOptions options; options.max_tool_rounds = 0;
    CHECK(RunOptions{}.max_tool_rounds == 24);
    RunService service(root, callbacks, options);
    const auto id = service.submit("bot", "", "Continue beyond the previous fixed limit", "request").run_id;
    if (cancel) {
        CHECK(reached.get_future().wait_for(30s) == std::future_status::ready);
        (void)service.cancel(id);
    }
    CHECK(settled(service, id).at("status").as_string() == (cancel ? "cancelled" : "completed"));
    CHECK(calls == 111 && reads == 110);
    CHECK(events(service, id, "run_interrupted").empty());
}
void independent_model_and_tool_bounds(const fs::path& root, const std::string& scenario) {
    int calls = 0, executions = 0;
    RunCallbacks callbacks;
    callbacks.configuration = [](const auto&) { auto config = route("simple", "small").config; config.max_output_tokens = 256000; return config; };
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"write", "Synthetic action", Json::Object{{"type", "object"}}}}; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        ++executions;
        return scenario == "tool-result"
            ? ToolExecution{std::string(140000, 'r'), false}
            : ToolExecution{"Written", false, {}, {"artifact:fixture"}, "verified write"};
    };
    callbacks.model = [&](const auto& config, const auto& messages, const auto&, ModelChunk chunk, auto) {
        ++calls; CHECK(config.max_output_tokens == 256000);
        if (calls == 1) {
            auto result = tool("write", "write");
            if (scenario == "text") {
                result.text = std::string(300000, 'x'); // Exceeds old text AND mixed tool-batch bounds.
                chunk("thinking", std::string(160000, 't')); // Thinking is not tool output.
                chunk("text", result.text);
            } else if (scenario == "tool-arguments") result.tool_calls.front().arguments = "{\"value\":\"" + std::string(70000, 'a') + "\"}";
            return result;
        }
        if (scenario == "text") {
            CHECK(std::any_of(messages.begin(), messages.end(), [](const auto& row) { return row.role == "assistant" && row.content.size() == 300000; }));
            return tool("finish", "task_finish", R"({"summary":"Verified delivery","artifacts":["artifact:fixture"],"verification":"verified write"})");
        }
        return ModelReply{"Tool limit was enforced", {}, 1, 1};
    };
    RunOptions options; options.max_context_chars = 1500000; options.max_model_reply_chars = 1024U * 1024U;
    RunService service(root, callbacks, options);
    const auto id = service.submit("bot", "", "Synthetic independent bounds", "request").run_id;
    CHECK(settled(service, id).at("status").as_string() == (scenario == "text" ? "completed" : "failed"));
    CHECK(executions == (scenario == "tool-arguments" ? 0 : 1));
    if (scenario == "text") {
        const auto replies = events(service, id, "model_reply");
        CHECK(replies.front().at("data").at("text").as_string().size() == 300000);
    } else if (scenario == "tool-result") {
        const auto result = service.get(id).at("tools").as_array().front();
        CHECK(result.at("state").as_string() == "uncertain");
        CHECK(result.at("execution").at("result").as_string().find("tool_result_budget_exceeded") != std::string::npos);
    }
}
RunOptions large_work_options() {
    RunOptions options;
    options.max_context_chars = 8U * 1024U * 1024U;
    options.max_model_reply_chars = 8U * 1024U * 1024U;
    options.max_input_chars = 1024U * 1024U;
    options.max_saved_chars = 32U * 1024U * 1024U;
    options.max_snapshot_bytes = 128U * 1024U * 1024U;
    options.max_event_page_bytes = 1024U * 1024U;
    options.list_preview_chars = 8192;
    return options;
}
std::string file_text(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void large_work_roundtrip(const fs::path& root, bool verified) {
    const std::string body = std::string(5U * 1024U * 1024U, 'x') + "尾端";
    const std::string input = std::string(1024U * 1024U - 64U, 'u') + " final original instruction";
    auto options = large_work_options();
    options.require_verified_finish = verified;
    std::atomic_int calls{0}, writes{0};
    RunCallbacks callbacks;
    callbacks.tools = [](const auto&) { return std::vector<ModelTool>{{"write", "Synthetic action", Json::Object{{"type", "object"}}}}; };
    callbacks.execute_tool = [&](const auto&, const auto&, auto) {
        ++writes; return ToolExecution{"Written", false, {}, {"artifact:large"}, "verified large task"};
    };
    callbacks.model = [&](const auto&, const auto& messages, const auto&, ModelChunk chunk, auto) {
        if (++calls == 1) {
            CHECK(std::any_of(messages.begin(), messages.end(), [&](const auto& row) { return row.role == "user" && row.content == input; }));
            chunk("text", body);
            auto reply = verified ? tool("write", "write") : ModelReply{};
            reply.text = body; return reply;
        }
        CHECK(verified);
        CHECK(std::any_of(messages.begin(), messages.end(), [&](const auto& row) { return row.role == "assistant" && row.content == body; }));
        return tool("finish", "task_finish", R"({"summary":"Verified large task","artifacts":["artifact:large"],"verification":"verified large task"})");
    };
    std::string id;
    {
        RunService service(root, callbacks, options);
        id = service.submit("large-bot", "", input, "large-request").run_id;
        CHECK(settled(service, id).at("status").as_string() == "completed");
        CHECK(calls == (verified ? 2 : 1)); CHECK(writes == (verified ? 1 : 0));
        const auto listing = service.list().as_array().front();
        CHECK(listing.at("text").as_string().size() == 8192);
        CHECK(listing.at("contentTruncated").as_bool());
        if (!verified) CHECK(listing.at("answer").as_string().size() == 8192);
        CHECK(service.get(id).at("inputs").as_array().front().at("text").as_string() == input);
        std::uint64_t cursor = 0;
        std::size_t large_pages = 0;
        for (;;) {
            const auto page = service.events_after(id, cursor, 128);
            CHECK(!page.at("events").as_array().empty());
            if (page.dump().size() > options.max_event_page_bytes) {
                CHECK(page.at("events").as_array().size() == 1); ++large_pages;
            }
            cursor = static_cast<std::uint64_t>(page.at("after").as_number());
            if (cursor == static_cast<std::uint64_t>(page.at("latest").as_number())) break;
        }
        CHECK(large_pages >= 2);
    }
    const auto snapshot_path = root / "runs" / id / "snapshot.json";
    CHECK(fs::file_size(snapshot_path) > 4U * 1024U * 1024U);
    const auto snapshot = Json::parse(file_text(snapshot_path), options.max_snapshot_bytes);
    CHECK(snapshot.at("schema").as_number() == 1);
    CHECK(!snapshot.find("answer") && !snapshot.find("text")); // Derived API aliases are not duplicated on disk.
    CHECK(std::any_of(snapshot.at("messages").as_array().begin(), snapshot.at("messages").as_array().end(),
        [&](const auto& row) { return row.at("role").as_string() == "assistant" && row.at("content").as_string() == body; }));
    if (!verified) {
        // Delete only the last committed record and append a torn fragment. The
        // snapshot's >4MiB lastEvent must repair it without model/tool replay.
        const auto event_dir = root / "runs" / id / "events";
        fs::path last;
        for (const auto& entry : fs::directory_iterator(event_dir)) if (entry.path().extension() == ".jsonl" && entry.path() > last) last = entry.path();
        CHECK(!last.empty());
        const auto bytes = file_text(last);
        const auto previous = bytes.rfind('\n', bytes.size() - 2);
        CHECK(previous != std::string::npos);
        std::ofstream output(last, std::ios::binary | std::ios::trunc);
        output.write(bytes.data(), static_cast<std::streamsize>(previous + 1));
        output << "{\"torn\":"; output.close();
    }
    const auto before = calls.load(), before_writes = writes.load();
    {
        RunService restored(root, callbacks, options);
        const auto saved = restored.get(id);
        CHECK(saved.at("status").as_string() == "completed");
        CHECK(saved.at("inputs").as_array().front().at("text").as_string() == input);
        if (!verified) CHECK(saved.at("answer").as_string() == body);
        const auto replies = events(restored, id, "model_reply");
        CHECK(replies.front().at("data").at("text").as_string() == body);
        CHECK(events(restored, id, "run_completed").size() == 1);
        CHECK(calls == before && writes == before_writes);
    }
}
void large_work_bounds_and_legacy(const fs::path& root) {
    CHECK(RunOptions{}.max_snapshot_bytes == 4U * 1024U * 1024U - 1024U);
    CHECK(RunOptions{}.max_model_reply_chars == 131072);
    CHECK(RunOptions{}.max_context_chars == 120000);
    CHECK(RunOptions{}.max_saved_chars == 1800000);
    CHECK(RunOptions{}.max_input_chars == 64000);
    RunCallbacks callbacks;
    callbacks.model = [](const auto&, const auto&, const auto&, ModelChunk, auto) { return ModelReply{std::string(140000, 'x'), {}, 1, 1}; };
    {
        auto defaults = RunOptions{}; defaults.require_verified_finish = false;
        RunService service(root / "defaults", callbacks, defaults);
        const auto id = service.submit("bot", "", "small input", "request").run_id;
        CHECK(settled(service, id).at("status").as_string() == "failed");
        CHECK(service.brief_json(id).at("error").as_string().find("Model response exceeds run limits") != std::string::npos);
    }
    for (const auto* field : {"reply", "input", "saved", "snapshot", "context"}) {
        auto options = large_work_options();
        if (std::string(field) == "reply") ++options.max_model_reply_chars;
        if (std::string(field) == "input") ++options.max_input_chars;
        if (std::string(field) == "saved") ++options.max_saved_chars;
        if (std::string(field) == "snapshot") ++options.max_snapshot_bytes;
        if (std::string(field) == "context") ++options.max_context_chars;
        rejects([&] { RunService invalid(root / field, callbacks, options); });
    }
    std::string old_id;
    callbacks.model = [](const auto&, const auto&, const auto&, ModelChunk, auto) { return ModelReply{"legacy answer", {}, 1, 1}; };
    {
        auto options = RunOptions{}; options.require_verified_finish = false;
        RunService old(root / "legacy", callbacks, options);
        old_id = old.submit("bot", "", "legacy instruction", "legacy-request").run_id;
        CHECK(settled(old, old_id).at("status").as_string() == "completed");
    }
    {
        RunService upgraded(root / "legacy", callbacks, large_work_options());
        CHECK(upgraded.get(old_id).at("answer").as_string() == "legacy answer");
    }
    // JSON escaping is accounted before committing model text, so expanded
    // bytes cannot leave an oversized, un-reloadable Work snapshot.
    callbacks.model = [](const auto&, const auto&, const auto&, ModelChunk, auto) { return ModelReply{std::string(6U * 1024U * 1024U, '\1'), {}, 1, 1}; };
    auto options = large_work_options(); options.require_verified_finish = false;
    std::string escaped;
    {
        RunService service(root / "escaped", callbacks, options);
        escaped = service.submit("bot", "", "escaped text", "request").run_id;
        const auto failed = settled(service, escaped);
        CHECK(failed.at("status").as_string() == "failed");
        CHECK(failed.at("error").as_string().find("run_saved_context_budget_exceeded") != std::string::npos);
        CHECK(failed.at("answer").as_string().empty());
    }
    {
        RunService restored(root / "escaped", callbacks, options);
        CHECK(restored.get(escaped).at("status").as_string() == "failed");
    }
    // Repair only the final commit. Missing earlier committed records must not
    // be silently truncated and replaced by the snapshot's last event.
    const auto legacy_events = root / "legacy" / "runs" / old_id / "events";
    const auto segment = fs::directory_iterator(legacy_events)->path();
    const auto original = file_text(segment);
    const auto first_newline = original.find('\n');
    CHECK(first_newline != std::string::npos);
    const auto broken = original.substr(first_newline + 1);
    { std::ofstream output(segment, std::ios::binary | std::ios::trunc); output << broken; }
    rejects([&] { RunService invalid(root / "legacy", callbacks, options); });
    CHECK(file_text(segment) == broken);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass the configured isolated absolute output directory");
        const fs::path supplied(argv[1]);
        CHECK(supplied.is_absolute() && supplied.lexically_normal() == fs::path(DIMENSION_TEST_ROOT).lexically_normal());
        const auto root = supplied / ("model-policy-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        catalog_policy(); catalog_concurrency(); routing_policy();
        for (const auto* scenario : {"transient", "difficulty", "no-higher", "auth", "bounded", "uncertain"})
            run_routing(root / scenario, scenario);
        for (const auto* scenario : {"recover", "bounded", "again", "uncertain", "chat"})
            output_limit_recovery(root / (std::string("output-") + scenario), scenario);
        round_budget_resume(root / "round-budget");
        unlimited_rounds(root / "unlimited-complete", false);
        unlimited_rounds(root / "unlimited-cancel", true);
        for (const auto* scenario : {"text", "tool-arguments", "tool-result"})
            independent_model_and_tool_bounds(root / (std::string("bounds-") + scenario), scenario);
        large_work_roundtrip(root / "large-text", false);
        large_work_roundtrip(root / "large-verified", true);
        large_work_bounds_and_legacy(root / "large-bounds");
        std::cout << "model policy: " << checks << " checks passed; injected providers/models/tools only\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "model policy failed: " << error.what() << '\n'; return 1;
    }
}
