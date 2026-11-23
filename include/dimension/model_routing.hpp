#pragma once

#include "dimension/model.hpp"
#include <exception>

namespace dimension {

struct ModelRoute {
    std::string tier, provider_id;
    ModelConfig config;
};

// Empty for cancellation, authentication/configuration/protocol errors, and
// non-model exceptions. The result contains no URL, key or upstream text.
std::string model_upgrade_reason(std::exception_ptr failure);

// The app supplies an attempt-frozen initial route and only explicitly configured
// higher tiers. At most three distinct destinations and two forward switches.
// This class cannot invoke models/tools or modify any receipt/history.
class ModelRoutePolicy {
public:
    explicit ModelRoutePolicy(std::vector<ModelRoute> plan);
    const ModelRoute& current() const;
    bool can_upgrade() const noexcept;
    Json selection() const;
    // Returns null when no configured higher destination remains.
    Json upgrade(const std::string& reason);
    // Difficulty is supported by actual failed verification/completion checks,
    // not by model prose. Uncertain side effects block this trigger entirely.
    bool note_round(bool failed_check, bool progress, bool uncertain);
private:
    std::vector<ModelRoute> plan_;
    std::size_t current_ = 0;
    unsigned failed_rounds_ = 0;
};
} // namespace dimension
