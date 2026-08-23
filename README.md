# dsh-logcat

DSH Web GUI 的安卓实机调试面板（类似 Android Studio 的 Logcat 视图）。

[中文](README.md) | [English](README.en.md)

## 功能

- **自动连接**：探测本机 adb（`ANDROID_HOME` / `ANDROID_SDK_ROOT` / 默认 `%LOCALAPPDATA%\Android\Sdk` / PATH /
  `~/.dsh/adb`），每 2 秒轮询 `adb devices -l`；检测到处于调试模式的设备**自动附加 logcat 流**（`-v threadtime`），无需打开面板。
- **一键安装 adb**：未找到 adb 时，面板状态栏显示「一键安装 adb」按钮 —— 从 USTC 镜像（Google 官方兜底）
  下载 platform-tools 解压到 `~/.dsh/adb` 并自动接入，开箱即用（约 10MB）。
- **实时日志**：WebSocket 推送，每设备保留最近 2000 行环形缓冲；断线自动重连（指数退避）。
- **Logcat 面板**（侧边栏「Logcat」入口，右侧抽屉，**宽度可拖拽调整并记忆**）：
  - 设备下拉（显示型号/序列号/状态，记住上次选择）
  - 级别过滤（V/D/I/W/E/F 单选，颜色与 Android Studio 一致）
  - 关键词过滤（**空格分隔多关键词 = 任一命中**）、**测试包名输入框**（回车设置，与 agent 的 `logcat_set_package` 互通，状态栏实时显示）
  - **截图按钮**：一键截取真机屏幕并下载 PNG（`exec-out screencap`）
  - **崩溃高亮**：FATAL EXCEPTION / ANR 行红色高亮，一眼定位崩溃
  - **历史回溯按钮**：从磁盘加载落盘历史日志（重启 GUI 不丢，与实时缓冲合并显示且按时间戳去重）
  - **崩溃自动快照**：流中出现 FATAL EXCEPTION / ANR 时自动截图 + 上下文落盘 `~/.dsh/logcat/crashes`，
    面板弹提示条，可随时在「崩溃」弹窗里查看截图与日志
  - **events 事件视图**：一键开启 `logcat -b events` 实时流，看应用启动/崩溃/生命周期事件
  - **WiFi 无线调试向导**：输入 IP/端口/配对码，自动 `adb pair` + `adb connect`，摆脱数据线（Android 11+）
  - **装APK 按钮**：本地文件选择器选 APK 直接安装到当前设备（流式上传，1GB 上限）
  - **设备快捷按键**：Home / 返回 / 最近任务 / 唤醒 / 电源 / 音量 ± 一键发送
  - **性能曲线**：CPU / 内存 / 电量每 2s 采样，状态栏 sparkline 趋势图
  - **屏幕实时投屏与远程操控**：「屏幕」tab 开启 ~1fps 实时画面（WS 二进制帧推送），**点击=点按、拖动=滑动**、
    文字输入框直接发到手机、快捷按键（Home/返回/唤醒/音量）、一键下载当前帧 —— 不用拿起手机
  - **逆向工作台（日志/屏幕/逆向三 tab）**：进程列表 → 内存 hex/字符串搜索 → 匹配地址 → 点击转储 256B 查看
  - 暂停/继续（暂停时缓冲，恢复自动回放）、清空、复制、导出 .txt
  - 窗口化渲染 + 自动滚动（滚动手动上翻时自动停用）
  - 未授权设备提示「请在手机上点击允许 USB 调试」
- **Agent 工具**（共 30 个，全部对 agent 开放，前置提示中已明示可调用）：
  - 设备：`logcat_devices`（列出设备）、`device_info`（型号/版本/SDK/分辨率/内存/电量）、`device_stats`（CPU/内存/电量实时采样）、
    `app_info`（已安装应用版本号/versionCode/APK 路径）
  - 屏幕/多模态：`screen_capture`（截图存档 + 嵌入对话图片块，多模态模型可直接看图配合 `input_*` 修 bug）
  - 执行：`adb_exec`（shell）、`adb_install`（本地 APK 装真机）、`adb_pull`（拉文件）、
    `app_launch`（启动应用/指定 Activity）、`app_stop`（force-stop，破坏性先确认）
  - 输入：`input_tap` / `input_swipe` / `input_text` / `input_keyevent`（真机 UI 自动化）、`ui_dump`（界面层级 XML）、
    `activity_current`（当前前台 Activity）
  - 日志：`logcat_recent`（按包名/级别/关键词过滤）、`logcat_history`（磁盘历史日志回溯，重启不丢）、
    `logcat_crash`（崩溃/ANR 自动捕获 + 上下文）、`logcat_events`（events 事件缓冲）、
    `crash_sessions`（崩溃自动快照历史）、`logcat_set_package`（锁定当前测试包名）
  - 逆向/内存：`proc_list`（进程列表）、`proc_maps`（内存映射 + so 模块基址）、`proc_status`（进程状态/内存摘要）、
    `proc_smaps`（smaps 明细，Pss Top 区域）、`mem_dump`（指定地址读内存 hex）、
    `mem_search`（内存搜 hex 模式/字符串）、`frida_server`（frida-server 部署/启停）、
    `frida_script`（hook/trace/scan/bypass/dump 常用脚本模板生成）
