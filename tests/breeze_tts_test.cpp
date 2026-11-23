#include "dimension/breeze_tts.hpp"

#include <atomic>
#include <filesystem>
#include <fstream>
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

std::string make_fake_wav(std::size_t payload_bytes = 256) {
    std::string wav(44 + payload_bytes, '\0');
    wav[0] = 'R'; wav[1] = 'I'; wav[2] = 'F'; wav[3] = 'F';
    wav[8] = 'W'; wav[9] = 'A'; wav[10] = 'V'; wav[11] = 'E';
    wav[12] = 'f'; wav[13] = 'm'; wav[14] = 't'; wav[15] = ' ';
    wav[36] = 'd'; wav[37] = 'a'; wav[38] = 't'; wav[39] = 'a';
    return wav;
}

} // namespace

int main(int argc, char** argv) {
    try {
        std::filesystem::path dir = argc > 1
            ? std::filesystem::path(argv[1])
            : (std::filesystem::temp_directory_path() / L"dimension-breeze-tts-test");
        std::error_code ec;
        std::filesystem::remove_all(dir, ec);
        std::filesystem::create_directories(dir, ec);

        // 1. 端点安全边界校验（严格阻止公网/凭据/非法协议，默认仅放行回环，允许局域网时放行 RFC1918）
        check(BreezeTtsBridge::is_allowed_endpoint("http://127.0.0.1:8080", false), "loopback ipv4 ok");
        check(BreezeTtsBridge::is_allowed_endpoint("http://localhost:8137", false), "localhost ok");
        check(BreezeTtsBridge::is_allowed_endpoint("http://[::1]:8080", false), "ipv6 loopback ok");
        check(!BreezeTtsBridge::is_allowed_endpoint("http://192.168.1.50:8080", false), "lan blocked when allow_lan=false");
        check(BreezeTtsBridge::is_allowed_endpoint("http://192.168.1.50:8080", true), "lan allowed when allow_lan=true");
        check(BreezeTtsBridge::is_allowed_endpoint("http://10.0.0.5:8080", true), "10.x lan ok");
        check(!BreezeTtsBridge::is_allowed_endpoint("https://example.com:8080", true), "public domain always rejected");
        check(!BreezeTtsBridge::is_allowed_endpoint("http://8.8.8.8:8080", true), "public ip always rejected");
        check(!BreezeTtsBridge::is_allowed_endpoint("http://user:pass@127.0.0.1:8080", true), "embedded creds rejected");
        check(!BreezeTtsBridge::is_allowed_endpoint("file:///C:/test", true), "file scheme rejected");

        // 2. 朗读文本智能净化
        const auto s1 = BreezeTtsBridge::sanitize_tts_text(
            "「[mood:shy]害、害羞什么，我只是懒得跟你吵。[gentle]……好吧，有一丢丢。[sticker:stk_01]」");
        check(s1.find("[mood:") == std::string::npos, "explicit mood tag stripped");
        check(s1.find("[gentle]") == std::string::npos, "bare mood tag stripped");
        check(s1.find("[sticker:") == std::string::npos, "sticker tag stripped");
        check(s1.find("害、害羞什么") != std::string::npos && s1.find("有一丢丢") != std::string::npos, "dialogue text preserved");

        const auto s2 = BreezeTtsBridge::sanitize_tts_text("```cpp\nint x = 1;\n```\n看看这个 https://example.com/a **超酷**！");
        check(s2.find("int x") == std::string::npos, "fenced code block stripped");
        check(s2.find("https://") == std::string::npos, "url stripped");
        check(s2.find("**") == std::string::npos, "markdown stars stripped");
        check(s2.find("超酷") != std::string::npos, "clean text kept");

        check(BreezeTtsBridge::sanitize_tts_text("```js\nconsole.log(1)\n```").empty(), "pure code block returns empty");
        check(BreezeTtsBridge::sanitize_tts_text("……！？").empty(), "pure punctuation returns empty");

        // 3. 8 位 AI 娘默认中文音色描述与 16 情绪导演表
        const auto defs = BreezeTtsBridge::default_profiles_json();
        check(defs.is_object() && defs.as_object().size() == 8, "8 default AI girl profiles");
        check(BreezeTtsBridge::default_bot_profile("ai-gemini").seed != BreezeTtsBridge::default_bot_profile("ai-claude").seed,
              "distinct seeds across characters");
        check(BreezeTtsBridge::mood_direction_prompt("gentle").find("温柔") != std::string::npos, "gentle mood direction");
        check(BreezeTtsBridge::mood_direction_prompt("hiss").find("炸毛") != std::string::npos, "hiss mood direction");

        // 4. 本地 Breeze 目录自动探测（在临时目录构造伪目录结构）
        {
            const auto fake_root = dir / L"fake-breeze";
            std::filesystem::create_directories(fake_root / L"breeze-tts-2-vulkan");
            std::filesystem::create_directories(fake_root / L"audio_tokenizer");
            std::ofstream(fake_root / L"breeze-tts-2-vulkan" / L"breeze-server.exe") << "exe";
            std::ofstream(fake_root / L"breeze-tts-2-q8_0.gguf") << "gguf";
            std::ofstream(fake_root / L"audio_tokenizer" / L"model.safetensors") << "tok";
            const auto det = BreezeTtsBridge::detect_local_install(fake_root.string());
            check(det.found, "detected complete fake local install");
            check(det.server_exe.find("breeze-server.exe") != std::string::npos, "found nested server exe");
            check(det.model_gguf.find("q8_0.gguf") != std::string::npos, "found q8_0 gguf");
        }

        // 5. Voice Design + 409 退避重试 + Voice Direction + 离线降级 + 配置持久化
        const auto cfg_path = dir / L"breeze_config.json";
        std::atomic<int> speech_calls{0};
        std::string last_speech_body;
        {
            BreezeTtsBridge bridge(cfg_path, [&](const std::string& method,
                                                 const std::string& url,
                                                 const std::string&,
                                                 const std::string& body,
                                                 int,
                                                 std::stop_token) -> BreezeHttpResponse {
                if (method == "GET" && url.ends_with("/health")) {
                    return {200, "application/json", R"({"status":"ok","sample_rate":24000,"ws_port":8081})", ""};
                }
                if (method == "GET" && url.ends_with("/v1/voices")) {
                    return {200, "application/json", R"([{"id":"gemini_sweet","saved":true,"seconds":4.8,"description":"灵动猫娘"}])", ""};
                }
                if (method == "POST" && url.ends_with("/v1/audio/speech")) {
                    last_speech_body = body;
                    const int n = speech_calls.fetch_add(1);
                    if (n == 0) {
                        return {409, "application/json", R"({"error":"busy"})", ""};
                    }
                    return {200, "audio/wav", make_fake_wav(512), ""};
                }
                return {404, "application/json", R"({"error":"not_found"})", ""};
            });

            const auto st = bridge.status_json(true);
            check(st.at("online").as_bool() && st.at("state").as_string() == "ready", "status online ready");
            check(st.at("sampleRate").as_number() == 24000.0, "sample rate parsed");
            check(st.at("voices").as_array().size() == 1, "voices fetched");

            // 首次调用触发 409 -> 自动退避重试成功；默认无 voice_id 走 Voice Design 且不含 voice 字段
            BreezeSpeakRequest req1;
            req1.bot_id = "ai-gemini";
            req1.text = "[mood:shy]哼，才不是特意等你呢！";
            req1.mood = "shy";
            const auto r1 = bridge.speak(req1);
            check(r1.ok && !r1.offline, "voice design succeeded after 409 retry");
            check(speech_calls.load() == 2, "409 retry occurred exactly once");
            check(r1.resolved_mode == "voice_design" && r1.resolved_voice == "design", "voice design mode resolved");
            check(r1.audio_bytes.size() == 44 + 512, "wav payload returned intact");
            const auto body1 = Json::parse(last_speech_body);
            check(!body1.find("voice"), "voice design omits voice field so breeze will not 404");
            check(body1.at("instructions").as_string().find("害羞") != std::string::npos, "shy mood appended to instruction");
            check(body1.at("cfg_scale").as_number() >= 1.8, "high-emotion mood boosts cfg_scale slightly");

            // 校验非法音色 ID（中文名）被拒
            bool rejected_cn_voice = false;
            try {
                (void)bridge.update_config_json(Json::Object{
                    {"bots", Json::Object{
                        {"ai-gemini", Json::Object{{"voiceId", "猫娘音色"}}}
                    }}
                });
            } catch (const std::invalid_argument&) {
                rejected_cn_voice = true;
            }
            check(rejected_cn_voice, "non-ascii voice id rejected per breeze rules");

            // 保存绑定固化音色并走 Voice Direction 模式
            (void)bridge.update_config_json(Json::Object{
                {"endpoint", "http://127.0.0.1:8080"},
                {"moodDirection", true},
                {"bots", Json::Object{
                    {"ai-gemini", Json::Object{{"voiceId", "gemini_sweet"}, {"cfgScale", 1.7}}}
                }}
            });
            BreezeSpeakRequest req2;
            req2.bot_id = "ai-gemini";
            req2.text = "好吧，有一丢丢想你。";
            req2.mood = "gentle";
            const auto r2 = bridge.speak(req2);
            check(r2.ok && r2.resolved_mode == "voice_direction" && r2.resolved_voice == "gemini_sweet", "saved voice + mood direction");
            const auto body2 = Json::parse(last_speech_body);
            check(body2.at("voice").as_string() == "gemini_sweet", "saved voice id forwarded");
            check(body2.at("instructions").as_string().find("温柔") != std::string::npos, "gentle direction forwarded");
        }

        // 6. 重载配置文件 + 服务离线静默标记验证
        {
            BreezeTtsBridge offline_bridge(cfg_path, [](const std::string&, const std::string&, const std::string&,
                                                        const std::string&, int, std::stop_token) -> BreezeHttpResponse {
                return {0, "", "", "connect_failed_12029"};
            });
            const auto cfg2 = offline_bridge.get_config();
            check(cfg2.bots.contains("ai-gemini") && cfg2.bots.at("ai-gemini").voice_id == "gemini_sweet",
                  "persisted bot voice config reloaded");
            BreezeSpeakRequest req3;
            req3.bot_id = "ai-gemini";
            req3.text = "离线静默测试";
            const auto r3 = offline_bridge.speak(req3);
            check(!r3.ok && r3.offline, "offline breeze cleanly flagged for silent fallback");
        }

        std::cout << "breeze_tts: " << g_checks << " checks passed\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << ex.what() << "\n";
        return 1;
    }
}
