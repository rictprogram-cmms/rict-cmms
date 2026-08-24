@echo off
REM ============================================================================
REM  purge-create-users.bat  --  RICT CMMS
REM
REM  Removes create-users.mjs from EVERY commit in Git history (it contained
REM  real names, emails and a shared temporary password in a public repo),
REM  then force-pushes the rewritten main branch to GitHub.
REM
REM  RUN THIS ONCE. It works in a fresh clone under %TEMP%, NOT in OneDrive.
REM
REM  Before you run it:
REM    1. Push any uncommitted work from OneDrive to GitHub.
REM    2. Install git-filter-repo once:   pip install git-filter-repo
REM
REM  After it finishes:
REM    - Delete the rict-cmms folder inside OneDrive on EVERY computer and
REM      re-clone:  git clone https://github.com/rictprogram-cmms/rict-cmms.git
REM      (old clones will refuse to fast-forward because history changed)
REM    - Vercel redeploys from the new main automatically.
REM ============================================================================

setlocal
set REPO=https://github.com/rictprogram-cmms/rict-cmms.git
set WORK=%TEMP%\rict-cmms-purge

where git-filter-repo >nul 2>&1
if errorlevel 1 (
  echo.
  echo  git-filter-repo is not installed. Run:   pip install git-filter-repo
  echo  then run this script again.
  pause
  exit /b 1
)

if exist "%WORK%" rmdir /s /q "%WORK%"
echo Cloning a fresh copy to %WORK% ...
git clone "%REPO%" "%WORK%"
if errorlevel 1 ( echo Clone failed. & pause & exit /b 1 )
cd /d "%WORK%"

echo.
echo Removing create-users.mjs from all history ...
git filter-repo --path create-users.mjs --invert-paths --force
if errorlevel 1 ( echo filter-repo failed. & pause & exit /b 1 )

REM filter-repo strips the remote for safety; add it back
git remote add origin "%REPO%"

echo.
echo Verifying the file is gone from history ...
git log --all --oneline -- create-users.mjs
echo (the line above should be empty)
echo.
echo About to FORCE PUSH rewritten history to origin/main.
pause

git push --force origin main
if errorlevel 1 ( echo Push failed. & pause & exit /b 1 )

echo.
echo Done. Now delete and re-clone the OneDrive working copy on every computer.
pause
endlocal
