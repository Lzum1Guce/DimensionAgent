#pragma once

#include "dimension/runs.hpp"
#include "dimension/store.hpp"

namespace dimension {

struct ConversationServiceCallbacks {
    std::function<ModelConfig(const std::string& bot, const std::string& kind)> configuration;
    RunModelCaller model;
    // Actual bounded input budget for one provider request, in UTF-8 bytes.
    std::function<std::size_t(const std::string& bot, const std::string& kind)> input_budget;
};

// Read-only model jobs with durable source snapshots. Summaries append one
// version-checked system record; mini roles have isolated transcripts/settings.
// Neither service exposes tools, mutates memory nor submits a Work task.
class ConversationServices final {
public:
    ConversationServices(std::filesystem::path root, Store&, RunService& work,
        ConversationServiceCallbacks);
    ~ConversationServices();
    ConversationServices(const ConversationServices&) = delete;
    ConversationServices& operator=(const ConversationServices&) = delete;
    [[nodiscard]] Json context(const std::string& bot);
    [[nodiscard]] Json summarize(const std::string& bot, const std::string& request);
    [[nodiscard]] std::string active_summary(const std::string& bot);
    [[nodiscard]] Json space(const std::string& bot);
    // Called only after a private Chat Bot reply has been durably appended.
    // The combined round is asynchronous and never mutates memory or Work.
    [[nodiscard]] Json on_delivery(const std::string& bot, Id message_id);
    [[nodiscard]] Json analyze_latest(const std::string& bot, const std::string& request);
    [[nodiscard]] std::string chat_guidance(const std::string& bot);
    [[nodiscard]] Json set_thinking(const std::string& bot, const std::string& role,
        bool enabled, const std::string& request);
    [[nodiscard]] Json mini_chat(const std::string& bot, const std::string& role,
        const std::string& text, const std::string& request);
    [[nodiscard]] Json mini_history(const std::string& bot, const std::string& role,
        const std::string& before = {});
    [[nodiscard]] Json job(const std::string& bot, const std::string& id);
    [[nodiscard]] Json cancel(const std::string& bot, const std::string& id);
    [[nodiscard]] std::string source(const std::string& bot, const std::string& id);
    void refresh();
    void shutdown();
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
