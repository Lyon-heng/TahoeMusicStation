@echo off
REM ============================================================
REM  Tahoe音乐站.exe —— C++ WebView2 无边框窗口壳构建说明
REM
REM  原始源码 _cpp/TahoeShell.cpp 已丢失，本脚本仅作占位与
REM  环境检查，真正构建需要先补齐该 C++ 源码。
REM
REM  环境要求：
REM    1. Visual Studio Build Tools 2022，勾选：
REM       - 使用 C++ 的桌面开发
REM       - Windows 11 SDK
REM    2. WebView2 SDK（NuGet: Microsoft.Web.WebView2）
REM    3. 生成的 TahoeShell.exe 重命名为 "Tahoe音乐站.exe"
REM       放到与 TahoeCore.exe 同一目录。
REM ============================================================

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 cl.exe。
  echo     请先安装 Visual Studio Build Tools 2022 + C++ 桌面开发负载，
  echo     并在 "x64 Native Tools Command Prompt for VS 2022" 中运行本脚本。
  pause
  exit /b 1
)

echo [i] C++ 工具链可用。但 TahoeShell.cpp 源码在本仓库中缺失，
echo     无法直接构建。请先补齐 _cpp/TahoeShell.cpp 后再编译。
echo.
echo 典型链接项（参考）：
echo   cl /EHsc /std:c++17 TahoeShell.cpp ^
echo      /I %WEBVIEW2_SDK%\include ^
echo      /link %WEBVIEW2_SDK%\lib\x64\WebView2LoaderStatic.lib ^
echo      user32.lib shell32.lib ole32.lib shlwapi.lib
pause
