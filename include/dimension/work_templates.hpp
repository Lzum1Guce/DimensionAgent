#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <string>

namespace dimension {

// Work templates contain procedure text only. They deliberately have no target,
// approval, credential, tool-grant, run-id, input-context or execution fields.
class WorkTemplateError final : public std::runtime_error {
public:
    WorkTemplateError(int status, std::string message)
        : std::runtime_error(std::move(message)), status(status) {}
    int status;
};

struct WorkTemplateMutation {
    Json response;
    bool duplicate = false;
};

class WorkTemplates final {
public:
    explicit WorkTemplates(std::filesystem::path root);

    Json list() const;
    Json get(const std::string& id) const;
    WorkTemplateMutation create(const Json& input);
    WorkTemplateMutation update(const std::string& id, const Json& input);
    WorkTemplateMutation erase(const std::string& id, const Json& input);

private:
    std::filesystem::path file_;
    Json state_;
    mutable std::mutex mutex_;
};

} // namespace dimension
