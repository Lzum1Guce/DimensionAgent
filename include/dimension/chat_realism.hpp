#pragma once

#include "dimension/image_assets.hpp"
#include "dimension/json.hpp"
#include "dimension/model.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct GroupChatTurnItem {
    std::string actor;     // "user" | "bot" | "system"
    std::string bot_id;
    std::string speaker_name;
    std::string text;
    std::int64_t created_at_ms = 0;
};

struct GroupMemberBrief {
    std::string id;
    std::string name;
    std::string persona_excerpt;
    bool spoke_recently = false;
};

struct GroupDesireMember {
    std::string id;
    std::string name;
    std::string persona;
    int turns_since_last_spoke = 3; // how many bot messages since this member last spoke
    int consecutive_turns = 0;      // how many consecutive recent bot messages were by this member
    bool mentioned_by_user = false;
    bool mentioned_by_peer = false;
    bool active_dyad_partner = false; // user is continuing a live 1-on-1 thread with this member
};

struct GroupDesireConfig {
    int speak_threshold = 22;
    int silence_step = 4;
    int silence_cap = 20;
    int user_mention_bonus = 55;
    int peer_mention_bonus = 30;
    int broadcast_bonus = 14;
    int just_spoke_penalty = 36;
    int consecutive_penalty = 24;
    int random_jitter_max = 10;
};

struct GroupDesireDecision {
    std::string bot_id;
    int score = 0;
    int baseline = 16;
    std::string debug_summary;
};

// Returns a concise local weekday + time-of-day anchor in Simplified Chinese.
std::string current_local_time_anchor();

// True only when the user's message plausibly touches Work task status/control,
// keeping everyday private Chat free of robotic `/work ...` manuals.
bool has_work_control_intent(std::string_view user_text);

// True when the user explicitly asks the whole group to weigh in.
bool is_group_broadcast_call(std::string_view user_text);

// Builds a bounded sticker reference snippet (`[sticker:id](名称)`) from the shared library.
std::string build_sticker_palette_prompt(const std::vector<ImageAsset>& stickers,
                                         std::size_t max_stickers = 24);

// Builds a vivid, anti-AI-tone private chat system prompt with energy mirroring,
// speech fingerprint emphasis, optional sticker palette, and snappy `||` multi-bubble support.
std::string build_private_chat_prompt(const std::string& bot_name,
                                      const std::string& raw_persona,
                                      std::string_view latest_user_text,
                                      const std::string& time_anchor,
                                      const std::string& sticker_prompt,
                                      bool web_lookup_enabled = false);

// Role-casting entry mapping a group Bot onto an original story character so the Bot performs
// that character's role with its own distinctive personality & voice.
struct StoryCastEntry {
    std::string bot_id;
    std::string bot_name;
    std::string role_name;
    std::string tier; // "lead" | "supporting" | "antagonist" | "cameo"
};

struct StoryForkChoice {
    std::string id;
    std::string label;
};

struct StoryStageCue {
    std::string scene; // "observatory" | "classroom" | "study" | "cafe" | ""
    std::string mood;  // "daily" | "tense" | "battle" | "warm" | "night" | ""
    std::string fx;    // "none" | "rain" | "shake" | "flash" | "petals" | ""
};

struct StoryEndingParsed {
    bool has_ending = false;
    std::string title;
    std::string rank; // "True End" | "Normal End" | "混沌 Bad End" | "隐藏 Secret End"
    std::string summary;
    std::vector<std::pair<std::string, std::string>> epilogues; // (speaker_name, line)
};

struct StoryActorExtras {
    std::string story_bible;
    std::string secret_note;
    bool inner_voice_enabled = false;
    std::string dice_context;
};

struct StoryNarratorExtras {
    std::string story_bible;
    std::vector<std::pair<std::string, std::string>> secret_notes; // (bot_name, secret_note)
    bool emit_stage_cue = false;
    std::string dice_context;
    bool is_finale = false;
};

struct StoryNarratorParsed {
    std::string narration;
    std::string node_title;
    std::string fork_prompt;
    std::vector<StoryForkChoice> choices;
    StoryStageCue stage_cue;
    StoryEndingParsed ending;
};

// Builds a group-chat system prompt for one member (`is_followup == true` when reacting to a peer Bot).
// spotlight_mode: "zero" (observer-only, ignore user) | "semi" (default, care about user + group vibe) | "lead" (user is center)
// story_premise: non-empty when the group is running in Story Theater / Roleplay mode.
std::string build_group_chat_prompt(const std::string& bot_name,
                                    const std::string& raw_persona,
                                    const std::string& remembered_context,
                                    const std::string& time_anchor,
                                    const std::string& sticker_prompt,
                                    bool was_explicitly_mentioned,
                                    bool is_followup,
                                    std::string_view reply_target_anchor = {},
                                    std::string_view length_hint = {},
                                    bool anti_repeat_warning = false,
                                    const std::vector<std::string>& stale_keywords = {},
                                    bool cue_user_in = false,
                                    bool spark_new_idea = false,
                                    std::string_view spotlight_mode = "semi",
                                    std::string_view story_premise = {},
                                    const std::vector<StoryCastEntry>& story_cast = {},
                                    std::string_view self_bot_id = {},
                                    std::string_view active_directive = {},
                                    bool web_lookup_enabled = false,
                                    const StoryActorExtras& story_extras = {});

