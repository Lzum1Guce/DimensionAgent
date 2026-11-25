// Original Win32/WebView2 client. UI content and third-party runtime notices
// remain separate; no legacy application host or backend is loaded.
#define NOMINMAX
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <winreg.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include "dimension/json.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cwctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {
namespace fs=std::filesystem;
using dimension::Json;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
constexpr UINT ready_message=WM_APP+21,failed_message=WM_APP+22,tray_message=WM_APP+23,notification_message=WM_APP+24,shell_pick_message=WM_APP+25,splash_frame_message=WM_APP+26;
constexpr UINT show_command=4001,hide_command=4002,exit_command=4003;
constexpr UINT system_exit_command=0x1400;
constexpr wchar_t title[]=L"维度 Agent";
struct Handle {
    HANDLE value=nullptr;
    Handle()=default;
    explicit Handle(HANDLE v):value(v){}
    ~Handle(){reset();}
    Handle(const Handle&)=delete;
    Handle& operator=(const Handle&)=delete;
    void reset(HANDLE v=nullptr){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);value=v;}
    HANDLE release(){auto v=value;value=nullptr;return v;}
};
std::wstring widen(std::string_view text){
    if(text.empty())return {};
    int length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);
    if(length<=0)throw std::runtime_error("Invalid UTF-8 configuration");
    std::wstring result(length,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),length);return result;
}
std::string narrow(std::wstring_view text){
    if(text.empty())return {};
    int length=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
    if(length<=0)throw std::runtime_error("Invalid UTF-16 configuration");
    std::string result(length,'\0');WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),length,nullptr,nullptr);return result;
}
std::string field(const Json&j,std::string_view key){const auto v=j.find(key);return v&&v->is_string()?v->as_string():std::string{};}
std::wstring quote(std::wstring_view text){
    std::wstring result=L"\"";std::size_t slashes=0;
    for(wchar_t c:text){
        if(c==L'\\'){++slashes;continue;}
        if(c==L'"'){result.append(slashes*2+1,L'\\');result+=c;}
        else{result.append(slashes,L'\\');result+=c;}
        slashes=0;
    }
    result.append(slashes*2,L'\\');return result+L'"';
}
struct Configuration {
    fs::path file,backend,ui,data,loader,icon,splash,node,plugin_host,helper;
    std::string distro,home;
    unsigned debug_port=0;
    bool background=false,quit=false;
};
Configuration configuration(){
    wchar_t module[32768]{};if(!GetModuleFileNameW(nullptr,module,32768))throw std::runtime_error("Cannot locate client");
    Configuration c;c.file=fs::path(module).parent_path()/L"native-client.json";
    int count=0;auto arguments=CommandLineToArgvW(GetCommandLineW(),&count);
    for(int i=1;i<count;++i){
        const std::wstring arg=arguments[i];
        if(arg==L"--background")c.background=true;
        else if(arg==L"--quit")c.quit=true;
        else if(arg==L"--config"&&i+1<count)c.file=fs::absolute(arguments[++i]);
        else{LocalFree(arguments);throw std::runtime_error("Unknown desktop client option");}
    }
    LocalFree(arguments);
    auto read_cfg_json=[&](const fs::path& p)->Json{
        std::error_code ec;
        if(!fs::is_regular_file(p,ec)||fs::file_size(p,ec)>65536)throw std::runtime_error("Client configuration is missing or too large");
        std::ifstream in(p,std::ios::binary);if(!in)throw std::runtime_error("native-client.json is missing");
        std::string bytes((std::istreambuf_iterator<char>(in)),{});
        if(bytes.size()>=3&&static_cast<unsigned char>(bytes[0])==0xEF&&static_cast<unsigned char>(bytes[1])==0xBB&&static_cast<unsigned char>(bytes[2])==0xBF)
            bytes.erase(0,3);
        return Json::parse(bytes);
    };
    Json j;
    try{j=read_cfg_json(c.file);}catch(...){
        Sleep(40);
        try{j=read_cfg_json(c.file);}catch(...){
            const auto prev=c.file.parent_path()/L"native-client.prev.json";
            if(fs::is_regular_file(prev))j=read_cfg_json(prev);
            else throw;
        }
    }
    if(!j.is_object())throw std::runtime_error("Client configuration must be an object");
    const std::set<std::string> keys{"backend","ui","data","loader","icon","splash","node","pluginHost","desktopHelper","sandboxDistribution","desktopHomeRoot","debugPort"};
    for(const auto&[key,value]:j.as_object())if(!keys.contains(key))throw std::runtime_error("Unknown client configuration field");
    auto path=[&](const char*key,bool required=false){
        auto text=field(j,key);if(text.empty()){if(required)throw std::runtime_error("Missing client path");return fs::path{};}
        fs::path p=widen(text);return fs::absolute(p.is_absolute()?p:c.file.parent_path()/p).lexically_normal();
    };
    c.backend=path("backend",true);c.ui=path("ui",true);c.data=path("data",true);c.loader=path("loader",true);
    c.icon=path("icon");c.splash=path("splash");c.node=path("node");c.plugin_host=path("pluginHost");c.helper=path("desktopHelper");
    c.distro=field(j,"sandboxDistribution");c.home=field(j,"desktopHomeRoot");
    if(auto debug=j.find("debugPort")){if(!debug->is_number()||debug->as_number()<1024||debug->as_number()>65535||debug->as_number()!=std::floor(debug->as_number()))throw std::runtime_error("Invalid test debug port");c.debug_port=static_cast<unsigned>(debug->as_number());}
    if(!fs::is_regular_file(c.backend)||!fs::is_regular_file(c.loader)||!fs::is_regular_file(c.ui/L"index.html"))
        throw std::runtime_error("Client installation is incomplete");
    fs::create_directories(c.data);
    c.data=fs::weakly_canonical(c.data);
    return c;
}
struct Client {
    Configuration config;
    HWND window=nullptr;
    HICON icon=nullptr;
    Handle instance,job,process,input,output;
    std::jthread reader;
    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    struct BrowserTab {
        std::string id;
        ComPtr<ICoreWebView2Controller> controller;
        ComPtr<ICoreWebView2> webview;
        std::wstring pending_url;
        bool creating=false, ready=false, loading=false;
    };
    ComPtr<ICoreWebView2Environment> browser_environment;
    bool browser_env_creating=false;
    std::map<std::string,std::unique_ptr<BrowserTab>> browser_tabs;
    std::string active_browser_tab;
    RECT browser_bounds{0,0,0,0};
    bool browser_visible=false;
    static constexpr std::size_t max_browser_tabs=12;
    HMODULE loader=nullptr;
    std::unique_ptr<Gdiplus::Image> splash;
    std::unique_ptr<Gdiplus::Image> wordmark;
    HDC splash_mem_dc=nullptr;
    HBITMAP splash_dib=nullptr,splash_old_bmp=nullptr;
    int splash_dib_w=0,splash_dib_h=0;
    LARGE_INTEGER splash_qpc_start{},splash_qpc_freq{};
    std::jthread splash_vsync;
    std::atomic_bool splash_frame_pending{false};
    std::wstring class_name,origin;
    std::atomic_bool quitting=false;
    std::atomic<unsigned> port=0;
    std::atomic_bool loaded=false;
    bool tray_added=false,failed=false;
    std::mutex log_mutex;
    std::set<std::string> previews;
    std::map<std::string,std::wstring> preview_scopes;
    bool frame_resources_protected=false,placement_ready=false;
    std::string pref_language="zh-CN",pref_theme="paperlight";
    bool pref_close_to_tray=true,pref_remember_window=true;
    bool pref_notifications=true,pref_notification_merge=true;
    UINT taskbar_created=0,show_message=0,quit_message=0;
    int exit_code=0;
    NOTIFYICONDATAW tray{};
    static constexpr UINT merge_timer_first=2,merge_timer_last=7,display_timer=20,splash_timer=31;
    static constexpr std::size_t notification_queue_limit=128,display_queue_limit=32,seen_notification_limit=1024;
    static constexpr UINT proactive_merge_timer=7;
    struct TrayNotice {
        std::string kind,title,detail;
        std::set<std::string> run_ids,bot_names;
        bool overflow=false;
        std::size_t count()const{return run_ids.size();}
    };
    std::mutex notification_mutex;
    std::vector<std::string> notification_queue;
    unsigned notification_queue_overflow=0;
    std::map<std::string,TrayNotice> pending_notifications;
    std::deque<TrayNotice> display_notifications;
    std::deque<std::string> seen_notification_order;
    std::set<std::string> seen_notifications;
    std::optional<TrayNotice> active_notification;
    bool notification_display_active=false;
    struct FolderPickRequest { std::string id, dialog_title; };
    std::deque<FolderPickRequest> folder_pick_queue;
    bool folder_pick_active=false;
    explicit Client(Configuration c):config(std::move(c)){
        auto identity=config.data.wstring();
        std::transform(identity.begin(),identity.end(),identity.begin(),[](wchar_t c){return std::towlower(c);});
        const auto token=std::to_wstring(std::hash<std::wstring>{}(identity));
        class_name=L"DimensionAgent.Native."+token;
        instance.reset(CreateMutexW(nullptr,FALSE,(L"Local\\"+class_name).c_str()));
        const auto existing_instance=GetLastError()==ERROR_ALREADY_EXISTS;
        if(!instance.value)throw std::runtime_error("Cannot create client instance lock");
        show_message=RegisterWindowMessageW((class_name+L".Show").c_str());
        quit_message=RegisterWindowMessageW((class_name+L".Quit").c_str());
        if(existing_instance){
            auto existing=FindWindowW(class_name.c_str(),nullptr);
            if(!existing&&(config.quit||!config.background)) {
                for(unsigned retry=0;retry<40&&!existing;++retry){Sleep(50);existing=FindWindowW(class_name.c_str(),nullptr);}
            }
            if(existing&&config.quit){
                DWORD pid=0;GetWindowThreadProcessId(existing,&pid);Handle running(OpenProcess(SYNCHRONIZE,FALSE,pid));
                PostMessageW(existing,quit_message,0,0);
                if(running.value&&WaitForSingleObject(running.value,15000)==WAIT_TIMEOUT)throw std::runtime_error("Client shutdown is still in progress");
            }
            else if(existing&&!config.background){AllowSetForegroundWindow(ASFW_ANY);PostMessageW(existing,show_message,0,0);}
            throw std::runtime_error("already-running");
        }
        if(config.quit)throw std::runtime_error("already-running");
        taskbar_created=RegisterWindowMessageW(L"TaskbarCreated");
        if(!config.icon.empty())icon=static_cast<HICON>(LoadImageW(nullptr,config.icon.c_str(),IMAGE_ICON,0,0,LR_LOADFROMFILE|LR_DEFAULTSIZE));
        if(!icon)icon=LoadIconW(nullptr,IDI_APPLICATION);
        const auto wm_path=config.ui/L"startup-wordmark.png";
        if(fs::is_regular_file(wm_path)){
            wordmark=std::make_unique<Gdiplus::Image>(wm_path.c_str());
            if(wordmark->GetLastStatus()!=Gdiplus::Ok)wordmark.reset();
        }
        if(!wordmark&&!config.splash.empty()&&fs::is_regular_file(config.splash)){
            splash=std::make_unique<Gdiplus::Image>(config.splash.c_str());
            if(splash->GetLastStatus()!=Gdiplus::Ok)splash.reset();
        }
        load_prefs();
        if(resolved_theme()=="nightink"||resolved_theme()=="codex")splash.reset();
    }
    void release_splash_surface(){
        if(splash_mem_dc){
            if(splash_old_bmp)SelectObject(splash_mem_dc,splash_old_bmp);
            DeleteDC(splash_mem_dc);
            splash_mem_dc=nullptr;
        }
        if(splash_dib){DeleteObject(splash_dib);splash_dib=nullptr;}
        splash_old_bmp=nullptr;splash_dib_w=0;splash_dib_h=0;
    }
    void stop_splash_anim(){
        if(splash_vsync.joinable()){
            splash_vsync.request_stop();
            splash_vsync.join();
        }
        splash_frame_pending.store(false,std::memory_order_relaxed);
    }
    void start_splash_anim(HWND hwnd){
        QueryPerformanceFrequency(&splash_qpc_freq);
        QueryPerformanceCounter(&splash_qpc_start);
        stop_splash_anim();
        splash_vsync=std::jthread([this,hwnd](std::stop_token st){
            while(!st.stop_requested()&&!loaded.load(std::memory_order_acquire)&&!quitting.load(std::memory_order_acquire)){
                const HRESULT hr=DwmFlush();
                if(FAILED(hr)){
                    DWORD hz=60;
                    MONITORINFOEXW mi{};mi.cbSize=sizeof(mi);
                    if(GetMonitorInfoW(MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST),&mi)){
                        DEVMODEW dm{};dm.dmSize=sizeof(dm);
                        if(EnumDisplaySettingsW(mi.szDevice,ENUM_CURRENT_SETTINGS,&dm)&&dm.dmDisplayFrequency>=30&&dm.dmDisplayFrequency<=480)
                            hz=dm.dmDisplayFrequency;
                    }
                    Sleep(std::max<DWORD>(2,1000/hz));
                }
                if(st.stop_requested()||loaded.load(std::memory_order_acquire)||quitting.load(std::memory_order_acquire))break;
                bool expected=false;
                if(splash_frame_pending.compare_exchange_strong(expected,true,std::memory_order_acq_rel)){
                    if(!PostMessageW(hwnd,splash_frame_message,0,0)){
                        splash_frame_pending.store(false,std::memory_order_relaxed);
                        break;
                    }
                }
            }
        });
    }
    ~Client(){
        stop_splash_anim();
        release_splash_surface();
        stop();if(tray_added)Shell_NotifyIconW(NIM_DELETE,&tray);
        if(controller)controller->Close();
        webview.Reset();controller.Reset();environment.Reset();
        if(loader)FreeLibrary(loader);
        if(icon&&icon!=LoadIconW(nullptr,IDI_APPLICATION))DestroyIcon(icon);
    }
    void log(const char*message){
        std::lock_guard guard(log_mutex);
        SYSTEMTIME st{};GetLocalTime(&st);
        char ts[32]{};
        std::snprintf(ts,sizeof(ts),"%04u-%02u-%02uT%02u:%02u:%02u.%03u",
            st.wYear,st.wMonth,st.wDay,st.wHour,st.wMinute,st.wSecond,st.wMilliseconds);
        std::ofstream file(config.data/L"native-client.log",std::ios::app);
        file<<ts<<" ["<<GetTickCount64()<<"] "<<message<<"\n";
    }

    bool system_light() const {
        DWORD value=1,size=sizeof(value);
        if(RegGetValueW(HKEY_CURRENT_USER,L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            L"AppsUseLightTheme",RRF_RT_REG_DWORD,nullptr,&value,&size)!=ERROR_SUCCESS)return true;
        return value!=0;
    }
    std::string resolved_theme() const {
        if(pref_theme=="codex")return "codex";
        if(pref_theme=="codexlight")return "codexlight";
        if(pref_theme=="nightink")return "nightink";
        if(pref_theme=="warmamber")return "warmamber";
        if(pref_theme=="system")return system_light()?"paperlight":"nightink";
        return "paperlight";
    }
    COLORREF app_color() const {
        const auto t=resolved_theme();
        if(t=="codex")return RGB(13,14,17);
        if(t=="codexlight")return RGB(255,255,255);
        return t=="nightink"?RGB(25,23,21):(t=="warmamber"?RGB(246,243,237):RGB(250,249,245));
    }
    void load_prefs(){
        try{
            const auto path=config.data/L"client-settings.json";
            std::ifstream file(path,std::ios::binary);
            if(!file)return;
            file.seekg(0,std::ios::end);
            const auto size=file.tellg();
            if(size<=0||size>4096)return;
            std::string text(static_cast<std::size_t>(size),'\0');
            file.seekg(0);file.read(text.data(),static_cast<std::streamsize>(size));
            auto value=Json::parse(text);
            const auto language=field(value,"language");
            if(language=="en"||language=="zh-CN")pref_language=language;
            const auto theme=field(value,"theme");
            if(theme=="paperlight"||theme=="warmamber"||theme=="nightink"||theme=="codex"||theme=="codexlight"||theme=="system")pref_theme=theme;
            if(auto found=value.find("closeToTray");found&&found->is_bool())pref_close_to_tray=found->as_bool();
            if(auto found=value.find("rememberWindowPosition");found&&found->is_bool())pref_remember_window=found->as_bool();
            if(auto found=value.find("notificationsEnabled");found&&found->is_bool())pref_notifications=found->as_bool();
            if(auto found=value.find("notificationMerge");found&&found->is_bool())pref_notification_merge=found->as_bool();
        }catch(...){}
    }
    void save_prefs(){
        try{
            const auto path=config.data/L"client-settings.json";
            const auto temporary=config.data/L"client-settings.json.tmp";
            std::ofstream file(temporary,std::ios::binary|std::ios::trunc);
            if(!file)return;
            file<<"{\n  \"language\":\""<<pref_language<<"\",\n  \"theme\":\""<<pref_theme<<"\",\n"
                <<"  \"closeToTray\":"<<(pref_close_to_tray?"true":"false")<<",\n"
                <<"  \"rememberWindowPosition\":"<<(pref_remember_window?"true":"false")<<",\n"
                <<"  \"notificationsEnabled\":"<<(pref_notifications?"true":"false")<<",\n"
                <<"  \"notificationMerge\":"<<(pref_notification_merge?"true":"false")<<"\n}\n";
            file.close();if(!file){log("Client settings write failed");return;}
            if(!MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))
                log("Client settings save failed; previous file preserved");
        }catch(...){log("Client settings save exception; previous file preserved");}
    }
    void request_restart(){
        wchar_t module[32768]{};if(!GetModuleFileNameW(nullptr,module,32768))return;
        STARTUPINFOW info{sizeof(info)};PROCESS_INFORMATION process{};
        std::wstring command=L"\""+std::wstring(module)+L"\"";
        if(config.file.wstring().size())command+=L" --config \""+config.file.wstring()+L"\"";
        std::vector<wchar_t> line(command.begin(),command.end());line.push_back(0);
        if(CreateProcessW(module,line.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&info,&process)){
            CloseHandle(process.hThread);CloseHandle(process.hProcess);
            save_placement();stop();if(window)DestroyWindow(window);
        }
    }
    void hide_or_exit(){
        save_placement();
        if(pref_close_to_tray){ShowWindow(window,SW_HIDE);log("Window hidden; backend continues");}
        else{log("Window closed");stop();DestroyWindow(window);}
    }
    void apply_frame(){
        if(!window)return;
        const bool zoomed=IsZoomed(window)!=FALSE;
        const int corner=zoomed?1:2;
        DwmSetWindowAttribute(window,33,&corner,sizeof(corner));
        const auto theme=resolved_theme();
        const COLORREF border=zoomed?static_cast<COLORREF>(0xFFFFFFFE):(theme=="codex"?RGB(38,42,52):(theme=="codexlight"?RGB(224,227,233):(theme=="nightink"?RGB(63,58,51):RGB(217,211,200))));
        DwmSetWindowAttribute(window,34,&border,sizeof(border));
        MARGINS margins=zoomed?MARGINS{0,0,0,0}:MARGINS{0,0,0,1};
        DwmExtendFrameIntoClientArea(window,&margins);
    }
    void save_placement(){
        if(!placement_ready||!window)return;
        WINDOWPLACEMENT placement{sizeof(placement)};
        if(!GetWindowPlacement(window,&placement))return;
        bool maximized=IsZoomed(window)!=FALSE;
        if(!IsWindowVisible(window)||IsIconic(window))
            maximized=placement.showCmd==SW_SHOWMAXIMIZED||(placement.flags&WPF_RESTORETOMAXIMIZED);
        const RECT area=placement.rcNormalPosition;
        if((area.right-area.left)<200||(area.bottom-area.top)<200)return;
        try{
            std::error_code error;
            fs::create_directories(config.data,error);
            const auto path=config.data/L"window-placement.json";
            const auto temporary=config.data/L"window-placement.json.tmp";
            std::ofstream file(temporary,std::ios::binary|std::ios::trunc);
            if(!file)return;
            file<<"{\n  \"show\":\""<<(maximized?"maximized":"normal")<<"\",\n"
                <<"  \"left\":"<<area.left<<",\n  \"top\":"<<area.top<<",\n"
                <<"  \"right\":"<<area.right<<",\n  \"bottom\":"<<area.bottom<<"\n}\n";
            file.close();
            fs::rename(temporary,path,error);
            if(error){error.clear();fs::remove(path,error);error.clear();fs::rename(temporary,path,error);}
        }catch(...){}
    }
    bool restore_placement(){
        if(!pref_remember_window)return false;
        const auto path=config.data/L"window-placement.json";
        std::error_code error;
        if(!fs::is_regular_file(path,error))return false;
        try{
            std::ifstream file(path,std::ios::binary);
            if(!file)return false;
            file.seekg(0,std::ios::end);
            const auto size=file.tellg();
            if(size<=0||size>4096)return false;
            std::string text(static_cast<std::size_t>(size),'\0');
            file.seekg(0);file.read(text.data(),static_cast<std::streamsize>(size));
            auto value=Json::parse(text);
            auto number=[&](const char* key,int& out){
                const auto found=value.find(key);
                if(!found||!found->is_number())return false;
                out=static_cast<int>(found->as_number());
                return true;
            };
            int left=0,top=0,right=0,bottom=0;
            if(!number("left",left)||!number("top",top)||!number("right",right)||!number("bottom",bottom))return false;
            RECT area{left,top,right,bottom};
            if((area.right-area.left)<820)area.right=area.left+820;
            if((area.bottom-area.top)<540)area.bottom=area.top+540;
            if(!MonitorFromRect(&area,MONITOR_DEFAULTTONULL)){
                MONITORINFO monitor{sizeof(monitor)};
                if(!GetMonitorInfoW(MonitorFromRect(&area,MONITOR_DEFAULTTONEAREST),&monitor))return false;
                const int width=area.right-area.left,height=area.bottom-area.top;
                area.left=monitor.rcWork.left;
                area.top=monitor.rcWork.top;
                area.right=area.left+width;
                area.bottom=area.top+height;
            }
            WINDOWPLACEMENT placement{};
            placement.length=sizeof(placement);
            placement.showCmd=field(value,"show")=="maximized"?SW_SHOWMAXIMIZED:SW_SHOWNORMAL;
            placement.rcNormalPosition=area;
            if(!SetWindowPlacement(window,&placement))return false;
            apply_frame();
            return true;
        }catch(...){return false;}
    }
    void notify_state(){
        if(webview)webview->PostWebMessageAsJson(IsZoomed(window)?L"{\"source\":\"dimension-chrome\",\"isMaximized\":true}":L"{\"source\":\"dimension-chrome\",\"isMaximized\":false}");
    }
    void reveal(){
        log("Window revealed");
        ShowWindow(window,IsIconic(window)?SW_RESTORE:SW_SHOW);SetForegroundWindow(window);
        if(controller)controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
    void tray_icon(){
        tray={};tray.cbSize=sizeof(tray);tray.hWnd=window;tray.uID=1;tray.uFlags=NIF_ICON|NIF_MESSAGE|NIF_TIP;
        tray.uCallbackMessage=tray_message;tray.hIcon=icon;wcscpy_s(tray.szTip,title);
        tray_added=Shell_NotifyIconW(NIM_ADD,&tray)!=FALSE;
        tray.uVersion=NOTIFYICON_VERSION_4;if(tray_added)Shell_NotifyIconW(NIM_SETVERSION,&tray);
    }
    static UINT merge_timer_id(const std::string& kind){
        if(kind=="completed")return 2;
        if(kind=="partial")return 3;
        if(kind=="failed")return 4;
        if(kind=="resource")return 5;
        if(kind=="takeover")return 6;
        if(kind=="proactive-reminder")return proactive_merge_timer;
        return 0;
    }
    static void merge_tray_notice(TrayNotice& target,const TrayNotice& incoming){
        target.run_ids.insert(incoming.run_ids.begin(),incoming.run_ids.end());
        target.bot_names.insert(incoming.bot_names.begin(),incoming.bot_names.end());
    }
    static std::wstring tray_bot_names(const TrayNotice& notice){
        std::wstring names;
        for(const auto& name:notice.bot_names){if(!names.empty())names+=L"、";names+=widen(name);}
        return names;
    }
    void show_tray_notice(const TrayNotice& notice){
        if(!tray_added||!pref_notifications)return;
        const auto count=notice.count();
        const auto names=tray_bot_names(notice);
        std::wstring heading=widen(notice.title),body;
        if(notice.overflow){
            body=count?std::to_wstring(count)+L" 项任务的通知已合并；打开客户端查看全部任务记录":
                L"部分通知已合并；打开客户端查看全部任务记录";
        }else{
            if(count>1)heading=std::to_wstring(count)+L" 项"+heading;
            else if(!names.empty())heading+=L" · "+names;
            body=count>1?std::to_wstring(count)+L" 项任务"+(names.empty()?L"":L" · "+names)+L"；打开客户端查看记录":
                notice.detail.empty()?L"打开客户端查看任务记录":widen(notice.detail);
        }
        tray.uFlags=NIF_INFO;tray.dwInfoFlags=NIIF_INFO|NIIF_NOSOUND;
        wcsncpy_s(tray.szInfoTitle,heading.c_str(),_TRUNCATE);wcsncpy_s(tray.szInfo,body.c_str(),_TRUNCATE);
        Shell_NotifyIconW(NIM_MODIFY,&tray);
        log(("Background notification "+notice.kind+" count="+std::to_string(count)).c_str());
    }
    void pump_notifications(){
        if(!pref_notifications||notification_display_active)return;
        if(display_notifications.empty()){KillTimer(window,display_timer);return;}
        auto notice=std::move(display_notifications.front());display_notifications.pop_front();
        notification_display_active=true;active_notification=notice;
        show_tray_notice(notice);
        SetTimer(window,display_timer,15000,nullptr); // Fallback only; tray callbacks normally advance the queue.
    }
    void advance_notifications(){
        active_notification.reset();notification_display_active=false;
        pump_notifications();
    }
    void enqueue_tray_notice(TrayNotice notice){
        if(!pref_notifications)return;
        if(display_notifications.size()>=display_queue_limit){
            if(!display_notifications.back().overflow){
                TrayNotice summary;summary.kind="overflow";summary.title="通知合并提醒";summary.overflow=true;
                merge_tray_notice(summary,display_notifications.back());
                display_notifications.back()=std::move(summary);
            }
            merge_tray_notice(display_notifications.back(),notice);
            log(("Notification display queue full; coalesced count="+std::to_string(display_notifications.back().count())+"; open client").c_str());
            return;
        }
        display_notifications.push_back(std::move(notice));
        pump_notifications();
    }
    void receive_notification(const Json& notice){
        if(!pref_notifications||!notice.is_object())return;
        const auto kind=field(notice,"kind");
        if(kind=="resolve-waiting"){
            const auto run_id=field(notice,"runId");if(run_id.empty()||run_id.size()>512)return;
            for(const char* waiting_kind:{"takeover","resource"}){
                auto found=pending_notifications.find(waiting_kind);
                if(found==pending_notifications.end())continue;
                found->second.run_ids.erase(run_id);
                if(found->second.run_ids.empty()){
                    KillTimer(window,merge_timer_id(waiting_kind));pending_notifications.erase(found);
                }
            }
            for(auto it=display_notifications.begin();it!=display_notifications.end();){
                if(it->kind!="takeover"&&it->kind!="resource"){++it;continue;}
                it->run_ids.erase(run_id);
                if(it->run_ids.empty())it=display_notifications.erase(it);else ++it;
            }
            if(active_notification&&(active_notification->kind=="takeover"||active_notification->kind=="resource")&&
                active_notification->run_ids.contains(run_id)){
                active_notification->run_ids.erase(run_id);
                if(active_notification->run_ids.empty()){
                    log(("Background notification resolved "+active_notification->kind).c_str());
                    if(tray_added){tray.uFlags=NIF_INFO;tray.szInfoTitle[0]=L'\0';tray.szInfo[0]=L'\0';Shell_NotifyIconW(NIM_MODIFY,&tray);}
                    advance_notifications();
                }else show_tray_notice(*active_notification);
            }
            return;
        }
        const auto timer_id=merge_timer_id(kind);
        if(!timer_id)return;
        const auto id=field(notice,"id");
        auto run_id=field(notice,"runId");if(run_id.empty())run_id=id;
        if(id.empty()||id.size()>512||run_id.size()>512)return;
        TrayNotice incoming;incoming.kind=kind;incoming.title=field(notice,"title");incoming.detail=field(notice,"detail");
        const auto bot_name=field(notice,"botName");
        if(incoming.title.size()>80||bot_name.size()>160||incoming.detail.size()>1000)return;
        if(kind=="partial")incoming.title="部分交付";
        incoming.run_ids.insert(run_id);if(!bot_name.empty())incoming.bot_names.insert(bot_name);
        if(!seen_notifications.insert(id).second)return;
        seen_notification_order.push_back(id);
        if(seen_notification_order.size()>seen_notification_limit){
            seen_notifications.erase(seen_notification_order.front());seen_notification_order.pop_front();
        }
        if(!pref_notification_merge){enqueue_tray_notice(std::move(incoming));return;}
        auto found=pending_notifications.find(kind);
        if(found==pending_notifications.end()){
            pending_notifications.emplace(kind,std::move(incoming));
            SetTimer(window,timer_id,1800,nullptr); // Fixed from the first event of this kind.
        }else merge_tray_notice(found->second,incoming);
    }
    void drain_notifications(){
        std::vector<std::string> rows;unsigned overflow=0;
        {std::lock_guard lock(notification_mutex);rows.swap(notification_queue);overflow=notification_queue_overflow;notification_queue_overflow=0;}
        for(const auto& row:rows)try{receive_notification(Json::parse(row));}catch(...){}
        if(overflow&&pref_notifications){
            TrayNotice summary;summary.kind="overflow";summary.title="通知合并提醒";summary.detail="通知队列已满，部分提醒已合并";summary.overflow=true;
            enqueue_tray_notice(std::move(summary));
        }
    }
    void flush_notifications(UINT timer_id=0){
        for(auto it=pending_notifications.begin();it!=pending_notifications.end();){
            if(timer_id&&merge_timer_id(it->first)!=timer_id){++it;continue;}
            KillTimer(window,merge_timer_id(it->first));
            auto notice=std::move(it->second);it=pending_notifications.erase(it);
            enqueue_tray_notice(std::move(notice));
        }
    }
    void clear_notifications(){
        for(UINT timer=merge_timer_first;timer<=merge_timer_last;++timer)KillTimer(window,timer);
        KillTimer(window,display_timer);
        pending_notifications.clear();display_notifications.clear();active_notification.reset();notification_display_active=false;
        {std::lock_guard lock(notification_mutex);notification_queue.clear();notification_queue_overflow=0;}
    }
    void tray_menu(){
        HMENU menu=CreatePopupMenu();AppendMenuW(menu,MF_STRING,show_command,L"打开维度 Agent");
        AppendMenuW(menu,MF_STRING,hide_command,L"收起到后台");AppendMenuW(menu,MF_SEPARATOR,0,nullptr);
        AppendMenuW(menu,MF_STRING,exit_command,L"退出客户端并停止后台");
        POINT point;GetCursorPos(&point);SetForegroundWindow(window);
        const auto action=TrackPopupMenu(menu,TPM_RETURNCMD|TPM_NONOTIFY|TPM_RIGHTBUTTON,point.x,point.y,0,window,nullptr);
        DestroyMenu(menu);PostMessageW(window,WM_NULL,0,0);
        if(action)SendMessageW(window,WM_COMMAND,action,0);
    }
    void start_backend(){
        SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
        HANDLE read_input=nullptr,write_input=nullptr,read_output=nullptr,write_output=nullptr;
        if(!CreatePipe(&read_input,&write_input,&security,0))
            throw std::runtime_error("Cannot create backend pipes");
        Handle child_input(read_input);input.reset(write_input);
        if(!CreatePipe(&read_output,&write_output,&security,0))throw std::runtime_error("Cannot create backend output pipe");
        Handle child_output(write_output);output.reset(read_output);
        SetHandleInformation(input.value,HANDLE_FLAG_INHERIT,0);SetHandleInformation(output.value,HANDLE_FLAG_INHERIT,0);
        job.reset(CreateJobObjectW(nullptr,nullptr));if(!job.value)throw std::runtime_error("Cannot supervise backend");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("Cannot configure backend supervision");
        std::vector<std::wstring> arguments{config.backend.wstring(),L"--data",config.data.wstring(),L"--ui",config.ui.wstring(),L"--port",L"0"};
        auto add=[&](const wchar_t*key,const fs::path&value){if(!value.empty()){arguments.emplace_back(key);arguments.push_back(value.wstring());}};
        add(L"--node",config.node);add(L"--plugin-host",config.plugin_host);add(L"--desktop-helper",config.helper);
        if(!config.distro.empty()){arguments.emplace_back(L"--sandbox-distro");arguments.push_back(widen(config.distro));}
        if(!config.home.empty()){arguments.emplace_back(L"--desktop-home-root");arguments.push_back(widen(config.home));}
        std::wstring command;for(const auto&arg:arguments){if(!command.empty())command+=L' ';command+=quote(arg);}
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);
        std::vector<unsigned char> storage(size);auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if(!InitializeProcThreadAttributeList(attributes,1,0,&size))throw std::runtime_error("Cannot initialize process attributes");
        HANDLE inherited[]{child_input.value,child_output.value};
        if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr)){
            DeleteProcThreadAttributeList(attributes);throw std::runtime_error("Cannot limit inherited handles");
        }
        STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes;
        startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;startup.StartupInfo.wShowWindow=SW_HIDE;
        startup.StartupInfo.hStdInput=child_input.value;startup.StartupInfo.hStdOutput=child_output.value;startup.StartupInfo.hStdError=child_output.value;
        PROCESS_INFORMATION launched{};
        const auto okay=CreateProcessW(config.backend.c_str(),command.data(),nullptr,nullptr,TRUE,
            CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,nullptr,config.file.parent_path().c_str(),&startup.StartupInfo,&launched);
        DeleteProcThreadAttributeList(attributes);
        if(!okay)throw std::runtime_error("Cannot launch native backend");
        process.reset(launched.hProcess);Handle thread(launched.hThread);
        if(!AssignProcessToJobObject(job.value,process.value)){TerminateProcess(process.value,1);throw std::runtime_error("Cannot own native backend");}
        ResumeThread(thread.value);child_input.reset();child_output.reset();
        reader=std::jthread([this]{
            std::string buffer;char chunk[4096];DWORD size=0;
            while(ReadFile(output.value,chunk,sizeof(chunk),&size,nullptr)&&size){
                buffer.append(chunk,size);
                if(buffer.size()>65536){PostMessageW(window,failed_message,0,0);return;}
                while(buffer.find('\n')!=std::string::npos){
                    const auto end=buffer.find('\n');auto line=buffer.substr(0,end);buffer.erase(0,end+1);
                    try{auto value=Json::parse(line);auto p=value.find("port");auto ready=value.find("ready");
                        const auto notice=value.find("notification"),control=value.find("notificationControl");
                        const auto event=notice&&notice->is_object()?notice:control;
                        if(event&&event->is_object()){
                            bool overflow_started=false;
                            {std::lock_guard lock(notification_mutex);
                                if(notification_queue.size()<notification_queue_limit)notification_queue.push_back(event->dump());
                                else{++notification_queue_overflow;overflow_started=notification_queue_overflow==1;}
                            }
                            if(overflow_started)log("Notification queue full; coalescing overflow; open client");
                            PostMessageW(window,notification_message,0,0);continue;
                        }
                        if(ready&&ready->is_bool()&&ready->as_bool()&&p&&p->is_number()&&p->as_number()>0&&p->as_number()<=65535&&!port.load()){
                            port=static_cast<unsigned>(p->as_number());log(("Native service ready on 127.0.0.1:"+std::to_string(port.load())).c_str());PostMessageW(window,ready_message,0,0);
                        }
                    }catch(...){log("Backend emitted a startup diagnostic");}
                }
            }
            if(!quitting)PostMessageW(window,failed_message,0,0);
        });
        SetTimer(window,1,60000,nullptr);
    }
    void stop(){
        if(quitting.exchange(true))return;
        close_all_browser_tabs();
        KillTimer(window,1);clear_notifications();
        if(input.value){constexpr char command[]="shutdown\n";DWORD written=0;WriteFile(input.value,command,sizeof(command)-1,&written,nullptr);input.reset();}
        if(process.value&&WaitForSingleObject(process.value,10000)==WAIT_TIMEOUT){log("Backend did not stop within deadline");TerminateJobObject(job.value,1);WaitForSingleObject(process.value,2000);}
        if(reader.joinable()){CancelSynchronousIo(reader.native_handle());reader.join();}
        output.reset();process.reset();job.reset();
    }
    static bool is_safe_browser_url(const std::wstring& raw){
        if(raw.empty())return false;
        std::wstring lower=raw;
        std::transform(lower.begin(),lower.end(),lower.begin(),[](wchar_t c){return std::towlower(c);});
        return lower==L"about:blank"||lower.starts_with(L"http://")||lower.starts_with(L"https://");
    }
    bool is_main_backend_api_url(const std::wstring& raw)const{
        if(origin.empty())return false;
        if(raw==origin)return true;
        if(!raw.starts_with(origin+L"/"))return false;
        // Allow authorized local artifact preview routes (/v/<token>/), block control APIs/UI origin from untrusted browser tabs.
        return !raw.starts_with(origin+L"/v/");
    }
    void post_browser_msg(const Json& payload){
        if(!webview||quitting)return;
        try{webview->PostWebMessageAsJson(widen(payload.dump()).c_str());}catch(...){}
    }
    void push_browser_tab_state(const std::string& tab_id,const std::string& error_msg=""){
        auto it=browser_tabs.find(tab_id);
        if(it==browser_tabs.end()||!it->second)return;
        auto& tab=*it->second;
        std::string url_str,title_str;
        BOOL can_back=FALSE,can_fwd=FALSE;
        if(tab.webview){
            LPWSTR u=nullptr;if(SUCCEEDED(tab.webview->get_Source(&u))&&u){try{url_str=narrow(u);}catch(...){}CoTaskMemFree(u);}
            LPWSTR t=nullptr;if(SUCCEEDED(tab.webview->get_DocumentTitle(&t))&&t){try{title_str=narrow(t);}catch(...){}CoTaskMemFree(t);}
            tab.webview->get_CanGoBack(&can_back);
            tab.webview->get_CanGoForward(&can_fwd);
        }else if(!tab.pending_url.empty()){
            try{url_str=narrow(tab.pending_url);}catch(...){}
        }
        Json::Object obj{
            {"source","dimension-browser"},
            {"action","tab-state"},
            {"id",tab_id},
            {"url",url_str},
            {"title",title_str},
            {"loading",tab.loading},
            {"canGoBack",can_back!=FALSE},
            {"canGoForward",can_fwd!=FALSE}
        };
        if(!error_msg.empty())obj["error"]=error_msg;
        post_browser_msg(Json(std::move(obj)));
    }
    void sync_browser_layout(){
        RECT client{};
        if(!window||!GetClientRect(window,&client))return;
        RECT r=browser_bounds;
        r.left=std::clamp(r.left,client.left,client.right);
        r.right=std::clamp(r.right,r.left,client.right);
        r.top=std::clamp(r.top,client.top,client.bottom);
        r.bottom=std::clamp(r.bottom,r.top,client.bottom);
        const bool show_any=loaded&&browser_visible&&!IsIconic(window)&&(r.right-r.left>=16)&&(r.bottom-r.top>=16);
        for(auto& [id,tab]:browser_tabs){
            if(!tab||!tab->controller)continue;
            const bool active=show_any&&(id==active_browser_tab);
            if(active)tab->controller->put_Bounds(r);
            tab->controller->put_IsVisible(active?TRUE:FALSE);
        }
    }
    void close_browser_tab(const std::string& tab_id){
        auto it=browser_tabs.find(tab_id);
        if(it==browser_tabs.end())return;
        if(it->second&&it->second->controller){
            it->second->controller->put_IsVisible(FALSE);
            it->second->controller->Close();
        }
        browser_tabs.erase(it);
        if(active_browser_tab==tab_id)active_browser_tab.clear();
        sync_browser_layout();
    }
    void close_all_browser_tabs(){
        for(auto& [id,tab]:browser_tabs){
            (void)id;
            if(tab&&tab->controller){
                tab->controller->put_IsVisible(FALSE);
                tab->controller->Close();
            }
        }
        browser_tabs.clear();
        active_browser_tab.clear();
        browser_visible=false;
        browser_environment.Reset();
    }
    void ensure_browser_env(){
        if(browser_environment||browser_env_creating||!loader||quitting)return;
        using CreateEnvironment=HRESULT(STDAPICALLTYPE*)(PCWSTR,PCWSTR,ICoreWebView2EnvironmentOptions*,ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
        const auto create=reinterpret_cast<CreateEnvironment>(GetProcAddress(loader,"CreateCoreWebView2EnvironmentWithOptions"));
        if(!create)return;
        browser_env_creating=true;
        auto options=Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        const auto language=pref_language=="en"?L"en":L"zh-CN";
        options->put_Language(language);
        const auto profile=config.data/L"webview-browser-profile";
        const auto hr=create(nullptr,profile.c_str(),options.Get(),Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result,ICoreWebView2Environment* env)->HRESULT{
                browser_env_creating=false;
                if(quitting||FAILED(result)||!env){
                    if(!quitting)log("Embedded Work browser WebView2 environment failed to initialize");
                    return S_OK;
                }
                browser_environment=env;
                std::vector<std::string> pending_ids;
                for(const auto& [id,tab]:browser_tabs){
                    if(tab&&!tab->ready&&!tab->creating)pending_ids.push_back(id);
                }
                for(const auto& id:pending_ids)create_browser_tab_controller(id);
                return S_OK;
            }).Get());
        if(FAILED(hr))browser_env_creating=false;
    }
    void create_browser_tab_controller(const std::string& tab_id){
        auto it=browser_tabs.find(tab_id);
        if(it==browser_tabs.end()||!it->second||it->second->creating||it->second->ready)return;
        if(!browser_environment){ensure_browser_env();return;}
        it->second->creating=true;
        const auto on_ctrl=Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [this,tab_id](HRESULT result,ICoreWebView2Controller* ctrl)->HRESULT{
                if(quitting||FAILED(result)||!ctrl){
                    if(ctrl)ctrl->Close();
                    auto cur=browser_tabs.find(tab_id);
                    if(cur!=browser_tabs.end()&&cur->second){
                        cur->second->creating=false;
                        push_browser_tab_state(tab_id,"内置浏览器标签初始化失败");
                    }
                    return S_OK;
                }
                auto cur=browser_tabs.find(tab_id);
                if(cur==browser_tabs.end()||!cur->second){
                    ctrl->Close();
                    return S_OK;
                }
                auto& tab=*cur->second;
                tab.creating=false;
                tab.ready=true;
                tab.controller=ctrl;
                ctrl->get_CoreWebView2(&tab.webview);
                if(!tab.webview){
                    close_browser_tab(tab_id);
                    return S_OK;
                }
                ComPtr<ICoreWebView2Settings> settings;
                if(SUCCEEDED(tab.webview->get_Settings(&settings))&&settings){
                    settings->put_AreDefaultContextMenusEnabled(TRUE);
                    settings->put_IsStatusBarEnabled(FALSE);
                    settings->put_AreDevToolsEnabled(TRUE);
                    settings->put_IsWebMessageEnabled(FALSE);
                    settings->put_AreHostObjectsAllowed(FALSE);
                }
                {
                    ComPtr<ICoreWebView2Controller2> ctrl2;
                    if(SUCCEEDED(tab.controller.As(&ctrl2))&&ctrl2){
                        const auto bg=app_color();
                        ctrl2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{255,GetRValue(bg),GetGValue(bg),GetBValue(bg)});
                    }
                }
                tab.controller->put_IsVisible(FALSE);
                EventRegistrationToken tok{};
                // Block untrusted external pages in Work browser tabs from calling main backend APIs.
                tab.webview->AddWebResourceRequestedFilter(L"*",COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                tab.webview->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                    [this](ICoreWebView2*,ICoreWebView2WebResourceRequestedEventArgs* args)->HRESULT{
                        ComPtr<ICoreWebView2WebResourceRequest> req;
                        if(FAILED(args->get_Request(&req))||!req)return S_OK;
                        LPWSTR uri=nullptr;
                        if(FAILED(req->get_Uri(&uri)))return S_OK;
                        const std::wstring u=uri?uri:L"";CoTaskMemFree(uri);
                        const std::wstring ws_as_http=u.starts_with(L"ws://")?(L"http"+u.substr(2)):u;
                        if(is_main_backend_api_url(u)||is_main_backend_api_url(ws_as_http)){
                            ComPtr<ICoreWebView2WebResourceResponse> denied;
                            if(browser_environment&&SUCCEEDED(browser_environment->CreateWebResourceResponse(
                                nullptr,403,L"Blocked",L"Content-Type: text/plain\r\nCache-Control: no-store",&denied))){
                                args->put_Response(denied.Get());
                            }
                        }
                        return S_OK;
                    }).Get(),&tok);
                tab.webview->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                    [this,tab_id](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs* args)->HRESULT{
                        LPWSTR uri=nullptr;args->get_Uri(&uri);
                        const std::wstring u=uri?uri:L"";CoTaskMemFree(uri);
                        if(!is_safe_browser_url(u)||is_main_backend_api_url(u)){
                            args->put_Cancel(TRUE);
                            push_browser_tab_state(tab_id,"已拦截不受支持的链接协议或内部接口地址");
                            return S_OK;
                        }
                        if(auto found=browser_tabs.find(tab_id);found!=browser_tabs.end()&&found->second){
                            found->second->loading=true;
                        }
                        push_browser_tab_state(tab_id);
                        return S_OK;
                    }).Get(),&tok);
                tab.webview->add_SourceChanged(Callback<ICoreWebView2SourceChangedEventHandler>(
                    [this,tab_id](ICoreWebView2*,ICoreWebView2SourceChangedEventArgs*)->HRESULT{
                        push_browser_tab_state(tab_id);return S_OK;
                    }).Get(),&tok);
                tab.webview->add_HistoryChanged(Callback<ICoreWebView2HistoryChangedEventHandler>(
                    [this,tab_id](ICoreWebView2*,IUnknown*)->HRESULT{
                        push_browser_tab_state(tab_id);return S_OK;
                    }).Get(),&tok);
                tab.webview->add_DocumentTitleChanged(Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
                    [this,tab_id](ICoreWebView2*,IUnknown*)->HRESULT{
                        push_browser_tab_state(tab_id);return S_OK;
                    }).Get(),&tok);
                tab.webview->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                    [this,tab_id](ICoreWebView2*,ICoreWebView2NavigationCompletedEventArgs* args)->HRESULT{
                        if(auto found=browser_tabs.find(tab_id);found!=browser_tabs.end()&&found->second){
                            found->second->loading=false;
                        }
                        BOOL ok=FALSE;args->get_IsSuccess(&ok);
                        COREWEBVIEW2_WEB_ERROR_STATUS status=COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                        args->get_WebErrorStatus(&status);
                        std::string err;
                        if(!ok&&status!=COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED){
                            err="页面加载未完成 (错误码 " + std::to_string(static_cast<int>(status)) + ")";
                        }
                        push_browser_tab_state(tab_id,err);
                        return S_OK;
                    }).Get(),&tok);
                tab.webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                    [this](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs* args)->HRESULT{
                        args->put_Handled(TRUE);
                        LPWSTR uri=nullptr;args->get_Uri(&uri);
                        const std::wstring u=uri?uri:L"";CoTaskMemFree(uri);
                        if(is_safe_browser_url(u)&&!is_main_backend_api_url(u)){
                            try{
                                post_browser_msg(Json(Json::Object{
                                    {"source","dimension-browser"},
                                    {"action","new-tab-request"},
                                    {"url",narrow(u)}
                                }));
                            }catch(...){}
                        }
                        return S_OK;
                    }).Get(),&tok);
                sync_browser_layout();
                if(!tab.pending_url.empty()&&is_safe_browser_url(tab.pending_url)&&!is_main_backend_api_url(tab.pending_url)){
                    tab.loading=true;
                    tab.webview->Navigate(tab.pending_url.c_str());
                }
                push_browser_tab_state(tab_id);
                return S_OK;
            });
        const auto language=pref_language=="en"?L"en":L"zh-CN";
        ComPtr<ICoreWebView2Environment10> env10;
        ComPtr<ICoreWebView2ControllerOptions> ctrl_opts;
        if(SUCCEEDED(browser_environment.As(&env10))&&SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&ctrl_opts))){
            ComPtr<ICoreWebView2ControllerOptions2> loc_opts;
            if(SUCCEEDED(ctrl_opts.As(&loc_opts)))loc_opts->put_ScriptLocale(language);
            env10->CreateCoreWebView2ControllerWithOptions(window,ctrl_opts.Get(),on_ctrl.Get());
        }else{
            browser_environment->CreateCoreWebView2Controller(window,on_ctrl.Get());
        }
    }
    void capture_browser_context(const std::string& tab_id,const std::string& req_id){
        auto it=browser_tabs.find(tab_id);
        if(it==browser_tabs.end()||!it->second||!it->second->webview){
            post_browser_msg(Json(Json::Object{
                {"source","dimension-browser"},{"action","context-captured"},{"id",tab_id},{"reqId",req_id},{"ok",false}
            }));
            return;
        }
        static constexpr wchar_t kExtractScript[]=
            L"(()=>{try{const sel=(window.getSelection?String(window.getSelection()):'').trim().slice(0,1800);"
            L"const txt=(document.body?(document.body.innerText||''):'').replace(/\\s+/g,' ').trim().slice(0,2600);"
            L"return {title:String(document.title||'').slice(0,240),url:String(location.href||'').slice(0,2048),selection:sel,text:txt};}"
            L"catch(e){return {title:'',url:String(location.href||''),selection:'',text:''};}})()";
        it->second->webview->ExecuteScript(kExtractScript,Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this,tab_id,req_id](HRESULT hr,LPCWSTR result_json)->HRESULT{
                if(quitting)return S_OK;
                Json ctx;
                bool ok=false;
                if(SUCCEEDED(hr)&&result_json){
                    try{ctx=Json::parse(narrow(result_json));ok=ctx.is_object();}catch(...){}
                }
                post_browser_msg(Json(Json::Object{
                    {"source","dimension-browser"},{"action","context-captured"},
                    {"id",tab_id},{"reqId",req_id},{"ok",ok},{"context",ok?ctx:Json::Object{}}
                }));
                return S_OK;
            }).Get());
    }
    void handle_browser_message(const Json& data,const std::string& action){
        if(action=="hello"||action=="ping"){
            post_browser_msg(Json(Json::Object{{"source","dimension-browser"},{"action","ready"},{"native",true}}));
            return;
        }
        if(action=="set-bounds"){
            auto num=[&](std::string_view k)->LONG{
                const auto v=data.find(k);
                return (v&&v->is_number())?static_cast<LONG>(std::lround(v->as_number())):0;
            };
            const LONG x=num("x"),y=num("y"),w=num("width"),h=num("height");
            const auto vis=data.find("visible");
            browser_visible=(vis&&vis->is_bool())?vis->as_bool():false;
            browser_bounds=RECT{x,y,x+std::max<LONG>(0,w),y+std::max<LONG>(0,h)};
            const auto id=field(data,"id");
            if(!id.empty())active_browser_tab=id;
            sync_browser_layout();
            return;
        }
        const auto id=field(data,"id");
        if(id.empty()||id.size()>64)return;
        if(action=="create"||action=="navigate"){
            const auto raw_url=field(data,"url");
            std::wstring wurl;
            try{wurl=widen(raw_url);}catch(...){return;}
            if(wurl.empty())wurl=L"about:blank";
            if(!is_safe_browser_url(wurl)||is_main_backend_api_url(wurl)){
                push_browser_tab_state(id,"仅支持打开 http:// 或 https:// 网页地址");
                return;
            }
            auto it=browser_tabs.find(id);
            if(it==browser_tabs.end()){
                if(browser_tabs.size()>=max_browser_tabs){
                    push_browser_tab_state(id,"已达同时打开网页标签上限");
                    return;
                }
                auto tab=std::make_unique<BrowserTab>();
                tab->id=id;
                tab->pending_url=wurl;
                browser_tabs.emplace(id,std::move(tab));
                if(action=="create"&&data.find("activate")&&data.at("activate").is_bool()&&data.at("activate").as_bool()){
                    active_browser_tab=id;
                }
                create_browser_tab_controller(id);
            }else if(it->second){
                it->second->pending_url=wurl;
                if(it->second->webview){
                    it->second->loading=true;
                    it->second->webview->Navigate(wurl.c_str());
                    push_browser_tab_state(id);
                }else if(!it->second->creating){
                    create_browser_tab_controller(id);
                }
            }
            sync_browser_layout();
            return;
        }
        if(action=="activate"){
            active_browser_tab=id;
            sync_browser_layout();
            push_browser_tab_state(id);
            return;
        }
        if(action=="close"){
            close_browser_tab(id);
            return;
        }
        auto it=browser_tabs.find(id);
        if(it==browser_tabs.end()||!it->second||!it->second->webview)return;
        if(action=="go-back"){it->second->webview->GoBack();return;}
        if(action=="go-forward"){it->second->webview->GoForward();return;}
        if(action=="reload"){it->second->webview->Reload();return;}
        if(action=="stop"){it->second->webview->Stop();return;}
        if(action=="open-devtools"){it->second->webview->OpenDevToolsWindow();return;}
        if(action=="open-external"){
            LPWSTR uri=nullptr;
            if(SUCCEEDED(it->second->webview->get_Source(&uri))&&uri){
                const std::wstring u(uri);CoTaskMemFree(uri);
                if(is_safe_browser_url(u)&&u!=L"about:blank")ShellExecuteW(window,L"open",u.c_str(),nullptr,nullptr,SW_SHOWNORMAL);
            }
            return;
        }
        if(action=="capture-context"){
            capture_browser_context(id,field(data,"reqId"));
            return;
        }
    }
    bool local(const std::wstring&url)const{return url==origin||url.starts_with(origin+L"/");}
    bool frame_local(const std::wstring& url) const {
        if(url==L"about:blank"||local(url))return true;
        for(const auto& [id,scope]:preview_scopes){(void)id;if(url.starts_with(scope))return true;}
        return false;
    }
    void on_message(ICoreWebView2WebMessageReceivedEventArgs*args){
        LPWSTR source=nullptr,raw=nullptr;
        if(FAILED(args->get_Source(&source)))return;
        const bool trusted=local(source?source:L"");CoTaskMemFree(source);if(!trusted)return;
        if(FAILED(args->get_WebMessageAsJson(&raw)))return;
        try{
            auto data=Json::parse(narrow(raw?raw:L""));CoTaskMemFree(raw);raw=nullptr;
            const auto from=field(data,"source"),action=field(data,"action");
            if(from=="dimension-browser"){
                handle_browser_message(data,action);
                return;
            }
            if(from=="dimension-preview"){
                const auto id=field(data,"id");if(id.empty()||id.size()>128)return;
                if(action=="open"){
                    previews.insert(id);
                    const auto url=field(data,"url");
                    // Only the trusted top-level UI can grant a local preview.
                    const auto marker=url.find("/v/"),slash=url.find_last_of('/');
                    bool valid=frame_resources_protected&&url.starts_with("http://127.0.0.1:")&&marker!=url.npos&&slash==marker+67&&url.size()>slash+1;
                    if(valid){
                        const auto port_part=url.substr(17,marker-17);
                        valid=!port_part.empty()&&port_part.size()<=5&&std::all_of(port_part.begin(),port_part.end(),[](char c){return c>='0'&&c<='9';});
                        const auto token=url.substr(marker+3,64);
                        valid=valid&&std::all_of(token.begin(),token.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');});
                    }
                    if(valid)preview_scopes[id]=widen(url.substr(0,slash+1));
                    const auto reply=Json(Json::Object{{"source","dimension-preview"},{"action","allowed"},{"id",id},{"allowed",valid}}).dump();
                    webview->PostWebMessageAsJson(widen(reply).c_str());
                }else if(action=="close"){previews.erase(id);preview_scopes.erase(id);}
                return;
            }
            if(from=="dimension-settings"){
                if(action=="restart"){request_restart();return;}
                if(action=="set"){
                    const auto settings=data.find("settings");
                    const Json row=settings?*settings:data;
                    const auto language=field(row,"language");
                    if(language=="en"||language=="zh-CN")pref_language=language;
                    const auto theme=field(row,"theme");
                    if(theme=="paperlight"||theme=="warmamber"||theme=="nightink"||theme=="codex"||theme=="codexlight"||theme=="system")pref_theme=theme;
                    if(auto found=row.find("closeToTray");found&&found->is_bool())pref_close_to_tray=found->as_bool();
                    if(auto found=row.find("rememberWindowPosition");found&&found->is_bool())pref_remember_window=found->as_bool();
                    if(auto found=row.find("notificationsEnabled");found&&found->is_bool())pref_notifications=found->as_bool();
                    const bool merge_was_enabled=pref_notification_merge;
                    if(auto found=row.find("notificationMerge");found&&found->is_bool())pref_notification_merge=found->as_bool();
                    if(!pref_notifications)clear_notifications();
                    else if(merge_was_enabled&&!pref_notification_merge)flush_notifications();
                    save_prefs();apply_frame();InvalidateRect(window,nullptr,TRUE);
                }
                return;
            }
            if(from=="dimension-shell"){
                if(action=="pick-folder"){
                    const auto id=field(data,"id");if(id.empty()||id.size()>128)return;
                    folder_pick_queue.push_back({id,field(data,"title")});
                    PostMessageW(window,shell_pick_message,0,0);
                    return;
                }
                if(action=="reveal-path"){
                    const auto raw_path=field(data,"path");if(raw_path.empty()||raw_path.size()>4096)return;
                    std::error_code ec;
                    const fs::path target=fs::path(widen(raw_path)).lexically_normal();
                    if(!target.is_absolute()||!fs::exists(target,ec))return;
                    if(fs::is_regular_file(target,ec)){
                        if(PIDLIST_ABSOLUTE pidl=ILCreateFromPathW(target.c_str())){
                            SHOpenFolderAndSelectItems(pidl,0,nullptr,0);
                            ILFree(pidl);
                        }
                    }else if(fs::is_directory(target,ec)){
                        ShellExecuteW(window,L"open",target.c_str(),nullptr,nullptr,SW_SHOWNORMAL);
                    }
                    return;
                }
                return;
            }
            if(from!="dimension-chrome")return;
            if(action=="minimize"){ShowWindow(window,SW_MINIMIZE);log("Window minimized");}
            else if(action=="maximize"||action=="dblclick"){ShowWindow(window,IsZoomed(window)?SW_RESTORE:SW_MAXIMIZE);notify_state();log(IsZoomed(window)?"Window maximized":"Window restored");}
            else if(action=="close")hide_or_exit();
            else if(action=="drag"){ReleaseCapture();SendMessageW(window,WM_NCLBUTTONDOWN,HTCAPTION,0);}
            else if(action=="resize"){
                const std::map<std::string,int> edges{{"left",HTLEFT},{"right",HTRIGHT},{"top",HTTOP},{"bottom",HTBOTTOM},
                    {"top-left",HTTOPLEFT},{"top-right",HTTOPRIGHT},{"bottom-left",HTBOTTOMLEFT},{"bottom-right",HTBOTTOMRIGHT}};
                if(auto i=edges.find(field(data,"edge"));i!=edges.end()){ReleaseCapture();SendMessageW(window,WM_NCLBUTTONDOWN,i->second,0);}
            }
        }catch(...){if(raw)CoTaskMemFree(raw);}
    }
    void drain_folder_picks(){
        if(folder_pick_active||!webview||!window)return;
        folder_pick_active=true;
        while(!folder_pick_queue.empty()&&!quitting){
            const auto req=std::move(folder_pick_queue.front());
            folder_pick_queue.pop_front();
            std::string chosen_path;
            bool cancelled=true;
            try{
                ComPtr<IFileOpenDialog> dlg;
                if(SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dlg)))){
                    DWORD opts=0;
                    if(SUCCEEDED(dlg->GetOptions(&opts))){
                        dlg->SetOptions(opts|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM|FOS_NOCHANGEDIR|FOS_PATHMUSTEXIST);
                    }
                    const std::wstring wtitle=req.dialog_title.empty()?L"选择保存文件夹":widen(req.dialog_title);
                    dlg->SetTitle(wtitle.c_str());
                    if(SUCCEEDED(dlg->Show(window))){
                        ComPtr<IShellItem> item;
                        if(SUCCEEDED(dlg->GetResult(&item))&&item){
                            PWSTR psz=nullptr;
                            if(SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH,&psz))&&psz){
                                chosen_path=narrow(psz);
                                cancelled=false;
                                CoTaskMemFree(psz);
                            }
                        }
                    }
                }
            }catch(...){}
            if(webview){
                const auto reply=Json(Json::Object{
                    {"source","dimension-shell"},
                    {"action","picked-folder"},
                    {"id",req.id},
                    {"cancelled",cancelled},
                    {"path",chosen_path}
                }).dump();
                webview->PostWebMessageAsJson(widen(reply).c_str());
            }
        }
        folder_pick_active=false;
    }
    void browser(){
        origin=L"http://127.0.0.1:"+std::to_wstring(port.load());
        loader=LoadLibraryExW(config.loader.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if(!loader)throw std::runtime_error("WebView2 loader is unavailable");
        using CreateEnvironment=HRESULT(STDAPICALLTYPE*)(PCWSTR,PCWSTR,ICoreWebView2EnvironmentOptions*,ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
        const auto create=reinterpret_cast<CreateEnvironment>(GetProcAddress(loader,"CreateCoreWebView2EnvironmentWithOptions"));
        if(!create)throw std::runtime_error("WebView2 loader is invalid");
        auto options=Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        const auto language=pref_language=="en"?L"en":L"zh-CN";
        options->put_Language(language);
        if(config.debug_port)options->put_AdditionalBrowserArguments((L"--remote-debugging-port="+std::to_wstring(config.debug_port)).c_str());
        const auto profile=config.data/L"webview-profile";
        const auto hr=create(nullptr,profile.c_str(),options.Get(),Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, language](HRESULT result,ICoreWebView2Environment*env)->HRESULT{
                if(FAILED(result)||!env){PostMessageW(window,failed_message,0,0);return S_OK;}
                environment=env;
                const auto on_controller=Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [this](HRESULT result,ICoreWebView2Controller*control)->HRESULT{
                        if(FAILED(result)||!control){PostMessageW(window,failed_message,0,0);return S_OK;}
                        controller=control;controller->get_CoreWebView2(&webview);
                        RECT bounds{};GetClientRect(window,&bounds);controller->put_Bounds(bounds);
                        ComPtr<ICoreWebView2Settings> settings;webview->get_Settings(&settings);
                        settings->put_AreDefaultContextMenusEnabled(TRUE);settings->put_IsStatusBarEnabled(FALSE);
                        settings->put_AreDevToolsEnabled(config.debug_port!=0);
                        EventRegistrationToken token{};
                        ComPtr<ICoreWebView2_22> frame_resources;
                        if(SUCCEEDED(webview.As(&frame_resources)))
                            frame_resources_protected=SUCCEEDED(frame_resources->AddWebResourceRequestedFilterWithRequestSourceKinds(
                                L"*",COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL));
                        webview->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2WebResourceRequestedEventArgs* args)->HRESULT{
                                ComPtr<ICoreWebView2WebResourceRequest> request;args->get_Request(&request);
                                LPWSTR uri=nullptr;if(!request||FAILED(request->get_Uri(&uri)))return S_OK;
                                const std::wstring url=uri?uri:L"";CoTaskMemFree(uri);
                                const bool local_socket=url.starts_with(L"ws://")&&local(L"http"+url.substr(2));
                                if(!frame_local(url)&&!local_socket){
                                    ComPtr<ICoreWebView2WebResourceResponse> denied;
                                    if(SUCCEEDED(environment->CreateWebResourceResponse(nullptr,403,L"Preview resource blocked",L"Content-Type: text/plain\r\nCache-Control: no-store", &denied)))
                                        args->put_Response(denied.Get());
                                    log("Blocked ungranted WebView resource before network dispatch");
                                }
                                return S_OK;}).Get(),&token);
                        webview->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2WebMessageReceivedEventArgs*args)->HRESULT{on_message(args);return S_OK;}).Get(),&token);
                        webview->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs*args)->HRESULT{
                                LPWSTR uri=nullptr;args->get_Uri(&uri);if(!local(uri?uri:L""))args->put_Cancel(TRUE);CoTaskMemFree(uri);return S_OK;}).Get(),&token);
                        webview->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs*args)->HRESULT{
                                LPWSTR uri=nullptr;args->get_Uri(&uri);if(!frame_local(uri?uri:L"")){args->put_Cancel(TRUE);log("Blocked preview navigation outside its granted resources");}
                                CoTaskMemFree(uri);return S_OK;}).Get(),&token);
                        webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs*args)->HRESULT{
                                args->put_Handled(TRUE);BOOL gesture=FALSE;args->get_IsUserInitiated(&gesture);LPWSTR uri=nullptr;args->get_Uri(&uri);
                                const std::wstring url=uri?uri:L"";CoTaskMemFree(uri);
                                if(gesture&&(url.starts_with(L"https://")||url.starts_with(L"http://")))ShellExecuteW(window,L"open",url.c_str(),nullptr,nullptr,SW_SHOWNORMAL);
                                return S_OK;}).Get(),&token);
                        webview->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                            [this](ICoreWebView2*,ICoreWebView2NavigationCompletedEventArgs*args)->HRESULT{
                                BOOL success=FALSE;args->get_IsSuccess(&success);if(success){loaded=true;KillTimer(window,1);KillTimer(window,splash_timer);
                                    stop_splash_anim();
                                    wordmark.reset();splash.reset();release_splash_surface();
                                    if(controller)controller->put_IsVisible(!IsIconic(window));
                                    InvalidateRect(window,nullptr,TRUE);notify_state();
                                    const auto injected=Json(Json::Object{{"source","dimension-settings"},{"action","hello"},
                                        {"language",pref_language},{"theme",pref_theme},
                                        {"closeToTray",pref_close_to_tray},{"rememberWindowPosition",pref_remember_window},
                                        {"notificationsEnabled",pref_notifications},{"notificationMerge",pref_notification_merge}}).dump();
                                    webview->PostWebMessageAsJson(widen(injected).c_str());
                                    log("Frontend loaded");}
                                else if(!loaded)PostMessageW(window,failed_message,0,0);return S_OK;}).Get(),&token);
                        controller->add_AcceleratorKeyPressed(Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                            [this](ICoreWebView2Controller*,ICoreWebView2AcceleratorKeyPressedEventArgs*args)->HRESULT{
                                UINT key=0;COREWEBVIEW2_KEY_EVENT_KIND kind;args->get_VirtualKey(&key);args->get_KeyEventKind(&kind);
                                if(key==VK_ESCAPE&&kind==COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN&&!previews.empty()){
                                    args->put_Handled(TRUE);webview->ExecuteScript(L"document.querySelectorAll('dialog.work-preview[open]').forEach(d=>d.close());",nullptr);
                                }return S_OK;}).Get(),&token);
                        {
                            ComPtr<ICoreWebView2Controller2> ctrl2;
                            if(SUCCEEDED(controller.As(&ctrl2))){
                                const auto bg=app_color();
                                ctrl2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{255,GetRValue(bg),GetGValue(bg),GetBValue(bg)});
                            }
                        }
                        controller->put_IsVisible(FALSE);
                        const auto boot=Json(Json::Object{{"language",pref_language},{"theme",pref_theme},{"closeToTray",pref_close_to_tray},{"rememberWindowPosition",pref_remember_window},
                                        {"notificationsEnabled",pref_notifications},{"notificationMerge",pref_notification_merge}}).dump();
                        webview->AddScriptToExecuteOnDocumentCreated((L"window.__dimensionClientSettings="+widen(boot)+L";").c_str(),nullptr);
                        webview->Navigate((origin+L"/dimension-ui/").c_str());return S_OK;
                    });
                ComPtr<ICoreWebView2Environment10> env10;
                ComPtr<ICoreWebView2ControllerOptions> controller_options;
                if(SUCCEEDED(env->QueryInterface(IID_PPV_ARGS(&env10)))&&SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&controller_options))){
                    ComPtr<ICoreWebView2ControllerOptions2> locale_options;
                    if(SUCCEEDED(controller_options.As(&locale_options))) locale_options->put_ScriptLocale(language);
                    return env10->CreateCoreWebView2ControllerWithOptions(window,controller_options.Get(),on_controller.Get());
                }
                return env->CreateCoreWebView2Controller(window,on_controller.Get());
            }).Get());
        if(FAILED(hr))throw std::runtime_error("WebView2 initialization failed");
    }
    void paint(){
        PAINTSTRUCT ps{};HDC dc=BeginPaint(window,&ps);RECT area{};GetClientRect(window,&area);
        const int w=area.right-area.left,h=area.bottom-area.top;
        const auto fill=app_color();
        if(loaded||w<=10||h<=10){
            HBRUSH brush=CreateSolidBrush(fill);FillRect(dc,&area,brush);DeleteObject(brush);
            EndPaint(window,&ps);
            return;
        }
        if(!splash_mem_dc||!splash_dib||splash_dib_w!=w||splash_dib_h!=h){
            release_splash_surface();
            BITMAPINFO bmi{};
            bmi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
            bmi.bmiHeader.biWidth=w;
            bmi.bmiHeader.biHeight=-h;
            bmi.bmiHeader.biPlanes=1;
            bmi.bmiHeader.biBitCount=32;
            bmi.bmiHeader.biCompression=BI_RGB;
            void* bits=nullptr;
            splash_dib=CreateDIBSection(dc,&bmi,DIB_RGB_COLORS,&bits,nullptr,0);
            if(splash_dib){
                splash_mem_dc=CreateCompatibleDC(dc);
                splash_old_bmp=static_cast<HBITMAP>(SelectObject(splash_mem_dc,splash_dib));
                splash_dib_w=w;splash_dib_h=h;
            }
        }
        if(!splash_mem_dc){
            HBRUSH brush=CreateSolidBrush(fill);FillRect(dc,&area,brush);DeleteObject(brush);
            EndPaint(window,&ps);
            return;
        }
        const auto theme=resolved_theme();
        const bool is_codex=(theme=="codex");
        const bool is_codex_light=(theme=="codexlight");
        const bool dark=(theme=="nightink"||is_codex);
        const bool warm=(theme=="warmamber");
        const BYTE ac_r=is_codex?96:(is_codex_light?37:(dark?224:(warm?198:217)));
        const BYTE ac_g=is_codex?165:(is_codex_light?99:(dark?131:(warm?122:119)));
        const BYTE ac_b=is_codex?250:(is_codex_light?235:(dark?100:(warm?60:87)));
        const BYTE ink_r=is_codex?243:(is_codex_light?13:(dark?243:44)),ink_g=is_codex?244:(is_codex_light?14:(dark?238:41)),ink_b=is_codex?246:(is_codex_light?17:(dark?230:37));
        const BYTE sub_r=is_codex?156:(is_codex_light?82:(dark?166:124)),sub_g=is_codex?163:(is_codex_light?88:(dark?158:117)),sub_b=is_codex?175:(is_codex_light?102:(dark?147:107));

        const UINT raw_dpi=GetDpiForWindow(window);
        const float dpi=raw_dpi>=72?static_cast<float>(raw_dpi)/96.0f:1.0f;

        LARGE_INTEGER now_qpc{};
        QueryPerformanceCounter(&now_qpc);
        if(splash_qpc_freq.QuadPart==0)QueryPerformanceFrequency(&splash_qpc_freq);
        if(splash_qpc_start.QuadPart==0)splash_qpc_start=now_qpc;
        const float t=splash_qpc_freq.QuadPart>0
            ?static_cast<float>(static_cast<double>(now_qpc.QuadPart-splash_qpc_start.QuadPart)/static_cast<double>(splash_qpc_freq.QuadPart))
            :0.0f;
        const float raw_intro=std::min(1.0f,t/0.34f);
        const float intro=1.0f-(1.0f-raw_intro)*(1.0f-raw_intro)*(1.0f-raw_intro);
        const float breath=0.86f+0.14f*std::sin(t*2.2f);
        const float levitate=std::sin(t*2.1f)*3.5f*dpi;

        {
            Gdiplus::Graphics g(splash_mem_dc);
            g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
            g.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
            g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
            g.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
            g.Clear(Gdiplus::Color(255,GetRValue(fill),GetGValue(fill),GetBValue(fill)));

            const float cx=w*0.5f;
            const float cy=h*0.48f;

            // 1. Seamless zero-edge central breathing halo (exact Alpha=0 boundary)
            {
                const float rx=std::min(w*0.44f,400.0f*dpi)*(0.96f+0.06f*breath);
                const float ry=std::min(h*0.28f,200.0f*dpi)*(0.96f+0.06f*breath);
                Gdiplus::GraphicsPath halo_path;
                halo_path.AddEllipse(cx-rx,cy-ry+levitate*0.5f,rx*2.0f,ry*2.0f);
                Gdiplus::PathGradientBrush halo_brush(&halo_path);
                const BYTE center_a=static_cast<BYTE>((dark?52.0f:40.0f)*breath*intro);
                halo_brush.SetCenterColor(Gdiplus::Color(center_a,ac_r,ac_g,ac_b));
                halo_brush.SetCenterPoint(Gdiplus::PointF(cx,cy+levitate*0.5f));
                Gdiplus::Color edge_colors[1]{Gdiplus::Color(0,ac_r,ac_g,ac_b)};
                INT edge_count=1;
                halo_brush.SetSurroundColors(edge_colors,&edge_count);
                halo_brush.SetFocusScales(0.18f,0.18f);
                g.FillPath(&halo_brush,&halo_path);
            }

            // 2. Dual astrolabe orbit rings + sweeping comet arcs + floating motes
            {
                const float r_outer=std::clamp(std::min(w,h)*0.21f,136.0f*dpi,184.0f*dpi);
                const float r_inner=r_outer*0.76f;
                Gdiplus::Pen outer_ring(Gdiplus::Color(static_cast<BYTE>((dark?34:28)*intro),ac_r,ac_g,ac_b),1.15f*dpi);
                const Gdiplus::REAL dash_pat[2]{5.0f,6.0f};
                outer_ring.SetDashPattern(dash_pat,2);
                outer_ring.SetDashOffset(-t*18.0f);
                g.DrawEllipse(&outer_ring,cx-r_outer,cy-r_outer,r_outer*2.0f,r_outer*2.0f);

                Gdiplus::Pen inner_ring(Gdiplus::Color(static_cast<BYTE>((dark?24:20)*intro),ink_r,ink_g,ink_b),1.0f*dpi);
                g.DrawEllipse(&inner_ring,cx-r_inner,cy-r_inner,r_inner*2.0f,r_inner*2.0f);

                // Sweeping comet arc on outer orbit
                const float head_deg=std::fmod(t*108.0f-45.0f,360.0f);
                for(int seg=0;seg<6;++seg){
                    const float frac=static_cast<float>(seg+1)/6.0f;
                    const BYTE a=static_cast<BYTE>(frac*frac*(dark?175.0f:155.0f)*intro);
                    Gdiplus::Pen seg_pen(Gdiplus::Color(a,ac_r,ac_g,ac_b),(1.0f+frac*1.35f)*dpi);
                    seg_pen.SetStartCap(Gdiplus::LineCapRound);
                    seg_pen.SetEndCap(Gdiplus::LineCapRound);
                    const float start_a=head_deg-(6-seg)*10.5f;
                    g.DrawArc(&seg_pen,cx-r_outer,cy-r_outer,r_outer*2.0f,r_outer*2.0f,start_a,11.5f);
                }
                const float head_rad=head_deg*3.14159265f/180.0f;
                const float orb_x=cx+std::cos(head_rad)*r_outer;
                const float orb_y=cy+std::sin(head_rad)*r_outer;
                Gdiplus::SolidBrush orb_glow(Gdiplus::Color(static_cast<BYTE>(75*intro),ac_r,ac_g,ac_b));
                Gdiplus::SolidBrush orb_core(Gdiplus::Color(static_cast<BYTE>(235*intro),ac_r,ac_g,ac_b));
                const float gr=6.0f*dpi,cr=2.6f*dpi;
                g.FillEllipse(&orb_glow,orb_x-gr,orb_y-gr,gr*2.0f,gr*2.0f);
                g.FillEllipse(&orb_core,orb_x-cr,orb_y-cr,cr*2.0f,cr*2.0f);

                // Counter-rotating whisper arc on inner orbit
                const float sub_deg=std::fmod(160.0f-t*72.0f,360.0f);
                Gdiplus::Pen sub_arc(Gdiplus::Color(static_cast<BYTE>(92*intro),234,182,118),1.5f*dpi);
                sub_arc.SetStartCap(Gdiplus::LineCapRound);
                sub_arc.SetEndCap(Gdiplus::LineCapRound);
                g.DrawArc(&sub_arc,cx-r_inner,cy-r_inner,r_inner*2.0f,r_inner*2.0f,sub_deg,44.0f);

                // Ambient firefly motes
                for(int i=0;i<6;++i){
                    const float phase=t*1.4f+i*1.047f;
                    const float dist=r_outer*(1.12f+0.28f*static_cast<float>(i%3));
                    const float mx=cx+std::cos(phase*0.55f+i*1.1f)*dist*1.35f;
                    const float my=cy+std::sin(phase*0.7f+i*0.9f)*dist*0.72f-std::fmod(t*10.0f+i*9.0f,18.0f)*dpi;
                    const float pulse=0.5f+0.5f*std::sin(phase*1.8f);
                    const BYTE ma=static_cast<BYTE>((28.0f+75.0f*pulse)*intro);
                    Gdiplus::SolidBrush mote_b(Gdiplus::Color(ma,ac_r,ac_g,ac_b));
                    const float mr=(1.6f+(i%2)*0.8f)*dpi;
                    g.FillEllipse(&mote_b,mx-mr,my-mr,mr*2.0f,mr*2.0f);
                }
            }

            // 3. Crisp levitating DimensionAgent wordmark (full original scale, DPI-aware) + Ciallo signature
            if(wordmark){
                const float src_w=static_cast<float>(wordmark->GetWidth());
                const float src_h=static_cast<float>(wordmark->GetHeight());
                const float max_w=std::max(320.0f*dpi,std::min(w*0.80f,620.0f*dpi));
                const float min_w=std::min(420.0f*dpi,max_w);
                const float target_w=std::clamp(w*0.56f,min_w,max_w)*(0.985f+0.015f*intro);
                const float target_h=src_w>0?(target_w*src_h/src_w):160.0f*dpi;
                const Gdiplus::RectF dest(cx-target_w*0.5f,cy-target_h*0.5f+levitate,target_w,target_h);

                const float tr=ink_r/255.0f,tg=ink_g/255.0f,tb=ink_b/255.0f;
                const float ta=(dark?0.94f:0.90f)*intro;
                Gdiplus::ColorMatrix cm={{
                    {0.0f,0.0f,0.0f,0.0f,0.0f},
                    {0.0f,0.0f,0.0f,0.0f,0.0f},
                    {0.0f,0.0f,0.0f,0.0f,0.0f},
                    {0.0f,0.0f,0.0f,ta,  0.0f},
                    {tr,  tg,  tb,  0.0f,1.0f}
                }};
                Gdiplus::ImageAttributes attr;
                attr.SetColorMatrix(&cm,Gdiplus::ColorMatrixFlagsDefault,Gdiplus::ColorAdjustTypeBitmap);
                g.DrawImage(wordmark.get(),dest,0.0f,0.0f,src_w,src_h,Gdiplus::UnitPixel,&attr);

                Gdiplus::FontFamily sig_fam(L"Segoe UI");
                Gdiplus::Font sig_font(&sig_fam,13.5f*dpi,Gdiplus::FontStyleRegular,Gdiplus::UnitPixel);
                Gdiplus::SolidBrush sig_brush(Gdiplus::Color(static_cast<BYTE>(178*intro),sub_r,sub_g,sub_b));
                Gdiplus::StringFormat rfmt;
                rfmt.SetAlignment(Gdiplus::StringAlignmentFar);
                const Gdiplus::RectF sig_rc(cx-target_w*0.5f,cy+target_h*0.42f+levitate,target_w-8.0f*dpi,24.0f*dpi);
                g.DrawString(L"Ciallo \xFF5E(\x2220\x30FB\x03C9< )\x2312\x2605",-1,&sig_font,sig_rc,&rfmt,&sig_brush);
            }else if(splash&&!dark){
                const INT src_w=static_cast<INT>(splash->GetWidth()),src_h=static_cast<INT>(splash->GetHeight());
                g.DrawImage(splash.get(),(w-src_w)/2,(h-src_h)/2,src_w,src_h);
            }

            // 4. Feathered indeterminate shimmer hairline + crisp Chinese status caption
            {
                const float bar_w=240.0f*dpi,bar_h=3.0f*dpi;
                const float bar_x=cx-bar_w*0.5f;
                const float bar_y=cy+std::clamp(h*0.165f,126.0f*dpi,162.0f*dpi);
                Gdiplus::LinearGradientBrush track_b(
                    Gdiplus::PointF(bar_x,bar_y),Gdiplus::PointF(bar_x+bar_w,bar_y),
                    Gdiplus::Color(0,ink_r,ink_g,ink_b),Gdiplus::Color(0,ink_r,ink_g,ink_b));
                const Gdiplus::Color track_cols[4]{
                    Gdiplus::Color(0,ink_r,ink_g,ink_b),
                    Gdiplus::Color(static_cast<BYTE>(32*intro),ink_r,ink_g,ink_b),
                    Gdiplus::Color(static_cast<BYTE>(32*intro),ink_r,ink_g,ink_b),
                    Gdiplus::Color(0,ink_r,ink_g,ink_b)};
                const Gdiplus::REAL track_pos[4]{0.0f,0.18f,0.82f,1.0f};
                track_b.SetInterpolationColors(track_cols,track_pos,4);
                g.FillRectangle(&track_b,bar_x,bar_y,bar_w,bar_h);

                const float shuttle_w=96.0f*dpi;
                const float travel=0.5f+0.5f*std::sin(t*2.8f-1.2f);
                const float sx=bar_x+(bar_w-shuttle_w)*travel;
                Gdiplus::LinearGradientBrush shuttle_b(
                    Gdiplus::PointF(sx,bar_y),Gdiplus::PointF(sx+shuttle_w,bar_y),
                    Gdiplus::Color(0,ac_r,ac_g,ac_b),Gdiplus::Color(0,ac_r,ac_g,ac_b));
                const Gdiplus::Color sh_cols[3]{
                    Gdiplus::Color(0,ac_r,ac_g,ac_b),
                    Gdiplus::Color(static_cast<BYTE>(225*intro),ac_r,ac_g,ac_b),
                    Gdiplus::Color(0,ac_r,ac_g,ac_b)};
                const Gdiplus::REAL sh_pos[3]{0.0f,0.5f,1.0f};
                shuttle_b.SetInterpolationColors(sh_cols,sh_pos,3);
                g.FillRectangle(&shuttle_b,sx,bar_y-0.25f*dpi,shuttle_w,bar_h+0.5f*dpi);

                Gdiplus::FontFamily zh_fam(L"Microsoft YaHei UI");
                Gdiplus::Font zh_font(&zh_fam,14.5f*dpi,Gdiplus::FontStyleRegular,Gdiplus::UnitPixel);
                Gdiplus::SolidBrush cap_brush(Gdiplus::Color(static_cast<BYTE>(178*intro),sub_r,sub_g,sub_b));
                Gdiplus::StringFormat cfmt;
                cfmt.SetAlignment(Gdiplus::StringAlignmentCenter);
                const Gdiplus::RectF cap_rc(cx-260.0f*dpi,bar_y+14.0f*dpi,520.0f*dpi,28.0f*dpi);
                g.DrawString(L"\x2726 \x6B63\x5728\x5524\x9192\x6B21\x5143\x5DE5\x574A\x4E0E\x4F19\x4F34\x8BB0\x5FC6\x2026",-1,&zh_font,cap_rc,&cfmt,&cap_brush);
            }
        }

        BitBlt(dc,0,0,w,h,splash_mem_dc,0,0,SRCCOPY);
        EndPaint(window,&ps);
    }
    static LRESULT CALLBACK procedure(HWND hwnd,UINT message,WPARAM wparam,LPARAM lparam){
        auto self=reinterpret_cast<Client*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
        if(message==WM_NCCREATE){self=static_cast<Client*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);self->window=hwnd;SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(self));}
        if(!self)return DefWindowProcW(hwnd,message,wparam,lparam);
        if(message==self->show_message){self->reveal();return 0;}
        if(message==self->quit_message){self->log("Complete exit requested by launcher");self->stop();DestroyWindow(hwnd);return 0;}
        if(message==self->taskbar_created){self->tray_icon();return 0;}
        switch(message){
        case WM_NCCALCSIZE:if(wparam)return 0;break;
        case WM_ERASEBKGND:return 1;
        case WM_PAINT:self->paint();return 0;
        case WM_SIZE:{
            if(self->controller){RECT r{};GetClientRect(hwnd,&r);self->controller->put_Bounds(r);self->controller->put_IsVisible(self->loaded&&wparam!=SIZE_MINIMIZED);}
            self->sync_browser_layout();
            self->apply_frame();self->notify_state();
            if(wparam==SIZE_MAXIMIZED||wparam==SIZE_RESTORED)self->save_placement();
            return 0;}
        case WM_EXITSIZEMOVE:self->save_placement();return 0;
        case WM_MOVE:{
            if(self->controller)self->controller->NotifyParentWindowPositionChanged();
            for(auto& [id,tab]:self->browser_tabs){(void)id;if(tab&&tab->controller)tab->controller->NotifyParentWindowPositionChanged();}
            return 0;}
        case WM_DPICHANGED:{auto r=reinterpret_cast<RECT*>(lparam);SetWindowPos(hwnd,nullptr,r->left,r->top,r->right-r->left,r->bottom-r->top,SWP_NOZORDER|SWP_NOACTIVATE);return 0;}
        case WM_GETMINMAXINFO:{
            auto info=reinterpret_cast<MINMAXINFO*>(lparam);info->ptMinTrackSize={820,540};
            MONITORINFO monitor{sizeof(monitor)};if(GetMonitorInfoW(MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST),&monitor)){
                info->ptMaxPosition={monitor.rcWork.left-monitor.rcMonitor.left,monitor.rcWork.top-monitor.rcMonitor.top};
                info->ptMaxSize={monitor.rcWork.right-monitor.rcWork.left,monitor.rcWork.bottom-monitor.rcWork.top};
            }return 0;}
        case WM_SETTINGCHANGE:if(self->pref_theme=="system"){self->apply_frame();InvalidateRect(hwnd,nullptr,TRUE);}return 0;
        case WM_CLOSE:self->hide_or_exit();return 0;
        case WM_SYSCOMMAND:
            if((wparam&0xfff0)==system_exit_command){self->save_placement();self->log("Complete exit requested");self->stop();DestroyWindow(hwnd);return 0;}
            break;
        case WM_QUERYENDSESSION:return TRUE;
        case WM_ENDSESSION:if(wparam){self->save_placement();self->stop();}return 0;
        case WM_COMMAND:
            if(LOWORD(wparam)==show_command)self->reveal();
            else if(LOWORD(wparam)==hide_command)ShowWindow(hwnd,SW_HIDE);
            else if(LOWORD(wparam)==exit_command){self->save_placement();self->log("Complete exit requested");self->stop();DestroyWindow(hwnd);}
            return 0;
        case tray_message:
            if(LOWORD(lparam)==WM_CONTEXTMENU||LOWORD(lparam)==WM_RBUTTONUP)self->tray_menu();
            else if(LOWORD(lparam)==NIN_BALLOONTIMEOUT)self->advance_notifications();
            else if(LOWORD(lparam)==NIN_BALLOONUSERCLICK||LOWORD(lparam)==NIN_SELECT||LOWORD(lparam)==WM_LBUTTONUP){self->reveal();self->advance_notifications();}
            return 0;
        case ready_message:
            try{self->browser();}catch(...){PostMessageW(hwnd,failed_message,0,0);}return 0;
        case notification_message:self->drain_notifications();return 0;
        case shell_pick_message:self->drain_folder_picks();return 0;
        case splash_frame_message:
            self->splash_frame_pending.store(false,std::memory_order_release);
            if(!self->loaded){InvalidateRect(hwnd,nullptr,FALSE);UpdateWindow(hwnd);}
            return 0;
        case WM_TIMER:
            if(wparam==self->splash_timer){if(!self->loaded)InvalidateRect(hwnd,nullptr,FALSE);else KillTimer(hwnd,self->splash_timer);}
            else if(wparam==1&&!self->loaded)PostMessageW(hwnd,failed_message,0,0);
            else if(wparam>=self->merge_timer_first&&wparam<=self->merge_timer_last)self->flush_notifications(static_cast<UINT>(wparam));
            else if(wparam==self->display_timer)self->advance_notifications();
            return 0;
        case failed_message:
            if(self->failed||self->quitting)return 0;
            self->failed=true;self->exit_code=1;
            self->stop_splash_anim();
            KillTimer(hwnd,1);KillTimer(hwnd,self->splash_timer);self->log("Client startup or backend connection failed");
            if(!self->config.background)MessageBoxW(hwnd,L"客户端未能连接到原生服务。详细记录位于数据目录 native-client.log。\n关闭后重新启动可重试；原有安装与数据仍保留。",title,MB_OK|MB_ICONERROR);
            self->stop();DestroyWindow(hwnd);return 0;
        case WM_DESTROY:PostQuitMessage(self->exit_code);return 0;
        }
        return DefWindowProcW(hwnd,message,wparam,lparam);
    }
    int run(HINSTANCE module,int show){
        (void)show;
        WNDCLASSEXW klass{sizeof(klass)};klass.lpfnWndProc=procedure;klass.hInstance=module;klass.hCursor=LoadCursorW(nullptr,IDC_ARROW);
        klass.style=CS_DBLCLKS;klass.hbrBackground=static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH));
        klass.hIcon=icon;klass.hIconSm=icon;klass.lpszClassName=class_name.c_str();
        if(!RegisterClassExW(&klass))throw std::runtime_error("Cannot register client window");
        auto hwnd=CreateWindowExW(WS_EX_APPWINDOW,class_name.c_str(),title,WS_POPUP|WS_THICKFRAME|WS_MINIMIZEBOX|WS_MAXIMIZEBOX|WS_SYSMENU,
            CW_USEDEFAULT,CW_USEDEFAULT,1200,820,nullptr,nullptr,module,this);
        if(!hwnd)throw std::runtime_error("Cannot create client window");
        if(auto menu=GetSystemMenu(hwnd,FALSE)){
            AppendMenuW(menu,MF_SEPARATOR,0,nullptr);
            AppendMenuW(menu,MF_STRING,system_exit_command,L"退出客户端并停止后台(&Q)");
        }
        apply_frame();
        tray_icon();
        if(!config.background){
            if(!restore_placement())ShowWindow(hwnd,SW_SHOWNORMAL);
            placement_ready=true;
            UpdateWindow(hwnd);
            start_splash_anim(hwnd);
        }else placement_ready=true;
        try{start_backend();}catch(...){PostMessageW(hwnd,failed_message,0,0);}
        MSG message{};while(GetMessageW(&message,nullptr,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
        return static_cast<int>(message.wParam);
    }
};
}
int WINAPI wWinMain(HINSTANCE module,HINSTANCE,LPWSTR,int show){
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const auto com=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(com))return 1;
    ULONG_PTR graphics=0;Gdiplus::GdiplusStartupInput input;Gdiplus::GdiplusStartup(&graphics,&input,nullptr);
    int code=1;
    bool unattended=false;int count=0;auto arguments=CommandLineToArgvW(GetCommandLineW(),&count);
    for(int i=1;i<count;++i)if(std::wstring_view(arguments[i])==L"--background"||std::wstring_view(arguments[i])==L"--quit")unattended=true;
    LocalFree(arguments);
    try{Client client(configuration());code=client.run(module,show);}
    catch(const std::exception&error){
        if(std::string(error.what())=="already-running")code=0;
        else if(!unattended)MessageBoxW(nullptr,widen(error.what()).c_str(),title,MB_OK|MB_ICONERROR);
        else{DWORD written=0;const auto message=std::string(error.what())+"\n";WriteFile(GetStdHandle(STD_ERROR_HANDLE),message.data(),static_cast<DWORD>(message.size()),&written,nullptr);}
    }
    Gdiplus::GdiplusShutdown(graphics);CoUninitialize();return code;
}
