@echo off
cd /d "%~dp0"
echo ============================================
echo    SERVIDOR KARTING - LOCAL
echo ============================================
echo.
if not exist node_modules\ws echo Instalando (solo la primera vez, espera un poco)...
if not exist node_modules\ws call npm install
echo.
echo Servidor arrancando...
echo.
echo   En ESTE PC abre:      http://localhost:8090
echo   En OTRO PC (misma wifi) usa la IP de este equipo,
echo   por ejemplo:           http://192.168.1.XX:8090
echo   (para saber la IP, abre otra consola y escribe:  ipconfig )
echo.
echo   Para PARAR el servidor: cierra esta ventana.
echo.
node server.js
pause
