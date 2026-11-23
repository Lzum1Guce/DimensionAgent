#pragma once
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {
struct PersonaFieldSpec {
    std::string_view key;
    std::string_view title;
    std::string_view heading;
    bool always_visible;
};

// Storage still knows eight keys. GET/POST only expose the five official columns.
const std::vector<PersonaFieldSpec>& persona_field_specs();
const PersonaFieldSpec* persona_field_by_key(std::string_view key);
bool is_persona_field_key(std::string_view key);

struct PersonaSection {
    std::string key;
    std::string title;
    std::string content;
    bool always_visible = false;
};

// Split a single bots.persona string by the known headings only.
// Untitled leading text is attached to role_setting so it is not dropped on save.
// Duplicate headings append. Unknown titles such as 【我推的孩子】 stay in the current section.
std::map<std::string, std::string> split_persona(std::string_view text);

// Recompose in library storage order (role_* then SELF, PERSONALITY, PREFERENCES, SPEECH, CRAFT).
// Empty optional sections are omitted. Empty official sections are also omitted from the text
// (GET still returns the five official boxes). Does not wrap an extra heading around content
// that already starts with that heading.
std::string join_persona(const std::map<std::string, std::string>& fields);

// Five official boxes always. role_setting / role_profile / affect_preference stay in storage but are not visible.
std::vector<PersonaSection> visible_persona_fields(std::string_view text);

// Start from current text, apply provided keys (empty string clears). Omitted keys stay.
std::string merge_persona_fields(std::string_view current,
    const std::map<std::string, std::string>& updates);
}
