#pragma once
#include "dimension/http.hpp"
#include "dimension/json.hpp"
#include <filesystem>
#include <memory>
#include <stop_token>
#include <stdexcept>
#include <string>
#include <utility>

namespace dimension {
// Pre-dispatch failures can be distinguished from an operation whose external
// effect is uncertain. In particular, human takeover must pause automated work.
struct DesktopError : std::runtime_error {
    std::string code;
    bool no_side_effects;
    bool waiting_for_user;
    DesktopError(std::string code, std::string message, bool no_side_effects = true,
                 bool waiting_for_user = false)
        : std::runtime_error(std::move(message)), code(std::move(code)), no_side_effects(no_side_effects),
          waiting_for_user(waiting_for_user) {}
};
struct DesktopOptions {
    std::filesystem::path data, wsl, helper;
    std::string distribution;
    std::string linux_home_root{};
};
class DesktopManager {
  public:
    explicit DesktopManager(DesktopOptions);
    ~DesktopManager();
    bool available() const;
    Json status(const std::string &bot_id, std::stop_token stop = {});
    Json software();
    Json set_software(const Json &apps);
    Json install_software(const std::string& bot_id, const Json& request,
                          const std::string& request_id, std::stop_token stop = {});
    Json settings(const std::string &bot_id);
    Json saved_settings(const std::string &bot_id) const;
    Json set_settings(const std::string &bot_id, const Json &patch);
    // Select the immutable project of a resumed Work run without changing the
    // user's preferred folder for new tasks. A human takeover is never stopped.
    void activate_project(const std::string& bot_id, const std::filesystem::path&,
                          std::stop_token stop = {});
    Json action(const std::string &bot_id, const Json &action, bool fast_input = false, bool from_user = true,
                std::stop_token stop = {});
    Json control(const std::string &bot_id, bool human);
    Json stop(const std::string &bot_id);
    HttpResponse stream(const std::string &bot_id);
    // Read only the active desktop's actual browser downloads. Snapshot tokens
    // bind chunk reads to one unchanged regular file; never resolve host paths.
    Json downloads(const std::string &bot_id, const Json &request = Json::Object{},
                   std::stop_token stop = {});
    void shutdown() noexcept;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
