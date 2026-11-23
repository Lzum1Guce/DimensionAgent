#pragma once

#include "dimension/json.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct WebLookupItem {
    std::string source;        // "bilibili" | "cnmeme" | "baike" | "bing" | "zhwiki" | "enwiki" | "custom:<id>"
    std::string source_label;  // 中文来源徽章，如 "B站" | "梗Wiki" | "百度百科" | "知乎" | "维基百科"
    std::string title;
    std::string snippet;
    std::string url;           // 原始出处链接（供模型理解来源及界面点击打开）
};

struct WebLookupResult {
    bool ok = false;
    bool from_cache = false;
    std::string query;
    std::string summary;  // 可直接注入聊天上下文的自然语言摘要
    std::vector<WebLookupItem> items;
    std::string error;
};

struct CustomSearchSource {
    std::string id;              // 唯一标识，如 "src_xxxx"
    std::string name;            // 显示名称，如 "二次元梗站" / "本地SearXNG"
    std::string url_template;    // 必须为 http(s):// 且包含 {query} 占位符
    std::string format = "auto"; // "auto" | "rss" | "json" | "html"
    bool enabled = true;
};

struct WebLookupConfig {
    bool enable_bing = true;
    bool enable_baike = true;
    bool enable_cnmeme = true;
    bool enable_bilibili_detail = true;
    bool enable_wikipedia = true;
    std::vector<std::string> priority_domains = {
        "bilibili.com", "cnmeme.wiki", "baike.baidu.com",
        "zhihu.com", "moegirl.org.cn", "wiki.biligame.com"
    };
    std::vector<CustomSearchSource> custom_sources;
};

struct HttpGetResult {
    int status = 0;
    std::string body;
    std::string error;
};

// 免配置多源并行查梗与百科引擎（Bing CN + 百度百科 + 梗Wiki + B站视频详情/Tags + 维基百科 + 自定义搜索地址）。
// 严格只读、短超时（默认 3500ms）、线程安全并带内存 TTL 缓存与配置持久化。
class ChatWebLookupEngine {
public:
    using HttpGetFn = std::function<HttpGetResult(const std::string& url, int timeout_ms, std::stop_token stop)>;

    explicit ChatWebLookupEngine(HttpGetFn custom_http = {}, std::filesystem::path config_file = {});
    ~ChatWebLookupEngine();

    ChatWebLookupEngine(const ChatWebLookupEngine&) = delete;
    ChatWebLookupEngine& operator=(const ChatWebLookupEngine&) = delete;

    WebLookupResult lookup(std::string_view raw_query,
                           std::stop_token stop = {},
                           int timeout_ms = 3500);

    // 搜索源与自定义地址配置读写（更新时自动持久化并刷新内存缓存）。
    WebLookupConfig get_config() const;
    Json config_json() const;
    WebLookupConfig update_config(const WebLookupConfig& cfg);
    WebLookupConfig update_config_json(const Json& doc);
    void clear_cache();

    // 暴露给离线单元测试的纯解析与辅助工具。
    static std::vector<WebLookupItem> parse_bing_rss(std::string_view xml_body, std::size_t max_items = 5);
    static std::vector<WebLookupItem> parse_wikipedia_extracts(std::string_view json_body,
                                                               std::string_view source_tag,
                                                               std::size_t max_items = 3);
    static std::optional<WebLookupItem> parse_baidu_baike_card(std::string_view json_body);
    static std::optional<WebLookupItem> parse_bilibili_view_detail(std::string_view json_body,
                                                                   std::string_view bvid_hint = {});
    static std::vector<WebLookupItem> parse_custom_response(std::string_view body,
                                                            std::string_view source_tag,
                                                            std::string_view source_label,
                                                            std::string_view request_url,
                                                            std::string_view format = "auto",
                                                            std::size_t max_items = 3);
    static std::string extract_core_query(std::string_view raw_query);
    static std::string extract_bvid(std::string_view text);
    static std::string infer_source_label(std::string_view source, std::string_view url = {});
    static std::string decode_html_entities(std::string_view text);
    static std::string url_encode(std::string_view text);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

struct LoreEntry {
    std::string id;
    std::string title;
    std::vector<std::string> triggers;
    std::string meaning;
    std::string scope = "global";      // "global" | "bot:<botId>" | "group:<groupId>"
    std::string source = "manual";     // "manual" | "auto_learned" | "web_cached" | "imported"
    std::string sticker_id;            // Optional linked sticker ID
    bool enabled = true;
    std::uint64_t hit_count = 0;
    std::int64_t created_at_ms = 0;
    std::int64_t updated_at_ms = 0;
};

struct LoreAutoLearnResult {
    bool triggered = false;
    std::vector<LoreEntry> learned;
};

// Shared Lorebook & Inside-Joke Glossary store with instant keyword matching and auto-learning.
class LorebookStore {
public:
    using LightModelFn = std::function<std::string(const std::string& system_prompt, const std::string& user_prompt)>;

    explicit LorebookStore(std::filesystem::path data_dir);
    ~LorebookStore();

    LorebookStore(const LorebookStore&) = delete;
    LorebookStore& operator=(const LorebookStore&) = delete;

    // Instant zero-bloat keyword trigger: scans latest user text & recent anchor, injects top matched lore cards.
    std::string match_prompt(std::string_view text,
                             std::string_view bot_id,
                             std::string_view group_id = {},
                             std::size_t max_items = 5);

    std::vector<LoreEntry> match_entries(std::string_view text,
                                         std::string_view bot_id,
                                         std::string_view group_id = {},
                                         std::size_t max_items = 5);

    LoreEntry upsert_entry(const LoreEntry& draft);
    bool remove_entry(std::string_view id);
    std::optional<LoreEntry> toggle_entry(std::string_view id, bool enabled);

    struct ImportSummary {
        std::size_t added = 0;
        std::size_t updated = 0;
        std::size_t skipped = 0;
    };
    ImportSummary import_json(const Json& payload);
    Json export_json() const;
    Json list_json() const;

    // Fast zero-cost heuristic gate checking if the user is explaining/correcting a meme or term.
    static bool has_learning_cue(std::string_view user_text, std::string_view prev_bot_text = {});

    // Auto-learns new lore/memes when the user explains or corrects a term in chat.
    LoreAutoLearnResult auto_learn_from_turn(std::string_view user_text,
                                             std::string_view prev_bot_text,
                                             std::string_view bot_id,
                                             std::string_view group_id,
                                             const LightModelFn& light_model = {},
                                             bool default_global = true);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
