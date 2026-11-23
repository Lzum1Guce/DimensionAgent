#pragma once

#include "dimension/json.hpp"

#include <chrono>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <vector>

namespace dimension {

enum class ProcessErrorCode {
    InvalidArgument, Launch, Cancelled, Timeout, OutputLimit, Protocol, Exit, Io
};

// Error messages contain only static diagnostics and numeric OS/exit codes, never
// stdin, stdout, stderr, arguments, environment values, paths or credentials.
class ProcessError final : public std::runtime_error {
public:
    ProcessError(ProcessErrorCode code, std::string message, unsigned long native_code = 0);
    ProcessErrorCode code() const noexcept { return code_; }
    unsigned long native_code() const noexcept { return native_code_; }
private:
    ProcessErrorCode code_;
    unsigned long native_code_;
};

using ProcessEnvironment = std::map<std::wstring, std::wstring>;

// Windows-only, one request/response per fresh worker. Calls CreateProcessW
// directly with escaped argv (no command shell), CREATE_NO_WINDOW, explicit
// inherited pipe handles, and a suspended launch assigned to a kill-on-close
// Job Object before any worker code runs. The executable/cwd must be absolute.
//
// stdin: one JSON line (<=4 MiB), then EOF. stdout: exactly one JSON line
// (<=4 MiB), then EOF and successful exit. stderr is drained with fixed bounded
// memory and never exposed. Cancellation/timeout/errors terminate the whole job.
//
// Default environment: SystemRoot, WINDIR, PATH, PATHEXT; all other inherited
// variables (including API keys) are absent. `environment` adds explicit values.
// TEMP/TMP always point to a fresh cache directory under cwd/.dimension-worker-cache.
// These directories are retained under the caller's chosen task directory.
Json run_json_worker(const std::filesystem::path& executable,
                     const std::vector<std::wstring>& arguments,
                     const std::filesystem::path& cwd,
                     const Json& input,
                     std::stop_token stop = {},
                     std::chrono::milliseconds timeout = std::chrono::seconds(30),
                     const ProcessEnvironment& environment = {});

} // namespace dimension
