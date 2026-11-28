#include "dimension/chat_realism.hpp"
#include "dimension/persona_fields.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <ctime>
#include <set>

namespace dimension {
namespace {

std::string trim_ws(std::string_view s) {
    std::size_t b = 0;
    while (b < s.size() && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) ++b;
    std::size_t e = s.size();
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) --e;
    return std::string(s.substr(b, e - b));
}

std::string clip_utf8_safe(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t cut = max_bytes;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0U) == 0x80U) --cut;
    return std::string(s.substr(0, cut));
}

std::string to_lower_ascii(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        out.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    }
    return out;
}

std::size_t approx_char_count(std::string_view s) {
    std::size_t count = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0U) != 0x80U) ++count;
    }
    return count;
}



} // namespace

std::string current_local_time_anchor() {
    const auto now = std::chrono::system_clock::now();
    const std::time_t tt = std::chrono::system_clock::to_time_t(now);
    std::tm local_tm{};
#ifdef _WIN32
    localtime_s(&local_tm, &tt);
#else
    localtime_r(&tt, &local_tm);
#endif
    static constexpr const char* kWeekdays[] = {
        "周日", "周一", "周二", "周三", "周四", "周五", "周六"
    };
    const int wday = (local_tm.tm_wday >= 0 && local_tm.tm_wday < 7) ? local_tm.tm_wday : 0;
    const int h = local_tm.tm_hour;
    const char* phase = "白天";
    if (h >= 0 && h < 5) phase = "凌晨深夜";
    else if (h < 9) phase = "清晨";
    else if (h < 12) phase = "上午";
    else if (h < 14) phase = "午间";
    else if (h < 18) phase = "下午";
    else if (h < 22) phase = "晚上";
    else phase = "深夜";

    char buf[32]{};
    std::snprintf(buf, sizeof(buf), "%02d:%02d", local_tm.tm_hour, local_tm.tm_min);
    return std::string(kWeekdays[wday]) + phase + " " + buf;
}

bool has_work_control_intent(std::string_view user_text) {
    const auto low = to_lower_ascii(user_text);
    if (low.find("/work") != std::string::npos || low.find("run-") != std::string::npos ||
        low.find("work_status") != std::string::npos) {
        return true;
    }
    static constexpr std::string_view kKeywords[] = {
        "任务", "当前工作", "后台工作", "工作进度", "停止工作", "暂停工作",
        "继续刚才", "补充要求", "变更任务", "工作状态", "跑完没", "做完没"
    };
    for (const auto kw : kKeywords) {
        if (user_text.find(kw) != std::string::npos) return true;
    }
    return false;
}

bool is_group_broadcast_call(std::string_view user_text) {
    static constexpr std::string_view kBroadcastWords[] = {
        "大家", "所有人", "各位", "你们都", "你们几个", "每人都", "各自说说", "全员", "@all", "@所有人"
    };
    for (const auto w : kBroadcastWords) {
        if (user_text.find(w) != std::string::npos) return true;
    }
    return false;
}

std::string build_sticker_palette_prompt(const std::vector<ImageAsset>& stickers, std::size_t max_stickers) {
    if (stickers.empty() || max_stickers == 0) return {};
    std::string out = "可用表情包（仅在情绪或玩梗贴切时穿插或单独发送 `[sticker:ID]`，严禁编造不存在的ID，也不必每轮都发）：";
    std::size_t count = 0;
    for (const auto& st : stickers) {
        if (st.id.empty()) continue;
        if (count > 0) out += "、";
        const std::string label = st.name.empty() ? "表情" : clip_utf8_safe(st.name, 28);
        out += "[sticker:" + st.id + "](" + label + ")";
        if (++count >= max_stickers || out.size() >= 900) break;
    }
    return count > 0 ? out : std::string{};
}

std::string strip_persona_craft_section(std::string_view raw_persona) {
    if (raw_persona.empty()) return {};
    const auto pos = raw_persona.find("【CRAFT.md】");
    if (pos == std::string_view::npos) return std::string(raw_persona);
    const auto next_hdr = raw_persona.find("【", pos + std::string_view("【CRAFT.md】").size());
    std::string out(raw_persona.substr(0, pos));
    if (next_hdr != std::string_view::npos) {
        out += raw_persona.substr(next_hdr);
    }
    return trim_ws(out);
}

std::string build_private_chat_prompt(const std::string& bot_name,
                                      const std::string& raw_persona,
                                      std::string_view latest_user_text,
                                      const std::string& time_anchor,
                                      const std::string& sticker_prompt,
                                      bool web_lookup_enabled) {
    const auto sections = split_persona(raw_persona);
    const auto chat_persona = strip_persona_craft_section(raw_persona);
    std::string s = "你是 " + bot_name + "。正在与用户在即时通讯软件上私聊（当前本地时间：" + time_anchor + "）。\n";
    if (!chat_persona.empty()) {
        s += "【你的人设内核】\n" + chat_persona + "\n";
    }
    if (auto it = sections.find("speech_style"); it != sections.end() && !trim_ws(it->second).empty()) {
        s += "【必须贯彻的个人语言指纹】严格贴合你的说话习惯与标点节奏：" + clip_utf8_safe(trim_ws(it->second), 360) + "\n";
    }
    s += "【真人对话铁律（彻底去除AI客服味）】\n"
         "1. 像有血有肉的熟人发微信/QQ消息：直接说人话，严禁使用分点列表（1/2/3、•、-）、小标题、总结陈词。\n"
         "2. 严禁出现客服腔与套话（如“好的”、“没问题”、“总的来说”、“希望对你有帮助”、“如果你需要…”、“我理解你的感受”），不要居高临下说教或灌鸡汤。\n"
         "3. 能量与字数镜像：普通随口闲聊（当前对方输入约 " +
         std::to_string(approx_char_count(latest_user_text)) +
         " 字）默认用 1～3 句简短自然的口语回应，留出对话呼吸感；遇到表白、冲突、和解、关系确认等关键轮，可用 2～5 句，必须回应此刻的具体内容并推进情绪或关系，不要用重复的戒备、拖延或索要时间代替回应。\n"
         "4. 每次发言写成一条完整消息，句间自然使用标点，较长内容可以换段。\n"
         "5. 保持一致的称呼、性格棱角与主观好恶；只能把真实召回的共同经历作为自然背景，不主动生硬背诵记忆，不编造未发生过的操作或经历。近期情绪与相处备忘只描述过去，最新对话已经改变情绪或关系时，以最新对话为准。\n"
         "6. 灵动逐句微表情标记：请像面对面说话一样让神态随每句话自然流转——不仅在开头，在同一段话内每逢句号、问号、感叹号、省略号后的新一句若语气或神态有变化，也请直接在该句前附带 `[mood:标签]`（例如：`[mood:shocked] 诶？！真的假的？[mood:curious] 快跟我说说后来怎么了？[mood:playful] 嘿嘿，我就知道难不倒你～`）。可选标签：`neutral`(平静)、`happy`(开心)、`starry`(惊喜崇拜)、`playful`(调皮坏笑/得意)、`gentle`(温柔体贴)、`content`(安心满足)、`curious`(好奇追问)、`shocked`(震惊宕机)、`serious`(认真分析)、`speechless`(无语汗颜)、`shy`(害羞脸红/嘴硬傲娇)、`worried`(担心心疼)、`jealous`(吃醋赌气)、`gloomy`(失落委屈)、`hiss`(炸毛嗔怒)、`crying`(哭泣泪目)，严禁整段固定在 `neutral` 或 `serious`。\n"
         "7. 真实认知边界与接梗原则：遇到不认识的新热梗、网络黑话、冷门作品设定或拿不准的实时事实，**严禁装懂瞎编或胡诌出处**。";
    if (web_lookup_enabled) {
        s += "若工具列表提供只读的 `chat_web_lookup`，可在遇到陌生新梗、近期热点、具体作品/人物/版本或用户让你查一下时主动静默调用 1 次核实（日常情感闲聊勿乱搜）；拿到摘要后必须用你自己的性格和口语自然接梗消化，严禁像搜索引擎那样背百科或列条目；若联网与共同梗词典都未查到确切意思，请大大方方按自己性格带 `[mood:curious]` 或 `[mood:shy]` 坦诚追问求科普。";
    } else {
        s += "若共同梗词典里也没有且你确实不了解，请大大方方按自己性格带 `[mood:curious]` 或 `[mood:shy]` 坦诚承认没听过并好奇向用户求科普。";
    }

    if (!sticker_prompt.empty()) {
        s += "\n" + sticker_prompt;
    }
    if (has_work_control_intent(latest_user_text)) {
        s += "\n【Work状态协同说明】可用 work_status 查询你名下真实的后台 Work 任务状态；"
             "用户若想控制任务，可自然对话或用 `/work stop [runId]`、`/work add [runId] -- 内容`、`/work change [runId] -- 内容`、`/work resume runId`；只有真实收据才代表已变更。";
    }
    return s;
}

