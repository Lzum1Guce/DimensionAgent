#pragma once

#include "dimension/runs.hpp"

#include <filesystem>
#include <functional>
#include <memory>
#include <optional>

namespace dimension {

struct ChatWorkReply {
    std::string text;
    Json receipt;
};

// Explicit current-user command parser and durable same-Bot control binding.
// No model, memory, history or quoted text is parsed as a control instruction.
// Consultation and unrelated prose remain ordinary Chat. Anchored supplements
// steer an active run; anchored changes preserve prior artifacts/receipts while
// recording the latest decision and its reverification impact. Only the explicit
// new-task command may submit a separate queued private run. All targeted reads
// and controls recheck private/group permission and exact Bot/run ownership.
class ChatWorkBridge final {
public:
    using InputGuard = std::function<void(const std::string& bot, const std::string& group)>;
    ChatWorkBridge(std::filesystem::path root, RunService& work, InputGuard guard);
    ~ChatWorkBridge();
    ChatWorkBridge(const ChatWorkBridge&) = delete;
    ChatWorkBridge& operator=(const ChatWorkBridge&) = delete;
    // nullopt means ordinary Chat prose. context only participates in request
    // binding; its content never becomes an instruction or a Work supplement.
    [[nodiscard]] std::optional<ChatWorkReply> handle(const std::string& bot,
        const std::string& plain, const std::string& request, const Json& context = {});
    [[nodiscard]] Json status(const std::string& bot, const std::string& run_id = {}) const;
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
