// Original headless Linux desktop protocol helper. The caller owns isolation.
#include "dimension/json.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <dirent.h>
#include <fcntl.h>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <poll.h>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

namespace {
using dimension::Json;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
constexpr int width = 1280;
constexpr int height = 800;
constexpr int preview_fps = 30;
constexpr std::size_t request_limit = 256U * 1024U;
constexpr std::size_t png_limit = 5U * 1024U * 1024U;
constexpr std::size_t jpeg_limit = 2U * 1024U * 1024U;
volatile std::sig_atomic_t received_signal = 0;
std::atomic<bool> stopping{false};
bool stopped() { return stopping.load(std::memory_order_relaxed) || received_signal != 0; }
void signal_stop(int) { received_signal = 1; }

struct ProtocolError : std::runtime_error {
    std::string code;
    ProtocolError(std::string value, const char* message) : std::runtime_error(message), code(std::move(value)) {}
};
[[noreturn]] void fail(const char* code, const char* message) { throw ProtocolError(code, message); }

void diagnostic(const char* text) {
    // Only fixed strings call this function; child stderr never reaches protocol output.
    static std::atomic<unsigned> count{0};
    if (count.fetch_add(1) < 16) {
        const std::size_t length = std::min<std::size_t>(std::strlen(text), 160);
        const auto message_written = ::write(STDERR_FILENO, text, length);
        const auto newline_written = ::write(STDERR_FILENO, "\n", 1);
        (void)message_written; (void)newline_written;
    }
}

class Fd {
public:
    explicit Fd(int value = -1) : value_(value) {}
    ~Fd() { reset(); }
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    Fd(Fd&& other) noexcept : value_(other.release()) {}
    Fd& operator=(Fd&& other) noexcept { if (this != &other) reset(other.release()); return *this; }
    int get() const { return value_; }
    int release() { return std::exchange(value_, -1); }
    void reset(int value = -1) { if (value_ >= 0) ::close(value_); value_ = value; }
private:
    int value_;
};

void nonblocking(int descriptor) {
    const int flags = ::fcntl(descriptor, F_GETFL, 0);
    if (flags < 0 || ::fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0)
        fail("PIPE_FAILED", "A local process pipe could not be configured.");
}

std::string base64(std::string_view bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve(((bytes.size() + 2U) / 3U) * 4U);
    for (std::size_t i = 0; i < bytes.size(); i += 3U) {
        const auto a = static_cast<unsigned char>(bytes[i]);
        const auto b = i + 1U < bytes.size() ? static_cast<unsigned char>(bytes[i + 1U]) : 0U;
        const auto c = i + 2U < bytes.size() ? static_cast<unsigned char>(bytes[i + 2U]) : 0U;
        result.push_back(alphabet[a >> 2U]);
        result.push_back(alphabet[((a & 3U) << 4U) | (b >> 4U)]);
        result.push_back(i + 1U < bytes.size() ? alphabet[((b & 15U) << 2U) | (c >> 6U)] : '=');
        result.push_back(i + 2U < bytes.size() ? alphabet[c & 63U] : '=');
    }
    return result;
}

std::string safe_utf8(std::string_view input) {
    std::string output;
    for (std::size_t i = 0; i < input.size();) {
        const auto first = static_cast<unsigned char>(input[i]);
        if (first < 0x80U) { if (first != 0U) output.push_back(input[i]); ++i; continue; }
        unsigned size = 0;
        std::uint32_t scalar = 0, minimum = 0;
        if (first >= 0xC2U && first <= 0xDFU) { size = 2; scalar = first & 0x1FU; minimum = 0x80U; }
        else if (first >= 0xE0U && first <= 0xEFU) { size = 3; scalar = first & 0x0FU; minimum = 0x800U; }
        else if (first >= 0xF0U && first <= 0xF4U) { size = 4; scalar = first & 7U; minimum = 0x10000U; }
        bool valid = size != 0 && i + size <= input.size();
        for (unsigned j = 1; valid && j < size; ++j) {
            const auto next = static_cast<unsigned char>(input[i + j]);
            if ((next & 0xC0U) != 0x80U) valid = false;
            scalar = (scalar << 6U) | (next & 0x3FU);
        }
        valid = valid && scalar >= minimum && scalar <= 0x10FFFFU && !(scalar >= 0xD800U && scalar <= 0xDFFFU);
        if (valid) { output.append(input.substr(i, size)); i += size; }
        else { output.append("\xEF\xBF\xBD"); ++i; }
    }
    return output;
}

class Output {
public:
    Output() { nonblocking(STDOUT_FILENO); }
    bool send(const Json& value, bool frame = false) {
        std::unique_lock<std::mutex> lock(mutex_, std::defer_lock);
        if (frame) { if (!lock.try_lock()) return false; }
        else lock.lock();
        const std::string line = value.dump() + '\n';
        std::size_t offset = 0;
        const auto deadline = Clock::now() + 2s;
        while (offset < line.size()) {
            const auto written = ::write(STDOUT_FILENO, line.data() + offset, line.size() - offset);
            if (written > 0) { offset += static_cast<std::size_t>(written); continue; }
            if (written < 0 && errno == EINTR) continue;
            if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && Clock::now() < deadline && !stopped()) {
                pollfd descriptor{STDOUT_FILENO, POLLOUT, 0};
                (void)::poll(&descriptor, 1, 25);
                continue;
            }
            stopping.store(true);
            return false;
        }
        return true;
    }
    void success(const Json& id, Json result) { send(Json::Object{{"id", id}, {"ok", true}, {"result", std::move(result)}}); }
    void error(const Json& id, const char* code, const char* message) {
        send(Json::Object{{"id", id}, {"ok", false}, {"error", Json::Object{{"code", code}, {"message", message}}}});
    }
private:
    std::mutex mutex_;
};