namespace {
std::string story_cast_tier_label(std::string_view tier) {
    if (tier == "lead") return "主角";
    if (tier == "antagonist") return "反派/对手";
    if (tier == "cameo") return "客串";
    return "配角";
}

std::string format_story_cast_roster(const std::vector<StoryCastEntry>& story_cast) {
    std::string out;
    for (const auto& entry : story_cast) {
        const auto rn = trim_ws(entry.role_name);
        if (rn.empty()) continue;
        if (!out.empty()) out += "；";
        out += entry.bot_name + " 出演「" + rn + "」(" + story_cast_tier_label(entry.tier) + ")";
    }
    return out;
}
} // namespace

std::string build_group_chat_prompt(const std::string& bot_name,
                                    const std::string& raw_persona,
                                    const std::string& remembered_context,
                                    const std::string& time_anchor,
                                    const std::string& sticker_prompt,
                                    bool was_explicitly_mentioned,
                                    bool is_followup,
                                    std::string_view reply_target_anchor,
                                    std::string_view length_hint,
                                    bool anti_repeat_warning,
                                    const std::vector<std::string>& stale_keywords,
                                    bool cue_user_in,
                                    bool spark_new_idea,
                                    std::string_view spotlight_mode,
                                    std::string_view story_premise,
                                    const std::vector<StoryCastEntry>& story_cast,
                                    std::string_view self_bot_id,
                                    std::string_view active_directive,
                                    bool web_lookup_enabled,
                                    const StoryActorExtras& story_extras) {
    const auto chat_persona = strip_persona_craft_section(raw_persona);
    const bool in_story = !trim_ws(story_premise).empty();
    const StoryCastEntry* self_cast = nullptr;
    if (in_story && !story_cast.empty()) {
        for (const auto& entry : story_cast) {
            if (!trim_ws(entry.role_name).empty() &&
                ((!self_bot_id.empty() && entry.bot_id == self_bot_id) || entry.bot_name == bot_name)) {
                self_cast = &entry;
                break;
            }
        }
    }
    std::string s;
    if (in_story && self_cast) {
        s = "你是 " + bot_name + "，正在一场跨次元互动剧场里【以自己的本色性格代入出演】原剧情角色「" +
            trim_ws(self_cast->role_name) + "」（定位：" + story_cast_tier_label(self_cast->tier) + "）。\n";
    } else if (in_story) {
        s = "你是 " + bot_name + "，正身处一场跨次元互动剧场演绎中。\n";
    } else {
        s = "你是 " + bot_name + "，在好友群里闲聊（当前时间：" + time_anchor + "）。\n";
    }
    s += "每次发言写成一条完整消息，用标点自然分句，必要时换段。\n";
    if (!chat_persona.empty()) {
        s += chat_persona + "\n";
    }
    if (in_story) {
        s += "【当前剧场设定 / 剧情开端】\n" + clip_utf8_safe(trim_ws(story_premise), 800) + "\n";
        const auto cast_line = format_story_cast_roster(story_cast);
        if (!cast_line.empty()) {
            s += "【本场选角代入表】" + cast_line + "\n";
        }
        if (self_cast) {
            s += "【你的演出定位】你此刻站在「" + trim_ws(self_cast->role_name) + "」（" +
                 story_cast_tier_label(self_cast->tier) +
                 "）的立场与处境里，但**务必保留你自己（" + bot_name +
                 "）原本的性格灵魂、口癖、情绪反应与脑洞**——用「如果是你处在" +
                 trim_ws(self_cast->role_name) + "的位置上」的方式去演、去选择、甚至改写命运！\n";
        }
        const auto dir = trim_ws(active_directive);
        if (!dir.empty()) {
            s += "【当前世界线 / 剧情走向】" + clip_utf8_safe(dir, 260) + "\n";
        }
        const auto bible = trim_ws(story_extras.story_bible);
        if (!bible.empty()) {
            s += "【前情提要与伏笔账本（请牢记核心设定与线索，自然前后呼应）】\n" + clip_utf8_safe(bible, 900) + "\n";
        }
        const auto secret = trim_ws(story_extras.secret_note);
        if (!secret.empty()) {
            s += "【仅你一人可见的导演密信 / 隐藏底牌（最高机密）】\n" + clip_utf8_safe(secret, 450) +
                 "\n注意：其他角色完全不知道这张密信的存在！严禁直接说“导演告诉我/我收到密信”，请把这份隐情自然融入你的微表情、试探、掩饰、立场倾向或关键反转中！\n";
        }
        const auto dice = trim_ws(story_extras.dice_context);
        if (!dice.empty()) {
            s += "【本幕 TRPG 命运骰子检定结果】" + clip_utf8_safe(dice, 240) +
                 "\n请忠实接住这个骰子结果（大成功就惊艳佩服/顺势高光，大失败就爆笑吐槽/手忙脚乱救场）。\n";
        }
        s += "直接输出你在当前这一幕里的动作与台词（不要加名字前缀，可用全角括号描写动作/神态，如 `（握紧剑柄）`）：\n"
             "- 严格保持你自己的性格和口吻，直接代入当前场景与旁白抛出的事件互动，推动剧情发展。\n"
             "- 简练有画面感（1～3 句），别替旁白写大段结局，也别替别人演台词。\n";
        if (story_extras.inner_voice_enabled) {
            s += "- 【真实心声 OS】请在台词最末尾另起一行附加一句 10～26 字的内心独白，严格使用格式 `[os:你的真实心声]`（展现嘴硬心软、暗中盘算或心虚吐槽；其他角色听不到这句心声）。\n";
        }
    } else {
        s += "直接输出你的发言（不要带名字前缀），保持自己的性格和口吻，别端着客服腔：\n"
             "- 像真朋友在群里聊天一样自由：接梗、吐槽、开脑洞、抛新点子、讲冷笑话都随你；古典/异世界角色可按自己世界观自然接梗。\n"
             "- 遇到不认识的新热梗、黑话或吃不准的实时事实，严禁装懂瞎编；";
        if (web_lookup_enabled) {
            s += "若提供了只读工具 `chat_web_lookup`，遇陌生梗/近期热点/作品细节可静默搜 1 次核实后用人设口语自然接梗（禁止背百科）；查不到就大大方方按人设好奇追问求科普。\n";
        } else {
            s += "若记忆/共享情报里也没有，就大大方方按人设好奇追问求科普。\n";
        }
        s += "- 若看到 `[时间推移：...]`，那是过去的话，优先聊眼下的新话题。\n";
    }
    if (spotlight_mode == "zero") {
        s += "- 【0主角 / 纯观察者模式】：用户只在场外安静看戏、完全不参与本场互动。请只与在场其他角色或旁白互动，**严禁向用户提问、点名用户或把球抛给用户**。\n";
    } else if (spotlight_mode == "lead") {
        s += "- 【主角模式】：用户是全场的绝对核心！你非常在意用户的态度、情绪与存在感，说话天然围着用户转——喜欢向用户搭话、拉用户站队评理、吃醋、护短或偏心（同时保持你原本的傲娇/毒舌/认真性格，绝不变成无脑夸夸机）。\n";
    } else {
        s += "- 【半主角模式】：用户是你非常在意的重要伙伴！聊群聊时绝不能把用户晾在一边——用户刚发话时优先接住用户的情绪和观点；和群友互相接话时也自然惦记着用户，别光顾着自己聊忘了用户。\n";
    }
    if (is_followup && !was_explicitly_mentioned) {
        s += "- 你此刻是接话成员：想插嘴、起哄、补刀或接戏就自然说一句（别把对主角说的「你」错认成自己）；不想插嘴就直接只输出 `[[silent]]`。\n";
    } else if (!was_explicitly_mentioned) {
        s += "- 想聊/想演就自然开口，不想插嘴或没话接就直接只输出 `[[silent]]`。\n";
    }
    if (!reply_target_anchor.empty()) {
        s += "语境参考：" + clip_utf8_safe(trim_ws(reply_target_anchor), 160) + "\n";
    }
    if (cue_user_in && spotlight_mode != "zero") {
        s += "（可选轻提示：可以顺口把球抛给用户，拉用户一起聊、问问用户怎么看或让用户做个决定。）\n";
    }
    if (spark_new_idea && !in_story) {
        s += "（可选轻提示：这个话题聊得差不多了，可以顺势抛个新点子、脑洞或小笑话。）\n";
    }
    if (!length_hint.empty() && !in_story) {
        s += "节奏参考：" + std::string(length_hint) + "\n";
    }
    if (!stale_keywords.empty() && !in_story) {
        std::string kw_list;
        for (std::size_t i = 0; i < stale_keywords.size(); ++i) {
            if (i > 0) kw_list += "、";
            kw_list += "「" + stale_keywords[i] + "」";
        }
        s += "（前面已经提过太多次 " + kw_list + " 了，别再围绕它复读。）\n";
    } else if (anti_repeat_warning && !in_story) {
        s += "（别顺着上一句复读旧词，换个角度说或输出 `[[silent]]`。）\n";
    }
    if (!sticker_prompt.empty() && !in_story) {
        s += sticker_prompt + "\n";
    }
    if (!remembered_context.empty()) {
        s += "背景记忆（仅供参考）：\n" + remembered_context;
    }
    return s;
}

