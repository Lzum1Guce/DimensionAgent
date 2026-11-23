#define NOMINMAX
#include "dimension/work_craft_evolution.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/living_memory.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

std::int64_t current_epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

std::string path_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return {reinterpret_cast<const char*>(u.data()), u.size()};
}

fs::path utf8_path(std::string_view s) {
    const std::u8string u8(reinterpret_cast<const char8_t*>(s.data()), s.size());
    return fs::path(u8);
}

std::string ascii_lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string trim_str(std::string_view s) {
    std::size_t b = 0, e = s.size();
    while (b < e && static_cast<unsigned char>(s[b]) <= 0x20U) ++b;
    while (e > b && static_cast<unsigned char>(s[e - 1]) <= 0x20U) --e;
    return std::string(s.substr(b, e - b));
}

std::string safe_clip_utf8(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t end = max_bytes;
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0U) == 0x80U) --end;
    return std::string(s.substr(0, end)) + "…";
}

std::string jstr(const Json& j, std::string_view k, std::string def = {}) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_string()) ? p->as_string() : def;
}

double jnum(const Json& j, std::string_view k, double def = 0.0) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_number()) ? p->as_number() : def;
}

bool jbool(const Json& j, std::string_view k, bool def = false) {
    if (!j.is_object()) return def;
    const auto* p = j.find(k);
    return (p && p->is_bool()) ? p->as_bool() : def;
}

std::vector<std::string> jstr_array(const Json& j, std::string_view k) {
    std::vector<std::string> out;
    if (!j.is_object()) return out;
    if (const auto* p = j.find(k); p && p->is_array()) {
        for (const auto& item : p->as_array()) {
            if (item.is_string() && !trim_str(item.as_string()).empty()) {
                out.push_back(trim_str(item.as_string()));
            }
        }
    }
    return out;
}

std::string stable_hash_hex(std::string_view text) {
    std::uint64_t h1 = 14695981039346656037ULL;
    std::uint64_t h2 = 1099511628211ULL ^ 0xA5A5A5A55A5A5A5AULL;
    for (unsigned char c : text) {
        h1 ^= c;
        h1 *= 1099511628211ULL;
        h2 ^= (static_cast<std::uint64_t>(c) + 0x9e3779b97f4a7c15ULL + (h2 << 6) + (h2 >> 2));
    }
    char buf[36]{};
    std::snprintf(buf, sizeof(buf), "%016llx%08x",
                  static_cast<unsigned long long>(h1),
                  static_cast<unsigned>(h2 & 0xFFFFFFFFULL));
    return std::string(buf);
}

std::string sanitize_ascii_slug(std::string_view raw, std::string_view fallback_seed) {
    std::string out;
    for (unsigned char c : raw) {
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            out.push_back(static_cast<char>(c));
        } else if (c >= 'A' && c <= 'Z') {
            out.push_back(static_cast<char>(c - 'A' + 'a'));
        } else if ((c == '-' || c == '_' || c == ' ') && !out.empty() && out.back() != '-') {
            out.push_back('-');
        }
        if (out.size() >= 36) break;
    }
    while (!out.empty() && out.back() == '-') out.pop_back();
    if (out.size() < 3) {
        out = "playbook-" + stable_hash_hex(fallback_seed).substr(0, 10);
    }
    return out;
}

std::string read_text_file_safe(const fs::path& p) {
    std::error_code ec;
    if (!fs::is_regular_file(p, ec)) return {};
    std::ifstream ifs(p, std::ios::binary);
    if (!ifs) return {};
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

void write_utf8_atomic(const fs::path& p, std::string_view bytes) {
    std::error_code ec;
    const auto abs_p = fs::absolute(p, ec);
    atomic_write_file(ec ? p : abs_p, bytes);
}

std::string extract_first_json_object(std::string_view raw) {
    const auto first = raw.find('{');
    const auto last = raw.rfind('}');
    if (first != std::string_view::npos && last != std::string_view::npos && last > first) {
        return std::string(raw.substr(first, last - first + 1));
    }
    return {};
}

bool contains_any(std::string_view haystack_lower, std::initializer_list<const char*> needles) {
    for (const char* n : needles) {
        if (n && *n && haystack_lower.find(n) != std::string_view::npos) return true;
    }
    return false;
}

double tag_overlap_score(const std::vector<std::string>& a, const std::vector<std::string>& b) {
    if (a.empty() || b.empty()) return 0.0;
    std::set<std::string> sa(a.begin(), a.end());
    std::size_t hits = 0;
    for (const auto& t : b) {
        if (sa.contains(t)) ++hits;
    }
    if (hits == 0) return 0.0;
    return static_cast<double>(hits) / static_cast<double>(std::min(sa.size(), b.size()));
}

double recency_factor(std::int64_t item_ms, std::int64_t now_ms) {
    if (item_ms <= 0 || now_ms <= item_ms) return 1.0;
    const double days = static_cast<double>(now_ms - item_ms) / (86400.0 * 1000.0);
    // Gentle 60-day half-life so proven engineering craft endures across weeks
    return std::pow(0.5, days / 60.0);
}

bool looks_like_user_correction(std::string_view followup) {
    const auto low = ascii_lower(followup);
    return contains_any(low, {
        "不是", "不对", "搞错", "别用", "不要", "改成", "换成", "停下", "重来",
        "而是", "我要的是", "偏了", "太花", "太乱", "太简陋", "wrong", "instead", "not "
    });
}

std::string format_skill_markdown(const TransferablePlaybook& pb, const std::string& bot_id) {
    std::ostringstream md;
    md << "---\n";
    md << "name: auto-" << pb.slug << "\n";
    md << "description: " << safe_clip_utf8(pb.title + " — 适用母类：" + pb.problem_archetype, 180) << "\n";
    md << "---\n\n";
    md << "# " << pb.title << "\n\n";
    md << "> 本技能由 Bot `" << bot_id << "` 在实战交付中自主提炼沉淀（已成功验证 "
       << pb.success_count << " 次），用于同类及相通问题的举一反十复用。\n\n";
    md << "## 适用问题母类（何时激活）\n";
    md << pb.problem_archetype << "\n\n";
    if (!pb.core_steps.empty()) {
        md << "## 标准化推进战法\n";
        for (std::size_t i = 0; i < pb.core_steps.size(); ++i) {
            md << (i + 1) << ". " << pb.core_steps[i] << "\n";
        }
        md << "\n";
    }
    if (!pb.quality_bar.empty()) {
        md << "## 交付质量与验收标尺\n";
        md << "- " << pb.quality_bar << "\n";
    }
    return md.str();
}

} // namespace

