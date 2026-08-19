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
	id: "@linxin666/dsh-logcat",
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
.dsh-logcat-view { position: fixed; top: 0; right: 0; bottom: 0; width: min(620px, 94vw); display: flex; flex-direction: column; background: var(--lc-bg, #ffffff); border-left: 1px solid rgba(128,128,128,.3); box-shadow: -10px 0 28px rgba(0,0,0,.18); z-index: 9999; }
.dsh-logcat-view[hidden] { display: none !important; }
.lc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.lc-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,.25); flex: none; }
.lc-back { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; font-size: 13px; }
.lc-back:hover { background: rgba(128,128,128,.14); }
.lc-title { font-size: 15px; font-weight: 600; margin: 0; }
.lc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.lc-dot.on { background: #4caf50; }
.lc-dot.off { background: #9e9e9e; }
.lc-dot.warn { background: #ff9800; }
.lc-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid rgba(128,128,128,.25); flex: none; flex-wrap: wrap; }
.lc-select, .lc-search { background: rgba(128,128,128,.08); border: 1px solid rgba(128,128,128,.3); border-radius: 6px; color: inherit; font: inherit; font-size: 12px; padding: 4px 8px; }
.lc-select:focus, .lc-search:focus { outline: 1px solid rgba(128,128,128,.5); }
.lc-search { flex: 1; min-width: 120px; max-width: 320px; }
.lc-levels { display: flex; gap: 2px; }
.lc-level { border: 1px solid transparent; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600; width: 24px; height: 24px; border-radius: 5px; cursor: pointer; }
.lc-level:hover { background: rgba(128,128,128,.12); }
.lc-level[data-on] { background: rgba(128,128,128,.22); border-color: rgba(128,128,128,.4); }
.lc-level.v { color: #9e9e9e; } .lc-level.d { color: #4fc3f7; } .lc-level.i { color: #4caf50; }
.lc-level.w { color: #fbc02d; } .lc-level.e { color: #ef5350; } .lc-level.f { color: #ab47bc; }
.lc-btn { border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.lc-btn:hover { background: rgba(128,128,128,.12); }
.lc-btn[data-on] { background: rgba(128,128,128,.22); }
.lc-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.lc-log { position: absolute; inset: 0; overflow: auto; font-family: Consolas, "Cascadia Mono", "Courier New", monospace; font-size: 12px; line-height: 20px; }
.lc-log-inner { position: relative; }
.lc-line { position: absolute; left: 0; right: 0; padding: 0 12px; white-space: pre; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.lc-line:hover { background: rgba(128,128,128,.12); }
.lc-line .ts { color: var(--lc-dim, #9e9e9e); margin-right: 8px; }
.lc-line .pid { color: var(--lc-dim, #9e9e9e); margin-right: 6px; }
.lc-line .lv { display: inline-block; width: 14px; text-align: center; font-weight: 700; margin-right: 6px; }
.lc-line .lv.V { color: #9e9e9e; } .lc-line .lv.D { color: #4fc3f7; } .lc-line .lv.I { color: #4caf50; }
.lc-line .lv.W { color: #fbc02d; } .lc-line .lv.E { color: #ef5350; } .lc-line .lv.F { color: #ab47bc; }
.lc-line .tag { color: #29b6f6; margin-right: 8px; }
.lc-line.cont .msg { padding-left: 44px; color: var(--lc-dim, #9e9e9e); }
.lc-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--lc-dim, #9e9e9e); font-size: 13px; }
.lc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px; border-top: 1px solid rgba(128,128,128,.25); flex: none; font-size: 11px; color: var(--lc-dim, #9e9e9e); }
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
						devicesRef.current = body.devices ?? [];
						if (serialRef.current === "" || !(body.devices ?? []).some((d) => d.serial === serialRef.current)) {
							const first = (body.devices ?? []).find((d) => d.state === "device");
							if (first !== undefined) pickSerial(first.serial);
						}
					})
					.catch(() => { /* host not up yet */ });
			}, []);

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
					h("span", null, h("b", null, adbReady ? "adb 就绪" : "未找到 adb"), " · " + (adbPath || "—")),
					h("span", null, "设备 " + devices.length + " · 在线 " + devices.filter((d) => d.state === "device").length),
					h("span", null, "显示 " + filtered.length + " / 缓冲 " + entries.length + " 行"),
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
			for (let i = viewport.top; i < viewport.bottom && i < entries.length; i++) {
				const e = entries[i];
				const level = e.level !== "" ? e.level : " ";
				rows.push(
					h("div", {
						key: i,
						className: "lc-line" + (e.cont === true ? " cont" : ""),
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

			const ensure = () => {
				if (container !== undefined && container.isConnected) return;
				root?.unmount();
				root = undefined;
				container?.remove();
				container = document.createElement("div");
				container.dataset.dshLogcatView = "";
				container.className = "dsh-logcat-view";
				container.hidden = true; // side-drawer: hidden until the sidebar entry is clicked
				document.body.appendChild(container);
				root = createRoot(container);
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
				unsubscribe();
				root?.unmount();
				root = undefined;
				container?.remove();
				container = undefined;
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
