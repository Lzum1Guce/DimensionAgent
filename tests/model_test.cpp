#include "dimension/model.hpp"

#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

using namespace dimension;
using namespace std::chrono_literals;

namespace {
int passed = 0;
int failed = 0;
constexpr auto fixture_key = "fixture-key-never-echo-4b72";
using Bytes = std::vector<std::uint8_t>;

void append_u32(Bytes& bytes, std::uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

void png_chunk(Bytes& png, std::string_view type, const Bytes& data) {
    append_u32(png, static_cast<std::uint32_t>(data.size()));
    const auto start = png.size();
    png.insert(png.end(), type.begin(), type.end());
    png.insert(png.end(), data.begin(), data.end());
    // Deliberately use the simple polynomial algorithm, independent of the
    // production lookup-table implementation. The Node server inflates pixels.
    std::uint32_t crc = 0xffffffffU;
    for (auto i = start; i < png.size(); ++i) {
        crc ^= png[i];
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1U) ^ ((crc & 1U) ? 0xedb88320U : 0U);
    }
    append_u32(png, crc ^ 0xffffffffU);
}

std::string encode64(const Bytes& bytes) {
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve((bytes.size() + 2U) / 3U * 4U);
    for (std::size_t i = 0; i < bytes.size(); i += 3U) {
        const auto a = bytes[i];
        const auto b = i + 1U < bytes.size() ? bytes[i + 1U] : 0U;
        const auto c = i + 2U < bytes.size() ? bytes[i + 2U] : 0U;
        result += alphabet[a >> 2U];
        result += alphabet[((a & 3U) << 4U) | (b >> 4U)];
        result += i + 1U < bytes.size() ? alphabet[((b & 15U) << 2U) | (c >> 6U)] : '=';
        result += i + 2U < bytes.size() ? alphabet[c & 63U] : '=';
    }
    return result;
}

Bytes fixture_png(bool alternate = false, std::size_t padded_size = 0U,
                  bool invalid_pixels = false, unsigned depth = 8U) {
    Bytes png{137, 80, 78, 71, 13, 10, 26, 10};
    Bytes ihdr;
    append_u32(ihdr, 3); append_u32(ihdr, 2);
    ihdr.insert(ihdr.end(), {static_cast<std::uint8_t>(depth), 2, 0, 0, 0});
    png_chunk(png, "IHDR", ihdr);
    // Two scanlines: red/green/blue, white/black/magenta. The alternate image
    // inverts every channel. Filter bytes remain zero.
    Bytes raw{0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
              0, 255, 255, 255, 0, 0, 0, 255, 0, 255};
    if (alternate)
        for (std::size_t i = 0; i < raw.size(); ++i) if (i % 10U) raw[i] ^= 255U;
    if (invalid_pixels) raw.clear();
    // A zlib stream containing one uncompressed DEFLATE block. This is a real
    // PNG, created without an image library or a downloaded fixture.
    const auto count = static_cast<unsigned>(raw.size());
    Bytes compressed{0x78, 0x01, 0x01, static_cast<std::uint8_t>(count), 0,
                     static_cast<std::uint8_t>(~count), 0xff};
    compressed.insert(compressed.end(), raw.begin(), raw.end());
    std::uint32_t s1 = 1, s2 = 0;
    for (const auto byte : raw) { s1 = (s1 + byte) % 65521U; s2 = (s2 + s1) % 65521U; }
    append_u32(compressed, (s2 << 16U) | s1);
    png_chunk(png, "IDAT", compressed);
    if (padded_size) {
        if (padded_size < png.size() + 24U) throw std::runtime_error("invalid fixture padding size");
        png_chunk(png, "npAD", Bytes(padded_size - png.size() - 24U, 0));
    }
    png_chunk(png, "IEND", {});
    return png;
}

ModelImage fixture_image(bool alternate = false, std::size_t padded_size = 0U) {
    return {"image/png", encode64(fixture_png(alternate, padded_size)), 3, 2};
}

const ModelImage& large_image() {
    static const auto image = fixture_image(false, model_image_binary_limit);
    return image;
}

void require(bool condition, const char* description) {
    if (!condition) throw std::runtime_error(description);
}

void test(const char* name, const std::function<void()>& body) {
    try {
        body();
        ++passed;
        std::cout << "PASS " << name << '\n';
    } catch (const std::exception& e) {
        ++failed;
        const std::string message = e.what();
        std::cerr << "FAIL " << name << ": "
                  << (message.find(fixture_key) == std::string::npos ? message : "error leaked test credential") << '\n';
    }
}

void rejects(const std::function<void()>& body, std::string_view expected = {}) {
    try { body(); }
    catch (const std::exception& e) {
        const std::string_view message(e.what());
        require(message.find(fixture_key) == std::string_view::npos, "exception contains credential");
        require(expected.empty() || message.find(expected) != std::string_view::npos, "unexpected error category");
        return;
    }
    throw std::runtime_error("expected an exception");
}

std::vector<ModelMessage> history() {
    return {{"system", "Test fixture only", {}, {}}, {"user", "你好", {}, {}},
        {"assistant", "", {{"history_call", "search", "{\"q\":\"old\"}"}}, {}},
        {"tool", "historical result", {}, "history_call"}};
}

std::vector<ModelTool> definitions() {
    return {{"search", "Local fixture tool", Json::Object{{"type", "object"},
        {"properties", Json::Object{{"q", Json::Object{{"type", "string"}}}}}}}};
}

ModelConfig config(std::string base) {
    ModelConfig result;
    result.base_url = std::move(base);
    result.api_key = fixture_key;
    result.model = "fixture-model";
    result.timeout_ms = 5000;
    return result;
}

void offline_tests() {
    const auto base = config("http://127.0.0.1:1/v1");
    test("unknown protocol rejected before network", [&] {
        auto c = base; c.protocol = "unknown";
        rejects([&] { call_model(c, history(), definitions()); }, "Unsupported model protocol");
    });
    test("endpoint protocol mismatch", [&] {
        auto c = base; c.base_url += "/responses";
        rejects([&] { call_model(c, history(), definitions()); }, "endpoint does not match");
    });
    test("embedded URL credentials refused", [&] {
        auto c = base; c.base_url = "http://user:secret@127.0.0.1:1/v1";
        rejects([&] { call_model(c, history(), definitions()); }, "embedded credentials");
    });
    test("API key header injection refused", [&] {
        auto c = base; c.api_key += "\r\nX-Test: injected";
        rejects([&] { call_model(c, history(), definitions()); }, "Invalid model API key");
    });
    test("invalid role rejected", [&] {
        auto input = history(); input.front().role = "other";
        rejects([&] { call_model(base, input, definitions()); }, "message role");
    });
    test("oversized request rejected", [&] {
        auto input = history(); input.front().content.assign(4U * 1024U * 1024U, 'x');
        rejects([&] { call_model(base, input, definitions()); }, "size limit");
    });
    test("escaped request size bounded", [&] {
        auto input = history(); input.front().content.assign(800U * 1024U, '\1');
        rejects([&] { call_model(base, input, definitions()); }, "size limit");
    });
    test("Work request limit remains bounded after JSON escaping", [&] {
        auto c = base; c.payload_limits = work_model_payload_limits;
        auto input = history(); input.front().content.assign(6U * 1024U * 1024U, '\1');
        rejects([&] { call_model(c, input, definitions()); }, "Model text request exceeds size limit");
    });
    test("zero or unsupported payload profiles rejected before network", [&] {
        auto c = base; c.payload_limits.response_bytes = 0;
        rejects([&] { call_model(c, history(), definitions()); }, "Invalid model payload limits");
        c.payload_limits = work_model_payload_limits;
        ++c.payload_limits.response_bytes;
        rejects([&] { call_model(c, history(), definitions()); }, "Invalid model payload limits");
    });
    test("large Work request preflight remains cancellable", [&] {
        auto c = base; c.payload_limits = work_model_payload_limits;
        auto input = history(); input.front().content.assign(31U * 1024U * 1024U, 'Q');
        std::stop_source source;
        const auto start = std::chrono::steady_clock::now();
        std::jthread cancel([&] { std::this_thread::sleep_for(1ms); source.request_stop(); });
        rejects([&] { call_model(c, input, definitions(), {}, source.get_token()); }, "cancelled");
        require(std::chrono::steady_clock::now() - start < 1500ms, "Work preflight cancellation was not prompt");
    });
    test("zero timeout rejected", [&] {
        auto c = base; c.timeout_ms = 0;
        rejects([&] { call_model(c, history(), definitions()); }, "timeout");
    });
    test("pre-cancelled request", [&] {
        std::stop_source source; source.request_stop();
        rejects([&] { call_model(base, history(), definitions(), {}, source.get_token()); }, "cancelled");
    });
}

void image_tests() {
    const auto base = config("http://127.0.0.1:1/v1");
    const auto png = fixture_image();
    test("real synthetic PNG decodes with default MIME and dimensions", [&] {
        ModelImage image;
        image.base64_data = png.base64_data; image.width = 3; image.height = 2;
        validate_model_image(image);
        validate_model_images({image, fixture_image(true)});
        validate_model_images({});
    });
    test("original four-field ModelMessage aggregate stays valid", [&] {
        const ModelMessage message{"user", "text", {}, {}};
        require(message.images.empty(), "legacy aggregate gained image data");
    });
    test("image context reserve uses pixels, never base64 length", [&] {
        auto image = png;
        require(model_image_context_cost(image) == 2052U, "tiny image cost mismatch");
        image.width = 1280; image.height = 800;
        require(model_image_context_cost(image) == 6048U, "desktop image cost mismatch");
        image.base64_data.assign(1024U * 1024U, 'A');
        require(model_image_context_cost(image) == 6048U, "base64 inflated image tokens");
        image.width = 4096; image.height = 4096;
        require(model_image_context_cost(image) == 67584U, "pixel boundary cost mismatch");
    });
    test("only PNG MIME and inline base64 are accepted", [&] {
        auto image = png; image.mime_type = "image/jpeg";
        rejects([&] { validate_model_image(image); }, "image/png");
        image = png; image.base64_data = "https://example.invalid/private.png";
        rejects([&] { validate_model_image(image); }, "base64");
        image.base64_data = "data:image/png;base64," + png.base64_data;
        rejects([&] { validate_model_image(image); }, "base64");
    });
    test("base64 rejects whitespace, nonalphabet, interior padding and bad length", [&] {
        for (const auto replacement : {'\n', '-', '_', '\0', '=', static_cast<char>(0xff)}) {
            auto image = png; image.base64_data[10] = replacement;
            rejects([&] { validate_model_image(image); }, "base64");
        }
        auto image = png; image.base64_data.pop_back();
        rejects([&] { validate_model_image(image); }, "base64");
        image.base64_data.clear();
        rejects([&] { validate_model_image(image); }, "base64");
    });
    test("base64 rejects noncanonical unused padding bits", [&] {
        auto image = png;
        require(image.base64_data.ends_with("=="), "fixture must have two padding bytes");
        constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        auto& tail = image.base64_data[image.base64_data.size() - 3U];
        tail = alphabet[alphabet.find(tail) + 1U];
        rejects([&] { validate_model_image(image); }, "base64");
        image = fixture_image(false, 101U);
        require(image.base64_data.back() == '=' && !image.base64_data.ends_with("=="), "fixture must have one padding byte");
        auto& second_tail = image.base64_data[image.base64_data.size() - 2U];
        second_tail = alphabet[alphabet.find(second_tail) + 1U];
        rejects([&] { validate_model_image(image); }, "base64");
    });
    test("PNG signature, truncation, CRC and trailing bytes are checked", [&] {
        for (int variation = 0; variation < 4; ++variation) {
            auto bytes = fixture_png();
            if (variation == 0) bytes[0] = 0;
            else if (variation == 1) bytes.resize(24U);
            else if (variation == 2) bytes[29] ^= 1U;
            else bytes.push_back(0);
            auto image = png; image.base64_data = encode64(bytes);
            rejects([&] { validate_model_image(image); }, "PNG");
        }
    });
    test("PNG requires complete IDAT and IEND, not merely an IHDR", [&] {
        auto bytes = fixture_png(); bytes.resize(bytes.size() - 12U);
        auto image = png; image.base64_data = encode64(bytes);
        rejects([&] { validate_model_image(image); }, "IEND");
        bytes = fixture_png(); bytes.erase(bytes.begin() + 33, bytes.end() - 12);
        image.base64_data = encode64(bytes);
        rejects([&] { validate_model_image(image); }, "PNG end");
    });
    test("PNG IHDR bit depth and declared dimensions are checked", [&] {
        auto image = png; image.width = 2;
        rejects([&] { validate_model_image(image); }, "dimensions do not match");
        image = png; image.base64_data = encode64(fixture_png(false, 0, false, 1));
        rejects([&] { validate_model_image(image); }, "IHDR format");
    });
    test("WIC compressed-stream tolerance is recorded without a strict PNG guarantee", [&] {
        auto image = png; image.base64_data = encode64(fixture_png(false, 0, true));
        validate_model_image(image);
        std::cout << "NOTE Windows WIC accepts this checksum-correct PNG with missing pixels; strict compressed-stream conformance is not promised\n";
    });
    test("dimensions reject zero, excessive axes and excessive pixel count", [&] {
        for (const auto dimensions : {std::pair{0U, 2U}, std::pair{3U, 0U}, std::pair{8193U, 1U},
                                      std::pair{1U, 8193U}, std::pair{8192U, 8192U}}) {
            auto image = png; image.width = dimensions.first; image.height = dimensions.second;
            rejects([&] { validate_model_image(image); }, "dimensions");
            rejects([&] { model_image_context_cost(image); }, "dimensions");
        }
    });
    test("exact 5 MiB PNG binary limit is accepted", [&] { validate_model_image(large_image()); });
    test("one byte over PNG binary limit is rejected before decode", [&] {
        const auto image = fixture_image(false, model_image_binary_limit + 1U);
        rejects([&] { validate_model_image(image); }, "exceeds 5 MiB");
    });
    test("encoded image input has a preallocation bound", [&] {
        auto image = png; image.base64_data.assign(((model_image_binary_limit + 2U) / 3U) * 4U + 4U, 'A');
        rejects([&] { validate_model_image(image); }, "base64 size");
    });
    test("image count limit applies to batches and entire requests", [&] {
        rejects([&] { validate_model_images({png, png, png}); }, "Too many model images");
        auto input = history();
        input.push_back({"user", "first", {}, {}, {png, png}});
        input.push_back({"user", "second", {}, {}, {png}});
        rejects([&] { call_model(base, input, definitions()); }, "Too many model images");
    });
    test("images cannot be attached to tool, assistant, system or developer messages", [&] {
        for (const auto* role : {"tool", "assistant", "system", "developer"}) {
            auto input = history(); input.push_back({role, "not a user image", {}, "call", {png}});
            rejects([&] { call_model(base, input, definitions()); }, "require user role");
        }
    });
    test("text keeps its 4 MiB limit even when images are present", [&] {
        auto input = history(); input.push_back({"user", std::string(model_text_body_limit, 'x'), {}, {}, {png}});
        rejects([&] { call_model(base, input, definitions()); }, "size limit");
    });
    test("two individually legal images cannot exceed the 12 MiB request limit", [&] {
        auto input = history(); input.push_back({"user", "two large PNGs", {}, {}, {large_image(), large_image()}});
        rejects([&] { call_model(base, input, definitions()); }, "size limit");
    });
    test("12 MiB base64 alone leaves no space for JSON and is rejected", [&] {
        const auto image = fixture_image(false, model_image_request_limit / 8U * 3U);
        auto input = history(); input.push_back({"user", "boundary", {}, {}, {image, image}});
        require(image.base64_data.size() * 2U == model_image_request_limit, "boundary fixture size mismatch");
        rejects([&] { call_model(base, input, definitions()); }, "size limit");
    });
    test("pre-cancelled image validation and request do not reach networking", [&] {
        std::stop_source source; source.request_stop();
        rejects([&] { validate_model_images({png}, source.get_token()); }, "cancelled");
        auto input = history(); input.push_back({"user", "screen", {}, {}, {png}});
        rejects([&] { call_model(base, input, definitions(), {}, source.get_token()); }, "cancelled");
    });
    test("large image validation responds to cancellation", [&] {
        const auto& image = large_image();
        std::stop_source source;
        const auto start = std::chrono::steady_clock::now();
        std::jthread cancel([&] { std::this_thread::sleep_for(1ms); source.request_stop(); });
        rejects([&] { validate_model_image(image, source.get_token()); }, "cancelled");
        require(std::chrono::steady_clock::now() - start < 1500ms, "image validation cancellation was not prompt");
    });
}

void http_tests(const std::string& base) {
    const auto at = [&](const char* scenario) { return config(base + "/" + scenario + "/v1"); };
    test("fragmented UTF-8 SSE with multiline data, reasoning and indexed tools", [&] {
        std::string text, thinking;
        const auto caller = std::this_thread::get_id();
        auto reply = call_model(at("sse"), history(), definitions(), [&](auto kind, auto value) {
            require(std::this_thread::get_id() == caller, "callback did not run on caller thread");
            (kind == "text" ? text : thinking) += value;
        });
        require(reply.text == "你好🌏" && text == reply.text, "UTF-8 text was not reconstructed");
        require(thinking == "先想🤔", "thinking stream mismatch");
        require(reply.text.find("先想") == std::string::npos, "thinking entered final text");
        require(reply.tool_calls.size() == 2, "tool count mismatch");
        require(reply.tool_calls[0].id == "call_z" && reply.tool_calls[0].name == "other" &&
            reply.tool_calls[0].arguments == "{}", "tool index order mismatch");
        require(reply.tool_calls[1].id == "call_a" && reply.tool_calls[1].name == "search" &&
            reply.tool_calls[1].arguments == "{\"q\":\"猫\"}", "tool fragments mismatch");
        require(reply.input_tokens == 123 && reply.output_tokens == 45, "usage mismatch");
    });
    test("non-streaming JSON fallback", [&] {
        std::string thinking;
        const auto reply = call_model(at("json"), history(), definitions(), [&](auto kind, auto text) {
            if (kind == "thinking") thinking += text;
        });
        require(reply.text == "JSON答复😀" && thinking == "非流式思考", "JSON text mismatch");
        require(reply.tool_calls.size() == 1 && reply.tool_calls[0].id == "json_call", "JSON tool mismatch");
        require(reply.input_tokens == 7 && reply.output_tokens == 4, "JSON usage mismatch");
    });
    test("private Chat DeepSeek dialect disables thinking and sets temperature", [&] {
        auto c = at("chat-sampling");
        c.thinking_enabled = false;
        c.temperature = 0.8;
        require(call_model(c, history(), definitions()).text == "ok", "Chat sampling request failed");
    });
    test("DeepSeek Work returns assistant reasoning with later tool history", [&] {
        auto c = at("work-reasoning");
        c.thinking_enabled = true;
        c.reasoning_effort = "high";
        c.preserve_reasoning_content = true;
        const auto first = call_model(c, history(), definitions());
        require(first.reasoning_content == "非流式思考", "reasoning content was not retained");
        auto follow = history();
        ModelMessage assistant{"assistant", first.text, first.tool_calls, {}};
        assistant.reasoning_content = first.reasoning_content;
        follow.push_back(std::move(assistant));
        follow.push_back({"tool", "new result", {}, "json_call"});
        require(call_model(c, follow, definitions()).text == "JSON答复😀", "reasoning follow-up failed");
    });
    test("full endpoint and query preserved without duplication", [&] {
        auto c = config(base + "/json/v1/chat/completions/?fixture=1");
        require(call_model(c, history(), definitions()).text == "JSON答复😀", "full endpoint failed");
    });
    test("missing usage and finish-reason-only EOF", [&] {
        const auto reply = call_model(at("no-usage"), history(), definitions());
        require(reply.text == "ok" && reply.input_tokens == 0 && reply.output_tokens == 0, "optional usage failed");
    });
    test("Responses SSE with reasoning, tool arguments, completion snapshot", [&] {
        auto c = at("responses-sse"); c.protocol = "responses";
        std::string thinking, text;
        const auto reply = call_model(c, history(), definitions(), [&](auto kind, auto value) {
            (kind == "text" ? text : thinking) += value;
        });
        require(reply.text == "响应🙂" && text == reply.text && thinking == "摘要🧠", "Responses text mismatch");
        require(reply.tool_calls.size() == 1 && reply.tool_calls[0].id == "response_call" &&
            reply.tool_calls[0].name == "search" && reply.tool_calls[0].arguments == "{\"q\":\"猫\"}",
            "Responses tool mismatch");
        require(reply.input_tokens == 8 && reply.output_tokens == 9, "Responses usage mismatch");
    });
    test("Responses non-streaming JSON", [&] {
        auto c = at("responses-json"); c.protocol = "responses";
        std::string thinking;
        const auto reply = call_model(c, history(), definitions(), [&](auto kind, auto text) {
            if (kind == "thinking") thinking += text;
        });
        require(reply.text == "响应🙂" && reply.tool_calls.size() == 1, "Responses JSON mismatch");
        require(thinking == "摘要🧠", "Responses JSON summary missing");
    });
    test("Chat Completions delivers actual PNG pixels in a user data URL", [&] {
        auto input = history(); input.push_back({"user", "Inspect these pixels: 红绿蓝", {}, {}, {fixture_image()}});
        const auto reply = call_model(at("vision-chat"), input, definitions());
        require(reply.text == "JSON答复😀", "Chat vision response mismatch");
    });
    test("Responses delivers input_text and actual PNG input_image pixels", [&] {
        auto c = at("responses-vision"); c.protocol = "responses";
        auto input = history(); input.push_back({"user", "Inspect these pixels: 红绿蓝", {}, {}, {fixture_image()}});
        require(call_model(c, input, definitions()).text == "响应🙂", "Responses vision response mismatch");
    });
    test("image-only user message preserves an empty text part", [&] {
        auto input = history(); input.push_back({"user", "", {}, {}, {fixture_image()}});
        require(call_model(at("vision-empty"), input, definitions()).text == "JSON答复😀", "image-only request failed");
    });
    test("two images across Chat user messages retain order and distinct pixels", [&] {
        auto input = history();
        input.push_back({"user", "first image", {}, {}, {fixture_image()}});
        input.push_back({"user", "second image", {}, {}, {fixture_image(true)}});
        require(call_model(at("vision-two"), input, definitions()).text == "JSON答复😀", "two-image Chat request failed");
    });
    test("two images in one Responses user message retain order and distinct pixels", [&] {
        auto c = at("responses-vision-two"); c.protocol = "responses";
        auto input = history(); input.push_back({"user", "both images", {}, {}, {fixture_image(), fixture_image(true)}});
        require(call_model(c, input, definitions()).text == "响应🙂", "two-image Responses request failed");
    });
    for (const bool responses : {false, true}) {
        test(responses ? "Responses accepts a 5 MiB PNG and body above 4 MiB" :
                         "Chat accepts a 5 MiB PNG and body above 4 MiB", [&] {
            auto c = at(responses ? "responses-vision-large" : "vision-large");
            if (responses) c.protocol = "responses";
            auto input = history(); input.push_back({"user", "large PNG", {}, {}, {large_image()}});
            const auto reply = call_model(c, input, definitions());
            require(reply.text == (responses ? "响应🙂" : "JSON答复😀"), "large PNG request failed");
        });
    }
    test("two 4 MiB PNGs fit the independent 12 MiB wire-body bound", [&] {
        auto input = history(); input.push_back({"user", "two padded PNGs", {}, {},
            {fixture_image(false, 4U * 1024U * 1024U), fixture_image(true, 4U * 1024U * 1024U)}});
        require(call_model(at("vision-near-limit"), input, definitions()).text == "JSON答复😀", "large two-image request failed");
    });
    test("image request does not increase the 4 MiB response limit", [&] {
        auto input = history(); input.push_back({"user", "screen", {}, {}, {fixture_image()}});
        rejects([&] { call_model(at("vision-huge-json"), input, definitions()); }, "size limit");
    });
    for (const bool responses : {false, true}) {
        test(responses ? "cancel Responses image body wait promptly" : "cancel Chat image header wait promptly", [&] {
            auto c = at(responses ? "responses-vision-slow-body" : "vision-slow-headers");
            if (responses) c.protocol = "responses";
            c.timeout_ms = 10000;
            auto input = history(); input.push_back({"user", "screen", {}, {}, {fixture_image()}});
            std::stop_source source;
            const auto start = std::chrono::steady_clock::now();
            std::jthread cancel([&] { std::this_thread::sleep_for(100ms); source.request_stop(); });
            rejects([&] { call_model(c, input, definitions(), {}, source.get_token()); }, "cancelled");
            require(std::chrono::steady_clock::now() - start < 1500ms, "vision cancellation was not prompt");
        });
    }
    test("cancel large image request while the server pauses reads", [&] {
        auto c = at("vision-stalled-upload"); c.timeout_ms = 10000;
        auto input = history(); input.push_back({"user", "large PNG", {}, {}, {large_image()}});
        std::stop_source source;
        const auto start = std::chrono::steady_clock::now();
        std::jthread cancel([&] { std::this_thread::sleep_for(500ms); source.request_stop(); });
        rejects([&] { call_model(c, input, definitions(), {}, source.get_token()); }, "cancelled");
        require(std::chrono::steady_clock::now() - start < 2000ms, "upload cancellation was not prompt");
    });
    const auto work_at = [&](const char* scenario) {
        auto c = at(scenario);
        c.payload_limits = work_model_payload_limits;
        c.timeout_ms = 15000;
        c.idle_timeout_ms = 5000;
        c.connect_timeout_ms = 1000;
        if (std::string_view(scenario).starts_with("responses-")) c.protocol = "responses";
        return c;
    };
    for (const auto* scenario : {"work-request", "responses-work-request", "work-escaped-request"}) {
        test(scenario, [&] {
            const bool escaped = std::string_view(scenario) == "work-escaped-request";
            auto input = history(); input.front().content.assign((escaped ? 1U : 5U) * 1024U * 1024U, escaped ? '\1' : 'Q');
            const auto c = work_at(scenario);
            require(!call_model(c, input, definitions()).text.empty(), "Large Work request failed");
            auto chat = c; chat.payload_limits = {};
            rejects([&] { call_model(chat, input, definitions()); }, "Model text request exceeds size limit");
        });
    }
    test("Work text and two maximum PNGs exceed old image body budget", [&] {
        auto input = history(); input.front().content.assign(5U * 1024U * 1024U, 'Q');
        input.push_back({"user", "Two independent images", {}, {},
            {large_image(), fixture_image(true, model_image_binary_limit)}});
        require(call_model(work_at("work-vision-two"), input, definitions()).text == "JSON答复😀",
            "Large Work image body failed");
    });
    test("Work wire overhead does not consume decoded output allowance", [&] {
        auto c = work_at("work-wire-overhead"); c.payload_limits.output_bytes = 2;
        require(call_model(c, history(), definitions()).text == "ok", "SSE framing consumed output allowance");
    });
    for (const auto* scenario : {"work-large-stream", "responses-work-large-stream"}) {
        test(scenario, [&] {
            std::size_t thinking = 0, text = 0;
            const auto reply = call_model(work_at(scenario), history(), definitions(), [&](auto kind, auto value) {
                (kind == "thinking" ? thinking : text) += value.size();
                require(!value.empty() && value.front() == (kind == "thinking" ? 'T' : 'R'), "Large stream content changed");
            });
            require(thinking == 5U * 1024U * 1024U && text == thinking, "Large thinking/text count mismatch");
            require(reply.text == std::string(text, 'R'), "Large reply truncated or thinking leaked into text");
        });
    }
    for (const auto* scenario : {"work-large-json", "responses-work-large-json"}) {
        test(scenario, [&] {
            require(call_model(work_at(scenario), history(), definitions()).text == std::string(5U * 1024U * 1024U, 'J'),
                "Explicit large JSON parse budget was not used");
        });
    }
    for (const auto* scenario : {"work-large-tools", "responses-work-large-tools"}) {
        test(scenario, [&] {
            auto c = work_at(scenario); c.payload_limits.output_bytes = 6U * 1024U * 1024U;
            const auto reply = call_model(c, history(), definitions());
            require(reply.tool_calls.size() == 1 && reply.tool_calls[0].name == "search", "Large tool lost metadata");
            require(reply.tool_calls[0].arguments == "{\"q\":\"" + std::string(5U * 1024U * 1024U, 'A') + "\"}",
                "Large tool parse failed or snapshot charged twice");
        });
    }
    for (const auto* scenario : {"work-output-bound", "work-tool-bound"}) {
        test(scenario, [&] {
            auto c = work_at(scenario); c.payload_limits.output_bytes = 1024U * 1024U;
            rejects([&] { call_model(c, history(), definitions()); }, "Model decoded output exceeds size limit");
        });
    }
    test("Work configurable SSE line bound is independent", [&] {
        auto c = work_at("work-line-bound"); c.payload_limits.sse_line_bytes = 1024U * 1024U;
        rejects([&] { call_model(c, history(), definitions()); }, "Model SSE line exceeds size limit");
    });
    test("Work configurable SSE event bound is independent", [&] {
        auto c = work_at("work-event-bound"); c.payload_limits.sse_event_bytes = 1024U * 1024U;
        rejects([&] { call_model(c, history(), definitions()); }, "Model SSE event exceeds size limit");
    });
    test("Work configurable wire bound is independent", [&] {
        auto c = work_at("work-wire-bound"); c.payload_limits.response_bytes = 1024U * 1024U;
        rejects([&] { call_model(c, history(), definitions()); }, "Model response transport exceeds size limit");
    });
    test("Work stream can cancel after more than 4 MiB was read", [&] {
        std::stop_source source;
        bool callback = false;
        const auto start = std::chrono::steady_clock::now();
        rejects([&] { call_model(work_at("work-cancel-stream"), history(), definitions(), [&](auto kind, auto value) {
            require(kind == "text" && value == "ok", "Large stream never reached its final marker");
            callback = true;
            source.request_stop();
        }, source.get_token()); }, "cancelled");
        require(callback && std::chrono::steady_clock::now() - start < 5000ms, "Large Work stream did not cancel promptly");
    });
    for (const auto* scenario : {"context-code", "context-message", "context-413", "context-json", "context-sse", "responses-context-sse"}) {
        test(scenario, [&] {
            auto c = at(scenario);
            if (std::string_view(scenario).starts_with("responses-")) c.protocol = "responses";
            try { (void)call_model(c, history(), definitions()); }
            catch (const ModelError& error) {
                require(error.kind() == ModelFailure::ContextWindowExceeded, "Explicit context overflow was not typed");
                require(!error.may_upgrade(), "Context overflow must use bounded compaction, not route upgrades");
                require(std::string_view(error.what()).find(fixture_key) == std::string_view::npos, "Context error leaked provider data");
                return;
            }
            throw std::runtime_error("Explicit context overflow did not fail");
        });
    }
    for (const auto* scenario : {"generic-400", "generic-413", "malformed-400", "large-error-400", "negative-context-400"}) {
        test(scenario, [&] {
            try { (void)call_model(at(scenario), history(), definitions()); }
            catch (const ModelError& error) {
                require(error.kind() == ModelFailure::Http, "Ordinary HTTP error incorrectly requested compaction");
                require(!error.may_upgrade(), "Invalid requests must not switch routes");
                return;
            }
            throw std::runtime_error("Expected ordinary HTTP error");
        });
    }
    test("HTTP status errors do not echo body or key", [&] {
        rejects([&] { call_model(at("http-error"), history(), definitions()); }, "HTTP error 401");
    });
    test("cross-origin redirect refused", [&] {
        rejects([&] { call_model(at("redirect"), history(), definitions()); }, "redirect refused");
    });
    test("same-origin redirect refused", [&] {
        rejects([&] { call_model(at("redirect-same"), history(), definitions()); }, "redirect refused");
    });
    test("SSE provider error is redacted", [&] {
        rejects([&] { call_model(at("provider-error"), history(), definitions()); }, "provider returned");
    });
    test("invalid JSON is redacted", [&] {
        rejects([&] { call_model(at("invalid-json"), history(), definitions()); }, "JSON error");
    });
    test("truncated stream refused", [&] {
        rejects([&] { call_model(at("truncated"), history(), definitions()); }, "before a complete");
    });
    for (const auto* scenario : {"chat-output-limit", "chat-output-limit-json", "responses-output-limit", "responses-output-limit-sse"}) {
        test(scenario, [&] {
            auto c = at(scenario);
            if (std::string_view(scenario).starts_with("responses-")) c.protocol = "responses";
            try { (void)call_model(c, history(), definitions()); }
            catch (const ModelError& error) {
                require(error.kind() == ModelFailure::OutputLimit, "Output truncation must have a typed recovery category");
                require(!error.may_upgrade(), "Output limit must not bypass configured budgets by switching routes");
                return;
            }
            throw std::runtime_error("Truncated model text/tool batch was returned as a complete reply");
        });
    }
    test("incomplete tool arguments refused", [&] {
        rejects([&] { call_model(at("invalid-tool"), history(), definitions()); }, "JSON error");
    });
    test("SSE line bound", [&] {
        rejects([&] { call_model(at("huge-line"), history(), definitions()); }, "SSE line exceeds");
    });
    test("SSE total body bound", [&] {
        rejects([&] { call_model(at("huge-body"), history(), definitions()); }, "size limit");
    });
    test("SSE multiline event bound", [&] {
        rejects([&] { call_model(at("huge-event"), history(), definitions()); }, "size limit");
    });
    test("incomplete Responses result refused", [&] {
        auto c = at("responses-incomplete"); c.protocol = "responses";
        rejects([&] { call_model(c, history(), definitions()); }, "did not complete");
    });
    test("JSON total body bound", [&] {
        rejects([&] { call_model(at("huge-json"), history(), definitions()); }, "size limit");
    });
    test("unexpected content type refused", [&] {
        rejects([&] { call_model(at("html"), history(), definitions()); }, "content type");
    });
    test("timeout while waiting for headers", [&] {
        auto c = at("slow-headers"); c.timeout_ms = 150;
        const auto start = std::chrono::steady_clock::now();
        rejects([&] { call_model(c, history(), definitions()); }, "timed out");
        require(std::chrono::steady_clock::now() - start < 1500ms, "header timeout was not prompt");
    });
    test("total timeout while body is stalled", [&] {
        auto c = at("slow-body"); c.timeout_ms = 150;
        rejects([&] { call_model(c, history(), definitions()); }, "timed out");
    });
    for (const auto* scenario : {"slow-headers", "slow-body"}) {
        test(scenario == std::string_view("slow-headers") ? "independent header idle timeout" : "independent response idle timeout", [&] {
            auto c = work_at(scenario); c.timeout_ms = 5000; c.idle_timeout_ms = 120;
            const auto start = std::chrono::steady_clock::now();
            rejects([&] { call_model(c, history(), definitions()); }, "timed out");
            require(std::chrono::steady_clock::now() - start < 1500ms, "Idle timeout waited for total deadline");
        });
    }
    test("network progress refreshes idle budget but not total deadline", [&] {
        auto c = work_at("trickle"); c.timeout_ms = 320; c.idle_timeout_ms = 100;
        const auto start = std::chrono::steady_clock::now();
        rejects([&] { call_model(c, history(), definitions()); }, "timed out");
        const auto elapsed = std::chrono::steady_clock::now() - start;
        require(elapsed >= 250ms && elapsed < 1500ms, "Idle progress or absolute deadline was not respected");
    });
    test("total deadline survives continuously arriving heartbeats", [&] {
        auto c = at("trickle"); c.timeout_ms = 180;
        const auto start = std::chrono::steady_clock::now();
        rejects([&] { call_model(c, history(), definitions()); }, "timed out");
        require(std::chrono::steady_clock::now() - start < 1500ms, "heartbeats reset the deadline");
    });
    for (const char* scenario : {"slow-headers", "slow-body"}) {
        test(scenario == std::string_view("slow-headers") ? "cancel header wait promptly" : "cancel body wait promptly", [&] {
            auto c = at(scenario); c.timeout_ms = 10000;
            std::stop_source source;
            const auto start = std::chrono::steady_clock::now();
            std::jthread cancel([&] { std::this_thread::sleep_for(80ms); source.request_stop(); });
            rejects([&] { call_model(c, history(), definitions(), {}, source.get_token()); }, "cancelled");
            require(std::chrono::steady_clock::now() - start < 1500ms, "cancellation was not prompt");
        });
    }
    test("callback exception type preserved and network cleaned up", [&] {
        struct CallbackFailure {};
        bool caught = false;
        try {
            call_model(at("callback"), history(), definitions(), [](auto, auto) { throw CallbackFailure{}; });
        } catch (const CallbackFailure&) { caught = true; }
        require(caught, "callback exception was replaced");
        require(call_model(at("json"), history(), definitions()).text == "JSON答复😀", "subsequent request failed");
    });
    test("callback can cancel its request", [&] {
        std::stop_source source;
        rejects([&] { call_model(at("callback"), history(), definitions(), [&](auto, auto) {
            source.request_stop();
        }, source.get_token()); }, "cancelled");
    });
    test("peer disconnect releases request", [&] {
        rejects([&] { call_model(at("disconnect"), history(), definitions()); }, "network error");
    });
}
} // namespace

int main(int argc, char** argv) {
    offline_tests();
    image_tests();
    if (argc > 1 && std::string_view(argv[1]).starts_with("http://127.0.0.1:")) http_tests(argv[1]);
    std::cout << "MODEL_TEST_RESULT passed=" << passed << " failed=" << failed << '\n';
    return failed ? 1 : 0;
}
