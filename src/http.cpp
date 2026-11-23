#include "dimension/http.hpp"

#ifndef _WIN32
#error The native HTTP transport currently targets Windows.
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <limits>
#include <mutex>
#include <shared_mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace dimension {
namespace {
using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
constexpr std::size_t max_headers = 32 * 1024;
constexpr std::size_t max_body = 4 * 1024 * 1024;
constexpr std::size_t max_image_body = 8 * 1024 * 1024;
constexpr std::size_t max_bot_archive_body = 16 * 1024 * 1024;
constexpr std::size_t max_connections = 192;
constexpr std::size_t max_streams = 96;
constexpr std::size_t max_keepalive_requests = 128;
constexpr auto read_timeout = std::chrono::seconds(15);
constexpr auto keepalive_idle_timeout = std::chrono::seconds(15);
constexpr auto write_timeout = std::chrono::seconds(5);
constexpr auto message_timeout = std::chrono::seconds(30);

std::size_t request_body_limit(const HttpRequest& request) {
    if (request.method != "POST") return max_body;
    if (request.path == "/api/native/bot-archive/stage") return max_bot_archive_body;
    if (request.path == "/api/dimension/stickers") return max_image_body;
    for (const std::string_view prefix : {"/api/dimension/bots/", "/api/dimension/groups/"}) {
        const std::string_view path = request.path;
        if (!path.starts_with(prefix) || !path.ends_with("/avatar") || path.size() <= prefix.size() + 7) continue;
        const auto id = path.substr(prefix.size(), path.size() - prefix.size() - 7);
        const bool group = prefix == "/api/dimension/groups/";
        bool valid = !id.empty() && id != "." && id != "..";
        std::size_t decoded_size = 0;
        for (std::size_t i = 0; valid && i < id.size(); ++i) {
            const auto c = id[i]; ++decoded_size;
            if (group && c == '%' && (id.substr(i, 3) == "%3A" || id.substr(i, 3) == "%3a")) { i += 2; continue; }
            valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || (group && c == ':');
        }
        if (valid && decoded_size <= 128) return max_image_body;
    }
    return max_body;
}

std::string lower(std::string_view value) {
    std::string out(value);
    for (auto& c : out) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
    return out;
}

std::string_view trim(std::string_view value) {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.remove_suffix(1);
    return value;
}

bool token(std::string_view value) {
    if (value.empty()) return false;
    for (const unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) continue;
        if (std::string_view("!#$%&'*+-.^_`|~").find(static_cast<char>(c)) == std::string_view::npos) return false;
    }
    return true;
}

bool header_value(std::string_view value) {
    for (const unsigned char c : value) if ((c < 32 && c != '\t') || c == 127) return false;
    return true;
}

bool valid_utf8(std::string_view value) {
    std::uint32_t code = 0, minimum = 0;
    int remaining = 0;
    for (const unsigned char c : value) {
        if (!remaining) {
            if (c <= 0x7f) continue;
            if (c >= 0xc2 && c <= 0xdf) { remaining = 1; code = c & 0x1f; minimum = 0x80; }
            else if (c >= 0xe0 && c <= 0xef) { remaining = 2; code = c & 0x0f; minimum = 0x800; }
            else if (c >= 0xf0 && c <= 0xf4) { remaining = 3; code = c & 0x07; minimum = 0x10000; }
            else return false;
        } else {
            if ((c & 0xc0) != 0x80) return false;
            code = (code << 6) | (c & 0x3f);
            if (!--remaining && (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) return false;
        }
    }
    return remaining == 0;
}

bool contains_token(std::string_view value, std::string_view wanted) {
    while (!value.empty()) {
        const auto comma = value.find(',');
        const auto item = trim(value.substr(0, comma));
        if (lower(item) == wanted) return true;
        if (comma == std::string_view::npos) break;
        value.remove_prefix(comma + 1);
    }
    return false;
}

std::string_view reason(int status) {
    switch (status) {
    case 200: return "OK"; case 201: return "Created"; case 202: return "Accepted";
    case 204: return "No Content"; case 206: return "Partial Content";
    case 301: return "Moved Permanently"; case 302: return "Found"; case 304: return "Not Modified";
    case 400: return "Bad Request"; case 401: return "Unauthorized"; case 403: return "Forbidden";
    case 404: return "Not Found"; case 405: return "Method Not Allowed"; case 408: return "Request Timeout";
    case 409: return "Conflict"; case 410: return "Gone"; case 413: return "Content Too Large"; case 414: return "URI Too Long";
    case 415: return "Unsupported Media Type"; case 417: return "Expectation Failed"; case 422: return "Unprocessable Content";
    case 426: return "Upgrade Required"; case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large"; case 500: return "Internal Server Error";
    case 501: return "Not Implemented"; case 503: return "Service Unavailable";
    case 505: return "HTTP Version Not Supported"; default: return "Response";
    }
}

std::string base64(std::string_view bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const auto a = static_cast<unsigned char>(bytes[i]);
        const auto b = i + 1 < bytes.size() ? static_cast<unsigned char>(bytes[i + 1]) : 0;
        const auto c = i + 2 < bytes.size() ? static_cast<unsigned char>(bytes[i + 2]) : 0;
        out += alphabet[a >> 2];
        out += alphabet[((a & 3) << 4) | (b >> 4)];
        out += i + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
        out += i + 2 < bytes.size() ? alphabet[c & 63] : '=';
    }
    return out;
}