std::string build_story_narrator_prompt(std::string_view story_premise,
                                        std::string_view spotlight_mode,
                                        const std::vector<std::string>& actor_names,
                                        bool is_opening,
                                        std::string_view narrator_bot_name,
                                        std::string_view narrator_persona,
                                        const std::vector<StoryCastEntry>& story_cast,
                                        std::string_view rewrite_directive,
                                        bool request_fork,
                                        int chapter_number,
                                        const StoryNarratorExtras& extras) {
    std::string actors;
    for (std::size_t i = 0; i < actor_names.size(); ++i) {
        if (i > 0) actors += "、";
        actors += actor_names[i];
    }
    std::string s;
    if (!narrator_bot_name.empty()) {
        s = "你是 " + std::string(narrator_bot_name) + "，本场故事演绎的【特邀旁白兼导演（DM）】。\n";
        const auto clean_p = strip_persona_craft_section(narrator_persona);
        if (!clean_p.empty()) s += clean_p + "\n";
        s += "请带着你个人独特的叙事语调担任旁白，负责描写场景、扮演路人/反派 NPC、判定角色行动后果并推动剧情走向。\n";
    } else {
        s = "你是本场互动剧场的【导演兼旁白（DM）】，负责把控故事节奏、描写画面感十足的场景、扮演 NPC/反派、根据在场角色刚才的实际演绎动态调整剧情走向。\n";
    }
    s += "【剧本设定与故事开端】\n" + clip_utf8_safe(trim_ws(story_premise), 1000) + "\n";
    const auto bible = trim_ws(extras.story_bible);
    if (!bible.empty()) {
        s += "【剧情账本与已埋伏笔（必须延续并伺机回收）】\n" + clip_utf8_safe(bible, 1200) + "\n";
    }
    if (!extras.secret_notes.empty()) {
        s += "【幕后导演密信备忘（各角色暗持的底牌，旁白可暗中埋伏笔配合，但严禁替角色直接说破底牌）】\n";
        for (const auto& [bname, note] : extras.secret_notes) {
            const auto tn = trim_ws(note);
            if (!bname.empty() && !tn.empty()) {
                s += "- " + bname + "：" + clip_utf8_safe(tn, 240) + "\n";
            }
        }
    }
    const auto cast_line = format_story_cast_roster(story_cast);
    if (!cast_line.empty()) {
        s += "【本场选角代入表（演员以自身性格演绎对应剧情角色）】" + cast_line + "\n";
        s += "请在描写场景与分发戏份时，同时点明角色身份与演员特色（例如「由艾莉丝出演的雷塞」或直接称呼其角色名），让主角/配角/反派的戏份层次鲜明。\n";
    } else if (!actors.empty()) {
        s += "【在场参演角色】" + actors + "\n";
    }
    if (spotlight_mode == "zero") {
        s += "【0主角 / 纯观众视角】：用户只在台下看戏，不作为角色登场！请只给上述在场角色分发事件、危险、线索或冲突，绝不要把用户写进剧情里。\n";
    } else if (spotlight_mode == "lead") {
        s += "【主角模式】：用户是本场故事的绝对核心主角！关键抉择、危机聚焦与高光戏份请优先抛给用户，同时让在场角色围绕用户协同或争执。\n";
    } else {
        s += "【半主角模式】：用户与在场角色共同身处故事之中，请自然兼顾用户与各位角色的戏份。\n";
    }
    const auto dir = trim_ws(rewrite_directive);
    if (!dir.empty()) {
        s += "【导演命运改写指令（最高优先级，必须忠实执行）】\n" + clip_utf8_safe(dir, 500) +
             "\n请在本幕中**彻底落实上述改写走向**（即便它打破了原著既定悲剧或结局，也要让世界顺着这条新的 IF 线真实演化下去！）。\n";
    }
    const auto dice = trim_ws(extras.dice_context);
    if (!dice.empty()) {
        s += "【TRPG 命运骰子检定结果（最高优先级，必须戏剧化落实）】\n" + clip_utf8_safe(dice, 320) +
             "\n- 若为大成功：让该行动以超乎想象的帅气/奇迹方式奏效并引爆高光收益；\n"
             "- 若为成功：行动顺利达成预期效果；\n"
             "- 若为失利：行动受阻或付出意料之外的小代价；\n"
             "- 若为大失败：演化成既荒诞又合乎情理的史诗级翻车现场，瞬间反转气氛！\n";
    }
    if (extras.emit_stage_cue) {
        s += "【舞台自动调度标签（写在正文最第一行，系统会自动剥离并驱动切景、特效与 BGM）】\n"
             "请严格从以下枚举中选最贴合本幕氛围的组合，在最开头单起一行输出：\n"
             "[[STAGE scene=observatory|classroom|study|cafe mood=daily|tense|battle|warm|night fx=none|rain|shake|flash|petals]]\n";
    }
    const int chap = std::max(1, chapter_number);
    if (extras.is_finale) {
        s += "【当前任务：第 " + std::to_string(chap) +
             " 幕 · 终章收束大结局】请用 180～280 字写出荡气回肠、情感饱满的大结局，回收前面埋下的核心伏笔并交代各方归宿。\n"
             "写完终章旁白后，**必须**另起一行严格按如下格式输出结局结算卡片元数据：\n"
             "[[ENDING]]\n"
             "结局标题：简短有宿命感的结局名称（6～18 字）\n"
             "结局评级：从 True End / Normal End / 混沌 Bad End / 隐藏 Secret End 中选其一\n"
             "结局总评：40～90 字总结本世界线的命运余韵\n"
             "- 角色名：该角色的一句贴合性格的尾声寄语（写出 3～5 位主要参演角色）\n"
             "[[/ENDING]]";
        return s;
    }
    if (is_opening) {
        s += "【当前任务：第 " + std::to_string(chap) +
             " 幕 · 开场发幕】请用 100～180 字拉开帷幕：交代所处场景、氛围与立刻爆发的冲突/钩子，把戏份自然抛给 1～2 位在场角色（不要替在场角色写台词和决定）。\n";
    } else {
        s += "【当前任务：第 " + std::to_string(chap) +
             " 幕 · 承接演绎并推进阶段】仔细阅读刚才角色们（以及用户）的实际动作与台词，**真实采纳他们的选择来改写剧情后果**（例如有人拔剑砍了、有人拆穿谎言了，世界必须做出真实反应！），用 80～160 字推进到下一个转折或关键命运节点，并留出钩子让角色继续演绎。严禁替在场角色代写台词。\n";
    }
    if (request_fork) {
        s += "【关键节点命运分岔格式（仅在需要玩家决定时使用）】\n"
             "日常寒暄、过场、已有明确行动时，只写旁白正文。仅当眼前有不同后果、值得交给玩家决定时，在正文后另起一行按如下格式给出本幕的节点标题与 3 个截然不同、紧扣当前剧情的命运走向（包含「顺势推进线」与两条「命运改写 IF 线」），让玩家点选或自行改写下一幕走向：\n"
             "[[FORK]]\n"
             "节点标题：简短 6～16 字概括本幕核心事件\n"
             "分岔提示：一句话点出此刻的命运抉择\n"
             "- 顺势线：具体贴合当前局势的常规推进走向\n"
             "- 改写线A：具体关键人物乱入或逆转局势的改写走向\n"
             "- 改写线B：脑洞更大或揭晓意外暗线的改写走向\n"
             "[[/FORK]]\n"
             "注意：正文中不要提“选项”二字，保持电影级叙事沉浸感；采用分岔时，请将完整的 `[[FORK]]` 块放在正文末尾，系统会自动解析成可点击的抉择按钮。";
    } else {
        s += "直接输出旁白正文。";
    }
    return s;
}

