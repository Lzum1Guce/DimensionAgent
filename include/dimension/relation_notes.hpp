#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace dimension {

struct RelationNoteField {
    std::string_view key, title, description;
};
inline constexpr std::array<RelationNoteField, 4> relation_note_fields{{
    {"user-profile", "关于用户", "用户的信息，不是 Bot 自己的履历或人设。"},
    {"user-relationship", "与用户的关系", "此 Bot 与用户的关系；可以留空，后续会话中逐步积累。"},
    {"contacts", "联系人及关系", "本应用中的其他 Bot，以及不同平台的人类联系人及其关系。"},
    {"external-bots", "认识的外部Bot", "外部平台上其他 Agent 中的 Bot。"}
}};
inline constexpr std::string_view relation_note_reserved_prefix = "@dimension-note/";
inline constexpr std::string_view relation_note_prefix = "@dimension-note/v1/";
inline constexpr std::size_t relation_note_max_content_bytes = 64U * 1024U;

struct RelationNote {
    std::string key, content;
};
[[nodiscard]] bool is_relation_note_text(std::string_view text) noexcept;
// Ordinary text returns nullopt; an invalid reserved encoding is an error.
[[nodiscard]] std::optional<RelationNote> parse_relation_note(std::string_view text);
[[nodiscard]] std::string encode_relation_note(std::string_view key, std::string_view content);
// Prompt material keeps explicit subject/field labels instead of the marker.
[[nodiscard]] std::string memory_context_text(std::string_view text);

} // namespace dimension