bool websocket_key(std::string_view key) {
    if (key.size() != 24 || key.substr(22) != "==") return false;
    std::string bytes;
    unsigned accumulator = 0;
    int bits = 0;
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (std::size_t i = 0; i < 22; ++i) {
        const auto n = alphabet.find(key[i]);
        if (n == std::string_view::npos) return false;
        accumulator = (accumulator << 6) | static_cast<unsigned>(n);
        bits += 6;
        if (bits >= 8) { bits -= 8; bytes += static_cast<char>((accumulator >> bits) & 255); }
    }
    return bytes.size() == 16 && base64(bytes) == key;
}

std::string accept_key(std::string key) {
    key += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    struct Algorithm {
        BCRYPT_ALG_HANDLE value = nullptr;
        ~Algorithm() { if (value) BCryptCloseAlgorithmProvider(value, 0); }
    } algorithm;
    struct Hash {
        BCRYPT_HASH_HANDLE value = nullptr;
        ~Hash() { if (value) BCryptDestroyHash(value); }
    };
    if (BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_SHA1_ALGORITHM, nullptr, 0) < 0)
        throw std::runtime_error("Cannot open the Windows SHA-1 provider");
    DWORD object_length = 0, written = 0;
    if (BCryptGetProperty(algorithm.value, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_length),
                          sizeof(object_length), &written, 0) < 0)
        throw std::runtime_error("Cannot query the Windows hash provider");
    // The provider's hash object buffer must outlive the hash handle.
    std::vector<unsigned char> object(object_length);
    Hash hash;
    if (BCryptCreateHash(algorithm.value, &hash.value, object.data(), object_length, nullptr, 0, 0) < 0)
        throw std::runtime_error("Cannot create a Windows hash");
    std::array<unsigned char, 20> digest{};
    const auto result = BCryptHashData(hash.value, reinterpret_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0);
    const auto finish = result < 0 ? result : BCryptFinishHash(hash.value, digest.data(), static_cast<ULONG>(digest.size()), 0);
    if (finish < 0) throw std::runtime_error("Cannot compute the WebSocket handshake");
    return base64(std::string_view(reinterpret_cast<const char*>(digest.data()), digest.size()));
}

bool close_code(std::uint16_t code) {
    return (code >= 1000 && code <= 1014 && code != 1004 && code != 1005 && code != 1006)
        || (code >= 3000 && code <= 4999);
}
} // namespace

namespace detail {
struct HttpConnection {
    enum class Mode { request, stream, websocket, closed };
    explicit HttpConnection(SOCKET value) : socket(value) {}
    ~HttpConnection() { finish(); }

    mutable std::shared_mutex socket_mutex;
    std::mutex write_mutex;
    SOCKET socket = INVALID_SOCKET;
    bool graceful_close = false; // Guarded by socket_mutex.
    std::stop_source stopped;
    std::atomic<Mode> mode{Mode::request};

    bool alive() const noexcept { return !stopped.stop_requested(); }

    void disconnect() noexcept {
        stopped.request_stop();
        std::shared_lock lock(socket_mutex);
        if (socket != INVALID_SOCKET && !graceful_close) shutdown(socket, SD_BOTH);
    }

