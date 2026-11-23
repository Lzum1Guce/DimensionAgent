#pragma once

#include "dimension/json.hpp"

#include <cstddef>
#include <functional>
#include <optional>
#include <stop_token>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct ToolCall {
    std::string id;
    std::string name;
    std::string arguments;
};

inline constexpr std::size_t model_text_body_limit = 4U * 1024U * 1024U;
inline constexpr std::size_t model_image_binary_limit = 5U * 1024U * 1024U;
inline constexpr std::size_t model_image_count_limit = 2U;
inline constexpr std::size_t model_image_request_limit = 12U * 1024U * 1024U;

// Independent byte budgets: SSE framing/usage/heartbeat bytes do not consume
// the decoded text, thinking and tool-data budget. Defaults retain Chat limits.
struct ModelPayloadLimits {
    std::size_t text_request_bytes = model_text_body_limit;
    std::size_t image_request_bytes = model_image_request_limit;
    std::size_t response_bytes = model_text_body_limit;
    std::size_t output_bytes = model_text_body_limit;
    std::size_t sse_line_bytes = 256U * 1024U;
    std::size_t sse_event_bytes = 1024U * 1024U;
};

// Maximum supported profile. Callers may use smaller positive budgets; image
// count, decoded image size, dimensions and JSON nesting limits stay unchanged.
inline constexpr ModelPayloadLimits work_model_payload_limits{
    32U * 1024U * 1024U, 48U * 1024U * 1024U, 128U * 1024U * 1024U,
    32U * 1024U * 1024U, 16U * 1024U * 1024U, 32U * 1024U * 1024U};

struct ModelImage {
    std::string mime_type = "image/png";
    std::string base64_data;
    unsigned width = 0;
    unsigned height = 0;
};

// Inline, canonical base64 PNG only. Dimensions must match IHDR, each axis is
// at most 8192, and total pixels at most 16 Mi. Invalid data throws a fixed
// std::runtime_error without exposing pixels or base64. The plural form also
// enforces the two-image limit; call_model enforces it across all messages.
void validate_model_image(const ModelImage& image, std::stop_token stop = {});
void validate_model_images(const std::vector<ModelImage>& images, std::stop_token stop = {});

// Requires an already-validated image; rechecks dimensions, without decoding.
// Local reserve: 2048 + 4 * ceil(width / 32) * ceil(height / 32) tokens. This is
// a conservative context estimate, not a provider billing/usage guarantee.
// Never estimate image tokens from base64 length.
std::size_t model_image_context_cost(const ModelImage& image);

struct ModelMessage {
    std::string role;
    std::string content;
    std::vector<ToolCall> tool_calls;
    std::string tool_call_id;
    std::vector<ModelImage> images;
    // Provider-specific reasoning attached to this assistant turn. It is only
    // serialized when the active model configuration explicitly requests it.
    std::string reasoning_content;
};

struct ModelTool {
    std::string name;
    std::string description;
    Json parameters;
};

struct ModelConfig {
    std::string base_url;
    std::string api_key;
    std::string model;
    int timeout_ms = 120000;
    int max_output_tokens = 4096;
    std::string protocol = "chat-completions";
    ModelPayloadLimits payload_limits{};
    // Zero retains timeout_ms for that phase. Work uses a 1 h total deadline,
    // 5 min without network progress, and a 10 s connection/DNS timeout.
    int idle_timeout_ms = 0;
    int connect_timeout_ms = 0;
    // Application-owned Work routing hints; never serialized into HTTP bodies.
    std::string provider_id;
    std::string context_feature;
    std::size_t context_window_tokens = 0;
    // Optional provider dialect controls. Empty defaults preserve third-party
    // request bodies. DeepSeek Work opts into reasoning history explicitly.
    std::optional<bool> thinking_enabled{};
    std::optional<double> temperature{};
    std::string reasoning_effort;
    bool preserve_reasoning_content = false;
};

enum class ModelFailure { Cancelled, Timeout, Transport, Http, OutputLimit, ContextWindowExceeded };
class ModelError final : public std::runtime_error {
public:
    ModelError(ModelFailure kind, std::string message, int http_status = 0);
    ModelFailure kind() const noexcept { return kind_; }
    int http_status() const noexcept { return http_status_; }
    // Only transient transport/HTTP failures qualify for a configured route.
    bool may_upgrade() const noexcept;
private:
    ModelFailure kind_;
    int http_status_;
};

struct ModelReply {
    std::string text;
    std::vector<ToolCall> tool_calls;
    int input_tokens = 0;
    int output_tokens = 0;
    std::string reasoning_content;
};

// Invoked on the calling thread. kind is "text" or "thinking". Views are
// valid only for the callback duration. Thinking never enters ModelReply::text.
using ModelChunk = std::function<void(std::string_view kind, std::string_view text)>;

// Windows WinHTTP client. Throws std::runtime_error on invalid configuration,
// HTTP/protocol errors, timeout or cancellation. Callback exceptions propagate.
// Redirects are refused; TLS verification uses the Windows defaults. Request
// and response budgets use config.payload_limits (Chat defaults: 4 MiB text,
// 12 MiB image request). Work explicitly selects work_model_payload_limits.
// Tool/assistant/system images are rejected. No request
// secrets/body are logged. Images are never returned in ModelReply.
ModelReply call_model(const ModelConfig& config,
                      const std::vector<ModelMessage>& messages,
                      const std::vector<ModelTool>& tools,
                      ModelChunk chunk = {},
                      std::stop_token stop = {});

// Authenticated GET of the same configured API base's /models endpoint.
// No redirects, cookies, auto-logon or weakened TLS. At most 1 MiB, 10 seconds;
// caller normalizes the untrusted JSON. No response bodies appear in errors.
std::string fetch_livebench_file(const std::string& name,std::stop_token stop = {});
Json fetch_model_catalog(const ModelConfig& config, std::stop_token stop = {});

} // namespace dimension
