#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <stop_token>
#include <string>
#include <string_view>

namespace dimension {

namespace detail { struct HttpConnection; struct HttpAccess; }

struct HttpRequest {
    std::string method;
    std::string target; // Original origin-form target, including the query string.
    std::string path;   // Target before '?'; percent escapes are not decoded.
    std::map<std::string, std::string> headers; // Lowercase names, trimmed values.
    std::string body;
};

class HttpStream {
public:
    // Writes the bytes verbatim. Streaming responses are delimited by connection
    // close. Calls are serialized, and return false on disconnect/write timeout.
    bool write(std::string_view bytes);
    bool alive() const noexcept;
    std::stop_token stop_token() const noexcept;

private:
    explicit HttpStream(std::shared_ptr<detail::HttpConnection> connection);
    std::shared_ptr<detail::HttpConnection> connection_;
    friend struct detail::HttpAccess;
};

class WebSocket {
public:
    using MessageHandler = std::function<void(std::string)>;
    using CloseHandler = std::function<void()>;

    // Install handlers in the upgrade callback before it returns. Message and
    // close handlers execute on the connection worker; send_text/close are safe
    // from another thread. Only UTF-8 text messages (up to 4 MiB) are supported.
    void set_message_handler(MessageHandler handler);
    void set_close_handler(CloseHandler handler);
    bool send_text(std::string_view text);
    void close(std::uint16_t code = 1000, std::string_view reason = {}) noexcept;
    bool alive() const noexcept;
    std::stop_token stop_token() const noexcept;

private:
    struct Impl;
    explicit WebSocket(std::shared_ptr<Impl> impl);
    std::shared_ptr<Impl> impl_;
    friend struct detail::HttpAccess;
};

struct HttpResponse {
    int status = 200;
    std::map<std::string, std::string> headers;
    std::string body;
    // Runs on its connection worker. Observe stream.stop_token() while waiting
    // and return promptly on cancellation. Disconnect only stops this stream,
    // not an application task. SSE defaults are supplied if headers omit them.
    std::function<void(HttpStream&)> stream;
    // Set to upgrade this route. The handshake is validated by HttpServer, then
    // this callback runs once, followed by the incoming-frame processing loop.
    std::function<void(std::shared_ptr<WebSocket>)> websocket;
};

// The application API always uses SameOrigin. IsolatedStatic is reserved for a
// separate, token-scoped preview listener: GET/HEAD only, no bodies or upgrades.
enum class HttpAccessPolicy { SameOrigin, IsolatedStatic };

struct HttpServerStats {
    std::uint64_t total_requests = 0;
    std::uint64_t reused_requests = 0;
    std::uint64_t rejected_connections = 0;
    std::size_t active_connections = 0;
    std::size_t active_streams = 0;
    std::size_t max_connections = 192;
    std::size_t max_streams = 96;
};

class HttpServer {
public:
    using Handler = std::function<HttpResponse(const HttpRequest&)>;
    // IPv4 loopback only. Port 0 selects an unused port. Supports HTTP/1.1
    // keep-alive when requested by the client, and reserves capacity so
    // long-lived streams/WebSockets cannot starve short RPC requests.
    HttpServer(std::uint16_t port, Handler handler, HttpAccessPolicy policy = HttpAccessPolicy::SameOrigin);
    ~HttpServer();
    HttpServer(const HttpServer&) = delete;
    HttpServer& operator=(const HttpServer&) = delete;

    void start(); // Throws on startup failure; otherwise idempotent.
    std::uint16_t port() const noexcept;
    HttpServerStats stats() const noexcept;
    // Call from the owner thread, never a route/message/stream callback. Stops
    // transport tokens, interrupts socket I/O, and joins all connection workers.
    void stop() noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
