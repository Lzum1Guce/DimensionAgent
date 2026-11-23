namespace {
std::string github_ps_literal(std::string value) {
    std::string quoted = "'";
    for (char ch : value) { quoted += ch; if (ch == '\'') quoted += ch; }
    return quoted + "'";
}
bool github_name(const std::string& value, size_t limit) {
    return !value.empty() && value.size() <= limit && value != "." && value != ".." &&
        value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") == value.npos;
}
std::string github_repository(std::string remote) {
    for (const std::string prefix : {"https://github.com/", "git@github.com:", "ssh://git@github.com/"}) {
        if (!remote.starts_with(prefix)) continue;
        remote.erase(0,prefix.size());
        if (remote.ends_with(".git")) remote.resize(remote.size()-4);
        const auto slash = remote.find('/');
        if (slash != remote.npos && github_name(remote.substr(0,slash),39) && github_name(remote.substr(slash+1),100))
            return remote;
        break;
    }
    return {};
}
}

Json Application::Impl::github_status(const std::string& bot_id, const fs::path& project,
                                      bool windows, bool probe_sandbox, bool login, std::stop_token stop) {
    O status{{"environment",windows ? "Windows" : "WSL 沙盒"},{"project",utf8(project)},{"state","unknown"},
             {"account",""},{"permission",""},{"repository",""},{"loginAvailable",false}};
    Json result;
    std::string windows_gh;
    fs::path probe_cwd;
    if (windows) {
        wchar_t system[MAX_PATH]{};
        if (!GetSystemDirectoryW(system,MAX_PATH)) throw ApiError(500,"无法定位 Windows 系统目录");
        fs::path official;
        wchar_t pf[32768]{};
        const auto size = GetEnvironmentVariableW(L"ProgramFiles",pf,32768);
        if (size && size < 32768) official = fs::path(pf)/L"GitHub CLI"/L"gh.exe";
        std::error_code ec;
        // Use the same CLI as the Work host. Ignore relative PATH entries so the
        // selected repository cannot supply an executable to the login button.
        wchar_t paths[32768]{};
        const auto length = GetEnvironmentVariableW(L"PATH",paths,32768);
        if (length && length < 32768) {
            std::wistringstream entries(paths);
            for (std::wstring item; std::getline(entries,item,L';'); ) {
                if (item.size()>1 && item.front()==L'"' && item.back()==L'"') item=item.substr(1,item.size()-2);
                const fs::path dir(item);
                if (!dir.is_absolute() || dir.root_name().wstring().size()!=2) continue;
                const auto candidate = dir/L"gh.exe";
                if (fs::is_regular_file(candidate,ec)) { official=candidate; break; }
            }
        }
        const bool installed = fs::is_regular_file(official,ec);
        status["loginAvailable"] = installed;
        if (login) {
            if (!installed) throw ApiError(409,"请在本机终端运行 gh auth login --hostname github.com --web");
            STARTUPINFOW si{}; si.cb = sizeof(si);
            PROCESS_INFORMATION pi{};
            auto command = L"\"" + official.wstring() + L"\" auth login --hostname github.com --git-protocol https --web";
            if (!CreateProcessW(official.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NEW_CONSOLE,
                                nullptr,system,&si,&pi)) throw ApiError(500,"无法启动 GitHub CLI 登录");
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return O{{"started",true}};
        }
        const std::string gh = installed ? github_ps_literal(utf8(official)) :
            "(Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source";
        windows_gh = gh;
        probe_cwd = system;
        auto script = "$ErrorActionPreference='SilentlyContinue'\n$env:GH_PROMPT_DISABLED='1'\n$gh="+gh+
            "\n$account=''\n$state='missing'\nif ($gh) { $state='unverified'; "
            "$account=& $gh api --hostname github.com user --jq .login 2>$null; "
            "if ($LASTEXITCODE -eq 0 -and $account) { $state='connected' } else { $account='' } }\n"
            "$remote=& git.exe -C "+github_ps_literal(utf8(project))+
            " config --get remote.origin.url 2>$null\nWrite-Output $state\n[Console]::WriteLine([string]$account)\nWrite-Output ([string]$remote)\nexit 0";
        result = execute_host_command({system,script,"powershell",15},stop);
    } else {
        if (login) throw ApiError(409,"WSL 沙盒使用临时 HOME，无法保留交互登录");
        status["networkEnabled"] = sandbox_network_enabled(bot_id);
        if (!probe_sandbox || !sandbox_executor->available()) {
            status["state"] = probe_sandbox ? "sandboxUnavailable" : "awaitingWorkspace";
            return status;
        }
        const std::string script =
            "account=''; state=missing; if command -v gh >/dev/null 2>&1; then state=unverified; "
            "if account=$(GH_PROMPT_DISABLED=1 gh api --hostname github.com user --jq .login 2>/dev/null); then state=connected; fi; fi; "
            "remote=$(git config --get remote.origin.url 2>/dev/null); printf '%s\\n' \"$state\" \"$account\" \"$remote\"";
        result = sandbox_executor->execute(project,sandbox_network_enabled(bot_id),
            O{{"argv",A{"/bin/sh","-c",script}},{"timeoutSeconds",12}},stop,{},false);
    }
    if (flag(result,"timedOut") || num(result,"exitCode",-1)!=0 || (!windows && !flag(result,"ok"))) return status;
    std::istringstream lines(str(result,"stdout"));
    auto line = [&] { std::string v; std::getline(lines,v); if(v.ends_with('\r'))v.pop_back(); return v; };
    const auto state = line(), account = line(), remote = line();
    if (state=="connected" && github_name(account,39)) { status["state"]=state; status["account"]=account; }
    else if (state=="missing" || state=="unverified") status["state"]=state;
    const auto repo = github_repository(remote);
    status["repository"] = repo;
    if (str(status,"state") == "connected" && !repo.empty() && !stop.stop_requested()) {
        Json access;
        if (windows) {
            const auto script = "$env:GH_PROMPT_DISABLED='1'; $gh=" + windows_gh +
                "; & $gh repo view " + github_ps_literal("github.com/"+repo) +
                " --json viewerPermission --jq .viewerPermission 2>$null; exit $LASTEXITCODE";
            access = execute_host_command({probe_cwd,script,"powershell",10},stop);
        } else {
            access = sandbox_executor->execute(project,sandbox_network_enabled(bot_id),O{{"argv",
                A{"/bin/sh","-c","GH_PROMPT_DISABLED=1 exec gh repo view \"$1\" --json viewerPermission --jq .viewerPermission",
                  "gh","github.com/"+repo}},{"timeoutSeconds",10}},stop,{},false);
        }
        auto permission = str(access,"stdout");
        while (!permission.empty() && (permission.back()=='\n' || permission.back()=='\r')) permission.pop_back();
        if (num(access,"exitCode",-1)==0 && (permission=="READ" || permission=="TRIAGE" ||
            permission=="WRITE" || permission=="MAINTAIN" || permission=="ADMIN"))
            status["permission"] = permission;
    }
    return status;
}