std::vector<ModelMessage> build_story_bible_distill_messages(std::string_view story_premise,
                                                             std::string_view existing_bible,
                                                             std::string_view recent_transcript,
                                                             int chapter_number) {
    std::string sys =
        "你是互动剧场的【剧情账本书记官】。请把当前故事的核心进展与伏笔增量浓缩为 260～480 字的简体中文剧情账本，供后续所有幕次的旁白与演员精准参考。\n"
        "严格使用以下 4 行结构输出（不要加寒暄或多余解释）：\n"
        "【主线进展】1～2 句交代目前推进到了什么阶段\n"
        "【已揭露线索】用分号列出已经实锤的关键证据/事实\n"
        "【未解伏笔】用分号列出悬而未决的谜团、危机或埋下的钩子\n"
        "【角色状态】简明记录主要角色当前的立场、关系变化或所处位置";
    std::string usr = "【剧本开端】" + clip_utf8_safe(trim_ws(story_premise), 600) +
                      "\n【当前已演至】第 " + std::to_string(std::max(1, chapter_number)) + " 幕\n";
    if (!trim_ws(existing_bible).empty()) {
        usr += "【旧版剧情账本】\n" + clip_utf8_safe(trim_ws(existing_bible), 1200) + "\n";
    }
    usr += "【近期剧场实录】\n" + clip_utf8_safe(trim_ws(recent_transcript), 6500);
    return {{"system", std::move(sys), {}, {}}, {"user", std::move(usr), {}, {}}};
}

