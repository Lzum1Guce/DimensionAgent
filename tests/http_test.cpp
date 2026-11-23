#include "dimension/http.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
using namespace std::chrono_literals;

struct Fixture {
    std::atomic_int streams_started{0};
    std::atomic_int streams_stopped{0};
    std::atomic_int websockets_closed{0};
    std::atomic_int floods_stopped{0};
    std::mutex delayed_mutex;
    std::jthread delayed_sender;

    dimension::HttpResponse handle(const dimension::HttpRequest& request) {
        dimension::HttpResponse response;
        response.headers["content-type"] = "text/plain; charset=utf-8";
        if (request.path == "/health") response.body = "native-http-ok";
        else if (request.path == "/echo") response.body = request.body;
        else if (request.path == "/inspect") response.body = request.method + " " + request.path + " " + request.target;
        else if (request.path == "/throw") throw std::runtime_error("fixture exception");
        else if (request.path == "/invalid-header") response.headers["x-fixture"] = "safe\r\nx-injected: unsafe";
        else if (request.path == "/metrics") {
            response.headers["content-type"] = "application/json";
            response.body = "{\"streams_started\":" + std::to_string(streams_started.load())
                + ",\"streams_stopped\":" + std::to_string(streams_stopped.load())
                + ",\"websockets_closed\":" + std::to_string(websockets_closed.load())
                + ",\"floods_stopped\":" + std::to_string(floods_stopped.load()) + "}";
        } else if (request.path == "/sse") {
            response.headers.clear();
            response.stream = [this](dimension::HttpStream& stream) {
                ++streams_started;
                for (int i = 0; i < 3; ++i) {
                    if (!stream.write("id: " + std::to_string(i) + "\ndata: event-" + std::to_string(i) + "\n\n")) break;
                    std::this_thread::sleep_for(10ms);
                }
                std::mutex mutex;
                std::unique_lock lock(mutex);
                std::condition_variable_any cv;
                cv.wait(lock, stream.stop_token(), [] { return false; });
                ++streams_stopped;
            };
        } else if (request.path == "/flood") {
            response.headers["content-type"] = "application/octet-stream";
            response.stream = [this](dimension::HttpStream& stream) {
                const std::string data(1024 * 1024, 'x');
                for (int i = 0; i < 128 && stream.write(data); ++i) {}
                ++floods_stopped;
            };
        } else if (request.path == "/ws") {
            response.websocket = [this](std::shared_ptr<dimension::WebSocket> websocket) {
                const std::weak_ptr<dimension::WebSocket> weak = websocket;
                websocket->set_close_handler([this] { ++websockets_closed; });
                websocket->set_message_handler([this, weak](std::string text) {
                    if (text == "server-close") {
                        if (auto socket = weak.lock()) socket->close(1000, "done");
                        return;
                    }
                    if (text.starts_with("delayed:")) {
                        std::lock_guard lock(delayed_mutex);
                        delayed_sender = std::jthread([weak, text = std::move(text)] {
                            // The reader has returned to its idle frame wait
                            // before this independent producer sends anything.
                            std::this_thread::sleep_for(75ms);
                            if (auto socket = weak.lock()) socket->send_text(text);
                        });
                    } else if (text.starts_with("thread:")) {
                        std::thread([weak, text = std::move(text)] { if (auto socket = weak.lock()) socket->send_text(text); }).join();
                    } else if (auto socket = weak.lock()) socket->send_text(text);
                });
            };
        } else { response.status = 404; response.body = "missing"; }
        return response;
    }
};

void require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}

std::string request(std::uint16_t port, const std::string& bytes) {
    const SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    require(client != INVALID_SOCKET, "create client socket");
    struct Cleanup { SOCKET socket; ~Cleanup() { closesocket(socket); } } cleanup{client};
    const DWORD timeout = 5000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    require(connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "connect loopback");
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const auto sent = send(client, bytes.data() + offset, static_cast<int>(bytes.size() - offset), 0);
        require(sent > 0, "send request");
        offset += static_cast<std::size_t>(sent);
    }
    std::string response;
    char buffer[4096];
    for (;;) {
        const auto size = recv(client, buffer, sizeof(buffer), 0);
        if (!size) break;
        require(size > 0, "read response");
        response.append(buffer, static_cast<std::size_t>(size));
    }
    return response;
}
} // namespace

