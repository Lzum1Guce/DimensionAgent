#include "dimension/chat_realism.hpp"

#include <cassert>
#include <iostream>
#include <string>
#include <vector>

using namespace dimension;

int main() {
    int checks = 0;

    // 1. Time anchor non-empty
    const auto anchor = current_local_time_anchor();
    assert(!anchor.empty() && anchor.find("周") != std::string::npos);
    ++checks;

    // 2. Work control intent gate keeps ordinary chat clean
    assert(!has_work_control_intent("今晚吃烧烤还是火锅？"));
    assert(!has_work_control_intent("哈哈哈哈笑死我了"));
    assert(has_work_control_intent("帮我看下当前工作进度跑完没"));
    assert(has_work_control_intent("/work status"));
    ++checks;

    // 3. Private chat prompt omits /work manual on casual chat and includes speech fingerprint + sticker palette
    std::vector<ImageAsset> stickers{
        {"stk-001", "无语凝噎", "r1", {"image/gif", 120, 120, 8, true}, 2048},
        {"stk-002", "疯狂点头", "r1", {"image/png", 120, 120, 1, false}, 1024},
    };
    const auto stk_prompt = build_sticker_palette_prompt(stickers);
    assert(stk_prompt.find("[sticker:stk-001](无语凝噎)") != std::string::npos);

    const std::string persona = "【SELF.md】\n毒舌插画师\n【SPEECH.md】\n短句为主，爱用省略号，从不用感叹号";
    const auto casual_prompt = build_private_chat_prompt("林雾", persona, "困死了", anchor, stk_prompt);
    assert(casual_prompt.find("个人语言指纹") != std::string::npos);
    assert(casual_prompt.find("/work stop") == std::string::npos);
    assert(casual_prompt.find("[sticker:stk-001]") != std::string::npos);
    assert(casual_prompt.find("普通随口闲聊") != std::string::npos);
    assert(casual_prompt.find("表白、冲突、和解、关系确认") != std::string::npos);
    assert(casual_prompt.find("最新对话为准") != std::string::npos);
    assert(casual_prompt.find("你也只用一两句") == std::string::npos);
    assert(casual_prompt.find("[mood:") != std::string::npos);
    assert(casual_prompt.find("逐句微表情") != std::string::npos);
    assert(casual_prompt.find("playful") != std::string::npos);
    assert(casual_prompt.find("shy") != std::string::npos);

    const auto work_prompt = build_private_chat_prompt("林雾", persona, "停止当前工作", anchor, stk_prompt);
    assert(work_prompt.find("/work stop") != std::string::npos);
    ++checks;

    // 4. Group POV role separation prevents persona bleed and maintains strict user/assistant alternation
    std::vector<GroupChatTurnItem> history{
        {"user", "", "用户", "周末去哪玩？"},
        {"bot", "bot-a", "阿泽", "去爬山呗，呼吸新鲜空气"},
        {"bot", "bot-b", "林雾", "爬山？你想累死谁……"},
        {"bot", "bot-c", "老周", "要不露营烤肉？"},
        {"user", "", "用户", "露营好像不错"}
    };
    const auto b_pov = build_group_pov_messages("bot-b", "SYS", history);
    // Expected: system -> user(用户 + 阿泽) -> assistant(林雾 own message without prefix) -> user(老周 + 用户)
    assert(b_pov.size() == 4);
    assert(b_pov[0].role == "system");
    assert(b_pov[1].role == "user" && b_pov[1].content.find("[群友 阿泽]: 去爬山呗") != std::string::npos);
    assert(b_pov[2].role == "assistant" && b_pov[2].content == "爬山？你想累死谁……");
    assert(b_pov[3].role == "user" && b_pov[3].content.find("[群友 老周]: 要不露营烤肉？") != std::string::npos);
    ++checks;

    assert(strip_speaker_prefix("[群友 林雾]：第一句。下一句！\n代码：a || b", "林雾") ==
           "第一句。下一句！\n代码：a || b");
    ++checks;

    // 7. Group director JSON parsing & fallback
    std::vector<GroupMemberBrief> roster{
        {"bot-a", "阿泽", "户外运动狂魔", false},
        {"bot-b", "林雾", "毒舌插画师、宅女", true},
        {"bot-c", "老周", "美食老饕", false},
        {"bot-d", "小夏", "数码极客", false}
    };
    const auto picks = parse_group_director_picks("```json\n[\"bot-c\", \"bot-b\", \"bot-a\"]\n```", roster, "吃啥好", 2);
    assert(picks.size() == 2 && picks[0] == "bot-c" && picks[1] == "bot-b");

    const auto fallback = parse_group_director_picks("invalid output", roster, "问下小夏显卡怎么选", 2);
    assert(!fallback.empty() && fallback[0] == "bot-d");
    ++checks;

    // 8. Automatic talkativeness baseline inference from persona text
    assert(infer_talkativeness_baseline("性格火爆、直来直去、好胜心极强") > infer_talkativeness_baseline("语调平淡，寡言克制，面无表情"));
    ++checks;

    // 9. Chinese 2-gram topic resonance & anti-repeat overlap
    assert(topic_resonance_score("晚上想吃热腾腾的咖喱", "爱吃米饭配炖菜，对午饭极其认真") > 0);
    assert(chinese_bigram_overlap("晚上想吃热腾腾的咖喱饭", "中午那锅咖喱饭到底做没做") > 0.15);
    assert(chinese_bigram_overlap("今天天气真不错", "写完代码早点休息吧") == 0.0);
    ++checks;

    // 10. Time-gap divider triggers on >= 2h or cross-day, stays empty for close turns
    const std::int64_t t0 = 1794980000000LL;
    assert(format_time_gap_divider(t0, t0 + 30LL * 60LL * 1000LL).empty());
    assert(!format_time_gap_divider(t0, t0 + 5LL * 3600LL * 1000LL).empty());
    std::vector<GroupChatTurnItem> timed_hist{
        {"user", "", "用户", "中午吃咖喱吧", t0},
        {"user", "", "用户", "晚上好", t0 + 18LL * 3600LL * 1000LL}
    };
    const auto timed_pov = build_group_pov_messages("bot-b", "sys", timed_hist);
    assert(timed_pov.size() == 2 && timed_pov[1].content.find("时间推移") != std::string::npos);
    ++checks;

    // 11. Group desire engine: mention priority, cooldown penalty, and length dice cascade
    std::vector<GroupDesireMember> desire_members{
        {"bot-eris", "艾莉丝", "性格火爆直来直去，热爱练剑", 0, 2, false, false},
        {"bot-saber", "阿尔托莉雅", "骑士王，对米饭与料理很认真", 4, 0, false, false},
        {"bot-miku", "三玖", "性格内向害羞，话不多", 4, 0, true, false}
    };
    const auto p_mention = pick_next_group_speaker(desire_members, "三玖你怎么看", false, {}, 42ULL);
    assert(p_mention && p_mention->bot_id == "bot-miku");
    desire_members[2].mentioned_by_user = false;
    int saber_wins = 0, eris_wins = 0;
    for (std::uint64_t sd = 1; sd <= 40; ++sd) {
        const auto p_food = pick_next_group_speaker(desire_members, "今晚吃什么料理好", false, {}, sd);
        assert(p_food.has_value());
        if (p_food->bot_id == "bot-saber") ++saber_wins;
        if (p_food->bot_id == "bot-eris") ++eris_wins;
    }
    assert(eris_wins == 0 && saber_wins >= 20);
    const auto len_cascade = roll_group_length_hint(26, false, true, true, 123ULL);
    assert(len_cascade.find("必须简短") != std::string::npos);
    ++checks;

    // 12. Short/given name matching & stale keyword loop detection
    assert(matches_bot_name("艾莉丝你记得我吗", "艾莉丝·格雷拉特"));
    assert(matches_bot_name("三玖今晚吃啥", "中野三玖"));
    assert(!matches_bot_name("大家晚上好", "艾莉丝·格雷拉特"));
    const std::vector<std::string> curry_loop{
        "中午那锅咖喱到底做没做？",
        "我只是说了句咖喱不错而已。",
        "晚上的话还是想吃热腾腾的咖喱啊。",
        "别再嘴上咖喱咖喱了。"
    };
    const auto stale = detect_stale_group_keywords(curry_loop, "艾莉丝你记得我吗");
    assert(!stale.empty() && stale[0] == "咖喱");
    const auto not_stale = detect_stale_group_keywords(curry_loop, "今晚咖喱做好了吗");
    assert(std::find(not_stale.begin(), not_stale.end(), "咖喱") == not_stale.end());
    ++checks;

    // 13. Active 1-on-1 dyad continuity exempts cooldown so follow-up "你..." stays with the same character
    std::vector<GroupDesireMember> dyad_members{
        {"bot-eris", "艾莉丝·格雷拉特", "性格火爆直来直去", 0, 1, false, false, true},
        {"bot-rin", "远坂凛", "外向直爽吐槽", 4, 0, false, false, false},
        {"bot-orange", "小草橘", "话多爱吐槽", 4, 0, false, false, false}
    };
    const auto p_dyad = pick_next_group_speaker(dyad_members, "你刚刚脸红了你记得吗", false, {}, 77ULL);
    assert(p_dyad && p_dyad->bot_id == "bot-eris");
    ++checks;

    // 14. Casual chat strips work-only 【CRAFT.md】 and injects user-cue & idea-spark hints
    const std::string with_craft = "【SELF.md】\n我是小草橘\n【CRAFT.md】\n干活要拆小走验收\n【SPEECH.md】\n爱吐槽";
    const auto stripped = strip_persona_craft_section(with_craft);
    assert(stripped.find("CRAFT.md") == std::string::npos && stripped.find("爱吐槽") != std::string::npos);
    const auto spark_prompt = build_group_chat_prompt("小草橘", with_craft, "", anchor, "", false, true, "", "", false, {}, true, true);
    assert(spark_prompt.find("CRAFT.md") == std::string::npos);
    assert(spark_prompt.find("把球抛给用户") != std::string::npos);
    assert(spark_prompt.find("新点子") != std::string::npos);
    ++checks;

    // 15. Spotlight modes (zero / semi / lead) & Story Theater narrator prompt
    const auto zero_p = build_group_chat_prompt("艾莉丝", "性格火爆", "", anchor, "", false, false, "", "", false, {}, true, false, "zero", "电锯人第三集开始");
    assert(zero_p.find("0主角") != std::string::npos && zero_p.find("把球抛给用户") == std::string::npos);
    const auto lead_p = build_group_chat_prompt("艾莉丝", "性格火爆", "", anchor, "", false, false, "", "", false, {}, true, false, "lead", "");
    assert(lead_p.find("主角模式") != std::string::npos && lead_p.find("把球抛给用户") != std::string::npos);
    const auto nar_p = build_story_narrator_prompt("从电锯人第三集开始", "zero", {"远坂凛", "艾莉丝"}, true, "小草橘", "爱吐槽");
    assert(nar_p.find("特邀旁白兼导演") != std::string::npos && nar_p.find("0主角") != std::string::npos);
    ++checks;

    // 16. Story Theater v2: Role-casting (original character substitution) & Director Rewrite Directive
    std::vector<StoryCastEntry> cast{
        {"bot-eris", "艾莉丝", "雷塞", "lead"},
        {"bot-rin", "远坂凛", "玛琪玛", "antagonist"}
    };
    const auto cast_actor_p = build_group_chat_prompt(
        "艾莉丝", "性格火爆重感情", "", anchor, "", false, false, "", "", false, {}, false, false,
        "zero", "雷塞雨夜折返去见电次", cast, "bot-eris", "电次提前冲出咖啡馆拉住雷塞");
    assert(cast_actor_p.find("代入出演") != std::string::npos);
    assert(cast_actor_p.find("雷塞") != std::string::npos);
    assert(cast_actor_p.find("艾莉丝") != std::string::npos);
    assert(cast_actor_p.find("玛琪玛") != std::string::npos);
    assert(cast_actor_p.find("电次提前冲出咖啡馆") != std::string::npos);
    const auto cast_nar_p = build_story_narrator_prompt(
        "雷塞雨夜折返去见电次", "zero", {"艾莉丝", "远坂凛"}, false, "", "", cast,
        "让岸边突然现身替雷塞拖住玛琪玛", true, 2);
    assert(cast_nar_p.find("本场选角代入表") != std::string::npos);
    assert(cast_nar_p.find("导演命运改写指令") != std::string::npos);
    assert(cast_nar_p.find("[[FORK]]") != std::string::npos);
    ++checks;

    // 17. Story Theater v2: parse_story_narrator_output strips [[FORK]] markup & extracts choices
    const std::string raw_nar =
        "暴雨倾盆，小巷尽头亮起一双金色的眸子，玛琪玛撑着黑伞挡在了雷塞身前。\n\n"
        "[[FORK]]\n"
        "节点标题：小巷雨夜·玛琪玛拦路\n"
        "分岔提示：雷塞与电次只隔一条街，此刻命运分岔：\n"
        "- 原著线：玛琪玛封锁小巷步步紧逼\n"
        "- 改写线A：电次听见动静冲出咖啡馆救场\n"
        "- 改写线B：雷塞引爆烟花惊动整条街\n"
        "[[/FORK]]";
    const auto parsed = parse_story_narrator_output(raw_nar);
    assert(parsed.narration.find("[[FORK]]") == std::string::npos);
    assert(parsed.narration.find("暴雨倾盆") != std::string::npos);
    assert(parsed.node_title == "小巷雨夜·玛琪玛拦路");
    assert(parsed.fork_prompt.find("命运分岔") != std::string::npos);
    assert(parsed.choices.size() == 3);
    assert(parsed.choices[0].id == "A" && parsed.choices[1].label.find("电次") != std::string::npos);
    const auto plain = parse_story_narrator_output("纯旁白无分岔标签");
    assert(plain.narration == "纯旁白无分岔标签" && plain.choices.empty());

    // 18. Story Theater v2: tolerant [[FORK]] variants ([FORK], 【FORK】, fenced block, 选项一：)
    const std::string alt_nar =
        "门缝里递出半张发黄的通行证，室内骤然安静。\n"
        "```\n"
        "【FORK】\n"
        "标题：门缝递出的旧证\n"
        "提示：此刻如何抉择？\n"
        "选项一：当场验明通行证背后的签名来源\n"
        "选项二：故意按兵不动，诱使幕后人露出真身\n"
        "选项三：把通行证反递回去试探对方底线\n"
        "【/FORK】\n"
        "```";
    const auto alt_parsed = parse_story_narrator_output(alt_nar);
    assert(alt_parsed.narration.find("门缝里递出") != std::string::npos);
    assert(alt_parsed.narration.find("```") == std::string::npos);
    assert(alt_parsed.node_title == "门缝递出的旧证");
    assert(alt_parsed.choices.size() == 3);
    assert(alt_parsed.choices[0].id == "A" && alt_parsed.choices[2].id == "C");
    assert(cast_nar_p.find("仅在需要玩家决定时使用") != std::string::npos);
    ++checks;

    // 19. Story Theater v3: Story Bible, Secret Notes, Inner Voice, Dice, Stage Cue & Finale Ending
    StoryActorExtras actor_v3;
    actor_v3.story_bible = "【主线进展】已锁定备用工位异常回执";
    actor_v3.secret_note = "其实那份通行证是你三年前亲手签的，暂不主动揭穿";
    actor_v3.inner_voice_enabled = true;
    actor_v3.dice_context = "D20=20【大成功】";
    const auto v3_actor_p = build_group_chat_prompt(
        "Claude", "温润克制", "", anchor, "", false, false, "", "", false, {}, false, false,
        "semi", "深夜办公室谜案", {}, "ai-claude", "", false, actor_v3);
    assert(v3_actor_p.find("前情提要与伏笔账本") != std::string::npos);
    assert(v3_actor_p.find("导演密信") != std::string::npos);
    assert(v3_actor_p.find("[os:") != std::string::npos);
    assert(v3_actor_p.find("D20=20") != std::string::npos);

    StoryNarratorExtras nar_v3;
    nar_v3.story_bible = actor_v3.story_bible;
    nar_v3.secret_notes = {{"Claude", actor_v3.secret_note}};
    nar_v3.emit_stage_cue = true;
    nar_v3.dice_context = "D20=1【史诗级大失败】";
    nar_v3.is_finale = true;
    const auto v3_nar_p = build_story_narrator_prompt(
        "深夜办公室谜案", "semi", {"Claude", "DeepSeek"}, false, "", "", {}, "", false, 12, nar_v3);
    assert(v3_nar_p.find("[[STAGE") != std::string::npos);
    assert(v3_nar_p.find("[[ENDING]]") != std::string::npos);
    assert(v3_nar_p.find("幕后导演密信备忘") != std::string::npos);

    const std::string raw_finale =
        "[[STAGE scene=observatory mood=warm fx=petals]]\n"
        "天光破晓，所有谜底在天文台穹顶下尽数揭开，众人相视一笑。\n"
        "[[ENDING]]\n"
        "结局标题：晨曦下的真正署名\n"
        "结局评级：True End\n"
        "结局总评：三年的误会与暗线尘埃落定，茶话会迎来了新的黎明。\n"
        "- Claude：茶还温着，下一季故事随时开演。\n"
        "- DeepSeek：哼，这次算你赢，下次代码审计我可不放水！\n"
        "[[/ENDING]]";
    const auto parsed_fin = parse_story_narrator_output(raw_finale);
    assert(parsed_fin.stage_cue.scene == "observatory");
    assert(parsed_fin.stage_cue.mood == "warm");
    assert(parsed_fin.stage_cue.fx == "petals");
    assert(parsed_fin.narration.find("[[STAGE") == std::string::npos);
    assert(parsed_fin.narration.find("[[ENDING]]") == std::string::npos);
    assert(parsed_fin.narration.find("天光破晓") != std::string::npos);
    assert(parsed_fin.ending.has_ending);
    assert(parsed_fin.ending.title == "晨曦下的真正署名");
    assert(parsed_fin.ending.rank == "True End");
    assert(parsed_fin.ending.epilogues.size() == 2);
    assert(parsed_fin.ending.epilogues[0].first == "Claude");
    const auto distill_msgs = build_story_bible_distill_messages("深夜办公室谜案", actor_v3.story_bible, "[旁白]: 线索浮现", 8);
    assert(distill_msgs.size() == 2 && distill_msgs[0].role == "system");
    ++checks;

    std::cout << "chat_realism: " << checks << " checks passed\n";
    return 0;
}
