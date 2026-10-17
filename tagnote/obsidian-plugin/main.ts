/**
 * TagNote Obsidian 插件。
 *
 * 标签笔记 = 普通 .md 笔记：frontmatter 里有 `tagnote: 1`，正文末尾有一个 ```tagnote 代码块装作品集 JSON
 * （生成器 backend/v2/tagnote_note.py）。
 *
 * - 打开这种笔记时直接显示六种视图：拦截 WorkspaceLeaf.setViewState，把 markdown 换成本插件的视图类型
 *   （同 Kanban 插件的做法，所以不会先闪一下 Markdown）。卸载插件时还原。
 * - 本视图只读：getViewData 原样返回读到的文本；requestSave、save 不写盘。
 * - 引擎 vendor/tagnote.esm.js 由 tagnote/build.py 生成，esbuild 把它打进 main.js。
 */
import {
  App, FileView, Keymap, MarkdownView, Menu, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder,
  TextFileView, ViewState, WorkspaceLeaf, parseLinktext,
} from 'obsidian';
import { around } from 'monkey-around';
import TagNote from './vendor/tagnote.esm.js';
import type { TagNoteData, TagNoteInstance, TagNotePrefs, TagNoteWork } from './vendor/tagnote.esm.js';

export const VIEW_TYPE = 'tagnote-view';
const ICON = 'layout-grid';

/* ------------------------------------------------------------------ 数据 */

// 第一个 ```tagnote（或 ~~~tagnote）代码块；兼容 CRLF
const FENCE = /^(`{3,}|~{3,})[ \t]*tagnote[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m;

class NoteDataError extends Error {}

/** 从笔记全文里取出作品集 JSON。读不出来时抛 NoteDataError，消息直接给用户看。 */
export function parseNote(md: string): TagNoteData {
  const m = md.match(FENCE);
  if (!m) throw new NoteDataError('笔记里没有 ```tagnote 代码块。');
  return parseBlock(m[2]);
}