Json PitfallAntibody::to_json() const {
    A tags;
    for (const auto& t : domain_tags) tags.push_back(t);
    return O{
        {"id", id},
        {"domainTags", std::move(tags)},
        {"triggerSignature", trigger_signature},
        {"rootCause", root_cause},
        {"remedy", remedy},
        {"sourceBotId", source_bot_id},
        {"hitCount", static_cast<double>(hit_count)},
        {"strength", strength},
        {"updatedAtMs", static_cast<double>(updated_at_ms)}
    };
}

PitfallAntibody PitfallAntibody::from_json(const Json& j) {
    PitfallAntibody p;
    p.id = jstr(j, "id");
    p.domain_tags = jstr_array(j, "domainTags");
    p.trigger_signature = jstr(j, "triggerSignature");
    p.root_cause = jstr(j, "rootCause");
    p.remedy = jstr(j, "remedy");
    p.source_bot_id = jstr(j, "sourceBotId");
    p.hit_count = std::max(1, static_cast<int>(jnum(j, "hitCount", 1)));
    p.strength = std::clamp(jnum(j, "strength", 1.0), 0.1, 5.0);
    p.updated_at_ms = static_cast<std::int64_t>(jnum(j, "updatedAtMs", 0));
    return p;
}

Json UserTasteHabit::to_json() const {
    A tags;
    for (const auto& t : domain_tags) tags.push_back(t);
    return O{
        {"id", id},
        {"domainTags", std::move(tags)},
        {"preference", preference},
        {"evidenceKind", evidence_kind},
        {"reinforceCount", static_cast<double>(reinforce_count)},
        {"strength", strength},
        {"updatedAtMs", static_cast<double>(updated_at_ms)}
    };
}

UserTasteHabit UserTasteHabit::from_json(const Json& j) {
    UserTasteHabit h;
    h.id = jstr(j, "id");
    h.domain_tags = jstr_array(j, "domainTags");
    h.preference = jstr(j, "preference");
    h.evidence_kind = jstr(j, "evidenceKind", "delivery");
    h.reinforce_count = std::max(1, static_cast<int>(jnum(j, "reinforceCount", 1)));
    h.strength = std::clamp(jnum(j, "strength", 1.0), 0.1, 5.0);
    h.updated_at_ms = static_cast<std::int64_t>(jnum(j, "updatedAtMs", 0));
    return h;
}

Json TransferablePlaybook::to_json() const {
    A tags, steps;
    for (const auto& t : domain_tags) tags.push_back(t);
    for (const auto& s : core_steps) steps.push_back(s);
    return O{
        {"id", id},
        {"slug", slug},
        {"title", title},
        {"problemArchetype", problem_archetype},
        {"domainTags", std::move(tags)},
        {"coreSteps", std::move(steps)},
        {"qualityBar", quality_bar},
        {"successCount", static_cast<double>(success_count)},
        {"strength", strength},
        {"materializedSkill", materialized_skill},
        {"updatedAtMs", static_cast<double>(updated_at_ms)}
    };
}

TransferablePlaybook TransferablePlaybook::from_json(const Json& j) {
    TransferablePlaybook pb;
    pb.id = jstr(j, "id");
    pb.slug = jstr(j, "slug");
    pb.title = jstr(j, "title");
    pb.problem_archetype = jstr(j, "problemArchetype");
    pb.domain_tags = jstr_array(j, "domainTags");
    pb.core_steps = jstr_array(j, "coreSteps");
    pb.quality_bar = jstr(j, "qualityBar");
    pb.success_count = std::max(1, static_cast<int>(jnum(j, "successCount", 1)));
    pb.strength = std::clamp(jnum(j, "strength", 1.0), 0.1, 5.0);
    pb.materialized_skill = jbool(j, "materializedSkill", false);
    pb.updated_at_ms = static_cast<std::int64_t>(jnum(j, "updatedAtMs", 0));
    return pb;
}

Json CraftDistillationOutcome::to_json() const {
    return O{
        {"globalPitfallsUpserted", static_cast<double>(global_pitfalls_upserted)},
        {"botHabitsUpserted", static_cast<double>(bot_habits_upserted)},
        {"botPlaybooksUpserted", static_cast<double>(bot_playbooks_upserted)},
        {"skillsMaterialized", static_cast<double>(skills_materialized)},
        {"usedModel", used_model}
    };
}

