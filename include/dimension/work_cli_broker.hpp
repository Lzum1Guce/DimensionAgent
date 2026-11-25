#pragma once

#include "dimension/json.hpp"
#include "dimension/model.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

// Supported full-power native Agent CLI harnesses.
// Each CLI is a standalone agent harness binary, while open harnesses (Hermes, Kimi Code,
// Claude Code, Codex, OpenCode, Qwen Code) can dynamically switch across arbitrary models.
struct CliNativeModelGroup {
    std::string group_title;             // e.g. "本机配置", "KIMI CODING", "DEEPSEEK"
    std::string provider_arg;            // Optional CLI --provider value (used by Hermes native providers)
    std::vector<std::string> models;     // Selectable native model IDs / aliases
    Json to_json() const;
};

struct CliHarnessDescriptor {
    std::string id;               // "hermes", "deepseek-harness", "kimi-code", "claude-code", "codex", "opencode", "qwen-code", "gemini-cli"
    std::string name;             // Display label
    std::string platform;         // Active platform resolved by execution policy: "wsl" (Bubblewrap sandbox) or "windows"
    std::string binary_path;      // Resolved active absolute path when installed
    std::string version;          // Optional detected version string
    bool installed = false;
    bool supports_custom_model = true;
    bool supports_session_resume = true;
    bool supports_stream_json = true;
    bool native_configured = false;                      // True if native login/config detected on disk
    std::string native_status_label;                     // Clean Chinese status e.g. "已就绪 · 原生配置已连接"
    std::string native_default_model;                    // Detected default model in native config if any
    std::vector<CliNativeModelGroup> native_model_groups;// Discovered + built-in native subscription models

    // Dual-location (Sandbox vs Host) awareness for Bubblewrap CLI isolation & in-app downloader
    bool sandbox_installed = false;
    std::string sandbox_binary_path;
    std::string sandbox_version;
    bool sandbox_native_configured = false;
    bool host_installed = false;
    std::string host_binary_path;
    std::string host_version;
    bool host_native_configured = false;
    bool sandbox_installable = true;
    std::string sandbox_install_package;                 // Official npm package or official Linux installer URL
    std::string execution_mode;                          // "sandbox" | "host" | ""
    Json to_json() const;
};

struct PreservedConstraintSet {
    std::vector<std::string> hard_constraints; // Verbatim guardrails extracted from raw user prompt
    bool forbid_tests = false;
    bool forbid_skills = false;
    bool forbid_network = false;
    bool forbid_memory = false;
    bool single_file_only = false;
};

struct BrokerEnrichRequest {
    std::string bot_id;
    std::string bot_name;
    std::string bot_persona;       // Bot SOUL / character personality traits
    std::string bot_specialties;   // Optional capability card specialties
    std::string raw_user_prompt;
    bool is_group_member = false;
    ModelConfig chat_slot_model;   // Uses Chat slot exclusively (never overrides Work slot)
};

struct BrokerEnrichResult {
    std::string greeting;          // 1-2 sentence in-character acceptance line
    std::string enriched_prompt;   // Enriched engineering brief passed to the CLI harness
    PreservedConstraintSet constraints;
    bool used_model_enrichment = false;
    Json to_json() const;
};

// Unified stream event normalized across Hermes, Kimi Code, Claude Code, Codex, OpenCode, Qwen & Gemini CLI.
struct NormalizedCliEvent {
    // "init" | "thinking" | "commentary" | "tool_start" | "tool_end" | "result"
    std::string kind;
    std::string session_id;
    std::string text;              // Commentary text, thinking text, or final summary
    std::string tool_call_id;
    std::string tool_name;
    // Programmatic rollup category: "read" | "edit" | "command" | "search" | "notify" | "other"
    std::string action_category;
    std::string display_verb;      // e.g. "阅读", "编辑", "运行命令", "内容检索"
    std::string display_target;    // e.g. "app.cpp" or "检查 Hermes 实际运行环境目录约定"
    std::string args_json;
    std::string output;
    std::string detected_dev_url;  // Auto-captured http://localhost:<port> / http://127.0.0.1:<port>
    std::int64_t duration_ms = 0;
    bool is_error = false;
    int exit_code = 0;
    std::int64_t input_tokens = 0;
    std::int64_t output_tokens = 0;
    Json to_json() const;
};

