"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Blend,
  Check,
  Download,
  Droplets,
  Eraser,
  Focus,
  Hand,
  Info,
  MapPin,
  Mountain,
  Pickaxe,
  RefreshCw,
  Save,
  Sparkles,
  TrendingUp,
  Trash2,
  Undo2,
  Upload,
  Waves,
  X,
} from "lucide-react";
import type { MapSaveData, SavedMapMeta, TerrainTool, WorldStats } from "@/engine/types";
import type { AlpineWorld } from "@/engine/world/AlpineWorld";

const SAVES_KEY = "alpineflowlab:saves";
const SAVES_DATA_PREFIX = "alpineflowlab:save-data:";
const FEATURED_SAVE_ID = "featured-map";
const FEATURED_SAVE_URL = "/maps/featured-map.json";

type FeaturedSave = {
  data: MapSaveData;
  meta: SavedMapMeta;
};

function parseSavesMeta(): SavedMapMeta[] {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persistSavesMeta(list: SavedMapMeta[]): void {
  localStorage.setItem(SAVES_KEY, JSON.stringify(list));
}

function persistSaveData(id: string, data: MapSaveData): void {
  localStorage.setItem(SAVES_DATA_PREFIX + id, JSON.stringify(data));
}

function loadSaveData(id: string): MapSaveData | null {
  try {
    const raw = localStorage.getItem(SAVES_DATA_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as MapSaveData;
  } catch {
    return null;
  }
}

function loadLatestSaveData(): MapSaveData | null {
  const newestFirst = [...parseSavesMeta()].sort((left, right) => right.createdAt - left.createdAt);
  for (const save of newestFirst) {
    const data = loadSaveData(save.id);
    if (data) return data;
  }
  return null;
}

function deleteSaveData(id: string): void {
  localStorage.removeItem(SAVES_DATA_PREFIX + id);
}

async function loadFeaturedSave(): Promise<FeaturedSave | null> {
  try {
    const response = await fetch(FEATURED_SAVE_URL);
    if (!response.ok) return null;
    const data = await response.json() as MapSaveData;
    if (!data.seed || !Array.isArray(data.heights) || data.heights.length === 0) return null;
    let peakHeight = Number.NEGATIVE_INFINITY;
    for (const height of data.heights) peakHeight = Math.max(peakHeight, height);
    return {
      data,
      meta: {
        id: FEATURED_SAVE_ID,
        name: "NIVAL-385 · 内置展示地图",
        createdAt: 0,
        seed: data.seed,
        peakHeight,
      },
    };
  } catch {
    return null;
  }
}

const seedNames = ["NIVAL", "MORAINE", "CIRQUE", "ARÊTE", "ALPENGLOW", "TALUS"];
const initialStats: WorldStats = { elevation: 0, peak: 0, waterVolume: 0, wateredYellowPercent: 0, fps: 60 };

const toolOptions: Array<{
  id: TerrainTool;
  label: string;
  hint: string;
  shortcut: string;
  icon: typeof Hand;
}> = [
  { id: "orbit", label: "观察", hint: "旋转镜头", shortcut: "O", icon: Hand },
  { id: "carve", label: "下切", hint: "雕刻谷地", shortcut: "D", icon: Pickaxe },
  { id: "raise", label: "抬升", hint: "堆起山体", shortcut: "B", icon: TrendingUp },
  { id: "smooth", label: "平滑", hint: "修整坡面", shortcut: "S", icon: Blend },
  { id: "paint-green", label: "青化", hint: "永久刷成青绿色地面", shortcut: "G", icon: Droplets },
  { id: "paint-yellow", label: "黄化", hint: "刷回会响应水流的黄色地面", shortcut: "Y", icon: Eraser },
];

function createSeed(): string {
  const name = seedNames[Math.floor(Math.random() * seedNames.length)];
  const digits = Math.floor(100 + Math.random() * 899);
  return `${name}-${digits}`;
}

export function AlpineFlowLab() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<AlpineWorld | null>(null);
  const [seed, setSeed] = useState("NIVAL-042");
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showSaves, setShowSaves] = useState(false);
  const [mode, setMode] = useState<"edit" | "play">("edit");
  const [tool, setTool] = useState<TerrainTool>("orbit");
  const [brushRadius, setBrushRadius] = useState(3.2);
  const [brushStrength, setBrushStrength] = useState(5.4);
  const [waterActive, setWaterActive] = useState(false);
  const [flowRate, setFlowRate] = useState(1);
  const [irrigationRadius, setIrrigationRadius] = useState(3);
  const [flowDelay, setFlowDelay] = useState(0.1);
  const [showcaseActive, setShowcaseActive] = useState(false);
  const [placingWaterSource, setPlacingWaterSource] = useState(false);
  const [stats, setStats] = useState<WorldStats>(initialStats);
  // Keep the server HTML and the client's first render identical. Saved maps
  // are browser-local and can only be loaded after hydration completes.
  const [saves, setSaves] = useState<SavedMapMeta[]>([]);
  const [featuredSave, setFeaturedSave] = useState<FeaturedSave | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveMessage, setSaveMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);
  const editMode = mode === "edit";
  const displayedSaves = featuredSave ? [featuredSave.meta, ...saves] : saves;
  const toggleMode = useCallback(() => {
    if (editMode) setTool("orbit");
    setMode(editMode ? "play" : "edit");
  }, [editMode]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSaves(parseSavesMeta()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let active = true;
    let world: AlpineWorld | null = null;

    async function mountWorld() {
      if (!hostRef.current) return;
      try {
        const localSave = loadLatestSaveData();
        const loadedFeaturedSave = await loadFeaturedSave();
        if (active) setFeaturedSave(loadedFeaturedSave);
        const initialSave = localSave ?? loadedFeaturedSave?.data ?? null;
        const initialSeed = initialSave?.seed ?? seed;
        const worldModule = await import("@/engine/world/AlpineWorld");
        if (!active || !hostRef.current) return;
        world = new worldModule.AlpineWorld(hostRef.current, initialSeed, {
          onReady: () => {
            if (!active || !world) return;
            if (initialSave) {
              world.loadSaveState(initialSave);
              setSeed(initialSave.seed);
            }
            worldRef.current = world;
            setStats((current) => ({ ...current, peak: world?.terrain.maxHeight ?? 0 }));
            setReady(true);
          },
          onStats: (nextStats) => active && setStats(nextStats),
          onWaterSourcePlacementChange: (placing) => active && setPlacingWaterSource(placing),
        });
      } catch (error) {
        console.warn("Alpine Flow Lab requires WebGL.", error);
        if (active) {
          setRenderError(true);
          setReady(true);
        }
      }
    }

    void mountWorld();
    return () => {
      active = false;
      worldRef.current = null;
      world?.dispose();
    };
    // The world owns seed changes after initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => worldRef.current?.setTool(tool), [tool]);
  useEffect(() => worldRef.current?.setBrushRadius(brushRadius), [brushRadius]);
  useEffect(() => worldRef.current?.setBrushStrength(brushStrength), [brushStrength]);
  useEffect(() => worldRef.current?.setWaterActive(waterActive), [waterActive]);
  useEffect(() => worldRef.current?.setFlowRate(flowRate), [flowRate]);
  useEffect(() => worldRef.current?.setIrrigationRadius(irrigationRadius), [irrigationRadius]);
  useEffect(() => {
    if (ready) worldRef.current?.setEditMode(editMode);
  }, [editMode, ready]);
  useEffect(() => worldRef.current?.setFlowDelay(flowDelay), [flowDelay]);
  useEffect(() => worldRef.current?.setShowcaseActive(showcaseActive), [showcaseActive]);

  // Prevent browser context menu & right-click gestures across the entire page
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) event.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const key = event.key.toLowerCase();
      if (key === "m") {
        toggleMode();
        return;
      }
      const shortcuts: Record<string, TerrainTool> = {
        o: "orbit",
        d: "carve",
        b: "raise",
        s: "smooth",
        g: "paint-green",
        y: "paint-yellow",
      };
      const nextTool = editMode ? shortcuts[key] : undefined;
      if (nextTool) setTool(nextTool);
      if (event.code === "Space") {
        event.preventDefault();
        setWaterActive((active) => !active);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, toggleMode]);

  const showSaveMessage = useCallback((text: string, type: "ok" | "error" = "ok") => {
    setSaveMessage({ text, type });
    setTimeout(() => setSaveMessage(null), 2000);
  }, []);

  const handleSave = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const data = world.getSaveState();
    const id = `map_${Date.now()}`;
    const name = saveName.trim() || `地图 ${new Date().toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    const meta: SavedMapMeta = {
      id,
      name,
      createdAt: Date.now(),
      seed: world.seed,
      peakHeight: world.terrain.maxHeight,
    };
    persistSaveData(id, data);
    const next = [...saves, meta];
    persistSavesMeta(next);
    setSaves(next);
    setSaveName("");
    showSaveMessage(`已保存「${name}」`);
  }, [saveName, saves, showSaveMessage]);

  const handleExportCurrent = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const blob = new Blob([JSON.stringify(world.getSaveState())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "alpine-flow-featured-map.json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showSaveMessage("已导出当前地图");
  }, [showSaveMessage]);

  const handleLoad = useCallback((id: string) => {
    const data = id === FEATURED_SAVE_ID ? featuredSave?.data ?? null : loadSaveData(id);
    if (!data) {
      showSaveMessage("无法加载：数据可能已损坏", "error");
      return;
    }
    worldRef.current?.loadSaveState(data);
    setSeed(data.seed);
    if (worldRef.current) {
      setStats((current) => ({
        ...current,
        peak: worldRef.current?.terrain.maxHeight ?? current.peak,
        waterVolume: worldRef.current?.water.volume ?? 0,
      }));
    }
    const meta = id === FEATURED_SAVE_ID ? featuredSave?.meta : saves.find((s) => s.id === id);
    showSaveMessage(meta ? `已加载「${meta.name}」` : "已加载地图");
    setShowSaves(false);
  }, [featuredSave, saves, showSaveMessage]);

  const handleDelete = useCallback((id: string) => {
    deleteSaveData(id);
    const next = saves.filter((s) => s.id !== id);
    persistSavesMeta(next);
    setSaves(next);
  }, [saves]);

  const regenerate = useCallback(() => {
    const nextSeed = createSeed();
    setSeed(nextSeed);
    worldRef.current?.regenerate(nextSeed);
    if (worldRef.current) {
      setStats((current) => ({ ...current, peak: worldRef.current?.terrain.maxHeight ?? current.peak, waterVolume: 0 }));
    }
  }, []);

  const resetTerrain = useCallback(() => worldRef.current?.resetTerrain(), []);
  const clearWater = useCallback(() => worldRef.current?.clearWater(), []);
  const toggleShowcase = useCallback(() => {
    setShowcaseActive((active) => {
      const next = !active;
      if (next) setTool("orbit");
      return next;
    });
  }, []);

  return (
    <main className="lab-shell" id="top">
      <div ref={hostRef} className="world-canvas" />
      {renderError && <FallbackMountain />}
      <div className="atmosphere-grain" aria-hidden="true" />

      {placingWaterSource && (
        <div className="source-placement-tip" role="status">
          <MapPin size={14} /> 移动鼠标调整水源，再点击地面放置
        </div>
      )}

      <header className="topbar glass-panel">
        <a className="brand" href="#top" aria-label="Alpine Flow Lab 首页">
          <span className="brand-mark"><Mountain size={17} strokeWidth={1.8} /></span>
          <span>
            <strong>ALPINE / FLOW</strong>
            <small>PROCEDURAL TERRAIN STUDY · 01</small>
          </span>
        </a>
        <div className="topbar-actions">
          {!showcaseActive && (
            <button
              className={`mode-toggle ${editMode ? "is-edit" : "is-play"}`}
              onClick={toggleMode}
              aria-label={`切换到${editMode ? "游玩" : "编辑"}模式`}
              title="按 M 切换模式"
            >
              <i />{editMode ? "编辑模式" : "游玩模式"}<small>M</small>
            </button>
          )}
          <span className="seed-chip"><i />{showcaseActive ? "WATER TEST RANGE" : <>SEED&nbsp; {seed}</>}</span>
          <button
            className={`scene-mode-button ${showcaseActive ? "is-active" : ""}`}
            onClick={toggleShowcase}
            aria-pressed={showcaseActive}
          >
            <Waves size={15} />
            <span>{showcaseActive ? "返回模拟场景" : "水体测试场"}</span>
          </button>
          <button className="icon-button" onClick={() => worldRef.current?.focusHome()} aria-label="返回最佳视角" title="返回最佳视角">
            <Focus size={17} />
          </button>
          <button className="icon-button" onClick={() => setShowNotes(true)} aria-label="查看操作说明" title="操作说明">
            <Info size={17} />
          </button>
        </div>
      </header>

      {editMode && !showcaseActive && (
        <button className="regenerate-fab" onClick={regenerate} disabled={renderError} aria-label="重新生成山脉" title="重新生成">
          <RefreshCw size={18} />
        </button>
      )}

      {!showcaseActive && <aside className="terrain-readout glass-panel" aria-label="地形与水流数据">
        <div className="readout-heading">
          <span><Sparkles size={15} /> LIVE PROFILE</span>
          <b>{stats.fps} FPS</b>
        </div>
        <dl>
          <div><dt>主峰高度</dt><dd>{stats.peak.toFixed(1)}<small> km*</small></dd></div>
          <div><dt>指针海拔</dt><dd>{stats.elevation.toFixed(1)}<small> km*</small></dd></div>
          <div><dt>地表水量</dt><dd>{stats.waterVolume.toFixed(1)}<small> m³*</small></dd></div>
          <div><dt>黄色地面水染率</dt><dd>{stats.wateredYellowPercent.toFixed(1)}<small> %</small></dd></div>
        </dl>
        <div className="altitude-key" aria-label="高度着色图例">
          <span className="key-snow">雪线</span>
          <span className="key-rock">裸岩</span>
          <span className="key-pine">林线</span>
          <span className="key-valley">谷地</span>
        </div>

        <section className="flow-controls" aria-label="融水控制">
          <div className="flow-title">
            <span><Droplets size={14} /> GLACIER MELT</span>
            <button
              className={`flow-switch ${waterActive ? "is-on" : ""}`}
              onClick={() => setWaterActive((active) => !active)}
              role="switch"
              aria-checked={waterActive}
              disabled={renderError}
            ><i /></button>
          </div>
          <label>
            <span>流量 <b>{flowRate.toFixed(1)}×</b></span>
            <input type="range" min="0.2" max="10" step="0.1" value={flowRate} onChange={(event) => setFlowRate(Number(event.target.value))} disabled={renderError} />
          </label>
          {editMode && (
            <label>
              <span>润泽范围 <b>{irrigationRadius.toFixed(1)}</b></span>
              <input type="range" min="0.5" max="8" step="0.1" value={irrigationRadius} onChange={(event) => setIrrigationRadius(Number(event.target.value))} disabled={renderError} />
            </label>
          )}
          <label>
            <span>流速 <b>{flowDelay.toFixed(2)} 秒/格</b></span>
            <input
              type="range"
              min="0.02"
              max="0.5"
              step="0.01"
              value={flowDelay}
              onChange={(event) => setFlowDelay(Number(event.target.value))}
              disabled={renderError}
              aria-label="水流每格停留时间"
            />
          </label>
          <div className={`panel-actions ${editMode ? "" : "single"}`}>
            <button onClick={clearWater} disabled={renderError}><Eraser size={13} /> 清空水体</button>
            {editMode && <button onClick={resetTerrain} disabled={renderError}><Undo2 size={13} /> 还原地形</button>}
          </div>
          <div className="flow-title save-title">
            <span><Save size={14} /> MAP SAVE</span>
            <button
              className="save-panel-toggle"
              onClick={() => setShowSaves((v) => !v)}
              disabled={renderError}
            ><MapPin size={14} /> {displayedSaves.length} 份存档</button>
          </div>
          <div className="save-row">
            <input
              className="save-name-input"
              type="text"
              placeholder="存档名称（可选）"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              disabled={renderError}
              maxLength={30}
            />
            <button className="save-button" onClick={handleSave} disabled={renderError}>
              <Download size={13} /> 保存
            </button>
            <button className="save-button" onClick={handleExportCurrent} disabled={renderError || !ready}>
              <Upload size={13} /> 导出当前
            </button>
          </div>
          {saveMessage && (
            <p className={`save-message ${saveMessage.type === "error" ? "save-error" : ""}`}>
              {saveMessage.type === "ok" ? <Check size={12} /> : <X size={12} />}
              {saveMessage.text}
            </p>
          )}
        </section>
        <p className="scale-note">* 艺术化模拟单位，用于比较相对变化</p>
      </aside>}

      {editMode && !showcaseActive && <nav className="tool-dock glass-panel" aria-label="地形工具">
        <div className="tool-group">
          {toolOptions.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                className={`tool-button ${tool === option.id ? "is-active" : ""}`}
                onClick={() => setTool(option.id)}
                title={`${option.hint} (${option.shortcut})`}
                aria-pressed={tool === option.id}
                disabled={renderError}
              >
                <Icon size={16} />
                <span>{option.label}<small>{option.shortcut}</small></span>
              </button>
            );
          })}
        </div>
        <div className="dock-divider" />
        <div className="brush-sliders">
          <label>
            <span>范围 <b>{brushRadius.toFixed(1)}</b></span>
            <input type="range" min="1.2" max="8" step="0.1" value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} disabled={renderError} />
          </label>
          <label>
            <span>力度 <b>{brushStrength.toFixed(1)}</b></span>
            <input type="range" min="1" max="10" step="0.2" value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} disabled={renderError} />
          </label>
        </div>
        <button className={`water-quick ${waterActive ? "is-on" : ""}`} onClick={() => setWaterActive((active) => !active)} disabled={renderError} aria-label={waterActive ? "暂停水流" : "开启水流"}>
          <Waves size={17} /><span>{waterActive ? "水流中" : "开启水流"}<small>SPACE</small></span>
        </button>
      </nav>}

      {!showcaseActive && <div className="scene-index" aria-hidden="true">
        <span>46° 48′ N</span><i /><span>{editMode ? "EDIT MODE" : "PLAY MODE"}</span><i /><span>{waterActive ? "MELT ACTIVE" : "MELT PAUSED"}</span>
      </div>}

      {showcaseActive && (
        <section className="showcase-guide glass-panel" aria-label="水体测试场图例">
          <div><b>01 河流</b><span>细曲线浪脊沿流向伸展</span></div>
          <div><b>02 湖泊</b><span>有体积的方向波与局部小浪</span></div>
          <div><b>03 瀑布</b><span>窄水纹、水幕与落点白沫</span></div>
        </section>
      )}

      {!ready && (
        <div className="loading-screen">
          <div className="loading-mark"><Mountain size={24} /></div>
          <p>正在抬升山脊</p>
          <span />
        </div>
      )}

      {renderError && (
        <p className="render-warning">当前预览环境未启用 WebGL；请在支持 WebGL 的现代浏览器中打开以体验交互山体。</p>
      )}

      {showNotes && (
        <div className="notes-backdrop" role="presentation" onMouseDown={() => setShowNotes(false)}>
          <section className="notes-panel" role="dialog" aria-modal="true" aria-labelledby="notes-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="notes-close" onClick={() => setShowNotes(false)} aria-label="关闭"><X size={18} /></button>
            <p className="eyebrow"><span>SYS</span> SYSTEM & CONTROLS</p>
            <h2 id="notes-title">一套可以继续生长的山脉系统</h2>
            <ol>
              <li><b>分区地貌</b><span>左侧高山、低丘平原、噪声海岸与海床都由种子生成，五层 ridged noise 雕刻峰面。</span></li>
              <li><b>地形工具</b><span>选择下切、抬升或平滑，直接在山体上拖动；中键始终旋转镜头。</span></li>
              <li><b>动态融水</b><span>青色晶体是冰川水源；编辑模式下点击晶体，移动鼠标后再次点击即可放置。水面依据相邻高度守恒交换，并响应地形改动。</span></li>
              <li><b>模式切换</b><span>按 M 在编辑与游玩模式之间切换；游玩模式会隐藏全部地形编辑功能。</span></li>
              <li><b>快捷操作</b><span>编辑模式下 O / D / B / S / G / Y 切换工具，Space 开关水流，中键旋转视角。</span></li>
            </ol>
          </section>
        </div>
      )}

      {showSaves && (
        <div className="notes-backdrop" role="presentation" onMouseDown={() => setShowSaves(false)}>
          <section className="saves-panel notes-panel" role="dialog" aria-modal="true" aria-labelledby="saves-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="notes-close" onClick={() => setShowSaves(false)} aria-label="关闭"><X size={18} /></button>
            <p className="eyebrow"><span>MAP</span> SAVED MAPS</p>
            <h2 id="saves-title">已保存的地图</h2>
            {displayedSaves.length === 0 ? (
              <p className="saves-empty">还没有保存地图。使用画笔修改地形后，点击「保存」即可创建第一份存档。</p>
            ) : (
              <ul className="saves-list">
                {displayedSaves.map((save) => {
                  const isFeatured = save.id === FEATURED_SAVE_ID;
                  return (
                    <li key={save.id} className={`saves-item ${isFeatured ? "is-featured" : ""}`}>
                      <div className="saves-item-info">
                        <strong>{save.name}{isFeatured && <small className="saves-badge">网页默认</small>}</strong>
                        <span>
                          SEED {save.seed} · 主峰 {save.peakHeight.toFixed(1)} km
                          {isFeatured ? " · 项目内置存档" : ` · ${new Date(save.createdAt).toLocaleString("zh-CN")}`}
                        </span>
                      </div>
                      <div className="saves-item-actions">
                        <button className="icon-button saves-load" onClick={() => handleLoad(save.id)} title="加载此存档">
                          <Upload size={15} />
                        </button>
                        {!isFeatured && (
                          <button className="icon-button saves-delete" onClick={() => handleDelete(save.id)} title="删除此存档">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function FallbackMountain() {
  return (
    <div className="fallback-mountain" aria-hidden="true">
      <i className="fallback-sun" />
      <span className="mountain-back" />
      <span className="mountain-mid" />
      <span className="mountain-front" />
      <span className="mountain-snow" />
      <span className="fallback-ground" />
    </div>
  );
}
