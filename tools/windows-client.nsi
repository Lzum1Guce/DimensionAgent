Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
Name "DimensionAgent"
OutFile "${DIST_EXE}"
InstallDir "$LOCALAPPDATA\Programs\DimensionAgent"
RequestExecutionLevel user
SetCompressor /FINAL lzma
SetCompressorDictSize 16
Icon "${PAYLOAD}\app\native-release\public\ui\DimensionAgent.ico"
VIProductVersion "0.7.28.0"
VIAddVersionKey "ProductName" "DimensionAgent"
VIAddVersionKey "FileDescription" "DimensionAgent Windows x64 安装程序"
VIAddVersionKey "FileVersion" "0.7.28"
VIAddVersionKey "LegalCopyright" "DimensionAgent contributors"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\DImensionagent.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 DimensionAgent"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此版本需要 64 位 Windows。"
    Abort
  ${EndIf}
FunctionEnd
Section "DimensionAgent"
  IfFileExists "$INSTDIR\.dimension-public-install" approved
  IfFileExists "$INSTDIR\*.*" 0 approved
  MessageBox MB_OK|MB_ICONSTOP "目标目录已有其他文件。请保留原有安装并使用空目录。" /SD IDOK
  Abort
  approved:
  SetRegView 32
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" check_user
  StrCmp $0 "0.0.0.0" check_user have_runtime
  check_user:
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" install_runtime
  StrCmp $0 "0.0.0.0" install_runtime have_runtime
  install_runtime:
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=WebView2Setup.exe "${WEBVIEW}"
  ExecWait '"$PLUGINSDIR\WebView2Setup.exe" /silent /install' $0
  StrCmp $0 "0" have_runtime
  MessageBox MB_OK|MB_ICONSTOP "安装 Microsoft WebView2 失败。请检查网络，安装 WebView2 Evergreen Runtime 后重新运行。" /SD IDOK
  Abort
  have_runtime:
  SetRegView 64
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  FileOpen $0 "$INSTDIR\.dimension-public-install" w
  FileWrite $0 "DimensionAgent public installation"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\DimensionAgent"
  CreateShortcut "$SMPROGRAMS\DimensionAgent\DimensionAgent.lnk" "$INSTDIR\DImensionagent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DimensionAgentPublic" "DisplayName" "DimensionAgent"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DimensionAgentPublic" "DisplayVersion" "0.7.28"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DimensionAgentPublic" "DisplayIcon" "$INSTDIR\DImensionagent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DimensionAgentPublic" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  SetRegView 64
  IfFileExists "$INSTDIR\.dimension-public-install" +2
  Abort
  !include "${REMOVE_LIST}"
  IfFileExists "$INSTDIR\data\*.*" keep_profile
  Delete "$INSTDIR\.dimension-public-install"
  keep_profile:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\DimensionAgent\DimensionAgent.lnk"
  RMDir "$SMPROGRAMS\DimensionAgent"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DimensionAgentPublic"
SectionEnd