struct WorkspaceFileDelta {
    std::filesystem::path absolute_path;
    std::string relative_path;
    bool created = false;
    std::string before_content;    // Populated for modified text files <= 512 KiB for inline Diff
    std::string after_content;
    std::uintmax_t bytes = 0;
};

struct CliHarnessRunRequest {
    std::string engine_id = "auto";      // "auto", "hermes", "kimi-code", "claude-code", "codex", "opencode", "qwen-code", "gemini-cli"
    std::string model_source = "work";   // "work" (inject Dimension Work-slot model/key) or "native" (use CLI's own login/config)
    std::string bot_id;
    std::string session_key;             // Deterministic per-(threadRoot, botId) key for persistent native CLI sessions
    std::string prompt;                  // Enriched prompt to execute
    PreservedConstraintSet constraints;
    ModelConfig work_slot_model;         // Dimension Work-slot endpoint, API key, and model
    std::string native_provider;         // Optional native provider ID when model_source == "native"
    std::string native_model;            // Optional explicit native model ID when model_source == "native"
    std::filesystem::path workspace_dir; // Target project or isolated task workspace directory
    std::vector<std::filesystem::path> image_paths; // Pasted/attached visual reference images for Vision-to-Work
    std::filesystem::path data_root;     // Dimension native-data-v1 root (hosts per-Bot isolated CLI homes)
    std::filesystem::path app_root;      // Dimension deploy root (hosts native-runtime/cli-kit & runtime/node)
    std::filesystem::path wsl_executable;
    std::string sandbox_distribution;
    bool require_exact_engine = false;
    bool file_prompt_for_batch = false; // Keep project file contents out of cmd.exe argument parsing.
    bool use_worktree = false;           // Optional git worktree isolation for concurrent multi-bot edits
    bool read_only_reception = false;    // Read-only Work reception/orchestration mode (no workspace writes, no skills/MCP)
    std::string execution_policy = "sandbox_first"; // "sandbox_first" | "sandbox_only" | "host_prefer"
    bool require_sandbox = false;        // Hard-enforce Bubblewrap WSL sandbox execution (never fall back to host)
    int timeout_seconds = 1200;
};

struct CliHarnessRunResult {
    bool success = false;
    bool cancelled = false;
    int exit_code = -1;
    std::string resolved_engine_id;
    std::string resolved_engine_name;
    std::string resolved_model_label;
    std::string native_session_id;
    std::string final_response;
    std::string error_detail;
    std::int64_t duration_ms = 0;
    std::int64_t input_tokens = 0;
    std::int64_t output_tokens = 0;
    std::vector<WorkspaceFileDelta> file_deltas;
    Json to_json() const;
};

using CliEventCallback = std::function<void(const NormalizedCliEvent&)>;
using BrokerCaller = std::function<ModelReply(const ModelConfig&, const std::vector<ModelMessage>&, std::stop_token)>;

// 1. Deterministically extracts hard user constraints (no tests, no skills, no network, etc.)
//    so they can never be diluted or dropped by persona enrichment.
PreservedConstraintSet extract_preserved_constraints(std::string_view raw_prompt);

// 2. Strips any speech-length / verbosity / roleplay-terse constraints that could accidentally
//    suppress engineering output quality if leaked into a coding CLI prompt.
std::string scrub_speech_constraints(std::string_view text);

// 3. Enriches the user's raw requirement through the Bot's persona using the Chat model slot,
//    strictly preserving original boundaries without adding/removing speech constraints.
BrokerEnrichResult enrich_prompt_with_persona(const BrokerEnrichRequest& req,
                                              const BrokerCaller& caller = {},
                                              std::stop_token stop = {});

// 3b. Zero-latency (<0.1ms) persona brief synthesizer for Fast-Track Concurrent CLI launch:
//     Injects scrubbed persona aesthetic cues + 100% locked hard constraints without blocking on an HTTP roundtrip.
std::string fast_synthesize_persona_brief(const std::string& bot_name,
                                          const std::string& bot_persona,
                                          std::string_view raw_task,
                                          const PreservedConstraintSet& constraints,
                                          std::string_view explicit_taste_notes = {});