int main(int argc, char** argv) {
    try {
        Fixture fixture;
        dimension::HttpServer server(0, [&fixture](const auto& value) { return fixture.handle(value); });
        server.start();
        server.start();
        if (argc > 1 && std::string_view(argv[1]) == "--serve") {
            std::cout << "{\"port\":" << server.port() << "}" << std::endl;
            std::string command;
            std::getline(std::cin, command);
            server.stop();
            std::cout << "{\"stopped\":true,\"streams_stopped\":" << fixture.streams_stopped.load() << "}" << std::endl;
            return 0;
        }
        const auto host = "127.0.0.1:" + std::to_string(server.port());
        const auto health = request(server.port(), "GET /health HTTP/1.1\r\nHost: " + host + "\r\n\r\n");
        require(health.starts_with("HTTP/1.1 200 "), "GET status");
        require(health.ends_with("native-http-ok"), "GET body");
        const std::string payload = "中文 / native / 😀";
        const auto echo = request(server.port(), "POST /echo HTTP/1.1\r\nHost: " + host + "\r\nContent-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload);
        require(echo.ends_with(payload), "POST preserves UTF-8 bytes");
        const auto rejected = request(server.port(), "POST /echo HTTP/1.1\r\nHost: " + host + "\r\nOrigin: https://untrusted.example\r\nContent-Length: 0\r\n\r\n");
        require(rejected.starts_with("HTTP/1.1 403 "), "cross-origin mutation rejected");
        const auto duplicate = request(server.port(), "POST /echo HTTP/1.1\r\nHost: " + host + "\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n");
        require(duplicate.starts_with("HTTP/1.1 400 "), "duplicate lengths rejected");
        const auto injected = request(server.port(), "GET /invalid-header HTTP/1.1\r\nHost: " + host + "\r\n\r\n");
        require(injected.starts_with("HTTP/1.1 500 ") && injected.find("x-injected") == std::string::npos, "response injection rejected");
        server.stop();
        server.stop();
        server.start();
        const auto restarted_host = "127.0.0.1:" + std::to_string(server.port());
        require(request(server.port(), "GET /health HTTP/1.1\r\nHost: " + restarted_host + "\r\n\r\n").ends_with("native-http-ok"), "server restart");

        // Verify HTTP/1.1 keep-alive reuses a single TCP connection cleanly.
        {
            const SOCKET ka = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            require(ka != INVALID_SOCKET, "create keepalive socket");
            struct Cleanup { SOCKET socket; ~Cleanup() { closesocket(socket); } } cleanup{ka};
            const DWORD timeout = 5000;
            setsockopt(ka, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
            setsockopt(ka, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
            sockaddr_in addr{};
            addr.sin_family = AF_INET;
            addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            addr.sin_port = htons(server.port());
            require(connect(ka, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0, "connect keepalive");
            const std::string pipelined =
                "GET /health HTTP/1.1\r\nHost: " + restarted_host + "\r\nConnection: keep-alive\r\n\r\n" +
                "POST /echo HTTP/1.1\r\nHost: " + restarted_host + "\r\nConnection: keep-alive\r\nContent-Length: 4\r\n\r\npong" +
                "GET /health HTTP/1.1\r\nHost: " + restarted_host + "\r\nConnection: close\r\n\r\n";
            require(send(ka, pipelined.data(), static_cast<int>(pipelined.size()), 0) == static_cast<int>(pipelined.size()), "send keepalive batch");
            std::string combined;
            char buf[4096];
            for (;;) {
                const auto n = recv(ka, buf, sizeof(buf), 0);
                if (!n) break;
                require(n > 0, "read keepalive responses");
                combined.append(buf, static_cast<std::size_t>(n));
            }
            require(combined.find("connection: keep-alive\r\n") != std::string::npos, "keep-alive header emitted");
            require(combined.find("\r\n\r\npongHTTP/1.1 200 OK") != std::string::npos, "second reused response intact");
            require(combined.ends_with("native-http-ok"), "final close response intact");
            const auto st = server.stats();
            require(st.reused_requests >= 2 && st.total_requests >= 4, "server stats track reused requests");
        }

        server.stop();
        std::cout << "http_test: all checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "http_test: " << error.what() << '\n';
        return 1;
    }
}