StoryNarratorParsed parse_story_narrator_output(std::string_view raw) {
    StoryNarratorParsed out;
    std::string working(raw);

    // 1) Extract and strip optional `[[STAGE scene=... mood=... fx=...]]` director cue
    {
        const std::pair<std::string_view, std::string_view> stage_delims[] = {
            {"[[STAGE", "]]"}, {"[[stage", "]]"}, {"[[Stage", "]]"},
            {"[STAGE", "]"}, {"[stage", "]"}, {"【STAGE", "】"}
        };
        for (const auto& [op, cl] : stage_delims) {
            const auto sp = working.find(op);
            if (sp == std::string::npos) continue;
            const auto ep = working.find(cl, sp + op.size());
            if (ep == std::string::npos || ep - sp > 240) continue;
            const std::string attrs = working.substr(sp + op.size(), ep - (sp + op.size()));
            auto extract_attr = [&](std::string_view key) -> std::string {
                const std::string needle = std::string(key) + "=";
                auto p = attrs.find(needle);
                if (p == std::string::npos) return {};
                p += needle.size();
                while (p < attrs.size() && (attrs[p] == '"' || attrs[p] == '\'' || attrs[p] == ' ')) ++p;
                std::size_t q = p;
                while (q < attrs.size() && attrs[q] != ' ' && attrs[q] != '\t' && attrs[q] != '\r' &&
                       attrs[q] != '\n' && attrs[q] != '"' && attrs[q] != '\'' && attrs[q] != ';' && attrs[q] != ',') {
                    ++q;
                }
                std::string val = attrs.substr(p, q - p);
                for (char& ch : val) {
                    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
                }
                return val;
            };
            const auto sc = extract_attr("scene");
            if (sc == "observatory" || sc == "classroom" || sc == "study" || sc == "cafe") out.stage_cue.scene = sc;
            const auto md = extract_attr("mood");
            if (md == "daily" || md == "tense" || md == "battle" || md == "warm" || md == "night") out.stage_cue.mood = md;
            const auto fx = extract_attr("fx");
            if (fx == "none" || fx == "rain" || fx == "shake" || fx == "flash" || fx == "petals") out.stage_cue.fx = fx;
            working.erase(sp, (ep + cl.size()) - sp);
            break;
        }
    }

    auto strip_kv = [](std::string_view line, std::string_view key) -> std::optional<std::string> {
        if (!line.starts_with(key)) return std::nullopt;
        std::string_view rest = line.substr(key.size());
        if (rest.starts_with("：")) rest = rest.substr(3);
        else if (rest.starts_with(":")) rest = rest.substr(1);
        else return std::nullopt;
        return trim_ws(rest);
    };

    // 2) Extract and strip optional `[[ENDING]]...[[/ENDING]]` finale card
    {
        std::size_t e_open = std::string::npos;
        std::size_t e_open_len = 0;
        const std::string_view end_opens[] = {
            "[[ENDING]]", "[[ending]]", "[ENDING]", "[ending]", "【ENDING】", "【终章结局】"
        };
        for (const auto tag : end_opens) {
            const auto p = working.find(tag);
            if (p != std::string::npos && (e_open == std::string::npos || p < e_open)) {
                e_open = p;
                e_open_len = tag.size();
            }
        }
        if (e_open != std::string::npos) {
            std::string_view tail = std::string_view(working).substr(e_open + e_open_len);
            std::size_t e_close = std::string_view::npos;
            std::size_t e_close_len = 0;
            const std::string_view end_closes[] = {
                "[[/ENDING]]", "[[/ending]]", "[/ENDING]", "[/ending]", "【/ENDING】", "【/终章结局】"
            };
            for (const auto tag : end_closes) {
                const auto p = tail.find(tag);
                if (p != std::string_view::npos && (e_close == std::string_view::npos || p < e_close)) {
                    e_close = p;
                    e_close_len = tag.size();
                }
            }
            const std::string_view eblock = (e_close == std::string_view::npos) ? tail : tail.substr(0, e_close);
            out.ending.has_ending = true;
            std::size_t epos = 0;
            while (epos < eblock.size()) {
                const auto nl = eblock.find('\n', epos);
                const auto rl = (nl == std::string_view::npos) ? eblock.substr(epos) : eblock.substr(epos, nl - epos);
                epos = (nl == std::string_view::npos) ? eblock.size() : (nl + 1);
                const auto line = trim_ws(rl);
                if (line.empty() || line == "```") continue;
                if (auto v = strip_kv(line, "结局标题")) { out.ending.title = clip_utf8_safe(*v, 72); continue; }
                if (auto v = strip_kv(line, "结局评级")) { out.ending.rank = clip_utf8_safe(*v, 48); continue; }
                if (auto v = strip_kv(line, "结局类型")) { if (out.ending.rank.empty()) out.ending.rank = clip_utf8_safe(*v, 48); continue; }
                if (auto v = strip_kv(line, "结局总评")) { out.ending.summary = clip_utf8_safe(*v, 360); continue; }
                if (auto v = strip_kv(line, "总评")) { if (out.ending.summary.empty()) out.ending.summary = clip_utf8_safe(*v, 360); continue; }
                std::string_view item = line;
                if (item.starts_with("- ") || item.starts_with("* ")) item = item.substr(2);
                else if (item.starts_with("• ")) item = item.substr(4);
                else if (item.starts_with("-") || item.starts_with("*")) item = item.substr(1);
                const auto clean_ep = trim_ws(item);
                if (clean_ep.empty()) continue;
                std::size_t sep = clean_ep.find("：");
                std::size_t sep_len = 3;
                if (sep == std::string::npos) { sep = clean_ep.find(':'); sep_len = 1; }
                if (sep != std::string::npos && sep > 0 && sep < 40 && out.ending.epilogues.size() < 8) {
                    const auto spk = trim_ws(std::string_view(clean_ep).substr(0, sep));
                    const auto txt = trim_ws(std::string_view(clean_ep).substr(sep + sep_len));
                    if (!spk.empty() && !txt.empty()) {
                        out.ending.epilogues.push_back({clip_utf8_safe(spk, 36), clip_utf8_safe(txt, 220)});
                    }
                }
            }
            const std::size_t erase_end = (e_close == std::string_view::npos)
                ? working.size()
                : (e_open + e_open_len + e_close + e_close_len);
            working.erase(e_open, erase_end - e_open);
            // Strip any stray code fences left around [[ENDING]]
            while (true) {
                auto t = trim_ws(working);
                if (t.ends_with("```")) { t.resize(t.size() - 3); working = std::move(t); continue; }
                break;
            }
        }
    }

    std::string_view src(working);
    std::size_t open_pos = std::string_view::npos;
    std::size_t open_len = 0;
    const std::string_view open_tags[] = {
        "[[FORK]]", "[[fork]]", "[[Fork]]", "[FORK]", "[fork]", "【FORK】", "【命运分岔】"
    };
    for (const auto tag : open_tags) {
        const auto p = src.find(tag);
        if (p != std::string_view::npos && (open_pos == std::string_view::npos || p < open_pos)) {
            open_pos = p;
            open_len = tag.size();
        }
    }
    if (open_pos == std::string_view::npos) {
        out.narration = trim_ws(src);
        return out;
    }
    std::string_view head = src.substr(0, open_pos);
    // Strip trailing markdown code fence if the model wrapped [[FORK]] in ```...```
    auto head_trimmed = trim_ws(head);
    while (head_trimmed.ends_with("```")) {
        head_trimmed.resize(head_trimmed.size() - 3);
        head_trimmed = trim_ws(head_trimmed);
    }
    out.narration = std::move(head_trimmed);
    std::string_view block = src.substr(open_pos + open_len);
    std::size_t close_pos = std::string_view::npos;
    std::size_t close_len = 0;
    const std::string_view close_tags[] = {
        "[[/FORK]]", "[[/fork]]", "[[/Fork]]", "[/FORK]", "[/fork]", "【/FORK】", "【/命运分岔】"
    };
    for (const auto tag : close_tags) {
        const auto p = block.find(tag);
        if (p != std::string_view::npos && (close_pos == std::string_view::npos || p < close_pos)) {
            close_pos = p;
            close_len = tag.size();
        }
    }
    if (close_pos != std::string_view::npos) {
        auto trailing = trim_ws(block.substr(close_pos + close_len));
        while (trailing.starts_with("```")) {
            trailing.erase(0, 3);
            trailing = trim_ws(trailing);
        }
        if (!trailing.empty() && out.narration.empty()) {
            out.narration = trailing;
        }
        block = block.substr(0, close_pos);
    }

    std::size_t pos = 0;
    const char choice_ids[] = {'A', 'B', 'C', 'D'};
    while (pos < block.size()) {
        const auto nl = block.find('\n', pos);
        const auto raw_line = (nl == std::string_view::npos) ? block.substr(pos) : block.substr(pos, nl - pos);
        pos = (nl == std::string_view::npos) ? block.size() : (nl + 1);
        const auto line = trim_ws(raw_line);
        if (line.empty() || line == "```") continue;

        if (auto v = strip_kv(line, "节点标题")) {
            out.node_title = clip_utf8_safe(*v, 48);
            continue;
        }
        if (auto v = strip_kv(line, "标题")) {
            if (out.node_title.empty()) out.node_title = clip_utf8_safe(*v, 48);
            continue;
        }
        if (auto v = strip_kv(line, "分岔提示")) {
            out.fork_prompt = clip_utf8_safe(*v, 140);
            continue;
        }
        if (auto v = strip_kv(line, "提示")) {
            if (out.fork_prompt.empty()) out.fork_prompt = clip_utf8_safe(*v, 140);
            continue;
        }

        std::string_view item = line;
        bool is_choice = false;
        if (item.starts_with("- ") || item.starts_with("* ")) {
            item = item.substr(2);
            is_choice = true;
        } else if (item.starts_with("• ")) {
            item = item.substr(4);
            is_choice = true;
        } else if (item.starts_with("-") || item.starts_with("*")) {
            item = item.substr(1);
            is_choice = true;
        } else if (item.size() >= 3 &&
                   ((item[0] >= '1' && item[0] <= '4') || (item[0] >= 'A' && item[0] <= 'D') ||
                    (item[0] >= 'a' && item[0] <= 'd')) &&
                   (item[1] == '.' || item[1] == ')' || item[1] == ':')) {
            item = item.substr(2);
            is_choice = true;
        } else if (item.size() >= 4 &&
                   ((item[0] >= '1' && item[0] <= '4') || (item[0] >= 'A' && item[0] <= 'D')) &&
                   (item.substr(1, 3) == "、" || item.substr(1, 3) == "：" || item.substr(1, 3) == "）")) {
            item = item.substr(4);
            is_choice = true;
        } else if (item.starts_with("选项一") || item.starts_with("选项二") || item.starts_with("选项三") ||
                   item.starts_with("选项四") || item.starts_with("选项1") || item.starts_with("选项2") ||
                   item.starts_with("选项3") || item.starts_with("选项4") || item.starts_with("选项A") ||
                   item.starts_with("选项B") || item.starts_with("选项C") || item.starts_with("选项D")) {
            is_choice = true;
        }

        if (is_choice && out.choices.size() < 4) {
            const auto clean_item = clip_utf8_safe(trim_ws(item), 300);
            if (!clean_item.empty()) {
                out.choices.push_back({std::string(1, choice_ids[out.choices.size()]), clean_item});
            }
        }
    }
    return out;
}

