// Short-lived Linux command runner, launched as PID 1 inside bubblewrap.
// stdin EOF is ownership loss. The helper accepts exactly one request and never
// persists or replays it. The outer WSL/bubblewrap launcher remains required.
#include "dimension/json.hpp"
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>
using dimension::Json;
using O=Json::Object;
using A=Json::Array;
using Clock=std::chrono::steady_clock;
using namespace std::chrono_literals;
namespace {
constexpr size_t output_limit=256*1024; // Worst-case JSON escaping stays below 4 MiB.
constexpr uint64_t output_file_limit=32*1024*1024;
constexpr uint64_t address_space_limit=1024*1024*1024;
constexpr unsigned process_limit=128;
constexpr unsigned open_file_limit=128;
volatile sig_atomic_t stopped=0;
bool command_started=false;
void signal_stop(int){stopped=1;}
struct NamespaceCleanup{
    bool active=true;
    ~NamespaceCleanup(){if(active){kill(-1,SIGKILL);while(waitpid(-1,nullptr,0)>0){}}}
};

std::string clean(std::string_view s){
    std::string out;size_t i=0;
    while(i<s.size()){
        const unsigned char c=s[i];size_t n=c<0x80?1:c>=0xc2&&c<=0xdf?2:c>=0xe0&&c<=0xef?3:c>=0xf0&&c<=0xf4?4:0;
        bool valid=n&&i+n<=s.size();
        if(valid&&n>1){for(size_t j=1;j<n;++j)if((static_cast<unsigned char>(s[i+j])&0xc0)!=0x80)valid=false;
            const unsigned char next=s[i+1];if((c==0xe0&&next<0xa0)||(c==0xed&&next>=0xa0)||(c==0xf0&&next<0x90)||(c==0xf4&&next>=0x90))valid=false;}
        if(valid){out.append(s.substr(i,n));i+=n;}else{out+="\xef\xbf\xbd";++i;}
    }return out;
}

bool relative_path(const std::string& value,bool cwd=false){
    if(value.empty()||value.size()>2048||value.front()=='/'||value.find('\\')!=value.npos||
       value.find(':')!=value.npos||value.find('\0')!=value.npos)return false;
    if(cwd&&value==".")return true;
    for(size_t at=0;at<=value.size();){
        const auto next=value.find('/',at);const auto part=value.substr(at,next==value.npos?next:next-at);
        if(part.empty()||part=="."||part=="..")return false;
        if(next==value.npos)break;
        at=next+1;
    }
    return true;
}

int open_beneath(int root,const std::string& path,int flags){
    open_how how{};how.flags=flags;
    how.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS;
    return static_cast<int>(syscall(SYS_openat2,root,path.c_str(),&how,sizeof(how)));
}

struct OutputFile{std::string path;uint64_t size=0;};
OutputFile verify_output(int root,const std::string& path){
    if(!relative_path(path))throw std::runtime_error("invalid_output_path");
    const int fd=open_beneath(root,path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)throw std::runtime_error("output_not_regular_file");
    struct stat info{};
    const bool valid=fstat(fd,&info)==0&&S_ISREG(info.st_mode)&&info.st_nlink==1&&
        info.st_size>=0&&static_cast<uint64_t>(info.st_size)<=output_file_limit;
    close(fd);
    if(!valid)throw std::runtime_error(info.st_size>static_cast<off_t>(output_file_limit)?"output_too_large":"output_not_regular_file");
    return {path,static_cast<uint64_t>(info.st_size)};
}

void limit_or_exit(int resource,rlim_t soft,rlim_t hard){
    rlimit value{soft,hard};if(setrlimit(resource,&value)<0)_exit(125);
}

Json execute(const Json& request){
    // Outside a PID namespace, kill(-1) would be unsafe. Refuse direct launch.
    // Managed workspaces additionally use the WSL host-write group 1002 so
    // Windows and Linux writes share one kernel group quota.
    const bool quota_group=(getgid()==1000&&getegid()==1000)||(getgid()==1002&&getegid()==1002);
    if(getpid()!=1||getuid()!=1000||geteuid()!=1000||!quota_group)
        return O{{"event","result"},{"ok",false},{"code","isolated_identity_and_pid_namespace_required"},{"noSideEffects",true}};
    if(!request.is_object())throw std::runtime_error("invalid_request");
    for(const auto& [key,value]:request.as_object()){(void)value;
        if(key!="argv"&&key!="cwd"&&key!="timeoutSeconds"&&key!="cpuSeconds"&&key!="outputs")throw std::runtime_error("invalid_request_field");}
    const auto& values=request.at("argv").as_array();if(values.empty()||values.size()>64)throw std::runtime_error("invalid_argv");
    std::vector<std::string> args;size_t total=0;
    for(const auto& value:values){auto s=value.as_string();total+=s.size();if(s.size()>16384||s.find('\0')!=s.npos)throw std::runtime_error("invalid_argument");args.push_back(std::move(s));}
    if(total>65536||args.front().empty()||args.front().front()!='/')throw std::runtime_error("invalid_executable");
    const auto cwd=request.at("cwd").as_string();if(!relative_path(cwd,true))throw std::runtime_error("invalid_cwd");
    const auto seconds=request.at("timeoutSeconds").as_number();
    if(!std::isfinite(seconds)||seconds<1||seconds>600||std::floor(seconds)!=seconds)throw std::runtime_error("invalid_timeout");
    const auto cpu=request.find("cpuSeconds")?request.at("cpuSeconds").as_number():std::min(seconds,60.0);
    if(!std::isfinite(cpu)||cpu<1||cpu>seconds||std::floor(cpu)!=cpu)throw std::runtime_error("invalid_cpu_timeout");
    std::vector<std::string> outputs;
    if(const auto* files=request.find("outputs")){
        if(!files->is_array()||files->as_array().size()>32)throw std::runtime_error("invalid_outputs");
        for(const auto& file:files->as_array()){
            if(!file.is_string()||!relative_path(file.as_string()))throw std::runtime_error("invalid_output_path");
            outputs.push_back(file.as_string());
        }
    }

    const int root=open("/workspace",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(root<0)throw std::runtime_error("workspace_not_found");
    const int working=cwd=="."?fcntl(root,F_DUPFD_CLOEXEC,3):open_beneath(root,cwd,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(working<0){close(root);throw std::runtime_error("cwd_not_found_or_unsafe");}
    std::vector<char*> argv;for(auto& s:args)argv.push_back(s.data());argv.push_back(nullptr);
    int out[2],err[2];if(pipe2(out,O_CLOEXEC)||pipe2(err,O_CLOEXEC)){close(root);close(working);throw std::runtime_error("pipe_failed");}
    const int input=open("/dev/null",O_RDONLY|O_CLOEXEC);if(input<0){close(root);close(working);close(out[0]);close(out[1]);close(err[0]);close(err[1]);throw std::runtime_error("input_failed");}
    const auto start=Clock::now();const pid_t owner=getpid();const pid_t pid=fork();
    if(pid<0){close(root);close(working);close(input);close(out[0]);close(out[1]);close(err[0]);close(err[1]);throw std::runtime_error("fork_failed");}
    if(!pid){
        setsid();prctl(PR_SET_PDEATHSIG,SIGKILL);prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0);if(getppid()!=owner)_exit(125);
        signal(SIGTERM,SIG_DFL);signal(SIGINT,SIG_DFL);signal(SIGPIPE,SIG_DFL);signal(SIGXCPU,SIG_DFL);signal(SIGXFSZ,SIG_DFL);
        dup2(input,STDIN_FILENO);dup2(out[1],STDOUT_FILENO);dup2(err[1],STDERR_FILENO);
        close(input);close(out[0]);close(out[1]);close(err[0]);close(err[1]);
        limit_or_exit(RLIMIT_CORE,0,0);
        limit_or_exit(RLIMIT_CPU,static_cast<rlim_t>(cpu),static_cast<rlim_t>(cpu)+1);
        limit_or_exit(RLIMIT_AS,address_space_limit,address_space_limit);
        limit_or_exit(RLIMIT_NPROC,process_limit,process_limit);
        limit_or_exit(RLIMIT_FSIZE,output_file_limit,output_file_limit);
        limit_or_exit(RLIMIT_NOFILE,open_file_limit,open_file_limit);
        umask(022);
        if(fchdir(working)<0)_exit(125);
        close(root);close(working);
        execv(argv[0],argv.data());_exit(127);
    }
    command_started=true;
    NamespaceCleanup namespace_cleanup;
#ifdef DIMENSION_EXEC_TEST_AFTER_FORK
    throw std::runtime_error("injected_after_fork");
#endif
    close(input);close(working);close(out[1]);close(err[1]);fcntl(out[0],F_SETFL,O_NONBLOCK);fcntl(err[0],F_SETFL,O_NONBLOCK);
    std::string stdout_text,stderr_text,reason;bool done=false,out_eof=false,err_eof=false;int status=0;
    auto end=start+std::chrono::seconds(static_cast<int>(seconds)),kill_at=end+1s;bool killing=false;
    while(!done||!out_eof||!err_eof){
        const auto now=Clock::now();
        if(reason.empty()&&(stopped||now>=end))reason=stopped?"cancelled":"timeout";
        if(!reason.empty()&&!killing){kill(-1,SIGTERM);killing=true;kill_at=now+250ms;}
        if(killing&&now>=kill_at)kill(-1,SIGKILL);
        pollfd descriptors[]={{STDIN_FILENO,POLLIN|POLLHUP,0},{out[0],POLLIN|POLLHUP,0},{err[0],POLLIN|POLLHUP,0}};
        poll(descriptors,3,30);
        if(descriptors[0].revents){char byte;auto n=read(STDIN_FILENO,&byte,1);if(n<=0){stopped=1;if(reason.empty())reason="cancelled";}}
        auto drain=[&](int fd,std::string& data,bool& eof){char buffer[8192];for(int block=0;block<16;++block){const auto count=read(fd,buffer,sizeof buffer);if(count>0){
            const size_t keep=std::min<size_t>(static_cast<size_t>(count),output_limit-std::min<size_t>(data.size(),output_limit));data.append(buffer,keep);
            if(keep<static_cast<size_t>(count)){if(reason.empty())reason="output_limit";break;}
        }else{if(count==0)eof=true;break;}}};
        drain(out[0],stdout_text,out_eof);drain(err[0],stderr_text,err_eof);
        if(!done&&waitpid(pid,&status,WNOHANG)==pid){done=true;kill(-1,SIGKILL);}
        // A Linux namespace can contain grandchildren in other sessions. PID 1
        // cleanup kills all of them, even if they close inherited output pipes.
        if(done&&out_eof&&err_eof)break;
    }
    kill(-1,SIGKILL);while(waitpid(-1,nullptr,0)>0){}
    namespace_cleanup.active=false;
    close(out[0]);close(err[0]);
    int code=WIFEXITED(status)?WEXITSTATUS(status):128+(WIFSIGNALED(status)?WTERMSIG(status):0);
    if(reason.empty()&&WIFSIGNALED(status)&&WTERMSIG(status)==SIGXCPU)reason="cpu_limit";
    if(reason.empty()&&WIFSIGNALED(status)&&WTERMSIG(status)==SIGXFSZ)reason="file_size_limit";
    A verified;
    if(reason.empty()&&code==0){
        try{
            for(const auto& path:outputs){const auto file=verify_output(root,path);verified.push_back(O{{"path",file.path},{"sizeBytes",static_cast<double>(file.size)}});}
        }catch(const std::exception& error){reason=error.what();}
    }
    close(root);
    if(!reason.empty()&&reason!="cancelled"&&reason!="timeout"&&reason!="output_limit"&&reason!="cpu_limit"&&reason!="file_size_limit")code=125;
    return O{{"event","result"},{"ok",reason.empty()&&code==0},{"exitCode",code},{"code",reason.empty()?(code?"command_failed":"completed"):reason},
        {"stdout",clean(stdout_text)},{"stderr",clean(stderr_text)},{"durationMs",double(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-start).count())},
        {"cancelled",reason=="cancelled"},{"timedOut",reason=="timeout"},{"truncated",reason=="output_limit"},{"noSideEffects",false},
        {"outputs",verified},{"outputsVerified",reason.empty()&&code==0},
        {"perProcessLimits",O{{"cpuSeconds",cpu},{"addressSpaceBytes",static_cast<double>(address_space_limit)},
            {"openFiles",static_cast<double>(open_file_limit)}}},
        {"perUidLimits",O{{"processes",static_cast<double>(process_limit)}}},
        {"perFileLimits",O{{"fileBytes",static_cast<double>(output_file_limit)}}},
        {"perCommandOutputLimits",O{{"stdoutBytes",static_cast<double>(output_limit)},{"stderrBytes",static_cast<double>(output_limit)}}},
        {"aggregateResourceControl","unavailable: no cgroup aggregate memory/CPU/workspace-write quota"},
        {"tmpfsLimits","16 MiB /tmp and /home per mount; 1 MiB /run; no combined quota"}};
}
}

