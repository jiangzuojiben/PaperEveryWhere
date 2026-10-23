import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useId,
  useSyncExternalStore,
} from "react";
import {
  Files,
  Search,
  Network,
  CalendarDays,
  SquarePen,
  Settings,
  ChevronsUpDown,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  Plus,
  X,
  BookOpen,
  Code2,
  Columns2,
  PanelLeftClose,
  PanelRightClose,
  Command,
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Link2,
  List,
  Hash,
  Bookmark,
  Cloud,
  Upload,
  RefreshCw,
  Globe,
  Check,
  Trash2,
  History,
  LayoutDashboard,
  Table2,
  Paperclip,
  Sun,
  Moon,
  Download,
  Copy,
  Shuffle,
  Presentation,
  Mic,
  Square,
} from "lucide-react";
import Editor from "./Editor.jsx";
import { validateSelectedSpan } from "./editor-helpers.mjs";
import { GraphView, CanvasView, BasesView, PropertiesPanel } from "./Views.jsx";
import {
  parseMarkdown,
  createLinkIndex,
  resolveLink,
  getReferences,
  searchFiles,
  normalizePath,
} from "../core/vault.mjs";
import { createPreviewBridge } from "./preview.js";
import { isTextPath } from "../core/file-types.mjs";
import { planExtract, planMerge } from "../core/composer.mjs";
import { createExtensionHost } from "./extensions.js";
import PluginsPanel from "./PluginsPanel.jsx";
import PdfViewer from "./PdfViewer.jsx";
import WebViewer from "./WebViewer.jsx";
import FileTree from "./FileTree.jsx";
import HistoryPanel from "./HistoryPanel.jsx";
import { WorkspaceLayout, WorkspaceSidebar } from "./WorkspaceLayout.jsx";
import { PluginRibbon, PluginStatusBar, PluginViewMount, PluginViewTitle } from "./PluginSurfaces.jsx";
import { createPluginWorkspaceAdapter } from "./plugin-workspace.mjs";
import {
  BookmarksPanel,
  Slides as DesktopSlides,
  MarkdownConverterDialog,
} from "./WindowsExtras.jsx";
import {
  normalizeBookmarks,
  bookmarkTarget,
  remapBookmarks,
  toggleFileBookmark,
  hasFileBookmark,
} from "../core/windows-extras.mjs";
import {
  formatDate,
  applyTemplate,
  notePath,
  uniqueNotePath,
} from "../core/dates.mjs";
import {
  restorePanes,
  remapPath,
  remapPanes,
  moveTab,
  normalizeWorkspaceLayout,
  splitWorkspacePane,
  removeWorkspacePane,
  updateWorkspaceTabState,
  getPaneTabState,
} from "../core/workspace.mjs";
import {
  WorkspacesPanel,
  ComposerDialogBody,
  FootnotesPanel,
  HotkeysPanel,
  AppearanceExtras,
  canonicalHotkey,
} from "./Utilities.jsx";

const emptyPluginUI=Object.freeze({revision:0,markdownRevision:0});
const emptyPluginSubscribe=()=>()=>{};
const getEmptyPluginUI=()=>emptyPluginUI;
const bridge = window.vaultdesk || createPreviewBridge();
const title = (p) =>
  p
    ?.split("/")
    .pop()
    ?.replace(/\.(md|canvas|base)$/i, "") || "新标签页";
