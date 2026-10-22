@echo off
REM ============================================================
REM  TahoeCore 后端代理打包脚本（PyInstaller onefile）
REM  前提：已补齐原始 server.py / _core_entry.py 源码（本仓库
REM        目前仅提供字节码存档 bytecode/server.pyc）。
REM  用法：把本脚本与 server.py / _core_entry.py / web/ 放在
REM        同一源码目录，执行 build-core.bat。
REM ============================================================

setlocal
cd /d %~dp0..

REM 首次运行若无证书，先自签一张（PowerShell 一行命令，openssl 亦可）
if not exist cert.pem (
  echo [i] 未找到 cert.pem / cert.key，可先用 openssl 自签：
  echo     openssl req -x509 -newkey rsa:2048 -nodes ^
  echo       -keyout cert.key -out cert.pem -days 3650 ^
  echo       -subj "/CN=Tahoe" ^
  echo       -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:YOUR_LAN_IP"
  echo.
)

python -m PyInstaller --onefile --console --name "TahoeCore" ^
  --distpath app --workpath _exe_build/build ^
  --add-data "web/index.html;." ^
  --add-data "web/style.css;." ^
  --add-data "web/app.js;." ^
  --add-data "web/particles.js;." ^
  --add-data "web/assets;assets" ^
  --add-data "cert.pem;." ^
  --add-data "cert.key;." ^
  _core_entry.py

echo.
echo [√] 打包完成，产物在 app\TahoeCore.exe
endlocal