struct Child {
    pid_t pid = -1;
    Fd input;
    Fd output;
};
struct CommandResult {
    std::string output;
    int status = -1;
    bool timed_out = false;
    bool too_large = false;
    bool cancelled = false;
    bool success() const { return !timed_out && !too_large && !cancelled && WIFEXITED(status) && WEXITSTATUS(status) == 0; }
};

class Processes {
public:
    Child spawn(const std::vector<std::string>& arguments, bool capture = false, bool input = false) {
        if (stopped()) fail("CANCELLED", "The desktop session is closing.");
        if (arguments.empty() || arguments.front().empty() || arguments.front().front() != '/')
            fail("INVALID_EXECUTABLE", "An absolute executable path is required.");
        std::vector<char*> argv;
        for (const auto& argument : arguments) argv.push_back(const_cast<char*>(argument.c_str()));
        argv.push_back(nullptr);
        Fd null(::open("/dev/null", O_RDWR | O_CLOEXEC));
        if (null.get() < 0) fail("SPAWN_FAILED", "A local program could not be started.");
        int out_pipe[2]{-1, -1}, in_pipe[2]{-1, -1}, error_pipe[2]{-1, -1};
        if (::pipe2(error_pipe, O_CLOEXEC) < 0) fail("PIPE_FAILED", "A local process pipe could not be created.");
        Fd error_read(error_pipe[0]), error_write(error_pipe[1]);
        if (capture && ::pipe2(out_pipe, O_CLOEXEC) < 0) fail("PIPE_FAILED", "A local process pipe could not be created.");
        Fd out_read(out_pipe[0]), out_write(out_pipe[1]);
        if (input && ::pipe2(in_pipe, O_CLOEXEC) < 0) fail("PIPE_FAILED", "A local process pipe could not be created.");
        Fd in_read(in_pipe[0]), in_write(in_pipe[1]);
        const pid_t owner = ::getpid();
        const pid_t pid = ::fork();
        if (pid < 0) fail("SPAWN_FAILED", "A local program could not be started.");
        if (pid == 0) {
            // Only async-signal-safe calls occur between fork and exec in this multithreaded program.
            (void)::setpgid(0, 0);
            (void)::prctl(PR_SET_PDEATHSIG, SIGKILL);
            if (::getppid() != owner) ::_exit(125);
            struct sigaction action{};
            action.sa_handler = SIG_DFL;
            ::sigemptyset(&action.sa_mask);
            (void)::sigaction(SIGPIPE, &action, nullptr);
            (void)::sigaction(SIGTERM, &action, nullptr);
            (void)::sigaction(SIGINT, &action, nullptr);
            if (::dup2(input ? in_read.get() : null.get(), STDIN_FILENO) < 0 ||
                ::dup2(capture ? out_write.get() : null.get(), STDOUT_FILENO) < 0 ||
                ::dup2(null.get(), STDERR_FILENO) < 0) ::_exit(126);
            ::execv(argv[0], argv.data());
            const int exec_error = errno;
            const auto error_written = ::write(error_write.get(), &exec_error, sizeof(exec_error));
            (void)error_written;
            ::_exit(127);
        }
        (void)::setpgid(pid, pid);
        { std::lock_guard<std::mutex> lock(mutex_); roots_.insert(pid); if (!capture) backgrounds_.insert(pid); }
        in_read.reset(); out_write.reset(); error_write.reset();
        nonblocking(error_read.get());
        const auto deadline = Clock::now() + 2s;
        bool exec_ok = false;
        while (Clock::now() < deadline && !stopped()) {
            int error = 0;
            const auto size = ::read(error_read.get(), &error, sizeof(error));
            if (size == 0) { exec_ok = true; break; }
            if (size > 0) break;
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
            pollfd descriptor{error_read.get(), POLLIN | POLLHUP, 0};
            (void)::poll(&descriptor, 1, 20);
        }
        if (!exec_ok) { stop(pid); fail(stopped() ? "CANCELLED" : "SPAWN_FAILED", "A local program could not be started."); }
        if (out_read.get() >= 0) nonblocking(out_read.get());
        if (in_write.get() >= 0) nonblocking(in_write.get());
        return {pid, std::move(in_write), std::move(out_read)};
    }

    void forget(pid_t pid) { std::lock_guard<std::mutex> lock(mutex_); roots_.erase(pid); backgrounds_.erase(pid); }

    void reap_backgrounds() {
        std::set<pid_t> background;
        { std::lock_guard<std::mutex> lock(mutex_); background = backgrounds_; }
        for (const pid_t pid : background) {
            int status = 0;
            const pid_t result = ::waitpid(pid, &status, WNOHANG);
            if (result == pid || (result < 0 && errno == ECHILD)) forget(pid);
        }
    }