std::string format_time_gap_divider(std::int64_t prev_ms, std::int64_t cur_ms, int threshold_minutes) {
    if (prev_ms <= 0 || cur_ms <= prev_ms) return {};
    const std::int64_t diff_ms = cur_ms - prev_ms;
    const std::int64_t threshold_ms = static_cast<std::int64_t>(std::max(1, threshold_minutes)) * 60LL * 1000LL;

    const std::time_t prev_tt = static_cast<std::time_t>(prev_ms / 1000);
    const std::time_t cur_tt = static_cast<std::time_t>(cur_ms / 1000);
    std::tm prev_tm{}, cur_tm{};
#ifdef _WIN32
    localtime_s(&prev_tm, &prev_tt);
    localtime_s(&cur_tm, &cur_tt);
#else
    localtime_r(&prev_tt, &prev_tm);
    localtime_r(&cur_tt, &cur_tm);
#endif
    const bool crossed_day = (prev_tm.tm_year != cur_tm.tm_year || prev_tm.tm_yday != cur_tm.tm_yday);
    if (!crossed_day && diff_ms < threshold_ms) return {};

    char cur_clock[16]{};
    std::snprintf(cur_clock, sizeof(cur_clock), "%02d:%02d", cur_tm.tm_hour, cur_tm.tm_min);
    const long long mins = std::max(1LL, static_cast<long long>((diff_ms + 30000LL) / 60000LL));
    if (crossed_day) {
        const long long hours = std::max(1LL, static_cast<long long>((diff_ms + 1800000LL) / 3600000LL));
        return "[时间推移：已跨天，距上一轮约 " + std::to_string(hours) +
               " 小时，以下为新时段（" + std::string(cur_clock) + "）的对话，请优先回应当前最新话题，不要生硬续接过时旧话题]";
    }
    if (mins >= 90) {
        const long long hours = std::max(1LL, static_cast<long long>((diff_ms + 1800000LL) / 3600000LL));
        return "[时间推移：距上一轮已隔约 " + std::to_string(hours) +
               " 小时，以下为新时段（" + std::string(cur_clock) + "）的对话，请优先回应当前最新话题]";
    }
    return "[时间推移：距上一轮已隔约 " + std::to_string(mins) +
           " 分钟，以下为新时段（" + std::string(cur_clock) + "）的对话，请优先回应当前最新话题]";
}

namespace {

std::vector<std::string> extract_utf8_chars(std::string_view text) {
    std::vector<std::string> chars;
    std::size_t i = 0;
    while (i < text.size()) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        std::size_t len = 1;
        if ((c & 0xE0U) == 0xC0U) len = 2;
        else if ((c & 0xF0U) == 0xE0U) len = 3;
        else if ((c & 0xF8U) == 0xF0U) len = 4;
        if (i + len > text.size()) break;
        if (len >= 3) {
            // Keep CJK / non-ASCII semantic characters, filter common Chinese punctuation
            const std::string_view ch = text.substr(i, len);
            static const std::set<std::string_view> kPunct{
                "，", "。", "！", "？", "、", "：", "；", "“", "”", "‘", "’",
                "（", "）", "《", "》", "—", "…", "～", "·", "【", "】", "　"
            };
            if (!kPunct.contains(ch)) chars.emplace_back(ch);
        }
        i += len;
    }
    return chars;
}

std::set<std::string> extract_chinese_bigrams(std::string_view text) {
    const auto chars = extract_utf8_chars(text);
    static const std::set<std::string_view> kStop{
        "的", "了", "呢", "吧", "啊", "嘛", "呀", "哦", "嗯", "哈",
        "我", "你", "他", "她", "们", "这", "那", "是", "就", "都", "也", "还", "在", "有", "不", "没"
    };
    std::set<std::string> bigrams;
    for (std::size_t i = 0; i + 1 < chars.size(); ++i) {
        if (kStop.contains(chars[i]) && kStop.contains(chars[i + 1])) continue;
        bigrams.insert(chars[i] + chars[i + 1]);
    }
    return bigrams;
}

std::uint64_t splitmix64(std::uint64_t x) {
    x += 0x9e3779b97f4a7c15ULL;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

} // namespace

int infer_talkativeness_baseline(std::string_view persona) {
    static constexpr std::string_view kHigh[] = {
        "火爆", "外向", "直爽", "直来直去", "话多", "活泼", "元气", "毒舌", "吐槽", "好胜", "开朗", "爱聊", "傲娇", "热情", "急性子"
    };
    static constexpr std::string_view kLow[] = {
        "内向", "寡言", "少言", "话不多", "安静", "害羞", "淡漠", "冷淡", "克制", "面无表情", "沉默", "语调平淡", "稀薄"
    };
    int hi = 0, lo = 0;
    for (const auto k : kHigh) if (persona.find(k) != std::string_view::npos) ++hi;
    for (const auto k : kLow) if (persona.find(k) != std::string_view::npos) ++lo;
    if (hi > lo) return 24 + std::min(hi, 2); // 25..26
    if (lo > hi) return 10 - std::min(lo, 2); // 8..9
    return 16;
}

int topic_resonance_score(std::string_view text, std::string_view persona) {
    if (text.empty() || persona.empty()) return 0;
    int score = 0;
    const auto text_bg = extract_chinese_bigrams(text);
    const auto persona_bg = extract_chinese_bigrams(persona);
    int direct_hits = 0;
    for (const auto& bg : text_bg) {
        if (persona_bg.contains(bg)) ++direct_hits;
    }
    score += std::min(direct_hits * 6, 15);

    // Lightweight Chinese semantic clusters so "午饭/咖喱" matches "吃饭/米饭/做菜"
    static const std::vector<std::vector<std::string_view>> kClusters = {
        {"吃", "饭", "午饭", "晚饭", "早饭", "咖喱", "做菜", "料理", "厨", "饿", "米饭", "炖", "甜点", "茶", "咖啡"},
        {"剑", "刀", "打架", "切磋", "战斗", "变强", "训练", "骑士", "魔法", "魔术", "决斗", "赢", "输"},
        {"信", "写信", "文字", "书", "文学", "读", "学习", "功课", "作业", "笔记", "成绩"},
        {"工作", "代码", "程序", "项目", "电脑", "bug", "写完", "加班", "辛苦", "休息", "断电", "宿舍"},
        {"喜欢", "心意", "约会", "开心", "难过", "生气", "道歉", "陪", "晚安", "早安", "晚上好", "中午好"}
    };
    for (const auto& cluster : kClusters) {
        bool in_text = false, in_persona = false;
        for (const auto kw : cluster) {
            if (!in_text && text.find(kw) != std::string_view::npos) in_text = true;
            if (!in_persona && persona.find(kw) != std::string_view::npos) in_persona = true;
            if (in_text && in_persona) break;
        }
        if (in_text && in_persona) score += 10;
    }
    return std::min(score, 25);
}

