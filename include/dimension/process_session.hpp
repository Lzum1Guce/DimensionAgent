#pragma once

#include "dimension/process.hpp"

#include <functional>
#include <memory>

namespace dimension {

// Persistent Windows JSONL child. Construction can deliver callbacks before it
// returns: capture an already-created shared state, not an unassigned owner.
class JsonProcessSession final {
public:
    using LineCallback = std::function<void(const Json&)>;

    // Direct hidden CreateProcessW, explicit argv/handles, kill-on-close Job.
    // Minimal inherited environment; TEMP/TMP use a fresh directory below cwd.
    // stdout is LF/CRLF JSON, <=8 MiB per line. stderr is drained. A sandbox launcher may opt into a bounded failure diagnostic.
    // Callbacks are serial, outside internal locks. They must promptly publish
    // state and return; they must not call close() or destroy the session.
    // A final host-generated {event:"exit",ok:bool,error?:{code,message}} follows
    // all delivered lines. Exception text and child diagnostics are never exposed.
    JsonProcessSession(const std::filesystem::path& executable,
                       const std::vector<std::wstring>& arguments,
                       const std::filesystem::path& cwd,
                       LineCallback callback,
                       const ProcessEnvironment& environment = {});
    JsonProcessSession(const std::filesystem::path& executable,
                       const std::vector<std::wstring>& arguments,
                       const std::filesystem::path& cwd, LineCallback callback,
                       const ProcessEnvironment& environment, bool sandbox_diagnostics);
    ~JsonProcessSession();
    JsonProcessSession(const JsonProcessSession&) = delete;
    JsonProcessSession& operator=(const JsonProcessSession&) = delete;

    // Thread-safe, nonblocking pipe delivery through a bounded writer queue.
    // true means accepted, not acknowledged by the child. false means stopped,
    // invalid/oversized input (>1 MiB), or backpressure (4 MiB / 128 queued lines).
    bool send(const Json& value);
    bool running() const noexcept;
    // Idempotent. Drop unsent lines, close stdin, allow about 2s for cooperative
    // EOF shutdown, then terminate the Windows job and join all threads. No
    // callback remains after return. Linux descendants need helper-side cleanup.
    void close() noexcept;
    // Host-owned final exit, stored independently of peer-authored JSON events.
    // Call after close() to make cleanup outcome part of the completion decision.
    Json transport_exit() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