    void stop(pid_t pid) {
        if (pid <= 0) return;
        { std::lock_guard<std::mutex> lock(mutex_); if (!roots_.contains(pid)) return; }
        (void)::kill(-pid, SIGTERM);
        (void)::kill(pid, SIGTERM);
        int status = 0;
        const auto deadline = Clock::now() + 100ms;
        bool reaped = false;
        while (Clock::now() < deadline) {
            const pid_t result = ::waitpid(pid, &status, WNOHANG);
            if (result == pid || (result < 0 && errno == ECHILD)) { reaped = true; break; }
            std::this_thread::sleep_for(5ms);
        }
        (void)::kill(-pid, SIGKILL);
        if (!reaped) {
            (void)::kill(pid, SIGKILL);
            const auto final_deadline = Clock::now() + 250ms;
            while (Clock::now() < final_deadline) {
                const pid_t result = ::waitpid(pid, &status, WNOHANG);
                if (result == pid || (result < 0 && errno == ECHILD)) break;
                std::this_thread::sleep_for(5ms);
            }
        }
        forget(pid);
    }

    bool alive(pid_t pid) {
        int status = 0;
        const pid_t result = ::waitpid(pid, &status, WNOHANG);
        if (result == 0) return true;
        if (result == pid || (result < 0 && errno == ECHILD)) forget(pid);
        return false;
    }

    CommandResult run(const std::vector<std::string>& arguments, std::chrono::milliseconds timeout,
                      std::size_t limit = 65536, std::string_view input = {}) {
        Child child = spawn(arguments, true, !input.empty());
        CommandResult result;
        std::size_t sent = 0;
        bool output_eof = false, exited = false;
        const auto deadline = Clock::now() + timeout;
        std::array<char, 65536> buffer{};
        while (!output_eof || !exited) {
            if (stopped()) { result.cancelled = true; break; }
            if (Clock::now() >= deadline) { result.timed_out = true; break; }
            if (child.input.get() >= 0) {
                const auto size = ::write(child.input.get(), input.data() + sent, input.size() - sent);
                if (size > 0) sent += static_cast<std::size_t>(size);
                else if (size < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) child.input.reset();
                if (sent == input.size()) child.input.reset();
            }
            while (!output_eof) {
                const auto size = ::read(child.output.get(), buffer.data(), buffer.size());
                if (size > 0) {
                    if (result.output.size() + static_cast<std::size_t>(size) > limit) { result.too_large = true; break; }
                    result.output.append(buffer.data(), static_cast<std::size_t>(size));
                } else if (size == 0) { output_eof = true; child.output.reset(); break; }
                else if (errno == EINTR) continue;
                else if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                else { output_eof = true; child.output.reset(); break; }
            }
            if (result.too_large) break;
            if (!exited) {
                const pid_t waited = ::waitpid(child.pid, &result.status, WNOHANG);
                if (waited == child.pid) { exited = true; forget(child.pid); }
                else if (waited < 0 && errno != EINTR) { exited = true; forget(child.pid); }
            }
            if (!output_eof || !exited) {
                pollfd descriptor{child.output.get(), POLLIN | POLLHUP, 0};
                (void)::poll(&descriptor, 1, 10);
            }
        }
        if (!exited || result.too_large || result.timed_out || result.cancelled) stop(child.pid);
        return result;
    }

    static std::set<pid_t> descendants() {
        std::map<pid_t, pid_t> parents;
        DIR* directory = ::opendir("/proc");
        if (!directory) return {};
        while (const dirent* entry = ::readdir(directory)) {
            char* end = nullptr;
            const long value = std::strtol(entry->d_name, &end, 10);
            if (value <= 0 || *end != '\0' || value > std::numeric_limits<pid_t>::max()) continue;
            std::ifstream file(std::string("/proc/") + entry->d_name + "/stat");
            std::string line;
            std::getline(file, line);
            const auto bracket = line.rfind(')');
            if (bracket == std::string::npos || bracket + 4 >= line.size()) continue;
            const long parent = std::strtol(line.c_str() + bracket + 4, nullptr, 10);
            parents.emplace(static_cast<pid_t>(value), static_cast<pid_t>(parent));
        }
        ::closedir(directory);
        std::set<pid_t> found{::getpid()};
        bool changed = true;
        while (changed) {
            changed = false;
            for (const auto& [pid, parent] : parents)
                if (found.contains(parent) && !found.contains(pid)) { found.insert(pid); changed = true; }
        }
        found.erase(::getpid());
        return found;
    }

    void shutdown() {
        std::set<pid_t> roots;
        { std::lock_guard<std::mutex> lock(mutex_); roots = roots_; }
        for (const pid_t pid : roots) (void)::kill(-pid, SIGTERM);
        for (const pid_t pid : descendants()) (void)::kill(pid, SIGTERM);
        const auto deadline = Clock::now() + 250ms;
        while (Clock::now() < deadline) {
            int status = 0;
            while (::waitpid(-1, &status, WNOHANG) > 0) {}
            if (descendants().empty()) break;
            std::this_thread::sleep_for(10ms);
        }
        for (const pid_t pid : roots) (void)::kill(-pid, SIGKILL);
        for (const pid_t pid : descendants()) (void)::kill(pid, SIGKILL);
        const auto final_deadline = Clock::now() + 500ms;
        while (Clock::now() < final_deadline) {
            int status = 0;
            while (::waitpid(-1, &status, WNOHANG) > 0) {}
            if (descendants().empty()) break;
            std::this_thread::sleep_for(10ms);
        }
        { std::lock_guard<std::mutex> lock(mutex_); roots_.clear(); backgrounds_.clear(); }
    }
private:
    std::mutex mutex_;
    std::set<pid_t> roots_;
    std::set<pid_t> backgrounds_;
};

