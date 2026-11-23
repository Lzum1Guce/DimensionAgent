#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

using Id = std::int64_t;

enum class Mode { Chat, Work };
enum class MemoryState { Candidate, Confirmed, Rejected };
enum class StoreErrorCode { InvalidArgument, NotFound, Conflict, Storage, LimitExceeded };

class ArchiveDocument;
enum class StoreBotConflict { Reject, PreserveExisting };
enum class StoreMemoryConflict { PreserveExisting, Reject };
enum class StoreGroupConflict { Reject, PreserveExisting };

struct StoreImportOptions {
    // Stable external source namespace, never a stage token or package digest.
    std::string source_id;
    std::optional<StoreBotConflict> bot_conflict; // Must be selected explicitly.
    StoreMemoryConflict memory_conflict = StoreMemoryConflict::PreserveExisting;
    std::optional<StoreGroupConflict> group_conflict; // Required for v2 archives.
};

struct StoreImportCounts {
    std::size_t bots_created{}, bots_preserved{};
    std::size_t groups_created{}, groups_preserved{};
    std::size_t messages_created{}, messages_reused{}, messages_tombstoned{};
    std::size_t memories_created{}, memories_preserved{}, memories_reused{}, memories_tombstoned{};
    std::size_t mid_memories_created{}, mid_memories_preserved{}, mid_memories_reused{}, mid_memories_tombstoned{};
};

struct StoreImportIssue {
    std::string code;
    std::string kind; // archive, bot, group, conversation, message, or memory.
    std::string source_id; // Locator only, never a record body.
};

struct StoreImportPlan {
    std::int64_t target_revision{};
    std::string digest; // Binds document, source namespace, policies and target identity.
    bool can_commit{};
    StoreImportCounts counts;
    std::vector<StoreImportIssue> issues; // First 256 issues; issue_count stays exact.
    std::size_t issue_count{};
    bool issues_truncated{};
    int archive_version{1};
};

struct StoreImportResult {
    std::int64_t revision_before{}, revision_after{};
    std::string digest;
    StoreImportCounts counts;
    int archive_version{1};
};

class StoreError final : public std::runtime_error {
public:
    StoreError(StoreErrorCode code, std::string message);
    [[nodiscard]] StoreErrorCode code() const noexcept { return code_; }

private:
    StoreErrorCode code_;
};

struct Bot {
    std::string id;
    std::string name;
    std::string persona;
    bool in_chat{};
    bool in_work{};
};

struct BotProfileOverride {
    std::string id;
    std::optional<std::string> name, persona;
};

struct BotProfileSnapshot {
    Bot bot;
    std::string revision; // Database/Bot-bound SHA-256 of current name/persona.
};

struct ConversationDraft {
    Mode mode{Mode::Chat};
    std::string bot_id, group_id, text;
    std::int64_t revision{}, updated_at_ms{};
};

struct ChatDeliveryReceipt {
    std::string receipt_key;
    std::string bot_id;
    std::string run_id;
    std::string message_id;
    std::string request_id;
    bool saved{};
    std::string payload_json;
    std::int64_t updated_at_ms{};
};

struct PersonaRevision {
    Id id{};
    std::string bot_id, persona, profile_revision, action;
    Id restored_revision_id{};
    std::int64_t created_at_ms{};
};

struct Group {
    std::string id, name, owner_id;
    std::vector<std::string> members, history_members, admins;
    bool in_chat{}, in_work{}, deleted{};
    std::string seal_shape, seal_color;
    std::int64_t revision{1};
};

struct MessageSource {
    std::string source_namespace;
    Id message_id{};
    std::string bot_id, group_id;
    Mode mode{Mode::Chat};
    std::string actor, text;
    std::int64_t created_at_ms{};
    std::size_t offset_codepoints{}, total_codepoints{};
    bool truncated{};
};

struct MessageContext {
    std::string kind; // quote (one same-scope source) or forward (one Chat conversation).
    std::vector<MessageSource> sources;
};

