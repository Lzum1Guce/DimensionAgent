// Original package installer worker. Invoked only inside the configured Linux
// distribution, never a Windows shell. Its stdin lifetime belongs to the client.
#include "dimension/json.hpp"
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <iostream>
#include <regex>
#include <string>
#include <thread>
#include <vector>
using dimension::Json;
using O=Json::Object;
using namespace std::chrono_literals;
namespace {
std::atomic_bool cancelled=false;
struct Result{int code;std::string output;};
void signal_stop(int){cancelled=true;}
Result command(std::vector<std::string> arguments,std::chrono::seconds timeout=30s){
    if(cancelled)return {-2,{}};
    std::vector<char*> argv;for(auto& arg:arguments)argv.push_back(arg.data());argv.push_back(nullptr);
    std::vector<std::string> environment{"PATH=/usr/bin:/bin","HOME=/root","DEBIAN_FRONTEND=noninteractive","LC_ALL=C"};
    std::vector<char*> envp;for(auto& item:environment)envp.push_back(item.data());envp.push_back(nullptr);
    int out[2];if(pipe2(out,O_CLOEXEC)<0)throw std::runtime_error("pipe_failed");
    pid_t pid=fork();if(pid<0){close(out[0]);close(out[1]);throw std::runtime_error("fork_failed");}
    if(!pid){
        setsid();int input=open("/dev/null",O_RDONLY);if(input>=0){dup2(input,STDIN_FILENO);close(input);}
        dup2(out[1],STDOUT_FILENO);dup2(out[1],STDERR_FILENO);close(out[0]);close(out[1]);
        // The lifetime watcher is a second thread. Do not allocate or acquire
        // libc environment locks between fork and exec.
        execve(argv[0],argv.data(),envp.data());_exit(127);
    }
    close(out[1]);fcntl(out[0],F_SETFL,fcntl(out[0],F_GETFL)|O_NONBLOCK);
    const auto end=std::chrono::steady_clock::now()+timeout;bool killed=false,done=false,eof=false;int status=0;
    auto deadline=end;std::string output;char bytes[4096];
    while(!done||!eof){
        const auto now=std::chrono::steady_clock::now();
        if(!done&&(cancelled||now>=end)&&!killed){kill(-pid,SIGTERM);killed=true;deadline=now+3s;}
        if(!done&&killed&&now>=deadline)kill(-pid,SIGKILL);
        pollfd descriptor{out[0],POLLIN|POLLHUP,0};poll(&descriptor,1,40);
        while(true){const auto count=read(out[0],bytes,sizeof bytes);if(count>0){if(output.size()<65536)output.append(bytes,std::min<std::size_t>(static_cast<std::size_t>(count),65536-output.size()));}else{if(!count)eof=true;break;}}
        if(!done&&waitpid(pid,&status,WNOHANG)==pid){done=true;deadline=std::chrono::steady_clock::now()+3s;}
        if(done&&!eof){kill(-pid,SIGTERM);if(std::chrono::steady_clock::now()>=deadline){kill(-pid,SIGKILL);break;}}
    }
    close(out[0]);if(!done)waitpid(pid,&status,0);
    if(killed)return {-2,{}};
    return {WIFEXITED(status)?WEXITSTATUS(status):128,output};
}
std::string trim(std::string value){while(!value.empty()&&(value.back()=='\n'||value.back()=='\r'||value.back()==' '))value.pop_back();return value;}
Json query(const std::string& package,const std::string& executable){
    const auto package_state=command({"/usr/bin/dpkg-query","-W","-f=${db:Status-Abbrev}\n${Version}",package});
    if(package_state.code==-2)return O{{"ok",false},{"code","interrupted"},{"uncertain",true}};
    if(package_state.code||!package_state.output.starts_with("ii "))return O{{"ok",true},{"installed",false},{"package",package}};
    const auto owner=command({"/usr/bin/dpkg-query","-S",executable});
    struct stat info{};
    const bool verified=owner.code==0&&owner.output.starts_with(package+": ")&&
        stat(executable.c_str(),&info)==0&&S_ISREG(info.st_mode)&&access(executable.c_str(),X_OK)==0;
    const auto split=package_state.output.find('\n');
    return O{{"ok",true},{"installed",true},{"verified",verified},{"package",package},
        {"version",split==std::string::npos?"":trim(package_state.output.substr(split+1))},{"executable",executable}};
}
Json execute(const Json& request){
    if(!request.is_object()||!request.find("package")||!request.find("executable")||!request.find("operation"))throw std::runtime_error("invalid_request");
    const auto package=request.at("package").as_string(),executable=request.at("executable").as_string(),op=request.at("operation").as_string();
    if(!std::regex_match(package,std::regex("[a-z0-9][a-z0-9+.-]{0,79}"))||
       !std::regex_match(executable,std::regex("/(usr/bin|usr/local/bin|bin|opt)/[A-Za-z0-9_./+-]{1,480}"))||
       executable.find("..")!=std::string::npos||executable.find("//")!=std::string::npos||
       (op!="query"&&op!="install"))throw std::runtime_error("invalid_package_or_executable");
    auto existing=query(package,executable);
    if(op=="query"||!existing.at("ok").as_bool())return existing;
    if(existing.at("installed").as_bool()){
        if(!existing.at("verified").as_bool())return O{{"ok",false},{"code","executable_not_owned_by_package"},{"uncertain",false}};
        auto data=existing.as_object();data["alreadyInstalled"]=true;return data;
    }
    if(geteuid()!=0)return O{{"ok",false},{"code","root_required"},{"uncertain",false}};
    const auto installed=command({"/usr/bin/apt-get","-y","--no-install-recommends","--no-remove","install",package},600s);
    if(installed.code)return O{{"ok",false},{"code",installed.code==-2?"interrupted":"package_install_failed"},
        {"exitCode",installed.code},{"uncertain",true}};
    auto checked=query(package,executable);
    if(!checked.at("ok").as_bool()||!checked.at("installed").as_bool()||!checked.at("verified").as_bool())
        return O{{"ok",false},{"code","post_install_verification_failed"},{"uncertain",true}};
    auto data=checked.as_object();data["alreadyInstalled"]=false;return data;
}
}
int main(){
    signal(SIGTERM,signal_stop);signal(SIGINT,signal_stop);signal(SIGHUP,signal_stop);signal(SIGPIPE,SIG_IGN);
    try{
        std::string line;char ch;
        while(read(STDIN_FILENO,&ch,1)==1&&ch!='\n'){line+=ch;if(line.size()>8192)throw std::runtime_error("request_too_large");}
        const auto request=Json::parse(line);
        std::jthread lifetime([](std::stop_token stop){char byte;while(!stop.stop_requested()){
            pollfd input{STDIN_FILENO,POLLIN|POLLHUP,0};if(poll(&input,1,100)>0&&read(STDIN_FILENO,&byte,1)<=0){cancelled=true;return;}
        }});
        auto result=execute(request);lifetime.request_stop();
        std::cout<<result.dump()<<'\n'<<std::flush;return 0;
    }catch(const std::exception& error){std::cout<<Json(O{{"ok",false},{"code",error.what()},{"uncertain",false}}).dump()<<'\n'<<std::flush;return 0;}
}