void require_success(const CommandResult& result, const char* message) {
    if (result.cancelled) fail("CANCELLED", "The desktop session is closing.");
    if (result.timed_out) fail("ACTION_TIMEOUT", "A desktop program exceeded its time limit.");
    if (result.too_large) fail("OUTPUT_LIMIT", "A desktop program exceeded its output limit.");
    if (!result.success()) fail("ACTION_FAILED", message);
}

class Preview {
public:
    Preview(Processes& processes, Output& output) : processes_(processes), output_(output) {}
    ~Preview() { disable(); }
    void enable() {
        if (requested_.load() && running_.load()) return;
        disable();
        requested_.store(true);
        { std::lock_guard<std::mutex> lock(mutex_); first_frame_ = false; finished_ = false; }
        thread_ = std::thread([this] { encode(); });
        std::unique_lock<std::mutex> lock(mutex_);
        const auto deadline = Clock::now() + 5s;
        while (!first_frame_ && !finished_ && !stopped() && Clock::now() < deadline) changed_.wait_for(lock, 25ms);
        const bool available = first_frame_ && !stopped();
        lock.unlock();
        if (!available) { disable(); fail("PREVIEW_FAILED", "A live desktop preview could not be started."); }
    }
    void disable() {
        requested_.store(false);
        if (thread_.joinable()) thread_.join();
        running_.store(false);
    }
private:
    void encode() {
        Child encoder;
        try {
            encoder = processes_.spawn({"/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-draw_mouse", "1", "-i", ":99.0",
                "-an", "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", "1", "-f", "image2pipe", "pipe:1"}, true);
            running_.store(true);
            std::string pending;
            std::array<char, 65536> buffer{};
            auto last_frame = Clock::now();
            bool eof = false;
            while (requested_.load() && !stopped() && !eof) {
                pollfd descriptor{encoder.output.get(), POLLIN | POLLHUP, 0};
                (void)::poll(&descriptor, 1, 50);
                for (;;) {
                    const auto size = ::read(encoder.output.get(), buffer.data(), buffer.size());
                    if (size > 0) pending.append(buffer.data(), static_cast<std::size_t>(size));
                    else if (size == 0) { eof = true; break; }
                    else if (errno == EINTR) continue;
                    else if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                    else { eof = true; break; }
                    if (pending.size() > jpeg_limit + buffer.size()) fail("PREVIEW_LIMIT", "Preview frame size exceeded its limit.");
                    for (;;) {
                        const auto start = pending.find("\xFF\xD8", 0, 2);
                        if (start == std::string::npos) { if (pending.size() > 1) pending.erase(0, pending.size() - 1); break; }
                        if (start) pending.erase(0, start);
                        const auto end = pending.find("\xFF\xD9", 2, 2);
                        if (end == std::string::npos) break;
                        const std::size_t frame_size = end + 2;
                        if (frame_size > jpeg_limit) fail("PREVIEW_LIMIT", "Preview frame size exceeded its limit.");
                        std::string frame = pending.substr(0, frame_size);
                        pending.erase(0, frame_size);
                        last_frame = Clock::now();
                        { std::lock_guard<std::mutex> lock(mutex_); first_frame_ = true; changed_.notify_all(); }
                        if (requested_.load() && !stopped()) {
                            output_.send(Json::Object{{"event", "frame"}, {"jpeg", base64(frame)},
                                {"seq", static_cast<double>(++sequence_)}, {"width", width}, {"height", height}}, true);
                        }
                    }
                }
                if (Clock::now() - last_frame > 5s) fail("PREVIEW_TIMEOUT", "The desktop encoder stopped producing frames.");
            }
        } catch (...) { if (!stopped() && requested_.load()) diagnostic("Desktop preview encoder failed."); }
        if (encoder.pid > 0) processes_.stop(encoder.pid);
        running_.store(false);
        requested_.store(false);
        { std::lock_guard<std::mutex> lock(mutex_); finished_ = true; changed_.notify_all(); }
    }
    Processes& processes_;
    Output& output_;
    std::thread thread_;
    std::atomic<bool> requested_{false}, running_{false};
    std::mutex mutex_;
    std::condition_variable changed_;
    bool first_frame_ = false, finished_ = true;
    std::uint64_t sequence_ = 0;
};

class Input {
public:
    explicit Input(Output& output) : output_(output) { reader_ = std::thread([this] { read(); }); }
    ~Input() { stopping.store(true); if (reader_.joinable()) reader_.join(); }
    std::optional<std::string> next() {
        std::unique_lock<std::mutex> lock(mutex_);
        while (queue_.empty() && !stopped()) changed_.wait_for(lock, 50ms);
        if (stopped()) return std::nullopt;
        auto line = std::move(queue_.front());
        queued_bytes_ -= line.size(); queue_.pop_front();
        return line;
    }
private:
    void read() {
        std::array<char, 8192> buffer{};
        std::string line;
        bool discard = false;
        while (!stopped()) {
            pollfd descriptor{STDIN_FILENO, POLLIN | POLLHUP, 0};
            const int ready = ::poll(&descriptor, 1, 50);
            if (ready < 0 && errno == EINTR) continue;
            if (ready < 0) break;
            if (ready == 0) continue;
            const auto size = ::read(STDIN_FILENO, buffer.data(), buffer.size());
            if (size == 0) break;
            if (size < 0) { if (errno == EINTR || errno == EAGAIN) continue; break; }
            for (ssize_t i = 0; i < size && !stopped(); ++i) {
                const char ch = buffer[static_cast<std::size_t>(i)];
                if (ch == '\n') {
                    if (!discard && !line.empty()) {
                        if (line.back() == '\r') line.pop_back();
                        bool full = false;
                        { std::lock_guard<std::mutex> lock(mutex_);
                          full = queue_.size() >= 64 || queued_bytes_ + line.size() > 1024U * 1024U;
                          if (!full) { queued_bytes_ += line.size(); queue_.push_back(std::move(line)); changed_.notify_one(); } }
                        if (full) output_.error(nullptr, "QUEUE_FULL", "Desktop request queue is full.");
                    }
                    line.clear(); discard = false;
                } else if (!discard) {
                    line.push_back(ch);
                    if (line.size() > request_limit) { output_.error(nullptr, "REQUEST_LIMIT", "Desktop request exceeds 256 KiB."); line.clear(); discard = true; }
                }
            }
        }
        stopping.store(true);
        changed_.notify_all();
    }
    Output& output_;
    std::thread reader_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> queue_;
    std::size_t queued_bytes_ = 0;
};