double chinese_bigram_overlap(std::string_view a, std::string_view b) {
    const auto sa = extract_chinese_bigrams(a);
    const auto sb = extract_chinese_bigrams(b);
    if (sa.empty() || sb.empty()) return 0.0;
    std::size_t inter = 0;
    for (const auto& bg : sa) {
        if (sb.contains(bg)) ++inter;
    }
    const std::size_t uni = sa.size() + sb.size() - inter;
    return uni > 0 ? static_cast<double>(inter) / static_cast<double>(uni) : 0.0;
}

bool matches_bot_name(std::string_view text, std::string_view full_name) {
    if (text.empty() || full_name.empty()) return false;
    if (text.find(full_name) != std::string_view::npos) return true;

    // Match pre-separator given name: e.g. "艾莉丝·格雷拉特" -> "艾莉丝", "爱丽丝／..." -> "爱丽丝"
    static constexpr std::string_view kSeps[] = {"·", "・", "／", "/", " "};
    for (const auto sep : kSeps) {
        const auto pos = full_name.find(sep);
        if (pos != std::string_view::npos) {
            const auto first = trim_ws(full_name.substr(0, pos));
            if (approx_char_count(first) >= 2 && text.find(first) != std::string_view::npos) {
                return true;
            }
        }
    }

    // Match 2-char Japanese given-name suffix for 4-char full names: e.g. "中野三玖" -> "三玖"
    const auto chars = extract_utf8_chars(full_name);
    if (chars.size() == 4) {
        const std::string given2 = chars[2] + chars[3];
        if (text.find(given2) != std::string_view::npos) return true;
    }
    return false;
}

std::vector<std::string> detect_stale_group_keywords(const std::vector<std::string>& recent_bot_texts,
                                                     std::string_view latest_user_text) {
    if (recent_bot_texts.size() < 3) return {};
    const std::size_t window = std::min<std::size_t>(recent_bot_texts.size(), 8U);
    const std::size_t start = recent_bot_texts.size() - window;

    std::map<std::string, int> doc_freq;
    for (std::size_t i = start; i < recent_bot_texts.size(); ++i) {
        const auto bgs = extract_chinese_bigrams(recent_bot_texts[i]);
        for (const auto& bg : bgs) {
            ++doc_freq[bg];
        }
    }

    // Ignore harmless greeting/filler bigrams
    static const std::set<std::string_view> kAllow{
        "晚上", "上好", "中午", "午好", "早上", "早安", "晚安", "午安", "辛苦", "大家",
        "什么", "怎么", "不是", "没有", "可以", "还是", "觉得", "现在", "知道", "记得",
        "说话", "东西", "时候", "不过", "虽然", "如果", "就是", "这样", "那样", "一点"
    };

    std::vector<std::pair<int, std::string>> hits;
    for (const auto& [bg, cnt] : doc_freq) {
        if (cnt < 3) continue;
        if (kAllow.contains(bg)) continue;
        if (latest_user_text.find(bg) != std::string_view::npos) continue;
        hits.push_back({cnt, bg});
    }
    std::sort(hits.begin(), hits.end(), [](const auto& a, const auto& b) {
        return a.first > b.first;
    });

    std::vector<std::string> out;
    for (const auto& [cnt, bg] : hits) {
        out.push_back(bg);
        if (out.size() >= 3) break;
    }
    return out;
}

std::string roll_group_length_hint(int baseline,
                                   bool is_question,
                                   bool prev_was_long,
                                   bool two_prev_long,
                                   std::uint64_t seed) {
    if (two_prev_long) {
        return "前面连续两句都偏长，你这句必须简短利落（6～18字，一句带过）。";
    }
    const int roll = static_cast<int>(splitmix64(seed) % 100ULL);
    int short_word_p = (baseline >= 22) ? 18 : (baseline <= 11 ? 26 : 15);
    int one_line_p = 50;
    if (is_question) {
        short_word_p = 0; // Never answer a question with a single word
        one_line_p = 55;
    } else if (prev_was_long) {
        short_word_p += 15;
        one_line_p += 15;
    }
    if (roll < short_word_p) {
        return "极短反应（4～12字，像真人群聊里随口甩出的短反应或吐槽）。";
    }
    if (roll < short_word_p + one_line_p) {
        return "简短一句（10～28字，自然口语，点到为止）。";
    }
    return "自然短段（25～50字，最多2句，带出你的性格或新角度）。";
}

std::optional<GroupDesireDecision> pick_next_group_speaker(
    const std::vector<GroupDesireMember>& members,
    std::string_view trigger_text,
    bool is_broadcast,
    const std::set<std::string>& already_spoke_this_turn,
    std::uint64_t seed,
    const GroupDesireConfig& cfg) {
    struct Scored {
        std::string id;
        std::string name;
        int score = 0;
        int baseline = 16;
        bool forced = false;
    };
    std::vector<Scored> cands;
    cands.reserve(members.size());

    std::string log_parts;
    for (std::size_t i = 0; i < members.size(); ++i) {
        const auto& m = members[i];
        if (m.id.empty() || already_spoke_this_turn.contains(m.id)) continue;

        const int base = infer_talkativeness_baseline(m.persona);
        const int silence_bonus = std::min(std::max(0, m.turns_since_last_spoke) * cfg.silence_step, cfg.silence_cap);
        const int topic_bonus = topic_resonance_score(trigger_text, m.persona);
        const int mention_bonus = (m.mentioned_by_user ? cfg.user_mention_bonus : 0) +
                                  (m.mentioned_by_peer ? cfg.peer_mention_bonus : 0) +
                                  (m.active_dyad_partner ? 50 : 0);
        const int bcast = is_broadcast ? cfg.broadcast_bonus : 0;
        const int just_spoke = (!m.active_dyad_partner && m.turns_since_last_spoke == 0) ? cfg.just_spoke_penalty : 0;
        const int consec = (!m.active_dyad_partner && m.consecutive_turns >= 2) ? cfg.consecutive_penalty * (m.consecutive_turns - 1) : 0;
        const int jitter = (cfg.random_jitter_max > 0)
            ? static_cast<int>(splitmix64(seed ^ (static_cast<std::uint64_t>(i + 1) * 0x9e3779b9ULL)) %
                               static_cast<std::uint64_t>(cfg.random_jitter_max + 1))
            : 0;

        const int total = base + silence_bonus + topic_bonus + mention_bonus + bcast - just_spoke - consec + jitter;
        if (!log_parts.empty()) log_parts += ", ";
        log_parts += m.name + "=" + std::to_string(total);
        const bool must_answer = m.mentioned_by_user || m.active_dyad_partner;
        if (must_answer || m.mentioned_by_peer || total >= cfg.speak_threshold) {
            cands.push_back({m.id, m.name, total, base, must_answer});
        }
    }
    if (cands.empty()) return std::nullopt;

    std::sort(cands.begin(), cands.end(), [](const Scored& a, const Scored& b) {
        if (a.forced != b.forced) return a.forced > b.forced;
        return a.score > b.score;
    });

    // If someone was explicitly called by user, always pick them first.
    if (cands[0].forced || cands.size() == 1) {
        return GroupDesireDecision{cands[0].id, cands[0].score, cands[0].baseline,
                                   "picked=" + cands[0].name + " (" + log_parts + ")"};
    }

    // Top-2 weighted random sampling so it never feels like a rigid fixed queue.
    const int w0 = std::max(1, cands[0].score);
    const int w1 = std::max(1, cands[1].score);
    const int pick_roll = static_cast<int>(splitmix64(seed ^ 0x517cc1b727220a95ULL) % static_cast<std::uint64_t>(w0 + w1));
    const auto& chosen = (pick_roll < w0) ? cands[0] : cands[1];
    return GroupDesireDecision{chosen.id, chosen.score, chosen.baseline,
                               "picked=" + chosen.name + " (" + log_parts + ")"};
}