    void close_gracefully(std::size_t max_drain = max_body) noexcept {
        stopped.request_stop();
        std::unique_lock lock(socket_mutex);
        if (socket == INVALID_SOCKET || graceful_close) return;
        graceful_close = true;
        shutdown(socket, SD_SEND);
        // After a protocol error, unread client bytes can make closesocket send
        // a reset that discards the close frame. Drain only a bounded amount of
        // already arriving data; an adversarial peer cannot prolong shutdown.
        const auto deadline = Clock::now() + std::chrono::milliseconds(100);
        std::array<char, 8192> buffer{};
        std::size_t drained = 0;
        while (drained <= max_drain && Clock::now() < deadline) {
            const auto count = recv(socket, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (count > 0) { drained += static_cast<std::size_t>(count); continue; }
            if (count == 0 || WSAGetLastError() != WSAEWOULDBLOCK) break;
            fd_set ready;
            FD_ZERO(&ready);
            FD_SET(socket, &ready);
            timeval timeout{0, 10000};
            if (select(0, &ready, nullptr, nullptr, &timeout) <= 0) break;
        }
    }

    void finish() noexcept {
        stopped.request_stop();
        mode = Mode::closed;
        std::unique_lock lock(socket_mutex);
        if (socket != INVALID_SOCKET) {
            if (!graceful_close) shutdown(socket, SD_BOTH);
            closesocket(socket);
            socket = INVALID_SOCKET;
        }
    }

    // Nonblocking sockets and short readiness waits make shutdown bounded. The
    // Shared socket locks prevent close/reused-handle races while allowing a
    // background sender to write during an idle reader's readiness wait.
    bool wait(bool writable, Deadline deadline) {
        while (alive() && Clock::now() < deadline) {
            int result = 0;
            {
                std::shared_lock lock(socket_mutex);
                if (socket == INVALID_SOCKET) return false;
                fd_set ready;
                FD_ZERO(&ready);
                FD_SET(socket, &ready);
                timeval timeout{0, 50000};
                result = select(0, writable ? nullptr : &ready, writable ? &ready : nullptr, nullptr, &timeout);
            }
            if (result > 0) return true;
            if (result == SOCKET_ERROR) return false;
        }
        return false;
    }

    int receive(char* destination, int capacity, Deadline deadline) {
        while (alive()) {
            int received = 0, error = 0;
            {
                std::shared_lock lock(socket_mutex);
                if (socket == INVALID_SOCKET) return -1;
                received = recv(socket, destination, capacity, 0);
                if (received == SOCKET_ERROR) error = WSAGetLastError();
            }
            if (received > 0) return received;
            if (received == 0 || error != WSAEWOULDBLOCK) { disconnect(); return -1; }
            if (!wait(false, deadline)) return -1;
        }
        return -1;
    }

    bool write_locked(std::string_view bytes, Deadline deadline) {
        while (!bytes.empty() && alive() && Clock::now() < deadline) {
            int sent = 0, error = 0;
            {
                std::shared_lock lock(socket_mutex);
                if (socket == INVALID_SOCKET) return false;
                const auto count = static_cast<int>(std::min<std::size_t>(bytes.size(), 64 * 1024));
                sent = send(socket, bytes.data(), count, 0);
                if (sent == SOCKET_ERROR) error = WSAGetLastError();
            }
            if (sent > 0) { bytes.remove_prefix(static_cast<std::size_t>(sent)); continue; }
            if (sent == 0 || error != WSAEWOULDBLOCK || !wait(true, deadline)) break;
        }
        if (!bytes.empty()) return false;
        return alive();
    }

    bool write(std::string_view bytes) {
        bool result;
        { std::lock_guard lock(write_mutex); result = write_locked(bytes, Clock::now() + write_timeout); }
        // Stop callbacks may call transport APIs, so signal only after releasing
        // the write lock, never from inside a serialized write operation.
        if (!result) disconnect();
        return result;
    }

    bool frame(unsigned char opcode, std::string_view payload, std::atomic_bool* closing) {
        std::string header;
        header += static_cast<char>(0x80 | opcode);
        if (payload.size() <= 125) header += static_cast<char>(payload.size());
        else if (payload.size() <= 65535) {
            header += static_cast<char>(126);
            header += static_cast<char>((payload.size() >> 8) & 255);
            header += static_cast<char>(payload.size() & 255);
        } else {
            header += static_cast<char>(127);
            for (int i = 7; i >= 0; --i) header += static_cast<char>((static_cast<std::uint64_t>(payload.size()) >> (i * 8)) & 255);
        }
        std::unique_lock lock(write_mutex);
        if (opcode == 8 ? closing->exchange(true) : closing->load()) return false;
        const auto deadline = Clock::now() + write_timeout;
        bool result;
        if (opcode >= 8) {
            // A control frame is at most 127 bytes. Submit it as a single write
            // before a subsequent shutdown, including protocol-error closes.
            header += payload;
            result = write_locked(header, deadline);
        } else result = write_locked(header, deadline) && write_locked(payload, deadline);
        lock.unlock();
        if (!result) disconnect();
        return result;
    }

    void inspect_stream() {
        if (mode != Mode::stream || !alive()) return;
        int received = 0, error = 0;
        {
            std::shared_lock lock(socket_mutex, std::try_to_lock);
            if (!lock.owns_lock()) return;
            if (socket == INVALID_SOCKET) return;
            char byte{};
            received = recv(socket, &byte, 1, MSG_PEEK);
            if (received == SOCKET_ERROR) error = WSAGetLastError();
        }
        // A second request is not allowed on an already streaming connection.
        if (received >= 0 || error != WSAEWOULDBLOCK) disconnect();
    }
};
} // namespace detail

namespace {
class Reader {
public:
    explicit Reader(std::shared_ptr<detail::HttpConnection> connection) : connection_(std::move(connection)) {}