const std::string& string_field(const Json& value, const char* name, std::size_t limit) {
    const Json* field = value.find(name);
    if (!field || !field->is_string() || field->as_string().size() > limit || field->as_string().find('\0') != std::string::npos)
        fail("INVALID_ARGUMENT", "A required string field is missing, invalid or too long.");
    return field->as_string();
}
int integer_field(const Json& value, const char* name, int minimum, int maximum) {
    const Json* field = value.find(name);
    if (!field || !field->is_number() || !std::isfinite(field->as_number()) ||
        std::floor(field->as_number()) != field->as_number() || field->as_number() < minimum || field->as_number() > maximum)
        fail("INVALID_ARGUMENT", "A coordinate or numeric field is outside its supported integer range.");
    return static_cast<int>(field->as_number());
}
int button_field(const Json& value) {
    const Json* button = value.find("button");
    if (!button) return 1;
    if (button->is_string()) {
        if (button->as_string() == "left") return 1;
        if (button->as_string() == "middle") return 2;
        if (button->as_string() == "right") return 3;
    } else if (button->is_number() && button->as_number() >= 1 && button->as_number() <= 3 && std::floor(button->as_number()) == button->as_number())
        return static_cast<int>(button->as_number());
    fail("INVALID_BUTTON", "Mouse button must be left, middle, right, or an integer from 1 to 3.");
}

std::string validated_key(const std::string& key) {
    if (key.empty() || key.size() > 128) fail("INVALID_KEY", "A supported key or modifier chord is required.");
    std::vector<std::string> parts;
    std::size_t start = 0;
    for (;;) {
        const auto end = key.find('+', start);
        parts.push_back(key.substr(start, end == std::string::npos ? end : end - start));
        if (end == std::string::npos) break;
        start = end + 1;
    }
    if (parts.size() > 5) fail("INVALID_KEY", "A key chord contains too many modifiers.");
    std::string result;
    std::set<std::string> modifiers;
    for (std::size_t i = 0; i + 1 < parts.size(); ++i) {
        std::string lower = parts[i];
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (lower == "control") lower = "ctrl";
        if (lower == "meta" || lower == "win") lower = "super";
        if ((lower != "ctrl" && lower != "alt" && lower != "shift" && lower != "super") || !modifiers.insert(lower).second)
            fail("INVALID_KEY", "A key chord uses an unsupported or duplicate modifier.");
        result += lower + '+';
    }
    std::string base = parts.back();
    const std::map<std::string, std::string> aliases{{"Enter", "Return"}, {"Esc", "Escape"}, {"Backspace", "BackSpace"},
        {"PageUp", "Page_Up"}, {"PageDown", "Page_Down"}, {"Space", "space"}, {"ArrowLeft", "Left"}, {"ArrowRight", "Right"}, {"ArrowUp", "Up"}, {"ArrowDown", "Down"}};
    if (const auto alias = aliases.find(base); alias != aliases.end()) base = alias->second;
    const std::set<std::string> names{"Return", "Tab", "Escape", "BackSpace", "Delete", "Insert", "Home", "End", "Left", "Right", "Up", "Down",
        "Page_Up", "Page_Down", "space", "minus", "equal", "plus", "comma", "period", "slash", "backslash", "semicolon", "apostrophe", "bracketleft", "bracketright", "grave", "Print", "Pause", "Caps_Lock"};
    bool valid = names.contains(base) || (base.size() == 1 && ((base[0] >= 'a' && base[0] <= 'z') || (base[0] >= 'A' && base[0] <= 'Z') || (base[0] >= '0' && base[0] <= '9')));
    if (base.size() >= 2 && base.size() <= 3 && base.front() == 'F') {
        int number = 0;
        bool digits = true;
        for (std::size_t i = 1; i < base.size(); ++i) { digits = digits && base[i] >= '0' && base[i] <= '9'; number = number * 10 + (base[i] - '0'); }
        valid = valid || (digits && number >= 1 && number <= 24);
    }
    if (!valid) fail("INVALID_KEY", "The key name is not supported; use type for arbitrary text.");
    return result + base;
}