/** 解析代码块正文并检查引擎必需的字段。 */
export function parseBlock(src: string): TagNoteData {
  if (!src.trim()) throw new NoteDataError('```tagnote 代码块是空的。');
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (e) {
    throw new NoteDataError('```tagnote 代码块里的 JSON 格式有错：' + errMsg(e));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NoteDataError('```tagnote 代码块里不是一个 JSON 对象。');
  const works = (data as { works?: unknown }).works;
  if (!Array.isArray(works)) throw new NoteDataError('数据里缺少 works（作品列表）。');
  if (!works.length) throw new NoteDataError('works（作品列表）是空的。');
  works.forEach((w, i) => {
    const ok = w && typeof w === 'object' && typeof w.id === 'string' && w.id && typeof w.title === 'string'
      && Array.isArray(w.tags) && w.tags.every((t: unknown) => typeof t === 'string');
    if (!ok) throw new NoteDataError(`第 ${i + 1} 部作品缺少 id、title 或 tags。`);
  });
  const seen = new Set<string>(), dup = new Set<string>();
  for (const w of works as { id: string }[]) (seen.has(w.id) ? dup : seen).add(w.id);
  if (dup.size) throw new NoteDataError(`作品 id 重复：${[...dup].slice(0, 5).join('、')}${dup.size > 5 ? ` 等 ${dup.size} 个` : ''}。`);
  return data as TagNoteData;
}

function fenceText(md: string) { return md.match(FENCE)?.[2] ?? null; }
function isDark() { return document.body.classList.contains('theme-dark'); }
function themeNow(): 'dark' | 'light' { return isDark() ? 'dark' : 'light'; }
function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

/* ------------------------------------------------------------------ 设置 */

// 字号固定为 1（引擎顶栏没有字号按钮），不存；设置里的 scale 字段读进来时忽略
type GlobalPrefs = Pick<TagNotePrefs, 'cover' | 'color' | 'drawer'>;

interface TagNoteSettings {
  autoOpen: boolean;                   // 打开标签笔记时自动显示六种视图
  prefs: Partial<GlobalPrefs>;         // 封面 / 配色 / 侧栏（所有笔记共用）
  viewByFile: Record<string, string>;  // 每个文件上次看的视图
}
const DEFAULT_SETTINGS: TagNoteSettings = { autoOpen: true, prefs: {}, viewByFile: {} };

function cleanPrefs(p: unknown): Partial<GlobalPrefs> {
  const src = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const out: Partial<GlobalPrefs> = {};
  if (typeof src.cover === 'boolean') out.cover = src.cover;
  if (typeof src.color === 'boolean') out.color = src.color;
  if (typeof src.drawer === 'boolean') out.drawer = src.drawer;
  return out;
}

function isTagNoteFrontmatter(fm: Record<string, unknown> | undefined | null) {
  const v = fm?.tagnote;
  return v === 1 || v === true || v === '1';
}

/* ------------------------------------------------------------------ 视图 */

export class TagNoteView extends TextFileView {
  plugin: TagNotePlugin;
  inst: TagNoteInstance | null = null;
  private shownSource: string | null = null; // 当前画面对应的代码块正文；内容没变就不重画
  private lastPrefs: Partial<TagNotePrefs> = {}; // 本面板上次的偏好：只把这次改了的那一项存成全局偏好
  private resize: ResizeObserver | null = null;  // 量本面板的可视高度，供侧栏最大高度用（见 styles.css）

  constructor(leaf: WorkspaceLeaf, plugin: TagNotePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.requestSave = () => { /* 只读：不保存 */ };
    this.contentEl.addClass('tagnote-view-content');
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? '标签笔记'; }
  getIcon() { return ICON; }

  async onOpen() {
    this.addAction('file-text', '以 Markdown 查看', () => { void this.plugin.openAsMarkdown(this.leaf); });
    // 文件被别的程序改了（例如脚本重新生成）→ 重新读、重画
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f instanceof TFile && f === this.file) void this.reloadFromDisk(f);
    }));
  }

  onPaneMenu(menu: Menu, source: string) {
    menu.addItem((i) => i.setSection('pane').setTitle('以 Markdown 查看').setIcon('file-text')
      .onClick(() => { void this.plugin.openAsMarkdown(this.leaf); }));
    super.onPaneMenu(menu, source);
  }

  // 只读：原样返回读到的文本；save 不写盘
  getViewData() { return this.data; }
  async save(clear?: boolean) { if (clear) this.clear(); }

  setViewData(data: string, clear: boolean) {
    this.data = data;
    if (clear) this.destroyEngine();
    this.renderData();
  }

  clear() { this.destroyEngine(); this.contentEl.empty(); }

  async onUnloadFile(file: TFile) {
    this.destroyEngine();
    await super.onUnloadFile(file);
  }

  async onClose() { this.clear(); }

  applyTheme() { this.inst?.setTheme(themeNow()); }

  destroyEngine() {
    if (this.inst) { try { this.inst.destroy(); } catch (e) { console.error('[tagnote]', e); } }
    this.inst = null;
    this.shownSource = null;
    this.resize?.disconnect();
    this.resize = null;
  }

  private async reloadFromDisk(file: TFile) {
    const text = await this.app.vault.read(file);
    if (file !== this.file || text === this.data) return;
    this.data = text;
    this.renderData();
  }

  /** 把 this.data 画出来：已有引擎就换数据（保留当前视图），否则新挂载；读不出数据就显示原因。 */
  private renderData() {
    const src = fenceText(this.data);
    if (this.inst && src !== null && src === this.shownSource) return;
    let data: TagNoteData;
    try { data = parseNote(this.data); } catch (e) { this.showError(errMsg(e)); return; }

    if (this.inst) {
      try { this.inst.setData(data); this.shownSource = src; return; } catch (e) { console.error('[tagnote]', e); this.destroyEngine(); }
    }
    this.contentEl.empty();
    const host = this.contentEl.createDiv({ cls: 'tagnote-host' });
    // 侧栏最大高度按本面板的可视高度算，不按整个窗口（上面有标签页栏，下面有状态栏；分屏时更矮）
    // 面板变高变矮时窗口不一定变，引擎自己察觉不到，所以写完高度要让它重新给读数区封顶
    const scrollH = () => {
      host.style.setProperty('--tnp-scroll-h', `${this.contentEl.clientHeight}px`);
      this.inst?.fit();
    };
    scrollH();
    this.resize = new ResizeObserver(scrollH);
    this.resize.observe(this.contentEl);
    const s = this.plugin.settings;
    const path = this.file?.path ?? '';
    this.lastPrefs = { cover: true, color: true, drawer: false, ...s.prefs };
    try {
      this.inst = TagNote.mount(host, data, {
        theme: themeNow(),
        prefs: { ...s.prefs, scale: 1, view: s.viewByFile[path] ?? null },
        onPrefsChange: (p) => {
          const before = this.lastPrefs;
          this.lastPrefs = { ...p };
          this.plugin.rememberPrefs(this.file?.path ?? null, p, before);
        },
        onWorkOpen: (w, evt) => { void this.plugin.openWork(w, this.file?.path ?? '', evt); },
      });
      this.shownSource = src;
    } catch (e) {
      console.error('[tagnote]', e);
      this.showError('引擎没能画出这份数据：' + errMsg(e));
    }
  }

  private showError(msg: string) {
    this.destroyEngine();
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: 'tagnote-error' });
    box.createEl('p', { cls: 'tagnote-error-title', text: '这篇笔记的标签笔记数据读不出来。' });
    box.createEl('p', { cls: 'tagnote-error-reason', text: '原因：' + msg });
    const btn = box.createEl('button', { cls: 'mod-cta', text: '以 Markdown 查看' });
    btn.addEventListener('click', () => { void this.plugin.openAsMarkdown(this.leaf); });
  }
}

