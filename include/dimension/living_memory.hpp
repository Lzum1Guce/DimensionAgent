#pragma once

#include "dimension/json.hpp"
#include "dimension/model.hpp"
#include "dimension/store.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

enum class MemoryVisibility {
    PublicSelf,    // Safe general preferences/facts that this Bot can carry into group chats
    PrivateSecret  // Strictly 1v1 private confidences; never recalled into group prompts
};

struct WorkBridgeEpisode {
    std::string run_id;
    std::string bot_id;
    std::string group_id;
    std::string group_name;
    std::string participants;
    std::string task_brief;
    std::string outcome_summary;
    std::int64_t completed_at_ms{0};
};

struct AffectRapportState {
    std::string mood_warmth;    // Natural-language emotional afterglow (~100 chars, auto-calms over time)
    std::string rapport_notes;  // Shared banter, communication rhythm & unspoken rapport (~160 chars)
    std::int64_t updated_at_ms{0};
};

struct CoreMindSnapshot {
    std::string perception;     // 1. 当下感知与潜台词
    std::string memory_digest;  // 2. 记忆提炼与冲突归并
    std::string relation_shift; // 3. 关系与群友印象演化
    std::string reflection;     // 4. 复盘自省
    std::int64_t updated_at_ms{0};
};

struct DistillationResult {
    std::size_t facts_proposed{0};
    std::size_t mid_added{0};
    std::size_t private_tagged{0};
    std::size_t filtered_retracted{0};
    bool mood_updated{false};
    bool used_model{false};
};

struct ConsolidationReport {
    std::size_t promoted_mid_count{0};
    std::size_t merged_duplicate_count{0};
    std::size_t expired_mid_cleaned{0};
    std::size_t conflicts_resolved{0};
    bool mind_refreshed{false};
};

class LivingMemoryEngine final {
public:
    using ModelFn = std::function<std::string(const std::string& system_prompt, const std::string& user_prompt)>;

    LivingMemoryEngine(Store& store, std::filesystem::path state_root);
    ~LivingMemoryEngine();

    LivingMemoryEngine(const LivingMemoryEngine&) = delete;
    LivingMemoryEngine& operator=(const LivingMemoryEngine&) = delete;

    // Builds the complete L0 (Core Relation + Mood/Rapport) + L1 (Hybrid Semantic/BM25/Decay
    // + Dual-Scope Privacy Bridging + Work Episode Bridge) prompt with natural relative time tags.
    [[nodiscard]] std::string build_prompt(
        const std::string& bot_id,
        const std::string& group_id,
        const std::string& query,
        const std::set<Id>& muted_ids = {},
        std::optional<std::int64_t> now_ms = {},
        bool chat_affect_softening = false) const;

    // Records a completed Work collaboration into the Bot's cross-mode episodic memory bridge.
    void record_work_episode(const WorkBridgeEpisode& episode);

    // Distills recent Chat turns into clean atomic facts, TTL-bounded MidMemories, privacy tags,
    // and subtle mood/rapport updates.
    [[nodiscard]] DistillationResult distill_recent_chat(
        const std::string& bot_id,
        const std::string& group_id,
        const ModelFn& model_fn = {},
        std::optional<std::int64_t> now_ms = {});

    // Sleep-cycle memory metabolism: promotes high-strength MidMemories, deduplicates redundant
    // confirmed memories, resolves contradictions, cleans stale expired MidMemories,
    // and refreshes the 4-Core Mind Loop snapshot.
    [[nodiscard]] ConsolidationReport consolidate(
        const std::string& bot_id,
        const std::string& group_id,
        const ModelFn& model_fn = {},
        std::optional<std::int64_t> now_ms = {});

    [[nodiscard]] MemoryVisibility visibility_of(
        const std::string& bot_id, Id memory_id, std::string_view text_hint = {}) const;

    void set_visibility(const std::string& bot_id, Id memory_id, MemoryVisibility visibility);

    [[nodiscard]] AffectRapportState affect_state(const std::string& bot_id) const;

    AffectRapportState update_affect_state(
        const std::string& bot_id,
        std::optional<std::string> mood_warmth,
        std::optional<std::string> rapport_notes,
        std::optional<std::int64_t> now_ms = {});

    [[nodiscard]] CoreMindSnapshot mind_snapshot(const std::string& bot_id) const;

    // Full state payload for UI inspection & management (Memory modal + 4-Core Mind Loop modal).
    [[nodiscard]] Json inspect_json(
        const std::string& bot_id,
        const std::string& group_id = "",
        std::optional<std::int64_t> now_ms = {}) const;

    // Helpers exposed for deterministic unit testing.
    [[nodiscard]] static double semantic_relevance(std::string_view query, std::string_view document);
    [[nodiscard]] static std::string format_relative_time_zh(std::int64_t target_ms, std::int64_t now_ms);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