class Desktop {
public:
    Desktop(Processes& processes, Preview& preview) : processes_(processes), preview_(preview) {}
    void initialize() {
        if (::chdir("/workspace") < 0) fail("STARTUP_FAILED", "The isolated workspace is unavailable.");
        if (::setenv("DISPLAY", ":99", 1) < 0 || ::setenv("HOME", "/home/bot", 1) < 0 ||
            ::setenv("TMPDIR", "/tmp", 1) < 0 || ::setenv("XDG_RUNTIME_DIR", "/run/user/1000", 1) < 0)
            fail("STARTUP_FAILED", "The isolated desktop environment could not be configured.");
        (void)::mkdir("/run/user", 0700);
        (void)::mkdir("/run/user/1000", 0700);
        // Abstract X sockets live in the network namespace, which may be shared
        // for internet access. Keep only the pathname socket in this Bot's /tmp.
        const Child display = processes_.spawn({"/usr/bin/Xvfb", ":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-nolisten", "local", "-ac", "-noreset"});
        const auto deadline = Clock::now() + 8s;
        bool ready = false;
        while (!stopped() && Clock::now() < deadline && processes_.alive(display.pid)) {
            const auto geometry = processes_.run({"/usr/bin/xdotool", "getdisplaygeometry"}, 500ms, 256);
            if (geometry.success() && geometry.output.find("1280 800") != std::string::npos) { ready = true; break; }
            std::this_thread::sleep_for(25ms);
        }
        if (!ready) fail("STARTUP_FAILED", "The private X display did not become ready.");
        const Child manager = processes_.spawn({"/usr/bin/openbox", "--sm-disable"});
        const auto settle = Clock::now() + 150ms;
        while (!stopped() && Clock::now() < settle) std::this_thread::sleep_for(10ms);
        if (stopped() || !processes_.alive(manager.pid)) fail("STARTUP_FAILED", "The private window manager did not start.");
    }

