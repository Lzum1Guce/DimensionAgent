#include "dimension/model_routing.hpp"

#include <algorithm>
#include <set>
#include <utility>

namespace dimension {
namespace {
int rank(std::string_view tier) {
    if (tier == "member" || tier == "pool") return -1;
    if (tier == "simple") return 0;
    if (tier == "standard") return 1;
    if (tier == "complex") return 2;
    throw std::invalid_argument("Invalid model route tier");
}
Json public_route(const ModelRoute& route) {
    return Json::Object{{"tier", route.tier}, {"providerId", route.provider_id}, {"model", route.config.model}};
}
} // namespace
std::string model_upgrade_reason(std::exception_ptr failure) {
    if (!failure) return {};
    try { std::rethrow_exception(failure); }
    catch (const ModelError& error) {
        if (!error.may_upgrade()) return {};
        if (error.kind() == ModelFailure::Timeout) return "model_timeout";
        if (error.kind() == ModelFailure::Transport) return "model_transport";
        return "model_http_" + std::to_string(error.http_status());
    } catch (...) { return {}; }
}
ModelRoutePolicy::ModelRoutePolicy(std::vector<ModelRoute> plan) {
    if (plan.empty() || plan.size() > 3) throw std::invalid_argument("Model route plan exceeds its bound");
    std::set<std::string> destinations;
    int previous = -2;
    for (auto& route : plan) {
        const auto level = rank(route.tier);
        if (level <= previous || (level == -1 && plan.size() != 1) || route.provider_id.size() > 256 ||
            route.config.model.size() > 256)
            throw std::invalid_argument("Model route plan must advance through configured tiers");
        previous = level;
        auto destination = Json(Json::Array{route.config.base_url, route.config.protocol, route.config.model}).dump();
        if (destinations.insert(std::move(destination)).second) plan_.push_back(std::move(route));
    }
}
const ModelRoute& ModelRoutePolicy::current() const { return plan_.at(current_); }
bool ModelRoutePolicy::can_upgrade() const noexcept { return current_ + 1 < plan_.size(); }
Json ModelRoutePolicy::selection() const { return public_route(current()); }
Json ModelRoutePolicy::upgrade(const std::string& reason) {
    if (!can_upgrade()) return {};
    if (reason != "verification_failed" && reason != "model_timeout" && reason != "model_transport" &&
        !(reason == "model_http_408" || reason == "model_http_429" ||
          (reason.starts_with("model_http_5") && reason.size() == 14 &&
           reason[12] >= '0' && reason[12] <= '9' && reason[13] >= '0' && reason[13] <= '9')))
        throw std::invalid_argument("Invalid model route upgrade reason");
    const auto from = public_route(current());
    ++current_; failed_rounds_ = 0;
    return Json::Object{{"from", from}, {"to", public_route(current())}, {"reason", reason},
        {"switch", static_cast<int>(current_)}, {"maximumSwitches", 2}};
}
bool ModelRoutePolicy::note_round(bool failed_check, bool progress, bool uncertain) {
    if (uncertain || progress || !failed_check) { failed_rounds_ = 0; return false; }
    if (failed_rounds_ < 2) ++failed_rounds_;
    return failed_rounds_ >= 2 && can_upgrade();
}
} // namespace dimension
