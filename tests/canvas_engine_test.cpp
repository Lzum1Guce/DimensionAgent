#include "dimension/canvas_engine.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using namespace dimension;

namespace {

int g_checks = 0;

void check(bool ok, const char* msg) {
    if (!ok) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
    ++g_checks;
}

Json wait_run_status(CanvasRuntimeService& svc, const std::string& run_id,
                     const std::vector<std::string>& targets, int timeout_ms = 10000) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto st = svc.get_run(run_id);
        const std::string s = st.at("status").as_string();
        for (const auto& t : targets) {
            if (s == t) return st;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return svc.get_run(run_id);
}

} // namespace

int main(int argc, char** argv) {
    const fs::path test_root = argc > 1 ? fs::path(argv[1]) : (fs::temp_directory_path() / "dim_canvas_engine_test");
    std::error_code ec;
    fs::remove_all(test_root, ec);
    fs::create_directories(test_root, ec);

    // 1. Edge-attachment parallel supplement rule (A -> B, with C attached onto edge A->B, and E attached onto C's edge)
    {
        CanvasGraph g;
        g.id = "test-edge-attach";
        g.name = "Edge Attachment Semantics";
        g.nodes = {
            CanvasNode{.id = "in", .type = "input", .title = "委托入口"},
            CanvasNode{.id = "A", .type = "agent", .title = "主方案A"},
            CanvasNode{.id = "C", .type = "agent", .title = "补充调研C"},
            CanvasNode{.id = "E", .type = "reference", .title = "补充红线E.txt", .ref_mode = "text", .ref_text = "禁止硬编码密钥"},
            CanvasNode{.id = "B", .type = "agent", .title = "终案汇总B", .prompt = "合并主干与补充产出最终方案"}
        };
        g.edges = {
            CanvasEdge{"e_in_a", "in", "out", "node", "A", 0.5, "main", ""},
            CanvasEdge{"e_in_c", "in", "out", "node", "C", 0.5, "main", ""},
            CanvasEdge{"e_ab", "A", "out", "node", "B", 0.5, "main", "主干"},
            CanvasEdge{"e_c_ab", "C", "out", "edge", "e_ab", 0.5, "supplement", "补充A"},
            CanvasEdge{"e_e_c", "E", "out", "edge", "e_c_ab", 0.4, "supplement", "补充C"}
        };

        const auto v = validate_canvas_graph(g);
        check(v.ok, "valid recursive edge-attached graph passes validation");
        check(resolve_edge_host_node(g, "e_c_ab") == "B", "edge attached to A->B resolves host node B");
        check(resolve_edge_host_node(g, "e_e_c") == "B", "nested edge attached to C->(A->B) resolves host node B");

        const auto deps = collect_forward_dependencies(g, "B");
        check(deps.size() == 3 &&
              std::find(deps.begin(), deps.end(), "A") != deps.end() &&
              std::find(deps.begin(), deps.end(), "C") != deps.end() &&
              std::find(deps.begin(), deps.end(), "E") != deps.end(),
              "B depends on primary A plus all parallel edge-attached supplements C and E");

        std::map<std::string, std::string> outs{
            {"A", "主方案正文_ALPHA"},
            {"C", "风险补充正文_CHARLIE"},
            {"E", "禁止硬编码密钥"}
        };
        const std::string ctx_b = assemble_canvas_node_context(g, "B", "做一个高性能缓存", outs);
        auto scoped = g;
        scoped.nodes.back().context_mode = "full_chain";
        scoped.nodes.push_back(CanvasNode{.id="other", .type="agent"});
        auto values = outs;
        values["other"] = "UNRELATED_BRANCH";
        values["in"] = "EARLY_ANCESTOR";
        const auto history = assemble_canvas_node_context(scoped, "B", "request", values);
        check(history.find("EARLY_ANCESTOR") != std::string::npos &&
              history.find("UNRELATED_BRANCH") == std::string::npos, "full chain includes only ancestors");
        scoped.nodes.back().prompt = "{{input}} / {{node:A}}";
        scoped.nodes.back().context_mode = "template_only";
        values["A"] = "{{node:C}}";
        check(assemble_canvas_node_context(scoped, "other", "{{prev}}", values) == "{{prev}} / {{node:C}}",
              "substituted member outputs and input stay literal");
        const auto pos_a = ctx_b.find("主方案正文_ALPHA");
        const auto pos_c_hdr = ctx_b.find("针对「主方案A」的并行补充信息");
        const auto pos_c = ctx_b.find("风险补充正文_CHARLIE");
        const auto pos_e_hdr = ctx_b.find("针对「补充调研C」的并行补充信息");
        check(pos_a != std::string::npos && pos_c_hdr != std::string::npos &&
              pos_c != std::string::npos && pos_e_hdr != std::string::npos &&
              pos_a < pos_c_hdr && pos_c_hdr < pos_c && pos_c < pos_e_hdr,
              "assembled context strictly nests C under A and E under C in exact wire hierarchy");

        // Forward cycle must be rejected
        CanvasGraph bad = g;
        bad.edges.push_back(CanvasEdge{"e_bad_cycle", "B", "out", "node", "A", 0.5, "main", ""});
        check(!validate_canvas_graph(bad).ok, "forward cycle without feedback wire is rejected");

        // Feedback edge back to upstream must be accepted
        CanvasGraph good_fb = g;
        good_fb.edges.push_back(CanvasEdge{"e_good_fb", "B", "loop", "node", "A", 0.5, "feedback", "返工"});
        check(validate_canvas_graph(good_fb).ok, "explicit feedback wire back to upstream is accepted");
    }

    // 2. Runtime: Parallel execution of A & C, automatic feedback loop, circuit breaker fuse, and .txt file reference
    {
        const fs::path ref_file = test_root / "spec.txt";
        {
            std::ofstream fout(ref_file, std::ios::binary);
            fout << "规范条目一：所有接口返回 JSON。\n" << std::string(1200, 'Z');
        }

        std::mutex log_mu;
        std::atomic<int> in_flight_ac{0};
        std::atomic<int> max_parallel_ac{0};
        std::map<std::string, int> call_counts;
        std::string captured_b_prompt;
        std::string captured_code_iter2_prompt;

        CanvasRuntimeService svc(
            test_root / "data_loop",
            [&](const CanvasNodeExecRequest& req, const std::function<void(std::string_view)>&, std::stop_token) -> CanvasNodeExecResult {
                CanvasNodeExecResult r;
                r.ok = true;
                r.model_label = "mock-model";
                {
                    std::lock_guard lk(log_mu);
                    call_counts[req.node.id]++;
                }
                if (req.node.id == "A" || req.node.id == "C") {
                    const int cur = ++in_flight_ac;
                    int prev = max_parallel_ac.load();
                    while (cur > prev && !max_parallel_ac.compare_exchange_weak(prev, cur)) {}
                    std::this_thread::sleep_for(std::chrono::milliseconds(80));
                    --in_flight_ac;
                    r.output = (req.node.id == "A") ? "主稿A内容" : "并行补充C内容";
                } else if (req.node.id == "B") {
                    captured_b_prompt = req.assembled_prompt;
                    r.output = "终案B完成";
                } else if (req.node.id == "code") {
                    if (req.iteration == 2) captured_code_iter2_prompt = req.assembled_prompt;
                    r.output = "CODE_V" + std::to_string(req.iteration);
                    r.artifacts = {"src/demo.cpp"};
                } else if (req.node.id == "review") {
                    // Fail on iteration 1, pass on iteration 2!
                    r.output = (req.iteration == 1) ? "[FAIL] 缺少超时重试逻辑" : "[PASS] 逻辑完备验收通过";
                } else if (req.node.id == "always_fail_review") {
                    r.output = "[FAIL] 依然不达标";
                } else {
                    r.output = "DONE:" + req.node.id;
                }
                return r;
            });

        // 2a. Verify builtin templates & functions are seeded
        const auto lib = svc.list_library();
        check(lib.at("canvases").as_array().size() >= 3 && lib.at("functions").as_array().size() >= 2,
              "builtin circuit templates and UE blueprint functions are seeded automatically");

        // 2b. Parallel A & C + .txt file truncation guard feeding B
        CanvasGraph par_g;
        par_g.id = "par-test";
        par_g.name = "并行补充测试";
        par_g.nodes = {
            CanvasNode{.id = "in", .type = "input", .title = "起点"},
            CanvasNode{.id = "A", .type = "agent", .title = "主干A"},
            CanvasNode{.id = "C", .type = "agent", .title = "补充C"},
            CanvasNode{.id = "R", .type = "reference", .title = "spec.txt", .ref_mode = "file", .file_path = ref_file.string(), .max_inline_chars = 600},
            CanvasNode{.id = "B", .type = "agent", .title = "接收B"}
        };
        par_g.edges = {
            CanvasEdge{"e1", "in", "out", "node", "A", 0.5, "main", ""},
            CanvasEdge{"e2", "in", "out", "node", "C", 0.5, "main", ""},
            CanvasEdge{"e3", "A", "out", "node", "B", 0.5, "main", ""},
            CanvasEdge{"e4", "C", "out", "edge", "e3", 0.4, "supplement", ""},
            CanvasEdge{"e5", "R", "out", "edge", "e3", 0.7, "supplement", ""}
        };
        (void)svc.save_graph(par_g);

        const auto run1 = svc.start_run({"par-test", "构建订单服务", "", ""});
        const auto end1 = wait_run_status(svc, run1.at("runId").as_string(), {"completed", "failed"});
        check(end1.at("status").as_string() == "completed", "parallel edge-supplement circuit completed cleanly");
        check(max_parallel_ac.load() >= 2, "A and edge-attached supplement C genuinely executed in parallel");
        check(captured_b_prompt.find("主稿A内容") != std::string::npos &&
              captured_b_prompt.find("并行补充C内容") != std::string::npos &&
              captured_b_prompt.find("规范条目一") != std::string::npos &&
              captured_b_prompt.find("资料防爆提示") != std::string::npos,
              "B received A, parallel C, and bounded .txt file with overflow guard notice");

        // 2c. Automatic feedback loop (iter 1 FAIL -> loops back to code -> iter 2 PASS -> ship)
        CanvasGraph loop_g;
        loop_g.id = "auto-loop-test";
        loop_g.name = "自动闭环测试";
        loop_g.nodes = {
            CanvasNode{.id = "in", .type = "input", .title = "需求"},
            CanvasNode{.id = "code", .type = "agent", .title = "编码"},
            CanvasNode{.id = "review", .type = "agent", .title = "审校"},
            CanvasNode{.id = "gate", .type = "gate", .title = "自动门", .gate_mode = "auto_condition", .pass_keyword = "PASS", .fail_keyword = "FAIL", .max_iterations = 3},
            CanvasNode{.id = "ship", .type = "agent", .title = "发布"}
        };
        loop_g.edges = {
            CanvasEdge{"l1", "in", "out", "node", "code", 0.5, "main", ""},
            CanvasEdge{"l2", "code", "out", "node", "review", 0.5, "main", ""},
            CanvasEdge{"l3", "review", "out", "node", "gate", 0.5, "main", ""},
            CanvasEdge{"l4", "gate", "loop", "node", "code", 0.5, "feedback", "打回修复"},
            CanvasEdge{"l5", "gate", "pass", "node", "ship", 0.5, "main", "放行"}
        };
        (void)svc.save_graph(loop_g);

        const auto run2 = svc.start_run({"auto-loop-test", "实现重试队列", "", ""});
        const auto end2 = wait_run_status(svc, run2.at("runId").as_string(), {"completed", "failed"});
        check(end2.at("status").as_string() == "completed", "auto feedback loop converged and completed");
        check(call_counts["code"] == 2 && call_counts["review"] == 2 && call_counts["ship"] == 1,
              "code & review ran twice via feedback wire, ship ran once after PASS");
        check(captured_code_iter2_prompt.find("CODE_V1") != std::string::npos &&
              captured_code_iter2_prompt.find("缺少超时重试逻辑") != std::string::npos,
              "iteration 2 received prior self output and rejection feedback note");

        // 2d. Circuit breaker fuse test: always FAIL stops cleanly after maxIterations = 2
        CanvasGraph fuse_g;
        fuse_g.id = "fuse-test";
        fuse_g.name = "熔断保护测试";
        fuse_g.nodes = {
            CanvasNode{.id = "in", .type = "input", .title = "需求"},
            CanvasNode{.id = "always_fail_review", .type = "agent", .title = "严格审校"},
            CanvasNode{.id = "gate", .type = "gate", .title = "熔断门", .gate_mode = "auto_condition", .pass_keyword = "PASS", .fail_keyword = "FAIL", .max_iterations = 2},
            CanvasNode{.id = "after_fuse", .type = "agent", .title = "收尾"}
        };
        fuse_g.edges = {
            CanvasEdge{"f1", "in", "out", "node", "always_fail_review", 0.5, "main", ""},
            CanvasEdge{"f2", "always_fail_review", "out", "node", "gate", 0.5, "main", ""},
            CanvasEdge{"f3", "gate", "loop", "node", "always_fail_review", 0.5, "feedback", ""},
            CanvasEdge{"f4", "gate", "pass", "node", "after_fuse", 0.5, "main", ""}
        };
        (void)svc.save_graph(fuse_g);

        const auto run_fuse = svc.start_run({"fuse-test", "测试熔断", "", ""});
        const auto end_fuse = wait_run_status(svc, run_fuse.at("runId").as_string(), {"completed", "failed"});
        check(end_fuse.at("status").as_string() == "completed" &&
              call_counts["always_fail_review"] == 3 && // initial + 2 feedback loops
              call_counts["after_fuse"] == 1,
              "circuit breaker trips cleanly after maxIterations=2 loops and releases safely");
        fuse_g.id = "final-gate";
        fuse_g.nodes[2].require_pass = true;
        (void)svc.save_graph(fuse_g);
        const auto strict_run = svc.start_run({fuse_g.id, "test", "", ""});
        const auto stopped = wait_run_status(svc, strict_run.at("runId").as_string(), {"completed","failed"});
        check(stopped.at("status").as_string() == "failed" && call_counts["always_fail_review"] == 6 &&
              call_counts["after_fuse"] == 1, "final gate blocks delivery after exhausting rework");
        CanvasGraph verdict;
        verdict.id = "verdict"; verdict.name = "verdict";
        verdict.nodes = {CanvasNode{.id="input", .type="input"}, fuse_g.nodes[2]};
        verdict.edges = {CanvasEdge{"verdict-in", "input", "out", "node", "gate", 0.5, "main", ""}};
        (void)svc.save_graph(verdict);
        for (const auto& [text, expected] : std::vector<std::pair<std::string,std::string>>{
                 {"NOT PASS", "failed"}, {"PASS succeeded?", "failed"}, {"report\n PASS \n", "completed"}}) {
            const auto run = svc.start_run({verdict.id, text, "", ""});
            check(wait_run_status(svc, run.at("runId").as_string(), {"completed","failed"}).at("status").as_string()
                  == expected, "final gate requires an explicit last-line verdict");
        }
    }

    // 3. Human approval gate (reject -> loop -> approve with note) + UE Blueprint Collapse to Function
    {
        std::string draft_iter2_prompt;
        std::string post_fn_prompt;

        CanvasRuntimeService svc(
            test_root / "data_bp",
            [&](const CanvasNodeExecRequest& req, const std::function<void(std::string_view)>&, std::stop_token) -> CanvasNodeExecResult {
                CanvasNodeExecResult r;
                r.ok = true;
                if (req.node.id == "draft") {
                    if (req.iteration == 2) draft_iter2_prompt = req.assembled_prompt;
                    r.output = "DRAFT_V" + std::to_string(req.iteration);
                } else if (req.node.id == "polish") {
                    r.output = "POLISHED(" + req.assembled_prompt.substr(0, std::min<std::size_t>(req.assembled_prompt.size(), 80)) + ")";
                } else if (req.node.id == "final") {
                    post_fn_prompt = req.assembled_prompt;
                    r.output = "FINAL_SHIPPED";
                } else {
                    r.output = "OUT_" + req.node.id;
                }
                return r;
            });

        CanvasGraph g;
        g.id = "bp-source";
        g.name = "蓝图折叠测试画布";
        g.nodes = {
            CanvasNode{.id = "in", .type = "input", .title = "入口"},
            CanvasNode{.id = "draft", .type = "agent", .title = "初稿", .bot_mode = "inline", .inline_name = "临时写手"},
            CanvasNode{.id = "approve", .type = "gate", .title = "人工审批", .gate_mode = "approval", .max_iterations = 4},
            CanvasNode{.id = "polish", .type = "agent", .title = "润色"},
            CanvasNode{.id = "final", .type = "agent", .title = "归档"}
        };
        g.edges = {
            CanvasEdge{"b1", "in", "out", "node", "draft", 0.5, "main", ""},
            CanvasEdge{"b2", "draft", "out", "node", "approve", 0.5, "main", ""},
            CanvasEdge{"b3", "approve", "loop", "node", "draft", 0.5, "feedback", "驳回"},
            CanvasEdge{"b4", "approve", "pass", "node", "polish", 0.5, "main", "通过"},
            CanvasEdge{"b5", "polish", "out", "node", "final", 0.5, "main", ""}
        };
        (void)svc.save_graph(g);

        // Collapse [draft, approve, polish] into a reusable UE Blueprint Function chip!
        const auto collapsed = svc.collapse_to_function("bp-source", {"draft", "approve", "polish"}, "写作审批芯片", "封装写稿-审批-润色");
        check(collapsed.created_function.kind == "function", "collapsed subgraph saved as blueprint function");
        check(collapsed.updated_canvas.nodes.size() == 3, "parent canvas collapsed 3 nodes into 1 function_call chip (in + chip + final)");
        check(!collapsed.chip_node_id.empty(), "chip node ID returned");

        // Run the parent canvas -> wait for nested approval gate inside the UE Blueprint Function!
        const auto r = svc.start_run({"bp-source", "写一篇发布公告", "", ""});
        const std::string run_id = r.at("runId").as_string();
        const auto w1 = wait_run_status(svc, run_id, {"waiting_approval", "failed", "completed"});
        check(w1.at("status").as_string() == "waiting_approval", "nested approval gate inside blueprint function pauses circuit cleanly");
        const auto& gates1 = w1.at("waitingGates").as_array();
        check(gates1.size() == 1, "exactly one nested gate reported in waitingGates");
        const std::string gate_key = gates1[0].at("key").as_string();
        check(gate_key == (collapsed.chip_node_id + "::approve"), "nested gate key includes function chip frame prefix");

        // Reject first -> verify draft reruns with rejection comment inside the function!
        (void)svc.decide_gate(run_id, gate_key, false, "语气再活泼一点");
        const auto w2 = wait_run_status(svc, run_id, {"waiting_approval", "failed", "completed"});
        check(w2.at("status").as_string() == "waiting_approval", "rejected nested gate looped back and reached approval again");
        check(draft_iter2_prompt.find("语气再活泼一点") != std::string::npos &&
              draft_iter2_prompt.find("DRAFT_V1") != std::string::npos,
              "nested function draft node received rejection feedback & prior draft");

        // Approve with pass comment -> circuit finishes cleanly!
        (void)svc.decide_gate(run_id, gate_key, true, "准许发布");
        const auto done = wait_run_status(svc, run_id, {"completed", "failed"});
        check(done.at("status").as_string() == "completed", "blueprint function completed and handed off to final node");
        check(done.at("gateReviews").as_number() == 2 && done.at("gateRejections").as_number() == 1,
              "human review counters include the rejection and its successful retry");
        check(done.at("finalOutput").as_string() == "FINAL_SHIPPED", "parent final node produced terminal delivery");
        check(post_fn_prompt.find("POLISHED(") != std::string::npos, "parent final node received output from collapsed blueprint function chip");
    }

    for (bool feedback : {false, true}) {
        CanvasRuntimeService service(test_root / (feedback ? "limit" : "no-loop"), {});
        CanvasGraph graph;
        graph.id = "human-gate";
        graph.name = "Approval";
        graph.nodes = {
            CanvasNode{.id="in", .type="input"},
            CanvasNode{.id="draft", .type="reference", .ref_mode="text", .ref_text="draft"},
            CanvasNode{.id="gate", .type="gate", .gate_mode="approval", .max_iterations=1},
            CanvasNode{.id="after", .type="reference", .ref_mode="text", .ref_text="approved"}
        };
        graph.edges = {
            CanvasEdge{"e1","in","out","node","draft",0.5,"main",""},
            CanvasEdge{"e2","draft","out","node","gate",0.5,"main",""},
            CanvasEdge{"e3","gate","pass","node","after",0.5,"main",""}
        };
        if (feedback) graph.edges.push_back(CanvasEdge{"redo","gate","loop","node","draft",0.5,"feedback",""});
        service.save_graph(graph);
        CanvasRunStartRequest request{graph.id, "fixture", "", "", "same-request"};
        const auto id = service.start_run(request).at("runId").as_string();
        check(service.start_run(request).at("runId").as_string() == id, "start retry returns original run");
        for (int i = 0; i < (feedback ? 2 : 1); ++i) {
            const auto waiting = wait_run_status(service, id, {"waiting_approval", "failed"});
            check(waiting.at("status").as_string() == "waiting_approval", "human approval requested");
            service.decide_gate(id, "gate", false, "redo");
        }
        const auto run = wait_run_status(service, id, {"failed","completed"});
        check(run.at("status").as_string() == "failed", "rejection with no remaining feedback stops the run");
        check(run.at("nodes").at("after").at("iteration").as_number() == 0, "rejection never dispatches downstream");
    }

    // 7. DimensionImage practical action step ("read_file" dir & file + "open_app" / "fetch_url" dispatch)
    {
        const fs::path act_dir = test_root / "action_sample_dir";
        fs::create_directories(act_dir, ec);
        {
            std::ofstream f(act_dir / "readme_notes.txt", std::ios::binary);
            f << "DimensionImage 动作读取测试正文: 预算控制与目录扫描";
        }
        CanvasGraph ag;
        ag.id = "action-flow";
        ag.name = "动作积木测试";
        CanvasNode n_in; n_in.id = "in"; n_in.type = "input"; n_in.title = "开始";
        CanvasNode n_dir; n_dir.id = "dir"; n_dir.type = "action"; n_dir.title = "读取目录";
        n_dir.action_kind = "read_file"; n_dir.action_target = act_dir.string();
        CanvasNode n_file; n_file.id = "file"; n_file.type = "action"; n_file.title = "读取具体文件";
        n_file.action_kind = "read_file"; n_file.action_target = (act_dir / "readme_notes.txt").string();
        CanvasNode n_fetch; n_fetch.id = "web"; n_fetch.type = "action"; n_fetch.title = "获取网页信息";
        n_fetch.action_kind = "fetch_url"; n_fetch.action_target = "https://example.test/status";
        CanvasNode n_end; n_end.id = "end"; n_end.type = "agent"; n_end.title = "伙伴汇总";
        ag.nodes = {n_in, n_dir, n_file, n_fetch, n_end};
        ag.edges = {
            {"ae1", "in", "out", "node", "dir", 0.5, "main", ""},
            {"ae2", "in", "out", "node", "file", 0.5, "main", ""},
            {"ae3", "in", "out", "node", "web", 0.5, "main", ""},
            {"ae4", "dir", "out", "node", "end", 0.5, "main", "目录清单"},
            {"ae5", "file", "out", "edge", "ae4", 0.4, "supplement", "文件内容补充"},
            {"ae6", "web", "out", "edge", "ae4", 0.7, "supplement", "网页信息补充"}
        };

        std::string end_prompt;
        CanvasRuntimeService svc(test_root / "svc-action", [&](const CanvasNodeExecRequest& req, auto, std::stop_token) {
            CanvasNodeExecResult r;
            r.ok = true;
            if (req.node.type == "action" && req.node.action_kind == "fetch_url") {
                r.output = "FETCHED_FROM:" + req.node.action_target;
                r.model_label = "获取网页信息";
            } else {
                end_prompt = req.assembled_prompt;
                r.output = "ACTION_FLOW_OK";
            }
            return r;
        });
        const auto lib = svc.list_library();
        bool has_action_tpl = false;
        for (const auto& c : lib.at("canvases").as_array()) {
            if (c.at("id").as_string() == "tpl-action-info-flow") has_action_tpl = true;
        }
        check(has_action_tpl, "builtin DimensionImage default action template tpl-action-info-flow exists");
        (void)svc.save_graph(ag);
        CanvasRunStartRequest sreq;
        sreq.canvas_id = "action-flow";
        sreq.input_text = "整理动作信息";
        const auto started = svc.start_run(sreq);
        const auto done = wait_run_status(svc, started.at("runId").as_string(), {"completed", "failed"});
        check(done.at("status").as_string() == "completed", "action flow with dir/file read + fetch_url supplement completed");
        check(end_prompt.find("readme_notes.txt") != std::string::npos, "dir action listed real file");
        check(end_prompt.find("动作读取测试正文") != std::string::npos, "file action read real text via edge supplement");
        check(end_prompt.find("FETCHED_FROM:https://example.test/status") != std::string::npos, "fetch_url action executed and attached as supplement");
    }

    // 8. Boolean switch + AND + OR logic conditions & True/False dual-branch routing
    {
        CanvasGraph lg;
        lg.id = "logic-gates-test";
        lg.name = "布尔与和或逻辑测试";
        CanvasNode b1; b1.id = "b1"; b1.type = "gate"; b1.title = "开关1";
        b1.gate_mode = "bool_switch"; b1.bool_source = "fixed"; b1.bool_value = true;
        CanvasNode b2; b2.id = "b2"; b2.type = "gate"; b2.title = "开关2";
        b2.gate_mode = "bool_switch"; b2.bool_source = "fixed"; b2.bool_value = false;
        CanvasNode b3; b3.id = "b3"; b3.type = "gate"; b3.title = "取反开关";
        b3.gate_mode = "bool_switch"; b3.bool_source = "fixed"; b3.bool_value = false; b3.invert_result = true;

        CanvasNode g_or; g_or.id = "g-or"; g_or.type = "gate"; g_or.title = "或门";
        g_or.gate_mode = "logic_or";
        CanvasNode g_and_fail; g_and_fail.id = "g-and-fail"; g_and_fail.type = "gate"; g_and_fail.title = "和门假";
        g_and_fail.gate_mode = "logic_and";
        CanvasNode g_and_rules; g_and_rules.id = "g-and-rules"; g_and_rules.type = "gate"; g_and_rules.title = "多规则和门";
        g_and_rules.gate_mode = "logic_and";
        g_and_rules.condition_rules = {{"contains", "TRUE"}, {"not_contains", "FATAL"}, {"gt_len", "3"}};

        CanvasNode hit_pass; hit_pass.id = "hit-pass"; hit_pass.type = "agent"; hit_pass.title = "命中真分支";
        CanvasNode hit_else; hit_else.id = "hit-else"; hit_else.type = "agent"; hit_else.title = "命中假分支";
        CanvasNode miss_branch; miss_branch.id = "miss-branch"; miss_branch.type = "agent"; miss_branch.title = "不应触发";

        lg.nodes = {b1, b2, b3, g_or, g_and_fail, g_and_rules, hit_pass, hit_else, miss_branch};
        lg.edges = {
            {"e1", "b1", "pass", "node", "g-or", 0.5, "main", ""},
            {"e2", "b2", "pass", "node", "g-or", 0.5, "main", ""},
            {"e3", "g-or", "pass", "node", "g-and-rules", 0.5, "main", ""},
            {"e4", "g-and-rules", "pass", "node", "hit-pass", 0.5, "main", "真"},
            {"e5", "b1", "pass", "node", "g-and-fail", 0.5, "main", ""},
            {"e6", "b2", "pass", "node", "g-and-fail", 0.5, "main", ""},
            {"e7", "g-and-fail", "pass", "node", "miss-branch", 0.5, "main", "真"},
            {"e8", "g-and-fail", "loop", "node", "hit-else", 0.5, "feedback", "假"}
        };

        std::mutex ran_mu;
        std::set<std::string> ran_nodes;
        CanvasRuntimeService svc(test_root / "svc-logic", [&](const CanvasNodeExecRequest& req, auto, std::stop_token) {
            {
                std::scoped_lock lk(ran_mu);
                ran_nodes.insert(req.node.id);
            }
            CanvasNodeExecResult r;
            r.ok = true;
            r.output = "RAN:" + req.node.id;
            return r;
        });
        (void)svc.save_graph(lg);
        CanvasRunStartRequest sreq;
        sreq.canvas_id = "logic-gates-test";
        sreq.input_text = "测试布尔与和或";
        const auto started = svc.start_run(sreq);
        const auto done = wait_run_status(svc, started.at("runId").as_string(), {"completed", "failed"});
        check(done.at("status").as_string() == "completed", "boolean/AND/OR logic graph completed cleanly");
        check(done.at("nodes").at("b3").at("gateDecision").as_string() == "pass", "inverted false boolean switch evaluated to true");
        check(done.at("nodes").at("g-or").at("gateDecision").as_string() == "pass", "OR gate with (true, false) evaluated to true");
        check(done.at("nodes").at("g-and-rules").at("gateDecision").as_string() == "pass", "multi-rule AND gate passed all 3 rules");
        check(done.at("nodes").at("g-and-fail").at("gateDecision").as_string() == "loop", "AND gate with (true, false) evaluated to false");
        check(ran_nodes.contains("hit-pass"), "true branch node executed");
        check(ran_nodes.contains("hit-else"), "false (Else) branch node executed");
        check(!ran_nodes.contains("miss-branch"), "blocked true branch under false AND gate did NOT execute");
    }

    for (const bool choice : {true, false}) {
        CanvasGraph graph;
        graph.id = "diamond";
        graph.name = "branch merge";
        CanvasNode gate;
        gate.id = "choice"; gate.type = "gate"; gate.gate_mode = "bool_switch";
        gate.bool_source = "fixed"; gate.bool_value = choice;
        graph.nodes.push_back(gate);
        CanvasNode input; input.id = "data"; input.type = "input"; graph.nodes.push_back(input);
        for (const auto* id : {"yes", "no", "deliver"}) {
            CanvasNode node; node.id = id; node.type = "agent";
            graph.nodes.push_back(node);
        }
        graph.edges = {{"t","choice","pass","node","yes",0.5,"main",""},{"f","choice","loop","node","no",0.5,"feedback",""},
                       {"data-edge","data","out","node","yes",0.5,"main",""},
                       {"j1","yes","out","node","deliver",0.5,"main",""},{"j2","no","out","node","deliver",0.5,"main",""}};
        CanvasRuntimeService service(test_root / (choice ? "true-merge" : "false-merge"),
            [](const CanvasNodeExecRequest& r, auto, std::stop_token) {
                CanvasNodeExecResult result; result.ok = true; result.output = r.node.id; return result;
            });
        service.save_graph(graph);
        const auto started = service.start_run({graph.id,"fixture","",""});
        const auto run = wait_run_status(service, started.at("runId").as_string(), {"completed","failed"});
        check(run.at("nodes").at(choice ? "no" : "yes").at("status").as_string() == "skipped",
              "unselected branch recorded as skipped");
        check(run.at("status").as_string() == "completed" && run.at("finalOutput").as_string() == "deliver",
              "exclusive branches rejoin and execute terminal delivery");
    }

    {
        CanvasRuntimeService service(test_root/"assignment-lock",{});
        CanvasGraph g; g.id="grp-bp-lock"; g.name="owner plan";
        CanvasNode agent; agent.id="job1"; agent.type="agent"; agent.model="manual-model";
        agent.assignment_locked=true; g.nodes.push_back(agent);
        service.save_graph(g);
        g.nodes.front().assignment_locked=false;
        check(service.save_graph(g,true).nodes.front().assignment_locked,"regeneration retains a user's lock");
        g.nodes.front().model="replacement";
        bool rejected=false;
        try { service.save_graph(g,true); } catch (const std::exception&) { rejected=true; }
        check(rejected && service.get_graph(g.id).nodes.front().model=="manual-model","conflicting automatic replan preserves original assignment");
        check(service.save_graph(g).nodes.front().model=="replacement","user may unlock and change their assignment");
    }

    fs::remove_all(test_root, ec);
    std::cout << "canvas_engine: " << g_checks << " checks passed\n";
    return 0;
}