    bool exact(std::size_t length, std::string& out, Deadline deadline) {
        out.clear();
        out.reserve(length);
        if (!pending_.empty()) {
            const auto take = std::min(length, pending_.size());
            out.append(pending_, 0, take);
            pending_.erase(0, take);
        }
        std::array<char, 8192> buffer{};
        while (out.size() < length) {
            if (Clock::now() >= deadline) return false;
            const int count = connection_->receive(buffer.data(), static_cast<int>(std::min(buffer.size(), length - out.size())), deadline);
            if (count <= 0) return false;
            out.append(buffer.data(), static_cast<std::size_t>(count));
        }
        return true;
    }

    int request(HttpRequest& request, std::uint16_t port, HttpAccessPolicy policy, bool reused = false) {
        request = HttpRequest{};
        std::array<char, 8192> buffer{};
        if (reused && pending_.empty()) {
            const int count = connection_->receive(buffer.data(), static_cast<int>(buffer.size()), Clock::now() + keepalive_idle_timeout);
            if (count <= 0) return -1;
            pending_.append(buffer.data(), static_cast<std::size_t>(count));
        }
        const auto deadline = Clock::now() + read_timeout;
        std::size_t boundary = std::string::npos;
        while ((boundary = pending_.find("\r\n\r\n")) == std::string::npos) {
            if (pending_.size() >= max_headers) return 431;
            const int count = connection_->receive(buffer.data(), static_cast<int>(std::min(buffer.size(), max_headers - pending_.size())), deadline);
            if (count <= 0) return connection_->alive() ? 408 : 400;
            pending_.append(buffer.data(), static_cast<std::size_t>(count));
            if (Clock::now() >= deadline) return 408;
        }
        if (boundary + 4 > max_headers) return 431;
        const std::string header = pending_.substr(0, boundary);
        pending_.erase(0, boundary + 4);
        const auto first_end = header.find("\r\n");
        const auto line = std::string_view(header).substr(0, first_end);
        const auto first_space = line.find(' ');
        const auto second_space = first_space == std::string_view::npos ? first_space : line.find(' ', first_space + 1);
        if (first_space == std::string_view::npos || second_space == std::string_view::npos || line.find(' ', second_space + 1) != std::string_view::npos) return 400;
        request.method = line.substr(0, first_space);
        request.target = line.substr(first_space + 1, second_space - first_space - 1);
        if (!token(request.method) || request.method.size() > 32) return 400;
        if (line.substr(second_space + 1) != "HTTP/1.1") return 505;
        if (request.target.empty() || request.target.front() != '/' || request.target.find('#') != std::string::npos) return 400;
        for (const unsigned char c : request.target) if (c <= 32 || c == 127 || c == '\\') return 400;
        request.path = request.target.substr(0, request.target.find('?'));
        if (first_end != std::string::npos) {
            std::size_t position = first_end + 2;
            while (position < header.size()) {
                const auto end = header.find("\r\n", position);
                const auto field = std::string_view(header).substr(position, end == std::string::npos ? end : end - position);
                const auto colon = field.find(':');
                if (colon == std::string_view::npos || !token(field.substr(0, colon)) || !header_value(field.substr(colon + 1))) return 400;
                const auto name = lower(field.substr(0, colon));
                if (!request.headers.emplace(name, trim(field.substr(colon + 1))).second) return 400;
                if (end == std::string::npos) break;
                position = end + 2;
            }
        }
        const auto host_field = request.headers.find("host");
        if (host_field == request.headers.end()) return 400;
        const auto host = lower(host_field->second);
        const auto suffix = ":" + std::to_string(port);
        if (host != "127.0.0.1" + suffix && host != "localhost" + suffix
            && !(port == 80 && (host == "127.0.0.1" || host == "localhost"))) return 403;
        const auto origin = request.headers.find("origin");
        if (policy == HttpAccessPolicy::SameOrigin && origin != request.headers.end() && lower(origin->second) != "http://" + host) return 403;
        const auto fetch_site = request.headers.find("sec-fetch-site");
        if (policy == HttpAccessPolicy::SameOrigin && fetch_site != request.headers.end()) {
            const auto value = lower(fetch_site->second);
            if (value != "none" && value != "same-origin") return 403;
        }
        if (request.headers.contains("transfer-encoding")) return 400;
        if (request.headers.contains("expect")) return 417;
        std::size_t content_length = 0;
        const auto body_limit = request_body_limit(request);
        const auto length = request.headers.find("content-length");
        if (length != request.headers.end()) {
            if (length->second.empty()) return 400;
            for (const unsigned char c : length->second) {
                if (c < '0' || c > '9') return 400;
                const auto digit = static_cast<std::size_t>(c - '0');
                if (content_length > (body_limit - digit) / 10) return 413;
                content_length = content_length * 10 + digit;
            }
        }
        if (policy == HttpAccessPolicy::IsolatedStatic &&
            (content_length || (request.method != "GET" && request.method != "HEAD") || request.headers.contains("upgrade"))) return 403;
        if (!exact(content_length, request.body, Clock::now() + read_timeout)) return connection_->alive() ? 408 : 400;
        return 0;
    }

private:
    std::shared_ptr<detail::HttpConnection> connection_;
    std::string pending_;
};

bool prepare_headers(const HttpResponse& response, std::map<std::string, std::string>& headers, HttpAccessPolicy policy) {
    for (const auto& [name, value] : response.headers) {
        if (!token(name) || !header_value(value)) return false;
        const auto key = lower(name);
        if (key == "connection" || key == "content-length" || key == "transfer-encoding" || key == "upgrade"
            || key == "sec-websocket-accept" || key == "sec-websocket-extensions"
            || (key.starts_with("access-control-") && policy != HttpAccessPolicy::IsolatedStatic)) continue;
        if (!headers.emplace(key, value).second) return false;
    }
    headers.try_emplace("x-content-type-options", "nosniff");
    headers.try_emplace("referrer-policy", "same-origin");
    return true;
}

std::string response_head(const HttpResponse& response, const std::map<std::string, std::string>& headers, bool streaming, bool keep_alive = false) {
    std::string result = "HTTP/1.1 " + std::to_string(response.status) + " " + std::string(reason(response.status)) + "\r\n";
    if (keep_alive && !streaming) {
        result += "connection: keep-alive\r\nkeep-alive: timeout=15, max=" + std::to_string(max_keepalive_requests) + "\r\n";
    } else {
        result += "connection: close\r\n";
    }
    const bool no_body = response.status == 204 || response.status == 304;
    if (!streaming && !no_body) result += "content-length: " + std::to_string(response.body.size()) + "\r\n";
    for (const auto& [name, value] : headers) result += name + ": " + value + "\r\n";
    result += "\r\n";
    return result;
}

void send_error(const std::shared_ptr<detail::HttpConnection>& connection, int status) {
    HttpResponse response;
    response.status = status;
    response.body = std::string(reason(status)) + "\n";
    std::map<std::string, std::string> headers{{"content-type", "text/plain; charset=utf-8"}, {"x-content-type-options", "nosniff"}};
    if (status == 426) headers.emplace("sec-websocket-version", "13");
    if (connection->write(response_head(response, headers, false))) connection->write(response.body);
    // A rejected upload can still be writing its body. Half-close after the
    // error response and drain a bounded amount so closing does not reset the
    // connection before the client can read the status. WebSocket limits keep
    // their existing default, and the 100 ms shutdown deadline still applies.
    connection->close_gracefully(max_image_body);
}
} // namespace

struct WebSocket::Impl {
    explicit Impl(std::shared_ptr<detail::HttpConnection> value) : connection(std::move(value)) {}
    std::shared_ptr<detail::HttpConnection> connection;
    std::mutex handlers_mutex;
    MessageHandler on_message;
    CloseHandler on_close;
    std::atomic_bool close_sent{false};
    std::atomic_bool close_notified{false};