struct Message {
    Id id{};
    std::string bot_id;
    std::string group_id; // Empty means the bot's private conversation.
    Mode mode{Mode::Chat};
    std::string actor; // "user", "bot", or "system".
    std::string text;
    std::int64_t created_at_ms{};
    std::optional<MessageContext> context;
};

struct Memory {
    Id id{};
    std::string bot_id;
    std::string group_id; // Empty means private; all other scopes match exactly.
    std::string text;
    MemoryState state{MemoryState::Candidate};
    std::int64_t revision{1};
    std::string source_actor;
    // Ordinary long-term facts use kind=fact. Episodes and directed subjective
    // impressions reuse the same records, candidate review and revisions.
    // For an impression bot_id is the observer; target_bot_id is never a persona
    // assertion and no affinity/confidence score is stored.
    std::string kind{"fact"};
    std::int64_t event_time_ms{0};
    std::string source_ref, participants, user_choice, outcome;
    std::string target_bot_id, evidence, applicable_scenarios;
    Id supersedes_id{0}; // New-source correction; the old row remains auditable.
};

struct MemoryChange {
    Id id{};
    std::int64_t expected_revision{};
    std::optional<std::string> text; // null means explicit deletion.
};

struct MemoryExcerpt {
    Id id{};
    std::int64_t revision{};
    std::string bot_id, group_id, text, relation_key;
    std::size_t offset_codepoints{}, total_codepoints{};
    bool truncated{};
};

inline constexpr std::size_t mid_memory_text_limit = 16U * 1024U;
inline constexpr std::size_t mid_memory_scope_limit = 200;
inline constexpr std::size_t mid_memory_total_limit = 10000;
inline constexpr std::int64_t mid_memory_strength_limit = 1000000;

struct MidMemory {
    Id id{};
    std::string bot_id, group_id, text, source_actor;
    std::int64_t revision{1}, created_at_ms{}, updated_at_ms{}, expires_at_ms{}, strength{1};
};

struct MidMemoryExcerpt {
    MemoryExcerpt source;
    std::int64_t expires_at_ms{}, strength{1};
};

struct RelationNotesSnapshot {
    std::string revision; // SHA-256 of this database/Bot's four-note snapshot.
    std::map<std::string, std::string> values; // Exactly the four semantic keys.
};

struct StoreArchiveSnapshotLimits {
    std::size_t max_bots = 1024;
    std::size_t max_groups = 256;
    std::size_t max_messages = 20000;
    std::size_t max_memories = 10000;
    std::size_t max_record_bytes = 4U * 1024U * 1024U;
    std::size_t max_mid_memories = mid_memory_total_limit;
};

struct StoreArchiveSnapshot {
    std::string source_id; // native-<persistent database identity>, never a stage ID.
    std::int64_t revision{};
    std::vector<Bot> bots;
    std::vector<Group> groups;
    std::vector<Message> messages;
    std::vector<Memory> memories;
    std::vector<MidMemory> mid_memories;
};

struct StoreBotArchiveFields {
    bool name{}, persona{}, chat_history{}, work_history{};
    bool long_term_memory{}, relations{}, mid_term_memory{};
};
struct StoreBotArchiveReceipt {
    // source_key hashes origin, exact package and explicit selection together.
    std::string source_key, target_id, selection_digest;
};

struct ConversationStatistics {
    std::int64_t messages{}, utf8_bytes{}, unicode_scalars{};
    Id first_id{}, last_id{};
};
struct ConversationSnapshot {
    std::string source_namespace, bot_id, group_id, fingerprint;
    Mode mode{Mode::Chat};
    std::vector<Message> messages; // Complete exact scope in ascending native ID order.
};

// One Store owns one SQLite connection. Calls are serialized within this object;
// separate Store instances use SQLite transactions and revision checks.
class Store final {
public:
    explicit Store(const std::filesystem::path& database_path);
    ~Store();
    Store(const Store&) = delete;
    Store& operator=(const Store&) = delete;
    Store(Store&&) = delete;
    Store& operator=(Store&&) = delete;

