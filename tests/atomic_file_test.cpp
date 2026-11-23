#include "dimension/atomic_file.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#include <algorithm>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <thread>

namespace {
using namespace dimension;
namespace fs=std::filesystem;
int checks=0;
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);++checks;}
std::wstring native(fs::path p){p.make_preferred();return L"\\\\?\\"+p.wstring();}
void directory(const fs::path& p){fs::create_directories(native(p));}
std::string read(const fs::path& p){std::ifstream f(native(p),std::ios::binary);check(f.good(),"read actual file");return {std::istreambuf_iterator<char>(f),std::istreambuf_iterator<char>()};}
template<class F>void rejects(F fn,AtomicFileFailure kind){
    try{fn();}catch(const AtomicFileError& e){check(e.kind==kind,"expected atomic rejection category");check(!e.committed,"rejected operation did not commit");return;}
    throw std::runtime_error("unsafe atomic write was accepted");
}
bool symlink(const fs::path& link,const fs::path& target){
    const auto ok=CreateSymbolicLinkW(native(link).c_str(),native(target).c_str(),SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE);
    if(ok)return true;
    const auto err=GetLastError();
    if(err==ERROR_PRIVILEGE_NOT_HELD)return false;
    throw std::runtime_error("required file symlink fixture failed, Windows error "+std::to_string(err));
}
void junction(const fs::path& link,const fs::path& target){
    directory(link);
    struct Reparse {DWORD tag;WORD length,reserved,sub_offset,sub_length,print_offset,print_length;WCHAR path[2048];} data{};
    const auto destination=L"\\??\\"+target.wstring();check(destination.size()+2<2048,"junction fixture bound");
    data.tag=IO_REPARSE_TAG_MOUNT_POINT;data.sub_length=static_cast<WORD>(destination.size()*sizeof(WCHAR));
    data.print_offset=data.sub_length+sizeof(WCHAR);data.length=static_cast<WORD>(8+data.print_offset+sizeof(WCHAR));
    std::copy(destination.begin(),destination.end(),data.path);
    const auto handle=CreateFileW(native(link).c_str(),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    check(handle!=INVALID_HANDLE_VALUE,"junction handle");DWORD bytes{};
    const auto ok=DeviceIoControl(handle,FSCTL_SET_REPARSE_POINT,&data,data.length+8,nullptr,0,&bytes,nullptr);
    CloseHandle(handle);check(ok,"junction fixture creation");
}
void clean_temporary(const fs::path& parent){
    for(const auto& entry:fs::directory_iterator(native(parent)))
        check(!entry.path().filename().wstring().starts_with(L".dimension-"),"no owned temporary file left behind");
}
}
int wmain(int argc,wchar_t**argv){
 try{
    if(argc!=2)throw std::runtime_error("configured isolated absolute output directory required");
    const fs::path supplied(argv[1]);
    if(!supplied.is_absolute()||supplied.lexically_normal()!=fs::path(DIMENSION_TEST_ROOT).lexically_normal())throw std::runtime_error("atomic tests must write in their configured isolated directory");
    const auto root=supplied/(std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64()));
    const auto project=root/L"project",outside=root/L"outside";directory(project);directory(outside);
    const auto sentinel=outside/L"sentinel.txt";atomic_write_file(sentinel,"external sentinel");
    const auto target=project/L"result.txt";
    atomic_write_file(target,"first");check(read(target)=="first","write exact destination");
    atomic_write_file(target,"replacement");check(read(target)=="replacement","replace exact destination");
    check(CreateHardLinkW(native(project/L"result.txt.pending").c_str(),native(sentinel).c_str(),nullptr),"pending hardlink fixture");
    atomic_write_file(target,"safe result");
    check(read(sentinel)=="external sentinel"&&read(target)=="safe result","legacy hardlink pending is untouched");
    if(symlink(project/L"symbol.txt.pending",sentinel)){
        atomic_write_file(project/L"symbol.txt","symbol target");
        check(read(sentinel)=="external sentinel"&&read(project/L"symbol.txt")=="symbol target","legacy symbolic pending is untouched");
    }
    check(CreateHardLinkW(native(project/L"hardlink.txt").c_str(),native(sentinel).c_str(),nullptr),"destination hardlink fixture");
    rejects([&]{atomic_write_file(project/L"hardlink.txt","bad");},AtomicFileFailure::UnsafePath);
    if(symlink(project/L"linked.txt",sentinel)){
        rejects([&]{atomic_write_file(project/L"linked.txt","bad");},AtomicFileFailure::UnsafePath);
    }
    junction(project/L"junction",outside);
    rejects([&]{atomic_write_file(project/L"junction"/L"sentinel.txt","bad");},AtomicFileFailure::UnsafePath);
    check(read(sentinel)=="external sentinel","all external sentinel bytes preserved");
    AtomicWriteOptions immutable;immutable.replace_existing=false;
    rejects([&]{atomic_write_file(target,"overwrite",immutable);},AtomicFileFailure::AlreadyExists);
    check(read(target)=="safe result","immutable target preserved");
    std::stop_source cancelled;cancelled.request_stop();
    rejects([&]{atomic_write_file(target,"cancelled",{},cancelled.get_token());},AtomicFileFailure::Cancelled);
    check(read(target)=="safe result","cancelled target preserved");
    AtomicWriteOptions boundary;boundary.existing_root=project;
    atomic_write_file(project/L"nested"/L"result.txt","within boundary",boundary);
    check(read(project/L"nested"/L"result.txt")=="within boundary","descendant directory creation");
    rejects([&]{atomic_write_file(outside/L"escape.txt","bad",boundary);},AtomicFileFailure::InvalidPath);
    boundary.existing_root=root/L"missing-root";
    rejects([&]{atomic_write_file(boundary.existing_root/L"nested"/L"result.txt","bad",boundary);},AtomicFileFailure::Storage);
    check(!fs::exists(native(boundary.existing_root)),"missing project root not created");
    rejects([&]{atomic_write_file(project/L".."/L"outside"/L"escape.txt","bad");},AtomicFileFailure::InvalidPath);
    rejects([&]{atomic_write_file(project/L"alternate:stream","bad");},AtomicFileFailure::InvalidPath);
    rejects([&]{atomic_write_file(project/L"NUL.txt","bad");},AtomicFileFailure::InvalidPath);
    auto long_path=project/L"long";while(long_path.wstring().size()<320)long_path/=L"component";
    const auto literal=long_path/L"中文 $dollar `backtick.txt";
    atomic_write_file(literal,"UTF-8 中文 bytes");check(read(literal)=="UTF-8 中文 bytes","long Unicode and literal metacharacter path");
    const auto concurrent=project/L"concurrent.txt";
    const std::string a(1024*1024,'A'),b(1024*1024,'B');std::atomic_int committed=0;
    auto writer=[&](const std::string& bytes){try{atomic_write_file(concurrent,bytes);++committed;}catch(const AtomicFileError& e){if(e.kind!=AtomicFileFailure::Storage)throw;}};
    auto one=std::async(std::launch::async,[&]{writer(a);});auto two=std::async(std::launch::async,[&]{writer(b);});one.get();two.get();
    const auto actual=read(concurrent);check(committed>0&&(actual==a||actual==b),"concurrent writes are complete or safely rejected");
    const auto watched=project/L"watched.txt";atomic_write_file(watched,"old watched content");
    struct HeldReader{HANDLE value=INVALID_HANDLE_VALUE;~HeldReader(){if(value!=INVALID_HANDLE_VALUE)CloseHandle(value);}void close(){if(value!=INVALID_HANDLE_VALUE){CloseHandle(value);value=INVALID_HANDLE_VALUE;}}};
    {
        HeldReader reader{CreateFileW(native(watched).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr)};
        check(reader.value!=INVALID_HANDLE_VALUE,"temporary reader fixture");
        auto pending=std::async(std::launch::async,[&]{atomic_write_file(watched,"new watched content");});
        bool staged=false;const auto staging_deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
        do {
            for(const auto& entry:fs::directory_iterator(native(project)))
                if(entry.path().filename().wstring().starts_with(L".dimension-"))staged=true;
            if(!staged)std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }while(!staged&&std::chrono::steady_clock::now()<staging_deadline);
        const auto waiting=pending.wait_for(std::chrono::milliseconds(40));
        const auto delete_handle=CreateFileW(native(project).c_str(),DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
            nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        const auto delete_error=GetLastError();if(delete_handle!=INVALID_HANDLE_VALUE)CloseHandle(delete_handle);
        reader.close();pending.get();
        check(staged,"writer reached its exclusive staging file while the destination reader was held");
        check(waiting==std::future_status::timeout,"short read lock waits without truncating target");
        check(delete_handle==INVALID_HANDLE_VALUE&&delete_error==ERROR_SHARING_VIOLATION,
            "atomic directory pins deny DELETE access while a real commit is pending");
        check(read(watched)=="new watched content","atomic replacement succeeds after short read lock releases");
    }
    {
        HeldReader reader{CreateFileW(native(watched).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr)};
        check(reader.value!=INVALID_HANDLE_VALUE,"cancelled read lock fixture");std::stop_source stop;
        auto pending=std::async(std::launch::async,[&]{try{atomic_write_file(watched,"must not commit",{},stop.get_token());return false;}catch(const AtomicFileError& e){return e.kind==AtomicFileFailure::Cancelled&&!e.committed;}});
        const auto waiting=pending.wait_for(std::chrono::milliseconds(40));stop.request_stop();
        const bool cancelled_write=pending.get();reader.close();
        check(waiting==std::future_status::timeout&&cancelled_write,"cancellation interrupts a pre-commit sharing retry");
        check(read(watched)=="new watched content","cancelled sharing retry preserves the previous destination");
    }
    clean_temporary(project);clean_temporary(project/L"nested");clean_temporary(long_path);
    std::cout<<"atomic_file: "<<checks<<" checks passed\n";return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
