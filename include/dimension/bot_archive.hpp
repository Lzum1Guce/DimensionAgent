#pragma once

#include "dimension/archive_staging.hpp"
#include "dimension/image_assets.hpp"

namespace dimension {

inline constexpr std::size_t bot_archive_max_package_bytes = 16U * 1024U * 1024U - 8192U;
inline constexpr std::size_t bot_archive_max_body_bytes = 16U * 1024U * 1024U;
inline constexpr std::size_t bot_archive_max_avatar_bytes = 8U * 1024U * 1024U;
// A stable, bounded private Work text snapshot. IDs are re-encoded by export;
// runnable state, receipts, tool outputs and contexts are not accepted here.
using BotArchiveWorkHistory = std::function<std::vector<Message>(std::string_view bot_id)>;

// Strict single-Bot data packages. All previews contain counts/locators only.
// Import selections may only remove available fields. New identities are the
// default; an existing identity can never be overwritten by a package.
class BotArchives final {
public:
    explicit BotArchives(Store&, ImageAssets&, BotArchiveWorkHistory = {});
    ~BotArchives();
    BotArchives(const BotArchives&) = delete;
    BotArchives& operator=(const BotArchives&) = delete;

    // {botId,fields:[name,id,persona,chatHistory,workHistory,longTermMemory,
    //                relations,midTermMemory,avatar]}
    [[nodiscard]] Json export_bot(const Json& request);
    // {package,fields:[],preserveId:false}; empty fields gives inspection only.
    [[nodiscard]] Json stage(const Json& request);
    // Frozen token only. Same-token and durable exact replays are idempotent.
    [[nodiscard]] Json commit(std::string_view token);
    // True means a stage was discarded. It never rolls back committed data.
    [[nodiscard]] bool discard(std::string_view token);
    [[nodiscard]] static Json capabilities();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
