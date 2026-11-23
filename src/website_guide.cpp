#include "dimension/website_guide.hpp"
#include <cstdlib>
#include <sstream>
namespace dimension {
Json WebsiteGuide::command(const std::string& text) {
    std::istringstream words(text);
    std::string verb, arg;
    words >> verb >> arg;
    if (verb == "/浏览" || ((verb == "打开" || verb == "帮我打开" || verb == "浏览") &&
        (arg.starts_with("https://") || arg.starts_with("http://")))) return Json::Object{{"action","open"},{"url",arg}};
    for (std::string_view prefix : {"/搜索 ", "帮我上网找", "帮我上网查", "帮我上网搜", "帮我搜索", "上网搜一下", "上网找一下", "去浏览器找", "帮我用浏览器找", "帮我查一下", "帮我找一下", "搜一下", "搜索一下"}) {
        if (text.starts_with(prefix)) {
            auto query = text.substr(prefix.size());
            const auto first = query.find_first_not_of(" \t\r\n");
            if (first != std::string::npos) query.erase(0, first);
            return Json::Object{{"action","search"},{"query",query}};
        }
    }
    if (verb == "/网页" || text == "看看当前网页" || text == "刷新当前网页") return Json::Object{{"action","read"}};
    if (verb == "/定位" || verb == "/点击") return Json::Object{{"action",verb == "/点击" ? "click" : "point"},{"ref",arg}};
    if (verb == "/关闭网页") return Json::Object{{"action","close"}};
    return {};
}
Json WebsiteGuide::run(const std::filesystem::path& node, const std::filesystem::path& script,
                       const std::filesystem::path& data, const std::filesystem::path& wsl, const std::string& distro,
                       const std::filesystem::path& helper, const std::string& bot, Json cmd) {
    if (distro.empty() || wsl.empty() || helper.empty()) throw std::runtime_error("内置网站沙盒未配置");
    std::unique_lock launch(launch_mutex_);
    if (!process_ || !process_->running()) {
        process_.reset();
        { std::lock_guard lk(mutex_); exited_ = false; }
        ProcessEnvironment env;
        for (const auto* key : {L"ProgramFiles", L"ProgramFiles(x86)", L"LOCALAPPDATA", L"APPDATA", L"USERPROFILE"}) {
            wchar_t* raw = nullptr;
            std::size_t size = 0;
            if (_wdupenv_s(&raw, &size, key) == 0 && raw) {
                env[std::wstring_view(key) == L"ProgramFiles(x86)" ? L"DIMENSION_PROGRAMFILES_X86" : key] = raw;
                std::free(raw);
            }
        }
        process_ = std::make_unique<JsonProcessSession>(node, std::vector<std::wstring>{script.wstring(), wsl.wstring(), std::filesystem::u8path(distro).wstring(),
            (helper.parent_path()/L"dimension-sandbox-root.sh").wstring()}, data,
            [this](const Json& msg) {
                std::lock_guard lk(mutex_);
                if (auto id = msg.find("id"); id && id->is_string()) {
                    if(auto i = replies_.find(id->as_string()); i != replies_.end()) i->second = msg;
                } else if (auto ev = msg.find("event"); ev && ev->is_string() && ev->as_string()=="exit") exited_=true;
                changed_.notify_all();
            }, env);
    }
    std::unique_lock lk(mutex_);
    auto id = std::to_string(++next_);
    cmd["id"]=id; cmd["bot"]=bot;
    const auto timeout = cmd.at("action").as_string() == "search" ? std::chrono::seconds(50) : std::chrono::seconds(30);
    replies_[id] = Json();
    if (!process_->send(cmd)) { replies_.erase(id); throw std::runtime_error("网站助手未就绪"); }
    launch.unlock();
    changed_.wait_for(lk,timeout,[&]{return exited_ || !replies_.at(id).is_null();});
    auto reply = replies_.extract(id).mapped();
    if (reply.is_null()) throw std::runtime_error("浏览器未响应，请查看网站窗口");
    return reply;
}
}

