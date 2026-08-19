# dsh-logcat 一键发布脚本
# 用法：
#   1) 先注册 GitHub 账号（github.com/signup），再用该账号登录 npmjs.com（Sign in with GitHub）。
#   2) 设置环境变量后运行本脚本：
#        $env:GH_TOKEN   = "<GitHub Personal Access Token（repo + 建仓权限）>"
#        $env:NPM_TOKEN  = "<npm automation token（可选，不设则跳过 npm 发布）>"
#      powershell -ExecutionPolicy Bypass -File .\publish.ps1
#   3) 脚本会：git init + 提交 + 推送 github.com/<user>/dsh-logcat + 打 topic + npm publish。
# 也可以不跑脚本，按输出里的手动命令逐个执行。
$ErrorActionPreference = 'Stop'
chcp 65001 > $null

Write-Host "=== dsh-logcat 发布脚本 ===" -ForegroundColor Cyan

# 0) 检查 git 身份
$name = git config --global user.name
$email = git config --global user.email
if (-not $name -or -not $email) {
  Write-Host "[提示] 先设置 git 身份：" -ForegroundColor Yellow
  Write-Host "  git config --global user.name \"你的名字\""
  Write-Host "  git config --global user.email \"你的邮箱\""
  $name = Read-Host "git user.name"
  $email = Read-Host "git user.email"
  git config --global user.name $name
  git config --global user.email $email
}

# 1) 解析 GitHub 用户名（从 remote / PAT / 手动输入）
$user = $env:GH_USER
if (-not $user) {
  if ($env:GH_TOKEN) {
    $u = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers @{ 'User-Agent' = 'dsh-logcat'; Authorization = "token $env:GH_TOKEN" }
    $user = $u.login
  }
}
if (-not $user) { $user = Read-Host "GitHub 用户名" }
Write-Host "GitHub 用户: $user"

$repo = 'dsh-logcat'
$remote = "https://github.com/$user/$repo.git"

# 2) 建仓（未建则用 API 创建公开仓库）
if ($env:GH_TOKEN) {
  try {
    Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' `
      -Headers @{ 'User-Agent' = 'dsh-logcat'; Authorization = "token $env:GH_TOKEN" } `
      -ContentType 'application/json' `
      -Body (@{ name = $repo; description = 'Android Logcat viewer for the DeepSeek Harness (DSH) Web GUI: auto-connect adb devices, live logcat stream with level/keyword filters, pause/clear/export, agent tool logcat_recent.'; homepage = 'https://github.com/topics/dsh-plugin'; 'private' = $false } | ConvertTo-Json) | Out-Null
    Write-Host "仓库已创建: $remote" -ForegroundColor Green
  } catch {
    Write-Host "[跳过] 建仓失败（可能已存在）: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# 3) git 初始化 + 提交 + 推送
if (-not (Test-Path .git)) { git init | Out-Null }
git add -A
git -c user.name="$name" -c user.email="$email" commit -m "dsh-logcat $(& { (Get-Content package.json -Raw | ConvertFrom-Json).version }): Android Logcat viewer for the DSH Web GUI" 2>$null
if (git remote | Select-String -Quiet '^origin$') { git remote set-url origin $remote } else { git remote add origin $remote }
if ($env:GH_TOKEN) {
  git push -u "https://x-access-token:$($env:GH_TOKEN)@github.com/$user/$repo.git" HEAD:main 2>&1 | Out-Null
  Write-Host "已推送到: https://github.com/$user/$repo" -ForegroundColor Green
} else {
  Write-Host "未提供 GH_TOKEN，请手动推送："
  Write-Host "  git push -u origin HEAD:main"
}

# 4) 打 topic（dsh-plugin 等），使其出现在 https://github.com/topics/dsh-plugin
if ($env:GH_TOKEN) {
  try {
    Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$user/$repo/topics" `
      -Headers @{ 'User-Agent' = 'dsh-logcat'; Authorization = "token $env:GH_TOKEN"; Accept = 'application/vnd.github+json' } `
      -ContentType 'application/json' `
      -Body (@{ names = @('dsh-plugin', 'deepseek-harness', 'dsh', 'android', 'logcat', 'adb') } | ConvertTo-Json) | Out-Null
    Write-Host "已打 topic: dsh-plugin / deepseek-harness / dsh / android / logcat / adb" -ForegroundColor Green
    Write-Host "主题页: https://github.com/topics/dsh-plugin" -ForegroundColor Green
  } catch {
    Write-Host "[跳过] 打 topic 失败: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} else {
  Write-Host "未提供 GH_TOKEN，请在仓库 Settings -> Topics 手动添加：dsh-plugin, deepseek-harness, dsh, android, logcat, adb"
}

# 5) npm 发布（可选）
if ($env:NPM_TOKEN) {
  npm config set "//registry.npmjs.org/:_authToken=$env:NPM_TOKEN" | Out-Null
  # 包 scope = GitHub 用户名（npm 用 GitHub 登录后，@scope 即用户名）。
  # 把 package.json 的 name 改成 @<user>/dsh-logcat，否则发布到 @linxin666 会因无权而失败。
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $pkg.name = "@$user/dsh-logcat"
  $pkg | ConvertTo-Json -Depth 10 | Set-Content package.json -Encoding UTF8
  Write-Host "发布包名: $($pkg.name)" -ForegroundColor Cyan
  npm publish --access public
  Write-Host "已发布到 npm: @$user/dsh-logcat" -ForegroundColor Green
  Write-Host "用户安装: dsh plugin --profile web add @$user/dsh-logcat"
} else {
  Write-Host "[跳过 npm] 未提供 NPM_TOKEN。登录后可手动：npm login; npm publish --access public"
}

Write-Host ""
Write-Host "完成。仓库: https://github.com/$user/$repo  |  主题页: https://github.com/topics/dsh-plugin" -ForegroundColor Cyan
