#include "dimension/living_memory.hpp"
#include "dimension/relation_notes.hpp"

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace dimension;
namespace fs = std::filesystem;

std::size_t checks = 0;
void check_impl(bool ok, const char* expr, int line) {
    ++checks;
    if (!ok) throw std::runtime_error("living_memory_test failed at line " + std::to_string(line) + ": " + expr);
}
#define CHECK(expr) check_impl(static_cast<bool>(expr), #expr, __LINE__)

void run_all(const fs::path& root) {
    std::error_code ec;
    fs::remove_all(root, ec);
    fs::create_directories(root);

    constexpr std::int64_t kDay = 24LL * 60LL * 60LL * 1000LL;
    constexpr std::int64_t t0   = 1760000000000LL;

    Store store(root / "data.sqlite");
    (void)store.create_bot("亚丝娜", "温柔可靠的前端伙伴", "asuna");
    (void)store.create_bot("芙莉莲", "冷静严谨的架构师", "frieren");

    Group grp;
    grp.id = "grp-dev";
    grp.name = "产品交付组";
    grp.owner_id = "asuna";
    grp.members = {"asuna", "frieren"};
    grp.history_members = {"asuna", "frieren"};
    grp.in_chat = true;
    grp.in_work = true;
    (void)store.create_group(grp);

    LivingMemoryEngine engine(store, root / "living-state");

    // 1. L0 Core Relation Pinning + Semantic Concept Recall + Natural Relative Time
    const auto rel0 = store.read_relation_notes("asuna");
    (void)store.save_relation_notes("asuna", {
        {"user-profile", "独立开发者，正在打磨桌面端 Agent 产品"},
        {"user-relationship", "并肩作战的老搭档，喜欢直接干脆的沟通"},
        {"contacts", ""},
        {"external-bots", ""}
    }, rel0.revision);

    auto m_allergy = store.propose_memory("asuna", "", "用户对海鲜严重过敏，平时熬夜爱喝无糖冰美式", "user");
    m_allergy = store.review_memory(m_allergy.id, m_allergy.revision, MemoryState::Confirmed);

    auto m_secret = store.propose_memory("asuna", "", "秘密：用户准备明年换城市定居，别往外说", "user");
    m_secret = store.review_memory(m_secret.id, m_secret.revision, MemoryState::Confirmed);
    CHECK(engine.visibility_of("asuna", m_secret.id, m_secret.text) == MemoryVisibility::PrivateSecret);
    CHECK(engine.visibility_of("asuna", m_allergy.id, m_allergy.text) == MemoryVisibility::PublicSelf);

    (void)store.add_mid_memory("asuna", "", "用户下周三去上海参加技术展会", 7, t0 - 2 * kDay);

    // Query with ZERO literal substring overlap ("日料刺身" + "提神的饮料")
    const std::string p_priv = engine.build_prompt(
        "asuna", "", "今晚聚餐去吃日料刺身还是烤肉？顺便帮我点杯提神的饮料", {}, t0);
    CHECK(p_priv.find("[核心底牌 · 关于用户]") != std::string::npos);
    CHECK(p_priv.find("独立开发者") != std::string::npos);
    CHECK(p_priv.find("[核心底牌 · 与用户的关系]") != std::string::npos);
    CHECK(p_priv.find("海鲜严重过敏") != std::string::npos);
    CHECK(p_priv.find("前天记录，5天后到期") != std::string::npos);
    CHECK(p_priv.find("到期Unix毫秒") == std::string::npos);

    // 2. Group Privacy Boundary: PublicSelf carries over, PrivateSecret & private relation notes NEVER leak!
    const std::string p_grp = engine.build_prompt(
        "asuna", "grp-dev", "今晚庆功宴大家吃日料刺身吗？另外有人换城市吗？", {}, t0);
    CHECK(p_grp.find("海鲜严重过敏") != std::string::npos);
    CHECK(p_grp.find("换城市定居") == std::string::npos);
    CHECK(p_grp.find("[核心底牌 · 与用户的关系]") == std::string::npos);

    // 3. Work -> Chat Episodic Bridge + Dynamic Mood Temporal Calming
    engine.record_work_episode({
        "run-amber-047", "asuna", "grp-dev", "产品交付组", "用户、亚丝娜、芙莉莲",
        "完成温润琥珀陶土前端美化重构", "双层悬浮输入卡与矢量图标全部上线", t0 - 3600 * 1000LL
    });
    engine.update_affect_state("asuna", "刚和用户一起打磨完新界面，成就感满满", "讨论 UI 时偏爱暖纸质感，讨厌刺眼荧光蓝", t0 - 2 * 3600 * 1000LL);

    const std::string p_after_work = engine.build_prompt("asuna", "", "刚才咱们改完的新界面感觉怎么样", {}, t0);
    CHECK(p_after_work.find("并肩完成的工作记忆") != std::string::npos);
    CHECK(p_after_work.find("温润琥珀陶土前端美化重构") != std::string::npos);
    CHECK(p_after_work.find("[当下心境余温") != std::string::npos);
    CHECK(p_after_work.find("相处默契备忘") != std::string::npos);

    // Private Chat explicitly softens stale affect; the default Work/legacy path above is unchanged.
    const std::string p_chat_soft = engine.build_prompt(
        "asuna", "", "刚才咱们改完的新界面感觉怎么样", {}, t0, true);
    CHECK(p_chat_soft.find("[早前心境背景") != std::string::npos);
    CHECK(p_chat_soft.find("[过往相处备忘（仅参考）]") != std::string::npos);
    CHECK(p_chat_soft.find("以上只描述过去，不决定本轮态度") != std::string::npos);
    CHECK(p_chat_soft.find("最新对话为准") != std::string::npos);
    CHECK(p_chat_soft.find("[当下心境余温") == std::string::npos);

    // 4 days later: mood warmth auto-settles while rapport notes stay intact, persona untouched!
    const std::string p_4days = engine.build_prompt("asuna", "", "随便聊聊", {}, t0 + 4 * kDay);
    CHECK(p_4days.find("[当下心境余温") == std::string::npos);
    CHECK(p_4days.find("相处默契备忘") != std::string::npos);
    CHECK(store.find_bot("asuna")->persona == "温柔可靠的前端伙伴");

    // 4. Smart Chat Distillation (Temporal -> MidMemory, Durable -> Fact, Retracted -> Filtered)
    (void)store.append_message("frieren", Mode::Chat, "user", "我特别喜欢吃香菜");
    (void)store.append_message("frieren", Mode::Chat, "user", "不对，刚才说错了，我最讨厌香菜");
    (void)store.append_message("frieren", Mode::Chat, "user", "明天下午我要去杭州出差两天");
    (void)store.append_message("frieren", Mode::Chat, "user", "我家养了一只叫雪球的布偶猫");
    (void)store.append_message("frieren", Mode::Chat, "user", "这是秘密别往外说：我存款够买房首付了");

    const auto dist = engine.distill_recent_chat("frieren", "", {}, t0);
    CHECK(dist.filtered_retracted >= 1);
    CHECK(dist.mid_added == 1);
    CHECK(dist.facts_proposed >= 2);
    CHECK(dist.private_tagged >= 1);

    const auto frieren_mids = store.list_mid_memories("frieren", "");
    CHECK(frieren_mids.size() == 1 && frieren_mids.front().text.find("杭州出差") != std::string::npos);

    // 5. Sleep-Cycle Consolidation: MidMemory Graduation + Duplicate Merge + Contradiction Resolution
    auto c_old = store.propose_memory("frieren", "", "用户喜欢喝绿茶", "user");
    c_old = store.review_memory(c_old.id, c_old.revision, MemoryState::Confirmed);
    auto c_dup = store.propose_memory("frieren", "", "用户平时喜欢喝绿茶提神", "user");
    // Wait: test contradiction against c_old:
    auto c_new_contra = store.propose_memory("frieren", "", "用户不喜欢喝绿茶", "user");
    c_new_contra = store.review_memory(c_new_contra.id, c_new_contra.revision, MemoryState::Confirmed);
    (void)c_dup;

    auto d1 = store.propose_memory("frieren", "", "用户常用 C++20 编写核心服务", "user");
    d1 = store.review_memory(d1.id, d1.revision, MemoryState::Confirmed);
    auto d2 = store.propose_memory("frieren", "", "用户日常常用 C++20 编写核心服务模块", "user");
    d2 = store.review_memory(d2.id, d2.revision, MemoryState::Confirmed);
    // Note: d2 encloses d1? Wait: "用户日常常用..." does not literally contain "用户常用...", so let's also add an exact enclosure:
    auto d3 = store.propose_memory("frieren", "", "用户常用 C++20 编写核心服务与桌面端", "user");
    d3 = store.review_memory(d3.id, d3.revision, MemoryState::Confirmed);

    // Reinforce mid-memory so strength == 2 (eligible for graduation!) and add an expired low-strength mid-memory
    const auto reinforced = store.reinforce_mid_memory("frieren", "", frieren_mids.front().id, frieren_mids.front().revision, 7, t0);
    CHECK(reinforced.strength == 2);
    (void)store.add_mid_memory("frieren", "", "三天前的临时提醒", 1, t0 - 5 * kDay);

    const auto rep = engine.consolidate("frieren", "", {}, t0);
    CHECK(rep.promoted_mid_count == 1);
    CHECK(rep.expired_mid_cleaned == 1);
    CHECK(rep.conflicts_resolved >= 1);
    CHECK(rep.merged_duplicate_count >= 1);
    CHECK(rep.mind_refreshed);

    const auto after_facts = store.list_memories("frieren", std::string_view(""), false, 50);
    bool has_dislike_tea = false, has_like_tea = false, has_promoted = false;
    for (const auto& m : after_facts) {
        if (m.text == "用户不喜欢喝绿茶") has_dislike_tea = true;
        if (m.text == "用户喜欢喝绿茶") has_like_tea = true;
        if (m.text.find("杭州出差") != std::string::npos) has_promoted = true;
    }
    CHECK(has_dislike_tea && !has_like_tea && has_promoted);

    // Restart persistence check
    {
        LivingMemoryEngine restored(store, root / "living-state");
        const auto snap = restored.inspect_json("asuna", "", t0);
        CHECK(snap.at("affect").at("moodWarmth").as_string().find("成就感满满") != std::string::npos);
        CHECK(snap.at("workEpisodes").as_array().size() == 1);
        CHECK(!restored.mind_snapshot("frieren").perception.empty());
    }
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const fs::path root = argc > 1 ? fs::path(argv[1]) : fs::temp_directory_path() / "dimension-living-memory-test";
        run_all(root);
        std::cout << "living_memory: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
