#include "dimension/sandbox_exec.hpp"
#include "dimension/atomic_file.hpp"
#include <windows.h>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <stdexcept>
namespace {
using namespace dimension;namespace fs=std::filesystem;using O=Json::Object;using A=Json::Array;using namespace std::chrono_literals;
int count=0;
void check(bool value,const char* label){if(!value)throw std::runtime_error(label);++count;std::cout<<"PASS "<<label<<'\n'<<std::flush;}
std::string read(const fs::path& p){std::ifstream f(p,std::ios::binary);return {(std::istreambuf_iterator<char>(f)),{}};}
fs::path own_executable(){std::wstring value(32768,L'\0');const auto size=GetModuleFileNameW(nullptr,value.data(),static_cast<DWORD>(value.size()));if(!size||size>=value.size())throw std::runtime_error("Cannot locate test executable");value.resize(size);return value;}
}
int wmain(int argc,wchar_t** argv){
    if(argc>=3&&std::wstring(argv[1])==L"-d"){
        const std::wstring mode=argv[2];
        if(mode==L"fixture-result-exit"||mode==L"fixture-result-hang"){
            std::cout<<Json(O{{"event","result"},{"ok",true},{"exitCode",0},{"code","completed"},{"noSideEffects",false},{"outputs",A{}},{"outputsVerified",true}}).dump()<<'\n'<<std::flush;
            if(mode==L"fixture-result-hang"){Sleep(60000);return 0;}return 7;
        }
        if(mode==L"fixture-no-result")return 0;
    }
    try{
        if(argc!=3&&argc!=4)throw std::runtime_error("output directory, Linux helper and optional post-fork fault helper required");
        const auto root=fs::absolute(argv[1]),project=root/L"ancestor"/L"project";fs::create_directories(project);
        char* selected=nullptr;size_t selected_size=0;_dupenv_s(&selected,&selected_size,"DIMENSION_WSL_DISTRO");
        const std::string distribution=selected&&*selected?selected:"dimension-sandbox";std::free(selected);
        SandboxExecutor executor({root/L"processes",L"C:/Windows/System32/wsl.exe",fs::absolute(argv[2]),distribution});
        check(executor.available(),"Actual Linux executor helper is installed");
        auto call=[&](A args,int timeout=30,A outputs={},bool network=false,int cpu=0){
            O request{{"argv",args},{"cwd","."},{"timeoutSeconds",timeout},{"outputs",outputs}};
            if(cpu)request["cpuSeconds"]=cpu;
            return executor.execute(project,network,request);
        };
        auto ok=[](const Json& v){if(!v.at("ok").as_bool()||!v.at("transportCleanupConfirmed").as_bool())throw std::runtime_error(v.dump());};
        SetEnvironmentVariableW(L"DIMENSION_SYNTHETIC_SECRET",L"must-not-inherit");
        auto inspect=call(A{"/usr/bin/python3","-c",
            "import os,json,socket,pathlib; print(json.dumps({'workspace':os.getcwd(),'home':os.environ['HOME'],'env':sorted(os.environ),'windows':os.path.exists('/mnt'),'opt':os.path.exists('/opt'),'profiles':os.path.exists('/home/dimension'),'shadow':os.path.exists('/etc/shadow'),'display':os.getenv('DISPLAY'),'interop':os.getenv('WSL_INTEROP'),'secret':os.getenv('DIMENSION_SYNTHETIC_SECRET'),'net':[x[1] for x in socket.if_nameindex()],'cgroup':os.path.exists('/sys/fs/cgroup')})); pathlib.Path(os.environ['HOME']+'/private.txt').write_text('temporary')"});
        ok(inspect);const auto info=Json::parse(inspect.at("stdout").as_string());
        check(info.at("workspace").as_string()=="/workspace"&&info.at("home").as_string()=="/home/bot"&&
            !info.at("windows").as_bool()&&!info.at("opt").as_bool()&&!info.at("profiles").as_bool()&&!info.at("shadow").as_bool()&&
            info.at("display").is_null()&&info.at("interop").is_null()&&info.at("secret").is_null()&&
            info.at("env").as_array().size()==7&&info.at("net").as_array().size()==1&&info.at("net").as_array().front().as_string()=="lo"&&!info.at("cgroup").as_bool()&&
            inspect.at("networkPolicy").as_string()=="isolated-loopback-only"&&inspect.at("concurrencyLimit").as_number()==1&&
            inspect.at("aggregateResourceControl").as_string().find("cgroup-v2")==0&&inspect.at("aggregateMemoryBytes").as_number()==2147483648.0&&
            inspect.at("aggregateCpuCount").as_number()==2&&inspect.at("aggregatePidLimit").as_number()==512&&!inspect.at("workspaceWriteQuota").as_bool(),
            "Fixed identity, exact environment, minimal mounts, loopback network, serial admission and supervised aggregate limits are real");
        auto next=call(A{"/usr/bin/python3","-c","import os; assert not os.path.exists(os.environ['HOME']+'/private.txt'); print('fresh-home')"});ok(next);
        check(next.at("stdout").as_string()=="fresh-home\n","Every command gets an empty HOME");
        const auto denied=call(A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('network-ran').write_text('bad')"},30,{},true);
        check(!denied.at("ok").as_bool()&&denied.at("code").as_string()=="network_access_unavailable"&&denied.at("noSideEffects").as_bool()&&!fs::exists(project/L"network-ran"),"Network enable is removed before launch with no side effects");

        const auto snapshot_root=root/L"task-owned-snapshot";
        auto output=executor.execute(project,false,O{{"argv",A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('verified').mkdir();pathlib.Path('verified/result.txt').write_text('verified-output')"}},
            {"cwd","."},{"timeoutSeconds",30},{"outputs",A{"verified/result.txt"}}},{},snapshot_root);ok(output);
        const auto snapshot=fs::path(output.at("outputSnapshots").as_array().front().at("snapshot").as_string());
        check(output.at("hostOutputsVerified").as_bool()&&output.at("outputSnapshots").as_array().front().at("sizeBytes").as_number()==15&&
            snapshot.parent_path()==snapshot_root&&read(snapshot)=="verified-output","Verified source handle is copied into the selected task snapshot");
        atomic_write_file(project/L"verified/result.txt","changed-after-snapshot");
        check(read(snapshot)=="verified-output","Task snapshot remains the verified object after project content changes");
        auto maximum=call(A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('maximum.bin').write_bytes(b'x'*(32*1024*1024))"},30,A{"maximum.bin"});ok(maximum);
        const auto maximum_snapshot=fs::path(maximum.at("outputSnapshots").as_array().front().at("snapshot").as_string());
        check(fs::file_size(maximum_snapshot)==32U*1024U*1024U&&read(maximum_snapshot).size()==32U*1024U*1024U,"Exact 32 MiB output passes snapshot and bounded artifact read");
        {std::ofstream file(project/L"too-large.bin",std::ios::binary);file.seekp(32*1024*1024);file.put('\0');}
        const auto oversized=call(A{"/usr/bin/true"},30,A{"too-large.bin"});
        check(!oversized.at("ok").as_bool()&&oversized.at("code").as_string()=="output_too_large"&&!oversized.find("outputSnapshots"),"33 MiB output is rejected before snapshot or artifact download");

        bool rejected=false;try{(void)executor.execute(project,false,O{{"argv",A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('invalid-output-ran').write_text('bad')"}},{"outputs",A{"../escape"}}});}catch(const std::exception&){rejected=true;}
        check(rejected&&!fs::exists(project/L"invalid-output-ran"),"Parent output path is rejected before execution");
        ok(call(A{"/usr/bin/python3","-c","import os;os.symlink('/tmp','cwd-link')"}));
        const auto unsafe_cwd=executor.execute(project,false,O{{"argv",A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('/tmp/cwd-escape').write_text('bad')"}},{"cwd","cwd-link"},{"timeoutSeconds",30}});
        check(!unsafe_cwd.at("ok").as_bool()&&unsafe_cwd.at("noSideEffects").as_bool()&&unsafe_cwd.at("code").as_string()=="cwd_not_found_or_unsafe","A symlink cwd cannot escape the authorized workspace");
        ok(call(A{"/usr/bin/python3","-c","import os;os.symlink('/tmp/outside','link-output')"}));
        const auto link=call(A{"/usr/bin/true"},30,A{"link-output"});
        ok(call(A{"/usr/bin/mkdir","directory-output"}));
        const auto directory=call(A{"/usr/bin/true"},30,A{"directory-output"});
        ok(call(A{"/usr/bin/python3","-c","import os,pathlib;pathlib.Path('real-output').write_text('x');os.link('real-output','hardlink-output')"}));
        const auto hardlink=call(A{"/usr/bin/true"},30,A{"hardlink-output"});
        check(!link.at("ok").as_bool()&&!directory.at("ok").as_bool()&&!hardlink.at("ok").as_bool(),"Link, directory and multi-link outputs are rejected");
        int host_rejected=0;for(const char* path:{"link-output","directory-output","hardlink-output","too-large.bin"}){
            try{(void)verify_sandbox_output(project,path);}catch(const std::exception&){++host_rejected;}}
        check(host_rejected==4,"Windows verifier independently rejects links, directories, multi-link and oversized outputs");

        const auto peer_success=Json(O{{"event","result"},{"ok",true},{"code","completed"},{"noSideEffects",false}});
        const auto cleanup_failure=Json(O{{"event","exit"},{"ok",false},{"error",O{{"code","cleanup_failed"},{"message","injected"}}}});
        const auto cleanup_result=normalize_sandbox_transport(peer_success,cleanup_failure);
        check(!cleanup_result.at("ok").as_bool()&&cleanup_result.at("uncertain").as_bool()&&
            cleanup_result.at("code").as_string()=="transport_cleanup_failed"&&!cleanup_result.at("transportCleanupConfirmed").as_bool(),"Injected cleanup_failed downgrades a successful peer result");
        SandboxExecutor fake({root/L"fake-processes",own_executable(),fs::absolute(argv[2]),"fixture-result-exit"});
        const auto nonzero=fake.execute(project,false,O{{"argv",A{"/usr/bin/true"}},{"timeoutSeconds",30}});
        check(!nonzero.at("ok").as_bool()&&nonzero.at("uncertain").as_bool()&&nonzero.at("code").as_string()=="transport_exit_failed"&&
            nonzero.at("executionCode").as_string()=="completed","Result followed by nonzero transport exit is never completion");
        SandboxExecutor hung({root/L"hung-processes",own_executable(),fs::absolute(argv[2]),"fixture-result-hang"});
        const auto result_hang=hung.execute(project,false,O{{"argv",A{"/usr/bin/true"}},{"timeoutSeconds",30}});
        check(!result_hang.at("ok").as_bool()&&result_hang.at("uncertain").as_bool()&&result_hang.at("code").as_string()=="transport_exit_failed"&&
            result_hang.at("transportExit").at("error").at("code").as_string()=="closed","Result followed by transport close is downgraded after the final cleanup wait");
        SandboxExecutor disconnected({root/L"disconnected-processes",own_executable(),fs::absolute(argv[2]),"fixture-no-result"});
        const auto no_result=disconnected.execute(project,false,O{{"argv",A{"/usr/bin/true"}},{"timeoutSeconds",30}});
        check(!no_result.at("ok").as_bool()&&no_result.at("uncertain").as_bool()&&no_result.at("code").as_string()=="executor_disconnected","Clean transport exit without a result remains uncertain");

        Json postfork;
        if(argc==4){
            SandboxExecutor fault({root/L"fault-processes",L"C:/Windows/System32/wsl.exe",fs::absolute(argv[3]),distribution});
            postfork=fault.execute(project,false,O{{"argv",A{"/usr/bin/python3","-c","import time,pathlib;time.sleep(2);pathlib.Path('/workspace/post-fork-leak').write_text('bad')"}},{"timeoutSeconds",30}});
            const auto& injected=postfork;
            std::this_thread::sleep_for(2500ms);
            check(!injected.at("ok").as_bool()&&injected.at("uncertain").as_bool()&&!injected.at("noSideEffects").as_bool()&&
                injected.at("code").as_string()=="executor_internal_error"&&!fs::exists(project/L"post-fork-leak"),"Injected post-fork exception is uncertain, has side effects and cleans descendants");
        }

        Json pinned;std::jthread pinned_run([&]{pinned=call(A{"/usr/bin/python3","-c","import pathlib,time;pathlib.Path('/workspace/pin-started').write_text('started');time.sleep(1)"});});
        for(int i=0;i<200&&!fs::exists(project/L"pin-started");++i)std::this_thread::sleep_for(25ms);
        check(fs::exists(project/L"pin-started"),"Directory pin fixture actually starts");
        const auto renamed=root/L"renamed-project";
        const bool moved=MoveFileW(project.c_str(),renamed.c_str());const auto move_error=GetLastError();
        const auto ancestor_renamed=root/L"renamed-ancestor";
        const bool ancestor_moved=MoveFileW(project.parent_path().c_str(),ancestor_renamed.c_str());const auto ancestor_error=GetLastError();
        check(!moved&&(move_error==ERROR_ACCESS_DENIED||move_error==ERROR_SHARING_VIOLATION)&&
            !ancestor_moved&&(ancestor_error==ERROR_ACCESS_DENIED||ancestor_error==ERROR_SHARING_VIOLATION),"Project root and its ancestor cannot be renamed while the directory chain is held");
        pinned_run.join();ok(pinned);
        check(MoveFileW(project.c_str(),renamed.c_str())&&MoveFileW(renamed.c_str(),project.c_str()),"Directory pin is released after final transport and snapshot completion");

        Json first,second;const auto concurrent_start=std::chrono::steady_clock::now();
        {std::jthread one([&]{first=call(A{"/usr/bin/python3","-c","import time;time.sleep(1)"});});
         std::jthread two([&]{second=call(A{"/usr/bin/python3","-c","import time;time.sleep(1)"});});}
        const auto concurrent_ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-concurrent_start).count();ok(first);ok(second);
        check(concurrent_ms>=1800,"Concurrent callers are admitted serially");

        auto node=call(A{"/usr/bin/node","-e","require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/index.html','<!doctype html><h1>actual-node-build</h1>');console.log('node-build')"});ok(node);
        atomic_write_file(project/L"hello.cpp","#include <iostream>\nint main(){std::cout << \"native-cpp-output\";}");
        ok(call(A{"/usr/bin/g++","hello.cpp","-o","build/hello"}));auto cpp=call(A{"/workspace/build/hello"});ok(cpp);
        atomic_write_file(project/L"CMakeLists.txt","cmake_minimum_required(VERSION 3.20)\nproject(DimensionSandboxCheck LANGUAGES CXX)\nadd_executable(dimension-check hello.cpp)\n");
        ok(call(A{"/usr/bin/cmake","-S",".","-B","cmake-build","-DCMAKE_BUILD_TYPE=Release"}));
        ok(call(A{"/usr/bin/cmake","--build","cmake-build","--parallel","2"}));
        auto cmake=call(A{"/workspace/cmake-build/dimension-check"});ok(cmake);
        check(read(project/"build/index.html").find("actual-node-build")!=std::string::npos&&cpp.at("stdout").as_string()=="native-cpp-output"&&cmake.at("stdout").as_string()=="native-cpp-output","Node, C++ and CMake still execute successfully");
        const auto cpu=call(A{"/usr/bin/python3","-c","while True:pass"},10,{},false,1);
        const auto memory=call(A{"/usr/bin/python3","-c","x=bytearray(2*1024**3)"},10);
        check(!cpu.at("ok").as_bool()&&cpu.at("code").as_string()=="cpu_limit"&&!memory.at("ok").as_bool()&&
            cpu.at("perProcessLimits").at("addressSpaceBytes").as_number()==1073741824,"Per-process CPU and address-space rlimits are enforced and labelled");
        const auto processes=call(A{"/usr/bin/python3","-c",
            "import os,sys,time,pathlib\ntry:\n for i in range(600):\n  pid=os.fork()\n  if pid==0:\n   try:time.sleep(3);pathlib.Path('/workspace/process-escape').write_text('bad')\n   except BaseException:pass\n   os._exit(0)\n print('limit-not-enforced',flush=True)\nexcept OSError as e:\n print('limited',e.errno,flush=True);sys.exit(9)"},10);
        std::this_thread::sleep_for(3500ms);
        check(!processes.at("ok").as_bool()&&processes.at("exitCode").as_number()==9&&!fs::exists(project/L"process-escape"),"Aggregate PID limit works and descendants cannot write later");
        const auto tmpfs=call(A{"/usr/bin/python3","-c","import pathlib;pathlib.Path('/tmp/full').write_bytes(b'x'*(17*1024*1024))"},10);
        check(!tmpfs.at("ok").as_bool(),"The 16 MiB /tmp mount rejects an over-budget write");
        const auto combined_tmpfs=call(A{"/usr/bin/python3","-c",
            "import pathlib\nfor path in ['/tmp/a','/home/bot/b','/run/user/1000/c','/dev/shm/d']:\n pathlib.Path(path).write_bytes(b'x'*5*1024**2)"},10);
        check(!combined_tmpfs.at("ok").as_bool()&&combined_tmpfs.at("code").as_string()=="command_failed",
            "Tmp, ephemeral home, runtime and shared memory have one combined hard quota");
        const auto timed=call(A{"/usr/bin/python3","-c","import subprocess,time; subprocess.Popen(['/usr/bin/python3','-c',\"import time,pathlib;time.sleep(3);pathlib.Path('/workspace/timeout-leak').write_text('bad')\"]);time.sleep(30)"},1);
        check(!timed.at("ok").as_bool()&&timed.at("timedOut").as_bool()&&timed.at("transportCleanupConfirmed").as_bool(),"Timeout terminates the process tree with confirmed transport cleanup");
        const auto flooded=call(A{"/usr/bin/python3","-c","import os; [os.fork() for _ in range(3)];\nwhile True: os.write(1,b'x'*8192)"},1);
        check(!flooded.at("ok").as_bool()&&(flooded.at("truncated").as_bool()||flooded.at("timedOut").as_bool()),"Continuous output writers cannot starve timeout or output limits");
        std::stop_source cancel;Json cancelled;
        std::jthread running([&]{cancelled=executor.execute(project,false,O{{"argv",A{"/usr/bin/python3","-c",
            "import pathlib,subprocess,time;pathlib.Path('/workspace/cancel-started').write_text('started');subprocess.Popen(['/usr/bin/python3','-c',\"import time,pathlib;time.sleep(4);pathlib.Path('/workspace/cancel-leak').write_text('bad')\"]);time.sleep(60)"}},{"timeoutSeconds",60}},cancel.get_token());});
        for(int i=0;i<200&&!fs::exists(project/L"cancel-started");++i)std::this_thread::sleep_for(25ms);
        check(fs::exists(project/L"cancel-started"),"Cancellation fixture actually starts");
        cancel.request_stop();running.join();std::this_thread::sleep_for(4500ms);
        check(!cancelled.at("ok").as_bool()&&cancelled.at("cancelled").as_bool()&&!fs::exists(project/L"cancel-leak")&&!fs::exists(project/L"timeout-leak"),"Cancellation and timeout leave no delayed descendant writes");
        auto reopened=call(A{"/usr/bin/python3","-c","import os,pathlib;assert not os.path.exists(os.environ['HOME']+'/private.txt');assert not pathlib.Path('/workspace/cancel-leak').exists();print('clean-reopen')"});ok(reopened);
        check(reopened.at("stdout").as_string()=="clean-reopen\n","Reopen neither replays cancelled output nor restarts work");
        O evidence{{"ok",true},{"checks",count},{"inspection",info},{"networkDenied",denied},{"output",output},
            {"oversized",oversized},{"concurrencyMs",static_cast<double>(concurrent_ms)},{"timeout",timed},{"cancel",cancelled},{"reopened",reopened}};
        evidence["maximum"]=O{{"bytes",32*1024*1024}};
        evidence["transport"]=O{{"cleanupFault",cleanup_result},{"nonzero",nonzero},{"resultHang",result_hang},{"noResult",no_result}};
        evidence["postFork"]=postfork;
        evidence["resources"]=O{{"cpu",cpu},{"memory",memory},{"processes",processes},{"tmpfs",tmpfs},{"combinedTmpfs",combined_tmpfs}};
        evidence["boundary"]="Supervised aggregate memory/swap, CPU and PID cgroups plus a combined 16 MiB tmpfs quota; no total workspace-write quota or network capability";
        atomic_write_file(root/L"result.json",Json(evidence).dump());std::cout<<count<<" actual Windows-to-Linux checks passed\n";return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
