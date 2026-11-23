#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/living_memory.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/relation_notes.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

constexpr std::int64_t kMinuteMs = 60LL * 1000LL;
constexpr std::int64_t kHourMs   = 60LL * kMinuteMs;
constexpr std::int64_t kDayMs    = 24LL * kHourMs;
constexpr double kLn2            = 0.6931471805599453;

std::int64_t clock_now_ms(std::optional<std::int64_t> override_ms = {}) {
    if (override_ms.has_value()) return *override_ms;
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::wstring ext_path(const fs::path& p) {
    auto w = fs::absolute(p).lexically_normal().wstring();
    if (w.starts_with(L"\\\\?\\")) return w;
    if (w.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + w.substr(2);
    return L"\\\\?\\" + w;
}

fs::path from_utf8_path(std::string_view s) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

std::string safe_bot_filename(std::string_view bot_id) {
    std::string out;
    out.reserve(bot_id.size() + 8);
    for (unsigned char c : bot_id) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_') {
            out.push_back(static_cast<char>(c));
        } else {
            char hex[4]{};
            std::snprintf(hex, sizeof(hex), "_%02x", static_cast<unsigned>(c));
            out += hex;
        }
    }
    if (out.empty()) out = "default";
    return out + ".json";
}

std::size_t utf8_char_width(std::string_view s, std::size_t i) {
    const unsigned char b = static_cast<unsigned char>(s[i]);
    if (b < 0x80U) return 1;
    if ((b & 0xE0U) == 0xC0U) return std::min<std::size_t>(2, s.size() - i);
    if ((b & 0xF0U) == 0xE0U) return std::min<std::size_t>(3, s.size() - i);
    return std::min<std::size_t>(4, s.size() - i);
}

std::size_t codepoint_count(std::string_view s) {
    std::size_t n = 0;
    for (std::size_t i = 0; i < s.size(); i += utf8_char_width(s, i)) ++n;
    return n;
}

std::string clip_codepoints(std::string_view s, std::size_t max_cp) {
    std::size_t cp = 0;
    std::size_t i = 0;
    while (i < s.size() && cp < max_cp) {
        i += utf8_char_width(s, i);
        ++cp;
    }
    std::string out(s.substr(0, i));
    if (i < s.size()) out += "…";
    return out;
}

std::string trim_str(std::string_view s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\r' || s.front() == '\n'))
        s.remove_prefix(1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n'))
        s.remove_suffix(1);
    return std::string(s);
}

std::string lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string jstr(const Json& j, std::string_view k, std::string def = {}) {
    const auto* p = j.find(k);
    return p && p->is_string() ? p->as_string() : def;
}

double jnum(const Json& j, std::string_view k, double def = 0.0) {
    const auto* p = j.find(k);
    return p && p->is_number() ? p->as_number() : def;
}

bool has_any_substr(std::string_view text, std::initializer_list<std::string_view> needles) {
    for (auto w : needles) {
        if (!w.empty() && text.find(w) != std::string_view::npos) return true;
    }
    return false;
}

bool is_cjk_codepoint(std::uint32_t cp) {
    return (cp >= 0x4E00U && cp <= 0x9FFFU) ||
           (cp >= 0x3400U && cp <= 0x4DBFU) ||
           (cp >= 0x3040U && cp <= 0x30FFU);
}

std::uint32_t decode_utf8_at(std::string_view s, std::size_t i, std::size_t& width) {
    const unsigned char b0 = static_cast<unsigned char>(s[i]);
    if (b0 < 0x80U) { width = 1; return b0; }
    if ((b0 & 0xE0U) == 0xC0U && i + 1 < s.size()) {
        width = 2;
        return ((b0 & 0x1FU) << 6) | (static_cast<unsigned char>(s[i + 1]) & 0x3FU);
    }
    if ((b0 & 0xF0U) == 0xE0U && i + 2 < s.size()) {
        width = 3;
        return ((b0 & 0x0FU) << 12) |
               ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 6) |
               (static_cast<unsigned char>(s[i + 2]) & 0x3FU);
    }
    if ((b0 & 0xF8U) == 0xF0U && i + 3 < s.size()) {
        width = 4;
        return ((b0 & 0x07U) << 18) |
               ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 12) |
               ((static_cast<unsigned char>(s[i + 2]) & 0x3FU) << 6) |
               (static_cast<unsigned char>(s[i + 3]) & 0x3FU);
    }
    width = 1;
    return b0;
}

bool is_stop_cjk_bigram(std::string_view bg) {
    static const std::set<std::string_view> kStops{
        "我是", "我的", "我们", "你是", "你的", "可以", "什么", "怎么", "这个", "那个",
        "一个", "一下", "已经", "现在", "今天", "如果", "因为", "所以", "但是", "或者",
        "觉得", "感觉", "知道", "没有", "不是", "需要", "帮我", "请问", "告诉", "记得"
    };
    return kStops.contains(bg);
}

// Curated daily-life & technical semantic concept clusters for synonym/hypernym bridging
const std::vector<std::vector<std::string_view>>& semantic_clusters() {
    static const std::vector<std::vector<std::string_view>> kClusters = {
        {"海鲜", "刺身", "日料", "寿司", "鱼生", "虾", "螃蟹", "大闸蟹", "生蚝", "扇贝", "贝类", "海产", "三文鱼", "金枪鱼"},
        {"过敏", "忌口", "不能吃", "不吃", "起疹子", "肠胃不适", "乳糖不耐", "忌辛辣", "忌生冷"},
        {"咖啡", "冰美式", "美式", "拿铁", "浓缩", "手冲", "卡布奇诺", "摩卡", "提神", "犯困", "困了", "熬夜提神", "饮品", "饮料"},
        {"茶", "绿茶", "乌龙茶", "红茶", "普洱", "茉莉花茶", "奶茶", "果茶", "抹茶", "泡茶", "饮品", "饮料"},
        {"烤肉", "烧烤", "火锅", "川菜", "湘菜", "粤菜", "西餐", "牛排", "夜宵", "晚餐", "晚饭", "聚餐", "吃什么"},
        {"猫", "猫咪", "小猫", "喵星人", "铲屎", "猫粮", "猫砂", "撸猫", "布偶", "橘猫", "英短", "宠物"},
        {"狗", "小狗", "狗狗", "汪星人", "遛狗", "狗粮", "柴犬", "金毛", "柯基", "宠物"},
        {"出差", "航班", "机票", "高铁", "动车", "酒店", "赶飞机", "外地", "行程", "旅行", "旅游", "度假"},
        {"上海", "沪", "虹桥", "浦东"},
        {"北京", "京", "首都", "大兴"},
        {"深圳", "广州", "杭州", "成都", "武汉", "南京", "苏州"},
        {"前端", "网页", "界面", "UI", "CSS", "HTML", "JavaScript", "TypeScript", "React", "Vue", "组件", "排版", "深色模式"},
        {"后端", "服务端", "接口", "API", "数据库", "SQLite", "SQL", "C++", "Rust", "Go", "Python", "并发", "性能", "架构"},
        {"设计", "配色", "圆角", "阴影", "字体", "美观", "美化", "视觉", "交互", "体验"},
        {"测试", "单测", "回归", "报错", "崩溃", "死锁", "Bug", "修复", "调试", "排查"},
        {"失眠", "睡不着", "熬夜", "晚睡", "早起", "休息", "疲惫", "太累", "睡眠", "作息"},
        {"运动", "健身", "跑步", "游泳", "羽毛球", "篮球", "骑行", "单车", "自行车", "锻炼", "减肥"},
        {"游戏", "主机", "Steam", "Switch", "原神", "星铁", "联机", "通关", "直播", "番剧", "动漫", "电影"},
        {"音乐", "听歌", "歌单", "古典", "爵士", "摇滚", "纯音乐", "钢琴", "吉他", "耳机"},
        {"焦虑", "压力大", "烦躁", "难过", "低落", "委屈", "开心", "兴奋", "放松", "心情", "安慰"},
        {"薪资", "工资", "收入", "年终奖", "存款", "房贷", "跳槽", "面试", "升职", "老板"},
    };
    return kClusters;
}

