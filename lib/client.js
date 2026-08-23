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

		const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require("react");
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
.lc-tabs { display: flex; gap: 4px; padding: 6px 12px 0; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); flex: none; }
.lc-tab { border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 7px 7px 0 0; cursor: pointer; opacity: .75; }
.lc-tab:hover { opacity: 1; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)); }
.lc-tab[data-on] { opacity: 1; background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); box-shadow: inset 0 -2px 0 #4285f4; }
.lc-keys { display: flex; gap: 4px; padding: 0 12px 6px; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); flex: none; flex-wrap: wrap; }
.lc-key { border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
.lc-key:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.lc-crashbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: rgba(239,83,80,.12); border-bottom: 1px solid rgba(239,83,80,.35); flex: none; font-size: 12px; }
.lc-crashbar b { color: #ef5350; }
.lc-crashbar .lc-btn { padding: 2px 8px; }
.lc-histnote { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: light-dark(rgba(66,133,244,.08), rgba(66,133,244,.14)); border-bottom: 1px solid light-dark(rgba(66,133,244,.25), rgba(66,133,244,.35)); flex: none; font-size: 11px; color: #4285f4; }
.lc-overlay { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
.lc-modal { width: min(480px, 92%); max-height: 82%; display: flex; flex-direction: column; background: light-dark(#ffffff, #1e2229); border: 1px solid light-dark(rgba(0,0,0,.2), rgba(255,255,255,.16)); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4); overflow: hidden; }
.lc-modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); font-weight: 700; font-size: 13px; }
.lc-modal-head .sp { flex: 1; }
.lc-modal-body { padding: 10px 14px; overflow: auto; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.lc-crash-item { border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.lc-crash-item:hover { background: light-dark(rgba(0,0,0,.04), rgba(255,255,255,.06)); }
.lc-crash-item .t { font-weight: 700; color: #ef5350; font-size: 12px; }
.lc-crash-item .s { color: light-dark(#6b7078, #9aa0a8); margin-top: 3px; word-break: break-all; }
.lc-crash-detail { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.lc-crash-detail img { max-width: 100%; border-radius: 6px; border: 1px solid light-dark(rgba(0,0,0,.15), rgba(255,255,255,.2)); }
.lc-crash-detail pre { max-height: 220px; overflow: auto; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.06)); border-radius: 6px; padding: 8px; margin: 0; font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-all; font-family: Consolas, "Cascadia Mono", monospace; }
.lc-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.lc-field input { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 5px 9px; }
.lc-wifi-out { white-space: pre-wrap; font-family: Consolas, monospace; font-size: 11px; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.06)); border-radius: 6px; padding: 8px; max-height: 120px; overflow: auto; margin: 0; }
.lc-spark { display: inline-block; vertical-align: middle; }
.lc-spark svg { display: block; }
.lc-re { position: absolute; inset: 0; display: flex; flex-direction: column; }
.lc-re-top { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); flex: none; align-items: center; flex-wrap: wrap; }
.lc-re-top input { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 5px 9px; }
.lc-re-split { flex: 1; min-height: 0; display: flex; }
.lc-re-col { width: 42%; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); }
.lc-re-col2 { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lc-re-head { padding: 5px 10px; font-size: 11px; font-weight: 700; color: light-dark(#6b7078, #9aa0a8); border-bottom: 1px solid light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08)); flex: none; }
.lc-re-list { flex: 1; overflow: auto; font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; }
.lc-re-row { padding: 3px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-re-row:hover { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)); }
.lc-re-row[data-on] { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.2)); }
.lc-re-dump { flex: 1; overflow: auto; padding: 8px 10px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-all; }
.lc-re-err { padding: 8px 10px; color: #ef5350; font-size: 12px; white-space: pre-wrap; }
.lc-screen { position: absolute; inset: 0; display: flex; flex-direction: column; }
.lc-screen-bar { display: flex; gap: 6px; padding: 6px 12px; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); flex: none; align-items: center; flex-wrap: wrap; font-size: 11px; }
.lc-screen-bar input { background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 4px 8px; }
.lc-screen-img { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; cursor: crosshair; background: light-dark(rgba(0,0,0,.03), rgba(255,255,255,.03)); position: relative; }
.lc-screen-img img, .lc-screen-img canvas { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; }
.lc-screen-hint { color: light-dark(#6b7078, #9aa0a8); }
`;
		//#endregion

		//#region panel state
		/** The panel state owner the sidebar entry toggles and the view renders from. */
		class PanelController {
			constructor() {
				this.panelOpen = false;
				this.listeners = new Set();
				this._snap = { panelOpen: false };
				// Bound as instance arrow properties: useSyncExternalStore calls them
				// WITHOUT a receiver, so prototype methods would lose `this` (white
				// panel). Arrow properties also give stable references.
				this.getSnapshot = () => {
					if (this._snap.panelOpen !== this.panelOpen) this._snap = { panelOpen: this.panelOpen };
					return this._snap;
				};
				this.subscribe = (fn) => {
					this.listeners.add(fn);
					return () => { this.listeners.delete(fn); };
				};
			}
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
			const [tab, setTab] = useState("log");
			const [eventsOn, setEventsOn] = useState(false);
			const [eventsEntries, setEventsEntries] = useState([]);
			const [eventsStreaming, setEventsStreaming] = useState([]);
			const [lastCrash, setLastCrash] = useState(null);
			const [crashModal, setCrashModal] = useState(false);
			const [crashList, setCrashList] = useState([]);
			const [crashOpenId, setCrashOpenId] = useState("");
			const [crashDetail, setCrashDetail] = useState(null);
			const [wifiOpen, setWifiOpen] = useState(false);
			const [wifiHost, setWifiHost] = useState("");
			const [wifiPort, setWifiPort] = useState("");
			const [wifiCode, setWifiCode] = useState("");
			const [wifiOut, setWifiOut] = useState("");
			const [historyNote, setHistoryNote] = useState("");
			const [installingApk, setInstallingApk] = useState(false);
			const [reFilter, setReFilter] = useState("");
			const [rePids, setRePids] = useState([]);
			const [rePid, setRePid] = useState(0);
			const [rePattern, setRePattern] = useState("");
			const [reResults, setReResults] = useState([]);
			const [reSearching, setReSearching] = useState(false);
			const [reDump, setReDump] = useState("");
			const [reDumpAddr, setReDumpAddr] = useState("");
			const [reError, setReError] = useState("");
			const [spark, setSpark] = useState({ cpu: [], mem: [], bat: [] });
			const [screenImg, setScreenImg] = useState(null);
			const [screenText, setScreenText] = useState("");
			const [screenOn, setScreenOn] = useState(false);
			const [screenFps, setScreenFps] = useState(0);
			const [screenHasFrame, setScreenHasFrame] = useState(false);
			const [hostScreenCapable, setHostScreenCapable] = useState(false);
			const panelOpen = useSyncExternalStore(controller.subscribe, controller.getSnapshot).panelOpen;

			const wsRef = useRef(null);
			const entriesRef = useRef([]);
			const devicesRef = useRef([]);
			const serialRef = useRef(serial);
			const pausedRef = useRef(paused);
			const pendingRef = useRef([]);
			const bodyRef = useRef(null);
			const autoScrollRef = useRef(autoScroll);
			const applyFrameRef = useRef(null);
			const eventsRef = useRef([]);
			const fileInputRef = useRef(null);
			const screenWrapRef = useRef(null);
			const screenImgRef = useRef(null);
			const screenCanvasRef = useRef(null);
			const screenDragRef = useRef(null);
			const screenWantRef = useRef(false);
			const handleBinaryRef = useRef(null);
			const prevSerialRef = useRef(serial);
			const screenDecodingRef = useRef(false);
			const screenPendingRef = useRef(null);
			const screenFpsTsRef = useRef([]);

			useEffect(() => { serialRef.current = serial; }, [serial]);
			useEffect(() => { pausedRef.current = paused; }, [paused]);
			useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

			const pickSerial = (next) => {
				try { localStorage.setItem("dsh-logcat-serial", next); } catch { /* private mode */ }
				serialRef.current = next;
				setSerial(next);
				entriesRef.current = [];
				setEntries([]);
				eventsRef.current = [];
				setEventsEntries([]);
				setHistoryNote("");
				setLastCrash(null);
				setCrashList([]);
				setCrashOpenId("");
				setCrashDetail(null);
				setReResults([]);
				setReDump("");
				setReDumpAddr("");
				setReError("");
				setSpark({ cpu: [], mem: [], bat: [] });
				requestReplay(next);
				if (eventsOn) {
					const ws = wsRef.current;
					if (ws !== null && ws.readyState === WebSocket.OPEN) {
						const prev = serialRef.current;
						if (prev !== "" && prev !== next) ws.send(JSON.stringify({ type: "events", serial: prev, on: false }));
						ws.send(JSON.stringify({ type: "events", serial: next, on: true }));
					}
				}
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
					setEventsStreaming(frame.eventsStreaming ?? []);
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
				} else if (frame.type === "eline") {
					if (frame.serial !== serialRef.current) return;
					const next = eventsRef.current.concat([frame.entry]);
					if (next.length > 2000) next.splice(0, next.length - 2000);
					eventsRef.current = next;
					setEventsEntries(next);
				} else if (frame.type === "ehistory") {
					if (frame.serial === serialRef.current) {
						eventsRef.current = frame.entries ?? [];
						setEventsEntries(eventsRef.current);
					}
				} else if (frame.type === "crash") {
					setLastCrash(frame.crash ?? null);
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
					socket.binaryType = "arraybuffer";
					wsRef.current = socket;
					socket.onopen = () => {
						retry = 0;
						setConnected(true);
						const target = serialRef.current;
						if (target !== "") socket.send(JSON.stringify({ type: "replay", serial: target }));
						if (screenWantRef.current && target !== "") {
							socket.send(JSON.stringify({ type: "screen", serial: target, on: true }));
						}
					};
					socket.onmessage = (event) => {
						if (event.data instanceof ArrayBuffer) { handleBinaryRef.current?.(event.data); return; }
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
						setEventsStreaming(body.eventsStreaming ?? []);
						setHostScreenCapable(body.screenCapable === true);
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

			// Live device stats (model / memory / cpu / battery) + sparkline history — every 2s.
			useEffect(() => {
				let alive = true;
				let timer = null;
				const push = (key, value) => {
					if (value === undefined || value === null) return;
					setSpark((prev) => {
						const arr = prev[key].concat([value]);
						if (arr.length > 90) arr.splice(0, arr.length - 90);
						return { ...prev, [key]: arr };
					});
				};
				const load = () => {
					const target = serialRef.current;
					if (target === "") { setStats(null); return; }
					fetch(API_BASE + "/stats?serial=" + encodeURIComponent(target))
						.then((res) => res.json())
						.then((body) => {
							if (!alive) return;
							if (body?.ready === true) {
								setStats(body);
								push("cpu", parseCpu(body.cpu));
								push("mem", body.memPct);
								push("bat", body.batteryLevel);
							} else {
								setStats(null);
							}
						})
						.catch(() => { /* device offline */ });
				};
				load();
				timer = setInterval(load, 2000);
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
				const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
				return entries.filter((e) => {
					if (level !== "" && e.level !== "" && e.level !== level) return false;
					if (terms.length === 0) return true;
					const raw = e.raw.toLowerCase();
					return terms.some((t) => raw.includes(t));
				});
			}, [entries, level, keyword]);

			const filteredEvents = useMemo(() => {
				const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
				return eventsEntries.filter((e) => {
					if (terms.length === 0) return true;
					const raw = e.raw.toLowerCase();
					return terms.some((t) => raw.includes(t));
				});
			}, [eventsEntries, keyword]);

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

			const sendKey = (key) => {
				fetch(API_BASE + "/keyevent", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ serial, key }),
				}).catch(() => { /* offline */ });
			};

			const installApkFile = (file) => {
				if (file === null || file === undefined) return;
				setInstallingApk(true);
				fetch(API_BASE + "/install-apk?serial=" + encodeURIComponent(serial), {
					method: "POST",
					body: file,
				})
					.then((res) => res.json())
					.then((body) => {
						if (body?.ok === true) window.alert("APK 安装成功：" + file.name);
						else window.alert("APK 安装失败：" + (body?.stderr || body?.error || "未知错误"));
					})
					.catch(() => window.alert("APK 安装失败：网络错误"))
					.finally(() => setInstallingApk(false));
			};

			const loadHistory = () => {
				fetch(API_BASE + "/history?serial=" + encodeURIComponent(serial) + "&lines=1000")
					.then((res) => res.json())
					.then((body) => {
						if (body?.entries === undefined) return;
						const disk = body.entries;
						if (disk.length === 0) { setHistoryNote("磁盘上没有历史日志"); return; }
						const merged = disk.concat(entriesRef.current);
						if (merged.length > 4000) merged.splice(0, merged.length - 4000);
						entriesRef.current = merged;
						setEntries(merged);
						setHistoryNote("已回溯 " + disk.length + " 条磁盘历史（最早 " + (disk[0]?.ts ?? "?") + "）");
						requestAnimationFrame(() => { if (autoScrollRef.current) scrollToBottom(); });
					})
					.catch(() => setHistoryNote("历史加载失败"));
			};

			const toggleEvents = () => {
				const next = !eventsOn;
				setEventsOn(next);
				const ws = wsRef.current;
				if (ws !== null && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "events", serial, on: next }));
				}
				if (!next) { eventsRef.current = []; setEventsEntries([]); }
			};

			const openCrashModal = () => {
				setCrashModal(true);
				setCrashList([]);
				setCrashOpenId("");
				setCrashDetail(null);
				fetch(API_BASE + "/crashes?serial=" + encodeURIComponent(serial))
					.then((res) => res.json())
					.then((body) => setCrashList(body?.crashes ?? []))
					.catch(() => setCrashList([]));
			};

			const toggleCrashDetail = (id) => {
				if (crashOpenId === id) { setCrashOpenId(""); setCrashDetail(null); return; }
				setCrashOpenId(id);
				setCrashDetail({ loading: true });
				fetch(API_BASE + "/crash-file?serial=" + encodeURIComponent(serial) + "&id=" + encodeURIComponent(id) + "&file=crash.log")
					.then((res) => (res.ok ? res.text() : Promise.reject(new Error("HTTP " + res.status))))
					.then((text) => setCrashDetail({ log: text }))
					.catch(() => setCrashDetail({ log: "(failed to load crash.log)" }));
			};

			const wifiConnect = () => {
				setWifiOut("连接中…");
				fetch(API_BASE + "/wifi-connect", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ host: wifiHost, port: wifiPort, code: wifiCode }),
				})
					.then((res) => res.json())
					.then((body) => setWifiOut(body?.output ?? JSON.stringify(body)))
					.catch(() => setWifiOut("网络错误"));
			};

			const wifiDisconnect = () => {
				fetch(API_BASE + "/wifi-disconnect", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ host: wifiHost, port: wifiPort }),
				})
					.then((res) => res.json())
					.then((body) => setWifiOut(body?.output ?? "已断开"))
					.catch(() => setWifiOut("网络错误"));
			};

			// RE workbench: auto-load the process list when the tab opens.
			useEffect(() => {
				if (tab === "re" && serial !== "") loadProcesses();
			}, [tab, serial]);

			const loadProcesses = () => {
				fetch(API_BASE + "/processes?serial=" + encodeURIComponent(serial) + "&filter=" + encodeURIComponent(reFilter))
					.then((res) => res.json())
					.then((body) => { setRePids(body?.processes ?? []); setReError(""); })
					.catch(() => setReError("进程列表加载失败"));
			};

			const reSearch = () => {
				if (!Number.isInteger(rePid) || rePid <= 0) { setReError("先选择进程"); return; }
				if (rePattern.trim() === "") { setReError("输入搜索内容（字符串或 hex:…）"); return; }
				setReSearching(true);
				setReError("");
				fetch(API_BASE + "/mem-search", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ serial, pid: rePid, pattern: rePattern.trim(), maxResults: 50 }),
				})
					.then((res) => res.json())
					.then((body) => {
						if (body?.error) { setReError(body.error); setReResults([]); return; }
						setReResults(body?.offsets ?? []);
						if ((body?.offsets ?? []).length === 0) setReError("无匹配");
					})
					.catch(() => setReError("搜索失败"))
					.finally(() => setReSearching(false));
			};

			const reDumpAt = (addr) => {
				const hexAddr = addr.startsWith("0x") ? addr : "0x" + addr.toString(16);
				setReDumpAddr(hexAddr);
				setReDump("读取中…");
				setReError("");
				fetch(API_BASE + "/mem-dump?serial=" + encodeURIComponent(serial) + "&pid=" + rePid + "&address=" + encodeURIComponent(hexAddr) + "&length=256")
					.then((res) => res.json())
					.then((body) => {
						if (body?.error) { setReError(body.error); setReDump(""); return; }
						setReDump(body?.hex ?? "");
					})
					.catch(() => { setReDump(""); setReError("转储失败"); });
			};

			// Live screen stream: on while the 屏幕 tab is open, the panel is open, and a device is selected.
			useEffect(() => {
				const prev = prevSerialRef.current;
				prevSerialRef.current = serial;
				const want = tab === "screen" && serial !== "" && panelOpen;
				screenWantRef.current = want;
				const ws = wsRef.current;
				if (ws !== null && ws.readyState === WebSocket.OPEN) {
					if (prev !== "" && prev !== serial) ws.send(JSON.stringify({ type: "screen", serial: prev, on: false }));
					ws.send(JSON.stringify({ type: "screen", serial, on: want }));
				}
				setScreenOn(want);
				if (!want) setScreenImg(null);
			}, [tab, serial, panelOpen]);

			// Binary WS frames: 4-byte JSON header length + header + PNG payload.
			// Decoding goes through createImageBitmap into a canvas (no base64
			// data-URL churn per frame); only the newest pending frame is kept.
			const pumpScreenFrame = async () => {
				if (screenDecodingRef.current) return;
				screenDecodingRef.current = true;
				try {
					while (screenPendingRef.current !== null) {
						const bytes = screenPendingRef.current;
						screenPendingRef.current = null;
						const canvas = screenCanvasRef.current;
						if (canvas === null) break; // wait until the canvas mounts
						try {
							const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
							if (canvas.width !== bmp.width) canvas.width = bmp.width;
							if (canvas.height !== bmp.height) canvas.height = bmp.height;
							const c2d = canvas.getContext("2d");
							c2d.drawImage(bmp, 0, 0);
							bmp.close();
							setScreenHasFrame(true);
						} catch { /* undecodable frame — skip */ }
					}
				} finally {
					screenDecodingRef.current = false;
				}
			};

			const handleBinary = (buffer) => {
				try {
					const view = new DataView(buffer);
					const hlen = view.getUint32(0);
					const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
					if (header.type !== "simage" || header.serial !== serialRef.current) return;
					const bytes = new Uint8Array(buffer, 4 + hlen);
					// Sliding 1.5s window → rough fps readout.
					const now = performance.now();
					const ts = screenFpsTsRef.current;
					ts.push(now);
					while (ts.length > 0 && now - ts[0] > 1500) ts.shift();
					setScreenFps(Math.min(ts.length, 10));
					screenPendingRef.current = bytes;
					void pumpScreenFrame();
				} catch { /* malformed frame */ }
			};
			handleBinaryRef.current = handleBinary;

			const screenToDevice = (e) => {
				const img = screenImgRef.current;
				if (img === null || img.naturalWidth === 0) return null;
				const imgRect = img.getBoundingClientRect();
				const x = Math.round(((e.clientX - imgRect.left) / imgRect.width) * img.naturalWidth);
				const y = Math.round(((e.clientY - imgRect.top) / imgRect.height) * img.naturalHeight);
				if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
				return { x, y };
			};

			const screenMouseDown = (e) => {
				const pt = screenToDevice(e);
				if (pt === null) return;
				screenDragRef.current = { ...pt, clientX: e.clientX, clientY: e.clientY };
			};

			const screenMouseUp = (e) => {
				const drag = screenDragRef.current;
				screenDragRef.current = null;
				if (drag === null) return;
				const pt = screenToDevice(e);
				if (pt === null) return;
				const dx = pt.x - drag.x;
				const dy = pt.y - drag.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const command = dist < 12
					? `input tap ${drag.x} ${drag.y}`
					: `input swipe ${drag.x} ${drag.y} ${pt.x} ${pt.y} 120`;
				fetch(API_BASE + "/exec", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ serial, command }),
				}).catch(() => { /* offline */ });
			};

			const sendScreenText = () => {
				const text = screenText.trim();
				if (text === "") return;
				setScreenText("");
				const safe = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/ /g, "%s");
				fetch(API_BASE + "/exec", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ serial, command: `input text "${safe}"` }),
				}).catch(() => { /* offline */ });
			};

			const downloadScreen = () => {
				const canvas = screenCanvasRef.current;
				if (canvas === null || canvas.width <= 1) return;
				try {
					const a = document.createElement("a");
					a.href = canvas.toDataURL("image/png");
					a.download = "screen-" + (serial || "device") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
					document.body.appendChild(a);
					a.click();
					a.remove();
				} catch { /* empty canvas */ }
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
					spark.mem.length >= 2 ? h(Spark, { data: spark.mem, color: "#fbc02d", width: 44, height: 14, title: "内存使用率趋势" }) : null,
					parseCpu(stats?.cpu) !== undefined
						? h("span", { className: "lc-chip", title: "CPU 使用率（采样）" }, "CPU " + parseCpu(stats.cpu) + "%")
						: null,
					spark.cpu.length >= 2 ? h(Spark, { data: spark.cpu, color: "#4fc3f7", width: 44, height: 14, title: "CPU 趋势" }) : null,
					stats?.batteryLevel !== undefined
						? h("span", { className: "lc-chip", title: "电量" },
							"电量 " + stats.batteryLevel + "%" + (BATTERY_STATUS[stats.batteryStatus] !== undefined ? " · " + BATTERY_STATUS[stats.batteryStatus] : ""))
						: null,
					spark.bat.length >= 2 ? h(Spark, { data: spark.bat, color: "#4caf50", width: 44, height: 14, title: "电量趋势" }) : null,
					stats === null && serial !== "" ? h("span", { className: "lc-chip" }, "正在采集设备状态…") : null,
				),
				h("div", { className: "lc-tabs" },
					h("button", { type: "button", className: "lc-tab", "data-on": tab === "log" ? "" : undefined, onClick: () => setTab("log") }, "日志"),
					h("button", { type: "button", className: "lc-tab", "data-on": tab === "screen" ? "" : undefined, onClick: () => setTab("screen") }, "屏幕"),
					h("button", { type: "button", className: "lc-tab", "data-on": tab === "re" ? "" : undefined, onClick: () => setTab("re") }, "逆向"),
				),
				tab === "log"
					? h("div", { className: "lc-toolbar" },
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
							placeholder: "关键词过滤（空格分隔 = 任一命中）…",
							title: "多个关键词用空格分隔，命中任一个即显示",
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
						h("button", { type: "button", className: "lc-btn", onClick: loadHistory, title: "从磁盘加载历史日志（重启不丢）" }, "历史"),
						h("button", { type: "button", className: "lc-btn", "data-on": eventsOn ? "" : undefined, onClick: toggleEvents, title: "logcat -b events 事件缓冲（应用启动/崩溃/生命周期）" }, "events"),
						h("button", { type: "button", className: "lc-btn", onClick: openCrashModal, title: "崩溃自动快照历史（截图+上下文）" }, "崩溃"),
						h("button", { type: "button", className: "lc-btn", onClick: () => setWifiOpen(true), title: "WiFi 无线调试（adb pair + connect）" }, "WiFi"),
						h("input", {
							ref: fileInputRef,
							type: "file",
							accept: ".apk",
							style: { display: "none" },
							onChange: (e) => { installApkFile(e.target.files?.[0] ?? null); e.target.value = ""; },
						}),
						h("button", { type: "button", className: "lc-btn", onClick: () => fileInputRef.current?.click(), title: "选择本地 APK 安装到当前设备", disabled: installingApk ? true : undefined }, installingApk ? "安装中…" : "装APK"),
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
					)
					: null,
				tab === "log" || tab === "screen"
					? h("div", { className: "lc-keys" },
						[["home", "⌂ Home"], ["back", "← 返回"], ["recents", "▦ 最近"], ["wakeup", "☀ 唤醒"], ["power", "⏻ 电源"], ["volume_up", "🔊+"], ["volume_down", "🔉−"]].map(([key, label]) =>
							h("button", { key, type: "button", className: "lc-key", title: "发送按键 " + key, onClick: () => sendKey(key) }, label)))
					: null,
				lastCrash !== null
					? h("div", { className: "lc-crashbar" },
						h("b", null, "崩溃捕获 [" + lastCrash.kind + "] " + (lastCrash.ts ?? "")),
						h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lastCrash.summary ?? ""),
						lastCrash.hasScreenshot ? h("span", { style: { color: "#ef5350", fontSize: 11 } }, "已存截图") : null,
						h("button", { type: "button", className: "lc-btn", onClick: openCrashModal }, "查看"),
						h("button", { type: "button", className: "lc-btn", onClick: () => setLastCrash(null) }, "忽略"),
					)
					: null,
				historyNote !== ""
					? h("div", { className: "lc-histnote" },
						h("span", { style: { flex: 1 } }, historyNote),
						h("button", { type: "button", className: "lc-btn", onClick: () => setHistoryNote("") }, "关闭"),
					)
					: null,
				h("div", { className: "lc-body", ref: bodyRef },
					tab === "re"
						? h("div", { className: "lc-re" },
							h("div", { className: "lc-re-top" },
								h("input", { placeholder: "进程过滤…", value: reFilter, onChange: (e) => setReFilter(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") loadProcesses(); }, style: { width: 120 } }),
								h("button", { type: "button", className: "lc-btn", onClick: loadProcesses }, "进程"),
								h("input", { placeholder: "搜索: hello 或 hex:48656c6c6f", value: rePattern, onChange: (e) => setRePattern(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") reSearch(); }, style: { flex: 1, minWidth: 140 } }),
								h("button", { type: "button", className: "lc-btn", onClick: reSearch, disabled: reSearching ? true : undefined }, reSearching ? "搜索中…" : "内存搜索"),
							),
							h("div", { className: "lc-re-split" },
								h("div", { className: "lc-re-col" },
									h("div", { className: "lc-re-head" }, "进程 (" + rePids.length + ")"),
									h("div", { className: "lc-re-list" },
										rePids.length === 0
											? h("div", { className: "lc-re-row", title: "点击「进程」或等待自动加载" }, "(尚未加载 — 点击「进程」刷新)")
											: rePids.map((p) =>
											h("div", { key: p.pid, className: "lc-re-row", "data-on": rePid === p.pid ? "" : undefined, title: (p.user ?? "") + " " + p.name, onClick: () => { setRePid(p.pid); setReResults([]); setReDump(""); setReError(""); } },
												p.pid + "  " + p.name)))),
								h("div", { className: "lc-re-col2" },
									h("div", { className: "lc-re-head" }, "匹配地址（点击转储 256B）" + (reResults.length > 0 ? " · " + reResults.length : "")),
									h("div", { className: "lc-re-list" },
										reResults.map((o) =>
											h("div", { key: o, className: "lc-re-row", "data-on": reDumpAddr === "0x" + o.toString(16) ? "" : undefined, title: "0x" + o.toString(16), onClick: () => reDumpAt(o) },
												"0x" + o.toString(16)))),
									reDump !== ""
										? h("div", { className: "lc-re-head" }, "转储 " + reDumpAddr)
										: null,
									reDump !== "" ? h("div", { className: "lc-re-dump" }, reDump) : null,
									reError !== "" ? h("div", { className: "lc-re-err" }, reError) : null,
								),
							),
						)
						: tab === "screen"
							? h("div", { className: "lc-screen" },
								h("div", { className: "lc-screen-bar" },
									h("span", { className: "lc-dot " + (screenOn && hostScreenCapable ? "on" : "off") }),
									h("span", null, !hostScreenCapable ? "宿主版本过旧" : (screenOn ? "投屏中 (~" + screenFps + "fps)" : "投屏未开启")),
									h("input", { placeholder: "输入文字后回车发送…", value: screenText, onChange: (e) => setScreenText(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") sendScreenText(); }, style: { flex: 1, minWidth: 140 } }),
									h("button", { type: "button", className: "lc-btn", onClick: downloadScreen, title: "下载当前帧 PNG" }, "下载"),
									h("span", { className: "lc-screen-hint" }, "点击=点按 · 拖动=滑动"),
								),
								!hostScreenCapable
									? h("div", { className: "lc-empty" }, "⚠ 运行中的 GUI 宿主版本过旧（0.6.0-preview.1）——请重启 GUI（dsh web）后刷新，投屏功能才会生效")
									: h("div", { className: "lc-screen-img", ref: screenWrapRef, onMouseDown: screenMouseDown, onMouseUp: screenMouseUp, onMouseLeave: screenMouseUp },
										h("canvas", { ref: screenCanvasRef, alt: "设备屏幕", style: { width: "1080px", height: "2408px" } }),
										!screenHasFrame ? h("div", { className: "lc-empty" }, "等待画面…（设备连接后自动开始）") : null,
									),
							)
							: eventsOn
							? (filteredEvents.length === 0
								? h("div", { className: "lc-empty" }, "events 事件缓冲（已开启流，等待事件…）")
								: h(VirtualLog, { entries: filteredEvents, scrollTop, onScrollTop: setScrollTop, bodyRef }))
							: (filtered.length === 0
								? h("div", { className: "lc-empty" }, paused ? "已暂停（" + entries.length + " 条已缓冲）" : "暂无日志")
								: h(VirtualLog, { entries: filtered, scrollTop, onScrollTop: setScrollTop, bodyRef })),
				),
				crashModal
					? h("div", { className: "lc-overlay", onClick: () => setCrashModal(false) },
						h("div", { className: "lc-modal", onClick: (e) => e.stopPropagation() },
							h("div", { className: "lc-modal-head" },
								h("span", null, "崩溃快照历史"),
								h("span", { className: "sp" }),
								h("button", { type: "button", className: "lc-btn", onClick: () => setCrashModal(false) }, "关闭"),
							),
							h("div", { className: "lc-modal-body" },
								crashList.length === 0
									? h("span", null, "暂无崩溃快照")
									: crashList.map((c) =>
										h("div", { key: c.id, className: "lc-crash-item", onClick: () => toggleCrashDetail(c.id) },
											h("div", { className: "t" }, c.ts + "  [" + c.kind + "]" + (c.hasScreenshot ? "  📷" : "")),
											h("div", { className: "s" }, c.summary),
											crashOpenId === c.id && crashDetail !== null
												? h("div", { className: "lc-crash-detail" },
													c.hasScreenshot
														? h("img", { src: API_BASE + "/crash-file?serial=" + encodeURIComponent(serial) + "&id=" + encodeURIComponent(c.id) + "&file=screenshot.png", alt: "崩溃截图" })
														: null,
													h("pre", null, crashDetail.log ?? (crashDetail.loading === true ? "加载中…" : "")))
												: null,
										))),
						),
					)
					: null,
				wifiOpen
					? h("div", { className: "lc-overlay", onClick: () => setWifiOpen(false) },
						h("div", { className: "lc-modal", onClick: (e) => e.stopPropagation() },
							h("div", { className: "lc-modal-head" },
								h("span", null, "WiFi 无线调试"),
								h("span", { className: "sp" }),
								h("button", { type: "button", className: "lc-btn", onClick: () => setWifiOpen(false) }, "关闭"),
							),
							h("div", { className: "lc-modal-body" },
								h("div", { className: "lc-field" },
									h("span", null, "设备 IP（手机「无线调试」页面可查）"),
									h("input", { placeholder: "192.168.1.100", value: wifiHost, onChange: (e) => setWifiHost(e.target.value) }),
								),
								h("div", { className: "lc-field" },
									h("span", null, "端口（adb connect 端口）"),
									h("input", { placeholder: "5555", value: wifiPort, onChange: (e) => setWifiPort(e.target.value) }),
								),
								h("div", { className: "lc-field" },
									h("span", null, "配对码（Android 11+ 「使用配对码配对」；留空则直接 connect）"),
									h("input", { placeholder: "123456", value: wifiCode, onChange: (e) => setWifiCode(e.target.value) }),
								),
								h("div", { style: { display: "flex", gap: 6 } },
									h("button", { type: "button", className: "lc-btn", onClick: wifiConnect }, "配对并连接"),
									h("button", { type: "button", className: "lc-btn", onClick: wifiDisconnect }, "断开"),
								),
								wifiOut !== "" ? h("pre", { className: "lc-wifi-out" }, wifiOut) : null,
							),
						),
					)
					: null,
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

		/** Tiny SVG sparkline for sampled stats (cpu / memory / battery). */
		function Spark({ data, color, width, height, title }) {
			const min = Math.min(...data);
			const max = Math.max(...data);
			const span = Math.max(max - min, 1);
			const points = data.map((v, i) => {
				const x = (i / Math.max(data.length - 1, 1)) * (width - 2) + 1;
				const y = (height - 2) - ((v - min) / span) * (height - 4) + 1;
				return x.toFixed(1) + "," + y.toFixed(1);
			}).join(" ");
			return h("span", { className: "lc-spark", title },
				h("svg", { width, height, viewBox: "0 0 " + width + " " + height },
					h("polyline", { points, fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }),
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
