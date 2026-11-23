#include "dimension/chat_knowledge.hpp"

#include <atomic>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace dimension;

namespace {

int g_checks = 0;

void check(bool cond, const char* msg) {
    if (!cond) {
        throw std::runtime_error(std::string("CHECK FAILED: ") + msg);
    }
    ++g_checks;
}

} // namespace

int main(int argc, char** argv) {
    try {
        std::filesystem::path dir = argc > 1
            ? std::filesystem::path(argv[1])
            : (std::filesystem::temp_directory_path() / L"dimension-chat-knowledge-test");
        std::error_code ec;
        std::filesystem::remove_all(dir, ec);
        std::filesystem::create_directories(dir, ec);

        // 1. HTML entity decoding & URL encoding
        check(ChatWebLookupEngine::decode_html_entities("A &amp; B &lt;tag&gt; &quot;hi&quot; &#65; &#x42;") == "A & B <tag> \"hi\" A B",
              "html entity decode");
        check(ChatWebLookupEngine::url_encode("hello world") == "hello%20world", "url encode ascii");
        check(ChatWebLookupEngine::url_encode("曼波").find('%') != std::string::npos, "url encode utf8");

        // 2. Bing RSS（含链接和站点徽章）、百度百科、B站详情/Tags、自定义源解析
        const std::string fake_rss =
            "<?xml version=\"1.0\"?><rss><channel>"
            "<item><title>哈基米（网络流行语）_百度百科</title>"
            "<link>https://baike.baidu.com/item/%E5%93%88%E5%9F%BA%E7%B1%B3/63015656</link>"
            "<description><![CDATA[哈基米是日语&quot;蜂蜜水&quot;的空耳，出自<b>赛马娘</b>动画。]]></description></item>"
            "<item><title>曼波是什么梗？_哔哩哔哩bilibili</title>"
            "<link>https://www.bilibili.com/video/BV1mA4m1c7od/</link>"
            "<description>已有60151名玩家向您推荐本视频，点击前往哔哩哔哩bilibili一起观看</description></item>"
            "<item><title>哈（汉语汉字）_百度百科</title><link>https://baike.baidu.com/item/1</link><description>单字字典噪声</description></item>"
            "</channel></rss>";
        const auto rss_items = ChatWebLookupEngine::parse_bing_rss(fake_rss, 5);
        check(rss_items.size() == 3, "rss item count");
        check(rss_items[0].title.find("哈基米") != std::string::npos, "rss title");
        check(rss_items[0].source_label == "百度百科", "rss baike label inferred");
        check(rss_items[0].url.find("baike.baidu.com") != std::string::npos, "rss link extracted");
        check(rss_items[1].source_label == "B站", "rss bilibili label inferred");
        check(rss_items[0].snippet.find("\"蜂蜜水\"") != std::string::npos, "rss entity decode");
        check(rss_items[0].snippet.find("<b>") == std::string::npos, "rss html stripped");

        // 2b. 核心词提纯与 BV 号识别
        check(ChatWebLookupEngine::extract_core_query("曼波 B站 什么梗？") == "曼波", "core query strips noisy suffixes");
        check(ChatWebLookupEngine::extract_core_query("哈基米南北绿豆 出处") == "哈基米南北绿豆", "core query strips source cue");
        check(ChatWebLookupEngine::extract_core_query("广智救我是什么梗") == "广智救我", "core query strips attached suffix");
        check(ChatWebLookupEngine::extract_bvid("看看这个 https://www.bilibili.com/video/BV1mA4m1c7od/?vd_source=1") == "BV1mA4m1c7od", "bvid extracted from url");
        check(ChatWebLookupEngine::extract_bvid("bv1WKnnzaEBU") == "BV1WKnnzaEBU", "bvid case normalized");

        // 2c. 百度百科公开接口 & B站 view/detail (含 Tags) & 梗Wiki HTML Meta & SearXNG JSON 解析
        const std::string fake_baike =
            R"json({"title":"哈基米","desc":"网络流行语","url":"http://baike.baidu.com/item/63015656","abstract":"哈基米，日语蜂蜜水的音译，出自赛马娘角色曲，后常用来称呼小猫。"})json";
        const auto bk_item = ChatWebLookupEngine::parse_baidu_baike_card(fake_baike);
        check(bk_item.has_value(), "baike parsed");
        check(bk_item->source_label == "百度百科", "baike label");
        check(bk_item->url.starts_with("https://baike.baidu.com/"), "baike url upgraded to https");

        const std::string fake_bili =
            R"json({"code":0,"data":{"View":{"bvid":"BV1mA4m1c7od","title":"曼波是什么梗？","tname":"搞笑","desc":"赛马娘诗歌剧二创洗脑梗科普","owner":{"name":"江湖百晓生呀"},"stat":{"view":3891513}},"Tags":[{"tag_name":"赛马娘"},{"tag_name":"曼波"},{"tag_name":"诗歌剧"}]}})json";
        const auto bv_item = ChatWebLookupEngine::parse_bilibili_view_detail(fake_bili, "BV1mA4m1c7od");
        check(bv_item.has_value(), "bilibili detail parsed");
        check(bv_item->source == "bilibili" && bv_item->source_label == "B站", "bilibili source & label");
        check(bv_item->snippet.find("诗歌剧") != std::string::npos && bv_item->snippet.find("389.2万") != std::string::npos, "bilibili tags & view count formatted");
        check(bv_item->url == "https://www.bilibili.com/video/BV1mA4m1c7od", "bilibili canonical url");

        const std::string fake_html =
            "<html><head><title>广智救我是什么梗｜来源、含义与用法 - 梗Wiki</title>"
            "<meta content=\"出自国产单机游戏《黑神话：悟空》，危机时变身广智扭转战局。\" name=\"description\"></head></html>";
        const auto html_items = ChatWebLookupEngine::parse_custom_response(fake_html, "cnmeme", "梗Wiki", "https://cnmeme.wiki/entry/gz", "html", 2);
        check(html_items.size() == 1, "html meta parsed regardless of attribute order");
        check(html_items[0].snippet.find("黑神话：悟空") != std::string::npos, "html meta description content");

        const std::string fake_searx =
            R"json({"results":[{"title":"萌娘百科：曼波","content":"待兼唐怀瑟哼唱的洗脑调子","url":"https://zh.moegirl.org.cn/曼波"}]})json";
        const auto sx_items = ChatWebLookupEngine::parse_custom_response(fake_searx, "custom:sx", "自建搜索", "http://127.0.0.1:8080/search?q=x", "auto", 3);
        check(sx_items.size() == 1 && sx_items[0].source_label == "自建搜索" && sx_items[0].url.find("moegirl") != std::string::npos, "searxng json parsed");

        const std::string fake_wiki =
            R"json({"query":{"pages":{"101":{"title":"哈基米 (网络用语)","fullurl":"https://zh.wikipedia.org/wiki/101","extract":"哈基米是2023年起流行的网络用语，原指蜂蜜水，后常用于指代小猫。"}}}})json";
        const auto wiki_items = ChatWebLookupEngine::parse_wikipedia_extracts(fake_wiki, "zhwiki", 2);
        check(wiki_items.size() == 1, "wiki item count");
        check(wiki_items[0].snippet.find("小猫") != std::string::npos, "wiki extract");
        check(wiki_items[0].url == "https://zh.wikipedia.org/wiki/101", "wiki fullurl preserved");

        // 3. 多源并发融合 + B站二段穿透补全 + 单字字典降权 + 缓存 + 自定义源配置持久化
        const auto cfg_path = dir / L"lookup_sources.json";
        std::atomic<int> http_calls{0};
        std::atomic<int> bili_enrich_calls{0};
        {
            ChatWebLookupEngine engine([&](const std::string& url, int, std::stop_token) -> HttpGetResult {
                http_calls.fetch_add(1);
                if (url.find("api.bilibili.com/x/web-interface/view/detail") != std::string::npos) {
                    bili_enrich_calls.fetch_add(1);
                    return {200, fake_bili, ""};
                }
                if (url.find("cn.bing.com") != std::string::npos) {
                    return {200, fake_rss, ""};
                }
                if (url.find("baike.baidu.com/api/openapi") != std::string::npos) {
                    return {200, fake_baike, ""};
                }
                if (url.find("cnmeme.wiki") != std::string::npos) {
                    return {200, fake_html, ""};
                }
                if (url.find("wikipedia.org") != std::string::npos) {
                    return {200, fake_wiki, ""};
                }
                if (url.find("custom.local/search") != std::string::npos) {
                    return {200, fake_searx, ""};
                }
                return {404, "", "not_found"};
            }, cfg_path);

            const auto r1 = engine.lookup("哈基米 B站 什么梗");
            check(r1.ok && !r1.from_cache, "first lookup live ok");
            check(r1.items.size() >= 3, "merged multi-source items");
            check(bili_enrich_calls.load() == 1, "bilibili generic rss description auto-enriched via view/detail");
            check(r1.summary.find("哈基米") != std::string::npos, "summary includes keyword");
            check(r1.summary.find("https://") != std::string::npos, "summary preserves source URLs");
            check(r1.items.front().title.find("汉语汉字") == std::string::npos, "single-char dictionary demoted");
            const int calls_after_r1 = http_calls.load();
            check(calls_after_r1 == 5, "called 4 primary sources + 1 bilibili enrichment");

            const auto r2 = engine.lookup("  哈基米 B站 什么梗  ");
            check(r2.ok && r2.from_cache, "second lookup served from cache");
            check(http_calls.load() == calls_after_r1, "cache prevented redundant network calls");

            // 直接查 BV 号直通 B站详情
            const auto rbv = engine.lookup("https://www.bilibili.com/video/BV1mA4m1c7od/");
            check(rbv.ok && !rbv.items.empty() && rbv.items[0].source == "bilibili", "direct bvid lookup ok");

            // 更新配置增加自定义搜索地址并校验非法地址被拒
            bool rejected_bad = false;
            try {
                (void)engine.update_config_json(Json::Object{
                    {"customSources", Json::Array{
                        Json::Object{{"name", "非法源"}, {"urlTemplate", "file:///etc/passwd?q={query}"}}
                    }}
                });
            } catch (const std::invalid_argument&) {
                rejected_bad = true;
            }
            check(rejected_bad, "non-http custom url template rejected");

            const auto saved_cfg = engine.update_config_json(Json::Object{
                {"enableBing", true},
                {"enableBaike", true},
                {"enableCnmeme", true},
                {"enableBilibiliDetail", true},
                {"enableWikipedia", false},
                {"priorityDomains", Json::Array{"bilibili.com", "moegirl.org.cn"}},
                {"customSources", Json::Array{
                    Json::Object{{"name", "我的二游站"}, {"urlTemplate", "http://custom.local/search?q={query}"}, {"format", "auto"}, {"enabled", true}}
                }}
            });
            check(!saved_cfg.enable_wikipedia && saved_cfg.custom_sources.size() == 1, "custom source config saved");

            const auto r_custom = engine.lookup("曼波");
            bool hit_custom = false;
            for (const auto& it : r_custom.items) {
                if (it.source_label == "我的二游站") hit_custom = true;
            }
            check(hit_custom, "custom search source participated in lookup");
        }

        // 重载搜索源配置文件验证持久化
        {
            ChatWebLookupEngine reloaded_eng({}, cfg_path);
            const auto cfg2 = reloaded_eng.get_config();
            check(!cfg2.enable_wikipedia && cfg2.custom_sources.size() == 1 && cfg2.custom_sources[0].name == "我的二游站",
                  "lookup config reloaded from disk");
        }

        // Empty/failing lookup gracefully guides persona honesty
        ChatWebLookupEngine failing_engine([](const std::string&, int, std::stop_token) -> HttpGetResult {
            return {0, "", "timeout"};
        });
        const auto rf = failing_engine.lookup("不存在的超神秘暗语xyz");
        check(!rf.ok, "failing lookup ok=false");
        check(rf.summary.find("请勿瞎编") != std::string::npos, "failing lookup warns against hallucination");

        // 4. Lorebook CRUD, scope isolation, instant keyword matching, persistence
        {
            LorebookStore store(dir);
            auto e1 = store.upsert_entry(LoreEntry{
                "", "曼波", {"曼波", "mambo", "诗歌剧"},
                "出自赛马娘角色诗歌剧哼唱的洗脑小曲，常用来卖萌起哄或打招呼。",
                "global", "manual", "stk_mambo", true, 0, 0, 0
            });
            check(!e1.id.empty(), "lore id generated");

            auto e2 = store.upsert_entry(LoreEntry{
                "", "秘密暗号", {"星空暗号"},
                "只有和 Gemini 单聊时才懂的晚安暗号。",
                "bot:ai-gemini", "manual", "", true, 0, 0, 0
            });
            check(e2.scope == "bot:ai-gemini", "bot scope preserved");

            auto e3 = store.upsert_entry(LoreEntry{
                "", "茶会黑话", {"翻车现场"},
                "特指昨天群里大家一起写代码把灯关掉的糗事。",
                "group:grp-1", "manual", "", true, 0, 0, 0
            });
            check(e3.scope == "group:grp-1", "group scope preserved");

            // Match global + bot scope
            const auto p_gem = store.match_prompt("哈哈曼波！今晚用星空暗号道晚安吧", "ai-gemini", "");
            check(p_gem.find("曼波") != std::string::npos, "global lore matched");
            check(p_gem.find("[sticker:stk_mambo]") != std::string::npos, "linked sticker hint injected");
            check(p_gem.find("秘密暗号") != std::string::npos, "bot-scoped lore matched for owner");
            check(p_gem.find("茶会黑话") == std::string::npos, "group-scoped lore not leaked to 1v1");

            // Bot isolation check
            const auto p_gpt = store.match_prompt("今晚用星空暗号吧", "ai-gpt", "");
            check(p_gpt.empty(), "bot-scoped lore isolated from other bots");

            // Group scope check
            const auto p_grp = store.match_prompt("简直是翻车现场啊 mambo", "ai-gpt", "grp-1");
            check(p_grp.find("茶会黑话") != std::string::npos, "group lore matched in matching group");
            check(p_grp.find("曼波") != std::string::npos, "ascii case-insensitive trigger matched");

            // Toggle off disables matching
            check(store.toggle_entry(e1.id, false).has_value(), "toggle entry");
            check(store.match_prompt("曼波", "ai-gpt", "").empty(), "disabled entry skipped");
            check(store.toggle_entry(e1.id, true).has_value(), "re-enable entry");

            // Export + import merge deduplication
            const auto exported = store.export_json();
            check(exported.at("entries").as_array().size() == 3, "export count 3");
            const Json batch = Json::Object{
                {"entries", Json::Array{
                    Json::Object{{"title", "曼波"}, {"triggers", Json::Array{"曼波", "南北绿豆"}}, {"meaning", "更新后的曼波玩梗释义"}, {"scope", "global"}},
                    Json::Object{{"title", "疯狂星期四"}, {"triggers", Json::Array{"V我50", "疯四"}}, {"meaning", "每周四编段子讨50元吃肯德基的玩梗文化"}, {"scope", "global"}}
                }}
            };
            const auto imp = store.import_json(batch);
            check(imp.added == 1 && imp.updated == 1, "import merge dedup");
            check(store.match_prompt("快 V我50 吧", "ai-claude", "").find("疯狂星期四") != std::string::npos,
                  "imported lore immediately matches");

            // 5. Auto-learning heuristic gate & offline fallback extraction
            check(!LorebookStore::has_learning_cue("今天天气真不错呀", ""), "casual chat skipped");
            check(LorebookStore::has_learning_cue("不是啦，草台班子的意思是大家临时凑一起硬撑场面", ""), "explaining cue detected");
            check(LorebookStore::has_learning_cue("其实就是大家一起开黑输麻了的自嘲说法", "诶？这是什么梗呀我没听过"), "followup explanation detected");

            const auto learned = store.auto_learn_from_turn(
                "给你科普一下，「绝绝子」的意思是用来夸张夸奖某个东西超级厉害或者绝了的网络热词。",
                "", "ai-gemini", "", {}, true);
            check(learned.triggered && learned.learned.size() == 1, "heuristic auto-learn extracted entry");
            check(learned.learned[0].title == "绝绝子", "auto-learn title clean");
            check(learned.learned[0].source == "auto_learned", "auto-learn source tagged");
            check(store.match_prompt("这波操作简直绝绝子", "ai-grok", "").find("绝绝子") != std::string::npos,
                  "auto-learned global lore immediately usable by all bots");

            // Auto-learn via light model callback
            const auto learned_m = store.auto_learn_from_turn(
                "我跟你讲，这其实出自某款二游名台词，大家喊「启动」就是准备通宵开黑的意思",
                "什么梗呀快教教我", "ai-claude", "",
                [](const std::string&, const std::string&) -> std::string {
                    return R"json([{"title":"启动梗","triggers":["启动","原神启动"],"meaning":"准备一起通宵开黑或郑重开始的调侃口号"}])json";
                }, true);
            check(learned_m.triggered && learned_m.learned.size() == 1, "model auto-learn extracted entry");
            check(store.match_prompt("今晚十点准时启动！", "ai-kimi", "").find("启动梗") != std::string::npos,
                  "model auto-learned lore immediately active");

            check(store.remove_entry(e2.id), "remove entry");
        }

        // Reload persistence check from disk
        {
            LorebookStore reloaded(dir);
            const auto listed = reloaded.list_json();
            check(listed.at("totalCount").as_number() >= 4.0, "persisted entries reloaded from disk");
            check(reloaded.match_prompt("绝绝子", "ai-qwen", "").find("绝绝子") != std::string::npos,
                  "reloaded auto-learned entry matches");
        }

        std::cout << "chat_knowledge: " << g_checks << " checks passed\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << ex.what() << "\n";
        return 1;
    }
}