    void close(std::uint16_t code, std::string_view reason_text) noexcept {
        try {
            if (connection->alive()) {
                if (!close_code(code) || reason_text.size() > 123 || !valid_utf8(reason_text)) { code = 1002; reason_text = {}; }
                std::string payload;
                payload += static_cast<char>(code >> 8);
                payload += static_cast<char>(code & 255);
                payload += reason_text;
                connection->frame(8, payload, &close_sent);
            }
        } catch (...) {}
        connection->close_gracefully();
    }

    void notify_close() noexcept {
        if (close_notified.exchange(true)) return;
        try {
            CloseHandler callback;
            { std::lock_guard lock(handlers_mutex); callback = on_close; }
            if (callback) callback();
        } catch (...) {}
        // Release callback captures even when the application retains the socket.
        std::lock_guard lock(handlers_mutex);
        on_message = {};
        on_close = {};
    }

    void read_messages(Reader& reader) {
        bool fragmented = false;
        std::string message;
        auto message_deadline = Deadline::max();
        while (connection->alive()) {
            std::string head;
            if (!reader.exact(1, head, message_deadline)) break;
            const auto first = static_cast<unsigned char>(head[0]);
            const auto frame_deadline = std::min(Clock::now() + read_timeout, message_deadline);
            if (!reader.exact(1, head, frame_deadline)) break;
            const auto second = static_cast<unsigned char>(head[0]);
            const bool final = (first & 0x80) != 0;
            const auto opcode = static_cast<unsigned char>(first & 15);
            const bool control = (opcode & 8) != 0;
            if ((first & 0x70) || !(second & 0x80) || (control && !final)
                || (opcode != 0 && opcode != 1 && opcode != 2 && opcode != 8 && opcode != 9 && opcode != 10)) { close(1002, {}); break; }
            std::uint64_t length = second & 127;
            if (control && length > 125) { close(1002, {}); break; }
            if (length == 126 || length == 127) {
                const auto size = length == 126 ? 2u : 8u;
                if (!reader.exact(size, head, frame_deadline)) break;
                length = 0;
                for (const unsigned char c : head) length = (length << 8) | c;
                if ((size == 8 && (static_cast<unsigned char>(head[0]) & 128)) || (size == 2 && length < 126) || (size == 8 && length <= 65535)) { close(1002, {}); break; }
            }
            if (length > max_body || (!control && message.size() + length > max_body)) { close(1009, {}); break; }
            if (opcode == 2) { close(1003, {}); break; }
            if ((!control && opcode == 0 && !fragmented) || (!control && opcode == 1 && fragmented)) { close(1002, {}); break; }
            std::string mask, payload;
            if (!reader.exact(4, mask, frame_deadline) || !reader.exact(static_cast<std::size_t>(length), payload, frame_deadline)) break;
            for (std::size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(static_cast<unsigned char>(payload[i]) ^ static_cast<unsigned char>(mask[i % 4]));
            if (opcode == 8) {
                if (payload.size() == 1) { close(1002, {}); break; }
                if (payload.size() >= 2) {
                    const auto code = static_cast<std::uint16_t>((static_cast<unsigned char>(payload[0]) << 8) | static_cast<unsigned char>(payload[1]));
                    if (!close_code(code)) { close(1002, {}); break; }
                    if (!valid_utf8(std::string_view(payload).substr(2))) { close(1007, {}); break; }
                }
                connection->frame(8, payload, &close_sent);
                connection->close_gracefully();
                break;
            }
            if (opcode == 9) { if (!connection->frame(10, payload, &close_sent)) break; continue; }
            if (opcode == 10) continue;
            if (opcode == 1) { message.clear(); message_deadline = Clock::now() + message_timeout; }
            message += payload;
            if (!final) { fragmented = true; continue; }
            fragmented = false;
            message_deadline = Deadline::max();
            if (!valid_utf8(message)) { close(1007, {}); break; }
            MessageHandler callback;
            { std::lock_guard lock(handlers_mutex); callback = on_message; }
            try { if (callback) callback(std::move(message)); }
            catch (...) { close(1011, {}); break; }
            message.clear();
        }
        connection->disconnect();
        notify_close();
    }
};

namespace detail {
struct ServerCounters {
    std::atomic<std::uint64_t> total_requests{0};
    std::atomic<std::uint64_t> reused_requests{0};
    std::atomic<std::uint64_t> rejected_connections{0};
    std::atomic<std::size_t> active_connections{0};
    std::atomic<std::size_t> active_streams{0};