    Json execute(const Json& request) {
        const std::string& operation = string_field(request, "op", 32);
        if (operation == "launch") return launch(request);
        if (operation == "observe") return observe();
        if (operation == "downloads") return downloads(request, false);
        if (operation == "download_read") return downloads(request, true);
        if (operation == "preview") {
            const Json* enabled = request.find("enabled");
            if (!enabled || !enabled->is_bool()) fail("INVALID_ARGUMENT", "preview requires a boolean enabled field.");
            if (enabled->as_bool()) preview_.enable(); else preview_.disable();
            return Json::Object{{"enabled", enabled->as_bool()}, {"previewFps", preview_fps}};
        }
        if (operation == "click" || operation == "drag" || operation == "scroll") return pointer(request, operation);
        if (operation == "type") return type(request);
        if (operation == "press") {
            const std::string key = validated_key(string_field(request, "key", 128));
            require_success(processes_.run({"/usr/bin/xdotool", "key", "--clearmodifiers", key}, 2s), "The key action failed.");
            return Json::Object{{"pressed", true}};
        }
        if (operation == "shutdown") return Json::Object{{"shuttingDown", true}};
        fail("UNKNOWN_OP", "Unknown desktop operation.");
    }
private:
    static std::string download_token(const struct stat& value) {
        return std::to_string(value.st_dev) + ":" + std::to_string(value.st_ino) + ":" +
               std::to_string(value.st_size) + ":" + std::to_string(value.st_mtim.tv_sec) + ":" +
               std::to_string(value.st_mtim.tv_nsec) + ":" + std::to_string(value.st_ctim.tv_sec) + ":" +
               std::to_string(value.st_ctim.tv_nsec);
    }
    static bool download_name(const std::string& name) {
        if (name.empty() || name.size() > 240 || name.front() == '.' ||
            name.find('/') != name.npos || name.find('\\') != name.npos ||
            name.find('\0') != name.npos || safe_utf8(name) != name) return false;
        auto extension = name.substr(name.find_last_of('.') == name.npos ? name.size() : name.find_last_of('.'));
        std::transform(extension.begin(), extension.end(), extension.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return extension == ".png" || extension == ".jpg" || extension == ".jpeg" ||
               extension == ".webp" || extension == ".gif";
    }
    Json downloads(const Json& request, bool read) {
        constexpr std::size_t limit = 16U * 1024U * 1024U;
        Fd directory(::open("/home/bot/Downloads", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
        if (directory.get() < 0) {
            if (!read && errno == ENOENT) return Json::Object{{"files", Json::Array{}}};
            fail("DOWNLOAD_DIRECTORY", "The browser download directory is unavailable.");
        }
        if (!read) {
            DIR* entries = ::fdopendir(::dup(directory.get()));
            if (!entries) fail("DOWNLOAD_DIRECTORY", "The browser download directory cannot be listed.");
            Json::Array files;
            while (const auto* entry = ::readdir(entries)) {
                const std::string name = entry->d_name;
                struct stat information{};
                if (!download_name(name) || ::fstatat(directory.get(), name.c_str(), &information, AT_SYMLINK_NOFOLLOW) < 0 ||
                    !S_ISREG(information.st_mode) || information.st_nlink != 1 ||
                    information.st_size <= 0 || static_cast<std::uint64_t>(information.st_size) > limit) continue;
                if (files.size() == 512) { ::closedir(entries); fail("DOWNLOAD_LIMIT", "Too many browser downloads; archive old files before continuing."); }
                files.emplace_back(Json::Object{{"name", name}, {"bytes", static_cast<double>(information.st_size)},
                                                {"snapshot", download_token(information)}});
            }
            ::closedir(entries);
            return Json::Object{{"files", files}};
        }
        const auto& name = string_field(request, "name", 240);
        const auto& snapshot = string_field(request, "snapshot", 256);
        if (!download_name(name)) fail("INVALID_ARGUMENT", "The download filename is invalid.");
        const auto offset = integer_field(request, "offset", 0, static_cast<int>(limit));
        Fd file(::openat(directory.get(), name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
        struct stat before{}, after{};
        if (file.get() < 0 || ::fstat(file.get(), &before) < 0 || !S_ISREG(before.st_mode) ||
            before.st_nlink != 1 || before.st_size <= 0 || static_cast<std::uint64_t>(before.st_size) > limit ||
            download_token(before) != snapshot || offset > before.st_size)
            fail("DOWNLOAD_CHANGED", "The download is unavailable or has changed; list it again.");
        std::string bytes(static_cast<std::size_t>(std::min<off_t>(512U * 1024U, before.st_size - offset)), '\0');
        std::size_t consumed = 0;
        while (consumed < bytes.size()) {
            if (stopped()) fail("CANCELLED", "The download read was cancelled.");
            const auto count = ::pread(file.get(), bytes.data() + consumed, bytes.size() - consumed, offset + consumed);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) fail("DOWNLOAD_CHANGED", "The download could not be read completely.");
            consumed += static_cast<std::size_t>(count);
        }
        if (::fstat(file.get(), &after) < 0 || download_token(after) != snapshot)
            fail("DOWNLOAD_CHANGED", "The download changed while it was being read.");
        return Json::Object{{"name", name}, {"snapshot", snapshot}, {"offset", offset},
                            {"total", static_cast<double>(before.st_size)},
                            {"data", base64(bytes)}, {"eof", offset + bytes.size() == static_cast<std::size_t>(before.st_size)}};
    }
    Json launch(const Json& request) {
        const std::string executable = string_field(request, "executable", 4096);
        if (executable.empty() || executable.front() != '/') fail("INVALID_EXECUTABLE", "An absolute executable path is required.");
        struct stat information{};
        if (::stat(executable.c_str(), &information) < 0 || !S_ISREG(information.st_mode) || ::access(executable.c_str(), X_OK) < 0)
            fail("INVALID_EXECUTABLE", "The executable is unavailable or not executable in this desktop.");
        std::vector<std::string> arguments{executable};
        std::size_t bytes = executable.size();
        if (const Json* args = request.find("args")) {
            if (!args->is_array() || args->as_array().size() > 128) fail("INVALID_ARGUMENT", "launch args must be an array of at most 128 strings.");
            for (const Json& argument : args->as_array()) {
                if (!argument.is_string() || argument.as_string().find('\0') != std::string::npos || argument.as_string().size() > 65536)
                    fail("INVALID_ARGUMENT", "A launch argument is invalid or too long.");
                bytes += argument.as_string().size();
                if (bytes > 128U * 1024U) fail("INVALID_ARGUMENT", "Launch arguments exceed 128 KiB.");
                arguments.push_back(argument.as_string());
            }
        }
        const Child program = processes_.spawn(arguments);
        return Json::Object{{"pid", static_cast<int>(program.pid)}, {"launched", true}};
    }

    Json observe() {
        const auto screenshot = processes_.run({"/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-draw_mouse", "1", "-i", ":99.0",
            "-frames:v", "1", "-an", "-c:v", "png", "-pix_fmt", "rgb24", "-threads", "1", "-f", "image2pipe", "pipe:1"}, 6s, png_limit);
        require_success(screenshot, "The desktop screenshot failed.");
        const auto& png = screenshot.output;
        constexpr char signature[] = "\x89PNG\r\n\x1A\n";
        if (png.size() < 24 || png.compare(0, 8, signature, 8) != 0 || png.compare(12, 4, "IHDR") != 0)
            fail("INVALID_FRAME", "The capture program did not produce a valid PNG frame.");
        auto big_endian = [&](std::size_t offset) {
            std::uint32_t number = 0;
            for (std::size_t i = 0; i < 4; ++i) number = (number << 8U) | static_cast<unsigned char>(png[offset + i]);
            return number;
        };
        if (big_endian(16) != width || big_endian(20) != height) fail("INVALID_FRAME", "The screenshot dimensions do not match this desktop.");
        Json::Object result{{"png", base64(png)}, {"width", width}, {"height", height}};
        const auto title = processes_.run({"/usr/bin/xdotool", "getactivewindow", "getwindowname"}, 1s, 4096);
        if (title.success()) {
            std::string name = safe_utf8(title.output);
            while (!name.empty() && (name.back() == '\r' || name.back() == '\n')) name.pop_back();
            if (!name.empty()) result.emplace("windowTitle", std::move(name));
        }
        return result;
    }

    Json pointer(const Json& request, const std::string& operation) {
        const int x = integer_field(request, "x", 0, width - 1), y = integer_field(request, "y", 0, height - 1);
        std::vector<std::string> command{"/usr/bin/xdotool", "mousemove", std::to_string(x), std::to_string(y)};
        if (operation == "scroll") {
            const int amount = integer_field(request, "amount", -50, 50);
            if (amount != 0) command.insert(command.end(), {"click", "--clearmodifiers", "--repeat", std::to_string(std::abs(amount)), "--delay", "10", amount > 0 ? "5" : "4"});
        } else {
            const int button = button_field(request);
            if (operation == "click") command.insert(command.end(), {"click", "--clearmodifiers", std::to_string(button)});
            else {
                const int to_x = integer_field(request, "toX", 0, width - 1), to_y = integer_field(request, "toY", 0, height - 1);
                command.insert(command.end(), {"mousedown", "--clearmodifiers", std::to_string(button)});
                for (int step = 1; step <= 16; ++step) command.insert(command.end(), {"mousemove", std::to_string(x + (to_x - x) * step / 16), std::to_string(y + (to_y - y) * step / 16), "sleep", "0.015"});
                command.insert(command.end(), {"mouseup", "--clearmodifiers", std::to_string(button)});
            }
        }
        const auto result = processes_.run(command, 3s);
        if (!result.success() && operation == "drag" && !stopped())
            (void)processes_.run({"/usr/bin/xdotool", "mouseup", "1", "mouseup", "2", "mouseup", "3"}, 1s);
        require_success(result, "The mouse action failed.");
        return Json::Object{{"performed", true}};
    }

    Json type(const Json& request) {
        const std::string& text = string_field(request, "text", 65536);
        if (text.empty()) return Json::Object{{"typedBytes", 0}};
        Child clipboard = processes_.spawn({"/usr/bin/xclip", "-selection", "clipboard", "-target", "UTF8_STRING", "-in", "-quiet"}, false, true);
        std::size_t sent = 0;
        const auto deadline = Clock::now() + 2s;
        while (sent < text.size() && !stopped() && Clock::now() < deadline) {
            const auto size = ::write(clipboard.input.get(), text.data() + sent, text.size() - sent);
            if (size > 0) sent += static_cast<std::size_t>(size);
            else if (size < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) break;
            else { pollfd descriptor{clipboard.input.get(), POLLOUT, 0}; (void)::poll(&descriptor, 1, 10); }
        }
        clipboard.input.reset();
        bool ready = false;
        if (sent == text.size()) {
            const auto selection_deadline = Clock::now() + 2s;
            while (!stopped() && Clock::now() < selection_deadline && processes_.alive(clipboard.pid)) {
                const auto selection = processes_.run({"/usr/bin/xclip", "-selection", "clipboard", "-target", "UTF8_STRING", "-out"}, 500ms, 65536);
                if (selection.success() && selection.output == text) { ready = true; break; }
                std::this_thread::sleep_for(10ms);
            }
        }
        if (!ready) { processes_.stop(clipboard.pid); fail("CLIPBOARD_FAILED", "UTF-8 clipboard text could not be prepared."); }
        if (clipboard_pid_ > 0) processes_.stop(clipboard_pid_);
        clipboard_pid_ = clipboard.pid;
        // A second X client can already read the selection before a GUI application
        // has processed its asynchronous XFixes ownership/format notification.
        // Give that notification time to settle before injecting the first paste.
        const auto clipboard_settle = Clock::now() + 250ms;
        while (!stopped() && Clock::now() < clipboard_settle) std::this_thread::sleep_for(10ms);
        if (stopped()) fail("CANCELLED", "The desktop session is closing.");
        require_success(processes_.run({"/usr/bin/xdotool", "key", "--clearmodifiers", "ctrl+v"}, 2s), "The clipboard paste action failed.");
        return Json::Object{{"typedBytes", static_cast<int>(text.size())}};
    }
    Processes& processes_;
    Preview& preview_;
    pid_t clipboard_pid_ = -1;
};

bool valid_id(const Json& id) {
    return (id.is_string() && id.as_string().size() <= 128 && id.as_string().find('\0') == std::string::npos) ||
        (id.is_number() && id.as_number() >= 0 && id.as_number() <= 9007199254740991.0 && std::floor(id.as_number()) == id.as_number());
}
} // namespace

int main() {
    struct sigaction action{};
    action.sa_handler = signal_stop;
    ::sigemptyset(&action.sa_mask);
    (void)::sigaction(SIGTERM, &action, nullptr);
    (void)::sigaction(SIGINT, &action, nullptr);
    action.sa_handler = SIG_IGN;
    (void)::sigaction(SIGPIPE, &action, nullptr);
    if (::prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) { diagnostic("Desktop child supervision could not be initialized."); return 1; }
    Processes processes;
    int status = 0;
    try {
        Output output;
        Input input(output);
        Preview preview(processes, output);
        Desktop desktop(processes, preview);
        try { desktop.initialize(); }
        catch (const ProtocolError& error) {
            if (!stopped()) output.error(nullptr, error.code.c_str(), error.what());
            stopping.store(true); status = 1;
        }
        if (!stopped()) output.send(Json::Object{{"event", "ready"}, {"width", width}, {"height", height}, {"previewFps", preview_fps}});
        while (!stopped()) {
            const auto line = input.next();
            if (!line) break;
            processes.reap_backgrounds();
            Json id;
            try {
                const Json request = Json::parse(*line);
                const Json* supplied_id = request.find("id");
                if (!request.is_object() || !supplied_id || !valid_id(*supplied_id)) fail("INVALID_REQUEST", "A request object with a short string or integer id is required.");
                id = *supplied_id;
                Json result = desktop.execute(request);
                output.success(id, std::move(result));
                if (request.at("op").as_string() == "shutdown") stopping.store(true);
            } catch (const ProtocolError& error) {
                if (!stopped()) output.error(id, error.code.c_str(), error.what());
            } catch (const std::exception&) {
                if (!stopped()) output.error(id, "INVALID_REQUEST", "Desktop request could not be parsed or completed.");
            }
        }
        stopping.store(true);
        preview.disable();
    } catch (const std::exception&) {
        diagnostic("Desktop helper initialization failed.");
        stopping.store(true); status = 1;
    }
    processes.shutdown();
    return status;
}