    [[nodiscard]] Bot create_bot(std::string_view name, std::string_view persona,
        std::string_view id = "");
    [[nodiscard]] std::optional<Bot> find_bot(std::string_view bot_id) const;
    [[nodiscard]] std::vector<Bot> list_bots(std::optional<Mode> roster = {}) const;
    // Covering-index scan returning only active Chat/Work roster bots (with empty persona).
    [[nodiscard]] std::vector<Bot> list_active_roster_bots() const;
    [[nodiscard]] std::int64_t current_revision() const;
    [[nodiscard]] Bot set_roster(std::string_view bot_id, Mode mode, bool present);
    // Detaches and clears private logs only in the selected mode. No mode keeps
    // the legacy both-mode operation. Identity, persona, memories, group logs,
    // and message/import receipt tombstones remain intact in either case.
    void remove_bot(std::string_view bot_id, std::optional<Mode> mode = {});
    [[nodiscard]] Bot update_bot_profile(std::string_view bot_id,
        std::optional<std::string> name = {}, std::optional<std::string> persona = {});
    [[nodiscard]] BotProfileSnapshot read_bot_profile(std::string_view bot_id) const;
    [[nodiscard]] BotProfileSnapshot save_bot_profile(std::string_view bot_id,
        std::string_view expected_revision, std::string_view persona);
    [[nodiscard]] BotProfileSnapshot restore_bot_profile(std::string_view bot_id,
        std::string_view expected_revision, Id revision_id);
    [[nodiscard]] std::vector<PersonaRevision> persona_revisions(std::string_view bot_id,
        std::size_t limit = 20) const;

    // A draft belongs to exactly one Bot/private or group scope and one mode.
    // Revision checks make delayed saves/clears unable to overwrite newer input.
    [[nodiscard]] std::optional<ConversationDraft> read_conversation_draft(Mode mode,
        std::string_view bot_id, std::string_view group_id) const;
    [[nodiscard]] ConversationDraft save_conversation_draft(Mode mode,
        std::string_view bot_id, std::string_view group_id, std::string_view text,
        std::int64_t expected_revision);
    [[nodiscard]] bool clear_conversation_draft(Mode mode,
        std::string_view bot_id, std::string_view group_id, std::int64_t expected_revision);

    // SQLite-backed Chat delivery receipts (replaces monolithic settings.json chatReceipts).
    [[nodiscard]] std::optional<ChatDeliveryReceipt> find_chat_delivery_receipt(std::string_view receipt_key) const;
    [[nodiscard]] std::optional<ChatDeliveryReceipt> find_chat_delivery_receipt_by_run(std::string_view run_id) const;
    [[nodiscard]] std::vector<ChatDeliveryReceipt> list_unsaved_chat_delivery_receipts() const;
    void upsert_chat_delivery_receipt(const ChatDeliveryReceipt& receipt);
    void upsert_chat_delivery_receipts_batch(const std::vector<ChatDeliveryReceipt>& receipts);
    void mark_bot_chat_delivery_receipts_saved(std::string_view bot_id);
    std::size_t prune_saved_chat_delivery_receipts(std::size_t keep_recent = 2000);

    [[nodiscard]] Group create_group(const Group& group);
    [[nodiscard]] std::optional<Group> find_group(std::string_view group_id) const;
    [[nodiscard]] std::vector<Group> list_groups(std::optional<Mode> roster = {},
                                               bool include_deleted = false) const;
    // Merges the old history into the replacement; revision is expected+1.
    // Deleted identities cannot be restored or removed through replacement.
    [[nodiscard]] Group replace_group(const Group& group, std::int64_t expected_revision);
    [[nodiscard]] Group set_group_roster(std::string_view group_id, Mode mode, bool present);
    // Soft deletion clears both modes' group logs; identity and memories stay.
    void remove_group(std::string_view group_id);
    // One SQL page across all historical members, newest native ID first.
    [[nodiscard]] std::vector<Message> group_messages_after(std::string_view group_id, Mode mode,
        Id after, std::size_t limit) const;
    [[nodiscard]] std::vector<Message> group_messages(std::string_view group_id, Mode mode,
        std::size_t limit = 50, std::optional<Id> before = {}) const;
    // Latest Bot-authored message per historical member, without a page cap.
    [[nodiscard]] std::vector<Message> latest_group_bot_messages(std::string_view group_id,
        Mode mode = Mode::Chat) const;

