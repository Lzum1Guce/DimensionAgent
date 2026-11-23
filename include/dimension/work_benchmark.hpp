#pragma once
#include "dimension/model.hpp"
#include <chrono>
#include <mutex>

namespace dimension {
// Each entry contains the mean score and competition rank among complete rows in the same release.
Json parse_livebench_scores(const Json& categories,const std::string& csv);
class WorkBenchmark {
    std::mutex mutex_;
    std::chrono::steady_clock::time_point retry_{};
    bool loading_{};
    Json snapshot_;
public:
    Json get(std::stop_token stop = {});
};
}
