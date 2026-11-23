#include "dimension/work_compaction.hpp"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace dimension;
int checks = 0;
void check(bool passed, const char* expression, int line) {
    ++checks;
    if (!passed) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(bool(value), #value, __LINE__)
ModelConfig configuration() { auto config = ModelConfig{"http://127.0.0.1:1/v1", "synthetic-key", "synthetic-work-model"}; config.max_output_tokens = 400; return config; }
WorkCompactionLimits limits() {
    WorkCompactionLimits value;
    value.context_tokens = 8000; value.output_tokens = 1000; value.buffer_tokens = 500;
    return value;
}
void round(std::vector<ModelMessage>& messages, int index, std::size_t bytes = 2000) {
    const auto id = "call-" + std::to_string(index);
    messages.push_back({"assistant", "Inspect the preceding result.", {{id, "read_file", "{\"path\":\"file-" + std::to_string(index) + "\"}"}}, {}});
    messages.push_back({"tool", "Evidence " + std::to_string(index) + ": " + std::string(bytes, 'a'), {}, id});
}
std::vector<ModelMessage> history(int rounds = 20, std::size_t bytes = 2000) {
    std::vector<ModelMessage> messages{{"system", "Original system rules, unchanged.", {}, {}}, {"user", "Original task: preserve exact artifacts and verify them.", {}, {}}};
    for (int i = 0; i < rounds; ++i) round(messages, i, bytes);
    return messages;
}
std::string contents(const std::vector<ModelMessage>& messages) {
    std::string result;
    for (const auto& message : messages) {
        result += message.role + ":" + message.content + ":" + message.tool_call_id;
        for (const auto& call : message.tool_calls) result += call.id + call.name + call.arguments;
    }
    return result;
}
void meter() {
    CHECK(work_context_tokens({}) == 512);
    CHECK(work_tool_tokens({}) == 512);
    ModelMessage text{"user", "a", {}, {}};
    CHECK(work_message_tokens(text) == 10); // ceil((4 + 1 + 32) / 4)
    text.images.push_back({"image/png", "", 32, 32});
    CHECK(work_message_tokens(text) == 10 + 2052);
    std::vector<ModelTool> tools{{"read", "description", Json::Object{{"type", "object"}}}};
    CHECK(work_context_tokens({text}, tools) == work_message_tokens(text) + work_tool_tokens(tools));
    CHECK(work_tool_tokens(tools) > 512);
}
void pruning() {
    std::string unicode;
    for (int i = 0; i < 9000; ++i) unicode += "🙂";
    auto source = history(0);
    source.push_back({"assistant", "", {{"long-result", "read_file", "{\"path\":\"must-not-change\"}"}}, {}});
    source.push_back({"tool", unicode, {}, "long-result"});
    const auto original = contents(source);
    int calls = 0;
    auto caller = [&](const auto&, const auto&, const auto&, auto, auto) { ++calls; return ModelReply{"Not needed", {}}; };
    auto generous = WorkCompactionLimits{};
    const auto unpressured = compact_work_context(source, {}, generous, configuration(), caller);
    CHECK(unpressured.status == "not_needed" && unpressured.pruned_results == 0 && calls == 0);
    CHECK(unpressured.messages.back().content == unicode);
    auto budget = limits(); budget.context_tokens = 12000; budget.output_tokens = 1000; budget.buffer_tokens = 3000;
    const auto pruned = compact_work_context(source, {}, budget, configuration(), caller);
    CHECK(pruned.status == "pruned" && pruned.changed && pruned.within_budget && calls == 0);
    CHECK(pruned.pruned_results == 1 && pruned.state.pruned_through == source.size());
    const auto& reduced = pruned.messages.back().content;
    CHECK(reduced.starts_with(unicode.substr(0, 4096 * 4)));
    CHECK(reduced.ends_with(unicode.substr(unicode.size() - 1024 * 4)));
    CHECK(reduced.find("3880 Unicode code points") != std::string::npos);
    CHECK(pruned.messages[2].tool_calls[0].arguments == source[2].tool_calls[0].arguments);
    CHECK(contents(source) == original);
    auto restored = work_compaction_state_from_json(Json::parse(work_compaction_state_json(pruned.state).dump()));
    CHECK(contents(work_compacted_messages(source, restored)) == contents(pruned.messages));
    source.back().content = std::string(8192, 'x');
    auto forced = compact_work_context(source, {}, budget, configuration(), {}, {}, WorkCompactionMode::ContextOverflow);
    CHECK(forced.pruned_results == 0 && forced.messages.back().content == source.back().content);
}
void summary_and_reuse() {
    auto source = history();
    source.insert(source.begin() + 10, {"user", "Older supplementary requirement, include this in the note.", {}, {}});
    source.insert(source.begin() + 15, {"system", "Additional trusted system requirement.", {}, {}});
    source.push_back({"user", "Latest user requirement must remain exact.", {}, {}});
    const auto original = contents(source);
    int calls = 0;
    auto callback = [&](const ModelConfig& config, const std::vector<ModelMessage>& request,
        const std::vector<ModelTool>& tools, ModelChunk, std::stop_token) {
        ++calls;
        CHECK(config.model == "synthetic-work-model" && config.api_key == "synthetic-key");
        CHECK(config.max_output_tokens == 400);
        CHECK(tools.empty() && request.size() == 2 && request[0].role == "system" && request[1].role == "user");
        CHECK(request[1].tool_calls.empty());
        CHECK(request[1].content.find("Older supplementary requirement") != std::string::npos);
        CHECK(work_context_tokens(request) + std::size_t(config.max_output_tokens) + 500 <= 8000);
        return ModelReply{"Observed results and original constraints remain in effect. Preserve file-1; further verification is pending.", {}, 100, 30};
    };
    const auto result = compact_work_context(source, {}, limits(), configuration(), callback);
    CHECK(result.status == "summarized" && result.changed && result.within_budget && calls == 1);
    CHECK(result.trigger_tokens == 6400 && result.input_limit_tokens == 7000);
    CHECK(result.after_tokens < result.before_tokens && result.state.summarized_through > 2);
    CHECK(result.messages.front().content == source.front().content);
    CHECK(std::any_of(result.messages.begin(), result.messages.end(), [&](const auto& message) { return message.content == source[1].content; }));
    CHECK(result.messages.back().content == source.back().content);
    CHECK(std::any_of(result.messages.begin(), result.messages.end(), [](const auto& message) { return message.role == "user" && message.content.starts_with("<work-history-reference>") && message.content.find("not a new user request") != std::string::npos; }));
    CHECK(std::any_of(result.messages.begin(), result.messages.end(), [](const auto& message) { return message.role == "system" && message.content == "Additional trusted system requirement."; }));
    CHECK(result.messages[result.messages.size() - 2].tool_call_id == "call-19");
    CHECK(result.messages[result.messages.size() - 3].tool_calls[0].id == "call-19");
    CHECK(contents(source) == original);
    const auto restored = work_compaction_state_from_json(Json::parse(work_compaction_state_json(result.state).dump()));
    CHECK(contents(work_compacted_messages(source, restored)) == contents(result.messages));
    auto next = compact_work_context(source, restored, limits(), configuration(), callback);
    CHECK(next.model_calls == 0 && calls == 1);
    source.push_back({"user", "A new steering instruction after restart.", {}, {}});
    const auto steered = work_compacted_messages(source, restored);
    CHECK(steered.back().content == source.back().content);
    CHECK(steered[1].content == source[1].content);
    source[2].content += " changed source";
    CHECK(contents(work_compacted_messages(source, restored)) == contents(source));
}
void failures_and_cancellation() {
    const auto source = history();
    int calls = 0;
    WorkCompactionCaller failure = [&](const auto&, const auto&, const auto&, auto, auto) -> ModelReply {
        ++calls; throw ModelError(ModelFailure::Http, "DO_NOT_EXPOSE_SYNTHETIC_SECRET", 401);
    };
    const auto failed = compact_work_context(source, {}, limits(), configuration(), failure);
    CHECK(failed.status == "failed" && failed.reason == "summary_model_failed" && failed.state.summary.empty() && !failed.changed);
    CHECK(failed.reason.find("SECRET") == std::string::npos && failed.model_calls == 1);
    const auto repeated = compact_work_context(source, failed.state, limits(), configuration(), failure);
    CHECK(repeated.status == "no_progress" && repeated.model_calls == 0 && calls == 1);
    for (int mode = 0; mode < 8; ++mode) {
        auto bad = [=](const auto&, const auto&, const auto&, auto chunk, auto) {
            if (mode == 0) return ModelReply{"  \n\t", {}};
            if (mode == 1) return ModelReply{"summary", {{"never-execute", "write_file", "{}"}}};
            if (mode == 2) return ModelReply{std::string(70000, 'x'), {}};
            if (mode == 3) return ModelReply{"short", {}, 0, 401};
            if (mode == 5) return ModelReply{"　\u00a0\u200b", {}};
            if (mode == 6) return ModelReply{std::string("\xc0\xaf", 2), {}};
            if (mode == 7) { chunk("thinking", std::string(600000, 'x')); chunk("text", std::string(448577, 'x')); return ModelReply{"short", {}}; }
            chunk("thinking", std::string(1048577, 'x')); return ModelReply{"short", {}};
        };
        const auto rejected = compact_work_context(source, {}, limits(), configuration(), bad);
        CHECK(!rejected.changed && rejected.state.summary.empty());
        CHECK(rejected.status == "failed" || rejected.status == "no_progress");
    }
    std::stop_source before;
    before.request_stop();
    CHECK(compact_work_context(source, {}, limits(), configuration(), failure, before.get_token()).status == "cancelled");
    CHECK(calls == 1);
    std::stop_source during;
    auto cancel = [&](const auto&, const auto&, const auto&, auto, auto) { during.request_stop(); return ModelReply{"late summary discarded", {}}; };
    const auto cancelled = compact_work_context(source, {}, limits(), configuration(), cancel, during.get_token());
    CHECK(cancelled.status == "cancelled" && !cancelled.changed && cancelled.state.summary.empty() && cancelled.state.last_attempt_digest.empty());
    CHECK(contents(cancelled.messages) == contents(source));
}
void passes_and_overflow() {
    int calls = 0;
    auto callback = [&](const auto&, const auto&, const auto&, auto, auto) { ++calls; return ModelReply{"Historical progress remains unverified where receipts do not prove completion.", {}}; };
    const auto large = history(80);
    const auto limited = compact_work_context(large, {}, limits(), configuration(), callback);
    CHECK(limited.model_calls == 2 && calls == 2 && limited.changed && !limited.within_budget);
    CHECK(limited.reason == "compaction_pass_limit");
    CHECK(compact_work_context(large, limited.state, limits(), configuration(), callback).model_calls == 0);
    auto short_history = history(10, 600);
    const auto automatic = compact_work_context(short_history, {}, limits(), configuration(), callback);
    CHECK(automatic.status == "not_needed" && automatic.model_calls == 0);
    const auto overflow = compact_work_context(short_history, {}, limits(), configuration(), callback, {}, WorkCompactionMode::ContextOverflow);
    CHECK(overflow.changed && overflow.model_calls == 1 && overflow.after_tokens < overflow.before_tokens);
    // An actual provider overflow overrides the generous configured tail, but
    // automatic pressure retains the documented window-based policy.
    const auto roomy = compact_work_context(short_history, {}, WorkCompactionLimits{}, configuration(), callback, {}, WorkCompactionMode::ContextOverflow);
    CHECK(roomy.changed && roomy.model_calls == 1 && roomy.after_tokens < roomy.before_tokens);
    CHECK(roomy.messages.back().tool_call_id == "call-9");
    CHECK(roomy.messages[roomy.messages.size() - 2].tool_calls[0].id == "call-9");
    auto invalid = limits(); invalid.output_tokens = invalid.context_tokens;
    const auto policy = compact_work_context(large, {}, invalid, configuration(), callback);
    CHECK(policy.status == "invalid_policy" && policy.model_calls == 0 && !policy.changed);
    auto unbalanced = large; unbalanced.pop_back();
    const auto rejected = compact_work_context(unbalanced, {}, limits(), configuration(), callback);
    CHECK(rejected.status == "invalid_context" && rejected.model_calls == 0 && !rejected.changed);
    bool corrupt_rejected = false;
    try { (void)work_compaction_state_from_json(Json::Object{{"version", 1}}); } catch (...) { corrupt_rejected = true; }
    CHECK(corrupt_rejected);
}
void image_history() {
    std::vector<ModelMessage> source{
        {"system", "Original system rules.", {}, {}},
        {"user", "Original task.", {}, {}},
        {"user", "Earlier screenshot.", {}, {}, {{"image/png", "ORIGINAL_OLDER_PIXELS", 512, 512}}},
        {"assistant", "Earlier observation.", {}, {}},
        {"user", "Latest screenshot.", {}, {}, {{"image/png", "ORIGINAL_LATEST_PIXELS", 512, 512}}},
        {"assistant", "Latest observation.", {}, {}},
        {"user", "Continue using the current screenshot.", {}, {}},
    };
    const auto original = contents(source);
    auto callback = [](const auto&, const std::vector<ModelMessage>& request, const auto&, auto, auto) {
        CHECK(request[1].images.empty());
        CHECK(request[1].content.find("ORIGINAL_OLDER_PIXELS") == std::string::npos);
        return ModelReply{"Prior screenshot is historical. Current screenshot and original requirements remain authoritative.", {}};
    };
    const auto reduced = compact_work_context(source, {}, limits(), configuration(), callback);
    CHECK(reduced.changed && reduced.status == "summarized" && reduced.within_budget && reduced.model_calls == 1);
    CHECK(reduced.after_tokens < reduced.before_tokens && contents(reduced.messages).size() > original.size());
    CHECK(reduced.messages.front().content == source.front().content && reduced.messages[1].content == source[1].content);
    CHECK(reduced.messages.back().content == source.back().content);
    std::size_t images = 0;
    for (const auto& message : reduced.messages) for (const auto& image : message.images) {
        ++images; CHECK(image.base64_data == "ORIGINAL_LATEST_PIXELS");
    }
    CHECK(images == 1 && contents(source) == original && source[2].images[0].base64_data == "ORIGINAL_OLDER_PIXELS");
    CHECK(source[4].images[0].base64_data == "ORIGINAL_LATEST_PIXELS");

    auto bounded = limits(); bounded.context_chars = 4096;
    CHECK(compact_work_context(source, {}, bounded, configuration(), callback).changed);
    bounded.context_chars = 1;
    const auto byte_pressure = compact_work_context(source, {}, bounded, configuration(), callback);
    CHECK(!byte_pressure.changed && byte_pressure.status == "no_progress" && byte_pressure.state.summary.empty());
    // A candidate must also not introduce a byte overflow in a previously
    // fitting request, even if its image-token reduction is useful.
    std::vector<ModelMessage> text_only = source;
    for (auto& message : text_only) message.images.clear();
    bounded.context_chars = work_context_tokens(text_only) * 4;
    const auto new_overflow = compact_work_context(source, {}, bounded, configuration(), callback);
    CHECK(!new_overflow.changed && new_overflow.state.summary.empty());

    // Enough newer tool exchanges put BOTH screenshots before the retained
    // tail. The latest screenshot still survives as an exact original message.
    for (int i = 0; i < 12; ++i) round(source, i, 600);
    const auto past_image = compact_work_context(source, {}, WorkCompactionLimits{}, configuration(), callback, {}, WorkCompactionMode::ContextOverflow);
    CHECK(past_image.changed && past_image.state.summarized_through > 4);
    images = 0;
    for (const auto& message : past_image.messages) for (const auto& image : message.images) {
        ++images; CHECK(image.base64_data == "ORIGINAL_LATEST_PIXELS");
    }
    CHECK(images == 1);
    CHECK(std::any_of(past_image.messages.begin(), past_image.messages.end(), [&](const auto& message) { return message.content == source[6].content; }));
    CHECK(past_image.messages.back().tool_call_id == "call-11");
    const auto restored = work_compaction_state_from_json(Json::parse(work_compaction_state_json(past_image.state).dump()));
    const auto reused = work_compacted_messages(source, restored);
    CHECK(contents(reused) == contents(past_image.messages));
    CHECK(std::any_of(reused.begin(), reused.end(), [](const auto& message) { return !message.images.empty() && message.images[0].base64_data == "ORIGINAL_LATEST_PIXELS"; }));
}
} // namespace

int main() {
    try {
        meter(); pruning(); summary_and_reuse(); failures_and_cancellation(); passes_and_overflow(); image_history();
        std::cout << "Work compaction: " << checks << " synthetic checks passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