int fixed_environment(){
    if(clearenv()!=0)return -1;
    return setenv("PATH","/usr/bin:/bin",1)||setenv("HOME","/home/bot",1)||
        setenv("USER","bot",1)||setenv("LOGNAME","bot",1)||setenv("LANG","C.UTF-8",1)||
        setenv("TMPDIR","/tmp",1)||setenv("XDG_RUNTIME_DIR","/run/user/1000",1)?-1:0;
}

int main(){
    prctl(PR_SET_DUMPABLE,0);prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0);
    signal(SIGTERM,signal_stop);signal(SIGINT,signal_stop);signal(SIGHUP,signal_stop);signal(SIGPIPE,SIG_IGN);
    if(fixed_environment()!=0){std::cout<<Json(O{{"event","result"},{"ok",false},{"code","fixed_environment_failed"},{"noSideEffects",true}}).dump()<<'\n';return 0;}
    try{
        std::string line;char c;bool complete=false;
        while(read(STDIN_FILENO,&c,1)==1){if(c=='\n'){complete=true;break;}line+=c;if(line.size()>128*1024)throw std::runtime_error("request_too_large");}
        if(!complete)return 0; // EOF with an incomplete request is cancellation, never replay.
        if(!line.empty()&&line.back()=='\r')line.pop_back();
        if(line.empty())throw std::runtime_error("invalid_request");
        std::cout<<execute(Json::parse(line)).dump()<<'\n'<<std::flush;return 0;
    }catch(const std::exception& error){std::cout<<Json(O{{"event","result"},{"ok",false},
        {"code",command_started?"executor_internal_error":error.what()},
        {"noSideEffects",!command_started},{"uncertain",command_started}}).dump()<<'\n'<<std::flush;return 0;}
}