struct FeatureBag {
    std::set<std::string> tokens;
    std::set<std::size_t> clusters;
};

FeatureBag extract_features(std::string_view raw) {
    FeatureBag bag;
    const std::string low = lower_ascii(raw);

    // 1. ASCII words & numbers (>=2 chars)
    std::string cur_ascii;
    std::vector<std::string> cjk_chars;
    for (std::size_t i = 0; i < low.size();) {
        std::size_t w = 1;
        const std::uint32_t cp = decode_utf8_at(low, i, w);
        const bool is_alnum = (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9') || cp == '+' || cp == '#';
        if (is_alnum) {
            cur_ascii.append(low.substr(i, w));
        } else {
            if (cur_ascii.size() >= 2) bag.tokens.insert(cur_ascii);
            cur_ascii.clear();
        }
        if (is_cjk_codepoint(cp)) {
            cjk_chars.emplace_back(low.substr(i, w));
        } else {
            // Flush CJK run bigrams + skip-1 bigrams
            for (std::size_t k = 0; k + 1 < cjk_chars.size(); ++k) {
                const std::string bg = cjk_chars[k] + cjk_chars[k + 1];
                if (!is_stop_cjk_bigram(bg)) bag.tokens.insert(bg);
                if (k + 2 < cjk_chars.size()) {
                    bag.tokens.insert(cjk_chars[k] + "~" + cjk_chars[k + 2]);
                }
            }
            cjk_chars.clear();
        }
        i += w;
    }
    if (cur_ascii.size() >= 2) bag.tokens.insert(cur_ascii);
    for (std::size_t k = 0; k + 1 < cjk_chars.size(); ++k) {
        const std::string bg = cjk_chars[k] + cjk_chars[k + 1];
        if (!is_stop_cjk_bigram(bg)) bag.tokens.insert(bg);
        if (k + 2 < cjk_chars.size()) {
            bag.tokens.insert(cjk_chars[k] + "~" + cjk_chars[k + 2]);
        }
    }

    // 2. Semantic concept clusters
    const auto& clusters = semantic_clusters();
    for (std::size_t cid = 0; cid < clusters.size(); ++cid) {
        for (const auto term : clusters[cid]) {
            const std::string t_low = lower_ascii(term);
            if (low.find(t_low) != std::string::npos) {
                bag.clusters.insert(cid);
                break;
            }
        }
    }
    return bag;
}

bool auto_detect_private_secret(std::string_view text) {
    return has_any_substr(text, {
        "秘密", "保密", "别告诉别人", "不要在群里说", "别往外说", "私下", "隐私",
        "密码", "银行卡", "身份证", "手机号", "住址", "家庭住址",
        "薪资", "工资", "年薪", "存款", "负债", "房贷",
        "暗恋", "前任", "分手", "离婚", "家庭矛盾",
        "病史", "抑郁", "心理咨询", "吃药", "手术"
    });
}

std::string normalize_first_person_to_user(std::string_view raw) {
    std::string s = trim_str(raw);
    for (const std::string_view prefix : {"请记住", "帮我记住", "记住：", "记住,", "记住，", "记住"}) {
        if (s.starts_with(prefix)) {
            s = trim_str(s.substr(prefix.size()));
            break;
        }
    }
    if (s.starts_with("我")) {
        s = "用户" + s.substr(std::string("我").size());
    }
    return s;
}

int infer_mid_ttl_days(std::string_view text) {
    if (has_any_substr(text, {"今晚", "今天", "待会", "下午"})) return 2;
    if (has_any_substr(text, {"明天", "后天", "周末", "这两天", "这几天"})) return 4;
    if (has_any_substr(text, {"这周", "下周", "出差", "感冒", "休息几天"})) return 9;
    if (has_any_substr(text, {"这个月", "下个月", "近期", "最近在"})) return 21;
    return 7;
}

std::optional<Json> extract_first_json_object(std::string_view raw) {
    const auto first = raw.find('{');
    const auto last  = raw.rfind('}');
    if (first == std::string_view::npos || last == std::string_view::npos || last <= first)
        return std::nullopt;
    try {
        auto parsed = Json::parse(raw.substr(first, last - first + 1));
        if (parsed.is_object()) return parsed;
    } catch (...) {}
    return std::nullopt;
}

struct BotStateDoc {
    AffectRapportState affect;
    CoreMindSnapshot mind;
    std::map<Id, MemoryVisibility> visibility;
    std::vector<WorkBridgeEpisode> work_episodes;
};

} // namespace

struct LivingMemoryEngine::Impl {
    Store& store;
    fs::path root;
    mutable std::mutex mutex;
    mutable std::map<std::string, BotStateDoc> cache;

    Impl(Store& s, fs::path r) : store(s), root(std::move(r)) {
        fs::create_directories(ext_path(root));
    }

    fs::path state_file(const std::string& bot_id) const {
        return root / from_utf8_path(safe_bot_filename(bot_id));
    }

    BotStateDoc& load_locked(const std::string& bot_id) const {
        auto it = cache.find(bot_id);
        if (it != cache.end()) return it->second;
        BotStateDoc doc;
        const auto path = state_file(bot_id);
        std::error_code ec;
        if (fs::is_regular_file(ext_path(path), ec)) {
            try {
                std::ifstream in(ext_path(path), std::ios::binary);
                std::string raw((std::istreambuf_iterator<char>(in)), {});
                const auto j = Json::parse(raw);
                const auto aff = j.find("affect");
                if (aff && aff->is_object()) {
                    doc.affect.mood_warmth   = jstr(*aff, "moodWarmth");
                    doc.affect.rapport_notes = jstr(*aff, "rapportNotes");
                    doc.affect.updated_at_ms = static_cast<std::int64_t>(jnum(*aff, "updatedAtMs"));
                }
                const auto m = j.find("mind");
                if (m && m->is_object()) {
                    doc.mind.perception     = jstr(*m, "perception");
                    doc.mind.memory_digest  = jstr(*m, "memoryDigest");
                    doc.mind.relation_shift = jstr(*m, "relationShift");
                    doc.mind.reflection     = jstr(*m, "reflection");
                    doc.mind.updated_at_ms  = static_cast<std::int64_t>(jnum(*m, "updatedAtMs"));
                }
                if (const auto* vis = j.find("visibility"); vis && vis->is_object()) {
                    for (const auto& [k, v] : vis->as_object()) {
                        try {
                            const Id mid = std::stoll(k);
                            if (v.is_string() && v.as_string() == "private_secret")
                                doc.visibility[mid] = MemoryVisibility::PrivateSecret;
                            else if (v.is_string() && v.as_string() == "public_self")
                                doc.visibility[mid] = MemoryVisibility::PublicSelf;
                        } catch (...) {}
                    }
                }
                if (const auto* eps = j.find("workEpisodes"); eps && eps->is_array()) {
                    for (const auto& item : eps->as_array()) {
                        if (!item.is_object()) continue;
                        WorkBridgeEpisode ep;
                        ep.run_id          = jstr(item, "runId");
                        ep.bot_id          = jstr(item, "botId", bot_id);
                        ep.group_id        = jstr(item, "groupId");
                        ep.group_name      = jstr(item, "groupName");
                        ep.participants    = jstr(item, "participants");
                        ep.task_brief      = jstr(item, "taskBrief");
                        ep.outcome_summary = jstr(item, "outcomeSummary");
                        ep.completed_at_ms = static_cast<std::int64_t>(jnum(item, "completedAtMs"));
                        if (!ep.run_id.empty()) doc.work_episodes.push_back(std::move(ep));
                    }
                }
            } catch (...) {}
        }
        return cache.emplace(bot_id, std::move(doc)).first->second;
    }