    [[nodiscard]] bool application_metadata_bootstrapped() const;
    // One-time migration of this application's own typed metadata. An existing
    // marker makes later calls no-ops; no source database or file is opened.
    void bootstrap_application_metadata(const std::vector<Group>& groups,
        const std::vector<BotProfileOverride>& profile_overrides);

    // One bounded SQLite read snapshot, including hidden/deleted identities and
    // all memory states. Every collection is in ascending native ID order.
    // Any exceeded count/UTF-8 record-byte limit rejects the complete result.
    [[nodiscard]] StoreArchiveSnapshot archive_snapshot(StoreArchiveSnapshotLimits limits = {}) const;
    // Complete selected private fields of one Bot in one read transaction.
    // Unselected histories/notes are never read or charged against limits.
    [[nodiscard]] StoreArchiveSnapshot bot_archive_snapshot(std::string_view bot_id,
        const StoreBotArchiveFields&, StoreArchiveSnapshotLimits limits = {}) const;
    [[nodiscard]] std::optional<StoreBotArchiveReceipt> bot_archive_receipt(std::string_view source_key) const;
    [[nodiscard]] std::string source_namespace() const;
    [[nodiscard]] ConversationStatistics conversation_statistics(std::string_view bot_id,
        Mode mode = Mode::Chat, std::string_view group_id = "") const;
    [[nodiscard]] ConversationSnapshot conversation_snapshot(std::string_view bot_id,
        Mode mode = Mode::Chat, std::string_view group_id = "") const;
    struct SearchHit {
        std::string kind, id, bot_id, group_id, mode, actor, state, text;
        Id record_id = 0;
        std::int64_t timestamp = 0;
    };
    // Bounded literal substring search. Rejected memories and reserved relation
    // records are excluded; snippets are capped before leaving the store.
    [[nodiscard]] std::vector<SearchHit> search_text(std::string_view query,
        std::size_t limit = 50) const;
    [[nodiscard]] std::optional<Message> find_message(Id id) const;
    // Exactly one of bot/group is set. Only a Chat row in that exact scope is
    // deleted. A repeated deletion returns false; unknown/wrong-scope IDs fail.
    // Receipts retain tombstones and other messages retain their source snapshots.
    [[nodiscard]] bool delete_chat_message(std::string_view bot_id,
        std::string_view group_id, Id message_id);
    // Compare the complete private Chat snapshot and append the generated
    // system summary plus receipt in one transaction. Source rows are retained.
    // Exact replay returns its prior summary even after later history changes.
    [[nodiscard]] Message append_summary_once(std::string_view bot_id, std::string_view text,
        std::string_view request_key, std::string_view expected_fingerprint);

    [[nodiscard]] Message append_message(std::string_view bot_id, Mode mode,
        std::string_view actor, std::string_view text, std::string_view group_id = "",
        std::optional<Id> quote_source = {});
    // Transactional idempotency within (bot, mode, group, request_key). An exact
    // replay returns the original Message; a changed actor/text is Conflict.
    // Deleting a message retains a receipt tombstone, so its consumed key can
    // never recreate cleared history. Use distinct keys for user/reply writes.
    [[nodiscard]] Message append_message_once(std::string_view bot_id, Mode mode,
        std::string_view actor, std::string_view text, std::string_view group_id,
        std::string_view request_key, std::optional<Id> quote_source = {});
    // The source is read from this database and must have the exact destination
    // conversation scope. The bounded snapshot is data, never authorization.
    [[nodiscard]] MessageContext capture_quote(std::string_view bot_id, Mode mode,
        std::string_view group_id, Id source_id) const;
    // One transaction validates the complete ordered source batch, then writes
    // one system/reference record, its context and idempotency receipt.
    [[nodiscard]] Message forward_group_messages(std::string_view destination_bot,
        std::string_view destination_group, std::string_view source_group,
        const std::vector<Id>& source_ids, std::string_view request_key);
    // Exactly one source scope is set: a private Bot or a group. Work sources
    // are rejected. Capturing/writing is atomic against concurrent deletion.
    [[nodiscard]] Message forward_chat_messages(std::string_view destination_bot,
        std::string_view destination_group, std::string_view source_bot,
        std::string_view source_group, const std::vector<Id>& source_ids,
        std::string_view request_key);
    // Newest first. The next page uses before = previous_page.back().id.
    // The exclusive ID cursor remains stable if newer messages arrive.
    [[nodiscard]] std::vector<Message> messages(std::string_view bot_id, Mode mode,
        std::string_view group_id = "", std::size_t limit = 50,
        std::optional<Id> before = {}) const;