std::vector<std::string> CraftEvolutionEngine::infer_domain_tags(std::string_view text, std::string_view platform_hint) {
    const auto low = ascii_lower(text);
    const auto plat_low = ascii_lower(platform_hint);
    std::set<std::string> tags;

    if (plat_low == "windows" || contains_any(low, {"windows", "win32", "powershell", ".exe", "msvc", "appdata", "regedit", "c:\\", "l:\\"})) {
        tags.insert("windows");
    }
    if (plat_low == "wsl" || contains_any(low, {"wsl", "linux", "ubuntu", "debian", "bash", "/mnt/", "sandbox", "沙盒"})) {
        tags.insert("linux-sandbox");
    }
    if (contains_any(low, {"c++", ".cpp", ".hpp", "cmake", "ninja", "msvc", "clang", "g++", "编译", "头文件", "链接"})) {
        tags.insert("cpp-native");
    }
    if (contains_any(low, {"html", "css", "javascript", "typescript", ".js", ".ts", "react", "vue", "dom", "webview", "前端", "界面", "样式", "交互", "动画", "配色"})) {
        tags.insert("frontend-ui");
    }
    if (contains_any(low, {"python", ".py", "pytest", "pip", "uv ", "venv", "fastapi"})) {
        tags.insert("python");
    }
    if (contains_any(low, {"客户端", "怎么跑", "运行方式", "运行机制", "只读", "摸底", "逆向", "排查", "检查", "日志", "进程", "配置目录", "inspect", "audit"})) {
        tags.insert("system-inspection");
    }
    if (contains_any(low, {"cli", "hermes", "kimi", "claude", "codex", "opencode", "agent", "命令行", "子进程", "stream-json"})) {
        tags.insert("agent-cli");
    }
    if (contains_any(low, {"sqlite", "sql", "database", "数据库", "存储", "索引", "schema"})) {
        tags.insert("storage-db");
    }
    if (contains_any(low, {"架构", "方案", "设计", "重构", "演进", "对比", "评估", "选型", "architecture"})) {
        tags.insert("architecture");
    }
    if (contains_any(low, {"脚本", "自动化", "批处理", ".ps1", ".sh", "定时", "流水线", "打包", "部署"})) {
        tags.insert("automation-devops");
    }
    if (tags.empty()) {
        tags.insert("general-engineering");
    }
    return {tags.begin(), tags.end()};
}

bool CraftEvolutionEngine::looks_like_ephemeral_constraint(std::string_view text) {
    const auto c = extract_preserved_constraints(text);
    if (c.forbid_tests || c.forbid_skills || c.forbid_network || c.forbid_memory || c.single_file_only) {
        return true;
    }
    const auto low = ascii_lower(text);
    return contains_any(low, {
        "禁止任何测试", "禁止测试", "不写测试", "不允许调用skill", "禁止调用skill",
        "禁止联网", "不允许网络", "不要调用记忆", "不使用记忆",
        "单文件html", "写在一个文件", "不超过", "字以内", "少说话", "只输出json"
    });
}

struct CraftEvolutionEngine::Impl {
    fs::path data_root;
    fs::path craft_root;
    fs::path global_pitfalls_path;
    fs::path bots_dir;
    mutable std::mutex mutex;

    struct BotCraftProfile {
        std::vector<UserTasteHabit> habits;
        std::vector<TransferablePlaybook> playbooks;
    };

    explicit Impl(fs::path root)
        : data_root(std::move(root)),
          craft_root(data_root / L"craft-evolution"),
          global_pitfalls_path(craft_root / L"global-pitfalls.json"),
          bots_dir(craft_root / L"bots") {
        std::error_code ec;
        fs::create_directories(bots_dir, ec);
    }

    fs::path bot_profile_path(const std::string& bot_id) const {
        return bots_dir / utf8_path(bot_id) / L"craft-profile.json";
    }

    std::vector<PitfallAntibody> load_global_pitfalls_unlocked() const {
        std::vector<PitfallAntibody> list;
        const auto raw = read_text_file_safe(global_pitfalls_path);
        if (raw.empty()) return list;
        try {
            const auto doc = Json::parse(raw);
            if (const auto* arr = doc.find("pitfalls"); arr && arr->is_array()) {
                for (const auto& item : arr->as_array()) {
                    auto p = PitfallAntibody::from_json(item);
                    if (!p.trigger_signature.empty() && !p.remedy.empty()) {
                        list.push_back(std::move(p));
                    }
                }
            }
        } catch (...) {}
        return list;
    }

    void save_global_pitfalls_unlocked(const std::vector<PitfallAntibody>& list) const {
        std::error_code ec;
        fs::create_directories(global_pitfalls_path.parent_path(), ec);
        A arr;
        for (const auto& item : list) arr.push_back(item.to_json());
        write_utf8_atomic(global_pitfalls_path, Json(O{{"version", 1.0}, {"pitfalls", std::move(arr)}}).dump());
    }

    BotCraftProfile load_bot_profile_unlocked(const std::string& bot_id) const {
        BotCraftProfile prof;
        const auto raw = read_text_file_safe(bot_profile_path(bot_id));
        if (raw.empty()) return prof;
        try {
            const auto doc = Json::parse(raw);
            if (const auto* harr = doc.find("habits"); harr && harr->is_array()) {
                for (const auto& item : harr->as_array()) {
                    auto h = UserTasteHabit::from_json(item);
                    if (!h.preference.empty()) prof.habits.push_back(std::move(h));
                }
            }
            if (const auto* parr = doc.find("playbooks"); parr && parr->is_array()) {
                for (const auto& item : parr->as_array()) {
                    auto pb = TransferablePlaybook::from_json(item);
                    if (!pb.title.empty() && !pb.problem_archetype.empty()) prof.playbooks.push_back(std::move(pb));
                }
            }
        } catch (...) {}
        return prof;
    }

    void save_bot_profile_unlocked(const std::string& bot_id, const BotCraftProfile& prof) const {
        const auto path = bot_profile_path(bot_id);
        std::error_code ec;
        fs::create_directories(path.parent_path(), ec);
        A harr, parr;
        for (const auto& h : prof.habits) harr.push_back(h.to_json());
        for (const auto& pb : prof.playbooks) parr.push_back(pb.to_json());
        write_utf8_atomic(path, Json(O{
            {"version", 1.0},
            {"botId", bot_id},
            {"habits", std::move(harr)},
            {"playbooks", std::move(parr)}
        }).dump());
    }

