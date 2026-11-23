#pragma once
#include <filesystem>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <string_view>

namespace dimension {
enum class AtomicFileFailure { InvalidPath, UnsafePath, Storage, Cancelled, AlreadyExists };
class AtomicFileError final : public std::runtime_error {
public:
    AtomicFileError(AtomicFileFailure kind, const char* message, bool committed = false)
        : std::runtime_error(message), kind(kind), committed(committed) {}
    AtomicFileFailure kind;
    // A post-rename verification/flush failure cannot claim no side effects.
    bool committed;
};
struct AtomicWriteOptions {
    bool replace_existing = true;
    // Optional project boundary: it and all its ancestors must already exist.
    // Only descendants may be created. This is not a substitute for ownership.
    std::filesystem::path existing_root;
};
// Absolute local Windows paths only. Pins all directories against replacement,
// rejects reparse/multi-link destinations, writes a random exclusive CREATE_NEW
// temporary file and renames that open handle. Never touches <target>.pending.
// Caller keeps its own content size, ownership and overwrite authorization rules.
void atomic_write_file(const std::filesystem::path& target, std::string_view bytes,
                       const AtomicWriteOptions& options = {}, std::stop_token stop = {});
} // namespace dimension
