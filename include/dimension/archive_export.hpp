#pragma once

#include "dimension/archive.hpp"

#include <cstdint>
#include <string>
#include <string_view>

namespace dimension {

struct ArchivePackage {
    ArchiveDocument archive;
    std::string source_id;
    std::int64_t source_revision{};
    std::string sha256;
};

// One Store-owned read snapshot, followed by strict v2 validation. Exports every
// recorded identity/scope/state or fails; it never truncates or writes to Store.
// ArchiveLimits can tighten the native import caps. Archive JSON is at most
// 4 MiB - 8192 bytes and the complete package at most 4 MiB - 4096 bytes.
[[nodiscard]] Json export_archive_package(const Store&, ArchiveLimits limits = {});

// Strict package envelope, v2 archive, metadata, counts, canonical-content and
// whole-envelope SHA256 validation. SHA256 detects changed content/metadata; it
// is not a signature or proof that a supplied source identity is authentic.
[[nodiscard]] ArchivePackage parse_archive_package(std::string_view bytes, ArchiveLimits limits = {});

} // namespace dimension