    // Only the literal source_actor "user" is accepted. Exact trimmed text is
    // deduplicated within the same bot and scope without changing its state.
    [[nodiscard]] Memory propose_memory(std::string_view bot_id, std::string_view group_id,
        std::string_view text, std::string_view source_actor);
    [[nodiscard]] Memory propose_episode(std::string_view bot_id, std::string_view group_id,
        std::string_view text, std::int64_t event_time_ms, std::string_view source_ref,
        std::string_view participants, std::string_view user_choice, std::string_view outcome);
    [[nodiscard]] std::vector<Memory> recall_episodes(std::string_view bot_id,
        std::string_view group_id, std::string_view query, std::size_t limit = 3) const;
    // A directed, subjective observation about target_bot_id. Group scope and a
    // direct shared message/run source are mandatory; private/hearsay references
    // are rejected. Replaying the same complete source record is idempotent.
    [[nodiscard]] Memory propose_impression(std::string_view observer_bot_id,
        std::string_view target_bot_id, std::string_view group_id, std::string_view text,
        std::int64_t event_time_ms, std::string_view source_ref, std::string_view evidence,
        std::string_view applicable_scenarios, Id supersedes_id = 0);
    [[nodiscard]] std::vector<Memory> recall_impressions(std::string_view observer_bot_id,
        std::string_view target_bot_id, std::string_view group_id, std::string_view query,
        std::size_t limit = 3) const;
    // Includes rejected superseded rows for audit, newest first.
    [[nodiscard]] std::vector<Memory> list_impressions(std::string_view observer_bot_id,
        std::string_view group_id = "", std::string_view target_bot_id = "") const;
    [[nodiscard]] std::optional<Memory> find_memory(Id memory_id) const;
    // No scope filter means all scopes for this bot. include_candidates=true
    // includes every state for management; false returns only Confirmed.
    [[nodiscard]] std::vector<Memory> list_memories(std::string_view bot_id,
        std::optional<std::string_view> group_id = {}, bool include_candidates = true,
        std::size_t limit = 100, std::optional<Id> before = {}) const;
    // Only ordinary Confirmed/Candidate records in one exact scope. Rejected
    // rows and reserved relation notes do not consume a visible page slot.
    [[nodiscard]] std::vector<Memory> visible_memories(std::string_view bot_id,
        std::string_view group_id = "", std::size_t limit = 100,
        std::optional<Id> before = {}) const;
    [[nodiscard]] Memory review_memory(Id memory_id, std::int64_t expected_revision,
        MemoryState state);
    // A text change returns the memory to Candidate for explicit review.
    [[nodiscard]] Memory edit_memory(Id memory_id, std::int64_t expected_revision,
        std::string_view text);
    void delete_memory(Id memory_id, std::int64_t expected_revision);
    // At most 100 explicitly selected confirmed memories in one exact scope.
    // All edits/deletions roll back together; no-op edits retain state/revision.
    void apply_memory_changes(std::string_view bot_id, std::string_view group_id,
                              const std::vector<MemoryChange>& changes);