    bool try_acquire_stream() noexcept {
        std::size_t current = active_streams.load(std::memory_order_relaxed);
        while (current < max_streams) {
            if (active_streams.compare_exchange_weak(current, current + 1, std::memory_order_acq_rel, std::memory_order_relaxed))
                return true;
        }
        return false;
    }
    void release_stream() noexcept { active_streams.fetch_sub(1, std::memory_order_acq_rel); }
};

struct StreamSlotGuard {
    ServerCounters* counters = nullptr;
    ~StreamSlotGuard() { if (counters) counters->release_stream(); }
};

struct HttpAccess {
    static void serve(const std::shared_ptr<HttpConnection>& connection, std::uint16_t port,
                      const HttpServer::Handler& handler, HttpAccessPolicy policy, ServerCounters& counters) {
        Reader reader(connection);
        for (std::size_t served = 0; served < max_keepalive_requests && connection->alive(); ++served) {
            HttpRequest request;
            const int error = reader.request(request, port, policy, served > 0);
            if (error < 0) return;
            if (error > 0) { send_error(connection, error); return; }
            counters.total_requests.fetch_add(1, std::memory_order_relaxed);
            if (served > 0) counters.reused_requests.fetch_add(1, std::memory_order_relaxed);

            HttpResponse response;
            try { response = handler(request); }
            catch (...) { send_error(connection, 500); return; }
            std::map<std::string, std::string> headers;
            if (response.status < 200 || response.status > 599 || (response.stream && response.websocket) ||
                (policy == HttpAccessPolicy::IsolatedStatic && (response.stream || response.websocket)) || !prepare_headers(response, headers, policy)) {
                send_error(connection, 500); return;
            }
            const auto field = [&request](const char* name) -> std::string_view {
                const auto found = request.headers.find(name);
                return found == request.headers.end() ? std::string_view{} : found->second;
            };
            if (response.websocket) {
                if (request.method != "GET" || !request.body.empty() || lower(field("upgrade")) != "websocket" || !contains_token(field("connection"), "upgrade")) { send_error(connection, 400); return; }
                if (field("sec-websocket-version") != "13") { send_error(connection, 426); return; }
                if (!websocket_key(field("sec-websocket-key"))) { send_error(connection, 400); return; }
                if (!counters.try_acquire_stream()) { send_error(connection, 503); return; }
                StreamSlotGuard slot{&counters};
                auto impl = std::make_shared<WebSocket::Impl>(connection);
                auto websocket = std::shared_ptr<WebSocket>(new WebSocket(impl));
                std::string head = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: " + accept_key(std::string(field("sec-websocket-key"))) + "\r\n";
                for (const auto& [name, value] : headers) head += name + ": " + value + "\r\n";
                head += "\r\n";
                if (!connection->write(head)) return;
                connection->mode = HttpConnection::Mode::websocket;
                // Keep the public connection alive until its reader exits, including
                // when application callbacks retain only weak references.
                try { response.websocket(websocket); impl->read_messages(reader); }
                catch (...) { impl->close(1011, {}); impl->notify_close(); }
                return;
            }
            const bool no_body = request.method == "HEAD" || response.status == 204 || response.status == 304;
            const bool streaming = static_cast<bool>(response.stream) && !no_body;
            if (streaming && !counters.try_acquire_stream()) { send_error(connection, 503); return; }
            StreamSlotGuard slot{streaming ? &counters : nullptr};
            if (streaming) {
                headers.try_emplace("content-type", "text/event-stream; charset=utf-8");
                headers.try_emplace("cache-control", "no-cache");
            } else headers.try_emplace("content-type", "application/octet-stream");

            const auto conn_hdr = field("connection");
            const bool client_wants_keepalive = contains_token(conn_hdr, "keep-alive") && !contains_token(conn_hdr, "close");
            const bool keep_alive = !streaming && client_wants_keepalive && (served + 1 < max_keepalive_requests) && connection->alive();

            if (!connection->write(response_head(response, headers, streaming, keep_alive))) return;
            if (!no_body) {
                if (streaming) {
                    connection->mode = HttpConnection::Mode::stream;
                    HttpStream stream(connection);
                    try { response.stream(stream); } catch (...) { connection->disconnect(); }
                    return;
                }
                if (!connection->write(response.body)) return;
            }
            if (!keep_alive) return;
        }
    }
};
} // namespace detail

HttpStream::HttpStream(std::shared_ptr<detail::HttpConnection> connection) : connection_(std::move(connection)) {}
bool HttpStream::write(std::string_view bytes) { return connection_->write(bytes); }
bool HttpStream::alive() const noexcept { return connection_->alive(); }
std::stop_token HttpStream::stop_token() const noexcept { return connection_->stopped.get_token(); }

WebSocket::WebSocket(std::shared_ptr<Impl> impl) : impl_(std::move(impl)) {}
void WebSocket::set_message_handler(MessageHandler handler) { std::lock_guard lock(impl_->handlers_mutex); impl_->on_message = std::move(handler); }
void WebSocket::set_close_handler(CloseHandler handler) { std::lock_guard lock(impl_->handlers_mutex); impl_->on_close = std::move(handler); }
bool WebSocket::send_text(std::string_view text) {
    if (text.size() > max_body || !valid_utf8(text) || impl_->close_sent) return false;
    return impl_->connection->frame(1, text, &impl_->close_sent);
}
void WebSocket::close(std::uint16_t code, std::string_view reason_text) noexcept { impl_->close(code, reason_text); }
bool WebSocket::alive() const noexcept { return impl_->connection->alive(); }
std::stop_token WebSocket::stop_token() const noexcept { return impl_->connection->stopped.get_token(); }

struct HttpServer::Impl {
    struct Worker {
        std::shared_ptr<detail::HttpConnection> connection;
        std::shared_ptr<std::atomic_bool> done;
        std::thread thread;
    };
    explicit Impl(std::uint16_t port, Handler value, HttpAccessPolicy access) : requested_port(port), handler(std::move(value)), policy(access) {
        if (!handler) throw std::invalid_argument("HTTP handler is required");
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw std::runtime_error("Cannot initialize WinSock");
    }
    ~Impl() { stop(); WSACleanup(); }

