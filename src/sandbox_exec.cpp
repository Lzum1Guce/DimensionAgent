#define NOMINMAX
#include "dimension/sandbox_exec.hpp"
#include "dimension/process_session.hpp"
#include "dimension/workspaces.hpp"
#include "dimension/managed_workspaces.hpp"
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cctype>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <vector>
namespace dimension {
namespace {
using O=Json::Object;
using A=Json::Array;
namespace fs=std::filesystem;
using namespace std::chrono_literals;
constexpr std::uint64_t output_file_limit=32U*1024U*1024U;
constexpr std::uint64_t tmpfs_size=16U*1024U*1024U;
std::wstring wide(const std::string& s){const auto n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),nullptr,0);if(!n&&!s.empty())throw std::runtime_error("UTF-8 参数无效");std::wstring w(n,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),w.data(),n);return w;}
std::string path_text(const fs::path& p){const auto value=p.u8string();return {reinterpret_cast<const char*>(value.data()),value.size()};}
std::string linux_path(const fs::path& p,const std::string& distribution=""){
    if(!distribution.empty())if(const auto key=managed_workspaces::key_from_windows(p,distribution))return managed_workspaces::linux_path(*key);
    const auto u=p.u8string();std::string s(u.begin(),u.end());std::replace(s.begin(),s.end(),'\\','/');if(s.size()<3||s[1]!=':'||s[2]!='/'||!isalpha(static_cast<unsigned char>(s[0])))throw std::runtime_error("Linux构建需要本机项目或匹配的WSL托管路径");return "/mnt/"+std::string(1,static_cast<char>(tolower(static_cast<unsigned char>(s[0]))))+s.substr(2);
}
std::string text(const Json& j,const char* key,std::string def={}){const auto p=j.find(key);return p?p->as_string():def;}
bool flag(const Json& j,const char* key){const auto p=j.find(key);return p&&p->is_bool()&&p->as_bool();}
fs::path native(const fs::path& p){auto value=fs::absolute(p).lexically_normal().wstring();if(value.starts_with(L"\\\\?\\"))return value;if(value.starts_with(L"\\\\"))return L"\\\\?\\UNC\\"+value.substr(2);return L"\\\\?\\"+value;}

class Handle final {
public:
    Handle()=default;explicit Handle(HANDLE value):value_(value){}
    ~Handle(){reset();}
    Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
    Handle(Handle&& other) noexcept:value_(std::exchange(other.value_,INVALID_HANDLE_VALUE)){}
    Handle& operator=(Handle&& other) noexcept{if(this!=&other)reset(std::exchange(other.value_,INVALID_HANDLE_VALUE));return *this;}
    HANDLE get()const{return value_;}
    explicit operator bool()const{return value_!=INVALID_HANDLE_VALUE&&value_!=nullptr;}
    void reset(HANDLE value=INVALID_HANDLE_VALUE){if(*this)CloseHandle(value_);value_=value;}
private:
    HANDLE value_=INVALID_HANDLE_VALUE;
};

