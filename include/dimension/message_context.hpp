#pragma once

#include "dimension/json.hpp"
#include "dimension/store.hpp"

namespace dimension {

// Strict, bounded, versioned reference-data format shared by Store, archives,
// runs and API views. IDs/timestamps/ranges use canonical decimal strings.
[[nodiscard]] Json message_context_json(const MessageContext&);
[[nodiscard]] MessageContext parse_message_context(const Json&);
void validate_message_context_scope(const MessageContext&, std::string_view bot,
    std::string_view group, Mode mode, std::string_view actor);
[[nodiscard]] std::string message_context_prompt(const MessageContext&);
[[nodiscard]] std::string message_with_context(const std::string& plain,
    const std::optional<MessageContext>& context);
[[nodiscard]] std::string source_data_digest(std::string_view bytes);

} // namespace dimension