/* ------------------------------------------------------------------ 插件 */

export default class TagNotePlugin extends Plugin {
  settings: TagNoteSettings = { ...DEFAULT_SETTINGS };
  /** 用户在这个面板里点了“以 Markdown 查看”的文件：同一面板再打开它时不自动切回六种视图 */
  markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
  /** 打开时还没有元数据缓存的面板（刚建的文件）：缓存出来后若是标签笔记再切过去 */
  private pendingLeaves = new Map<WorkspaceLeaf, string>();
  /** Markdown 视图标题栏上的“以六种视图查看”按钮 */
  private mdButtons = new Map<MarkdownView, HTMLElement>();
  private unloading = false;
  private saveTimer: number | null = null;
  private pendingTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new TagNoteView(leaf, this));
    this.patchSetViewState();

    this.registerEvent(this.app.workspace.on('css-change', () => this.forEachView((v) => v.applyTheme())));

    const refresh = () => this.refreshMarkdownButtons();
    this.registerEvent(this.app.workspace.on('layout-change', refresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
    this.registerEvent(this.app.workspace.on('file-open', () => { this.checkPending(); refresh(); }));
    this.registerEvent(this.app.metadataCache.on('changed', () => { this.checkPending(); refresh(); }));
    this.app.workspace.onLayoutReady(refresh);

    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (f) => this.onDelete(f)));

    this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile, _source: string, leaf?: WorkspaceLeaf) => {
      if (!(file instanceof TFile) || !this.isTagNote(file)) return;
      if (leaf?.view instanceof TagNoteView) return; // 视图自己的菜单里已有“以 Markdown 查看”
      menu.addItem((i) => i.setTitle('以六种视图打开').setIcon(ICON).onClick(() => { void this.openAsTagNote(file, leaf); }));
    }));

    this.addCommand({
      id: 'toggle-tagnote-view',
      name: '在标签笔记视图和 Markdown 之间切换',
      checkCallback: (checking) => {
        const tv = this.app.workspace.getActiveViewOfType(TagNoteView);
        if (tv) { if (!checking) void this.openAsMarkdown(tv.leaf); return true; }
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        const f = mv?.file;
        if (!mv || !f || !this.isTagNote(f)) return false;
        if (!checking) void this.openAsTagNote(f, mv.leaf);
        return true;
      },
    });

    // 笔记里的 ```tagnote 代码块（阅读模式、实时预览）：一张小卡片 + “打开六种视图”
    this.registerMarkdownCodeBlockProcessor('tagnote', (src, el, ctx) => {
      const card = el.createDiv({ cls: 'tagnote-embed' });
      let data: TagNoteData;
      try { data = parseBlock(src); } catch (e) {
        card.addClass('is-error');
        card.createDiv({ cls: 'tagnote-embed-title', text: '标签笔记数据读不出来' });
        card.createDiv({ cls: 'tagnote-embed-reason', text: errMsg(e) });
        return;
      }
      const title = String(data.collection?.title || '未命名');
      card.createDiv({ cls: 'tagnote-embed-title', text: `标签笔记 · ${title} · ${data.works.length} 部作品` });
      const btn = card.createEl('button', { cls: 'mod-cta', text: '打开六种视图' });
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.openPathAsTagNote(ctx.sourcePath, el, evt);
      });
    });

    this.addSettingTab(new TagNoteSettingTab(this.app, this));
  }

  onunload() {
    this.unloading = true;
    if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; void this.saveSettings(); }
    this.mdButtons.forEach((btn) => btn.remove());
    this.mdButtons.clear();
    this.pendingLeaves.clear();
    if (this.pendingTimer !== null) { window.clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    // 和 Kanban 一样：卸载时把打开着的标签笔记面板换回 Markdown（换视图时会走 onClose → 销毁引擎）
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (!(v instanceof TagNoteView)) continue;
      v.destroyEngine();
      if (v.file) void leaf.setViewState({ type: 'markdown', state: { file: v.file.path }, popstate: true } as ViewState);
    }
  }

  /* ---------- 打开时直接用六种视图（不闪 Markdown） ---------- */

  private patchSetViewState() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;
    this.register(around(WorkspaceLeaf.prototype, {
      setViewState(next) {
        return function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
          let target = state;
          try { target = plugin.redirect(this, state) ?? state; } catch (e) { console.error('[tagnote]', e); }
          return next.call(this, target, eState);
        };
      },
    }));
  }

  /** 要把 markdown 换成六种视图时返回新的 ViewState，否则返回 null。 */
  redirect(leaf: WorkspaceLeaf, state: ViewState): ViewState | null {
    if (this.unloading || !this.settings.autoOpen || state?.type !== 'markdown') return null;
    const path = state.state?.file;
    if (typeof path !== 'string') return null;
    const chosen = this.markdownLeaves.get(leaf);
    if (chosen === path) return null;                            // 用户在这个面板里选了 Markdown
    if (chosen !== undefined) this.markdownLeaves.delete(leaf);  // 面板换了文件：以后再打开这篇时照常自动切换
    this.pendingLeaves.delete(leaf);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) { this.pendingLeaves.set(leaf, path); return null; }
    if (!isTagNoteFrontmatter(cache.frontmatter)) return null;
    return { ...state, type: VIEW_TYPE };
  }

  /** 打开时还没有元数据的面板：元数据出来、面板也加载完了，若是标签笔记就切到六种视图。 */
  private checkPending(retry = 0) {
    if (this.pendingTimer !== null) { window.clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    let wait = false;
    for (const [leaf, path] of [...this.pendingLeaves]) {
      if (!leaf.view.containerEl.isConnected) { this.pendingLeaves.delete(leaf); continue; } // 面板已关
      // 面板还在加载这篇笔记（WorkspaceLeaf 内部的 working 标志）：这时调 setViewState 会被忽略，稍后再看
      if ((leaf as unknown as { working?: boolean }).working) { wait = true; continue; }
      const v = leaf.view;
      if (!(v instanceof MarkdownView) || v.file?.path !== path) { this.pendingLeaves.delete(leaf); continue; }
      const cache = this.app.metadataCache.getFileCache(v.file);
      if (!cache) continue; // 元数据还没出来，等 metadataCache 的 changed
      this.pendingLeaves.delete(leaf);
      if (this.settings.autoOpen && isTagNoteFrontmatter(cache.frontmatter) && this.markdownLeaves.get(leaf) !== path) {
        void this.openAsTagNote(v.file, leaf);
      }
    }
    if (wait && retry < 40) this.pendingTimer = window.setTimeout(() => { this.pendingTimer = null; this.checkPending(retry + 1); }, 50);
  }

  isTagNote(file: TFile) {
    return file.extension === 'md' && isTagNoteFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  forEachView(fn: (v: TagNoteView) => void) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof TagNoteView) fn(leaf.view);
  }

  async openAsTagNote(file: TFile, leaf?: WorkspaceLeaf | null) {
    const l = leaf ?? this.app.workspace.getLeaf(false);
    this.markdownLeaves.delete(l);
    const same = l.view instanceof FileView && l.view.file === file;
    await l.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true, popstate: same } as ViewState);
  }

  async openAsMarkdown(leaf: WorkspaceLeaf) {
    const f = leaf.view instanceof FileView ? leaf.view.file : null;
    if (!f) return;
    this.markdownLeaves.set(leaf, f.path);
    await leaf.setViewState({ type: 'markdown', state: { file: f.path }, active: true, popstate: true } as ViewState);
  }

  /** 代码块卡片上的按钮：在卡片所在的面板里打开（按住 Ctrl/⌘ 时开新标签页）。 */
  private async openPathAsTagNote(path: string, el: HTMLElement, evt: MouseEvent) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const mod = Keymap.isModEvent(evt);
    let leaf: WorkspaceLeaf | null = null;
    if (mod) leaf = this.app.workspace.getLeaf(mod);
    else this.app.workspace.iterateAllLeaves((l) => { if (!leaf && l.view.containerEl.contains(el)) leaf = l; });
    await this.openAsTagNote(file, leaf);
  }

  /**
   * 双击或 Ctrl/⌘ + 单击作品名。绝不新建笔记：
   * 有 link 且库里有这篇作品笔记 → 在新标签页打开；否则有 subject_id → 打开 Bangumi 条目页；都没有 → 提示“这部作品没有链接”。
   */
  async openWork(w: TagNoteWork, sourcePath: string, evt: MouseEvent) {
    const link = typeof w.link === 'string' ? w.link.trim() : '';
    const dest = link ? this.app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, sourcePath) : null;
    if (dest) {
      const mod = Keymap.isModEvent(evt);
      const leaf = this.app.workspace.getLeaf(mod === 'split' || mod === 'window' ? mod : 'tab');
      await leaf.openFile(dest, { active: true });
      return;
    }
    const sid = String(w.subject_id ?? '').trim();
    if (/^\d+$/.test(sid)) { window.open(`https://bgm.tv/subject/${sid}`); return; }
    new Notice('这部作品没有链接');
  }

  /* ---------- Markdown 视图标题栏的“以六种视图查看”按钮 ---------- */

  refreshMarkdownButtons() {
    if (this.unloading) return;
    const live = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (!(v instanceof MarkdownView)) continue; // 后台还没加载的标签页
      live.add(v);
      const want = !!v.file && this.isTagNote(v.file);
      const btn = this.mdButtons.get(v);
      if (want && !btn) {
        this.mdButtons.set(v, v.addAction(ICON, '以六种视图查看', () => { if (v.file) void this.openAsTagNote(v.file, v.leaf); }));
      } else if (!want && btn) {
        btn.remove();
        this.mdButtons.delete(v);
      }
    }
    for (const v of [...this.mdButtons.keys()]) if (!live.has(v)) this.mdButtons.delete(v);
  }

  /* ---------- 偏好 ---------- */

  /** 引擎报告偏好变化：只把这个面板里真正改了的那几项写进全局偏好（别的面板的旧值不会盖掉它）；视图按文件记。 */
  rememberPrefs(path: string | null, p: TagNotePrefs, before: Partial<TagNotePrefs>) {
    const patch: Record<string, unknown> = {};
    for (const k of ['cover', 'color', 'drawer'] as const) if (p[k] !== before[k]) patch[k] = p[k];
    const prefs = cleanPrefs({ ...this.settings.prefs, ...patch });
    let changed = JSON.stringify(prefs) !== JSON.stringify(this.settings.prefs);
    this.settings.prefs = prefs;
    if (path && p.view && this.settings.viewByFile[path] !== p.view) { this.settings.viewByFile[path] = String(p.view); changed = true; }
    if (changed) this.saveSoon();
  }

  private onRename(f: TAbstractFile, oldPath: string) {
    const map = this.settings.viewByFile;
    let changed = false;
    if (f instanceof TFile && oldPath in map) { map[f.path] = map[oldPath]; delete map[oldPath]; changed = true; }
    if (f instanceof TFolder) {
      for (const k of Object.keys(map)) {
        if (k.startsWith(oldPath + '/')) { map[f.path + k.slice(oldPath.length)] = map[k]; delete map[k]; changed = true; }
      }
    }
    if (changed) this.saveSoon();
  }

  private onDelete(f: TAbstractFile) {
    const map = this.settings.viewByFile;
    let changed = false;
    for (const k of Object.keys(map)) if (k === f.path || k.startsWith(f.path + '/')) { delete map[k]; changed = true; }
    if (changed) this.saveSoon();
  }

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Partial<TagNoteSettings>;
    this.settings = {
      autoOpen: typeof raw.autoOpen === 'boolean' ? raw.autoOpen : DEFAULT_SETTINGS.autoOpen,
      prefs: cleanPrefs(raw.prefs),
      viewByFile: raw.viewByFile && typeof raw.viewByFile === 'object' ? { ...raw.viewByFile } : {},
    };
  }

  private saveSoon() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveSettings(); }, 400);
  }

  async saveSettings() { await this.saveData(this.settings); }
}

class TagNoteSettingTab extends PluginSettingTab {
  plugin: TagNotePlugin;
  constructor(app: App, plugin: TagNotePlugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('自动打开六视图')
      .setDesc('打开 frontmatter 里有 tagnote: 1 的笔记时，直接显示六种视图。关掉后按 Markdown 打开，可以用标题栏按钮或命令切换。')
      .addToggle((t) => t.setValue(this.plugin.settings.autoOpen).onChange(async (v) => {
        this.plugin.settings.autoOpen = v;
        await this.plugin.saveSettings();
      }));
  }
}
