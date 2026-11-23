#pragma once

#include "dimension/json.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct BotVoiceProfile {
    std::string voice_id;        // Breeze 已保存的 .breeze 音色 ID（留空则走中文 Voice Design）
    std::string instruction;     // 中文音色描述（Voice Design）或补充声线设定
    double cfg_scale = 1.5;      // 1.0 ~ 3.0，表现力与引导强度
    int seed = 42;               // 固定随机种子，保持同一角色声线稳定
    bool enabled = true;
};

struct BreezeTtsConfig {
    bool enabled = true;                         // 沉浸模式配音总开关（服务未开时静默降级无声）
    std::string endpoint = "http://127.0.0.1:8080";
    bool allow_lan = false;                      // 默认仅允许本机回环地址，开启后允许 RFC1918 私有局域网 IP
    std::string local_dir;                       // 本机 Breeze-TTS-2 目录（如 G:\breeze-cpp）
    bool use_cpu = false;                        // 显卡 Vulkan 不可用时可切换 --cpu 回退
    int parallel = 2;                            // 并发槽位数（1 ~ 4；Breeze 启用 cfg>1 时单流占 2 槽）
    bool mood_direction = true;                  // 是否将 16 种微表情联动为中文语气导演指令
    double default_cfg_scale = 1.5;              // 全局默认 cfg_scale
    std::map<std::string, BotVoiceProfile> bots; // 按 botId 覆盖的音色配置
};

struct BreezeHttpResponse {
    int status = 0;
    std::string content_type;
    std::string body;
    std::string error;
};

struct BreezeSpeakRequest {
    std::string bot_id;
    std::string text;
    std::string mood;            // 16 种微表情 key，如 "gentle", "shy", "hiss"
    std::string voice_id;        // 可选单次覆盖（如试听未保存的选项）
    std::string instruction;     // 可选单次覆盖
    std::optional<double> cfg_scale;
    std::optional<int> seed;
    bool preview = false;
};

struct BreezeSpeakResult {
    bool ok = false;
    bool offline = false;        // true 表示 Breeze 服务未启动或不可达，前端静默降级
    int http_status = 0;
    std::string content_type = "audio/wav";
    std::string audio_bytes;     // WAV 音频二进制字节
    std::string resolved_voice;  // 实际使用的 voice_id 或 "design"
    std::string resolved_mode;   // "voice_direction" | "voice_clone" | "voice_design"
    std::string sanitized_text;  // 清洗后实际朗读文本
    std::string error;
};

struct BreezeLocalInstallInfo {
    bool found = false;
    std::string root_dir;
    std::string server_exe;
    std::string model_gguf;
    std::string tokenizer_file;
    std::string missing_reason;
};

// 原生 Breeze-TTS-2 本地同源桥接与受控进程托管引擎。
// - 仅允许桥接本机 127.0.0.1/localhost（或用户显式开启的私有局域网 IP）
// - 托管拉起本机 breeze-server.exe 并绑定 JobObject，退出客户端自动清理释放约 4GB 显存
// - 单通道串行 + 409 busy 自动退避重试 + 16 情绪中文语气导演 + 8 位 AI 娘默认中文声线预设
class BreezeTtsBridge {
public:
    using HttpCallFn = std::function<BreezeHttpResponse(const std::string& method,
                                                        const std::string& url,
                                                        const std::string& content_type,
                                                        const std::string& body,
                                                        int timeout_ms,
                                                        std::stop_token stop)>;

    explicit BreezeTtsBridge(std::filesystem::path config_file = {}, HttpCallFn custom_http = {});
    ~BreezeTtsBridge();

    BreezeTtsBridge(const BreezeTtsBridge&) = delete;
    BreezeTtsBridge& operator=(const BreezeTtsBridge&) = delete;

    // 退出应用时立刻停止本机托管拉起的 Breeze 进程，释放显存。
    void shutdown();

    // 配置与状态查询
    BreezeTtsConfig get_config() const;
    Json config_json() const;
    BreezeTtsConfig update_config_json(const Json& doc);
    Json status_json(bool include_voices = true, std::stop_token stop = {}) const;
    Json list_voices_json(std::stop_token stop = {}) const;

    // 受控启动 / 停止 / 重启本机 Breeze-TTS-2 服务
    Json start_managed_server();
    Json stop_managed_server();

    // 合成单句 WAV 音频（带文本净化、角色音色解析、情绪导演与 409 退避重试）
    BreezeSpeakResult speak(const BreezeSpeakRequest& req, std::stop_token stop = {});

    // 暴露给单元测试与前端展示的纯静态辅助函数
    static BotVoiceProfile default_bot_profile(std::string_view bot_id);
    static std::string default_preview_line(std::string_view bot_id);
    static std::string mood_direction_prompt(std::string_view mood_key);
    static std::string sanitize_tts_text(std::string_view raw_text);
    static bool is_allowed_endpoint(std::string_view url, bool allow_lan, std::string* reason = nullptr);
    static BreezeLocalInstallInfo detect_local_install(std::string_view preferred_dir = {});
    static Json default_profiles_json();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