// Builds the Director/Narrator system prompt for Story Theater mode (supports both standalone System Narrator
// and designating a group Bot as temporary DM/Narrator, plus role-casting, fate-fork nodes, plot rewrites,
// story bible, secret notes, automatic stage cues, TRPG D20 dice checks & finale convergence).
std::string build_story_narrator_prompt(std::string_view story_premise,
                                        std::string_view spotlight_mode,
                                        const std::vector<std::string>& actor_names,
                                        bool is_opening,
                                        std::string_view narrator_bot_name = {},
                                        std::string_view narrator_persona = {},
                                        const std::vector<StoryCastEntry>& story_cast = {},
                                        std::string_view rewrite_directive = {},
                                        bool request_fork = true,
                                        int chapter_number = 1,
                                        const StoryNarratorExtras& extras = {});

// Builds compact summarization messages to distill/update the persistent Story Bible (foreshadowing ledger).
std::vector<ModelMessage> build_story_bible_distill_messages(std::string_view story_premise,
                                                             std::string_view existing_bible,
                                                             std::string_view recent_transcript,
                                                             int chapter_number);

// Parses `[[STAGE ...]]`, `[[FORK]]...[[/FORK]]`, and `[[ENDING]]...[[/ENDING]]` metadata emitted by the
// Story Narrator, stripping markup from the clean narration text.
StoryNarratorParsed parse_story_narrator_output(std::string_view raw);

// Strips the work-only `【CRAFT.md】` section from persona text during casual Chat so characters relax.
std::string strip_persona_craft_section(std::string_view raw_persona);

// True when text addresses a bot by full name, pre-dot given name (e.g. "艾莉丝" for "艾莉丝·格雷拉特"),
// or 2-char suffix given name (e.g. "三玖" for "中野三玖").
bool matches_bot_name(std::string_view text, std::string_view full_name);

// Detects overused Chinese 2-gram keywords appearing >= 3 times in recent bot replies
// that the user did NOT mention in their latest message (e.g. stale "咖喱" loops).
std::vector<std::string> detect_stale_group_keywords(const std::vector<std::string>& recent_bot_texts,
                                                     std::string_view latest_user_text);

// Formats a concise Simplified Chinese time-gap divider when two adjacent turns are >= threshold_minutes apart
// or cross a calendar day; returns empty string when messages are close in time.
std::string format_time_gap_divider(std::int64_t prev_ms, std::int64_t cur_ms, int threshold_minutes = 120);

// Infers a character's talkativeness baseline (8..26) directly from existing persona markdown.
int infer_talkativeness_baseline(std::string_view persona);

// Computes lightweight Chinese 2-gram + topic cluster resonance score (0..25) between text and persona.
int topic_resonance_score(std::string_view text, std::string_view persona);

// Computes Chinese UTF-8 character 2-gram Jaccard overlap (0.0..1.0) for fast anti-repeat detection.
double chinese_bigram_overlap(std::string_view a, std::string_view b);

// Rolls a natural reply-length instruction based on baseline & recent message lengths.
std::string roll_group_length_hint(int baseline,
                                   bool is_question,
                                   bool prev_was_long,
                                   bool two_prev_long,
                                   std::uint64_t seed);

// Scores all eligible group members and picks one via Top-2 weighted random sampling.
// Returns std::nullopt when no eligible member clears the threshold.
std::optional<GroupDesireDecision> pick_next_group_speaker(
    const std::vector<GroupDesireMember>& members,
    std::string_view trigger_text,
    bool is_broadcast,
    const std::set<std::string>& already_spoke_this_turn,
    std::uint64_t seed,
    const GroupDesireConfig& cfg = {});

// Assembles strict alternating `user` / `assistant` messages from a member's own POV:
// - Own past messages -> `assistant` (no name prefix, preventing persona bleed)
// - User & other Bots' messages -> merged into `user` blocks with `[用户]:` / `[群友 名]:` labels.
std::vector<ModelMessage> build_group_pov_messages(const std::string& self_bot_id,
                                                   const std::string& system_prompt,
                                                   const std::vector<GroupChatTurnItem>& history);

// Strips accidental leading `"名字: "` / `"[名字]："` prefixes echoed by the model.
std::string strip_speaker_prefix(std::string_view text, std::string_view bot_name);

// Builds the lightweight Group Director prompt to pick 1..2 most natural responders.
std::vector<ModelMessage> build_group_director_messages(const std::vector<GroupMemberBrief>& roster,
                                                        std::string_view latest_user_text,
                                                        std::string_view recent_transcript);

// Parses 1..max_pick valid botIds from the Group Director output, with deterministic fallback.
std::vector<std::string> parse_group_director_picks(std::string_view raw_output,
                                                    const std::vector<GroupMemberBrief>& roster,
                                                    std::string_view latest_user_text,
                                                    std::size_t max_pick = 2);

} // namespace dimension