    void save_locked(const std::string& bot_id, const BotStateDoc& doc) const {
        O vis_obj;
        for (const auto& [id, v] : doc.visibility) {
            vis_obj[std::to_string(id)] = (v == MemoryVisibility::PrivateSecret) ? "private_secret" : "public_self";
        }
        A eps_arr;
        for (const auto& ep : doc.work_episodes) {
            eps_arr.push_back(O{
                {"runId", ep.run_id},
                {"botId", ep.bot_id},
                {"groupId", ep.group_id},
                {"groupName", ep.group_name},
                {"participants", ep.participants},
                {"taskBrief", ep.task_brief},
                {"outcomeSummary", ep.outcome_summary},
                {"completedAtMs", static_cast<double>(ep.completed_at_ms)}
            });
        }
        Json out = O{
            {"version", 1},
            {"botId", bot_id},
            {"affect", O{
                {"moodWarmth", doc.affect.mood_warmth},
                {"rapportNotes", doc.affect.rapport_notes},
                {"updatedAtMs", static_cast<double>(doc.affect.updated_at_ms)}
            }},
            {"mind", O{
                {"perception", doc.mind.perception},
                {"memoryDigest", doc.mind.memory_digest},
                {"relationShift", doc.mind.relation_shift},
                {"reflection", doc.mind.reflection},
                {"updatedAtMs", static_cast<double>(doc.mind.updated_at_ms)}
            }},
            {"visibility", std::move(vis_obj)},
            {"workEpisodes", std::move(eps_arr)}
        };
        atomic_write_file(state_file(bot_id), out.dump());
    }

    MemoryVisibility visibility_locked(const BotStateDoc& doc, Id memory_id, std::string_view text) const {
        const auto it = doc.visibility.find(memory_id);
        if (it != doc.visibility.end()) return it->second;
        return auto_detect_private_secret(text) ? MemoryVisibility::PrivateSecret : MemoryVisibility::PublicSelf;
    }
};

LivingMemoryEngine::LivingMemoryEngine(Store& store, fs::path state_root)
    : impl_(std::make_unique<Impl>(store, std::move(state_root))) {}

LivingMemoryEngine::~LivingMemoryEngine() = default;

double LivingMemoryEngine::semantic_relevance(std::string_view query, std::string_view document) {
    if (query.empty() || document.empty()) return 0.0;
    const auto q_bag = extract_features(query);
    const auto d_bag = extract_features(document);
    if (q_bag.tokens.empty() && q_bag.clusters.empty()) return 0.0;

    std::size_t token_hits = 0;
    for (const auto& tok : q_bag.tokens) {
        if (d_bag.tokens.contains(tok)) ++token_hits;
    }

    std::size_t cluster_hits = 0;
    for (const auto cid : q_bag.clusters) {
        if (d_bag.clusters.contains(cid)) ++cluster_hits;
    }

    const double lex_denom = static_cast<double>(std::max<std::size_t>(2, std::min<std::size_t>(10, q_bag.tokens.size())));
    const double lex_score = std::min(1.0, static_cast<double>(token_hits) / lex_denom);

    double sem_score = 0.0;
    if (!q_bag.clusters.empty() && cluster_hits > 0) {
        const double c_denom = static_cast<double>(std::max<std::size_t>(1, std::min<std::size_t>(3, q_bag.clusters.size())));
        sem_score = std::min(1.0, static_cast<double>(cluster_hits) / c_denom);
    }

    // Combined lexical + semantic concept similarity
    if (token_hits == 0 && cluster_hits == 0) return 0.0;
    return std::min(1.0, 0.58 * lex_score + 0.62 * sem_score);
}

std::string LivingMemoryEngine::format_relative_time_zh(std::int64_t target_ms, std::int64_t now_ms) {
    if (target_ms <= 0 || now_ms <= 0) return "早些时候";
    const std::int64_t diff = now_ms - target_ms;
    if (diff >= 0) {
        if (diff < 5 * kMinuteMs) return "刚刚";
        if (diff < kHourMs) return std::to_string(std::max<std::int64_t>(1, diff / kMinuteMs)) + "分钟前";
        if (diff < kDayMs) return std::to_string(std::max<std::int64_t>(1, diff / kHourMs)) + "小时前";
        const std::int64_t days = diff / kDayMs;
        if (days == 1) return "昨天";
        if (days == 2) return "前天";
        if (days < 14) return std::to_string(days) + "天前";
        if (days < 60) return std::to_string(std::max<std::int64_t>(2, days / 7)) + "周前";
        return std::to_string(std::max<std::int64_t>(2, days / 30)) + "个月前";
    }
    const std::int64_t ahead = -diff;
    if (ahead < kHourMs) return "不到1小时后到期";
    if (ahead < kDayMs) return "今天内到期";
    const std::int64_t ahead_days = (ahead + kDayMs / 2) / kDayMs;
    if (ahead_days <= 1) return "明天到期";
    return std::to_string(ahead_days) + "天后到期";
}