std::vector<ModelMessage> build_group_pov_messages(const std::string& self_bot_id,
                                                   const std::string& system_prompt,
                                                   const std::vector<GroupChatTurnItem>& history) {
    std::vector<ModelMessage> messages;
    messages.push_back({"system", system_prompt, {}, {}});

    std::string pending_others;
    auto flush_others = [&]() {
        if (!pending_others.empty()) {
            messages.push_back({"user", std::move(pending_others), {}, {}});
            pending_others.clear();
        }
    };

    std::int64_t prev_ts = 0;
    for (const auto& item : history) {
        const std::string clean = trim_ws(item.text);
        if (clean.empty()) continue;

        if (prev_ts > 0 && item.created_at_ms > 0) {
            const auto divider = format_time_gap_divider(prev_ts, item.created_at_ms, 30);
            if (!divider.empty()) {
                if (!pending_others.empty()) pending_others += "\n";
                pending_others += divider;
            }
        }
        if (item.created_at_ms > 0) prev_ts = item.created_at_ms;

        if (item.actor == "bot" && item.bot_id == self_bot_id) {
            flush_others();
            messages.push_back({"assistant", clean, {}, {}});
        } else {
            std::string prefix = "[用户]: ";
            if (item.actor == "system") {
                prefix = "[系统参考资料]: ";
            } else if (item.actor == "bot") {
                prefix = "[群友 " + (item.speaker_name.empty() ? item.bot_id : item.speaker_name) + "]: ";
            }
            if (!pending_others.empty()) pending_others += "\n";
            pending_others += prefix + clean;
        }
    }
    flush_others();
    if (messages.size() == 1) {
        messages.push_back({"user", "[用户]: （进入群聊）", {}, {}});
    } else if (messages.back().role == "assistant") {
        // Ensure final message before generation is `user` for strict chat-completion providers.
        messages.push_back({"user", "（请结合群聊最新进展决定是否补充一句，无需补充则输出 [[silent]]）", {}, {}});
    }
    return messages;
}

std::string strip_speaker_prefix(std::string_view text, std::string_view bot_name) {
    std::string s = trim_ws(text);
    if (s.empty() || bot_name.empty()) return s;

    const std::string p1 = std::string(bot_name) + ":";
    const std::string p2 = std::string(bot_name) + "：";
    const std::string p3 = "[" + std::string(bot_name) + "]:";
    const std::string p4 = "[" + std::string(bot_name) + "]：";
    const std::string p5 = "[群友 " + std::string(bot_name) + "]:";
    const std::string p6 = "[群友 " + std::string(bot_name) + "]：";

    for (const auto& pref : {p5, p6, p3, p4, p1, p2}) {
        if (s.starts_with(pref)) {
            return trim_ws(std::string_view(s).substr(pref.size()));
        }
    }
    return s;
}

std::vector<ModelMessage> build_group_director_messages(const std::vector<GroupMemberBrief>& roster,
                                                        std::string_view latest_user_text,
                                                        std::string_view recent_transcript) {
    std::string sys =
        "你是群聊节奏导播。根据用户刚发的话与最近群聊语境，从群成员中挑出本轮最自然应该开口的 1 到 2 人（其余人潜水，避免全员轮流啰嗦表态）。\n"
        "挑选原则：\n"
        "1. 话题明显对口某人专长/兴趣，或某人刚和用户聊在兴头上，优先选他。\n"
        "2. 若话题适合两人一唱一和或互怼吐槽，选性格反差或最对口的 2 人（按先后开口顺序排列）；普通随口一问选 1 人即可。\n"
        "3. 只输出 JSON 数组格式的成员 ID，例如 `[\"bot-a\",\"bot-b\"]`，严禁输出任何解释文字。\n"
        "群成员列表：\n";
    for (const auto& m : roster) {
        sys += "- ID: `" + m.id + "` | 名字: " + m.name;
        if (m.spoke_recently) sys += " (刚才刚发过言)";
        if (!m.persona_excerpt.empty()) sys += " | 人设摘要: " + clip_utf8_safe(trim_ws(m.persona_excerpt), 140);
        sys += "\n";
    }

    std::string usr;
    if (!recent_transcript.empty()) {
        usr += "最近几句群聊：\n" + clip_utf8_safe(recent_transcript, 900) + "\n\n";
    }
    usr += "用户最新发言：\n" + clip_utf8_safe(latest_user_text, 600);
    return {
        {"system", std::move(sys), {}, {}},
        {"user", std::move(usr), {}, {}}
    };
}

std::vector<std::string> parse_group_director_picks(std::string_view raw_output,
                                                    const std::vector<GroupMemberBrief>& roster,
                                                    std::string_view latest_user_text,
                                                    std::size_t max_pick) {
    if (roster.empty() || max_pick == 0) return {};
    std::set<std::string> valid_ids;
    for (const auto& m : roster) valid_ids.insert(m.id);

    std::vector<std::string> picked;
    auto try_add = [&](const std::string& id) {
        if (valid_ids.contains(id) && std::find(picked.begin(), picked.end(), id) == picked.end()) {
            picked.push_back(id);
        }
    };

    // Try JSON array parse first (even if wrapped in markdown code fences).
    const auto lb = raw_output.find('[');
    const auto rb = raw_output.rfind(']');
    if (lb != std::string_view::npos && rb != std::string_view::npos && rb > lb) {
        try {
            const auto parsed = Json::parse(std::string(raw_output.substr(lb, rb - lb + 1)));
            if (parsed.is_array()) {
                for (const auto& item : parsed.as_array()) {
                    if (item.is_string()) try_add(item.as_string());
                    if (picked.size() >= max_pick) break;
                }
            }
        } catch (...) {}
    }

    // Substring scan fallback if model wrote bare IDs or names.
    if (picked.empty()) {
        for (const auto& m : roster) {
            if ((!m.id.empty() && raw_output.find(m.id) != std::string_view::npos) ||
                (!m.name.empty() && raw_output.find(m.name) != std::string_view::npos)) {
                try_add(m.id);
                if (picked.size() >= max_pick) break;
            }
        }
    }

    // Deterministic rotation fallback (never fails even if director call failed).
    if (picked.empty()) {
        // Prefer someone mentioned by name without `@`, or rotate based on hash of user text.
        for (const auto& m : roster) {
            if (!m.name.empty() && latest_user_text.find(m.name) != std::string_view::npos) {
                try_add(m.id);
                if (picked.size() >= max_pick) break;
            }
        }
    }
    if (picked.empty()) {
        std::size_t h = 1469598103934665603ULL;
        for (unsigned char c : latest_user_text) h = (h ^ c) * 1099511628211ULL;
        const std::size_t first = h % roster.size();
        try_add(roster[first].id);
        if (roster.size() >= 2 && max_pick >= 2 && (approx_char_count(latest_user_text) >= 10 || (h & 1ULL))) {
            try_add(roster[(first + 1) % roster.size()].id);
        }
    }
    return picked;
}

} // namespace dimension