    std::uint16_t requested_port;
    std::atomic<std::uint16_t> bound_port{0};
    Handler handler;
    HttpAccessPolicy policy;
    detail::ServerCounters counters;
    std::mutex lifecycle_mutex;
    std::atomic_bool running{false};
    SOCKET listener = INVALID_SOCKET;
    std::thread accept_thread;
    std::vector<Worker> workers;

    HttpServerStats stats() const noexcept {
        HttpServerStats out;
        out.total_requests = counters.total_requests.load(std::memory_order_relaxed);
        out.reused_requests = counters.reused_requests.load(std::memory_order_relaxed);
        out.rejected_connections = counters.rejected_connections.load(std::memory_order_relaxed);
        out.active_connections = counters.active_connections.load(std::memory_order_relaxed);
        out.active_streams = counters.active_streams.load(std::memory_order_relaxed);
        out.max_connections = max_connections;
        out.max_streams = max_streams;
        return out;
    }

    void start() {
        std::lock_guard lock(lifecycle_mutex);
        if (running) return;
        if (accept_thread.joinable()) accept_thread.join();
        for (auto& worker : workers) worker.connection->disconnect();
        for (auto& worker : workers) if (worker.thread.joinable()) worker.thread.join();
        workers.clear();
        SOCKET candidate = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (candidate == INVALID_SOCKET) throw std::runtime_error("Cannot create the loopback listener");
        const BOOL exclusive = TRUE;
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(requested_port);
        u_long nonblocking = 1;
        if (setsockopt(candidate, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive)) != 0
            || bind(candidate, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0
            || listen(candidate, SOMAXCONN) != 0 || ioctlsocket(candidate, FIONBIO, &nonblocking) != 0) {
            closesocket(candidate);
            throw std::runtime_error("Cannot bind the loopback HTTP port");
        }
        int size = sizeof(address);
        if (getsockname(candidate, reinterpret_cast<sockaddr*>(&address), &size) != 0) {
            closesocket(candidate); throw std::runtime_error("Cannot read the loopback port");
        }
        listener = candidate;
        bound_port = ntohs(address.sin_port);
        running = true;
        try { accept_thread = std::thread([this] { accept_connections(); }); }
        catch (...) { running = false; closesocket(listener); listener = INVALID_SOCKET; bound_port = 0; throw; }
    }

