#pragma once
#include "dimension/http.hpp"
#include "dimension/json.hpp"
#include <filesystem>
#include <functional>
#include <memory>

namespace dimension {
struct AppOptions {
    std::filesystem::path data, ui, provider_file, node, plugin_host;
    std::filesystem::path wsl, desktop_helper;
    std::string sandbox_distribution;
    std::string desktop_home_root;
    // Trusted task-event notifications for the desktop host. This is not model
    // output and never includes Chat messages or reasoning.
    std::function<void(const Json&)> notification;
    std::function<HttpServerStats()> http_stats;
};
class Application {
  public:
    explicit Application(AppOptions);
    ~Application();
    HttpResponse handle(const HttpRequest &);
    void shutdown();

  private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