    bool upsert_pitfall_unlocked(std::vector<PitfallAntibody>& list, PitfallAntibody incoming, std::int64_t ts) {
        incoming.trigger_signature = trim_str(incoming.trigger_signature);
        incoming.root_cause = trim_str(incoming.root_cause);
        incoming.remedy = trim_str(incoming.remedy);
        if (incoming.trigger_signature.empty() || incoming.remedy.empty()) return false;
        if (looks_like_ephemeral_constraint(incoming.remedy)) return false;

        if (incoming.domain_tags.empty()) {
            incoming.domain_tags = infer_domain_tags(incoming.trigger_signature + " " + incoming.remedy);
        }
        if (incoming.id.empty()) {
            incoming.id = "pit-" + stable_hash_hex(incoming.trigger_signature + "|" + incoming.remedy).substr(0, 12);
        }
        incoming.updated_at_ms = ts;

        for (auto& existing : list) {
            const double sim = LivingMemoryEngine::semantic_relevance(
                incoming.trigger_signature + " " + incoming.remedy,
                existing.trigger_signature + " " + existing.remedy);
            if (existing.id == incoming.id || sim >= 0.58) {
                existing.hit_count += 1;
                existing.strength = std::min(5.0, existing.strength + 0.35);
                if (incoming.remedy.size() >= existing.remedy.size() / 2) {
                    existing.remedy = incoming.remedy;
                }
                if (!incoming.root_cause.empty()) existing.root_cause = incoming.root_cause;
                for (const auto& t : incoming.domain_tags) {
                    if (std::find(existing.domain_tags.begin(), existing.domain_tags.end(), t) == existing.domain_tags.end()) {
                        existing.domain_tags.push_back(t);
                    }
                }
                existing.updated_at_ms = ts;
                return true;
            }
        }

        list.push_back(std::move(incoming));
        if (list.size() > 64) {
            std::sort(list.begin(), list.end(), [&](const PitfallAntibody& a, const PitfallAntibody& b) {
                return (a.strength * recency_factor(a.updated_at_ms, ts)) >
                       (b.strength * recency_factor(b.updated_at_ms, ts));
            });
            list.resize(64);
        }
        return true;
    }

    bool upsert_habit_unlocked(BotCraftProfile& prof, UserTasteHabit incoming, std::int64_t ts) {
        incoming.preference = trim_str(scrub_speech_constraints(incoming.preference));
        if (incoming.preference.size() < 6) return false;
        if (looks_like_ephemeral_constraint(incoming.preference)) return false;

        if (incoming.domain_tags.empty()) {
            incoming.domain_tags = infer_domain_tags(incoming.preference);
        }
        if (incoming.id.empty()) {
            incoming.id = "hab-" + stable_hash_hex(incoming.preference).substr(0, 12);
        }
        if (incoming.evidence_kind == "correction") {
            incoming.strength = std::max(incoming.strength, 1.5);
        }
        incoming.updated_at_ms = ts;

        for (auto& existing : prof.habits) {
            const double sim = LivingMemoryEngine::semantic_relevance(incoming.preference, existing.preference);
            if (existing.id == incoming.id || sim >= 0.55) {
                existing.reinforce_count += 1;
                existing.strength = std::min(5.0, existing.strength + (incoming.evidence_kind == "correction" ? 0.6 : 0.25));
                if (incoming.evidence_kind == "correction" || incoming.preference.size() >= existing.preference.size()) {
                    existing.preference = incoming.preference;
                    if (incoming.evidence_kind == "correction") existing.evidence_kind = "correction";
                }
                existing.updated_at_ms = ts;
                return true;
            }
        }

        prof.habits.push_back(std::move(incoming));
        if (prof.habits.size() > 32) {
            std::sort(prof.habits.begin(), prof.habits.end(), [&](const UserTasteHabit& a, const UserTasteHabit& b) {
                return (a.strength * recency_factor(a.updated_at_ms, ts)) >
                       (b.strength * recency_factor(b.updated_at_ms, ts));
            });
            prof.habits.resize(32);
        }
        return true;
    }

    bool upsert_playbook_unlocked(BotCraftProfile& prof, TransferablePlaybook incoming, std::int64_t ts, bool& newly_materialized) {
        newly_materialized = false;
        incoming.title = trim_str(incoming.title);
        incoming.problem_archetype = trim_str(scrub_speech_constraints(incoming.problem_archetype));
        incoming.quality_bar = trim_str(scrub_speech_constraints(incoming.quality_bar));
        if (incoming.title.empty() || incoming.problem_archetype.empty() || incoming.core_steps.empty()) return false;
        if (looks_like_ephemeral_constraint(incoming.problem_archetype) || looks_like_ephemeral_constraint(incoming.quality_bar)) {
            return false;
        }
        std::erase_if(incoming.core_steps, [](const std::string& step) {
            return trim_str(step).empty() || looks_like_ephemeral_constraint(step);
        });
        if (incoming.core_steps.empty()) return false;

        if (incoming.domain_tags.empty()) {
            incoming.domain_tags = infer_domain_tags(incoming.title + " " + incoming.problem_archetype);
        }
        incoming.slug = sanitize_ascii_slug(incoming.slug, incoming.title + "|" + incoming.problem_archetype);
        if (incoming.id.empty()) {
            incoming.id = "pb-" + stable_hash_hex(incoming.slug).substr(0, 12);
        }
        incoming.updated_at_ms = ts;

        for (auto& existing : prof.playbooks) {
            const double sim = LivingMemoryEngine::semantic_relevance(
                incoming.title + " " + incoming.problem_archetype,
                existing.title + " " + existing.problem_archetype);
            if (existing.slug == incoming.slug || existing.id == incoming.id || sim >= 0.56) {
                existing.success_count += 1;
                existing.strength = std::min(5.0, existing.strength + 0.45);
                if (incoming.core_steps.size() >= existing.core_steps.size()) {
                    existing.core_steps = incoming.core_steps;
                }
                if (!incoming.quality_bar.empty()) existing.quality_bar = incoming.quality_bar;
                if (!incoming.problem_archetype.empty() && incoming.problem_archetype.size() >= existing.problem_archetype.size() / 2) {
                    existing.problem_archetype = incoming.problem_archetype;
                }
                for (const auto& t : incoming.domain_tags) {
                    if (std::find(existing.domain_tags.begin(), existing.domain_tags.end(), t) == existing.domain_tags.end()) {
                        existing.domain_tags.push_back(t);
                    }
                }
                existing.updated_at_ms = ts;
                if (!existing.materialized_skill && (existing.success_count >= 2 || existing.strength >= 1.35)) {
                    existing.materialized_skill = true;
                    newly_materialized = true;
                }
                return true;
            }
        }

        if (incoming.success_count >= 2 || incoming.strength >= 1.35) {
            incoming.materialized_skill = true;
            newly_materialized = true;
        }
        prof.playbooks.push_back(std::move(incoming));
        if (prof.playbooks.size() > 24) {
            std::sort(prof.playbooks.begin(), prof.playbooks.end(), [&](const TransferablePlaybook& a, const TransferablePlaybook& b) {
                return (a.strength * recency_factor(a.updated_at_ms, ts)) >
                       (b.strength * recency_factor(b.updated_at_ms, ts));
            });
            prof.playbooks.resize(24);
        }
        return true;
    }

