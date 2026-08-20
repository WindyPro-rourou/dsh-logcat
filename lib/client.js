/**
 * dsh-logcat — browser half. Runs inside the dsh web GUI.
 *
 * Renders an Android-Studio-style Logcat panel:
 *   - sidebar entry row toggling the panel (DOM-level injection, self-healing),
 *   - device dropdown (auto-picks the first attached device / remembers the
 *     last choice), live severity + keyword filters, pause/resume, clear,
 *     copy / export .txt, auto-scroll with stick-to-bottom,
 *   - windowed rendering so a 2000-line buffer stays smooth,
 *   - WebSocket stream with automatic reconnect.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` (lazy CJS) —
 * the only client bundle format the web shell materializes.
 */
window.__ModuleLoader__.load({
	id: "@windypro-rourou/dsh-logcat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { createElement: h, useEffect, useMemo, useRef, useState } = require("react");
		const { createRoot } = require("react-dom/client");

		//#region styles
		const STYLE = `
[data-dsh-logcat-entry] {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; margin: 2px 0; border: 0; border-radius: 8px;
  background: transparent; color: inherit; font: inherit; cursor: pointer;
  text-align: left;
}
[data-dsh-logcat-entry]:hover { background: rgba(128,128,128,.14); }
[data-dsh-logcat-entry][data-active] { background: rgba(128,128,128,.22); }
[data-dsh-logcat-entry] .lc-entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
[data-dsh-logcat-entry] .lc-entry-label { font-size: 13px; line-height: 1.2; opacity: .92; }
.dsh-logcat-view { position: fixed; top: 0; right: 0; bottom: 0; width: min(620px, 94vw); z-index: 9999; }
.dsh-logcat-view[hidden] { display: none !important; }
.dsh-logcat-panel {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: light-dark(#ffffff, #171a1f);
  color: light-dark(#1a1d23, #dfe3ea);
  border-left: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
  box-shadow: -10px 0 28px rgba(0,0,0,.22);
}
.dsh-logcat-resize { position: absolute; left: -6px; top: 0; bottom: 0; width: 12px; cursor: col-resize; z-index: 2; display: flex; align-items: center; justify-content: center; }
.dsh-logcat-resize::before { content: ""; width: 3px; height: 48px; border-radius: 2px; background: light-dark(rgba(0,0,0,.3), rgba(255,255,255,.35)); transition: background .15s, height .15s; }
.dsh-logcat-resize:hover::before, .dsh-logcat-resize[data-drag]::before { background: light-dark(rgba(0,0,0,.6), rgba(255,255,255,.75)); height: 72px; }
.dsh-logcat-resize:hover, .dsh-logcat-resize[data-drag] { background: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.14)); }
.lc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.lc-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; }
.lc-back { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; font-size: 13px; }
.lc-back:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.lc-title { font-size: 15px; font-weight: 700; margin: 0; letter-spacing: .2px; }
.lc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.lc-dot.on { background: #4caf50; box-shadow: 0 0 6px rgba(76,175,80,.6); }
.lc-dot.off { background: #9e9e9e; }
.lc-dot.warn { background: #ff9800; }
.lc-stats { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); flex: none; flex-wrap: wrap; font-size: 11px; }
.lc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); color: light-dark(#4a4f58, #b9bec7); white-space: nowrap; }
.lc-chip b { color: inherit; font-weight: 600; }
.lc-mem-bar { display: inline-block; width: 44px; height: 5px; border-radius: 3px; background: light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); overflow: hidden; vertical-align: middle; }
.lc-mem-fill { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #4caf50, #fbc02d); }
.lc-mem-fill.hot { background: linear-gradient(90deg, #fbc02d, #ef5350); }
.lc-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; flex-wrap: wrap; }
.lc-select, .lc-search { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 5px 9px; }
.lc-select:focus, .lc-search:focus { outline: 2px solid rgba(66,133,244,.35); border-color: rgba(66,133,244,.5); }
.lc-search { flex: 1; min-width: 120px; max-width: 320px; }
.lc-levels { display: flex; gap: 2px; background: light-dark(rgba(0,0,0,.04), rgba(255,255,255,.06)); padding: 2px; border-radius: 7px; }
.lc-level { border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600; width: 24px; height: 22px; border-radius: 5px; cursor: pointer; }
.lc-level:hover { background: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); }
.lc-level[data-on] { background: light-dark(#fff, #2a2f37); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.lc-level.v { color: #9e9e9e; } .lc-level.d { color: #4fc3f7; } .lc-level.i { color: #4caf50; }
.lc-level.w { color: #fbc02d; } .lc-level.e { color: #ef5350; } .lc-level.f { color: #ab47bc; }
.lc-btn { border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer; transition: background .12s; }
.lc-btn:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.lc-btn[data-on] { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.22)); border-color: rgba(66,133,244,.45); color: #4285f4; }
.lc-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.lc-log { position: absolute; inset: 0; overflow: auto; font-family: Consolas, "Cascadia Mono", "Courier New", monospace; font-size: 12px; line-height: 20px; }
.lc-log-inner { position: relative; }
.lc-line { position: absolute; left: 0; right: 0; padding: 0 12px; white-space: pre; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.lc-line:hover { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)); }
.lc-line .ts { color: light-dark(#9aa0a8, #7c838d); margin-right: 8px; }
.lc-line .pid { color: light-dark(#9aa0a8, #7c838d); margin-right: 6px; }
.lc-line .lv { display: inline-block; width: 14px; text-align: center; font-weight: 700; margin-right: 6px; }
.lc-line .lv.V { color: #9e9e9e; } .lc-line .lv.D { color: #4fc3f7; } .lc-line .lv.I { color: #4caf50; }
.lc-line .lv.W { color: #fbc02d; } .lc-line .lv.E { color: #ef5350; } .lc-line .lv.F { color: #ab47bc; }
.lc-line .tag { color: #29b6f6; margin-right: 8px; }
.lc-line.cont .msg { padding-left: 44px; color: light-dark(#9aa0a8, #7c838d); }
.lc-line.crash { background: rgba(239,83,80,.14); box-shadow: inset 2px 0 0 #ef5350; }
.lc-line.crash .tag { color: #ef5350; font-weight: 700; }
.lc-line.crash .msg { color: #ef5350; }
.lc-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: light-dark(#9aa0a8, #7c838d); font-size: 13px; }
.lc-status { display: flex; align-items: center; gap: 14px; padding: 5px 14px; border-top: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; font-size: 11px; color: light-dark(#6b7078, #9aa0a8); }
.lc-status b { font-weight: 600; color: inherit; }
`;
		//#endregion

		//#region panel state
		/** The panel state owner the sidebar entry toggles and the view renders from. */
		class PanelController {
			constructor() {
				this.panelOpen = false;
				this.listeners = new Set();
			}
			getSnapshot() { return { panelOpen: this.panelOpen }; }
			subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
			open() { if (this.panelOpen) return; this.panelOpen = true; this.notify(); }
			close() { if (!this.panelOpen) return; this.panelOpen = false; this.notify(); }
			toggle() { if (this.panelOpen) this.close(); else this.open(); }
			notify() { for (const fn of [...this.listeners]) fn(); }
		}
		//#endregion

		//#region ws + data
		const API_BASE = "/api/dsh-logcat";
		const LEVELS = ["V", "D", "I", "W", "E", "F"];
		const LEVEL_TITLES = { V: "详细", D: "调试", I: "信息", W: "警告", E: "错误", F: "致命" };

		/** The Logcat panel view. */
		function LogcatPanel({ controller }) {
			const [adbPath, setAdbPath] = useState("");
			const [adbReady, setAdbReady] = useState(false);
			const [devices, setDevices] = useState([]);
			const [streaming, setStreaming] = useState([]);
			const [serial, setSerial] = useState(() => { try { return localStorage.getItem("dsh-logcat-serial") ?? ""; } catch { return ""; } });
			const [entries, setEntries] = useState([]);
			const [connected, setConnected] = useState(false);
			const [paused, setPaused] = useState(false);
			const [currentPackage, setCurrentPackage] = useState("");
			const [pkgInput, setPkgInput] = useState("");
			const [installingAdb, setInstallingAdb] = useState(false);
			const [currentVersion, setCurrentVersion] = useState("");
			const [latestVersion, setLatestVersion] = useState("");
			const [updateAvailable, setUpdateAvailable] = useState(false);
			const [updateKind, setUpdateKind] = useState("");
			const [updateHint, setUpdateHint] = useState("");
			const [stats, setStats] = useState(null);
			const [level, setLevel] = useState("");
			const [keyword, setKeyword] = useState("");
			const [autoScroll, setAutoScroll] = useState(true);
			const [scrollTop, setScrollTop] = useState(0);

			const wsRef = useRef(null);
			const entriesRef = useRef([]);
			const devicesRef = useRef([]);
			const serialRef = useRef(serial);
			const pausedRef = useRef(paused);
			const pendingRef = useRef([]);
			const bodyRef = useRef(null);
			const autoScrollRef = useRef(autoScroll);
			const applyFrameRef = useRef(null);

			useEffect(() => { serialRef.current = serial; }, [serial]);
			useEffect(() => { pausedRef.current = paused; }, [paused]);
			useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

			const pickSerial = (next) => {
				try { localStorage.setItem("dsh-logcat-serial", next); } catch { /* private mode */ }
				serialRef.current = next;
				setSerial(next);
				entriesRef.current = [];
				setEntries([]);
				requestReplay(next);
			};

			const requestReplay = (target) => {
				const ws = wsRef.current;
				if (ws !== null && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "replay", serial: target }));
				}
			};

			const scrollToBottom = () => {
				const body = bodyRef.current;
				if (body !== null) body.scrollTop = body.scrollHeight;
			};

			const appendEntries = (incoming) => {
				const next = entriesRef.current.concat(incoming);
				if (next.length > 2000) next.splice(0, next.length - 2000);
				entriesRef.current = next;
				setEntries(next);
				if (autoScrollRef.current) requestAnimationFrame(() => scrollToBottom());
			};

			const applyFrame = (frame) => {
				if (frame.type === "ready") {
					setAdbPath(frame.adbPath ?? "");
					setAdbReady(frame.adbPath != null && frame.adbPath !== "");
					setStreaming(frame.streaming ?? []);
					setDevices(frame.devices ?? []);
					devicesRef.current = frame.devices ?? [];
					if (serialRef.current === "" || !(frame.devices ?? []).some((d) => d.serial === serialRef.current)) {
						const first = (frame.devices ?? []).find((d) => d.state === "device");
						if (first !== undefined) pickSerial(first.serial);
					}
				} else if (frame.type === "devices") {
					setDevices(frame.devices ?? []);
					devicesRef.current = frame.devices ?? [];
					if (serialRef.current === "" || !(frame.devices ?? []).some((d) => d.serial === serialRef.current)) {
						const first = (frame.devices ?? []).find((d) => d.state === "device");
						if (first !== undefined) pickSerial(first.serial);
					}
				} else if (frame.type === "history") {
					if (frame.serial === serialRef.current) {
						entriesRef.current = frame.entries ?? [];
						setEntries(entriesRef.current);
						requestAnimationFrame(() => { if (autoScrollRef.current) scrollToBottom(); });
					}
				} else if (frame.type === "line") {
					if (pausedRef.current) {
						pendingRef.current.push(frame);
						if (pendingRef.current.length > 800) pendingRef.current.splice(0, pendingRef.current.length - 800);
						return;
					}
					if (frame.serial !== serialRef.current) return;
					appendEntries([frame.entry]);
				} else if (frame.type === "device-state") {
					setDevices(devicesRef.current.map((d) => d.serial === frame.serial ? { ...d, state: frame.state } : d));
				} else if (frame.type === "package") {
					setCurrentPackage(frame.package ?? "");
				}
			};
			applyFrameRef.current = applyFrame;

			// WebSocket lifecycle (created once; handlers read latest state through refs).
			useEffect(() => {
				let closed = false;
				let socket = null;
				let retry = 0;
				const connect = () => {
					if (closed) return;
					const scheme = window.location.protocol === "https:" ? "wss" : "ws";
					socket = new WebSocket(scheme + "://" + window.location.host + API_BASE + "/stream");
					wsRef.current = socket;
					socket.onopen = () => {
						retry = 0;
						setConnected(true);
						const target = serialRef.current;
						if (target !== "") socket.send(JSON.stringify({ type: "replay", serial: target }));
					};
					socket.onmessage = (event) => {
						let frame;
						try { frame = JSON.parse(event.data); } catch { return; }
						applyFrameRef.current(frame);
					};
					socket.onclose = () => {
						wsRef.current = null;
						setConnected(false);
						if (closed) return;
						retry = Math.min(retry + 1, 10);
						setTimeout(connect, 800 * retry);
					};
					socket.onerror = () => { try { socket.close(); } catch { /* closed */ } };
				};
				connect();
				return () => {
					closed = true;
					try { socket?.close(); } catch { /* closed */ }
				};
			}, []);

			// Initial status fetch (panel may open long after the plugin loaded).
			useEffect(() => {
				fetch(API_BASE + "/status")
					.then((res) => res.json())
					.then((body) => {
						setAdbPath(body.adbPath ?? "");
						setAdbReady(body.ready === true);
						setDevices(body.devices ?? []);
						setStreaming(body.streaming ?? []);
						setCurrentPackage(body.currentPackage ?? "");
						setCurrentVersion(body.currentVersion ?? "");
						setLatestVersion(body.latestVersion ?? "");
						setUpdateAvailable(body.updateAvailable === true);
						setUpdateKind(body.updateKind ?? "");
						setUpdateHint(body.updateHint ?? "");
						devicesRef.current = body.devices ?? [];
						if (serialRef.current === "" || !(body.devices ?? []).some((d) => d.serial === serialRef.current)) {
							const first = (body.devices ?? []).find((d) => d.state === "device");
							if (first !== undefined) pickSerial(first.serial);
						}
					})
					.catch(() => { /* host not up yet */ });
			}, []);

			// Live device stats (model / memory / cpu / battery) — refresh every 5s.
			useEffect(() => {
				let alive = true;
				let timer = null;
				const load = () => {
					const target = serialRef.current;
					if (target === "") { setStats(null); return; }
					fetch(API_BASE + "/stats?serial=" + encodeURIComponent(target))
						.then((res) => res.json())
						.then((body) => { if (alive) setStats(body?.ready === true ? body : null); })
						.catch(() => { /* device offline */ });
				};
				load();
				timer = setInterval(load, 5000);
				return () => { alive = false; if (timer !== null) clearInterval(timer); };
			}, [serial]);

			const parseCpu = (line) => {
				if (!line) return undefined;
				const m = /([\d.]+)%cpu\s+.*?\s+([\d.]+)%idle/.exec(line);
				if (m === null) return undefined;
				const total = Number(m[1]);
				if (total <= 0) return undefined;
				return Math.round(((total - Number(m[2])) / total) * 100);
			};
			const BATTERY_STATUS = { 1: "未知", 2: "充电中", 3: "放电", 4: "未充电", 5: "已满" };
			const mb = (kb) => kb !== undefined ? (kb / 1024 / 1024).toFixed(1) : undefined;

			const filtered = useMemo(() => {
				const needle = keyword.trim().toLowerCase();
				return entries.filter((e) => {
					if (level !== "" && e.level !== "" && e.level !== level) return false;
					if (needle === "") return true;
					return e.raw.toLowerCase().includes(needle);
				});
			}, [entries, level, keyword]);

			const togglePause = () => {
				const next = !paused;
				setPaused(next);
				if (!next && pendingRef.current.length > 0) {
					const replay = pendingRef.current.filter((f) => f.serial === serialRef.current);
					pendingRef.current = [];
					if (replay.length > 0) appendEntries(replay.map((f) => f.entry));
				}
			};

			const clearLog = () => {
				entriesRef.current = [];
				setEntries([]);
			};

			const exportLog = () => {
				const text = filtered.map((e) => e.raw).join("\n");
				const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
				const a = document.createElement("a");
				a.href = URL.createObjectURL(blob);
				a.download = "logcat-" + (serial || "all") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(a.href), 5000);
			};

			const copyLog = () => {
				const text = filtered.map((e) => e.raw).join("\n");
				if (navigator.clipboard !== undefined) {
					navigator.clipboard.writeText(text).catch(() => { /* denied */ });
				}
			};

			const device = devices.find((d) => d.serial === serial);
			const deviceState = device?.state ?? "";
			const live = connected && serial !== "" && streaming.includes(serial);

			const setPackageFilter = (pkg) => {
				const value = (pkg ?? "").trim();
				setPkgInput(value);
				fetch(API_BASE + "/package", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ package: value }),
				}).catch(() => { /* host not up yet */ });
			};

			const takeScreenshot = () => {
				fetch(API_BASE + "/screenshot?serial=" + encodeURIComponent(serial))
					.then((res) => {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.blob();
					})
					.then((blob) => {
						const a = document.createElement("a");
						a.href = URL.createObjectURL(blob);
						a.download = "logcat-shot-" + (serial || "device") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
						document.body.appendChild(a);
						a.click();
						a.remove();
						setTimeout(() => URL.revokeObjectURL(a.href), 5000);
					})
					.catch(() => { /* device offline etc. */ });
			};

			const installAdb = () => {
				setInstallingAdb(true);
				fetch(API_BASE + "/install-adb", { method: "POST" })
					.then((res) => res.json())
					.then((body) => {
						if (body?.ok !== true) {
							window.alert("adb 安装失败：" + (body?.error ?? "未知错误"));
							return;
						}
						// Refresh status so the panel picks up the freshly installed adb.
						return fetch(API_BASE + "/status")
							.then((res) => res.json())
							.then((b) => {
								setAdbPath(b.adbPath ?? "");
								setAdbReady(b.ready === true);
								setDevices(b.devices ?? []);
								setStreaming(b.streaming ?? []);
								setCurrentPackage(b.currentPackage ?? "");
							});
					})
					.catch(() => { window.alert("adb 安装失败：网络错误"); })
					.finally(() => setInstallingAdb(false));
			};

			return h("div", { className: "lc-panel" },
				h("div", { className: "lc-header" },
					h("button", { type: "button", className: "lc-back", onClick: () => controller.close() },
						h("span", { "aria-hidden": true }, "‹"),
						h("span", null, "关闭"),
					),
					h("h2", { className: "lc-title" }, "Logcat"),
					h("span", { className: "lc-dot " + (live ? "on" : connected ? "warn" : "off") }),
					h("span", { style: { fontSize: 12, color: "var(--lc-dim, #9e9e9e)" } },
						live ? "实机日志流中" : connected ? "未选设备" : "未连接"),
					h("select", {
						className: "lc-select",
						value: serial,
						onChange: (e) => pickSerial(e.target.value),
						title: "选择设备",
					},
						devices.length === 0
							? h("option", { value: "" }, "无设备 — 请连接并开启 USB 调试")
							: devices.map((d) =>
								h("option", { key: d.serial, value: d.serial },
									(d.model !== "" ? d.model + " · " : "") + d.serial + " [" + d.state + "]"))),
				),
				h("div", { className: "lc-stats" },
					stats?.model
						? h("span", { className: "lc-chip", title: "设备型号 / 系统版本" },
							stats.model + (stats.androidVersion ? " · Android " + stats.androidVersion : ""))
						: null,
					stats?.resolution
						? h("span", { className: "lc-chip", title: "屏幕分辨率" }, stats.resolution)
						: null,
					stats?.memPct !== undefined
						? h("span", { className: "lc-chip", title: "内存 " + (mb(stats.usedMemKb) ?? "?") + "G / " + (mb(stats.totalMemKb) ?? "?") + "G" },
							"内存 ",
							h("span", { className: "lc-mem-bar" },
								h("span", {
									className: "lc-mem-fill" + (stats.memPct > 85 ? " hot" : ""),
									style: { width: stats.memPct + "%" },
								})),
							" " + stats.memPct + "%")
						: null,
					parseCpu(stats?.cpu) !== undefined
						? h("span", { className: "lc-chip", title: "CPU 使用率（采样）" }, "CPU " + parseCpu(stats.cpu) + "%")
						: null,
					stats?.batteryLevel !== undefined
						? h("span", { className: "lc-chip", title: "电量" },
							"电量 " + stats.batteryLevel + "%" + (BATTERY_STATUS[stats.batteryStatus] !== undefined ? " · " + BATTERY_STATUS[stats.batteryStatus] : ""))
						: null,
					stats === null && serial !== "" ? h("span", { className: "lc-chip" }, "正在采集设备状态…") : null,
				),
				h("div", { className: "lc-toolbar" },
					h("div", { className: "lc-levels", role: "group", "aria-label": "日志级别" },
						h("button", {
							type: "button",
							className: "lc-level i",
							"data-on": level === "" ? "" : undefined,
							title: "全部级别",
							onClick: () => setLevel(""),
						}, "A"),
						LEVELS.map((lv) =>
							h("button", {
								type: "button",
								key: lv,
								className: "lc-level " + lv.toLowerCase(),
								"data-on": level === lv ? "" : undefined,
								title: LEVEL_TITLES[lv],
								onClick: () => setLevel(level === lv ? "" : lv),
							}, lv))),
					h("input", {
						className: "lc-search",
						type: "search",
						placeholder: "关键词过滤…",
						value: keyword,
						onChange: (e) => setKeyword(e.target.value),
					}),
					h("input", {
						className: "lc-search",
						type: "text",
						placeholder: "测试包名（回车）…",
						title: "设置/清除当前测试应用包名（与 agent 的 logcat_set_package 互通）",
						value: pkgInput,
						onChange: (e) => setPkgInput(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") setPackageFilter(pkgInput); },
						style: { maxWidth: 180 },
					}),
					h("button", { type: "button", className: "lc-btn", onClick: () => setPackageFilter(pkgInput), title: "按包名过滤日志（agent 侧 logcat_recent 同步生效）" }, "包名"),
					h("button", { type: "button", className: "lc-btn", onClick: takeScreenshot, title: "截取真机屏幕并下载 PNG" }, "截图"),
					h("button", { type: "button", className: "lc-btn", "data-on": paused ? "" : undefined, onClick: togglePause },
						paused ? "继续" : "暂停"),
					h("button", { type: "button", className: "lc-btn", onClick: clearLog }, "清空"),
					h("button", { type: "button", className: "lc-btn", onClick: copyLog }, "复制"),
					h("button", { type: "button", className: "lc-btn", onClick: exportLog }, "导出"),
					h("button", {
						type: "button",
						className: "lc-btn",
						"data-on": autoScroll ? "" : undefined,
						title: "新日志自动滚到底部",
						onClick: () => setAutoScroll(!autoScroll),
					}, "自动滚动"),
				),
				h("div", { className: "lc-body", ref: bodyRef },
					filtered.length === 0
						? h("div", { className: "lc-empty" }, paused ? "已暂停（" + entries.length + " 条已缓冲）" : "暂无日志")
						: h(VirtualLog, { entries: filtered, scrollTop, onScrollTop: setScrollTop, bodyRef }),
				),
				h("div", { className: "lc-status" },
					h("span", null,
						h("b", null, adbReady ? "adb 就绪" : "未找到 adb"),
						" · " + (adbPath || "—"),
						!adbReady
							? h("button", {
								type: "button",
								className: "lc-btn",
								style: { marginLeft: 8, padding: "2px 8px" },
								title: "从 Google 官方下载 platform-tools 到 ~/.dsh/adb 并接入（约 10MB）",
								onClick: installAdb,
							}, installingAdb ? "安装中…" : "一键安装 adb")
							: null),
					h("span", null, "设备 " + devices.length + " · 在线 " + devices.filter((d) => d.state === "device").length),
					h("span", null, "显示 " + filtered.length + " / 缓冲 " + entries.length + " 行"),
					h("span", { title: "插件版本" }, "v" + (currentVersion || "?")),
					updateAvailable === true
						? h("span", { style: { color: updateKind === "preview" ? "#4fc3f7" : "#fbc02d" } },
							h("b", null, updateHint || "有新版本"),
							updateKind === "preview" ? "（preview 尝鲜版）" : "（dsh plugin --profile web update 后重启 GUI）")
						: null,
					currentPackage !== ""
						? h("span", { title: "当前测试应用包名（agent 通过 logcat_set_package 设置）" }, "测试: " + currentPackage)
						: null,
					deviceState === "unauthorized"
						? h("span", { style: { color: "#ef5350" } }, "⚠ 设备未授权 — 请在手机上点击“允许 USB 调试”")
						: null,
				),
			);
		}

		/** Windowed log list: fixed 20px rows, only the visible slice is rendered. */
		function VirtualLog({ entries, scrollTop, onScrollTop, bodyRef }) {
			const ROW = 20;
			const height = useRef(0);
			const [viewport, setViewport] = useState({ top: 0, bottom: 100 });

			useEffect(() => {
				const body = bodyRef.current;
				if (body === null) return;
				const measure = () => {
					height.current = body.clientHeight;
					const top = Math.max(0, Math.floor(scrollTop / ROW) - 8);
					const bottom = Math.min(entries.length, Math.ceil((scrollTop + height.current) / ROW) + 8);
					setViewport({ top, bottom });
				};
				measure();
				if (typeof ResizeObserver !== "undefined") {
					const observer = new ResizeObserver(measure);
					observer.observe(body);
					return () => observer.disconnect();
				}
				return undefined;
			}, [entries.length]);

			useEffect(() => {
				const top = Math.max(0, Math.floor(scrollTop / ROW) - 8);
				const bottom = Math.min(entries.length, Math.ceil((scrollTop + (height.current || 400)) / ROW) + 8);
				setViewport({ top, bottom });
			}, [scrollTop, entries.length]);

			const rows = [];
			const isCrash = (e) => /FATAL EXCEPTION|ANR in /.test(e.raw) || (e.tag === "AndroidRuntime" && e.level === "F");
			for (let i = viewport.top; i < viewport.bottom && i < entries.length; i++) {
				const e = entries[i];
				const level = e.level !== "" ? e.level : " ";
				rows.push(
					h("div", {
						key: i,
						className: "lc-line" + (e.cont === true ? " cont" : "") + (isCrash(e) ? " crash" : ""),
						style: { top: i * ROW },
						title: e.raw,
					},
						e.ts !== "" ? h("span", { className: "ts" }, e.ts) : null,
						e.pid > 0 ? h("span", { className: "pid" }, e.pid + "-" + e.tid) : null,
						e.level !== "" ? h("span", { className: "lv " + level }, level) : null,
						e.tag !== "" ? h("span", { className: "tag" }, e.tag) : null,
						h("span", { className: "msg" }, e.msg !== "" ? e.msg : e.raw),
					),
				);
			}

			return h("div",
				{
					className: "lc-log",
					ref: bodyRef,
					onScroll: (e) => { onScrollTop(e.target.scrollTop); },
				},
				h("div", { className: "lc-log-inner", style: { height: entries.length * ROW } }, rows),
			);
		}
		//#endregion

		//#region DOM mounts
		const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="3" y="1.5" width="10" height="13" rx="2"/><path d="M6.5 4.5h3M6.5 7h3M6.5 9.5h1.5" stroke-linecap="round"/><circle cx="8" cy="12" r="0.9" fill="currentColor" stroke="none"/></svg>';

		function sidebarRoot() {
			const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (column === null) return undefined;
			const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
			return logoOwner ?? (column.firstElementChild ?? undefined);
		}

		function newSessionButton(root) {
			const nested = root.querySelector('button[class*="newSession"]');
			if (nested !== null) return nested;
			for (const child of root.children) {
				if (child.tagName === "BUTTON") return child;
			}
			return undefined;
		}

		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshLogcatEntry = "";
			entry.setAttribute("aria-label", "Logcat 实机调试");
			entry.setAttribute("title", "Logcat 实机调试（自动连接 adb 设备）");
			entry.innerHTML = '<span class="lc-entry-icon">' + ICON + '</span><span class="lc-entry-label">Logcat</span>';
			entry.addEventListener("click", () => { controller.toggle(); });
			return entry;
		}

		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === undefined) return false;
			if (entry.parentElement !== root) {
				const row = button.closest('[class*="logoRow"]');
				const base = (row !== null && row.parentElement === root) ? row : button;
				const family = Array.from(root.children).filter(
					(el) => el instanceof HTMLElement && el.matches("[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-logcat-entry]"),
				);
				const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}

		function mountSidebarEntry(controller) {
			const entry = createEntry(controller);
			let root;
			let placed = false;
			let rootObserver;

			const tryPlace = () => {
				if (root !== undefined && !root.isConnected) {
					rootObserver?.disconnect();
					root = undefined;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver?.disconnect();
					root = undefined;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === undefined) return;
				placed = placeEntry(root, entry);
				if (placed) {
					rootObserver = new MutationObserver(() => {
						if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
						if (!root.contains(entry)) placed = placeEntry(root, entry);
					});
					rootObserver.observe(root, { childList: true, subtree: true });
				}
			};

			const waitObserver = new MutationObserver(() => { tryPlace(); });
			waitObserver.observe(document.body, { childList: true, subtree: true });

			const syncActive = () => {
				if (controller.getSnapshot().panelOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			tryPlace();

			return () => {
				waitObserver.disconnect();
				rootObserver?.disconnect();
				unsubscribe();
				entry.remove();
			};
		}

		function mountPanel(controller) {
			let root;
			let container;
			let handle;
			let drag = null;

			const MIN_WIDTH = 320;
			const DEFAULT_WIDTH = 620;
			const readWidth = () => {
				try {
					const w = Number(localStorage.getItem("dsh-logcat-width"));
					if (Number.isFinite(w) && w >= MIN_WIDTH && w <= window.innerWidth - 40) return w;
				} catch { /* private mode */ }
				return Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80));
			};

			const onMove = (e) => {
				if (drag === null || container === undefined) return;
				const width = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 40, drag.startWidth + (drag.startX - e.clientX)));
				container.style.width = width + "px";
			};
			const onUp = () => {
				if (drag === null) return;
				handle?.removeAttribute("data-drag");
				try {
					const w = container.style.width.replace("px", "");
					localStorage.setItem("dsh-logcat-width", w);
				} catch { /* private mode */ }
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				drag = null;
			};
			const onDown = (e) => {
				e.preventDefault();
				if (drag !== null) return;
				// double-click on the handle resets to the default width
				const now = Date.now();
				if (now - (handle?._lastClick ?? 0) < 350) {
					handle._lastClick = 0;
					container.style.width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80)) + "px";
					try { localStorage.setItem("dsh-logcat-width", String(Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80)))); } catch { /* private */ }
					return;
				}
				handle._lastClick = now;
				drag = { startX: e.clientX, startWidth: container.getBoundingClientRect().width };
				handle?.setAttribute("data-drag", "");
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			const ensure = () => {
				if (container !== undefined && container.isConnected) return;
				root?.unmount();
				root = undefined;
				container?.remove();
				handle = undefined;
				// Wrapper keeps the resize handle OUTSIDE the React root — createRoot clears
				// the container's children on render, which used to delete the handle.
				container = document.createElement("div");
				container.dataset.dshLogcatView = "";
				container.className = "dsh-logcat-view";
				container.style.width = readWidth() + "px";
				container.hidden = true; // side-drawer: hidden until the sidebar entry is clicked
				handle = document.createElement("div");
				handle.className = "dsh-logcat-resize";
				handle.title = "拖拽调整宽度（双击重置）";
				handle.addEventListener("mousedown", onDown);
				container.appendChild(handle);
				const panel = document.createElement("div");
				panel.className = "dsh-logcat-panel";
				container.appendChild(panel);
				document.body.appendChild(container);
				root = createRoot(panel);
				root.render(h(LogcatPanel, { controller }));
			};

			// The drawer lives on <body>, which never gets rebuilt — mount once.
			ensure();

			const applyOpen = () => {
				if (container !== undefined) container.hidden = !controller.getSnapshot().panelOpen;
			};
			const unsubscribe = controller.subscribe(applyOpen);
			applyOpen();

			return () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				unsubscribe();
				root?.unmount();
				root = undefined;
				container?.remove();
				container = undefined;
				handle = undefined;
			};
		}
		//#endregion

		//#region entry
		/** Required services (fiber inject waiting — the runtime must be up first). */
		const inject = ["slots"];

		/**
		 * Mount the Logcat panel.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = STYLE;
			style.dataset.dshLogcatStyle = "";
			document.head.appendChild(style);

			const controller = new PanelController();
			const disposers = [];
			try {
				disposers.push(mountSidebarEntry(controller));
				disposers.push(mountPanel(controller));
			} catch (error) {
				console.warn("[dsh-logcat] mount failed:", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
				style.remove();
			}, "dsh-logcat: ui mounts");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