class DirectoryChain final {
public:
    explicit DirectoryChain(const fs::path& root){
        const auto value=fs::absolute(root).lexically_normal();
        if(value.root_path().empty()||(value.root_name().wstring().starts_with(L"\\\\")&&!managed_workspaces::key_from_windows_any(value)))throw std::runtime_error("项目根需要本机目录或受管WSL工作区");
        fs::path current=value.root_path();
        if(value.root_name().wstring().starts_with(L"\\\\"))current=*managed_workspaces::root_from_windows_descendant(value);
        open(current);
        for(const auto& part:value.lexically_relative(current)){current/=part;open(current);}
    }
private:
    std::vector<Handle> directories_;
    void open(const fs::path& path){
        Handle handle(CreateFileW(native(path).c_str(),FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        BY_HANDLE_FILE_INFORMATION info{};
        if(!handle||!GetFileInformationByHandle(handle.get(),&info)||
           !(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))
            throw std::runtime_error("无法从磁盘根逐层锁定项目目录");
        directories_.push_back(std::move(handle));
    }
};

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

struct OpenOutput{Handle handle;std::uint64_t size=0;};
OpenOutput open_output(const fs::path& root,const std::string& relative){
    if(!relative_path(relative))throw std::runtime_error("成果必须是项目内相对文件路径");
    auto cursor=root;const auto parts=fs::path(wide(relative));
    for(auto part=parts.begin();part!=parts.end();++part){
        cursor/=*part;const auto attributes=GetFileAttributesW(native(cursor).c_str());
        if(attributes==INVALID_FILE_ATTRIBUTES)throw std::runtime_error("指定成果不存在");
        if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)throw std::runtime_error("成果路径不能经过符号链接或重解析点");
        if(std::next(part)!=parts.end()&&!(attributes&FILE_ATTRIBUTE_DIRECTORY))throw std::runtime_error("成果父路径不是目录");
    }
    Handle handle(CreateFileW(native(cursor).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr));
    if(!handle)throw std::runtime_error("无法打开指定成果");
    BY_HANDLE_FILE_INFORMATION info{};const auto type=GetFileType(handle.get());
    const bool described=GetFileInformationByHandle(handle.get(),&info);
    ULARGE_INTEGER size{};size.LowPart=info.nFileSizeLow;size.HighPart=info.nFileSizeHigh;
    const bool valid=described&&type==FILE_TYPE_DISK&&!(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&
        info.nNumberOfLinks==1&&size.QuadPart<=output_file_limit;
    if(!valid){if(size.QuadPart>output_file_limit)throw std::runtime_error("指定成果超过32 MiB上限");throw std::runtime_error("指定成果必须是工作区内单链接普通文件");}
    return {std::move(handle),size.QuadPart};
}

SandboxOutputFile snapshot_output(const fs::path& root,const std::string& relative,
                                  const fs::path& snapshot_root,std::size_t index){
    auto source=open_output(root,relative);
    const auto filename=fs::path(wide(relative)).filename().wstring();
    const auto destination=snapshot_root/(std::to_wstring(index)+L"-"+filename);
    Handle target(CreateFileW(native(destination).c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL|FILE_FLAG_SEQUENTIAL_SCAN,nullptr));
    if(!target)throw std::runtime_error("无法创建任务专属成果快照");
    try{
        std::vector<char> buffer(1024*1024);std::uint64_t total=0;
        for(;;){
            DWORD count=0;if(!ReadFile(source.handle.get(),buffer.data(),static_cast<DWORD>(buffer.size()),&count,nullptr))
                throw std::runtime_error("读取成果源句柄失败");
            if(!count)break;
            total+=count;if(total>source.size||total>output_file_limit)throw std::runtime_error("成果复制超过已核验大小");
            DWORD offset=0;while(offset<count){DWORD written=0;
                if(!WriteFile(target.get(),buffer.data()+offset,count-offset,&written,nullptr)||!written)
                    throw std::runtime_error("写入任务成果快照失败");offset+=written;}
        }
        if(total!=source.size||!FlushFileBuffers(target.get()))throw std::runtime_error("成果快照大小或落盘核验失败");
    }catch(...){const auto path=native(destination);target.reset();DeleteFileW(path.c_str());throw;}
    target.reset();source.handle.reset();
    if(!SetFileAttributesW(native(destination).c_str(),FILE_ATTRIBUTE_READONLY))throw std::runtime_error("无法固定任务成果快照");
    return {destination,source.size};
}

fs::path default_snapshot_root(const fs::path& data){
    static std::atomic<std::uint64_t> serial{0};
    return data/L"snapshots"/(std::to_wstring(GetCurrentProcessId())+L"-"+
        std::to_wstring(GetTickCount64())+L"-"+std::to_wstring(++serial));
}
}

SandboxOutputFile verify_sandbox_output(const fs::path& project,const std::string& relative){
    const auto root=WorkspaceBindings::validate_project(project,false);
    DirectoryChain chain(root);
    auto output=open_output(root,relative);
    return {root/fs::path(wide(relative)),output.size};
}

Json normalize_sandbox_transport(const Json& result,const Json& transport_exit){
    auto value=result.is_object()?result.as_object():O{};
    if(result.is_object()&&result.find("noSideEffects"))value["noSideEffects"]=flag(result,"noSideEffects");
    else value["noSideEffects"]=false; // A launched/lost transport is never proof of no side effects.
    if(!transport_exit.is_null())value["transportExit"]=transport_exit;
    const bool exited=transport_exit.is_object()&&flag(transport_exit,"ok");
    if(!exited){
        const auto* error_value=transport_exit.is_object()?transport_exit.find("error"):nullptr;
        const auto error=error_value&&error_value->is_object()?text(*error_value,"code"):"";
        if(result.is_object()&&result.find("code"))value["executionCode"]=text(result,"code");
        value["ok"]=false;value["uncertain"]=true;value["transportCleanupConfirmed"]=false;
        value["code"]=error=="cleanup_failed"?"transport_cleanup_failed":transport_exit.is_null()?"executor_disconnected":"transport_exit_failed";
        return value;
    }
    if(!result.is_object()){
        value["ok"]=false;value["uncertain"]=true;value["transportCleanupConfirmed"]=true;
        value["code"]="executor_disconnected";return value;
    }
    if(!result.find("ok")||!result.at("ok").is_bool()){
        value["ok"]=false;value["uncertain"]=true;value["transportCleanupConfirmed"]=true;
        value["code"]="invalid_executor_result";return value;
    }
    value["transportCleanupConfirmed"]=true;return value;
}

SandboxExecutor::SandboxExecutor(SandboxExecOptions options):options_(std::move(options)){fs::create_directories(options_.data);}
bool SandboxExecutor::available() const{
    auto supervisor=options_.helper;supervisor.replace_filename(L"dimension-sandbox-root.sh");
    return !options_.distribution.empty()&&fs::is_regular_file(options_.wsl)&&fs::is_regular_file(options_.helper)&&fs::is_regular_file(supervisor);
}
Json SandboxExecutor::execute(const fs::path& project,bool network,const Json& request,std::stop_token stop,
                              const fs::path& task_snapshot_root, bool wait_for_slot){
    if(!available())throw std::runtime_error("Linux构建运行环境未配置");
    if(network && !options_.allow_network_mode)return O{{"ok",false},{"code","network_access_unavailable"},{"networkRequested",true},
        {"networkAccess",false},{"networkPolicy","isolated-loopback-only"},{"noSideEffects",true},{"uncertain",false}};
    const bool enable_net = network && options_.allow_network_mode;
    if(!request.is_object())throw std::runtime_error("构建参数必须是对象");
    for(const auto& [key,value]:request.as_object()){(void)value;if(key!="argv"&&key!="cwd"&&key!="timeoutSeconds"&&key!="cpuSeconds"&&key!="outputs")throw std::runtime_error("未知构建参数");}
    const auto* arguments=request.find("argv");
    if(!arguments||!arguments->is_array()||arguments->as_array().empty()||arguments->as_array().size()>64)throw std::runtime_error("argv需要1至64个参数");
    size_t total=0;
    for(const auto& arg:arguments->as_array()){if(!arg.is_string()||arg.as_string().find('\0')!=std::string::npos||arg.as_string().size()>16384)throw std::runtime_error("命令参数无效");total+=arg.as_string().size();}
    const auto executable=arguments->as_array().front().as_string();
    if(total>65536||executable.empty()||executable.front()!='/')throw std::runtime_error("请提供Linux绝对程序路径，例如/usr/bin/npm");
    const auto cwd=text(request,"cwd",".");
    if(!relative_path(cwd,true))throw std::runtime_error("cwd必须是项目内相对目录");
    const double timeout=request.find("timeoutSeconds")?request.at("timeoutSeconds").as_number():120;
    if(!std::isfinite(timeout)||timeout<1||timeout>600||floor(timeout)!=timeout)throw std::runtime_error("执行时限须为1至600秒整数");
    const double cpu=request.find("cpuSeconds")?request.at("cpuSeconds").as_number():std::min(timeout,60.0);
    if(!std::isfinite(cpu)||cpu<1||cpu>timeout||floor(cpu)!=cpu)throw std::runtime_error("CPU时限须为1至执行时限的整数秒");
    std::vector<std::string> outputs;
    if(const auto* files=request.find("outputs")){
        if(!files->is_array()||files->as_array().size()>32)throw std::runtime_error("成果路径最多32个");
        for(const auto& file:files->as_array()){
            if(!file.is_string()||!relative_path(file.as_string()))throw std::runtime_error("成果必须是项目内相对文件路径");
            outputs.push_back(file.as_string());
        }
    }
    if(stop.stop_requested())return O{{"ok",false},{"cancelled",true},{"noSideEffects",true}};

    const std::size_t max_conc = std::max<std::size_t>(1, options_.max_concurrency);
    std::unique_lock admission_lock(admission_mutex_);
    if(!wait_for_slot && active_executions_ >= max_conc) return O{{"ok",false},{"code","executor_busy"}};
    if(!admission_changed_.wait(admission_lock,stop,[this,max_conc]{return active_executions_ < max_conc;})||stop.stop_requested())
        return O{{"ok",false},{"cancelled",true},{"code","admission_cancelled"},{"noSideEffects",true}};
    ++active_executions_;admission_lock.unlock();
    const auto admission_guard=std::shared_ptr<void>(nullptr,[this](void*){
        {std::lock_guard guard(admission_mutex_);if(active_executions_>0)--active_executions_;}admission_changed_.notify_all();});

    const auto root=WorkspaceBindings::validate_project(project,false);
    const bool managed=managed_workspaces::key_from_windows(root,options_.distribution).has_value();
    DirectoryChain project_chain(root); // Held through execution, snapshot and return. No DELETE sharing.
    auto supervisor=options_.helper;supervisor.replace_filename(L"dimension-sandbox-root.sh");
    static std::atomic<std::uint64_t> cgroup_serial{0};
    const auto cgroup_name="dimension-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64())+"-"+std::to_string(++cgroup_serial);
    std::vector<std::wstring> args{L"-d",wide(options_.distribution),L"-u",L"root",L"--exec",wide(linux_path(supervisor)),wide(cgroup_name),
        L"2147483648",L"200000",L"100000",L"512"};
    if(managed){
        const auto launcher=options_.helper.parent_path()/L"dimension-userns.py";
        if(!fs::is_regular_file(launcher))throw std::runtime_error("托管工作区身份映射助手未安装");
        args.insert(args.end(),{L"/usr/bin/python3",wide(linux_path(launcher)),L"--unshare-ipc",L"--unshare-pid",L"--unshare-uts",L"--unshare-cgroup"});
        if(!enable_net)args.push_back(L"--unshare-net");
    }else{
        args.insert(args.end(),{L"/usr/bin/bwrap",L"--unshare-all"});
        if(enable_net)args.push_back(L"--share-net");
    }
    args.insert(args.end(),{L"--die-with-parent",L"--new-session",L"--as-pid-1"});
    auto add=[&](std::initializer_list<std::wstring> entries){args.insert(args.end(),entries.begin(),entries.end());};
    for(const auto* leaf:{L"passwd",L"group",L"hosts",L"resolv.conf",L"nsswitch.conf",L"ssl"}){std::wstring file=std::wstring(L"/etc/")+leaf;add({L"--ro-bind",file,file});}
    for(const auto* leaf:{L"alternatives",L"ld.so.cache",L"localtime"}){std::wstring file=std::wstring(L"/etc/")+leaf;add({L"--ro-bind-try",file,file});}
    if(options_.allow_network_mode)add({L"--ro-bind-try",L"/opt/dimension-tools",L"/opt/dimension-tools"});
    const std::wstring sandbox_path_env = options_.allow_network_mode ? L"/opt/dimension-tools/bin:/usr/bin:/bin" : L"/usr/bin:/bin";
    add({L"--ro-bind",L"/usr",L"/usr",
         L"--symlink",L"usr/bin",L"/bin",L"--symlink",L"usr/sbin",L"/sbin",
         L"--symlink",L"usr/lib",L"/lib",L"--symlink",L"usr/lib64",L"/lib64",
         L"--proc",L"/proc",L"--dev",L"/dev",
         // One filesystem enforces a combined hard limit. Symlinking the
         // temporary directories avoids independent per-mount allowances.
         L"--size",std::to_wstring(tmpfs_size),L"--tmpfs",L"/dev/shm",
         L"--dir",L"/dev/shm/tmp",L"--dir",L"/dev/shm/home/bot",
         L"--dir",L"/dev/shm/run/user/1000",
         L"--symlink",L"/dev/shm/tmp",L"/tmp",
         L"--symlink",L"/dev/shm/home",L"/home",
         L"--symlink",L"/dev/shm/run",L"/run",
         L"--bind",wide(linux_path(root,options_.distribution)),L"/workspace",
         L"--ro-bind",wide(linux_path(options_.helper)),L"/dimension-exec-helper",
         L"--uid",L"1000",L"--gid",managed?L"1002":L"1000",L"--cap-drop",L"ALL",L"--clearenv",
         L"--setenv",L"PATH",sandbox_path_env,L"--setenv",L"HOME",L"/home/bot",
         L"--setenv",L"USER",L"bot",L"--setenv",L"LOGNAME",L"bot",L"--setenv",L"LANG",L"C.UTF-8",
         L"--setenv",L"TMPDIR",L"/tmp",L"--setenv",L"XDG_RUNTIME_DIR",L"/run/user/1000",L"--chdir",L"/workspace",L"/dimension-exec-helper"});
    struct Reply{std::mutex mutex;std::condition_variable_any changed;Json value;bool exited=false;};
    auto reply=std::make_shared<Reply>();
    JsonProcessSession process(options_.wsl,args,options_.data,[reply](const Json& line){
        std::lock_guard lock(reply->mutex);if(text(line,"event")=="result")reply->value=line;else if(text(line,"event")=="exit")reply->exited=true;reply->changed.notify_all();}, {}, true);
    if(!process.send(O{{"argv",*arguments},{"cwd",cwd},{"timeoutSeconds",timeout},{"cpuSeconds",cpu},{"outputs",request.find("outputs")?*request.find("outputs"):Json(A{})}})){
        process.close();auto failed=normalize_sandbox_transport({},process.transport_exit()).as_object();
        failed["code"]="executor_input_failed";return failed;
    }
    Json result;
    {std::unique_lock lock(reply->mutex);reply->changed.wait_for(lock,stop,std::chrono::seconds(static_cast<int>(timeout)+8),[&]{return !reply->value.is_null()||reply->exited;});result=reply->value;}
    process.close();
    auto value=normalize_sandbox_transport(result,process.transport_exit()).as_object();
    if(stop.stop_requested())value["cancelled"]=true;
    if(value["ok"].as_bool())try{
        A snapshots;
        if(!outputs.empty()){
            const auto snapshot_root=WorkspaceBindings::validate_project(
                task_snapshot_root.empty()?default_snapshot_root(options_.data):task_snapshot_root,true);
            for(std::size_t index=0;index<outputs.size();++index){
                const auto file=snapshot_output(root,outputs[index],snapshot_root,index);
                snapshots.push_back(O{{"path",outputs[index]},{"sizeBytes",static_cast<double>(file.size_bytes)},{"snapshot",path_text(file.path)}});
            }
        }
        value["outputSnapshots"]=snapshots;value["hostOutputsVerified"]=true;
    }catch(const std::exception&){value["ok"]=false;value["code"]="output_host_validation_failed";value["hostOutputsVerified"]=false;}
    value["networkRequested"]=network;value["networkAccess"]=enable_net;
    value["networkPolicy"]=enable_net?"sandbox-shared-network":"isolated-loopback-only";
    value["concurrencyAdmission"]=max_conc>1?"bounded-parallel":"serialized-per-executor";
    value["concurrencyLimit"]=static_cast<double>(max_conc);
    value["aggregateResourceControl"]=std::string("cgroup-v2: 2 GiB memory with swap disabled, 2 CPUs and 512 PIDs per execution; ")+(managed?"448 MiB managed ext4 group quota":"no workspace-write quota for legacy DrvFs");
    value["aggregateMemoryBytes"]=2147483648.0;value["aggregateCpuCount"]=2;value["aggregatePidLimit"]=512;value["workspaceWriteQuota"]=managed;
    value["workspaceStorage"]=managed?"managed-wsl-ext4":"legacy-windows-drvfs";
    if(managed)value["workspaceWriteQuotaBytes"]=448.0*1024.0*1024.0;
    value["tmpfsLimits"]="16 MiB combined hard quota for /tmp, ephemeral /home, /run and /dev/shm";
    value["combinedTmpfsBytes"]=static_cast<double>(tmpfs_size);
    value["workspace"]="/workspace";value["ephemeralHome"]=true;return value;
}
}