    void sync_skills_on_disk_unlocked(const std::string& bot_id, const BotCraftProfile& prof, bool forbid_skills) const {
        if (bot_id.empty()) return;
        const fs::path bot_cli_root = data_root / L"cli-homes" / utf8_path(bot_id);
        const fs::path bot_work_agent_root = data_root / L"work-agents" / utf8_path(bot_id);
        const std::vector<fs::path> active_skill_roots{
            bot_cli_root / L"hermes" / L"skills",
            bot_cli_root / L"skills",
            bot_work_agent_root / L"hermes" / L"skills"
        };

        std::error_code ec;
        for (const auto& sroot : active_skill_roots) {
            if (fs::is_directory(sroot, ec)) {
                for (const auto& entry : fs::directory_iterator(sroot, ec)) {
                    if (!entry.is_directory(ec)) continue;
                    const auto name = path_utf8(entry.path().filename());
                    if (name.starts_with("auto-")) {
                        if (forbid_skills) {
                            fs::remove_all(entry.path(), ec);
                        }
                    }
                }
            }
            if (!forbid_skills) {
                for (const auto& pb : prof.playbooks) {
                    if (!pb.materialized_skill) continue;
                    const fs::path dir = sroot / utf8_path("auto-" + pb.slug);
                    fs::create_directories(dir, ec);
                    write_utf8_atomic(dir / L"SKILL.md", format_skill_markdown(pb, bot_id));
                }
            }
        }
    }
};

CraftEvolutionEngine::CraftEvolutionEngine(std::filesystem::path data_root)
    : impl_(std::make_unique<Impl>(std::move(data_root))) {}

CraftEvolutionEngine::~CraftEvolutionEngine() = default;

void CraftEvolutionEngine::upsert_global_pitfall(PitfallAntibody antibody, std::optional<std::int64_t> now_ms) {
    const auto ts = now_ms.value_or(current_epoch_ms());
    std::lock_guard lk(impl_->mutex);
    auto list = impl_->load_global_pitfalls_unlocked();
    if (impl_->upsert_pitfall_unlocked(list, std::move(antibody), ts)) {
        impl_->save_global_pitfalls_unlocked(list);
    }
}

void CraftEvolutionEngine::upsert_bot_habit(const std::string& bot_id, UserTasteHabit habit, std::optional<std::int64_t> now_ms) {
    if (bot_id.empty()) return;
    const auto ts = now_ms.value_or(current_epoch_ms());
    std::lock_guard lk(impl_->mutex);
    auto prof = impl_->load_bot_profile_unlocked(bot_id);
    if (impl_->upsert_habit_unlocked(prof, std::move(habit), ts)) {
        impl_->save_bot_profile_unlocked(bot_id, prof);
    }
}

void CraftEvolutionEngine::upsert_bot_playbook(const std::string& bot_id, TransferablePlaybook playbook, std::optional<std::int64_t> now_ms) {
    if (bot_id.empty()) return;
    const auto ts = now_ms.value_or(current_epoch_ms());
    std::lock_guard lk(impl_->mutex);
    auto prof = impl_->load_bot_profile_unlocked(bot_id);
    bool newly_mat = false;
    if (impl_->upsert_playbook_unlocked(prof, std::move(playbook), ts, newly_mat)) {
        impl_->save_bot_profile_unlocked(bot_id, prof);
        impl_->sync_skills_on_disk_unlocked(bot_id, prof, false);
    }
}

void CraftEvolutionEngine::sync_bot_cli_skills(const std::string& bot_id, bool forbid_skills) const {
    if (bot_id.empty()) return;
    std::lock_guard lk(impl_->mutex);
    const auto prof = impl_->load_bot_profile_unlocked(bot_id);
    impl_->sync_skills_on_disk_unlocked(bot_id, prof, forbid_skills);
}