    void accept_connections() noexcept {
        try {
            while (running) {
                for (auto it = workers.begin(); it != workers.end();) {
                    if (*it->done) { it->thread.join(); it = workers.erase(it); }
                    else { it->connection->inspect_stream(); ++it; }
                }
                fd_set ready;
                FD_ZERO(&ready);
                FD_SET(listener, &ready);
                timeval timeout{0, 100000};
                const auto selected = select(0, &ready, nullptr, nullptr, &timeout);
                if (selected == 0) continue;
                if (selected == SOCKET_ERROR) break;
                sockaddr_in peer{};
                int length = sizeof(peer);
                const auto client = accept(listener, reinterpret_cast<sockaddr*>(&peer), &length);
                if (client == INVALID_SOCKET) continue;
                if (!running || peer.sin_addr.s_addr != htonl(INADDR_LOOPBACK) || workers.size() >= max_connections) {
                    if (running && workers.size() >= max_connections)
                        counters.rejected_connections.fetch_add(1, std::memory_order_relaxed);
                    closesocket(client);
                    continue;
                }
                u_long nonblocking = 1;
                const BOOL no_delay = TRUE;
                if (ioctlsocket(client, FIONBIO, &nonblocking) != 0) { closesocket(client); continue; }
                setsockopt(client, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&no_delay), sizeof(no_delay));
                std::shared_ptr<detail::HttpConnection> connection;
                try { connection = std::make_shared<detail::HttpConnection>(client); }
                catch (...) { closesocket(client); throw; }
                auto done = std::make_shared<std::atomic_bool>(false);
                // Reserve before starting a thread so vector allocation cannot
                // strand a joinable worker during exceptional resource failure.
                workers.reserve(max_connections);
                counters.active_connections.fetch_add(1, std::memory_order_relaxed);
                std::thread worker([this, connection, done] {
                    try { detail::HttpAccess::serve(connection, bound_port, handler, policy, counters); } catch (...) {}
                    connection->finish();
                    counters.active_connections.fetch_sub(1, std::memory_order_relaxed);
                    *done = true;
                });
                workers.push_back(Worker{std::move(connection), std::move(done), std::move(worker)});
            }
        } catch (...) {}
        running = false;
        // Signal every worker before waiting for any socket lock. This keeps
        // shutdown time independent of the number of idle connection readers.
        for (auto& worker : workers) worker.connection->stopped.request_stop();
        for (auto& worker : workers) worker.connection->disconnect();
        closesocket(listener);
        listener = INVALID_SOCKET;
    }

    void stop() noexcept {
        std::lock_guard lock(lifecycle_mutex);
        running = false;
        if (accept_thread.joinable()) accept_thread.join();
        for (auto& worker : workers) worker.connection->disconnect();
        for (auto& worker : workers) if (worker.thread.joinable()) worker.thread.join();
        workers.clear();
    }
};

HttpServer::HttpServer(std::uint16_t port, Handler handler, HttpAccessPolicy policy) : impl_(std::make_unique<Impl>(port, std::move(handler), policy)) {}
HttpServer::~HttpServer() = default;
void HttpServer::start() { impl_->start(); }
std::uint16_t HttpServer::port() const noexcept { return impl_->bound_port; }
HttpServerStats HttpServer::stats() const noexcept { return impl_->stats(); }
void HttpServer::stop() noexcept { impl_->stop(); }

} // namespace dimension
