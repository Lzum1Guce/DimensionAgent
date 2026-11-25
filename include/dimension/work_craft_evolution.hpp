#pragma once

#include "dimension/json.hpp"
#include "dimension/model.hpp"
#include "dimension/work_cli_broker.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

// Global cross-Bot shared pitfall antibody: once any Bot hits an environmental,
// toolchain, encoding, or runtime trap and resolves it, every Bot gains immunity.
struct PitfallAntibody {
    std::string id;
    std::vector<std::string> domain_tags; // e.g. ["windows", "cpp", "msvc", "powershell"]
    std::string trigger_signature;        // Scenario or error symptom that triggers this trap
    std::string root_cause;               // Concise root cause explanation
    std::string remedy;                   // Proven one-shot solution / prevention rule
    std::string source_bot_id;            // Bot that first discovered & solved it
    int hit_count = 1;
    double strength = 1.0;
    std::int64_t updated_at_ms = 0;

    Json to_json() const;
    static PitfallAntibody from_json(const Json& j);
};

// Per-Bot independently cultivated user taste & working habit preference.
struct UserTasteHabit {
    std::string id;
    std::vector<std::string> domain_tags;
    std::string preference;               // Distilled durable engineering/aesthetic preference
    std::string evidence_kind;            // "correction" (high weight) | "delivery"
    int reinforce_count = 1;
    double strength = 1.0;
    std::int64_t updated_at_ms = 0;

    Json to_json() const;
    static UserTasteHabit from_json(const Json& j);
};

// Per-Bot independently cultivated transferable playbook ("舉一反十" methodology).
// Abstracts concrete one-off tasks into reusable cross-problem structural patterns,
// and materializes high-confidence playbooks into isolated native CLI SKILL.md files.
struct TransferablePlaybook {
    std::string id;
    std::string slug;                     // ASCII slug used for materialized SKILL.md folder
    std::string title;                    // Methodological title, e.g. "桌面客户端只读运行机制摸底法"
    std::string problem_archetype;        // Class of problems this generalizes to ("举一反十" trigger)
    std::vector<std::string> domain_tags;
    std::vector<std::string> core_steps;  // 3-5 transferable execution steps
    std::string quality_bar;              // Reusable verification & quality standard
    int success_count = 1;
    double strength = 1.0;
    bool materialized_skill = false;
    std::int64_t updated_at_ms = 0;

    Json to_json() const;
    static TransferablePlaybook from_json(const Json& j);
};

struct WorkRunTraceSample {
    std::string run_id;
    std::string bot_id;
    std::string bot_name;
    std::string bot_persona;
    std::string group_id;
    std::string platform_hint;            // "windows" or "wsl"
    std::vector<std::string> user_inputs; // Chronological user prompts (>1 indicates mid-task steering/correction!)
    std::vector<std::string> failed_tool_summaries;   // Intermediate errors overcome during the run
    std::vector<std::string> succeeded_tool_summaries;// Key verified actions / commands
    std::vector<std::string> changed_files;
    std::string final_response;
    bool completed_successfully = false;
};

struct CraftDistillationOutcome {
    std::size_t global_pitfalls_upserted = 0;
    std::size_t bot_habits_upserted = 0;
    std::size_t bot_playbooks_upserted = 0;
    std::size_t skills_materialized = 0;
    bool used_model = false;
    Json to_json() const;
};

struct CraftRecallSelection {
    std::vector<TransferablePlaybook> playbooks;
    std::vector<UserTasteHabit> habits;
    std::vector<PitfallAntibody> global_pitfalls;
    std::string silent_prompt_block;      // Compact (<1400 bytes) silent guidance injected into Work/CLI brief
};

class CraftEvolutionEngine final {
public:
    using ModelCaller = std::function<std::string(const std::string& system_prompt,
                                                  const std::string& user_prompt,
                                                  std::stop_token stop)>;

    // `data_root` is Dimension's persistent data root (e.g. L:\DimensionAgent\native-data-v1).
    // Stores:
    //   - <data_root>/craft-evolution/global-pitfalls.json (shared across all Bots)
    //   - <data_root>/craft-evolution/bots/<bot_id>/craft-profile.json (independent per Bot)
    //   - <data_root>/cli-homes/<bot_id>/hermes/skills/<slug>/SKILL.md (materialized native CLI skills)
    explicit CraftEvolutionEngine(std::filesystem::path data_root);
    ~CraftEvolutionEngine();

    CraftEvolutionEngine(const CraftEvolutionEngine&) = delete;
    CraftEvolutionEngine& operator=(const CraftEvolutionEngine&) = delete;

    // 1. Silent post-run / post-correction distillation:
    //    - Strips one-off hard constraints (e.g. "禁止测试", "单文件HTML") so temporary boundaries
    //      NEVER pollute long-term habits or playbooks;
    //    - Extracts mid-turn user corrections into high-priority per-Bot habits;
    //    - Extracts overcome tool/CLI failures into the global shared pitfall library;
    //    - Abstracts successful engineering/research workflows into generalizable "举一反十" playbooks
    //      and materializes proven playbooks as native SKILL.md files in the Bot's isolated CLI homes.
    CraftDistillationOutcome distill_from_run(
        const WorkRunTraceSample& sample,
        const ModelCaller& caller = {},
        std::optional<std::int64_t> now_ms = {},
        std::stop_token stop = {});

    // 2. Silent pre-task recall:
    //    - Respects `constraints.forbid_memory` (returns empty immediately when forbidden);
    //    - Recalls Top-2 transferable playbooks + Top-3 habits from `bot_id`'s private profile,
    //      plus Top-3 matching antibodies from the global shared pitfall library;
    //    - Formats a bounded, silent background guidance block ready for CLI / prompt injection.
    [[nodiscard]] CraftRecallSelection recall_for_task(
        const std::string& bot_id,
        std::string_view task_prompt,
        const PreservedConstraintSet& constraints = {},
        std::string_view platform_hint = {},
        std::optional<std::int64_t> now_ms = {}) const;

    // 3. Synchronizes materialized SKILL.md files for `bot_id` into its isolated CLI home directories
    //    (or temporarily unstages auto-evolved skills if `forbid_skills` is active for this run).
    void sync_bot_cli_skills(const std::string& bot_id, bool forbid_skills = false) const;

    // Direct programmatic upsert helpers (used by tests and explicit learning hooks).
    void upsert_global_pitfall(PitfallAntibody antibody, std::optional<std::int64_t> now_ms = {});
    void upsert_bot_habit(const std::string& bot_id, UserTasteHabit habit, std::optional<std::int64_t> now_ms = {});
    void upsert_bot_playbook(const std::string& bot_id, TransferablePlaybook playbook, std::optional<std::int64_t> now_ms = {});

    // Inspection snapshot for diagnostics & unit verification.
    [[nodiscard]] Json inspect_bot(const std::string& bot_id) const;
    [[nodiscard]] std::vector<PitfallAntibody> list_global_pitfalls() const;

    // Exposed deterministic domain & relevance helpers for unit testing.
    [[nodiscard]] static std::vector<std::string> infer_domain_tags(std::string_view text, std::string_view platform_hint = {});
    [[nodiscard]] static bool looks_like_ephemeral_constraint(std::string_view text);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
