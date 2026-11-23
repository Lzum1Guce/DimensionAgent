#pragma once
#include "dimension/process_session.hpp"
#include <condition_variable>
#include <mutex>
#include <map>
namespace dimension {
class WebsiteGuide {
public:
    // Returns null for ordinary Chat messages. Actions are selected from the user's command only.
    static Json command(const std::string& text);
    Json run(const std::filesystem::path& node, const std::filesystem::path& script,
             const std::filesystem::path& data, const std::filesystem::path& wsl, const std::string& distro,
             const std::filesystem::path& helper, const std::string& bot, Json command);
private:
    std::mutex launch_mutex_, mutex_;
    std::condition_variable changed_;
    std::map<std::string,Json> replies_;
    std::uint64_t next_ = 0;
    bool exited_ = false;
    std::unique_ptr<JsonProcessSession> process_;
};
}