const date = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const emptySettings = {
  theme: "dark",
  fontSize: 16,
  lineWidth: 760,
  alwaysUpdateLinks: true,
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  dailyFolder: "",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "每日笔记.md",
  timeFormat: "HH:mm",
  uniqueFormat: "YYYYMMDDHHmmss",
  uniqueFolder: "",
  uniqueTemplate: "",
  templateFolder: "模板",
  spellcheck: false,
  showLineNumbers: true,
  hotkeys: {},
  customCss: "",
  fileSort: "name-asc",
};
const cloudPreferences = (value = {}) => ({
  baseUrl: value.baseUrl || "http://127.0.0.1:8766",
  vaultId: value.vaultId || "",
  autoSync: !!value.autoSync,
  paused: !!value.paused,
  excludeFolders: value.excludeFolders || [],
  attachmentTypes: value.attachmentTypes || "all",
  intervalMs: value.intervalMs || 60000,
});
const isText = isTextPath;
const IconButton = ({ icon: Icon, label, active, ...rest }) => (
  <button
    className={"icon-button" + (active ? " active" : "")}
    title={label}
    aria-label={label}
    {...rest}
  >
    <Icon size={18} />
  </button>
);
function Dialog({ title: heading, children, onClose, wide = false }) {
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"dialog" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
      >
        <header>
          <h2>{heading}</h2>
          <IconButton icon={X} label="关闭对话框" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState({ files: [], vaultPath: "" });
  const [files, setFiles] = useState({});
  const fileRef = useRef({});
  const mtimes = useRef({});
  const versions = useRef({});
  const [selection, setSelection] = useState({
    text: "",
    characters: 0,
    words: 0,
  });
  const [splitDirection, setSplitDirection] = useState("horizontal");
  const [panes, setPaneRecords] = useState([
    { id: "pane-1", tabs: ["开始.md"], active: "开始.md", tabStates: {} },
  ]);
  const setPanes = useCallback(update => setPaneRecords(old => {
    const next = typeof update === "function" ? update(old) : update;
    if (next.length === old.length && next.every((pane,index)=>pane===old[index])) return old;
    return next.map(pane => pane.id ? pane : { ...pane, id:"pane-" + crypto.randomUUID() });
  }), []);
  const [layout, setLayout] = useState(null);
  const [sidebars, setSidebars] = useState({left:{width:250,collapsed:false},right:{width:257,collapsed:false}});
  const liveWorkspace = useRef(null);
  const pluginWorkspace = useRef(null);
  const [paneIndex, setPaneIndex] = useState(0);
  const [workspaces, setWorkspaces] = useState({});
  const [viewStateRevision,setViewStateRevision]=useState(0);
  const [pdfPages, setPdfPages] = useState({});
  const [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    [leftTab, setLeftTab] = useState("files"),
    [rightTab, setRightTab] = useState("outline");
  const [query, setQuery] = useState(""),
    [collapsed, setCollapsed] = useState(new Set()),
    [defaultMode, setDefaultMode] = useState("live");
  const [settings, setSettings] = useState(emptySettings),
    [bookmarks, setBookmarks] = useState([]),
    [dialog, setDialog] = useState(null),
    [notice, setNotice] = useState(""),
    [saveState, setSaveState] = useState("已保存"),
    [ready, setReady] = useState(false);
  const [cloud, setCloud] = useState({
      baseUrl: "http://127.0.0.1:8766",
      token: "",
      vaultId: "",
    }),
    [cloudUser, setCloudUser] = useState(null),
    [vaults, setVaults] = useState([]),
    [sites, setSites] = useState([]),
    [syncing, setSyncing] = useState(false);
  const configuredSync = useRef(null);
  const [syncStatus, setSyncStatus] = useState({ phase: "idle" });
  const [syncProgress, setSyncProgress] = useState(null);
  const [plugins, setPlugins] = useState([]),
    [pluginCommands, setPluginCommands] = useState([]),
    [pluginHost, setPluginHost] = useState(null);
  const pluginUI=useSyncExternalStore(pluginHost?.subscribeUI || emptyPluginSubscribe,pluginHost?.getUI || getEmptyPluginUI,getEmptyPluginUI);
  const processPluginMarkdown=useMemo(()=>pluginHost ? (container,options)=>pluginHost.processMarkdown(container,options) : undefined,[pluginHost,pluginUI.markdownRevision ?? pluginUI.revision]);
  const runtime = useRef({});
  const pendingOpen = useRef(null);
  const pluginEvents = useRef(new Set());
  const [recent, setRecent] = useState([]);
  const editors = useRef({});
  const lastTextPaths = useRef({});
  const timers = useRef(new Map()),
    dirty = useRef(new Set()),
    saving = useRef(new Map());
  const notify = useCallback((m) => setNotice(String(m)), []);
  const switching = useRef(false),
    vaultEpoch = useRef(0),
    metadataCache = useRef(new Map()),
    contentEpoch = useRef(0),
    snapshotRequest = useRef(0),
    busyRef = useRef(false);
  const navHistory = useRef([]),
    navIndex = useRef(-1);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef(null);
  const active = panes[paneIndex]?.active;
  const mode = panes[paneIndex]?.tabStates?.[active]?.mode || defaultMode;
  function setMode(value,index=paneIndex) {
    const current=panes[index]?.tabStates?.[panes[index]?.active]?.mode || defaultMode;
    const next = typeof value === "function" ? value(current) : value;
    setDefaultMode(next);
    const argumentsIndex=index;
    setPanes(old => old.map((pane,index) => index !== argumentsIndex || !pane.active ? pane : {
      ...pane, tabStates:{...pane.tabStates,[pane.active]:{...pane.tabStates?.[pane.active],mode:next}}
    }));
  }
  const editorFor = index => editors.current[panes[index]?.id];
  function applyWorkspaceLayout(next) {
    const normalized = normalizeWorkspaceLayout({...liveWorkspace.current,...next});
    liveWorkspace.current = {...liveWorkspace.current,...normalized};
    setPanes(normalized.panes); setLayout(normalized.layout); setPaneIndex(normalized.paneIndex);
    setSidebars(normalized.sidebars);
    setLeft(!normalized.sidebars.left.collapsed); setRight(!normalized.sidebars.right.collapsed);
  }
  function recordViewState(state,path,paneId) {
    if (!state || state.path && state.path !== path) return;
    setPanes(old => old.map(pane => {
      if (pane.id !== paneId || !pane.tabs.includes(path)) return pane;
      if (JSON.stringify(pane.tabStates?.[path]) === JSON.stringify(state)) return pane;
      return {...pane,tabStates:{...pane.tabStates,[path]:state}};
    }));
  }
  const content = files[active] || "";
  useEffect(
    () => setSelection({ text: "", characters: 0, words: 0 }),
    [active, paneIndex],
  );
  const allPaths = useMemo(
    () => snapshot.files.filter((f) => !f.isDirectory).map((f) => f.path),
    [snapshot],
  );
  const linkIndex = useMemo(() => createLinkIndex(allPaths), [allPaths]);
  const allFiles = useMemo(
    () => ({ ...Object.fromEntries(allPaths.map((p) => [p, ""])), ...files }),
    [allPaths, files],
  );

  const refresh = useCallback(async () => {
    const epoch = vaultEpoch.current,
      editVersion = contentEpoch.current,
      request = ++snapshotRequest.current;
    const s = await bridge.snapshot();
    if (
      epoch !== vaultEpoch.current ||
      editVersion !== contentEpoch.current ||
      request !== snapshotRequest.current
    )
      return s;
    const next = {};
    s.files
      .filter((f) => !f.isDirectory && typeof f.content === "string")
      .forEach((f) => {
        next[f.path] = f.content;
        if (!dirty.current.has(f.path)) {
          mtimes.current[f.path] = f.mtime;
          versions.current[f.path] = f.version;
        }
      });
    for (const p of dirty.current) next[p] = fileRef.current[p];
    fileRef.current = next;
    setFiles(next);
    setSnapshot(s);
    return s;
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const s = await refresh(),
          w = await bridge.loadWorkspace();
        if (w) {
          setSettings({ ...emptySettings, ...s.settings, ...w.settings });
          setBookmarks(normalizeBookmarks(w.bookmarks || []));
          setWorkspaces(w.workspaces || {});
          setDefaultMode(w.mode || "live");
          setRecent(w.recent || []);
          setPlugins((w.plugins || []).map((p) => ({ ...p, enabled: false })));
          setLeft(w.left !== false);
          setRight(w.right !== false);
          setLeftTab(w.leftTab || "files");
          setRightTab(w.rightTab || "outline");
          setSplitDirection(w.splitDirection || "horizontal");
          if (w.cloud?.baseUrl)
            setCloud((c) => ({
              ...c,
              ...cloudPreferences(w.cloud),
            }));
        }
        const paths = s.files.filter((f) => !f.isDirectory).map((f) => f.path);
        const restored = w?.panes?.length ? normalizeWorkspaceLayout(w,paths).panes : [];
        if (restored?.length) {
          restored.forEach((p) => (p.active ||= p.tabs[0]));
          applyWorkspaceLayout({...w,panes:restored});
        } else
          setPanes([
            {
              tabs: paths.length
                ? [
                    paths.find((p) => p === "开始.md") ||
                      paths.find((p) => p.endsWith(".md")) ||
                      paths[0],
                  ]
                : [],
              active:
                paths.find((p) => p === "开始.md") ||
                paths.find((p) => p.endsWith(".md")) ||
                paths[0] ||
                null,
            },
          ]);
      } catch (e) {
        notify(e.message);
      } finally {
        setReady(true);
        if (pendingOpen.current) {
          const event = pendingOpen.current;
          pendingOpen.current = null;
          queueMicrotask(() =>
            runtime.current.openFile?.(event.path, event.state),
          );
        }
      }
    })();
    return bridge.onChange((event) => {
      if (event?.type === "sync-before") {
        Promise.resolve()
          .then(() => runtime.current.flush?.())
          .then(() => bridge.syncReady(event.requestId, { ok: true }))
          .catch((error) =>
            bridge
              .syncReady(event.requestId, { ok: false, error: error.message })
              .catch(() => {}),
          );
        return;
      }
      if (event?.type === "sync-progress") {
        setSyncProgress(event);
        return;
      }
      if (event?.type === "sync-status") {
        setSyncStatus(event);
        setSyncing(!!event.running);
        if (event.phase === "idle" && event.lastSuccess)
          refresh().catch((e) => notify(e.message));
        return;
      }

      if (["webviewer", "sync-progress", "sync-status"].includes(event?.type))
        return;
      if (event?.warning) notify(event.warning.message || event.warning);
      refresh()
        .then(() => {
          if (event?.type === "open" && event.path) {
            if (runtime.current.isReady)
              runtime.current.openFile?.(event.path, event.state);
            else pendingOpen.current = event;
          }
        })
        .catch((e) => notify(e.message));
    });
  }, [refresh, notify]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${settings.fontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--readable-width",
      `${settings.lineWidth}px`,
    );
  }, [settings]);
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.vaultdesk = "custom-css";
    style.textContent = settings.customCss || "";
    document.head.appendChild(style);
    return () => style.remove();
  }, [settings.customCss]);
  const workspace = useMemo(
    () => normalizeWorkspaceLayout({
      layoutVersion: 2, layout, sidebars:{left:{...sidebars.left,collapsed:!left},right:{...sidebars.right,collapsed:!right}},
      activePaneId:panes[paneIndex]?.id,
      panes,
      paneIndex,
      leftTab,
      rightTab,
      splitDirection,
      workspaces,
      settings,
      bookmarks,
      mode:defaultMode,
      left,
      right,
      recent,
      plugins,
      cloud: cloudPreferences(cloud),
    }),
    [
      layout, sidebars,
      panes,
      paneIndex,
      leftTab,
      rightTab,
      splitDirection,
      workspaces,
      settings,
      bookmarks,
      defaultMode,
      left,
      right,
      recent,
      plugins,
      cloud,
    ],
  );
  liveWorkspace.current = workspace;
  useEffect(() => {
    if (ready && !switching.current)
      bridge.saveWorkspace(workspace).catch((e) => notify(e.message));
  }, [workspace, ready]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(t);
  }, [notice]);

  const save = useCallback(
    async (p) => {
      while (saving.current.has(p)) await saving.current.get(p);
      if (!dirty.current.has(p)) return;
      const text = fileRef.current[p];
      const task = (async () => {
        try {
          const result = await bridge.write(
            p,
            text,
            mtimes.current[p],
            versions.current[p],
          );
          contentEpoch.current++;
          if (result?.mtime) {
            mtimes.current[p] = result.mtime;
            versions.current[p] = result.version;
          } else mtimes.current[p] = (await bridge.read(p)).mtime;
          if (fileRef.current[p] === text) dirty.current.delete(p);
          setSaveState(dirty.current.size ? "保存中…" : "已保存");
        } catch (e) {
          setSaveState("保存冲突");
          notify(`${p}：${e.message}。编辑内容仍保留在当前窗口；可另存副本。`);
          throw e;
        }
      })();
      saving.current.set(p, task);
      try {
        await task;
      } finally {
        saving.current.delete(p);
      }
    },
    [notify],
  );
  const flush = useCallback(async () => {
    for (const t of timers.current.values()) clearTimeout(t);
    while (dirty.current.size) {
      for (const p of [...dirty.current]) await save(p);
    }
  }, [save]);
  const change = useCallback(
    (p, value) => {
      contentEpoch.current++;
      fileRef.current = { ...fileRef.current, [p]: value };
      setFiles(fileRef.current);
      dirty.current.add(p);
      setSaveState("保存中…");
      clearTimeout(timers.current.get(p));
      timers.current.set(
        p,
        setTimeout(() => save(p).catch(() => {}), 650),
      );
    },
    [save],
  );
  useEffect(() => {
    const handler = (e) => {
      if (runtime.current.workspace)
        bridge.saveWorkspace(runtime.current.workspace).catch(() => {});
      if (dirty.current.size || recorder.current) {
        e.preventDefault();
        e.returnValue = "仍有未保存的笔记";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  const open = useCallback(
    (p, index = paneIndex, track = true) => {
      setPanes((old) =>
        old.map((pane, i) =>
          i === index
            ? {
                ...pane,
                tabs: pane.tabs.includes(p) ? pane.tabs : [...pane.tabs, p],
                active: p,
              }
            : pane,
        ),
      );
      setPaneIndex(index);
      setRecent((r) => [p, ...r.filter((v) => v !== p)].slice(0, 30));
      if (track) {
        navHistory.current = navHistory.current.slice(0, navIndex.current + 1);
        navHistory.current.push(p);
        navIndex.current = navHistory.current.length - 1;
      }
    },
    [paneIndex],
  );
  const togglePin = (p, index) =>
    setPanes((ps) =>
      ps.map((pane, i) =>
        i !== index
          ? pane
          : {
              ...pane,
              pinned: (pane.pinned || []).includes(p)
                ? pane.pinned.filter((t) => t !== p)
                : [...(pane.pinned || []), p],
            },
      ),
    );
  const closeTab = (p, index) =>
    setPanes((old) =>
      old.map((pane, i) => {
        if (i !== index) return pane;
        const tabs = pane.tabs.filter((t) => t !== p);
        return {
          ...pane,
          tabs,
          pinned: (pane.pinned || []).filter((t) => t !== p),
          active: pane.active === p ? tabs.at(-1) || null : pane.active,
        };
      }),
    );
  const create = async (p, text = "") => {
    p = p.trim().replace(/\\/g, "/");
    if (!p) return;
    if (!/\.[^/]+$/.test(p)) p += ".md";
    await bridge.create(p, text);
    await refresh();
    open(p);
    setDialog(null);
  };
  function openExact(path, subpath = "", index = paneIndex) {
    const actual =
      allPaths.find((p) => p === path) ||
      allPaths.find(
        (p) => p.toLocaleLowerCase() === String(path).toLocaleLowerCase(),
      );
    if (!actual) {
      notify(`书签目标不存在：${path}`);
      return;
    }
    if (/\.pdf$/i.test(actual) && subpath) {
      const page = /(?:^#?|&)page=(\d+)/.exec(subpath);
      setPdfPages((v) => ({
        ...v,
        [actual]: {
          page: page ? Number(page[1]) : 1,
          key: (v[actual]?.key || 0) + 1,
        },
      }));
    }
    open(actual, index);
    if (subpath && !/\.pdf$/i.test(actual))
      setTimeout(
        () =>
          editorFor(index)?.scrollToHeading?.(subpath.replace(/^#/, "")),
        150,
      );
  }
  const navigate = async (link, source = active, index = paneIndex) => {
    try {
      if (/^(?:https?:\/\/|mailto:)/i.test(link)) {
        await bridge.openExternal(link);
        return;
      }
      let targetLink = link
        .replace(/^!?(?:\[\[)?/, "")
        .replace(/\]\]$/, "")
        .split("|")[0];
      const [lp, ...sub] = targetLink.split("#");
      const p = lp ? resolveLink(lp, source, linkIndex) : source;
      if (p) {
        if (/\.pdf$/i.test(p)) {
          const page = /(?:^|&)page=(\d+)/.exec(sub.join("#"));
          setPdfPages((v) => ({
            ...v,
            [p]: {
              page: page ? Math.max(1, Number(page[1])) : 1,
              key: (v[p]?.key || 0) + 1,
            },
          }));
        }
        open(p, index);
        if (sub.length && !/\.pdf$/i.test(p))
          setTimeout(
            () => editorFor(index)?.scrollToHeading?.(sub.join("#")),
            150,
          );
      } else {
        const base = /^\.\.?\//.test(lp)
          ? source?.includes("/")
            ? source.slice(0, source.lastIndexOf("/")) + "/"
            : ""
          : "";
        const normalized = normalizePath(base + lp);
        if (!normalized) throw Error("链接路径超出知识库");
        const proposed = normalized + (normalized.endsWith(".md") ? "" : ".md");
        setDialog({ type: "create", value: proposed, text: "" });
      }
    } catch (e) {
      notify(e.message);
    }
  };
  function assertFolder(folder) {
    if (
      folder &&
      !snapshot.files.some(
        (f) =>
          (f.path === folder && f.isDirectory) ||
          f.path.startsWith(folder + "/"),
      )
    )
      throw Error(`目录「${folder}」不存在，请先创建目录。`);
  }
  const daily = async () => {
    const now = new Date(),
      name = formatDate(now, settings.dailyFormat || "YYYY-MM-DD"),
      p = notePath(settings.dailyFolder, name);
    if (p in fileRef.current) {
      open(p);
      return;
    }
    assertFolder(settings.dailyFolder);
    const template =
      fileRef.current[
        `${settings.templateFolder}/${settings.dailyTemplate || "每日笔记.md"}`
      ] || "# {{date}}\n\n";
    await create(
      p,
      applyTemplate(template, {
        now,
        title: name,
        timeFormat: settings.timeFormat,
      }),
    );
  };
  async function uniqueNote() {
    assertFolder(settings.uniqueFolder);
    const now = new Date(),
      note = uniqueNotePath(allPaths, {
        folder: settings.uniqueFolder,
        format: settings.uniqueFormat,
        now,
      });
    const template =
      fileRef.current[
        `${settings.templateFolder}/${settings.uniqueTemplate}`
      ] || "";
    await create(
      note.path,
      applyTemplate(template, {
        now,
        title: note.title,
        timeFormat: settings.timeFormat,
      }),
    );
  }
  const rename = async (value, decision, sourcePath) => {
    const old = sourcePath || dialog.path;
    if (!settings.alwaysUpdateLinks && !decision) {
      setDialog({ type: "renameDecision", path: old, value });
      return;
    }
    await flush();
    const result = await bridge.rename(old, value, {
      ...settings,
      decision: decision || "automatic",
    });
    if (decision === "always")
      setSettings((s) => ({ ...s, alwaysUpdateLinks: true }));
    if (result?.warnings?.length)
      notify(
        "文件已移动，但部分引用保存失败：" +
          result.warnings.map((w) => w.path).join("、"),
      );
    setPanes((ps) => remapPanes(ps, old, value));
    setWorkspaces((ws) =>
      Object.fromEntries(
        Object.entries(ws).map(([name, w]) => [
          name,
          { ...w, panes: remapPanes(w.panes || [], old, value) },
        ]),
      ),
    );
    setRecent((items) => items.map((p) => remapPath(p, old, value)));
    navHistory.current = navHistory.current.map((p) =>
      remapPath(p, old, value),
    );
    setBookmarks((b) => remapBookmarks(b, old, value));
    await refresh();
    setDialog(null);
  };
  const run = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const split = (direction = "vertical",path,paneId) => run(async()=>{
    await pluginHost?.captureViewStates?.();
    const current=liveWorkspace.current;
    applyWorkspaceLayout(splitWorkspacePane(current,paneId||current.activePaneId,direction,
      path ? {path} : {}));
  });
  const toggleBookmark = () => {
    if (active && !active.startsWith("@"))
      setBookmarks((b) => toggleFileBookmark(b, active));
  };
  const newNote = () =>
    setDialog({ type: "create", value: "未命名.md", text: "" });
  const newCanvas = () =>
    setDialog({
      type: "create",
      value: "未命名.canvas",
      text: '{"nodes":[],"edges":[]}',
    });
  const newBase = () =>
    setDialog({
      type: "create",
      value: "未命名.base",
      text: "views:\n  - type: table\n    name: 全部笔记\n",
    });
  if (!pluginWorkspace.current) pluginWorkspace.current = createPluginWorkspaceAdapter({
    getWorkspace:()=>liveWorkspace.current,
    setWorkspace:next=>runtime.current.applyLayout(next),
    getEditor:(paneId,path)=>{
      const pane=liveWorkspace.current?.panes.find(p=>p.id===paneId),api=editors.current[paneId];
      return runtime.current.isReady && !busyRef.current && pane?.active===path && api?.getSelectionInfo?.().path===path ? api : null;
    },
    onOpen:(path,state)=>runtime.current.onPluginOpen(path,state),
    onSave:()=>bridge.saveWorkspace(liveWorkspace.current),
  });
  runtime.current = {
    applyLayout:applyWorkspaceLayout,
    onPluginOpen:(path,state)=>{
      setRecent(r=>[path,...r.filter(p=>p!==path)].slice(0,30));
      const attempt=remaining=>{
        const api=editors.current[state.paneId];
        if(api?.getSelectionInfo?.().path!==path){if(remaining)setTimeout(()=>attempt(remaining-1),50);return;}
        if(state.eState?.cursor)api.setCursor?.(state.eState.cursor);
        if(state.subpath)api.scrollToHeading?.(state.subpath.replace(/^#/,""));
      };setTimeout(()=>attempt(20),0);
    },
    flush,
    workspace,
    isReady: ready,
    getFiles: () =>
      snapshot.files.map((f) => ({
        ...f,
        content: fileRef.current[f.path] ?? f.content,
      })),
    getActivePath: () => active,
    openFile: (p, state) =>
      state?.subpath ? openExact(p, state.subpath) : open(p),
  };
  useEffect(() => {
    if (!snapshot.vaultPath) return;
    const host = createExtensionHost({
      bridge,
      getFiles: () => runtime.current.getFiles(),
      getActivePath: () => runtime.current.getActivePath(),
      openFile: (p, state) => runtime.current.openFile(p, state),
      getEditor: leafId => pluginWorkspace.current.getEditor(leafId),
      workspaceAdapter: pluginWorkspace.current,
      onEvent: (listener) => {
        pluginEvents.current.add(listener);
        return () => pluginEvents.current.delete(listener);
      },
      notice: notify,
      addCommand: (command) =>
        setPluginCommands((c) => [
          ...c.filter((x) => x.id !== command.id),
          command,
        ]),
      removeCommand: (id) =>
        setPluginCommands((c) => c.filter((x) => x.id !== id)),
    });
    setPluginHost(host);
    return () => {
      host.dispose().catch((e) => notify(e.message));
      setPluginCommands([]);
    };
  }, [snapshot.vaultPath]);
  useEffect(() => {
    const event =
      active && !active.startsWith("@")
        ? { scope: "workspace", name: "file-open", path: active }
        : { scope: "workspace", name: "file-open", args: [null] };
    for (const listener of pluginEvents.current) listener(event);
    for (const listener of pluginEvents.current) listener({scope:"workspace",name:"active-leaf-change",args:[]});
  }, [active, paneIndex, pluginHost]);
  const layoutEventKey=JSON.stringify({layout:workspace.layout,panes:panes.map(p=>({id:p.id,tabs:p.tabs,active:p.active,pinned:p.pinned,pluginViews:p.pluginViews})),activePaneId:workspace.activePaneId});
  useEffect(()=>{
    for(const listener of pluginEvents.current)listener({scope:"workspace",name:"layout-change",args:[]});
  },[layoutEventKey,pluginHost]);
  useEffect(() => {
    if (!ready || !bridge.configureSync) return;
    if (!cloud.token || !cloud.vaultId) {
      if (configuredSync.current?.vaultPath === snapshot.vaultPath) {
        configuredSync.current = null;
        bridge
          .configureSync({
            ...cloud,
            token: "",
            vaultId: "",
            autoSync: false,
            paused: true,
          })
          .then(setSyncStatus)
          .catch((e) => notify(e.message));
      }
      return;
    }
    configuredSync.current = { vaultPath: snapshot.vaultPath };
    bridge
      .configureSync(cloud)
      .then(setSyncStatus)
      .catch((e) => notify(e.message));
  }, [cloud, snapshot.vaultPath, ready]);
  const defaultCommands = [
    ["Markdown 格式转换", "", () => setDialog({ type: "convert" })],
    [
      "在新窗口打开当前库",
      "",
      () =>
        run(async () => {
          await flush();
          if (!bridge.newWindow) throw Error("请在桌面版使用多窗口");
          await bridge.saveWorkspace(workspace);
          await bridge.newWindow({
            path: active?.startsWith("@") ? undefined : active,
          });
        }),
    ],
    [
      "在新窗口打开其他知识库",
      "",
      () =>
        run(async () => {
          await flush();
          await bridge.openVaultInNewWindow();
        }),
    ],
    ["打开网页标签", "", () => setDialog({ type: "weburl" })],
    [
      "向下分屏",
      "",
      () => split("horizontal"),
    ],
    ["固定/取消固定当前标签", "", () => togglePin(active, paneIndex)],
    ["打开命令面板", "Ctrl+P", () => setDialog({ type: "commands" })],
    ["保存当前修改", "Ctrl+S", () => flush().catch(() => {})],
    ["关闭当前标签", "Ctrl+W", () => active && closeTab(active, paneIndex)],
    [
      "搜索整个知识库",
      "Ctrl+Shift+F",
      () => {
        setLeft(true);
        setLeftTab("search");
      },
    ],
    ["管理工作区布局", "", () => setDialog({ type: "workspaces" })],
    [
      "笔记重组",
      "",
      () => {
        const selected = editorFor(paneIndex)?.getSelectionInfo?.();
        if (selected?.path !== active) {
          notify("组合输入尚未提交，请稍后重试。");
          return;
        }
        setDialog({
          type: "composer",
          path: active,
          selection: selected,
        });
      },
    ],
    [
      "查看脚注",
      "",
      () => {
        setRight(true);
        setRightTab("footnotes");
      },
    ],
    [
      "查看回收站",
      "",
      () =>
        run(async () => {
          if (!bridge.listTrash) throw Error("回收站恢复请在桌面版使用");
          setDialog({ type: "trash", items: await bridge.listTrash() });
        }),
    ],
    ["创建时间戳笔记", "", () => run(uniqueNote)],
    ["新建笔记", "Ctrl+N", newNote],
    ["打开快速切换", "Ctrl+O", () => setDialog({ type: "quick" })],
    ["打开图谱", "", () => open("@graph")],
    ["打开局部图谱", "", () => open("@localgraph:" + active)],
    ["打开每日笔记", "", () => run(daily)],
    ["新建 Canvas", "", newCanvas],
    ["新建 Bases", "", newBase],
    [
      "切换阅读模式",
      "Ctrl+E",
      () => setMode((m) => (m === "reading" ? "live" : "reading")),
    ],
    ["切换源码模式", "", () => setMode("source")],
    ["左右分屏", "", split],
    ["插入模板", "", () => setDialog({ type: "templates" })],
    ["添加/移除书签", "", toggleBookmark],
    [
      "随机笔记",
      "",
      () => {
        const p = Object.keys(files).filter((p) => p.endsWith(".md"));
        if (p.length) open(p[Math.floor(Math.random() * p.length)]);
      },
    ],
    [
      "恢复文件版本",
      "",
      () =>
        run(async () =>
          setDialog({
            type: "history",
            path: active,
            items: await bridge.getHistory(active),
          }),
        ),
    ],
    [
      "保存为副本",
      "",
      () =>
        setDialog({
          type: "create",
          value: title(active) + " 副本.md",
          text: content,
        }),
    ],
    [
      "导出 Markdown",
      "",
      () => {
        if (bridge.exportText) {
          run(() =>
            bridge.exportText(content, active?.split("/").pop() || "笔记.md"),
          );
          return;
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(
          new Blob([content], { type: "text/markdown" }),
        );
        a.download = active?.split("/").pop() || "笔记.md";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    ],
    ["演示幻灯片", "", () => setDialog({ type: "slides" })],
    ["切换左侧栏", "", () => setLeft((v) => !v)],
    ["切换右侧栏", "", () => setRight((v) => !v)],
    [
      "打开设置",
      "Ctrl+,",
      () => setDialog({ type: "settings", section: "editor" }),
    ],
    ["立即同步", "", () => run(syncNow)],
    ["打开本地知识库", "", () => run(openVault)],
    ...pluginCommands.map((c) => [c.name, "", () => c.callback(), c.id]),
  ];
  const commandItems = defaultCommands.map(([name, key, action, id]) => [
    name,
    Object.hasOwn(settings.hotkeys || {}, id || name)
      ? settings.hotkeys[id || name]
      : key,
    action,
    id || name,
  ]);
  useEffect(() => {
    const key = (e) => {
      if (e.defaultPrevented) return;
      if (busyRef.current) {
        if (!(e.ctrlKey && e.key === "c")) e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        setDialog(null);
        return;
      }
      if (dialog && !["commands", "quick"].includes(dialog.type)) return;
      const shortcut = canonicalHotkey(e);
      const command = commandItems.find(
        (item) => item[1] && item[1] === shortcut,
      );
      if (command) {
        e.preventDefault();
        command[2]();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function openVault() {
    if (recorder.current)
      throw Error("请先停止录音并等待附件保存后再切换知识库。");
    await flush();
    await bridge.saveWorkspace(workspace);
    switching.current = true;
    setReady(false);
    vaultEpoch.current++;
    try {
      const s = await bridge.openVault();
      if (!s || s.vaultPath === snapshot.vaultPath) return;
      dirty.current.clear();
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      mtimes.current = {};
      versions.current = {};
      fileRef.current = {};
      metadataCache.current.clear();
      await refresh();
      const w = await bridge.loadWorkspace();
      setSettings({ ...emptySettings, ...s.settings, ...w?.settings });
      setBookmarks(normalizeBookmarks(w?.bookmarks || []));
      setWorkspaces(w?.workspaces || {});
      setPdfPages({});
      setRecent(w?.recent || []);
      setDefaultMode(w?.mode || "live");
      setLeft(w?.left !== false);
      setRight(w?.right !== false);
      setLeftTab(w?.leftTab || "files");
      setRightTab(w?.rightTab || "outline");
      setSplitDirection(w?.splitDirection || "horizontal");
      setCloud({
        ...cloudPreferences(w?.cloud),
        token: "",
      });
      setCloudUser(null);
      setVaults([]);
      setSites([]);
      setPlugins((w?.plugins || []).map((p) => ({ ...p, enabled: false })));
      setSaveState("已保存");
      navHistory.current = [];
      navIndex.current = -1;
      const paths = s.files.filter((f) => !f.isDirectory).map((f) => f.path);
      const valid = w?.panes?.length ? normalizeWorkspaceLayout(w,paths).panes : [];
      const p = paths.find((p) => p.endsWith(".md")) || paths[0];
      applyWorkspaceLayout({...w,panes:valid?.length ? valid : [{ tabs:p?[p]:[],active:p||null }]});
    } finally {
      switching.current = false;
      setReady(true);
    }
  }
  async function cloudCall(path, options = {}) {
    if (bridge.cloudRequest) return bridge.cloudRequest(cloud, path, options);
    const response = await fetch(cloud.baseUrl.replace(/\/$/, "") + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {}),
        ...options.headers,
      },
      body:
        options.body && typeof options.body !== "string"
          ? JSON.stringify(options.body)
          : options.body,
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(
        typeof result.detail === "string"
          ? result.detail
          : JSON.stringify(result.detail || result),
      );
    return result;
  }
  async function syncNow() {
    if (!cloud.token || !cloud.vaultId) {
      setDialog({ type: "settings", section: "cloud" });
      return;
    }
    if (!bridge.sync) throw Error("同步需要在桌面版中运行。");
    await flush();
    setSyncing(true);
    try {
      const result = await bridge.sync(cloud);
      await refresh();
      notify(
        result?.conflicts?.length
          ? `同步完成，保留 ${result.conflicts.length} 份冲突副本`
          : "同步完成",
      );
    } finally {
      setSyncing(false);
    }
  }
  const indexed = useMemo(() => {
    const pathsKey = allPaths.join("\0");
    const result = {};
    for (const [p, text] of Object.entries(files)) {
      if (!p.endsWith(".md")) continue;
      let cached = metadataCache.current.get(p);
      if (!cached || cached.text !== text) {
        cached = { text, meta: parseMarkdown(text) };
      }
      if (cached.pathsKey !== pathsKey || !cached.refs) {
        cached = { ...cached, pathsKey,
          refs: getReferences(text, p, linkIndex, cached.meta) };
      }
      metadataCache.current.set(p, cached);
      result[p] = cached;
    }
    for (const p of metadataCache.current.keys())
      if (!(p in files)) metadataCache.current.delete(p);
    return result;
  }, [files, allPaths, linkIndex]);
  const meta = indexed[active]?.meta || {};
  const backlinks = useMemo(
    () =>
      !active
        ? []
        : Object.entries(indexed)
            .filter(
              ([p, v]) => p !== active && v.refs.some((r) => r.path === active),
            )
            .map(([p]) => [p, files[p]]),
    [indexed, active],
  );
  const outgoing = indexed[active]?.refs || [];
  const tags = useMemo(() => {
    const map = Object.create(null);
    for (const [p, v] of Object.entries(indexed))
      for (const tag of v.meta.tags || []) {
        const name = typeof tag === "string" ? tag : tag.tag;
        (map[name] ||= []).push(p);
      }
    return Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  }, [indexed]);
  const results = useMemo(() => {
    try {
      return query ? searchFiles(files, query) : [];
    } catch {
      return [];
    }
  }, [files, query]);

  function fileTree() {
    const root = Object.create(null);
    for (const f of snapshot.files) {
      const parts = f.path.split("/");
      let tree = root;
      parts.forEach((name, i) => {
        tree[name] ||= {
          _path: parts.slice(0, i + 1).join("/"),
          _mtime: f.mtime || 0,
          _children: Object.create(null),
          _folder: !!(i < parts.length - 1 || f.isDirectory),
        };
        if (i < parts.length - 1) tree[name]._folder = true;
        tree = tree[name]._children;
      });
    }
    const render = (tree, depth = 0) =>
      Object.entries(tree)
        .sort(
          (a, b) =>
            Number(b[1]._folder) - Number(a[1]._folder) ||
            (settings.fileSort === "modified"
              ? b[1]._mtime - a[1]._mtime
              : settings.fileSort === "name-desc"
                ? b[0].localeCompare(a[0], "zh")
                : a[0].localeCompare(b[0], "zh")),
        )
        .map(([name, n]) => (
          <React.Fragment key={n._path}>
            <div
              className={"tree-row" + (n._path === active ? " selected" : "")}
              style={{ paddingLeft: 10 + depth * 16 }}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData("application/x-vaultdesk-file", n._path)
              }
              onDragOver={(e) => {
                if (
                  n._folder &&
                  e.dataTransfer.types.includes("application/x-vaultdesk-file")
                )
                  e.preventDefault();
              }}
              onDrop={(e) => {
                const source = e.dataTransfer.getData(
                  "application/x-vaultdesk-file",
                );
                if (!n._folder || !source) return;
                e.preventDefault();
                e.stopPropagation();
                const dest = n._path + "/" + source.split("/").pop();
                if (dest !== source) run(() => rename(dest, undefined, source));
              }}
              onClick={() =>
                n._folder
                  ? setCollapsed((c) => {
                      const s = new Set(c);
                      s.has(n._path) ? s.delete(n._path) : s.add(n._path);
                      return s;
                    })
                  : open(n._path)
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setDialog({
                  type: "filemenu",
                  path: n._path,
                  folder: n._folder,
                });
              }}
            >
              <span className="tree-icon">
                {n._folder ? (
                  collapsed.has(n._path) ? (
                    <ChevronRight size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )
                ) : n._path.endsWith(".canvas") ? (
                  <LayoutDashboard size={15} />
                ) : n._path.endsWith(".base") ? (
                  <Table2 size={15} />
                ) : (
                  <FileText size={15} />
                )}
              </span>
              <span>{name.replace(/\.(md)$/, "")}</span>
              <button
                className="row-more"
                aria-label={`操作 ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDialog({
                    type: "filemenu",
                    path: n._path,
                    folder: n._folder,
                  });
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
            {n._folder &&
              !collapsed.has(n._path) &&
              render(n._children, depth + 1)}
          </React.Fragment>
        ));
    return render(root);
  }

  async function recordAudio() {
    if (recording) {
      if (recorder.current?.state === "recording") recorder.current.stop();
      return;
    }
    if (!bridge.writeBinary) throw Error("当前桌面宿主尚未支持录音附件写入。");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let rec;
    try {
      rec = new MediaRecorder(stream);
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      throw error;
    }
    const recordPath = active;
    recorder.current = rec;
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      try {
        const bytes = new Uint8Array(
          await new Blob(chunks, { type: rec.mimeType }).arrayBuffer(),
        );
        let binary = "";
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        const p = `附件/录音-${Date.now()}.webm`;
        await bridge.writeBinary(p, btoa(binary));
        if (recordPath?.endsWith(".md") && recordPath in fileRef.current) {
          change(recordPath, fileRef.current[recordPath] + `\n![[${p}]]\n`);
          await save(recordPath);
        } else notify(`录音已保存为 ${p}`);
        await refresh();
      } catch (e) {
        notify(e.message);
      } finally {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        recorder.current = null;
      }
    };
    rec.start();
    setRecording(true);
  }

  async function composeNotes(operation, target) {
    if (busyRef.current) throw Error("另一个文件操作正在进行。");
    const source = dialog.path,
      selection = dialog.selection;
    busyRef.current = true;
    setBusy(true);
    let written = 0;
    try {
      await flush();
      const current = await bridge.snapshot();
      const records = current.files.filter((file) => !file.isDirectory);
      const input = Object.fromEntries(
        records.map((file) => [file.path, file.content ?? ""]),
      );
      const modificationTimes = Object.fromEntries(
        records.map((file) => [file.path, file.mtime]),
      );
      const versions = Object.fromEntries(
        records.map((file) => [file.path, file.version]),
      );
      const plan =
        operation === "extract"
          ? planExtract(input, source, selection, target)
          : planMerge(input, source, target);
      // Preflight all existing text before the first write; each write also uses CAS.
      for (const edit of plan.changes.filter(
        (edit) => edit.kind !== "create",
      )) {
        const disk = await bridge.read(edit.path);
        if (
          disk.content !== edit.before ||
          disk.mtime !== modificationTimes[edit.path] ||
          disk.version !== versions[edit.path]
        )
          throw Error(`${edit.path} 已在外部修改，请重新打开笔记重组。`);
      }
      for (const edit of plan.writes) {
        if (edit.kind === "create") await bridge.create(edit.path, edit.after);
        else
          await bridge.write(
            edit.path,
            edit.after,
            modificationTimes[edit.path],
            versions[edit.path],
          );
        written++;
      }
      for (const path of plan.deletes)
        await bridge.trash(path, modificationTimes[path], versions[path]);
      contentEpoch.current++;
      await refresh();
      if (operation === "merge") {
        setPanes((ps) => remapPanes(ps, source, target));
        setBookmarks((items) => remapBookmarks(items, source, target));
      }
      setDialog(null);
      open(target);
      notify(
        plan.warnings?.length
          ? plan.warnings.join("；")
          : operation === "extract"
            ? "已提取选区并维护引用"
            : "已合并笔记、维护引用并回收原文",
      );
    } catch (error) {
      if (written) {
        contentEpoch.current++;
        await refresh().catch(() => {});
        throw Error(
          `重组中止，已写入 ${written} 个文件。请核对目标与原文后继续；已写入文件可从版本历史恢复。${error.message}`,
        );
      }
      throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function importAttachments(
    dropped,
    source = active,
    index = paneIndex,
    suppliedSelection,
  ) {
    const selected =
      suppliedSelection || editorFor(index)?.getSelectionInfo?.();
    const original = fileRef.current[source];
    await flush();
    let imported = [];
    if (bridge.importDroppedFiles && [...dropped].every((file) => file.name)) {
      try {
        imported = await bridge.importDroppedFiles([...dropped], "附件");
      } catch (error) {
        if (![...dropped].every((file) => file.type?.startsWith("image/")))
          throw error;
      }
    }
    if (!imported.length) {
      if (!bridge.writeBinary) throw Error("请在桌面版导入附件");
      for (const file of dropped) {
        if (file.size > 64 * 1024 * 1024) throw Error("单个附件超过64MB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const filename = (file.name || "粘贴图片.png").replace(
          /[<>:"/\\|?*\x00-\x1f]/g,
          "_",
        );
        const path = `附件/${Date.now()}-${crypto.randomUUID().slice(0, 6)}-${filename}`;
        await bridge.writeBinary(path, btoa(binary));
        imported.push({ path });
      }
    }
    const links = imported
      .map((file) => `![[${typeof file === "string" ? file : file.path}]]`)
      .join("\n");
    if (source?.endsWith(".md") && source in fileRef.current) {
      const current = fileRef.current[source];
      const next =
        current === original && validateSelectedSpan(selected, source, original)
          ? current.slice(0, selected.from) + links + current.slice(selected.to)
          : current + "\n" + links + "\n";
      change(source, next);
      await save(source);
    }
    await refresh();
    notify(`已导入 ${imported.length} 个附件`);
  }
  const view = (p, i) => {
    if (p?.startsWith("@web:"))
      return (
        <WebViewer
          key={`${snapshot.vaultPath}:${p}:${i}`}
          url={p.slice(5)}
          visible={!dialog && !busy && ready}
        />
      );
    if (p?.startsWith("@plugin-view:")) return <PluginViewMount host={pluginHost} leafId={p.slice(13)} />;
    if (!p || p.startsWith("@empty:"))
      return (
        <div className="empty-pane">
          <div className="empty-mark">◇</div>
          <h2>让想法有一个落脚点</h2>
          <p>打开一篇笔记，或创建新的开始。</p>
          <button className="primary" onClick={newNote}>
            <Plus size={16} />
            新建笔记
          </button>
          <small>Ctrl + O 快速打开 · Ctrl + P 命令面板</small>
        </div>
      );
    if (p === "@graph" || p.startsWith("@localgraph:"))
      return (
        <GraphView
          files={allFiles}
          onOpen={(path) => open(path, i)}
          activePath={p.startsWith("@localgraph:") ? p.slice(12) : active}
          local={p.startsWith("@localgraph:")}
        />
      );
    if (p.endsWith(".canvas"))
      return (
        <CanvasView
          key={`${snapshot.vaultPath}:${p}`}
          path={p}
          value={files[p] || '{"nodes":[],"edges":[]}'}
          onChange={(v) => change(p, v)}
          onOpen={(link) => navigate(link, p, i)}
          files={allFiles}
          resolveAsset={(path) => bridge.assetUrl(path)}
        />
      );
    if (p.endsWith(".base"))
      return (
        <BasesView
          key={`${snapshot.vaultPath}:${p}`}
          path={p}
          metadata={Object.fromEntries(
            snapshot.files.map((file) => [file.path, file]),
          )}
          value={files[p] || ""}
          onChange={(v) => change(p, v)}
          files={allFiles}
          onEditFile={(path, text) => change(path, text)}
          resolveAsset={(path) => bridge.assetUrl(path)}
          onNavigate={(link, sourcePath) => navigate(link, sourcePath, i)}
          onOpen={(path) => open(path, i)}
        />
      );
    if (!isText(p))
      return (
        <AssetView
          key={`${snapshot.vaultPath}:${p}:${snapshot.files.find((f) => f.path === p)?.mtime || 0}`}
          path={p}
          initialPage={pdfPages[p]?.page || 1}
          navigationKey={pdfPages[p]?.key || 0}
          onNavigate={(link) => navigate(link, p, i)}
          onCopyReference={async ({ path, page, text }) => {
            const link = `[[${path}#page=${page}]]`;
            const quote = text
              ? text
                  .split("\n")
                  .map((line) => "> " + line)
                  .join("\n") + "\n\n"
              : "";
            await (
              bridge.writeClipboard ||
              navigator.clipboard.writeText.bind(navigator.clipboard)
            )(quote + link);
            notify("PDF 引用已复制");
          }}
        />
      );
    if (!(p in files))
      return (
        <div className="empty-pane">
          <p>文件尚未成功读取，编辑已暂停。</p>
          <button onClick={() => run(refresh)}>重新读取</button>
        </div>
      );
    return (
      <Editor
        key={`${snapshot.vaultPath}:${panes[i]?.id}`}
        path={p}
        value={files[p] || ""}
        readOnly={busy || !ready || p !== panes[i]?.active}
        onSelectionChange={(value) => {
          if (i === paneIndex && p === panes[i]?.active) setSelection(value);
        }}
        onPasteFiles={(dropped, selected) =>
          run(() => importAttachments(dropped, p, i, selected))
        }
        mode={getPaneTabState(panes[i],p,defaultMode).mode}
        initialViewState={panes[i]?.tabStates?.[p]}
        viewStateRevision={viewStateRevision}
        onViewStateChange={(state,path) => recordViewState(state,path,panes[i]?.id)}
        processMarkdown={processPluginMarkdown}
        commands={commandItems.map(([name, , action]) => ({
          name,
          run: action,
        }))}
        files={allFiles}
        onChange={(v) => {
          change(p, v);
          const paneId=panes[i]?.id,epoch=vaultEpoch.current;
          queueMicrotask(()=>{
            if(epoch!==vaultEpoch.current)return;
            const leaf=pluginWorkspace.current?.getLeaves().find(row=>row.paneId===paneId&&row.path===p);
            if(leaf)for(const listener of pluginEvents.current)listener({scope:"workspace",name:"editor-change",leafId:leaf.id,path:p});
          });
        }}
        onNavigate={(link) => navigate(link, p, i)}
        resolveAsset={(path) =>
          bridge.assetUrl(
            resolveLink(path, p, linkIndex) || path,
          )
        }
        onReady={(api) => {
          editors.current[panes[i]?.id] = api;
        }}
      />
    );
  };

  function paneContent(pane, i) {
    const path = pane.active,
      key = snapshot.vaultPath + ":" + panes[i]?.id;
    const text =
      path &&
      isText(path) &&
      !path.endsWith(".canvas") &&
      !path.endsWith(".base");
    if (text) lastTextPaths.current[key] = path;
    const remembered = lastTextPaths.current[key];
    return (
      <>
        <div className="kept-pane" style={{ display: text ? "block" : "none" }}>
          {remembered && files[remembered] !== undefined
            ? view(remembered, i)
            : text
              ? view(path, i)
              : null}
        </div>
        {pane.tabs
          .filter((p) => p.startsWith("@web:"))
          .map((p) => (
            <div
              className="kept-pane"
              key={`${snapshot.vaultPath}:${p}`}
              style={{ display: path === p ? "block" : "none" }}
            >
              <WebViewer
                url={p.slice(5)}
                visible={path === p && !dialog && !busy && ready}
              />
            </div>
          ))}
        {!text && !path?.startsWith("@web:") && view(path, i)}
      </>
    );
  }
  return (
    <div
      className="app"
      aria-busy={busy}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          run(() => importAttachments([...e.dataTransfer.files]));
        }
      }}
    >
      <div className="titlebar">
        <div className="brand">
          <span className="gem">◇</span>
          <span>VaultDesk</span>
          <span className="branch-badge">LOCAL</span>
        </div>
        <div>
          {snapshot.preview
            ? "演示知识库"
            : snapshot.vaultPath?.split(/[\\/]/).pop() || "本地知识库"}
        </div>
        <div className="window-hint">独立实现 · 自托管</div>
      </div>
      <div className="workspace">
        <nav className="ribbon" aria-label="功能导航">
          <IconButton
            icon={Files}
            label="文件浏览器"
            active={leftTab === "files" && left}
            onClick={() => {
              setLeft(true);
              setLeftTab("files");
            }}
          />
          <IconButton
            icon={Search}
            label="搜索所有笔记"
            active={leftTab === "search" && left}
            onClick={() => {
              setLeft(true);
              setLeftTab("search");
            }}
          />
          <IconButton
            icon={Network}
            label="打开图谱"
            onClick={() => open("@graph")}
          />
          <IconButton
            icon={LayoutDashboard}
            label="新建 Canvas"
            onClick={newCanvas}
          />
          <IconButton
            icon={CalendarDays}
            label="打开每日笔记"
            onClick={() => run(daily)}
          />
          <IconButton icon={Table2} label="新建 Bases" onClick={newBase} />
          <IconButton
            icon={Bookmark}
            label="书签"
            active={leftTab === "bookmarks"}
            onClick={() => {
              setLeft(true);
              setLeftTab("bookmarks");
            }}
          />
          <IconButton
            icon={Command}
            label="命令面板"
            onClick={() => setDialog({ type: "commands" })}
          />
          <PluginRibbon host={pluginHost}/><div className="ribbon-space" />
          <IconButton
            icon={recording ? Square : Mic}
            label={recording ? "停止录音" : "录音"}
            active={recording}
            onClick={() => run(recordAudio)}
          />
          <IconButton
            icon={Cloud}
            label="同步与发布"
            active={syncing}
            onClick={() => setDialog({ type: "settings", section: "cloud" })}
          />
          <IconButton
            icon={Settings}
            label="设置"
            onClick={() => setDialog({ type: "settings", section: "editor" })}
          />
        </nav>
        <WorkspaceSidebar side="left" width={sidebars.left.width} collapsed={!left}
          onResize={width=>setSidebars(v=>({...v,left:{...v.left,width}}))}
          onCollapsedChange={collapsed=>setLeft(!collapsed)}>
        {left && (
          <aside className="left-sidebar">
            <div className="sidebar-tabs">
              <IconButton
                icon={Files}
                label="文件"
                active={leftTab === "files"}
                onClick={() => setLeftTab("files")}
              />
              <IconButton
                icon={Search}
                label="搜索"
                active={leftTab === "search"}
                onClick={() => setLeftTab("search")}
              />
              <IconButton
                icon={Hash}
                label="标签"
                active={leftTab === "tags"}
                onClick={() => setLeftTab("tags")}
              />
              <IconButton
                icon={Bookmark}
                label="书签列表"
                active={leftTab === "bookmarks"}
                onClick={() => setLeftTab("bookmarks")}
              />
              <span />
              <IconButton
                icon={PanelLeftClose}
                label="收起左侧栏"
                onClick={() => setLeft(false)}
              />
            </div>
            {leftTab === "files" && (
              <>
                <div className="section-caption">
                  <span>文件</span>
                  <div>
                    <IconButton
                      icon={SquarePen}
                      label="新建笔记"
                      onClick={newNote}
                    />
                    <IconButton
                      icon={FolderOpen}
                      label="新建文件夹"
                      onClick={() =>
                        setDialog({ type: "folder", value: "新建文件夹" })
                      }
                    />
                    <IconButton
                      icon={Paperclip}
                      label="导入附件"
                      onClick={() =>
                        run(async () => {
                          await bridge.importFiles();
                          await refresh();
                        })
                      }
                    />
                  </div>
                </div>
                <FileTree
                  files={snapshot.files}
                  active={active}
                  collapsed={collapsed}
                  sort={settings.fileSort}
                  onOpen={open}
                  onToggle={(path) =>
                    setCollapsed((value) => {
                      const next = new Set(value);
                      next.has(path) ? next.delete(path) : next.add(path);
                      return next;
                    })
                  }
                  onMenu={(path, folder) =>
                    setDialog({ type: "filemenu", path, folder })
                  }
                  onMove={(path, target) =>
                    run(() => rename(target, undefined, path))
                  }
                />
              </>
            )}
            {leftTab === "search" && (
              <div className="sidebar-scroll search-panel">
                <input
                  autoFocus
                  placeholder="搜索笔记…"
                  aria-label="搜索笔记"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <p className="hint">支持 path:、tag:、引号短语</p>
                <div className="section-caption">
                  {query ? `${results.length} 个结果` : "搜索你的知识库"}
                </div>
                {results.map((r, i) => {
                  const p = typeof r === "string" ? r : r.path;
                  return (
                    <button
                      key={p || i}
                      className="search-result"
                      onClick={() => {
                        open(p);
                        if (r.line != null)
                          setTimeout(
                            () =>
                              editorFor(paneIndex)?.scrollToLine?.(
                                r.line + 1,
                              ),
                            120,
                          );
                      }}
                    >
                      <b>{title(p)}</b>
                      <small>
                        {r.preview || r.snippet || files[p]?.slice(0, 100)}
                      </small>
                      <span>{p}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {leftTab === "tags" && (
              <div className="sidebar-scroll">
                <div className="section-caption">
                  标签 <span>{tags.length}</span>
                </div>
                {tags.map(([tag, paths]) => (
                  <button
                    className="tag-row"
                    key={tag}
                    onClick={() => {
                      setQuery(`tag:${String(tag).replace(/^#/, "")}`);
                      setLeftTab("search");
                    }}
                  >
                    <span>
                      <Hash size={14} />
                      {String(tag).replace(/^#/, "")}
                    </span>
                    <small>{paths.length}</small>
                  </button>
                ))}
              </div>
            )}
            {leftTab === "bookmarks" && (
              <div className="sidebar-scroll">
                <div className="section-caption">书签</div>
                <BookmarksPanel
                  items={bookmarks}
                  onChange={setBookmarks}
                  files={allFiles}
                  activePath={active?.startsWith("@") ? "" : active}
                  searchQuery={query}
                  onOpen={(item) => {
                    if (item.type === "search") {
                      setQuery(item.query);
                      setLeftTab("search");
                    } else if (item.type === "url")
                      bridge
                        .openExternal(item.url)
                        .catch((e) => notify(e.message));
                    else openExact(item.path, item.subpath || "");
                  }}
                />
              </div>
            )}
            <button className="vault-switch" onClick={() => run(openVault)}>
              <span className="vault-avatar">V</span>
              <span>
                <b>
                  {snapshot.vaultPath?.split(/[\\/]/).pop() || "选择知识库"}
                </b>
                <small>
                  {snapshot.preview
                    ? "浏览器演示 · 独立存储"
                    : "本地文件 · 自动保存"}
                </small>
              </span>
              <ChevronsUpDown size={15} />
            </button>
          </aside>
        )}
        </WorkspaceSidebar>
        <main className="panes">
          <WorkspaceLayout workspace={workspace} layout={workspace.layout} panes={workspace.panes}
            activePaneId={workspace.activePaneId} onChange={applyWorkspaceLayout}
            onActivate={(id,index)=>setPaneIndex(index)}
            renderPane={(pane,i,controls) => (
            <section
              className={"pane" + (paneIndex === i ? " focused" : "")}
              key={pane.id}
              onFocus={() => setPaneIndex(i)}
              onMouseDown={() => setPaneIndex(i)}
            >
              <div className="tabbar">
                {!left && i === 0 && (
                  <IconButton
                    icon={Files}
                    label="显示左侧栏"
                    onClick={() => setLeft(true)}
                  />
                )}
                <div className="tab-list" {...controls.getTabStripProps()}>
                  {pane.tabs.map((p) => (
                    <button
                      key={p}
                      className={"tab" + (p === pane.active ? " selected" : "")}
                      {...controls.getTabProps(p)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setDialog({ type: "tabmenu", path: p, pane: i });
                      }}
                      onClick={() => open(p, i)}
                    >
                      <span>
                        {p.startsWith("@") ? (
                          <Network size={14} />
                        ) : p.endsWith(".canvas") ? (
                          <LayoutDashboard size={14} />
                        ) : (
                          <FileText size={14} />
                        )}
                      </span>
                      <span>
                        {p.startsWith("@plugin-view:") ? <PluginViewTitle host={pluginHost} leafId={p.slice(13)}/> : p.startsWith("@empty:") ? "新标签页" : p.startsWith("@localgraph:")
                          ? "局部图谱"
                          : p === "@graph"
                            ? "关系图谱"
                            : p.startsWith("@web:")
                              ? p.slice(5)
                              : title(p)}
                      </span>
                      {(pane.pinned || []).includes(p) && (
                        <span title="已固定">◆</span>
                      )}
                      {dirty.current.has(p) && <i className="dirty-dot" />}
                      <span
                        className="tab-close"
                        role="button"
                        aria-label={`关闭 ${title(p)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(p, i);
                        }}
                      >
                        <X size={13} />
                      </span>
                    </button>
                  ))}
                </div>
                <IconButton
                  icon={Plus}
                  label="新标签页"
                  onClick={() => setDialog({ type: "quick" })}
                />
                <IconButton icon={Columns2} label="向右分屏" onClick={()=>split("vertical",undefined,pane.id)} />
                <IconButton icon={Columns2} label="向下分屏" onClick={()=>split("horizontal",undefined,pane.id)} />
                {panes.length>1 && <IconButton icon={X} label="关闭分屏" onClick={controls.closePane} />}
                {!right && (
                  <IconButton
                    icon={PanelRightClose}
                    label="显示右侧栏"
                    onClick={() => setRight(true)}
                  />
                )}
              </div>
              <div className="document-toolbar">
                <div className="nav-buttons">
                  <IconButton
                    icon={ArrowLeft}
                    label="后退"
                    disabled={navIndex.current <= 0}
                    onClick={() => {
                      navIndex.current--;
                      open(navHistory.current[navIndex.current], i, false);
                    }}
                  />
                  <IconButton
                    icon={ArrowRight}
                    label="前进"
                    disabled={navIndex.current >= navHistory.current.length - 1}
                    onClick={() => {
                      navIndex.current++;
                      open(navHistory.current[navIndex.current], i, false);
                    }}
                  />
                </div>
                <div className="breadcrumbs">
                  {pane.active?.startsWith("@")
                    ? pane.active.startsWith("@plugin-view:") ? <PluginViewTitle host={pluginHost} leafId={pane.active.slice(13)}/> : pane.active.startsWith("@empty:") ? "新标签页" : pane.active.startsWith("@web:") ? pane.active.slice(5) : "知识网络"
                    : pane.active?.split("/").map((s, k, a) => (
                        <React.Fragment key={k}>
                          <span className={k === a.length - 1 ? "last" : ""}>
                            {s.replace(/\.md$/, "")}
                          </span>
                          {k < a.length - 1 && <ChevronRight size={13} />}
                        </React.Fragment>
                      ))}
                </div>
                <div className="document-actions">
                  {pane.active?.endsWith(".md") && (
                    <>
                      <IconButton
                        icon={Code2}
                        label="源码模式"
                        active={getPaneTabState(pane,pane.active,defaultMode).mode === "source"}
                        onClick={() => setMode("source",i)}
                      />
                      <IconButton
                        icon={SquarePen}
                        label="实时预览"
                        active={getPaneTabState(pane,pane.active,defaultMode).mode === "live"}
                        onClick={() => setMode("live",i)}
                      />
                      <IconButton
                        icon={BookOpen}
                        label="阅读模式"
                        active={getPaneTabState(pane,pane.active,defaultMode).mode === "reading"}
                        onClick={() => setMode("reading",i)}
                      />
                    </>
                  )}
                  <IconButton
                    icon={MoreHorizontal}
                    label="笔记操作"
                    onClick={() =>
                      pane.active &&
                      setDialog({ type: "filemenu", path: pane.active })
                    }
                  />
                </div>
              </div>
              <div className="document-view">{paneContent(pane, i)}</div>
            </section>
          )}/>
        </main>
        <WorkspaceSidebar side="right" width={sidebars.right.width} collapsed={!right}
          onResize={width=>setSidebars(v=>({...v,right:{...v.right,width}}))}
          onCollapsedChange={collapsed=>setRight(!collapsed)}>
        {right && (
          <aside className="right-sidebar">
            <div className="sidebar-tabs">
              <IconButton
                icon={List}
                label="大纲"
                active={rightTab === "outline"}
                onClick={() => setRightTab("outline")}
              />
              <IconButton
                icon={Link2}
                label="反向链接"
                active={rightTab === "backlinks"}
                onClick={() => setRightTab("backlinks")}
              />
              <IconButton
                icon={ArrowRight}
                label="出链"
                active={rightTab === "outgoing"}
                onClick={() => setRightTab("outgoing")}
              />
              <IconButton
                icon={Table2}
                label="属性"
                active={rightTab === "properties"}
                onClick={() => setRightTab("properties")}
              />
              <span />
              <IconButton
                icon={PanelRightClose}
                label="收起右侧栏"
                onClick={() => setRight(false)}
              />
            </div>
            <div className="sidebar-scroll">
              {rightTab === "outline" && (
                <>
                  <div className="section-caption">大纲</div>
                  {(meta.headings || []).map((h, i) => (
                    <button
                      className="outline-row"
                      key={i}
                      style={{ paddingLeft: 16 + (h.level - 1) * 12 }}
                      onClick={() =>
                        editorFor(paneIndex)?.scrollToHeading?.(
                          h.heading || h.text,
                        )
                      }
                    >
                      <span className="outline-bullet">
                        {h.level === 1 ? "◆" : "•"}
                      </span>
                      {h.heading || h.text}
                    </button>
                  ))}
                  {!meta.headings?.length && (
                    <p className="muted padded">当前文档没有标题</p>
                  )}
                  <div className="sidebar-divider" />
                  <div className="section-caption">
                    反向链接 <span>{backlinks.length}</span>
                  </div>
                  {backlinks.slice(0, 6).map(([p, t]) => (
                    <button
                      key={p}
                      className="backlink-card"
                      onClick={() => open(p)}
                    >
                      <FileText size={14} />
                      <span>
                        <b>{title(p)}</b>
                        <small>{p}</small>
                      </span>
                    </button>
                  ))}
                </>
              )}
              {rightTab === "backlinks" && (
                <>
                  <div className="section-caption">
                    链接提及 <span>{backlinks.length}</span>
                  </div>
                  {backlinks.map(([p, t]) => (
                    <button
                      key={p}
                      className="backlink-card"
                      onClick={() => open(p)}
                    >
                      <FileText size={14} />
                      <span>
                        <b>{title(p)}</b>
                        <small>
                          {t
                            .split("\n")
                            .find((l) => l.includes(title(active))) || p}
                        </small>
                      </span>
                    </button>
                  ))}
                  <div className="section-caption">未链接提及</div>
                  {Object.entries(files)
                    .filter(
                      ([p, t]) =>
                        p !== active &&
                        !backlinks.some(([b]) => b === p) &&
                        title(active) &&
                        t.includes(title(active)),
                    )
                    .map(([p]) => (
                      <button
                        key={p}
                        className="tree-row"
                        onClick={() => open(p)}
                      >
                        {title(p)}
                      </button>
                    ))}
                </>
              )}
              {rightTab === "outgoing" && (
                <>
                  <div className="section-caption">
                    出链 <span>{outgoing.length}</span>
                  </div>
                  {outgoing.map((r, i) => (
                    <button
                      key={i}
                      className={"tree-row" + (!r.path ? " unresolved" : "")}
                      onClick={() => navigate(r.link)}
                    >
                      <Link2 size={14} />
                      {r.link || title(active)}
                    </button>
                  ))}
                </>
              )}
              {rightTab === "footnotes" && (
                <FootnotesPanel
                  text={content}
                  onNavigate={(id) =>
                    editorFor(paneIndex)?.scrollToFootnote?.(id)
                  }
                />
              )}
              {rightTab === "properties" && active?.endsWith(".md") && (
                <PropertiesPanel
                  text={content}
                  onChange={(t) => change(active, t)}
                />
              )}
            </div>
            <div className="sidebar-footer">
              <span className="online-dot" />
              所有笔记，尽在本地
            </div>
          </aside>
        )}
        </WorkspaceSidebar>
      </div>
      <footer className="statusbar">
        <span>
          {snapshot.files.filter((f) => !f.isDirectory).length} 个文件
        </span>
        <span>
          {active?.endsWith(".md") ? `${backlinks.length} 个反向链接` : ""}
        </span>
        <PluginStatusBar host={pluginHost}/>
        <span className="status-spacer" />
        <span className={saveState === "保存冲突" ? "error-text" : ""}>
          {saveState === "已保存" && <Check size={12} />} {saveState}
        </span>
        {dirty.current.size > 0 && saveState === "保存冲突" && (
          <button
            onClick={() =>
              setDialog({ type: "conflict", path: [...dirty.current][0] })
            }
          >
            处理冲突
          </button>
        )}
        <span>
          {selection.text
            ? `选区 ${selection.characters ?? Array.from(selection.text).length} 字符`
            : `${Array.from(content).length} 字符`}
        </span>
        <span>
          {selection.text
            ? selection.words
            : content.trim().split(/\s+/).filter(Boolean).length}{" "}
          词
        </span>
        <button onClick={() => run(syncNow)} title="立即同步">
          <Cloud size={13} />
          {syncing
            ? "同步中"
            : syncStatus.paused
              ? "同步已暂停"
              : syncStatus.phase === "offline"
                ? "离线重试中"
                : "自托管同步"}
        </button>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <IconButton icon={X} label="关闭通知" onClick={() => setNotice("")} />
        </div>
      )}
      {dialog && renderDialog()}
      {busy && (
        <div className="busy-shield" aria-label="正在处理">
          <span>正在处理…</span>
        </div>
      )}
    </div>
  );

  async function applyConversions(changes) {
    if (busyRef.current) throw Error("另一个文件操作正在进行");
    busyRef.current = true;
    setBusy(true);
    let count = 0;
    try {
      await flush();
      const checked = [];
      for (const row of changes) {
        if (!row.path.endsWith(".md") || !allPaths.includes(row.path))
          throw Error("只能转换当前库中的 Markdown 文件");
        const disk = await bridge.read(row.path);
        if (disk.content !== row.before)
          throw Error(row.path + " 在预览后已变化，请重新预览");
        checked.push({ ...row, mtime: disk.mtime, version: disk.version });
      }
      for (const row of checked) {
        await bridge.write(row.path, row.after, row.mtime, row.version);
        count++;
      }
      contentEpoch.current++;
      await refresh();
      notify(`已转换 ${count} 个文件，原文可从版本历史恢复`);
    } catch (error) {
      if (count) {
        contentEpoch.current++;
        await refresh().catch(() => {});
        throw Error(`已转换 ${count} 个文件后中止：${error.message}`);
      }
      throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function renderDialog() {
    const close = () => setDialog(null);
    if (dialog.type === "convert")
      return (
        <Dialog title="Markdown 格式转换" onClose={close} wide>
          <MarkdownConverterDialog
            files={files}
            initialPaths={active?.endsWith(".md") ? [active] : []}
            readFile={async (path) =>
              fileRef.current[path] ?? (await bridge.read(path)).content
            }
            onApply={applyConversions}
            onClose={close}
          />
        </Dialog>
      );

    if (dialog.type === "weburl")
      return (
        <InputDialog
          heading="打开网页标签"
          initial="https://"
          description="输入完整 HTTP 或 HTTPS 地址。"
          onClose={close}
          onSubmit={(value) => {
            try {
              const url = new URL(value);
              if (
                !["https:", "http:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw Error("请输入有效的 HTTP/HTTPS 地址");
              open("@web:" + url.href);
              close();
            } catch (e) {
              notify(e.message);
            }
          }}
        />
      );
    if (dialog.type === "tabmenu")
      return (
        <Dialog title="标签操作" onClose={close}>
          <div className="action-menu">
            <button
              onClick={() => {
                togglePin(dialog.path, dialog.pane);
                close();
              }}
            >
              固定 / 取消固定
            </button>
            <button
              onClick={() => {
                split("vertical",dialog.path);
                close();
              }}
            >
              在新分屏中打开
            </button>
            <button
              onClick={() =>
                run(async () => {
                  await flush();
                  await bridge.saveWorkspace(workspace);
                  await bridge.newWindow({ path: dialog.path });
                  close();
                })
              }
            >
              在新窗口中打开
            </button>
            <button
              onClick={() => {
                closeTab(dialog.path, dialog.pane);
                close();
              }}
            >
              关闭标签
            </button>
          </div>
        </Dialog>
      );

    if (dialog.type === "composer")
      return (
        <Dialog title="笔记重组" onClose={close} wide>
          <ComposerDialogBody
            files={files}
            active={dialog.path}
            selection={dialog.selection}
            onExtract={(target) => composeNotes("extract", target)}
            onMerge={(target) => composeNotes("merge", target)}
          />
        </Dialog>
      );
    if (["create", "folder", "rename"].includes(dialog.type))
      return (
        <InputDialog
          heading={
            dialog.type === "rename"
              ? "重命名 / 移动"
              : dialog.type === "folder"
                ? "新建文件夹"
                : "新建文件"
          }
          initial={dialog.value}
          description="路径相对于当前知识库，使用 / 创建子文件夹。"
          onClose={close}
          onSubmit={(value) =>
            run(async () => {
              if (dialog.type === "rename") return rename(value);
              if (dialog.type === "folder") {
                await bridge.mkdir(value);
                await refresh();
                close();
                return;
              }
              await create(value, dialog.text || "");
            })
          }
        />
      );
    if (
      dialog.type === "quick" ||
      dialog.type === "commands" ||
      dialog.type === "templates"
    )
      return (
        <Palette
          kind={dialog.type}
          files={allFiles}
          metadata={indexed}
          onCreate={(name) =>
            setDialog({
              type: "create",
              value: /\.md$/i.test(name) ? name : name + ".md",
              text: "",
            })
          }
          recent={recent}
          commands={commandItems}
          templateFolder={settings.templateFolder}
          onClose={close}
          onSelect={(item) => {
            close();
            if (dialog.type === "commands") item[2]();
            else if (dialog.type === "templates") {
              const text = applyTemplate(files[item] || "", {
                title: title(active),
                timeFormat: settings.timeFormat,
              });
              try { editorFor(paneIndex)?.insert?.(text); } catch(error) { notify(error.message); }
            } else open(item);
          }}
        />
      );
    if (dialog.type === "filemenu")
      return (
        <Dialog title={title(dialog.path)} onClose={close}>
          <div className="action-menu">
            {!dialog.folder && (
              <button
                onClick={() => {
                  open(dialog.path);
                  close();
                }}
              >
                <BookOpen size={17} />
                打开
              </button>
            )}
            <button
              onClick={() =>
                setDialog({
                  type: "rename",
                  path: dialog.path,
                  value: dialog.path,
                })
              }
            >
              <SquarePen size={17} />
              重命名 / 移动
            </button>
            {!dialog.folder && (
              <>
                <button
                  onClick={() => {
                    setBookmarks((b) => toggleFileBookmark(b, dialog.path));
                    close();
                  }}
                >
                  <Bookmark size={17} />
                  {hasFileBookmark(bookmarks, dialog.path)
                    ? "移除书签"
                    : "添加书签"}
                </button>
                <button
                  onClick={() =>
                    run(async () => {
                      const items = await bridge.getHistory(dialog.path);
                      setDialog({ type: "history", path: dialog.path, items });
                    })
                  }
                >
                  <History size={17} />
                  版本恢复
                </button>
                <button
                  onClick={() =>
                    setDialog({
                      type: "create",
                      value: title(dialog.path) + " 副本.md",
                      text: files[dialog.path] || "",
                    })
                  }
                >
                  <Copy size={17} />
                  另存为副本
                </button>
                <button
                  onClick={() => {
                    (
                      bridge.writeClipboard ||
                      navigator.clipboard.writeText.bind(navigator.clipboard)
                    )(`[[${dialog.path.replace(/\.md$/, "")}]]`).then(() =>
                      notify("链接已复制"),
                    );
                    close();
                  }}
                >
                  <Link2 size={17} />
                  复制内部链接
                </button>
              </>
            )}
            <button
              className="danger"
              onClick={() => setDialog({ type: "delete", path: dialog.path })}
            >
              <Trash2 size={17} />
              移至回收站
            </button>
          </div>
        </Dialog>
      );
    if (dialog.type === "renameDecision")
      return (
        <Dialog title="更新内部链接" onClose={close}>
          <p className="padded">
            重命名「{dialog.path}」时，是否更新引用它的内部链接？
          </p>
          <div className="dialog-actions">
            <button onClick={() => run(() => rename(dialog.value, "decline"))}>
              不更新
            </button>
            <button onClick={() => run(() => rename(dialog.value, "once"))}>
              仅这一次
            </button>
            <button
              className="primary"
              onClick={() => run(() => rename(dialog.value, "always"))}
            >
              总是更新
            </button>
          </div>
        </Dialog>
      );
    if (dialog.type === "delete")
      return (
        <Dialog title="移至回收站" onClose={close}>
          <p className="padded">
            将「{dialog.path}」移至当前知识库的
            .vaultdesk/trash。原文件仍可从该目录取回。
          </p>
          <div className="dialog-actions">
            <button onClick={close}>取消</button>
            <button
              className="danger"
              onClick={() =>
                run(async () => {
                  await flush();
                  await bridge.trash(dialog.path);
                  setPanes((ps) =>
                    ps.map((p) => {
                      const tabs = p.tabs.filter(
                        (t) =>
                          t !== dialog.path && !t.startsWith(dialog.path + "/"),
                      );
                      return {
                        tabs,
                        active: tabs.includes(p.active)
                          ? p.active
                          : tabs[0] || null,
                      };
                    }),
                  );
                  await refresh();
                  close();
                })
              }
            >
              移至回收站
            </button>
          </div>
        </Dialog>
      );
    if (dialog.type === "conflict")
      return (
        <Dialog title="保存冲突" onClose={close}>
          <p className="padded">
            「{dialog.path}
            」已被外部程序修改。当前窗口内的编辑尚未覆盖磁盘文件。
          </p>
          <div className="dialog-actions">
            <button onClick={close}>继续保留编辑</button>
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  const p = dialog.path;
                  const copy = p.replace(
                    /(\.[^/.]+)?$/,
                    ` 冲突副本-${Date.now()}$1`,
                  );
                  await bridge.create(copy, fileRef.current[p]);
                  clearTimeout(timers.current.get(p));
                  dirty.current.delete(p);
                  contentEpoch.current++;
                  await refresh();
                  setSaveState(dirty.current.size ? "待保存" : "已保存");
                  close();
                  open(copy);
                  notify("已保留当前编辑副本，原文件维持磁盘版本");
                })
              }
            >
              保存副本并读取磁盘版本
            </button>
          </div>
        </Dialog>
      );
    if (dialog.type === "history")
      return (
        <Dialog title={"版本恢复 · " + title(dialog.path)} onClose={close} wide>
          <HistoryPanel
            path={dialog.path}
            items={dialog.items || []}
            current={files[dialog.path] || ""}
            readVersion={(path, id) =>
              bridge.readHistory
                ? bridge.readHistory(path, id)
                : Promise.resolve((dialog.items || []).find((v) => v.id === id))
            }
            onRestore={(id) =>
              run(async () => {
                await flush();
                await bridge.restoreHistory(dialog.path, id);
                await refresh();
                close();
                notify("历史版本已恢复");
              })
            }
          />
        </Dialog>
      );
    if (dialog.type === "settings")
      return (
        <SettingsDialog
          section={dialog.section}
          plugins={plugins}
          setPlugins={setPlugins}
          pluginHost={pluginHost}
          commandItems={defaultCommands}
          settings={settings}
          setSettings={setSettings}
          cloud={cloud}
          setCloud={setCloud}
          user={cloudUser}
          setUser={setCloudUser}
          vaults={vaults}
          setVaults={setVaults}
          sites={sites}
          setSites={setSites}
          files={files}
          active={active}
          cloudCall={cloudCall}
          syncNow={syncNow}
          syncStatus={syncStatus}
          syncProgress={syncProgress}
          notify={notify}
          run={run}
          onClose={close}
        />
      );
    if (dialog.type === "workspaces")
      return (
        <Dialog title="工作区布局" onClose={close} wide>
          <WorkspacesPanel
            current={{ panes, mode }}
            workspaces={workspaces}
            onSave={async (name) => {
              await pluginHost?.captureViewStates?.();
              await flush();
              const current=liveWorkspace.current;
              const savedPanes=current.panes.map(pane=>{
                const api=editors.current[pane.id];
                if(!api || api.path!==pane.active || api.getStatus?.().pending)return pane;
                return{...pane,tabStates:{...pane.tabStates,[pane.active]:api.getViewState()}};
              });
              const saved={...current,panes:savedPanes};
              delete saved.workspaces; delete saved.plugins; delete saved.cloud;
              const next={...current.workspaces,[name]:saved};
              await bridge.saveWorkspace({...current,workspaces:next});
              setWorkspaces(next);
            }}
            onDelete={async (name) => {
              const current=liveWorkspace.current;
              const next=Object.fromEntries(Object.entries(current.workspaces||{}).filter(([key])=>key!==name));
              await bridge.saveWorkspace({...current,workspaces:next});
              setWorkspaces(next);
            }}
            onLoad={async (name) => {
              await flush();
              const w = workspaces[name];
              if (!w) return;
              const ps = normalizeWorkspaceLayout(w,allPaths).panes;
              applyWorkspaceLayout({...w,panes:ps.length ? ps : [{tabs:[],active:null}]});
              setLeft(w.left !== false);
              setRight(w.right !== false);
              setLeftTab(w.leftTab || "files");
              setRightTab(w.rightTab || "outline");
              setSplitDirection(w.splitDirection || "horizontal");
              setDefaultMode(w.mode || "live");
              setViewStateRevision(value=>value+1);
              await pluginHost?.syncWorkspace?.({forceState:true});
            }}
          />
        </Dialog>
      );
    if (dialog.type === "trash")
      return (
        <Dialog title="回收站" onClose={close} wide>
          <div className="history-list">
            {!dialog.items.length && <p>回收站为空。</p>}
            {dialog.items.map((item) => (
              <div className="history-item" key={item.id}>
                <span>
                  <b>{item.path}</b>
                  <small>{new Date(item.timestamp).toLocaleString()}</small>
                </span>
                <button
                  onClick={() =>
                    run(async () => {
                      await bridge.restoreTrash(item.id);
                      await refresh();
                      setDialog({
                        type: "trash",
                        items: await bridge.listTrash(),
                      });
                      notify("已恢复 " + item.path);
                    })
                  }
                >
                  恢复文件
                </button>
              </div>
            ))}
          </div>
        </Dialog>
      );
    if (dialog.type === "slides")
      return (
        <DesktopSlides
          text={content}
          path={active}
          files={allFiles}
          resolveAsset={(path) => bridge.assetUrl(path)}
          onClose={close}
          onNavigate={navigate}
        />
      );
    return null;
  }
}

function InputDialog({ heading, initial, description, onSubmit, onClose }) {
  const [value, setValue] = useState(initial || "");
  return (
    <Dialog title={heading} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
      >
        <div className="form-body">
          <label>
            名称 / 相对路径
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
              required
            />
          </label>
          <p className="muted">{description}</p>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            确定
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function Palette({
  kind,
  files,
  recent,
  commands,
  templateFolder,
  metadata = {},
  onCreate,
  onSelect,
  onClose,
}) {
  const [q, setQ] = useState(""),
    [selection, setSelection] = useState(0);
  const entries =
    kind === "commands"
      ? commands
      : kind === "templates"
        ? Object.keys(files).filter(
            (p) => p.startsWith(templateFolder + "/") && p.endsWith(".md"),
          )
        : [
            ...new Set([
              ...recent.filter((p) => p in files),
              ...Object.keys(files),
            ]),
          ];
  const filtered = entries.filter((item) => {
    const text = Array.isArray(item) ? item[0] : item;
    if (text.toLowerCase().includes(q.toLowerCase())) return true;
    if (kind !== "quick" || Array.isArray(item)) return false;
    const aliases = metadata[item]?.meta?.frontmatter?.aliases;
    return (Array.isArray(aliases) ? aliases : aliases ? [aliases] : []).some(
      (alias) => String(alias).toLowerCase().includes(q.toLowerCase()),
    );
  });
  return (
    <Dialog
      title={
        kind === "commands"
          ? "命令面板"
          : kind === "templates"
            ? "插入模板"
            : "快速切换"
      }
      onClose={onClose}
      wide
    >
      <div className="palette">
        <input
          autoFocus
          placeholder={kind === "commands" ? "输入命令…" : "输入文件名…"}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelection(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelection((s) => Math.min(s + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelection((s) => Math.max(s - 1, 0));
            }
            if (e.key === "Enter" && filtered[selection])
              onSelect(filtered[selection]);
            else if (e.key === "Enter" && kind === "quick" && q.trim())
              onCreate?.(q.trim());
          }}
        />
        <div className="palette-results">
          {filtered.slice(0, 100).map((item, i) => (
            <button
              key={Array.isArray(item) ? item[0] : item}
              className={selection === i ? "selected" : ""}
              onMouseEnter={() => setSelection(i)}
              onClick={() => onSelect(item)}
            >
              <span>
                {kind === "commands" ? (
                  <Command size={16} />
                ) : (
                  <FileText size={16} />
                )}
              </span>
              <span>
                {Array.isArray(item) ? item[0] : title(item)}
                <small>{Array.isArray(item) ? "" : item}</small>
              </span>
              <kbd>{Array.isArray(item) ? item[1] : ""}</kbd>
            </button>
          ))}
          {!filtered.length &&
            (kind === "quick" && q.trim() ? (
              <button className="padded" onClick={() => onCreate?.(q.trim())}>
                创建笔记「{q.trim()}」
              </button>
            ) : (
              <p className="padded muted">没有匹配结果</p>
            ))}
        </div>
        <footer>
          ↑↓ 选择 <span>↵ 打开</span>
          <span>esc 关闭</span>
        </footer>
      </div>
    </Dialog>
  );
}
function AssetView({
  path,
  initialPage,
  navigationKey,
  onNavigate,
  onCopyReference,
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setUrl("");
    setError("");
    bridge
      .assetUrl(path)
      .then((u) => live && setUrl(u))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path]);
  if (error)
    return (
      <div className="empty-pane">
        <p>无法读取附件</p>
        <small>{error}</small>
      </div>
    );
  if (!url) return <div className="empty-pane">正在载入附件…</div>;
  return (
    <div
      className={"asset-view" + (/\.pdf$/i.test(path) ? " pdf-asset-view" : "")}
    >
      {/\.pdf$/i.test(path) ? (
        <PdfViewer
          path={path}
          url={url}
          navigationKey={navigationKey}
          initialPage={initialPage}
          onNavigate={onNavigate}
          onCopyReference={onCopyReference}
        />
      ) : /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path) ? (
        <img src={url} alt={path} />
      ) : /\.(mp3|wav|ogg|m4a|flac)$/i.test(path) ? (
        <audio controls src={url} />
      ) : /\.(mp4|webm|mov)$/i.test(path) ? (
        <video controls src={url} />
      ) : (
        <div className="empty-pane">
          <Paperclip size={36} />
          <h2>{path.split("/").pop()}</h2>
          <p>此文件可作为笔记附件保存在知识库中。</p>
          <button
            onClick={() =>
              bridge.exportAttachment
                ? bridge
                    .exportAttachment(path)
                    .catch((e) => setError(e.message))
                : setError("请在桌面版导出附件")
            }
          >
            另存附件
          </button>
        </div>
      )}
    </div>
  );
}
function Slides({ text, files, onClose, navigate }) {
  const slides = text.split(/^---\s*$/m).filter((s) => s.trim()),
    [index, setIndex] = useState(0);
  return (
    <Dialog
      title={`幻灯片 ${index + 1} / ${slides.length}`}
      onClose={onClose}
      wide
    >
      <div className="slides-body">
        <Editor
          path="slides.md"
          value={slides[index] || ""}
          mode="reading"
          files={files}
          onChange={() => {}}
          onNavigate={navigate}
          resolveAsset={(p) => bridge.assetUrl(p)}
        />
      </div>
      <div className="dialog-actions">
        <button disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
          上一页
        </button>
        <button
          disabled={index === slides.length - 1}
          onClick={() => setIndex((i) => i + 1)}
        >
          下一页
        </button>
      </div>
    </Dialog>
  );
}

function SettingsDialog({
  section,
  plugins,
  setPlugins,
  pluginHost,
  commandItems,
  settings,
  setSettings,
  cloud,
  setCloud,
  user,
  setUser,
  vaults,
  setVaults,
  sites,
  setSites,
  files,
  active,
  cloudCall,
  syncNow,
  syncStatus,
  syncProgress,
  notify,
  run,
  onClose,
}) {
  const [tab, setTab] = useState(section || "editor"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [vaultName, setVaultName] = useState("我的知识库"),
    [slug, setSlug] = useState("my-notes"),
    [siteTitle, setSiteTitle] = useState("我的笔记"),
    [selected, setSelected] = useState(
      active && !active.startsWith("@") ? [active] : [],
    );
  const update = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const auth = (type) =>
    run(async () => {
      const r = await cloudCall("/auth/" + type, {
        method: "POST",
        body: { email, password },
      });
      setCloud((c) => ({ ...c, token: r.token }));
      setUser(r.user);
      setPassword("");
      notify(type === "register" ? "独立账号已创建" : "登录成功");
    });
  const loadVaults = () =>
    run(async () => {
      const r = await cloudCall("/vaults");
      setVaults(Array.isArray(r) ? r : r.vaults || []);
    });
  const loadSites = () =>
    run(async () => {
      const r = await cloudCall("/sites");
      setSites(Array.isArray(r) ? r : r.sites || []);
    });
  return (
    <Dialog title="设置" onClose={onClose} wide>
      <div className="settings-layout">
        <nav>
          {[
            ["editor", "编辑器"],
            ["appearance", "外观"],
            ["hotkeys", "快捷键"],
            ["files", "文件与链接"],
            ["daily", "日记与模板"],
            ["cloud", "同步与发布"],
            ["plugins", "本地插件"],
            ["about", "关于与兼容范围"],
          ].map(([id, name]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === "editor" && (
            <>
              <h3>编辑器</h3>
              <Setting title="字体大小" note="调整笔记正文与阅读模式的文字大小">
                <input
                  type="number"
                  min="12"
                  max="30"
                  value={settings.fontSize}
                  onChange={(e) =>
                    update("fontSize", Number(e.target.value) || 16)
                  }
                />
              </Setting>
              <Setting title="可读行宽" note="限制长段落的最大宽度">
                <input
                  type="number"
                  min="400"
                  max="1600"
                  step="40"
                  value={settings.lineWidth}
                  onChange={(e) =>
                    update("lineWidth", Number(e.target.value) || 760)
                  }
                />
              </Setting>
              <p className="settings-note">
                编辑器支持 Ctrl+F 查找、Ctrl+Z 撤销、Ctrl+Shift+Z 重做。Ctrl+E
                切换阅读模式。
              </p>
            </>
          )}
          {tab === "appearance" && (
            <>
              <h3>外观</h3>
              <Setting title="基础主题" note="在深色与浅色之间切换">
                <select
                  value={settings.theme}
                  onChange={(e) => update("theme", e.target.value)}
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </Setting>
              <p className="settings-note">
                采用独立绘制的界面与图标，不包含原应用资源。
              </p>
              <AppearanceExtras
                css={settings.customCss || ""}
                onChange={(value) => update("customCss", value)}
              />
            </>
          )}
          {tab === "hotkeys" && (
            <HotkeysPanel
              commands={commandItems.map(([name, defaultHotkey, , id]) => ({
                id: id || name,
                name,
                defaultHotkey,
              }))}
              hotkeys={settings.hotkeys || {}}
              onChange={(value) => update("hotkeys", value)}
            />
          )}
          {tab === "files" && (
            <>
              <h3>文件与链接</h3>
              <Setting title="文件排序">
                <select
                  value={settings.fileSort || "name-asc"}
                  onChange={(e) => update("fileSort", e.target.value)}
                >
                  <option value="name-asc">名称升序</option>
                  <option value="name-desc">名称降序</option>
                  <option value="modified">最近修改</option>
                </select>
              </Setting>
              <Setting
                title="自动更新内部链接"
                note="重命名或移动时保留原引用目标"
              >
                <input
                  type="checkbox"
                  checked={settings.alwaysUpdateLinks}
                  onChange={(e) =>
                    update("alwaysUpdateLinks", e.target.checked)
                  }
                />
              </Setting>
              <Setting title="使用 Markdown 链接" note="重命名后生成链接的格式">
                <input
                  type="checkbox"
                  checked={settings.useMarkdownLinks}
                  onChange={(e) => update("useMarkdownLinks", e.target.checked)}
                />
              </Setting>
              <p className="settings-note">
                笔记以普通 Markdown
                保存。应用设置、历史、回收站与同步状态保存在知识库的 .vaultdesk
                目录。已有 .obsidian 目录不会被改写。
              </p>
            </>
          )}
          {tab === "daily" && (
            <>
              <h3>日记与模板</h3>
              <Setting title="日记目录">
                <input
                  value={settings.dailyFolder}
                  onChange={(e) => update("dailyFolder", e.target.value)}
                />
              </Setting>
              <Setting title="日期格式">
                <input
                  value={settings.dailyFormat}
                  onChange={(e) => update("dailyFormat", e.target.value)}
                />
              </Setting>
              <Setting title="每日模板文件">
                <input
                  value={settings.dailyTemplate}
                  onChange={(e) => update("dailyTemplate", e.target.value)}
                />
              </Setting>
              <Setting title="时间格式">
                <input
                  value={settings.timeFormat}
                  onChange={(e) => update("timeFormat", e.target.value)}
                />
              </Setting>
              <Setting title="唯一笔记格式">
                <input
                  value={settings.uniqueFormat}
                  onChange={(e) => update("uniqueFormat", e.target.value)}
                />
              </Setting>
              <Setting title="唯一笔记目录">
                <input
                  value={settings.uniqueFolder}
                  onChange={(e) => update("uniqueFolder", e.target.value)}
                />
              </Setting>
              <Setting title="唯一笔记模板文件">
                <input
                  value={settings.uniqueTemplate}
                  onChange={(e) => update("uniqueTemplate", e.target.value)}
                />
              </Setting>
              <Setting title="模板目录">
                <input
                  value={settings.templateFolder}
                  onChange={(e) => update("templateFolder", e.target.value)}
                />
              </Setting>
              <p className="settings-note">
                每日笔记优先使用模板目录中的「每日笔记.md」。模板支持{" "}
                {"{{date}}"}、{"{{time}}"}、{"{{title}}"}。
              </p>
            </>
          )}
          {tab === "cloud" && (
            <>
              <h3>自己的云服务</h3>
              <p className="settings-note">
                连接你部署的 VaultDesk
                服务。可手动或自动同步，账号令牌仅在本次会话中保留。
              </p>
              <label>
                服务地址
                <input
                  value={cloud.baseUrl}
                  onChange={(e) => {
                    bridge.syncPause?.().catch(() => {});
                    setCloud({
                      baseUrl: e.target.value,
                      token: "",
                      vaultId: "",
                    });
                    setUser(null);
                    setVaults([]);
                    setSites([]);
                  }}
                  placeholder="http://127.0.0.1:8766"
                />
              </label>
              {!cloud.token ? (
                <>
                  <div className="form-grid">
                    <label>
                      邮箱
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="username"
                      />
                    </label>
                    <label>
                      密码
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button className="primary" onClick={() => auth("login")}>
                      登录
                    </button>
                    <button onClick={() => auth("register")}>
                      创建独立账号
                    </button>
                    <button
                      onClick={() =>
                        run(async () => {
                          await cloudCall("/health");
                          notify("服务连接正常");
                        })
                      }
                    >
                      测试连接
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="account-row">
                    <span>
                      <Check size={15} />
                      已登录 {user?.email || email}
                    </span>
                    <button
                      onClick={() =>
                        run(async () => {
                          await cloudCall("/auth/logout", { method: "POST" });
                          setCloud((c) => ({ ...c, token: "" }));
                          setUser(null);
                        })
                      }
                    >
                      退出
                    </button>
                  </div>
                  <h4>自动与选择性同步</h4>
                  <Setting title="自动同步">
                    <input
                      type="checkbox"
                      checked={!!cloud.autoSync}
                      onChange={(e) =>
                        setCloud((c) => ({ ...c, autoSync: e.target.checked }))
                      }
                    />
                  </Setting>
                  <Setting title="暂停同步">
                    <input
                      type="checkbox"
                      checked={!!cloud.paused}
                      onChange={(e) =>
                        setCloud((c) => ({ ...c, paused: e.target.checked }))
                      }
                    />
                  </Setting>
                  <label>
                    排除目录（每行一个）
                    <textarea
                      aria-label="同步排除目录"
                      value={(cloud.excludeFolders || []).join("\n")}
                      onChange={(e) =>
                        setCloud((c) => ({
                          ...c,
                          excludeFolders: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                    />
                  </label>
                  <label>
                    附件类型
                    <select
                      aria-label="附件同步类型"
                      value={
                        Array.isArray(cloud.attachmentTypes)
                          ? "custom"
                          : cloud.attachmentTypes || "all"
                      }
                      onChange={(e) =>
                        setCloud((c) => ({
                          ...c,
                          attachmentTypes:
                            e.target.value === "custom"
                              ? ["pdf", "png", "jpg"]
                              : e.target.value,
                        }))
                      }
                    >
                      <option value="all">所有附件</option>
                      <option value="none">仅笔记</option>
                      <option value="custom">指定扩展名</option>
                    </select>
                  </label>
                  {Array.isArray(cloud.attachmentTypes) && (
                    <input
                      aria-label="同步附件扩展名"
                      value={cloud.attachmentTypes.join(",")}
                      onChange={(e) =>
                        setCloud((c) => ({
                          ...c,
                          attachmentTypes: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                    />
                  )}
                  <p className="settings-note">
                    状态：{syncStatus?.phase || "idle"}
                    {syncStatus?.lastError ? " · " + syncStatus.lastError : ""}
                    {syncProgress?.path ? " · " + syncProgress.path : ""}
                    。同步前会等待同库各窗口保存；排除内容保留远端数据。
                  </p>
                  <h4>远程知识库</h4>
                  <div className="button-row">
                    <button onClick={loadVaults}>刷新列表</button>
                    <select
                      aria-label="远程知识库"
                      value={cloud.vaultId}
                      onChange={(e) =>
                        setCloud((c) => ({ ...c, vaultId: e.target.value }))
                      }
                    >
                      <option value="">选择远程知识库</option>
                      {vaults.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="button-row">
                    <input
                      aria-label="新远程知识库名称"
                      value={vaultName}
                      onChange={(e) => setVaultName(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        run(async () => {
                          const v = await cloudCall("/vaults", {
                            method: "POST",
                            body: { name: vaultName },
                          });
                          setVaults((old) => [...old, v]);
                          setCloud((c) => ({ ...c, vaultId: v.id }));
                          notify("远程知识库已创建");
                        })
                      }
                    >
                      创建远程库
                    </button>
                  </div>
                  <button
                    className="primary"
                    disabled={!cloud.vaultId}
                    onClick={() => run(syncNow)}
                  >
                    <RefreshCw size={15} />
                    立即双向同步
                  </button>
                  <p className="settings-note">
                    同步采用版本校验，冲突保留副本。服务端可读取上传内容；当前版本没有端到端加密。
                  </p>
                  <h4>发布网站</h4>
                  <p className="settings-note">
                    只发布下面勾选并已同步的文件。发布后无需登录即可访问；修改笔记后需再次发布更新快照。
                  </p>
                  <div className="form-grid">
                    <label>
                      网站标识
                      <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                      />
                    </label>
                    <label>
                      网站名称
                      <input
                        value={siteTitle}
                        onChange={(e) => setSiteTitle(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="publish-files">
                    {Object.keys(files)
                      .filter((p) => p.endsWith(".md"))
                      .map((p) => (
                        <label key={p}>
                          <input
                            type="checkbox"
                            checked={selected.includes(p)}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, p]
                                  : s.filter((x) => x !== p),
                              )
                            }
                          />
                          {p}
                        </label>
                      ))}
                  </div>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={!cloud.vaultId || !selected.length}
                      onClick={() =>
                        run(async () => {
                          const s = await cloudCall("/sites", {
                            method: "POST",
                            body: {
                              vault_id: cloud.vaultId,
                              slug,
                              title: siteTitle,
                              paths: selected,
                            },
                          });
                          setSites((old) => [
                            ...old.filter((v) => v.id !== s.id),
                            s,
                          ]);
                          notify("所选文件已公开发布");
                        })
                      }
                    >
                      <Globe size={15} />
                      公开发布所选文件
                    </button>
                    <button onClick={loadSites}>已有站点</button>
                  </div>
                  {sites.map((s) => (
                    <div className="site-row" key={s.id}>
                      <button
                        className="link-button"
                        onClick={() =>
                          bridge
                            .openExternal(cloud.baseUrl + `/p/${s.slug}/`)
                            .catch((e) => notify(e.message))
                        }
                      >
                        {s.title} ↗
                      </button>
                      <button
                        onClick={() =>
                          run(async () => {
                            await cloudCall(`/sites/${s.id}`, {
                              method: "DELETE",
                            });
                            setSites((all) => all.filter((x) => x.id !== s.id));
                            notify("已取消发布");
                          })
                        }
                      >
                        取消发布
                      </button>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          {tab === "plugins" && (
            <PluginsPanel
              plugins={plugins}
              onChange={setPlugins}
              host={pluginHost}
              notify={notify}
            />
          )}
          {tab === "about" && (
            <>
              <div className="about-mark">◇</div>
              <h3>VaultDesk 0.3.0</h3>
              <p>
                基于 Obsidian 1.13.7 的 REA 行为研究构建的独立本地笔记应用。
              </p>
              <p>
                本版覆盖本地知识库、编辑与阅读、双链、图谱、Canvas、属性表以及自部署同步发布。
              </p>
              <p className="settings-note">
                此版本仍在兼容性建设中：社区插件生态、完整 Live Preview、Bases
                查询语言、移动端、原版所有快捷键与交互尚未达到完整一致性。详细证据与限制见源码中的
                docs/parity.md。
              </p>
              <p className="settings-note">
                数据文件属于你。应用不会默认连接 Obsidian 云端。
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
function Setting({ title: label, note, children }) {
  const id = useId();
  const control = React.isValidElement(children) &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div className="setting-row">
      <label htmlFor={control ? id : undefined}>
        <b>{label}</b>
        {note && <small>{note}</small>}
      </label>
      {control ? React.cloneElement(children, { id }) : children}
    </div>
  );
}
