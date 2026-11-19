@echo off
chcp 65001 >nul
rem Kagibako デスクトップ版のビルド
rem 出力: dist\Kagibako\Kagibako.exe （このフォルダごと好きな場所に置いて使えます）
setlocal
cd /d "%~dp0.."
dotnet publish desktop\Kagibako.csproj -c Release -o dist\Kagibako
if errorlevel 1 (
  echo ビルドに失敗しました。
  exit /b 1
)
echo.
echo 完了: %cd%\dist\Kagibako\Kagibako.exe