CraftDistillationOutcome CraftEvolutionEngine::distill_from_run(
    const WorkRunTraceSample& sample,
    const ModelCaller& caller,
    std::optional<std::int64_t> now_ms,
    std::stop_token stop) {
    CraftDistillationOutcome outcome;
    if (sample.bot_id.empty() || sample.user_inputs.empty()) return outcome;
    if (sample.user_inputs.front().starts_with("APPTEST:")) return outcome;

    // Respect user boundary: if user explicitly forbade memory on this run, do not distill from it either.
    std::string combined_inputs;
    for (const auto& inp : sample.user_inputs) {
        if (!combined_inputs.empty()) combined_inputs += "\n";
        combined_inputs += inp;
    }
    const auto constraints = extract_preserved_constraints(combined_inputs);
    if (constraints.forbid_memory) return outcome;

    const auto ts = now_ms.value_or(current_epoch_ms());
    const auto inferred_tags = infer_domain_tags(
        combined_inputs + "\n" + sample.final_response, sample.platform_hint);

    std::vector<PitfallAntibody> extracted_pitfalls;
    std::vector<UserTasteHabit> extracted_habits;
    std::vector<TransferablePlaybook> extracted_playbooks;

    // Try high-precision Chat-slot LLM abstraction first when available
    if (caller && !stop.stop_requested() &&
        (sample.completed_successfully || sample.user_inputs.size() > 1 || !sample.failed_tool_summaries.empty())) {
        try {
            const std::string sys_prompt =
                "你是工匠经验蒸馏与举一反十方法论提炼引擎。请从本次完成的工程任务轨迹中提炼可跨任务长期复用的经验，严格只输出一个 JSON 对象，格式如下：\n"
                "{\n"
                "  \"pitfalls\": [{\"triggerSignature\":\"触发报错或环境陷阱特征\",\"rootCause\":\"根因\",\"remedy\":\"一次到位的通用预防或解法\",\"domainTags\":[\"windows\",\"cpp-native\"]}],\n"
                "  \"habits\": [{\"preference\":\"用户稳定的审美/交互/工程习惯偏好\",\"evidenceKind\":\"correction或delivery\"}],\n"
                "  \"playbook\": {\"slug\":\"english-kebab-slug\",\"title\":\"去业务化的通用战法标题\",\"problemArchetype\":\"该战法可举一反十迁移解决的整类问题母型\",\"coreSteps\":[\"步骤1\",\"步骤2\",\"步骤3\"],\"qualityBar\":\"通用验收标准\"}\n"
                "}\n"
                "【硬铁律】：\n"
                "1. 去业务化抽象（举一反十核心）：playbook 严禁死记本次具体业务名词（如查某特定软件名或写某特定页面），必须升维成同母类问题皆可套用的通用方法论！若本轮只是极简单闲聊问答无方法论价值，playbook 设为 null。\n"
                "2. 严禁污染：任何单次临时边界（如‘禁止测试’、‘单文件HTML’、‘禁止调用skills’、‘不联网’、字数限制）绝不能写入 habits 或 playbook！\n"
                "3. pitfalls 仅在轨迹中确实克服了环境/命令/编译/路径陷阱时提炼，无踩坑则输出空数组 []。";

            std::ostringstream usr;
            usr << "【运行平台】" << (sample.platform_hint.empty() ? "auto" : sample.platform_hint) << "\n";
            usr << "【用户历次输入（若有多条则含中途纠偏）】\n";
            for (std::size_t i = 0; i < sample.user_inputs.size(); ++i) {
                usr << "  [" << (i + 1) << "] " << safe_clip_utf8(sample.user_inputs[i], 500) << "\n";
            }
            if (!sample.failed_tool_summaries.empty()) {
                usr << "【中途遭遇并克服的错误/陷阱】\n";
                for (const auto& f : sample.failed_tool_summaries) {
                    usr << "  - " << safe_clip_utf8(f, 360) << "\n";
                }
            }
            if (!sample.succeeded_tool_summaries.empty()) {
                usr << "【关键成功操作链】\n";
                for (std::size_t i = 0; i < std::min<std::size_t>(8, sample.succeeded_tool_summaries.size()); ++i) {
                    usr << "  - " << safe_clip_utf8(sample.succeeded_tool_summaries[i], 240) << "\n";
                }
            }
            if (!sample.changed_files.empty()) {
                usr << "【产出/修改文件】";
                for (std::size_t i = 0; i < std::min<std::size_t>(10, sample.changed_files.size()); ++i) {
                    if (i > 0) usr << ", ";
                    usr << sample.changed_files[i];
                }
                usr << "\n";
            }
            usr << "【最终交付摘要】\n" << safe_clip_utf8(sample.final_response, 900);

            const auto raw_reply = caller(sys_prompt, usr.str(), stop);
            const auto json_str = extract_first_json_object(raw_reply);
            if (!json_str.empty()) {
                const auto parsed = Json::parse(json_str);
                outcome.used_model = true;
                if (const auto* parr = parsed.find("pitfalls"); parr && parr->is_array()) {
                    for (const auto& item : parr->as_array()) {
                        auto p = PitfallAntibody::from_json(item);
                        p.source_bot_id = sample.bot_id;
                        if (p.domain_tags.empty()) p.domain_tags = inferred_tags;
                        extracted_pitfalls.push_back(std::move(p));
                    }
                }
                if (const auto* harr = parsed.find("habits"); harr && harr->is_array()) {
                    for (const auto& item : harr->as_array()) {
                        auto h = UserTasteHabit::from_json(item);
                        if (h.domain_tags.empty()) h.domain_tags = inferred_tags;
                        extracted_habits.push_back(std::move(h));
                    }
                }
                if (const auto* pbj = parsed.find("playbook"); pbj && pbj->is_object()) {
                    auto pb = TransferablePlaybook::from_json(*pbj);
                    if (pb.domain_tags.empty()) pb.domain_tags = inferred_tags;
                    pb.strength = sample.user_inputs.size() > 1 ? 1.4 : 1.15;
                    extracted_playbooks.push_back(std::move(pb));
                }
            }
        } catch (...) {
            // Fall through cleanly to deterministic distillation below
        }
    }

    // Deterministic fallback & signal reinforcement (guarantees offline & unit-test reliability)
    if (!outcome.used_model) {
        // Signal A: Mid-turn user corrections -> high-priority per-Bot habit
        for (std::size_t i = 1; i < sample.user_inputs.size(); ++i) {
            const auto& corr = sample.user_inputs[i];
            if (corr.starts_with("[[MEMBER_CALLBACK]]")) continue;
            if (looks_like_user_correction(corr) && !looks_like_ephemeral_constraint(corr)) {
                UserTasteHabit h;
                h.domain_tags = inferred_tags;
                h.evidence_kind = "correction";
                h.strength = 1.6;
                h.preference = "注意用户纠偏倾向：「" + safe_clip_utf8(trim_str(corr), 160) +
                               "」（避免误判为：" + safe_clip_utf8(trim_str(sample.user_inputs[0]), 80) + "）";
                extracted_habits.push_back(std::move(h));
            }
        }

        // Signal B: Overcome tool/CLI errors -> Global shared pitfall antibody
        if (sample.completed_successfully && !sample.failed_tool_summaries.empty()) {
            PitfallAntibody anti;
            anti.domain_tags = inferred_tags;
            anti.source_bot_id = sample.bot_id;
            anti.trigger_signature = safe_clip_utf8(sample.failed_tool_summaries.front(), 180);
            anti.root_cause = "执行过程中曾触发命令或环境报错，经后续步骤修正后通过验收";
            if (!sample.succeeded_tool_summaries.empty()) {
                anti.remedy = "避开上述失败调用方式，优先采用已验证通过的路径：" +
                              safe_clip_utf8(sample.succeeded_tool_summaries.back(), 180);
            } else {
                anti.remedy = "执行前先核验目标路径、运行环境与参数格式，参考最终通过方案：" +
                              safe_clip_utf8(sample.final_response, 160);
            }
            extracted_pitfalls.push_back(std::move(anti));
        }

        // Signal C: Transferable archetype playbook synthesis on substantial completed work
        if (sample.completed_successfully &&
            (!sample.succeeded_tool_summaries.empty() || !sample.changed_files.empty() || sample.final_response.size() >= 120)) {
            TransferablePlaybook pb;
            pb.domain_tags = inferred_tags;
            const auto has_tag = [&](std::string_view t) {
                return std::find(inferred_tags.begin(), inferred_tags.end(), t) != inferred_tags.end();
            };
            if (has_tag("system-inspection")) {
                pb.slug = "client-runtime-readonly-inspection";
                pb.title = "本地客户端与服务运行机制只读摸底战法";
                pb.problem_archetype = "当需要调查任意桌面客户端、CLI 工具或本地后台服务如何启动、配置、调度与落盘时";
                pb.core_steps = {
                    "先只读定位安装路径、配置文件目录（AppData / HOME）与最近运行日志，零副作用不改写原状态",
                    "核查实际可执行文件、子进程拉起参数、模型/权限配置与环境变量约定",
                    "区分已验证的实跑证据与未登录/缺失凭据边界，输出带精确路径引用的结构化结论"
                };
                pb.quality_bar = "全程只读零侵入，所有结论对应真实配置、日志或命令输出，不猜测未观测状态";
            } else if (has_tag("frontend-ui")) {
                pb.slug = "modular-interactive-ui-craft";
                pb.title = "高完成度交互界面模块化构建战法";
                pb.problem_archetype = "当需要设计并实现网页应用、可视化面板、交互组件或前端样式升级时";
                pb.core_steps = {
                    "先对齐视觉层级、色彩令牌与核心交互状态机（空态/加载态/激活态/深浅主题适配）",
                    "按职责清晰拆分结构、样式与状态逻辑，保持真实可交互的数据流与键盘鼠标无障碍体验",
                    "落盘后静态校验脚本语法与资源相对路径，确保直接打开或挂载即可零报错运行"
                };
                pb.quality_bar = "交互闭环完整、视觉克制精致、无悬空占位按钮或语法异常";
            } else if (has_tag("cpp-native")) {
                pb.slug = "native-cpp-safe-incremental-build";
                pb.title = "原生 C++ 模块增量演进与回归验证战法";
                pb.problem_archetype = "当需要在 C++/CMake/MSVC 原生工程中新增能力、修改头文件契约并保障全量测试回归时";
                pb.core_steps = {
                    "先阅读既有头文件接口与单测契约，新增可选字段保持默认值向后兼容",
                    "采用局部精准编辑实现核心逻辑，注意清理受头文件布局变更影响的旧目标文件防 ABI 错位",
                    "编写覆盖边界条件的独立单元测试并跑通全量回归套件后再交付"
                };
                pb.quality_bar = "零破坏既有测试契约，编译链接零错误，并发与资源生命周期由 RAII 严格托管";
            } else {
                pb.slug = "structured-engineering-delivery";
                pb.title = "结构化工程拆解与闭环核验战法";
                pb.problem_archetype = "当面对综合性编码开发、脚本自动化、仓库改造或深度技术方案推演任务时";
                pb.core_steps = {
                    "先摸清工作区现状与用户显式边界约束，先定清晰骨架再填实现细节",
                    "优先复用成熟工具链做最小侵入式实现，分离最终交付成品与临时推演草稿",
                    "对核心产出执行真实核验，如实说明运行入口与已验证范围"
                };
                pb.quality_bar = "边界严守、成品干净即用、结论有据可查";
            }
            pb.strength = 1.2;
            extracted_playbooks.push_back(std::move(pb));
        }
    }

    std::lock_guard lk(impl_->mutex);
    if (!extracted_pitfalls.empty()) {
        auto global_list = impl_->load_global_pitfalls_unlocked();
        bool changed = false;
        for (auto& p : extracted_pitfalls) {
            if (impl_->upsert_pitfall_unlocked(global_list, std::move(p), ts)) {
                ++outcome.global_pitfalls_upserted;
                changed = true;
            }
        }
        if (changed) impl_->save_global_pitfalls_unlocked(global_list);
    }

    if (!extracted_habits.empty() || !extracted_playbooks.empty()) {
        auto prof = impl_->load_bot_profile_unlocked(sample.bot_id);
        bool changed = false;
        for (auto& h : extracted_habits) {
            if (impl_->upsert_habit_unlocked(prof, std::move(h), ts)) {
                ++outcome.bot_habits_upserted;
                changed = true;
            }
        }
        for (auto& pb : extracted_playbooks) {
            bool newly_mat = false;
            if (impl_->upsert_playbook_unlocked(prof, std::move(pb), ts, newly_mat)) {
                ++outcome.bot_playbooks_upserted;
                if (newly_mat) ++outcome.skills_materialized;
                changed = true;
            }
        }
        if (changed) {
            impl_->save_bot_profile_unlocked(sample.bot_id, prof);
            impl_->sync_skills_on_disk_unlocked(sample.bot_id, prof, constraints.forbid_skills);
        }
    }

    return outcome;
}

