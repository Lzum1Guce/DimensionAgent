#include "dimension/persona_fields.hpp"

#include <cctype>

namespace dimension {
namespace {
constexpr PersonaFieldSpec kSpecs[] = {
    {"who_am_i", "我是谁", "【SELF.md】", true},
    {"personality", "性格", "【PERSONALITY.md】", true},
    {"speech_style", "说话方式", "【SPEECH.md】", true},
    {"preferences", "爱好和厌恶的东西", "【PREFERENCES.md】", true},
    {"work_attitude", "对待自己拿手工作的经验和态度", "【CRAFT.md】", true},
    {"role_setting", "角色设定", "【角色设定】", false},
    {"role_profile", "角色资料", "【角色资料】", false},
    {"affect_preference", "情绪表达偏好", "【情绪表达偏好】", false},
};

constexpr std::string_view kStorageOrder[] = {
    "role_setting",
    "role_profile",
    "affect_preference",
    "who_am_i",
    "personality",
    "preferences",
    "speech_style",
    "work_attitude",
};

bool is_ascii_ws(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

void rtrim_ws(std::string& text) {
    while (!text.empty() && is_ascii_ws(static_cast<unsigned char>(text.back()))) text.pop_back();
}

bool is_blank(std::string_view text) {
    for (char c : text) {
        if (!is_ascii_ws(static_cast<unsigned char>(c))) return false;
    }
    return true;
}

bool at_line_start(std::string_view text, std::size_t i) {
    if (i == 0) return true;
    const auto prev = text[i - 1];
    return prev == '\n' || prev == '\r';
}

const PersonaFieldSpec* match_heading(std::string_view text, std::size_t i, std::size_t& line_end) {
    for (const auto& spec : kSpecs) {
        if (text.size() - i < spec.heading.size()) continue;
        if (text.substr(i, spec.heading.size()) != spec.heading) continue;
        auto j = i + spec.heading.size();
        while (j < text.size() && (text[j] == ' ' || text[j] == '\t')) ++j;
        if (j == text.size() || text[j] == '\n' || text[j] == '\r') {
            line_end = j;
            return &spec;
        }
    }
    return nullptr;
}

std::string strip_self_heading(std::string content, std::string_view heading) {
    std::size_t i = 0;
    while (i < content.size() && is_ascii_ws(static_cast<unsigned char>(content[i]))) ++i;
    if (content.size() - i >= heading.size() && content.compare(i, heading.size(), heading) == 0) {
        i += heading.size();
        if (i < content.size() && content[i] == '\r') ++i;
        if (i < content.size() && content[i] == '\n') ++i;
        content.erase(0, i);
    }
    rtrim_ws(content);
    return content;
}

std::size_t skip_eol(std::string_view text, std::size_t i) {
    if (i < text.size() && text[i] == '\r') ++i;
    if (i < text.size() && text[i] == '\n') ++i;
    return i;
}
} // namespace

const std::vector<PersonaFieldSpec>& persona_field_specs() {
    static const std::vector<PersonaFieldSpec> specs(std::begin(kSpecs), std::end(kSpecs));
    return specs;
}

const PersonaFieldSpec* persona_field_by_key(std::string_view key) {
    for (const auto& spec : kSpecs) {
        if (spec.key == key) return &spec;
    }
    return nullptr;
}

bool is_persona_field_key(std::string_view key) {
    const auto* spec = persona_field_by_key(key);
    return spec && spec->always_visible;
}

std::map<std::string, std::string> split_persona(std::string_view text) {
    std::map<std::string, std::string> out;
    for (const auto& spec : kSpecs) out.emplace(std::string(spec.key), std::string{});

    struct Hit {
        std::size_t pos;
        std::size_t line_end;
        const PersonaFieldSpec* spec;
    };
    std::vector<Hit> hits;
    for (std::size_t i = 0; i < text.size();) {
        if (at_line_start(text, i)) {
            std::size_t line_end = i;
            if (const auto* spec = match_heading(text, i, line_end)) {
                hits.push_back({i, line_end, spec});
                i = line_end;
                continue;
            }
        }
        ++i;
    }

    std::string preamble;
    if (hits.empty()) {
        preamble = std::string(text);
        rtrim_ws(preamble);
    } else if (hits.front().pos > 0) {
        preamble = std::string(text.substr(0, hits.front().pos));
        rtrim_ws(preamble);
    }

    for (std::size_t n = 0; n < hits.size(); ++n) {
        const auto start = skip_eol(text, hits[n].line_end);
        const auto stop = n + 1 < hits.size() ? hits[n + 1].pos : text.size();
        auto raw = std::string(text.substr(start, stop > start ? stop - start : 0));
        rtrim_ws(raw);
        auto& slot = out[std::string(hits[n].spec->key)];
        if (!slot.empty() && !raw.empty()) {
            slot.push_back('\n');
            slot += raw;
        } else if (slot.empty()) {
            slot = std::move(raw);
        }
    }

    if (!preamble.empty()) {
        auto& setting = out["role_setting"];
        if (setting.empty()) setting = std::move(preamble);
        else setting = preamble + "\n" + setting;
    }
    return out;
}

std::string join_persona(const std::map<std::string, std::string>& fields) {
    std::string out;
    for (const auto key : kStorageOrder) {
        const auto* spec = persona_field_by_key(key);
        if (!spec) continue;
        auto it = fields.find(std::string(key));
        if (it == fields.end() || is_blank(it->second)) continue;
        auto content = strip_self_heading(it->second, spec->heading);
        if (is_blank(content)) continue;
        if (!out.empty() && out.back() != '\n') out.push_back('\n');
        if (!out.empty()) out.push_back('\n');
        out.append(spec->heading);
        out.push_back('\n');
        out += content;
    }
    return out;
}

std::vector<PersonaSection> visible_persona_fields(std::string_view text) {
    const auto parts = split_persona(text);
    std::vector<PersonaSection> fields;
    for (const auto& spec : kSpecs) {
        if (!spec.always_visible) continue;
        const auto it = parts.find(std::string(spec.key));
        const std::string content = it == parts.end() ? std::string{} : it->second;
        fields.push_back({std::string(spec.key), std::string(spec.title), content, spec.always_visible});
    }
    return fields;
}

std::string merge_persona_fields(std::string_view current,
    const std::map<std::string, std::string>& updates) {
    auto parts = split_persona(current);
    for (const auto& [key, value] : updates) {
        if (!is_persona_field_key(key)) continue;
        parts[key] = value;
    }
    return join_persona(parts);
}
} // namespace dimension