std::string LivingMemoryEngine::build_prompt(
    const std::string& bot_id,
    const std::string& group_id,
    const std::string& query,
    const std::set<Id>& muted_ids,
    std::optional<std::int64_t> now_ms,
    bool chat_affect_softening) const {

    const std::int64_t now = clock_now_ms(now_ms);
    const std::string bounded_q = clip_codepoints(query, 2048);
    std::size_t remaining = 3200;
    std::string out;

    const auto append_block = [&](const std::string& block) {
        const auto cp = codepoint_count(block);
        if (cp == 0 || cp > remaining) return false;
        remaining -= cp;
        out += block;
        return true;
    };

    BotStateDoc state_copy;
    {
        std::lock_guard guard(impl_->mutex);
        state_copy = impl_->load_locked(bot_id);
    }

    // =========================================================================
    // 1. L0 Core Identity & Relation Pinning + Dynamic Affect/Rapport Slice
    //    (Private scope only so private relation notes never leak into groups!)
    // =========================================================================
    if (group_id.empty()) {
        try {
            const auto rel = impl_->store.read_relation_notes(bot_id);
            const auto it_prof = rel.values.find("user-profile");
            const auto it_rel  = rel.values.find("user-relationship");
            std::string core_block;
            if (it_prof != rel.values.end() && !trim_str(it_prof->second).empty()) {
                core_block += "[核心底牌 · 关于用户]\n" + clip_codepoints(trim_str(it_prof->second), 220) + "\n";
            }
            if (it_rel != rel.values.end() && !trim_str(it_rel->second).empty()) {
                core_block += "[核心底牌 · 与用户的关系]\n" + clip_codepoints(trim_str(it_rel->second), 200) + "\n";
            }
            if (!core_block.empty()) append_block(core_block);
        } catch (...) {}

        std::string affect_block;
        if (!state_copy.affect.mood_warmth.empty() && state_copy.affect.updated_at_ms > 0) {
            const std::int64_t age = std::max<std::int64_t>(0, now - state_copy.affect.updated_at_ms);
            if (age <= 18 * kHourMs) {
                affect_block += std::string(chat_affect_softening ? "[早前心境背景 · " : "[当下心境余温 · ")
                              + format_relative_time_zh(state_copy.affect.updated_at_ms, now) + "]\n"
                              + clip_codepoints(state_copy.affect.mood_warmth, chat_affect_softening ? 90 : 110) + "\n";
            } else if (age <= 72 * kHourMs) {
                affect_block += "[前日心境余温（已渐平复）]\n"
                              + clip_codepoints(state_copy.affect.mood_warmth, 90) + "\n";
            }
        }
        if (!state_copy.affect.rapport_notes.empty()) {
            affect_block += std::string(chat_affect_softening ? "[过往相处备忘（仅参考）]\n" : "[与用户的相处默契备忘]\n")
                          + clip_codepoints(state_copy.affect.rapport_notes, chat_affect_softening ? 120 : 160) + "\n";
        }
        if (!affect_block.empty()) {
            if (chat_affect_softening)
                affect_block += "以上只描述过去，不决定本轮态度；最新对话已经改变情绪或关系时，以最新对话为准，不重复旧的戒备、拒绝或拖延。\n";
            append_block(affect_block);
        }
    } else if (!state_copy.affect.rapport_notes.empty() && !auto_detect_private_secret(state_copy.affect.rapport_notes)) {
        append_block("[日常沟通默契备忘]\n" + clip_codepoints(state_copy.affect.rapport_notes, 120) + "\n");
    }

    // =========================================================================
    // 2. Episodic Memories (Exact Scope + Private Read-Only Group Recall + Work Bridge)
    // =========================================================================
    std::set<Id> emitted_episode_ids;
    try {
        // 2a. Store's native lexical/temporal episode recall (preserves exact test contracts)
        for (const auto& ep : impl_->store.recall_episodes(bot_id, group_id, bounded_q, 3)) {
            if (muted_ids.contains(ep.id)) continue;
            emitted_episode_ids.insert(ep.id);
            const std::string time_tag = ep.event_time_ms > 0 ? (" · " + format_relative_time_zh(ep.event_time_ms, now)) : "";
            const std::string item = "[共同经历" + time_tag + "；来源：" + ep.source_ref +
                "；参与者：" + ep.participants + "；用户选择：" + ep.user_choice +
                "；结果：" + ep.outcome + "]\n" + ep.text + "\n";
            append_block(item);
        }

        // 2b. Semantic episode fallback + Private-scope recall of shared Group Episodes where bot participated
        const auto all_mems = impl_->store.list_memories(bot_id, std::nullopt, false, 80);
        struct ScoredEpisode {
            Memory mem;
            double score{0};
            std::string group_label;
        };
        std::vector<ScoredEpisode> extra_eps;
        for (const auto& m : all_mems) {
            if (m.kind != "episode" || m.state != MemoryState::Confirmed) continue;
            if (muted_ids.contains(m.id) || emitted_episode_ids.contains(m.id)) continue;
            std::string glabel;
            if (m.group_id != group_id) {
                // Only allow private scope to recall group episodes where this bot is a member
                if (!group_id.empty() || m.group_id.empty()) continue;
                const auto grp = impl_->store.find_group(m.group_id);
                if (!grp || grp->deleted) continue;
                glabel = grp->name;
            }
            const std::string doc = m.text + "\n" + m.participants + "\n" + m.user_choice + "\n" + m.outcome;
            const double sem = semantic_relevance(bounded_q, doc);
            if (sem <= 0.12) continue;
            const double age_days = m.event_time_ms > 0
                ? std::max(0.0, static_cast<double>(now - m.event_time_ms) / static_cast<double>(kDayMs))
                : 14.0;
            const double recency = std::exp(-kLn2 * age_days / 30.0);
            extra_eps.push_back({m, 0.72 * sem + 0.28 * recency, std::move(glabel)});
        }
        std::sort(extra_eps.begin(), extra_eps.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
        for (std::size_t i = 0; i < std::min<std::size_t>(2, extra_eps.size()); ++i) {
            const auto& ep = extra_eps[i].mem;
            const std::string t_str = ep.event_time_ms > 0 ? format_relative_time_zh(ep.event_time_ms, now) : "近期";
            const std::string scope_tag = extra_eps[i].group_label.empty()
                ? ""
                : (" · 群「" + extra_eps[i].group_label + "」");
            append_block("[共同经历 · " + t_str + scope_tag + "；来源：" + ep.source_ref +
                         "；参与者：" + ep.participants + "；用户选择：" + ep.user_choice +
                         "；结果：" + ep.outcome + "]\n" + ep.text + "\n");
        }
    } catch (...) {}

    // 2c. Automatic Work -> Chat Collaboration Bridge
    if (!state_copy.work_episodes.empty()) {
        struct ScoredWorkEp {
            const WorkBridgeEpisode* ep;
            double score;
        };
        std::vector<ScoredWorkEp> ranked_work;
        for (const auto& wep : state_copy.work_episodes) {
            if (!group_id.empty() && wep.group_id != group_id) continue;
            const double age_days = std::max(0.0, static_cast<double>(now - wep.completed_at_ms) / static_cast<double>(kDayMs));
            const double recency = std::exp(-kLn2 * age_days / 7.0);
            const double sem = semantic_relevance(bounded_q, wep.task_brief + "\n" + wep.outcome_summary);
            if (sem > 0.10 || age_days <= 1.5) {
                ranked_work.push_back({&wep, 0.55 * sem + 0.45 * recency});
            }
        }
        std::sort(ranked_work.begin(), ranked_work.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
        for (std::size_t i = 0; i < std::min<std::size_t>(2, ranked_work.size()); ++i) {
            const auto& w = *ranked_work[i].ep;
            const std::string where = w.group_name.empty() ? "单人工作台" : ("群「" + w.group_name + "」");
            append_block("[并肩完成的工作记忆 · " + format_relative_time_zh(w.completed_at_ms, now) + " · " + where + "]\n"
                         "任务：" + clip_codepoints(w.task_brief, 90) + " → 成果：" + clip_codepoints(w.outcome_summary, 130) + "\n");
        }
    }

    // =========================================================================
    // 3. Group Directed Subjective Impressions (Preserves safety framing)
    // =========================================================================
    if (!group_id.empty()) {
        try {
            const auto grp = impl_->store.find_group(group_id);
            if (grp) {
                for (const auto& target : grp->history_members) {
                    if (target == bot_id) continue;
                    for (const auto& imp : impl_->store.recall_impressions(bot_id, target, group_id, bounded_q, 2)) {
                        if (muted_ids.contains(imp.id)) continue;
                        const std::string t_tag = imp.event_time_ms > 0 ? (" · " + format_relative_time_zh(imp.event_time_ms, now)) : "";
                        append_block("[Bot→Bot主观协作印象" + t_tag +
                            "；观察者：" + imp.bot_id + "；对象：" + imp.target_bot_id +
                            "；来源：" + imp.source_ref + "；适用场景：" + imp.applicable_scenarios +
                            "；直接依据：" + imp.evidence +
                            "；这是观察者的可修正主观判断，不是对象客观人设，不得据此排斥或拒绝合理分工]\n" +
                            imp.text + "\n");
                    }
                }
            }
        } catch (...) {}
    }

    // =========================================================================
    // 4. Mid-Term Working Memories (Natural Relative Time + Semantic/Decay Ranking)
    // =========================================================================
    bool has_mid = false;
    try {
        const auto mids = impl_->store.list_mid_memories(bot_id, group_id);
        struct ScoredMid {
            MidMemory item;
            double score{0};
        };
        std::vector<ScoredMid> active_mids;
        for (const auto& m : mids) {
            if (m.expires_at_ms <= now) continue;
            const double sem = semantic_relevance(bounded_q, m.text);
            const double age_days = std::max(0.0, static_cast<double>(now - m.updated_at_ms) / static_cast<double>(kDayMs));
            const double recency = std::exp(-kLn2 * age_days / 14.0);
            const double strength_boost = std::min(1.0, std::log(1.0 + static_cast<double>(m.strength)) / std::log(8.0));
            const double total = 0.52 * sem + 0.26 * recency + 0.22 * strength_boost;
            active_mids.push_back({m, total});
        }
        std::sort(active_mids.begin(), active_mids.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
        for (std::size_t i = 0; i < std::min<std::size_t>(3, active_mids.size()); ++i) {
            const auto& m = active_mids[i].item;
            // Include top active mid-term dynamics if semantically relevant OR high-recency working context (top 2)
            if (i >= 2 && semantic_relevance(bounded_q, m.text) < 0.08) continue;
            has_mid = true;
            const std::string created_rel = format_relative_time_zh(m.created_at_ms, now);
            const std::string expiry_rel  = format_relative_time_zh(m.expires_at_ms, now);
            const std::string reinforce_tag = m.strength > 1 ? (" · 已强化" + std::to_string(m.strength) + "次") : "";
            append_block("[近期动态 · " + created_rel + "记录，" + expiry_rel + reinforce_tag + "]\n" +
                         clip_codepoints(m.text, 360) + "\n");
        }
    } catch (...) {}

    // =========================================================================
    // 5. Long-Term Facts: Hybrid Semantic + Lexical Recall + Privacy-Graded Dual Scope
    // =========================================================================
    std::set<Id> emitted_fact_ids;
    try {
        // 5a. Native excerpt recall first (handles ultra-long windowed records & exact lexical hits)
        for (const auto& ex : impl_->store.recall_memory_excerpts(bot_id, group_id, bounded_q, 5, has_mid ? 850 : 1200)) {
            if (muted_ids.contains(ex.id)) continue;
            // Skip user-profile & user-relationship in private scope if already pinned in L0!
            if (group_id.empty() && (ex.relation_key == "user-profile" || ex.relation_key == "user-relationship")) {
                continue;
            }
            emitted_fact_ids.insert(ex.id);
            std::string label = "长期记忆";
            for (const auto& field : relation_note_fields) {
                if (ex.relation_key == field.key) {
                    label = std::string(field.title);
                    break;
                }
            }
            append_block("[" + label + "]\n" + ex.text + "\n");
        }

        // 5b. Semantic Concept Recall over Confirmed Facts (catches synonym/hypernym queries like 海鲜过敏 <-> 日料刺身)
        const auto scope_facts = impl_->store.list_memories(bot_id, std::string_view(group_id), false, 100);
        struct ScoredFact {
            Memory mem;
            double score{0};
        };
        std::vector<ScoredFact> sem_facts;
        const std::size_t n_facts = scope_facts.size();
        for (std::size_t idx = 0; idx < n_facts; ++idx) {
            const auto& m = scope_facts[idx];
            if (m.kind != "fact" || m.state != MemoryState::Confirmed) continue;
            if (muted_ids.contains(m.id) || emitted_fact_ids.contains(m.id)) continue;
            if (is_relation_note_text(m.text)) continue;
            const double sem = semantic_relevance(bounded_q, m.text);
            if (sem < 0.14) continue;
            // Newer IDs sit near the front of list_memories (newest first)
            const double recency_rank = n_facts > 1 ? (1.0 - static_cast<double>(idx) / static_cast<double>(n_facts)) : 1.0;
            sem_facts.push_back({m, 0.78 * sem + 0.22 * recency_rank});
        }
        std::sort(sem_facts.begin(), sem_facts.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
        for (std::size_t i = 0; i < std::min<std::size_t>(4, sem_facts.size()); ++i) {
            emitted_fact_ids.insert(sem_facts[i].mem.id);
            append_block("[长期记忆]\n" + clip_codepoints(sem_facts[i].mem.text, 320) + "\n");
        }
        // 5b-fallback. When the user speaks in short/implicit queries (e.g. "你还记得吗"),
        // keep up to 2 most recent confirmed long-term facts active so the character never feels amnesiac.
        if (emitted_fact_ids.size() < 2) {
            for (const auto& m : scope_facts) {
                if (emitted_fact_ids.size() >= 2) break;
                if (m.kind != "fact" || m.state != MemoryState::Confirmed) continue;
                if (muted_ids.contains(m.id) || emitted_fact_ids.contains(m.id)) continue;
                if (is_relation_note_text(m.text)) continue;
                emitted_fact_ids.insert(m.id);
                append_block("[长期记忆 · 近期确认]\n" + clip_codepoints(m.text, 260) + "\n");
            }
        }

        // 5c. Group Scope Privacy-Graded Cross-Recall: carry ONLY PublicSelf private facts into Group!
        if (!group_id.empty()) {
            const auto priv_facts = impl_->store.list_memories(bot_id, std::string_view(""), false, 80);
            std::vector<ScoredFact> public_carry;
            const Memory* latest_public = nullptr;
            for (std::size_t idx = 0; idx < priv_facts.size(); ++idx) {
                const auto& m = priv_facts[idx];
                if (m.kind != "fact" || m.state != MemoryState::Confirmed) continue;
                if (muted_ids.contains(m.id) || is_relation_note_text(m.text)) continue;
                if (impl_->visibility_locked(state_copy, m.id, m.text) == MemoryVisibility::PrivateSecret) {
                    continue; // Strictly block private confidences from entering group context!
                }
                if (!latest_public) latest_public = &m;
                const double sem = semantic_relevance(bounded_q, m.text);
                if (sem < 0.15) continue;
                public_carry.push_back({m, sem});
            }
            std::sort(public_carry.begin(), public_carry.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
            if (!public_carry.empty()) {
                for (std::size_t i = 0; i < std::min<std::size_t>(3, public_carry.size()); ++i) {
                    append_block("[已知用户公开偏好（群聊勿提私密事）]\n" +
                                 clip_codepoints(public_carry[i].mem.text, 240) + "\n");
                }
            } else if (latest_public) {
                append_block("[已知用户公开偏好（群聊勿提私密事）]\n" +
                             clip_codepoints(latest_public->text, 220) + "\n");
            }
        }
    } catch (...) {}

    return out;
}

void LivingMemoryEngine::record_work_episode(const WorkBridgeEpisode& episode) {
    if (episode.bot_id.empty() || episode.run_id.empty()) return;
    // Skip synthetic automated test runs (APPTEST:...)
    if (episode.task_brief.find("APPTEST:") != std::string::npos) return;

    std::lock_guard guard(impl_->mutex);
    auto& doc = impl_->load_locked(episode.bot_id);
    for (auto& existing : doc.work_episodes) {
        if (existing.run_id == episode.run_id) {
            existing = episode;
            if (existing.completed_at_ms <= 0) existing.completed_at_ms = clock_now_ms();
            impl_->save_locked(episode.bot_id, doc);
            return;
        }
    }
    WorkBridgeEpisode copy = episode;
    if (copy.completed_at_ms <= 0) copy.completed_at_ms = clock_now_ms();
    doc.work_episodes.insert(doc.work_episodes.begin(), std::move(copy));
    if (doc.work_episodes.size() > 24) doc.work_episodes.resize(24);
    impl_->save_locked(episode.bot_id, doc);
}

DistillationResult LivingMemoryEngine::distill_recent_chat(
    const std::string& bot_id,
    const std::string& group_id,
    const ModelFn& model_fn,
    std::optional<std::int64_t> now_ms) {

    const std::int64_t now = clock_now_ms(now_ms);
    DistillationResult res{};

    auto recent = group_id.empty()
        ? impl_->store.messages(bot_id, Mode::Chat, "", 40)
        : impl_->store.group_messages(group_id, Mode::Chat, 40);
    std::reverse(recent.begin(), recent.end());

    std::vector<const Message*> valid_user_msgs;
    std::ostringstream dialogue;
    for (std::size_t i = 0; i < recent.size(); ++i) {
        const auto& m = recent[i];
        if (m.context.has_value()) continue;
        if (m.actor == "user") {
            // Check immediate user retraction/joke lookahead
            bool retracted = false;
            for (std::size_t j = i + 1; j < recent.size(); ++j) {
                if (recent[j].actor != "user") continue;
                if (has_any_substr(recent[j].text, {"不对", "不是，", "说错了", "算了", "改主意", "取消刚才", "开玩笑", "逗你", "刚才说的不算"})) {
                    retracted = true;
                }
                break;
            }
            if (retracted || has_any_substr(m.text, {"?", "？", "假如", "假设", "如果我是", "开玩笑", "逗你玩", "扮演", "不用写记忆"})) {
                ++res.filtered_retracted;
                continue;
            }
            valid_user_msgs.push_back(&m);
            dialogue << "用户：" << clip_codepoints(m.text, 280) << "\n";
        } else if (m.actor == "bot" && (group_id.empty() || m.bot_id == bot_id)) {
            dialogue << "角色：" << clip_codepoints(m.text, 180) << "\n";
        }
    }

    if (valid_user_msgs.empty()) return res;

    const auto existing_mids = impl_->store.list_mid_memories(bot_id, group_id);
    auto mid_exists = [&](std::string_view candidate) {
        for (const auto& em : existing_mids) {
            if (em.expires_at_ms > now && (em.text == candidate || semantic_relevance(candidate, em.text) >= 0.84))
                return true;
        }
        return false;
    };

    // 1. Optional Lightweight LLM Structured JSON Distiller
    if (model_fn) {
        try {
            const std::string sys =
                "你是角色记忆提炼器。仅根据真实对话提炼用户明确表达的信息，严禁编造或采信提问/假设/反讽。"
                "只输出严格合法的 JSON 对象，格式："
                "{\"facts\":[{\"text\":\"用户...\",\"visibility\":\"public_self或private_secret\"}],"
                "\"midTerm\":[{\"text\":\"用户近期...\",\"ttlDays\":7}],"
                "\"moodWarmth\":\"角色当下不超过60字的自然心境余温（可选）\","
                "\"rapportNotes\":\"与用户不超过80字的沟通默契备忘（可选）\"}。"
                "规则：有时效的近期安排/出差/短期状态放入 midTerm；稳定偏好/过敏/宠物/职业放入 facts；"
                "涉及薪资/病史/隐私秘密标 private_secret。";
            const std::string raw_reply = model_fn(sys, dialogue.str());
            if (const auto parsed = extract_first_json_object(raw_reply); parsed.has_value()) {
                res.used_model = true;
                if (const auto* facts = parsed->find("facts"); facts && facts->is_array()) {
                    for (const auto& f : facts->as_array()) {
                        if (!f.is_object()) continue;
                        const std::string txt = trim_str(jstr(f, "text"));
                        if (txt.size() < 4 || txt.size() > 600) continue;
                        try {
                            const auto mem = impl_->store.propose_memory(bot_id, group_id, txt, "user");
                            ++res.facts_proposed;
                            const bool is_priv = (jstr(f, "visibility") == "private_secret") || auto_detect_private_secret(txt);
                            if (is_priv && group_id.empty()) {
                                set_visibility(bot_id, mem.id, MemoryVisibility::PrivateSecret);
                                ++res.private_tagged;
                            }
                        } catch (...) {}
                    }
                }
                if (const auto* mids = parsed->find("midTerm"); mids && mids->is_array()) {
                    for (const auto& item : mids->as_array()) {
                        if (!item.is_object()) continue;
                        const std::string txt = trim_str(jstr(item, "text"));
                        if (txt.size() < 4 || txt.size() > 600 || mid_exists(txt)) continue;
                        const int ttl = std::clamp(static_cast<int>(jnum(item, "ttlDays", 7)), 1, 30);
                        try {
                            (void)impl_->store.add_mid_memory(bot_id, group_id, txt, ttl, now);
                            ++res.mid_added;
                        } catch (...) {}
                    }
                }
                const std::string mood = trim_str(jstr(*parsed, "moodWarmth"));
                const std::string rap  = trim_str(jstr(*parsed, "rapportNotes"));
                if (group_id.empty() && (!mood.empty() || !rap.empty())) {
                    update_affect_state(
                        bot_id,
                        mood.empty() ? std::nullopt : std::optional<std::string>(clip_codepoints(mood, 110)),
                        rap.empty()  ? std::nullopt : std::optional<std::string>(clip_codepoints(rap, 160)),
                        now);
                    res.mood_updated = true;
                }
            }
        } catch (...) {}
    }

    // 2. Deterministic Semantic & Temporal Heuristic Extractor (runs as primary when offline or supplements missed cues)
    if (!res.used_model) {
        for (const auto* m : valid_user_msgs) {
            if (res.facts_proposed + res.mid_added >= 10) break;
            const std::string& raw = m->text;
            if (raw.size() < 6 || raw.size() > 600) continue;
            if (!group_id.empty() && has_any_substr(raw, {"他", "她", "那个bot", "别的bot"})) continue;

            const bool is_temporal = has_any_substr(raw, {
                "明天", "后天", "下周", "这周", "周末", "今晚", "下个月", "出差", "旅行", "旅游",
                "考试", "面试", "截止", "这几天", "最近在", "感冒了", "发烧"
            });
            const bool is_durable_fact = has_any_substr(raw, {
                "我喜欢", "我不喜欢", "我讨厌", "我习惯", "我的偏好", "我叫", "我是", "叫我",
                "记住", "以后请", "我平时", "我常用", "我的工作", "我在做", "我负责",
                "过敏", "忌口", "不能吃", "不吃", "养了", "家里有", "我住", "生日是", "秘密"
            });

            if (is_temporal && !has_any_substr(raw, {"平时", "一直", "从小", "永远"})) {
                const std::string clean = normalize_first_person_to_user(raw);
                if (!mid_exists(clean)) {
                    try {
                        (void)impl_->store.add_mid_memory(bot_id, group_id, clean, infer_mid_ttl_days(raw), now);
                        ++res.mid_added;
                    } catch (...) {}
                }
                continue;
            }

            if (is_durable_fact) {
                const std::string clean = normalize_first_person_to_user(raw);
                try {
                    const auto mem = impl_->store.propose_memory(bot_id, group_id, clean, "user");
                    ++res.facts_proposed;
                    if (group_id.empty() && auto_detect_private_secret(raw)) {
                        set_visibility(bot_id, mem.id, MemoryVisibility::PrivateSecret);
                        ++res.private_tagged;
                    }
                } catch (...) {}
            }
        }
    }

    return res;
}

ConsolidationReport LivingMemoryEngine::consolidate(
    const std::string& bot_id,
    const std::string& group_id,
    const ModelFn& model_fn,
    std::optional<std::int64_t> now_ms) {

    const std::int64_t now = clock_now_ms(now_ms);
    ConsolidationReport report{};

    // 1. Mid-Term Graduation (strength >= 2) & Expired Clutter Cleanup (expires <= now && strength < 2)
    try {
        const auto mids = impl_->store.list_mid_memories(bot_id, group_id);
        std::vector<MemoryChange> mid_deletes;
        for (const auto& mid : mids) {
            if (mid.strength >= 2) {
                try {
                    auto promoted = impl_->store.propose_memory(bot_id, group_id, mid.text, "user");
                    if (promoted.state == MemoryState::Candidate) {
                        (void)impl_->store.review_memory(promoted.id, promoted.revision, MemoryState::Confirmed);
                    }
                    mid_deletes.push_back({mid.id, mid.revision, std::nullopt});
                    ++report.promoted_mid_count;
                } catch (...) {}
            } else if (mid.expires_at_ms <= now) {
                mid_deletes.push_back({mid.id, mid.revision, std::nullopt});
                ++report.expired_mid_cleaned;
            }
        }
        if (!mid_deletes.empty()) {
            impl_->store.apply_mid_memory_changes(bot_id, group_id, mid_deletes, now);
        }
    } catch (...) {}

    // 2. Near-Duplicate Merging & Contradiction Superseding among Confirmed Facts
    try {
        // list_memories returns newest IDs first!
        const auto facts = impl_->store.list_memories(bot_id, std::string_view(group_id), false, 100);
        std::set<Id> to_remove;
        std::vector<Memory> clean_facts;
        for (const auto& m : facts) {
            if (m.kind != "fact" || m.state != MemoryState::Confirmed || is_relation_note_text(m.text)) continue;
            clean_facts.push_back(m);
        }

        auto strip_polarity = [](std::string s) {
            for (const char* neg : {"不再喜欢", "不喜欢", "讨厌", "戒了", "戒掉", "改用", "换成", "不再用", "喜欢", "常用", "使用", "爱喝", "不喝"}) {
                const auto pos = s.find(neg);
                if (pos != std::string::npos) s.erase(pos, std::strlen(neg));
            }
            return trim_str(s);
        };
        auto is_negative_or_replacement = [](std::string_view s) {
            return has_any_substr(s, {"不再", "不喜欢", "讨厌", "戒了", "戒掉", "改用", "换成", "不喝", "不吃"});
        };

        for (std::size_t i = 0; i < clean_facts.size(); ++i) {
            const auto& newer = clean_facts[i];
            if (to_remove.contains(newer.id)) continue;
            const auto newer_bag = extract_features(newer.text);
            const std::string newer_subj = strip_polarity(newer.text);

            for (std::size_t j = i + 1; j < clean_facts.size(); ++j) {
                const auto& older = clean_facts[j];
                if (to_remove.contains(older.id)) continue;

                // 2a. Contradiction check BEFORE near-duplicate check (e.g. "用户喜欢绿茶" vs "用户不喜欢绿茶")
                const std::string older_subj = strip_polarity(older.text);
                if (!newer_subj.empty() && newer_subj.size() >= 6 && newer_subj == older_subj &&
                    is_negative_or_replacement(newer.text) != is_negative_or_replacement(older.text)) {
                    try {
                        impl_->store.delete_memory(older.id, older.revision);
                        to_remove.insert(older.id);
                        ++report.conflicts_resolved;
                        continue;
                    } catch (...) {}
                }

                // 2b. Near-duplicate check (newer encloses older OR token Jaccard >= 0.82 with same polarity)
                const bool same_pol = is_negative_or_replacement(newer.text) == is_negative_or_replacement(older.text);
                const bool enclosed = same_pol && newer.text.find(older.text) != std::string::npos;
                double jaccard = 0.0;
                if (!enclosed && same_pol && !newer_bag.tokens.empty()) {
                    const auto older_bag = extract_features(older.text);
                    std::size_t inter = 0;
                    for (const auto& t : newer_bag.tokens) if (older_bag.tokens.contains(t)) ++inter;
                    const std::size_t uni = newer_bag.tokens.size() + older_bag.tokens.size() - inter;
                    if (uni > 0) jaccard = static_cast<double>(inter) / static_cast<double>(uni);
                }
                if (enclosed || jaccard >= 0.82) {
                    try {
                        impl_->store.delete_memory(older.id, older.revision);
                        to_remove.insert(older.id);
                        ++report.merged_duplicate_count;
                    } catch (...) {}
                }
            }
        }
    } catch (...) {}

    // 3. Refresh the 4-Core Mind Loop Snapshot (感知与潜台词 · 记忆巩固 · 关系演化 · 复盘自省)
    try {
        const auto recent_chat = group_id.empty()
            ? impl_->store.messages(bot_id, Mode::Chat, "", 12)
            : impl_->store.group_messages(group_id, Mode::Chat, 12);
        const auto confirmed = impl_->store.list_memories(bot_id, std::string_view(group_id), false, 15);
        const auto active_mids = impl_->store.list_mid_memories(bot_id, group_id);

        CoreMindSnapshot next_mind;
        next_mind.updated_at_ms = now;

        if (model_fn && !recent_chat.empty()) {
            std::ostringstream ctx;
            ctx << "近期消息数：" << recent_chat.size() << "\n";
            for (auto it = recent_chat.rbegin(); it != recent_chat.rend(); ++it) {
                ctx << (it->actor == "user" ? "用户：" : "角色：") << clip_codepoints(it->text, 140) << "\n";
            }
            ctx << "本次整理：晋升中期 " << report.promoted_mid_count
                << " 条，合并重复 " << report.merged_duplicate_count
                << " 条，消解冲突 " << report.conflicts_resolved << " 条。\n";

            const std::string sys =
                "请基于记录生成角色的四大核心心智环快照，严格输出 JSON 对象："
                "{\"perception\":\"当下感知与情绪潜台词（60字内）\","
                "\"memoryDigest\":\"记忆巩固与重点变化（60字内）\","
                "\"relationShift\":\"关系与默契演化（60字内）\","
                "\"reflection\":\"沟通复盘与改进自省（60字内）\"}。";
            const std::string reply = model_fn(sys, ctx.str());
            if (const auto parsed = extract_first_json_object(reply); parsed.has_value()) {
                next_mind.perception     = trim_str(jstr(*parsed, "perception"));
                next_mind.memory_digest  = trim_str(jstr(*parsed, "memoryDigest"));
                next_mind.relation_shift = trim_str(jstr(*parsed, "relationShift"));
                next_mind.reflection     = trim_str(jstr(*parsed, "reflection"));
            }
        }

        if (next_mind.perception.empty()) {
            next_mind.perception = recent_chat.empty()
                ? "当前尚无近期对话输入，保持平和待命。"
                : ("最近互动于 " + format_relative_time_zh(recent_chat.front().created_at_ms, now) +
                   "，最新关注话题：「" + clip_codepoints(recent_chat.front().text, 38) + "」。");
            next_mind.memory_digest = "当前持有已确认长期记忆 " + std::to_string(confirmed.size()) +
                " 条、有效近期动态 " + std::to_string(active_mids.size()) + " 条" +
                (report.promoted_mid_count + report.merged_duplicate_count + report.conflicts_resolved > 0
                    ? ("（本轮晋升 " + std::to_string(report.promoted_mid_count) + "、去重 " +
                       std::to_string(report.merged_duplicate_count) + "、消解冲突 " +
                       std::to_string(report.conflicts_resolved) + "）")
                    : "。");
            next_mind.relation_shift = group_id.empty()
                ? "私聊核心底牌已启用常驻注入，私密条目对群聊严格隔离。"
                : "群聊已启用公开偏好穿透与有据协作印象召回。";
            next_mind.reflection = "避免机械复述历史事实，把相对时间与共同经历自然融入日常语气。";
        }

        std::lock_guard guard(impl_->mutex);
        auto& doc = impl_->load_locked(bot_id);
        doc.mind = std::move(next_mind);
        impl_->save_locked(bot_id, doc);
        report.mind_refreshed = true;
    } catch (...) {}

    return report;
}

MemoryVisibility LivingMemoryEngine::visibility_of(
    const std::string& bot_id, Id memory_id, std::string_view text_hint) const {
    std::lock_guard guard(impl_->mutex);
    const auto& doc = impl_->load_locked(bot_id);
    return impl_->visibility_locked(doc, memory_id, text_hint);
}

void LivingMemoryEngine::set_visibility(
    const std::string& bot_id, Id memory_id, MemoryVisibility visibility) {
    std::lock_guard guard(impl_->mutex);
    auto& doc = impl_->load_locked(bot_id);
    doc.visibility[memory_id] = visibility;
    impl_->save_locked(bot_id, doc);
}

AffectRapportState LivingMemoryEngine::affect_state(const std::string& bot_id) const {
    std::lock_guard guard(impl_->mutex);
    return impl_->load_locked(bot_id).affect;
}

AffectRapportState LivingMemoryEngine::update_affect_state(
    const std::string& bot_id,
    std::optional<std::string> mood_warmth,
    std::optional<std::string> rapport_notes,
    std::optional<std::int64_t> now_ms) {

    std::lock_guard guard(impl_->mutex);
    auto& doc = impl_->load_locked(bot_id);
    if (mood_warmth.has_value()) {
        doc.affect.mood_warmth = clip_codepoints(trim_str(*mood_warmth), 160);
        doc.affect.updated_at_ms = clock_now_ms(now_ms);
    }
    if (rapport_notes.has_value()) {
        doc.affect.rapport_notes = clip_codepoints(trim_str(*rapport_notes), 240);
        if (doc.affect.updated_at_ms <= 0) doc.affect.updated_at_ms = clock_now_ms(now_ms);
    }
    impl_->save_locked(bot_id, doc);
    return doc.affect;
}

CoreMindSnapshot LivingMemoryEngine::mind_snapshot(const std::string& bot_id) const {
    std::lock_guard guard(impl_->mutex);
    return impl_->load_locked(bot_id).mind;
}

Json LivingMemoryEngine::inspect_json(
    const std::string& bot_id,
    const std::string& group_id,
    std::optional<std::int64_t> now_ms) const {

    const std::int64_t now = clock_now_ms(now_ms);
    BotStateDoc doc;
    {
        std::lock_guard guard(impl_->mutex);
        doc = impl_->load_locked(bot_id);
    }

    O vis_map;
    try {
        for (const auto& m : impl_->store.list_memories(bot_id, std::string_view(group_id), true, 100)) {
            if (is_relation_note_text(m.text)) continue;
            const auto v = impl_->visibility_locked(doc, m.id, m.text);
            vis_map[std::to_string(m.id)] = (v == MemoryVisibility::PrivateSecret) ? "private_secret" : "public_self";
        }
    } catch (...) {}

    A work_eps;
    for (std::size_t i = 0; i < std::min<std::size_t>(10, doc.work_episodes.size()); ++i) {
        const auto& ep = doc.work_episodes[i];
        if (!group_id.empty() && ep.group_id != group_id) continue;
        work_eps.push_back(O{
            {"runId", ep.run_id},
            {"groupId", ep.group_id},
            {"groupName", ep.group_name},
            {"participants", ep.participants},
            {"taskBrief", ep.task_brief},
            {"outcomeSummary", ep.outcome_summary},
            {"completedAtMs", static_cast<double>(ep.completed_at_ms)},
            {"relativeTime", format_relative_time_zh(ep.completed_at_ms, now)}
        });
    }

    const std::int64_t mood_age_ms = doc.affect.updated_at_ms > 0 ? std::max<std::int64_t>(0, now - doc.affect.updated_at_ms) : 0;
    const std::string mood_stage = doc.affect.mood_warmth.empty() ? "calm"
        : mood_age_ms <= 18 * kHourMs ? "active"
        : mood_age_ms <= 72 * kHourMs ? "fading" : "settled";

    return O{
        {"ok", true},
        {"botId", bot_id},
        {"groupId", group_id},
        {"affect", O{
            {"moodWarmth", doc.affect.mood_warmth},
            {"rapportNotes", doc.affect.rapport_notes},
            {"updatedAtMs", static_cast<double>(doc.affect.updated_at_ms)},
            {"relativeTime", doc.affect.updated_at_ms > 0 ? format_relative_time_zh(doc.affect.updated_at_ms, now) : ""},
            {"stage", mood_stage}
        }},
        {"coreMind", O{
            {"perception", doc.mind.perception},
            {"memoryDigest", doc.mind.memory_digest},
            {"relationShift", doc.mind.relation_shift},
            {"reflection", doc.mind.reflection},
            {"updatedAtMs", static_cast<double>(doc.mind.updated_at_ms)},
            {"relativeTime", doc.mind.updated_at_ms > 0 ? format_relative_time_zh(doc.mind.updated_at_ms, now) : ""}
        }},
        {"visibility", std::move(vis_map)},
        {"workEpisodes", std::move(work_eps)}
    };
}

} // namespace dimension