- **实机调试工作流**：构建安卓应用时，agent 的通告会动态列出当前已连接设备（serial + 型号）与当前测试包名，
  可先向用户确认后：`adb_install` 部署 APK → `adb_exec` 启动 → `logcat_set_package` 锁包 →
  `logcat_recent` / `logcat_crash` 看崩溃 → `ui_dump` + `input_*` 做界面自动化 → `adb_pull` 取证，闭环真机调试。
- **逆向工作流**：`proc_list` 定位进程 → `proc_maps` 拿模块基址 → `mem_dump` 读目标地址 / `mem_search` 搜特征模式 →
  `proc_smaps` 看内存占用明细 → `frida_script` 生成脚本 + `frida_server` 起 frida 做动态插桩。
  读其他应用内存/maps 需要 root 或 debuggable 应用（run-as），工具会给出明确提示。
- **附加能力**：`POST /api/dsh-logcat/exec` 执行 shell、`POST /api/dsh-logcat/package` 设置包名、
  `GET /api/dsh-logcat/screenshot` 截屏、`POST /api/dsh-logcat/install-adb` 一键装 adb、
  `GET /api/dsh-logcat/history` 历史回溯、`GET /api/dsh-logcat/crashes` + `GET /api/dsh-logcat/crash-file` 崩溃快照读取、
  `POST /api/dsh-logcat/install-apk` 上传安装 APK、`POST /api/dsh-logcat/keyevent` 按键、
  `POST /api/dsh-logcat/wifi-connect` / `wifi-disconnect` 无线调试、`GET /api/dsh-logcat/processes`、
  `POST /api/dsh-logcat/mem-search`、`GET /api/dsh-logcat/mem-dump`。
- **数据落盘**：日志按设备按天写入 `~/.dsh/logcat/logs/<serial>/logcat-MM-DD.log`（原始 threadtime 行）；
  崩溃快照存 `~/.dsh/logcat/crashes/<serial>/<时间戳>-<FATAL|ANR>/`（`screenshot.png` + `crash.log` + `meta.json`）。

## 安装

```bash
# 方式一（推荐，npm 安装）：
dsh plugin --profile web add @windypro-rourou/dsh-logcat

# 更新到最新版（不会自动更新；装旧版时面板/agent 通告会提示有新版本）：
dsh plugin --profile web update                # 升到当前 major 内最新
# 或强制最新：dsh plugin --profile web add @windypro-rourou/dsh-logcat@latest
# 更新后重启 GUI（dsh web）生效

# 尝鲜 preview 版（日常迭代高频更新，可能不稳定）：
dsh plugin --profile web add @windypro-rourou/dsh-logcat@preview
```

## 发布策略（main / latest 为主）

- **`main` 分支 + npm `latest` 标签**：正式版，更新的主要通道 —— 功能攒够一批就发，直接推 main/latest。
- **`preview` 分支 + npm `preview` 标签**：可选尝鲜通道（高频小步迭代）。正式版发布后如无新的试验特性，
  preview 标签可能停留在上一个预览版本，不必理会。
- 版本自检会按安装通道提示（正式版用户只看 `latest`，preview 用户只看 `preview`，互不打扰）。

```bash
# 方式二（源码本地链接，实时生效无需重启）：把插件链进 web profile，
# 并在 ~/.dsh/profiles/web/cordis.patch.yml 增加一行：
pnpm --dir "%USERPROFILE%\.dsh\profiles\web" add link:F:\dsh-logcat
#   然后在 profile 的 cordis.patch.yml 追加：
#   - insert:
#       - id: logcat
#         name: '@windypro-rourou/dsh-logcat'
# 该 patch 文件会被运行中的 GUI 热监听；若未生效，重启 GUI 即可。

# 方式三（bundle 层，README 原始流程，适合全新 profile；与方式二互斥，勿混用）：
dsh plugin --profile web add link:<本目录绝对路径>
# 之后需要重启 GUI（dsh web）才会装载。
```

> 注意：以上方式都会在 profile 树中插入同一行 `logcat`，不要同时使用，否则下次
> 启动会因重复插件 id 而失败。

依赖解析：`ws` / `react` / `react-dom` / `@deepseek-ai/*` 通过本目录 `node_modules` 下的 junction 指向宿主
实际加载的物理包（保证单例）。若宿主依赖升级，请同步更新 junction 目标。

## 限制

- 需要设备开启 USB 调试并在手机上授权本机（`unauthorized` 状态会提示）。
- logcat 输出可能含敏感信息；`/api/dsh-logcat/*` 路由仅允许 loopback 访问。
- `adb shell` 命令消耗真实设备资源，先确认再执行。

## 文件

- `lib/index.js` — 宿主端：adb 引擎、轮询、logcat 子进程、路由、WebSocket、agent 工具。
- `lib/client.js` — 浏览器端：侧边栏入口 + Logcat 面板（React，无构建步骤）。
- `cordis.patch.yml` — profile bundle patch（自动应用）。
