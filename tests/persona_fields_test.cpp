#include "dimension/persona_fields.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace dimension;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
}

int main() {
    try {
        const std::string sample =
            "【角色设定】\n死亡笔记\n\n"
            "【角色资料】\n# L\n出处：死亡笔记\n\n"
            "【SELF.md】\n我是 L。\n正文里有【我推的孩子】不能当分节。\n\n"
            "【PERSONALITY.md】\n冷静。\n\n"
            "【PREFERENCES.md】\n喜欢：甜食\n讨厌：浪费时间\n\n"
            "【SPEECH.md】\n说话简短。\n\n"
            "【CRAFT.md】\n推理。\n";

        const auto parts = split_persona(sample);
        CHECK(parts.at("role_setting") == "死亡笔记");
        CHECK(parts.at("role_profile") == "# L\n出处：死亡笔记");
        CHECK(parts.at("who_am_i") == "我是 L。\n正文里有【我推的孩子】不能当分节。");
        CHECK(parts.at("personality") == "冷静。");
        CHECK(parts.at("preferences") == "喜欢：甜食\n讨厌：浪费时间");
        CHECK(parts.at("speech_style") == "说话简短。");
        CHECK(parts.at("work_attitude") == "推理。");
        CHECK(parts.at("affect_preference").empty());

        const auto visible = visible_persona_fields(sample);
        CHECK(visible.size() == 5);
        CHECK(visible[0].key == "who_am_i" && visible[0].title == "我是谁");
        CHECK(visible[1].key == "personality" && visible[1].title == "性格");
        CHECK(visible[2].key == "speech_style" && visible[2].title == "说话方式");
        CHECK(visible[3].key == "preferences" && visible[3].title == "爱好和厌恶的东西");
        CHECK(visible[4].key == "work_attitude" && visible[4].title == "对待自己拿手工作的经验和态度");
        for (const auto& field : visible) {
            CHECK(field.key != "role_setting" && field.key != "role_profile" && field.key != "affect_preference");
        }
        CHECK(parts.at("role_setting") == "死亡笔记");
        CHECK(parts.at("role_profile") == "# L\n出处：死亡笔记");

        const auto grass = split_persona("【角色设定】\n坏字\ue862\n\n【情绪表达偏好】\nsummary\n\n【SELF.md】\n我是小草橘。\n");
        CHECK(grass.at("role_setting") == std::string("坏字") + "\ue862");
        CHECK(grass.at("affect_preference") == "summary");
        CHECK(grass.at("who_am_i") == "我是小草橘。");
        CHECK(grass.at("role_profile").empty());
        const auto grass_fields = visible_persona_fields("【角色设定】\n坏字\n\n【情绪表达偏好】\nsummary\n\n【SELF.md】\n我是小草橘。\n");
        CHECK(grass_fields.size() == 5);
        for (const auto& field : grass_fields) {
            CHECK(field.key != "role_setting" && field.key != "role_profile" && field.key != "affect_preference");
        }
        CHECK(grass.at("role_setting") == std::string("坏字") + "\ue862");
        CHECK(grass.at("affect_preference") == "summary");

        const auto joined = join_persona(parts);
        const auto again = split_persona(joined);
        CHECK(again.at("role_setting") == parts.at("role_setting"));
        CHECK(again.at("role_profile") == parts.at("role_profile"));
        CHECK(again.at("who_am_i") == parts.at("who_am_i"));
        CHECK(again.at("personality") == parts.at("personality"));
        CHECK(again.at("preferences") == parts.at("preferences"));
        CHECK(again.at("speech_style") == parts.at("speech_style"));
        CHECK(again.at("work_attitude") == parts.at("work_attitude"));
        CHECK(joined.find("【PREFERENCES.md】") < joined.find("【SPEECH.md】"));

        const auto doubled = join_persona({{"who_am_i", "【SELF.md】\n我是 L。"}});
        CHECK(doubled == "【SELF.md】\n我是 L。");
        CHECK(doubled.find("【SELF.md】【SELF.md】") == std::string::npos);
        CHECK(doubled.find("【SELF.md】\n【SELF.md】") == std::string::npos);

        const auto empty_optional = visible_persona_fields("【SELF.md】\n只有我。\n");
        CHECK(empty_optional.size() == 5);
        CHECK(empty_optional[0].content == "只有我。");
        CHECK(empty_optional[1].content.empty());

        const auto no_headings = split_persona("整篇没有分节。");
        CHECK(no_headings.at("role_setting") == "整篇没有分节。");
        CHECK(no_headings.at("who_am_i").empty());

        const auto with_preamble = split_persona("前言\n【SELF.md】\n正文\n");
        CHECK(with_preamble.at("role_setting") == "前言");
        CHECK(with_preamble.at("who_am_i") == "正文");

        const auto merged = merge_persona_fields(sample, {{"speech_style", ""}, {"personality", "更冷静。"}});
        const auto merged_parts = split_persona(merged);
        CHECK(merged_parts.at("personality") == "更冷静。");
        CHECK(merged_parts.at("speech_style").empty());
        CHECK(merged_parts.at("who_am_i") == parts.at("who_am_i"));
        CHECK(merged_parts.at("role_setting") == "死亡笔记");
        CHECK(merged.find("【SPEECH.md】") == std::string::npos);

        CHECK(is_persona_field_key("who_am_i"));
        CHECK(is_persona_field_key("work_attitude"));
        CHECK(!is_persona_field_key("role_setting"));
        CHECK(!is_persona_field_key("role_profile"));
        CHECK(!is_persona_field_key("affect_preference"));
        CHECK(!is_persona_field_key("persona"));
        CHECK(!is_persona_field_key("self"));
        CHECK(!is_persona_field_key("orientation"));

        std::cout << "persona_fields: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