CraftRecallSelection CraftEvolutionEngine::recall_for_task(
    const std::string& bot_id,
    std::string_view task_prompt,
    const PreservedConstraintSet& constraints,
    std::string_view platform_hint,
    std::optional<std::int64_t> now_ms) const {
    CraftRecallSelection sel;
    if (bot_id.empty() || trim_str(task_prompt).empty() || constraints.forbid_memory) {
        return sel;
    }

    const auto ts = now_ms.value_or(current_epoch_ms());
    const auto query_tags = infer_domain_tags(task_prompt, platform_hint);

    std::vector<PitfallAntibody> all_pitfalls;
    Impl::BotCraftProfile prof;
    {
        std::lock_guard lk(impl_->mutex);
        all_pitfalls = impl_->load_global_pitfalls_unlocked();
        prof = impl_->load_bot_profile_unlocked(bot_id);
    }

    // 1. Score & select Top-2 transferable playbooks ("举一反十": matches either direct semantics OR domain archetype!)
    struct ScoredPlaybook {
        double score = 0.0;
        TransferablePlaybook item;
    };
    std::vector<ScoredPlaybook> scored_pbs;
    for (const auto& pb : prof.playbooks) {
        if (constraints.forbid_skills && pb.materialized_skill) {
            // Still allow internal methodological recall unless memory is forbidden, just don't invoke external SKILL files
        }
        const double sem = LivingMemoryEngine::semantic_relevance(
            task_prompt, pb.title + " " + pb.problem_archetype);
        const double tag_sim = tag_overlap_score(query_tags, pb.domain_tags);
        const double raw_match = std::max(sem, tag_sim * 0.72 + sem * 0.45);
        if (raw_match < 0.22) continue;
        const double final_score = raw_match * (0.75 + 0.25 * std::min(3.0, pb.strength)) * recency_factor(pb.updated_at_ms, ts);
        scored_pbs.push_back({final_score, pb});
    }
    std::sort(scored_pbs.begin(), scored_pbs.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
    for (std::size_t i = 0; i < std::min<std::size_t>(2, scored_pbs.size()); ++i) {
        sel.playbooks.push_back(scored_pbs[i].item);
    }

    // 2. Score & select Top-3 per-Bot user taste habits
    struct ScoredHabit {
        double score = 0.0;
        UserTasteHabit item;
    };
    std::vector<ScoredHabit> scored_habits;
    for (const auto& h : prof.habits) {
        const double sem = LivingMemoryEngine::semantic_relevance(task_prompt, h.preference);
        const double tag_sim = tag_overlap_score(query_tags, h.domain_tags);
        const double base = std::max(sem, tag_sim * 0.65) + (h.evidence_kind == "correction" ? 0.12 : 0.0);
        if (base < 0.20) continue;
        const double final_score = base * (0.7 + 0.3 * std::min(3.0, h.strength)) * recency_factor(h.updated_at_ms, ts);
        scored_habits.push_back({final_score, h});
    }
    std::sort(scored_habits.begin(), scored_habits.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
    for (std::size_t i = 0; i < std::min<std::size_t>(3, scored_habits.size()); ++i) {
        sel.habits.push_back(scored_habits[i].item);
    }

    // 3. Score & select Top-3 global shared pitfall antibodies
    struct ScoredPitfall {
        double score = 0.0;
        PitfallAntibody item;
    };
    std::vector<ScoredPitfall> scored_pits;
    for (const auto& p : all_pitfalls) {
        const double sem = LivingMemoryEngine::semantic_relevance(
            task_prompt, p.trigger_signature + " " + p.remedy);
        const double tag_sim = tag_overlap_score(query_tags, p.domain_tags);
        const double raw_match = std::max(sem, tag_sim * 0.70 + sem * 0.40);
        if (raw_match < 0.24) continue;
        const double final_score = raw_match * (0.75 + 0.25 * std::min(3.0, p.strength)) * recency_factor(p.updated_at_ms, ts);
        scored_pits.push_back({final_score, p});
    }
    std::sort(scored_pits.begin(), scored_pits.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
    for (std::size_t i = 0; i < std::min<std::size_t>(3, scored_pits.size()); ++i) {
        sel.global_pitfalls.push_back(scored_pits[i].item);
    }

    if (sel.playbooks.empty() && sel.habits.empty() && sel.global_pitfalls.empty()) {
        return sel;
    }

    // Format compact, silent background internalization block (< 1400 bytes, never boasts about "using memory")
    std::ostringstream out;
    out << "【内化实战经验与全局防坑直觉（静默融入执行，勿在回复中生硬提及“根据记忆/战法库”；若与当前用户显式要求冲突，一律以当前要求为准）】";
    std::size_t budget = 1600;

    auto append_bounded = [&](const std::string& line) {
        if (line.size() > budget) return false;
        budget -= line.size();
        out << "\n" << line;
        return true;
    };

    for (const auto& pb : sel.playbooks) {
        std::string steps_joined;
        for (std::size_t i = 0; i < std::min<std::size_t>(4, pb.core_steps.size()); ++i) {
            if (i > 0) steps_joined += " → ";
            steps_joined += safe_clip_utf8(pb.core_steps[i], 120);
        }
        append_bounded("- [可迁移母版战法·" + safe_clip_utf8(pb.title, 96) + "] " + steps_joined +
                       (pb.quality_bar.empty() ? "" : "（标尺：" + safe_clip_utf8(pb.quality_bar, 100) + "）"));
    }
    for (const auto& h : sel.habits) {
        append_bounded("- [默契偏好] " + safe_clip_utf8(h.preference, 160));
    }
    for (const auto& p : sel.global_pitfalls) {
        append_bounded("- [全局避坑·" + safe_clip_utf8(p.trigger_signature, 72) + "] → " + safe_clip_utf8(p.remedy, 140));
    }

    sel.silent_prompt_block = out.str();
    return sel;
}

Json CraftEvolutionEngine::inspect_bot(const std::string& bot_id) const {
    std::lock_guard lk(impl_->mutex);
    const auto prof = impl_->load_bot_profile_unlocked(bot_id);
    const auto pits = impl_->load_global_pitfalls_unlocked();
    A harr, parr, garr;
    for (const auto& h : prof.habits) harr.push_back(h.to_json());
    for (const auto& pb : prof.playbooks) parr.push_back(pb.to_json());
    for (const auto& p : pits) garr.push_back(p.to_json());
    return O{
        {"botId", bot_id},
        {"habits", std::move(harr)},
        {"playbooks", std::move(parr)},
        {"globalPitfalls", std::move(garr)}
    };
}

std::vector<PitfallAntibody> CraftEvolutionEngine::list_global_pitfalls() const {
    std::lock_guard lk(impl_->mutex);
    return impl_->load_global_pitfalls_unlocked();
}

} // namespace dimension