    // Typed mid-term notes are explicit user records, separate from ordinary
    // learning candidates and relation fields. Expiry never deletes/promotes
    // their text. Optional time is for deterministic callers/tests; HTTP uses
    // the server clock. New notes live 1..30 days (default 7).
    [[nodiscard]] MidMemory add_mid_memory(std::string_view bot_id, std::string_view group_id,
        std::string_view text, int days = 7, std::optional<std::int64_t> now_ms = {});
    [[nodiscard]] std::vector<MidMemory> list_mid_memories(std::string_view bot_id,
        std::string_view group_id = "") const;
    // Same explicit id/revision/text shape; a null text deletes only that ID.
    // A text edit preserves expiry and strength; no-op retains its revision.
    void apply_mid_memory_changes(std::string_view bot_id, std::string_view group_id,
        const std::vector<MemoryChange>& changes, std::optional<std::int64_t> now_ms = {});
    // Explicit renewal extends from max(expiry,now), capped at now+90 days.
    // Only this action increases strength, and it requires the original revision.
    [[nodiscard]] MidMemory reinforce_mid_memory(std::string_view bot_id, std::string_view group_id,
        Id id, std::int64_t expected_revision, int days = 7, std::optional<std::int64_t> now_ms = {});
    [[nodiscard]] std::vector<MidMemoryExcerpt> recall_mid_memory_excerpts(std::string_view bot_id,
        std::string_view group_id, std::string_view query, std::size_t max_items = 3,
        std::size_t max_codepoints = 600, std::optional<std::int64_t> now_ms = {}) const;

    [[nodiscard]] RelationNotesSnapshot read_relation_notes(std::string_view bot_id) const;
    // Explicit whole-form save in the private scope. Empty values delete only
    // that field; changed nonempty values remain Confirmed. All writes are atomic.
    [[nodiscard]] RelationNotesSnapshot save_relation_notes(std::string_view bot_id,
        const std::map<std::string, std::string>& values, std::string_view expected_revision);

    // Confirmed memories in the exact bot/scope only. Hard maximums are 5 items
    // and 1600 Unicode scalar values total. Only complete records that fit the
    // remaining budget are returned; longer records are skipped, never cut.
    [[nodiscard]] std::vector<Memory> retrieve_memories(std::string_view bot_id,
        std::string_view group_id, std::string_view query,
        std::size_t max_items = 5, std::size_t max_codepoints = 1600) const;
    // Bounded, source-labelled excerpts from Confirmed records in this exact
    // scope. Long records retain their stored text and yield relevant UTF-8
    // windows instead of disappearing. Offsets count Unicode scalar values in
    // the ordinary body (or relation-note content, excluding its wire prefix).
    [[nodiscard]] std::vector<MemoryExcerpt> recall_memory_excerpts(std::string_view bot_id,
        std::string_view group_id, std::string_view query,
        std::size_t max_items = 5, std::size_t max_codepoints = 1600) const;

    // One read snapshot; no writes. v2 also supports complete group metadata.
    // A differing Bot or memory may be kept by explicit preserve policy; no
    // existing row is overwritten. Source record identity never uses text alone.
    [[nodiscard]] StoreImportPlan prepare_archive_import(const ArchiveDocument&,
        const StoreImportOptions&) const;
    // BEGIN IMMEDIATE, verify token, replan and write all records and source
    // mappings in one transaction. Any failure rolls the complete batch back.
    // Deleted mapped targets remain tombstones and cannot be reimported.
    [[nodiscard]] StoreImportResult commit_archive_import(const ArchiveDocument&,
        const StoreImportOptions&, std::int64_t expected_revision,
        std::string_view expected_digest);
    // First import must create exactly one new Bot. Exact source replays may
    // preserve only previously mapped rows/tombstones, never add or overwrite.
    // before_create runs with the SQLite writer lock after conflict checks and
    // before writes; used to persist an invisible new-ID avatar first. Failure
    // cleanup also runs before the writer lock is released to other callers.
    [[nodiscard]] StoreImportResult commit_bot_archive_import(const ArchiveDocument&,
        const StoreImportOptions&, const StoreBotArchiveReceipt&,
        std::int64_t expected_revision, std::string_view expected_digest,
        const std::function<void()>& before_create = {},
        const std::function<void()>& on_create_failure = {});

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
