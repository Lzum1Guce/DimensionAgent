#pragma once
#include "dimension/model.hpp"
#include "dimension/store.hpp"
#include <filesystem>
#include <memory>

namespace dimension {
class CharacterToolError final : public std::runtime_error {
public:
    CharacterToolError(int status, std::string message) : std::runtime_error(std::move(message)), status(status) {}
    int status;
};
// Explicit local JSON snapshots only. No account access, crawling or image fetch.
class CharacterDirectory {
public:
    CharacterDirectory(Store&, std::filesystem::path);
    ~CharacterDirectory();
    Json search(std::string_view query, std::size_t offset = 0, std::size_t limit = 40,
                std::string_view revision = {}) const;
    Json replace_snapshot(const Json& catalog, std::string_view expected_revision);
    Bot import_entry(std::string_view source_id, std::string_view entry_id, std::string_view revision);
    Json provenance(std::string_view bot_id) const;
private:
    struct Impl; std::unique_ptr<Impl> impl_;
};

// Ephemeral draft jobs never update a profile until explicit apply with CAS.
class PersonaDrafts {
public:
    using Generate = std::function<ModelReply(const ModelConfig&, const std::vector<ModelMessage>&,
                                             ModelChunk, std::stop_token)>;
    explicit PersonaDrafts(Store&, Generate = {});
    ~PersonaDrafts();
    Json start(std::string_view bot_id, std::string_view brief, const ModelConfig&, std::string_view expected_revision);
    Json get(std::string_view bot_id, std::string_view draft_id) const;
    Json cancel(std::string_view bot_id, std::string_view draft_id);
    BotProfileSnapshot apply(std::string_view bot_id, std::string_view draft_id,
        std::string_view revision, std::string_view edited_persona);
private:
    struct Impl; std::unique_ptr<Impl> impl_;
};
} // namespace dimension