// Extracts any localhost / 127.0.0.1 dev server URL (excluding Dimension's internal 18788 API port) from CLI text/output.
std::string extract_local_dev_url(std::string_view text);

// 4. Rewrites or wraps the raw CLI engineering output in the Bot's own voice (Chat slot) while
//    preserving 100% of file paths, metrics, and technical facts.
std::string compose_persona_delivery(const std::string& bot_name,
                                     const std::string& bot_persona,
                                     const std::string& user_goal,
                                     const CliHarnessRunResult& cli_result,
                                     const ModelConfig& chat_slot_model,
                                     const BrokerCaller& caller = {},
                                     std::stop_token stop = {});

// 5. Discovers all 8 mainstream Agent CLIs across WSL Bubblewrap sandbox (/opt/dimension-tools),
//    Windows host, and bundled cli-kit, resolving active runtime according to execution_policy.
std::vector<CliHarnessDescriptor> discover_cli_harnesses(const std::filesystem::path& app_root,
                                                         const std::filesystem::path& wsl_executable = {},
                                                         const std::string& sandbox_distribution = {},
                                                         std::string_view execution_policy = "sandbox_first");

// 5b. Sandbox CLI environment probe, controlled in-sandbox downloader/uninstaller, and interactive login launcher.
struct SandboxCliEnvironmentStatus {
    bool wsl_available = false;
    bool distro_ready = false;
    bool bwrap_ready = false;
    bool node_ready = false;
    bool npm_ready = false;
    bool python_ready = false;
    bool ready = false;
    std::string node_version;
    std::string detail;
    Json to_json() const;
};

struct SandboxCliInstallRequest {
    std::string engine_id;                          // Valid CLI engine ID (excluding auto/builtin)
    std::string action = "install";                 // "install" | "update" | "uninstall"
    std::string registry = "npmmirror";             // "npmmirror" | "official"
    bool clear_credentials = false;                 // Optional on uninstall: wipe /var/lib/dimension-cli-homes/<engine>
    std::filesystem::path wsl_executable;
    std::string sandbox_distribution;
};

struct SandboxCliInstallResult {
    bool ok = false;
    bool cancelled = false;
    int exit_code = -1;
    std::string engine_id;
    std::string version;
    std::string binary_path;
    std::string error;
    std::vector<std::string> logs;
    Json to_json() const;
};

SandboxCliEnvironmentStatus probe_sandbox_cli_environment(const std::filesystem::path& wsl_executable,
                                                          const std::string& sandbox_distribution);

SandboxCliInstallResult manage_sandbox_cli(const SandboxCliInstallRequest& req,
                                           const std::function<void(std::string_view)>& on_log = {},
                                           std::stop_token stop = {});

Json launch_sandbox_cli_login_terminal(const std::string& engine_id,
                                       const std::filesystem::path& wsl_executable,
                                       const std::string& sandbox_distribution);

Json launch_host_cli_login_terminal(const std::string& engine_id,
                                    const std::filesystem::path& app_root);

// Lightweight background keep-alive daemon that keeps WSL2 dimension-sandbox warm
// so Agents and DimensionImage can invoke all installed CLIs without cold-start lag.
class CliSandboxKeepAliveDaemon {
public:
    CliSandboxKeepAliveDaemon() = default;
    ~CliSandboxKeepAliveDaemon();
    CliSandboxKeepAliveDaemon(const CliSandboxKeepAliveDaemon&) = delete;
    CliSandboxKeepAliveDaemon& operator=(const CliSandboxKeepAliveDaemon&) = delete;

    Json start(const std::filesystem::path& wsl_executable, const std::string& sandbox_distribution);
    Json stop();
    Json status() const;

private:
    Json status_locked() const;
    void close_handle_locked() const;

    mutable std::mutex mu_;
    mutable void* process_handle_ = nullptr;
    mutable std::uint32_t pid_ = 0;
    mutable std::int64_t started_ms_ = 0;
    mutable std::string distro_;
    mutable std::string last_error_;
};

bool query_windows_autostart_enabled();
Json set_windows_autostart_enabled(bool enable, const std::filesystem::path& host_exe_path);

// Converts a Windows drive path (e.g. L:\proj) or WSL UNC path (\\wsl.localhost\distro\home\...) to Linux path.
std::string windows_path_to_wsl_path(const std::filesystem::path& win_path,
                                     const std::string& sandbox_distribution = {});

// 6. Normalizes a single JSONL line from Hermes, Kimi Code, Claude Code, Codex, OpenCode, Qwen, or Gemini CLI.
//    Returns true if the line was a recognized structured event.
bool parse_cli_json_event(std::string_view engine_id,
                          std::string_view raw_line,
                          NormalizedCliEvent& out_event);

// 7. Categorizes any tool call (native or CLI) into programmatic rollup buckets ("read", "edit", "command", "search", "notify")
//    and extracts a clean human-readable verb + short target for the vertical step tree.
void classify_tool_for_rollup(std::string_view tool_name,
                              std::string_view args_json,
                              std::string& out_category,
                              std::string& out_verb,
                              std::string& out_target);

// 8. Builds the command-line arguments and isolated per-Bot environment for any supported CLI harness
//    (exposed for deterministic unit testing as well as live execution).
struct PreparedCliInvocation {
    std::string engine_id;
    std::string engine_name;
    std::string platform; // "windows" or "wsl"
    std::string binary_path;
    std::vector<std::string> args;
    std::vector<std::pair<std::string, std::string>> env_overrides;
    std::filesystem::path temp_query_file;
    std::filesystem::path isolated_home_dir;
    std::filesystem::path session_id_map_file;
    std::string stdin_payload;
    std::string model_label;
    bool use_bwrap_sandbox = false;
    std::string linux_workspace_path;
    std::string linux_home_path;
    std::string linux_task_dir;
    std::vector<std::string> bwrap_args;
};

PreparedCliInvocation prepare_cli_invocation(const CliHarnessRunRequest& req,
                                             const std::vector<CliHarnessDescriptor>& discovered = {});

// 9. Executes the prepared full-power CLI harness with real-time JSONL event streaming,
//    per-Bot persistent session continuity, JobObject cancellation, and automatic file delta harvesting.
CliHarnessRunResult run_cli_harness(const CliHarnessRunRequest& req,
                                    const CliEventCallback& on_event = {},
                                    std::stop_token stop = {});

// 10. Official local CLI reception adapter (Work lead & Chat/Group reception): serializes native messages
//     & allowed tools into a read-only prompt and parses structured <dimension_tool_call> blocks back
//     into standard ModelReply so RunService & frontend work seamlessly without any proxy or token extraction.
class ReceptionTextStreamFilter {
public:
    void feed(std::string_view chunk, const std::function<void(std::string_view)>& on_text);
    void flush(const std::function<void(std::string_view)>& on_text);
    bool emitted_any() const { return emitted_any_; }
    void reset();

private:
    bool inside_tool_tag_ = false;
    bool emitted_any_ = false;
    std::string pending_;
};

std::string build_cli_reception_prompt(const std::vector<ModelMessage>& messages,
                                       const std::vector<ModelTool>& tools,
                                       std::string_view context_feature = "work",
                                       std::string_view engine_id = {});

std::string build_cli_reception_delta_prompt(const std::vector<ModelMessage>& new_messages);

std::string compute_cli_reception_system_fingerprint(const ModelConfig& config,
                                                     const std::vector<ModelMessage>& messages,
                                                     const std::vector<ModelTool>& tools);

ModelReply parse_cli_reception_reply(std::string_view raw_text,
                                     const std::vector<ModelTool>& allowed_tools);

void prewarm_cli_reception_engine(const std::string& engine_id,
                                  const std::filesystem::path& data_root,
                                  const std::filesystem::path& app_root,
                                  const std::filesystem::path& wsl_executable = {},
                                  const std::string& sandbox_distribution = {},
                                  const std::string& execution_policy = "sandbox_first");

void shutdown_cli_reception_pool();

ModelReply call_cli_as_work_lead(const ModelConfig& config,
                                 const std::vector<ModelMessage>& messages,
                                 const std::vector<ModelTool>& tools,
                                 const std::filesystem::path& data_root,
                                 const std::filesystem::path& app_root,
                                 ModelChunk chunk = {},
                                 std::stop_token stop = {},
                                 const std::filesystem::path& wsl_executable = {},
                                 const std::string& sandbox_distribution = {},
                                 const std::string& execution_policy = "sandbox_first");

} // namespace dimension
