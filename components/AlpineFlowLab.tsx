"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Blend,
  BookOpen,
  Check,
  Download,
  Droplets,
  Eraser,
  Focus,
  Hand,
  MapPin,
  Mountain,
  PanelRightClose,
  PanelRightOpen,
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
import { WORLD_CONFIG } from "@/engine/config";

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
        name: "NIVAL-385 · Featured Map",
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
const initialStats: WorldStats = {
  elevation: 0,
  peak: 0,
  waterVolume: 0,
  wateredYellowPercent: 0,
  fps: 60,
  waterPhysicsMs: 0,
  waterGeometryMs: 0,
  waterTopologyMs: 0,
  gpuFrameMs: null,
};

const toolOptions: Array<{
  id: TerrainTool;
  label: string;
  hint: string;
  shortcut: string;
  icon: typeof Hand;
}> = [
  { id: "orbit", label: "Orbit", hint: "Rotate the camera", shortcut: "O", icon: Hand },
  { id: "carve", label: "Carve", hint: "Cut a channel", shortcut: "D", icon: Pickaxe },
  { id: "raise", label: "Raise", hint: "Build up terrain", shortcut: "B", icon: TrendingUp },
  { id: "smooth", label: "Smooth", hint: "Soften the slope", shortcut: "S", icon: Blend },
  { id: "paint-green", label: "Green", hint: "Paint permanent cyan-green ground", shortcut: "G", icon: Droplets },
  { id: "paint-yellow", label: "Yellow", hint: "Restore water-responsive yellow ground", shortcut: "Y", icon: Eraser },
  { id: "paint-rock", label: "Stone", hint: "Turn each stroke into one low-poly boulder", shortcut: "R", icon: Mountain },
];

const editOnlyTools = new Set<TerrainTool>(["paint-green", "paint-yellow", "paint-rock"]);

function createSeed(): string {
  const name = seedNames[Math.floor(Math.random() * seedNames.length)];
  const digits = Math.floor(100 + Math.random() * 899);
  return `${name}-${digits}`;
}

export function AlpineFlowLab() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<AlpineWorld | null>(null);
  const coverDismissTimerRef = useRef<number | null>(null);
  const tutorialTimerRef = useRef<number | null>(null);
  const introRequestedRef = useRef(false);
  const [seed, setSeed] = useState("NIVAL-042");
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [showCover, setShowCover] = useState(true);
  const [coverClosing, setCoverClosing] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showSaves, setShowSaves] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [mode, setMode] = useState<"edit" | "play">("play");
  const [tool, setTool] = useState<TerrainTool>("orbit");
  const [brushRadius, setBrushRadius] = useState<number>(WORLD_CONFIG.brush.radius);
  const [brushStrength, setBrushStrength] = useState<number>(WORLD_CONFIG.brush.strength);
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
  const wateredProgress = Math.max(0, Math.min(100, stats.wateredYellowPercent));
  const toggleMode = useCallback(() => {
    if (editMode) setTool("orbit");
    setMode(editMode ? "play" : "edit");
  }, [editMode]);

  const scheduleTutorial = useCallback((delayMs: number) => {
    if (tutorialTimerRef.current !== null) window.clearTimeout(tutorialTimerRef.current);
    tutorialTimerRef.current = window.setTimeout(() => {
      setShowTutorial(true);
      tutorialTimerRef.current = null;
    }, delayMs);
  }, []);

  const startCoverCameraMove = useCallback(() => {
    introRequestedRef.current = true;
    const world = worldRef.current;
    world?.pulseWaterFlow(0.1);
    const duration = world?.startIntroCameraMove();
    if (duration !== undefined) scheduleTutorial(duration + 180);
    else if (renderError) scheduleTutorial(500);
  }, [renderError, scheduleTutorial]);

  const dismissCover = useCallback(() => {
    if (coverClosing) return;
    setCoverClosing(true);
    startCoverCameraMove();
    coverDismissTimerRef.current = window.setTimeout(() => {
      setShowCover(false);
      setCoverClosing(false);
      coverDismissTimerRef.current = null;
    }, 460);
  }, [coverClosing, startCoverCameraMove]);

  useEffect(() => () => {
    if (coverDismissTimerRef.current !== null) {
      window.clearTimeout(coverDismissTimerRef.current);
    }
    if (tutorialTimerRef.current !== null) window.clearTimeout(tutorialTimerRef.current);
  }, []);

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
            if (introRequestedRef.current) {
              world.pulseWaterFlow(0.1);
              scheduleTutorial(world.startIntroCameraMove() + 180);
            }
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
          if (introRequestedRef.current) scheduleTutorial(500);
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
      if (showcaseActive) return;
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
        r: "paint-rock",
      };
      const requestedTool = shortcuts[key];
      const nextTool = requestedTool && (editMode || !editOnlyTools.has(requestedTool)) ? requestedTool : undefined;
      if (nextTool) setTool(nextTool);
      if (event.code === "Space") {
        event.preventDefault();
        setWaterActive((active) => !active);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode, showcaseActive, toggleMode]);

  const showSaveMessage = useCallback((text: string, type: "ok" | "error" = "ok") => {
    setSaveMessage({ text, type });
    setTimeout(() => setSaveMessage(null), 2000);
  }, []);

  const handleSave = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const data = world.getSaveState();
    const id = `map_${Date.now()}`;
    const name = saveName.trim() || `Map ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
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
    showSaveMessage(`Saved “${name}”`);
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
    showSaveMessage("Current map exported");
  }, [showSaveMessage]);

  const handleLoad = useCallback((id: string) => {
    const data = id === FEATURED_SAVE_ID ? featuredSave?.data ?? null : loadSaveData(id);
    if (!data) {
      showSaveMessage("Could not load: the map data may be damaged", "error");
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
    showSaveMessage(meta ? `Loaded “${meta.name}”` : "Map loaded");
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

      {showCover && (
        <button
          type="button"
          className={`title-cover ${coverClosing ? "is-closing" : ""}`}
          onClick={dismissCover}
          aria-label="Enter FLOW"
        >
          <FallbackMountain className="title-cover-mountain" />
          <span className="title-cover-kicker">A LANDSCAPE SHAPED BY WATER</span>
          <span className="title-cover-word">FLOW</span>
          <span className="title-cover-current" aria-hidden="true"><i /></span>
          <span className="title-cover-prompt">CLICK ANYWHERE TO BEGIN</span>
        </button>
      )}

      {!showcaseActive && (
        <div
          className="watered-progress"
          role="progressbar"
          aria-label="Dry ground restored by water"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Number(wateredProgress.toFixed(1))}
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(65, 132, 99, .94) 0%, rgba(65, 132, 99, .94) ${wateredProgress}%, rgba(255, 255, 255, .34) ${wateredProgress}%, rgba(255, 255, 255, .34) 100%)`,
          }}
        >
          {wateredProgress.toFixed(1)}%
        </div>
      )}

      {placingWaterSource && (
        <div className="source-placement-tip" role="status">
          <MapPin size={14} /> Move the pointer to position the source, then click the ground to place it
        </div>
      )}

      <header className="topbar glass-panel">
        <a className="brand" href="#top" aria-label="Alpine Flow Lab home">
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
              aria-label={`Switch to ${editMode ? "play" : "edit"} mode`}
              title="Press M to switch modes"
            >
              <i />{editMode ? "EDIT MODE" : "PLAY MODE"}<small>M</small>
            </button>
          )}
          <span className="seed-chip"><i />{showcaseActive ? "WATER TEST RANGE" : <>SEED&nbsp; {seed}</>}</span>
          <button
            className={`scene-mode-button ${showcaseActive ? "is-active" : ""}`}
            onClick={toggleShowcase}
            aria-pressed={showcaseActive}
          >
            <Waves size={15} />
            <span>{showcaseActive ? "BACK TO SIMULATION" : "WATER SHOWCASE"}</span>
          </button>
          <button className="icon-button" onClick={() => worldRef.current?.focusHome()} aria-label="Return to the best view" title="Reset view">
            <Focus size={17} />
          </button>
          <button className="icon-button" onClick={() => setShowTutorial(true)} aria-label="Open play tutorial" title="Play tutorial">
            <BookOpen size={17} />
          </button>
        </div>
      </header>

      {editMode && !showcaseActive && (
        <button className="regenerate-fab" onClick={regenerate} disabled={renderError} aria-label="Generate a new mountain" title="Generate new mountain">
          <RefreshCw size={18} />
        </button>
      )}

      {!showcaseActive && <aside className={`terrain-readout glass-panel ${rightPanelCollapsed ? "is-collapsed" : ""}`} aria-label="Terrain and water data">
        {rightPanelCollapsed ? (
          <button
            className="readout-expand-button"
            onClick={() => setRightPanelCollapsed(false)}
            aria-label="Expand terrain and water panel"
            title="Expand panel"
          >
            <PanelRightOpen size={18} />
          </button>
        ) : <>
        <div className="readout-heading">
          <span><Sparkles size={15} /> LIVE PROFILE</span>
          <span className="readout-heading-actions">
            <b>{stats.fps} FPS</b>
            <button
              className="readout-collapse-button"
              onClick={() => setRightPanelCollapsed(true)}
              aria-label="Collapse terrain and water panel"
              title="Collapse panel"
            >
              <PanelRightClose size={15} />
            </button>
          </span>
        </div>
        <dl>
          <div><dt>PEAK HEIGHT</dt><dd>{stats.peak.toFixed(1)}<small> km*</small></dd></div>
          <div><dt>CURSOR ELEVATION</dt><dd>{stats.elevation.toFixed(1)}<small> km*</small></dd></div>
          <div><dt>SURFACE WATER</dt><dd>{stats.waterVolume.toFixed(1)}<small> m³*</small></dd></div>
        </dl>
        <div className="performance-grid" aria-label="Water performance timings">
          <span><small>PHYSICS</small><b>{stats.waterPhysicsMs.toFixed(2)} ms</b></span>
          <span><small>GEOMETRY</small><b>{stats.waterGeometryMs.toFixed(2)} ms</b></span>
          <span><small>TOPOLOGY</small><b>{stats.waterTopologyMs.toFixed(2)} ms</b></span>
          <span><small>GPU FRAME</small><b>{stats.gpuFrameMs === null ? "N/A" : `${stats.gpuFrameMs.toFixed(2)} ms`}</b></span>
        </div>
        <div className="altitude-key" aria-label="Elevation color key">
          <span className="key-snow">SNOW LINE</span>
          <span className="key-rock">BARE ROCK</span>
          <span className="key-pine">TREE LINE</span>
          <span className="key-valley">VALLEY</span>
        </div>

        <section className="flow-controls" aria-label="Meltwater controls">
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
            <span>FLOW RATE <b>{flowRate.toFixed(1)}×</b></span>
            <input type="range" min="0.2" max="10" step="0.1" value={flowRate} onChange={(event) => setFlowRate(Number(event.target.value))} disabled={renderError} />
          </label>
          {editMode && (
            <label>
              <span>WATERING RANGE <b>{irrigationRadius.toFixed(1)}</b></span>
              <input type="range" min="0.5" max="8" step="0.1" value={irrigationRadius} onChange={(event) => setIrrigationRadius(Number(event.target.value))} disabled={renderError} />
            </label>
          )}
          {editMode && (
            <label>
              <span>FLOW SPEED <b>{flowDelay.toFixed(2)} s/cell</b></span>
              <input
                type="range"
                min="0.02"
                max="0.5"
                step="0.01"
                value={flowDelay}
                onChange={(event) => setFlowDelay(Number(event.target.value))}
                disabled={renderError}
                aria-label="Water dwell time per cell"
              />
            </label>
          )}
          <div className={`panel-actions ${editMode ? "" : "single"}`}>
            <button onClick={clearWater} disabled={renderError}><Eraser size={13} /> CLEAR WATER</button>
            {editMode && <button onClick={resetTerrain} disabled={renderError}><Undo2 size={13} /> RESTORE TERRAIN</button>}
          </div>
          <div className="flow-title save-title">
            <span><Save size={14} /> MAP SAVE</span>
            <button
              className="save-panel-toggle"
              onClick={() => setShowSaves((v) => !v)}
              disabled={renderError}
            ><MapPin size={14} /> {displayedSaves.length} {displayedSaves.length === 1 ? "SAVE" : "SAVES"}</button>
          </div>
          <div className="save-row">
            <input
              className="save-name-input"
              type="text"
              placeholder="Save name (optional)"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              disabled={renderError}
              maxLength={30}
            />
            <button className="save-button" onClick={handleSave} disabled={renderError}>
              <Download size={13} /> SAVE
            </button>
            <button className="save-button" onClick={handleExportCurrent} disabled={renderError || !ready}>
              <Upload size={13} /> EXPORT CURRENT
            </button>
          </div>
          {saveMessage && (
            <p className={`save-message ${saveMessage.type === "error" ? "save-error" : ""}`}>
              {saveMessage.type === "ok" ? <Check size={12} /> : <X size={12} />}
              {saveMessage.text}
            </p>
          )}
        </section>
        <p className="scale-note">* Stylized simulation units for comparing relative change</p>
        </>}
      </aside>}

      {!showcaseActive && <nav className={`tool-dock glass-panel ${editMode ? "" : "is-play"}`} aria-label="Terrain tools">
        <div className="tool-group">
          {toolOptions.filter((option) => editMode || !editOnlyTools.has(option.id)).map((option) => {
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
        {editMode && <div className="dock-divider" />}
        {editMode && (
          <div className="brush-sliders">
            <label>
              <span>SIZE <b>{brushRadius.toFixed(1)}</b></span>
              <input type="range" min={WORLD_CONFIG.brush.minRadius} max={WORLD_CONFIG.brush.maxRadius} step="0.1" value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} disabled={renderError} />
            </label>
            <label>
              <span>STRENGTH <b>{brushStrength.toFixed(1)}</b></span>
              <input type="range" min={WORLD_CONFIG.brush.minStrength} max={WORLD_CONFIG.brush.maxStrength} step="0.2" value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} disabled={renderError} />
            </label>
          </div>
        )}
        <button className={`water-quick ${waterActive ? "is-on" : ""}`} onClick={() => setWaterActive((active) => !active)} disabled={renderError} aria-label={waterActive ? "Pause water flow" : "Start water flow"}>
          <Waves size={17} /><span>{waterActive ? "FLOWING" : "START FLOW"}<small>SPACE</small></span>
        </button>
      </nav>}

      {!showcaseActive && <div className="scene-index" aria-hidden="true">
        <span>46° 48′ N</span><i /><span>{editMode ? "EDIT MODE" : "PLAY MODE"}</span><i /><span>{waterActive ? "MELT ACTIVE" : "MELT PAUSED"}</span>
      </div>}

      {showcaseActive && (
        <section className="showcase-guide glass-panel" aria-label="Water showcase key">
          <div><b>01 RIVER</b><span>Fine curved wave ridges stretch with the current</span></div>
          <div><b>02 LAKE</b><span>Directional body waves with localized ripples</span></div>
          <div><b>03 WATERFALL</b><span>Narrow water lines, falling sheets, and impact foam</span></div>
        </section>
      )}

      {!ready && (
        <div className="loading-screen">
          <div className="loading-mark"><Mountain size={24} /></div>
          <p>RAISING THE RIDGELINE</p>
          <span />
        </div>
      )}

      {renderError && (
        <p className="render-warning">WebGL is unavailable in this preview. Open the project in a modern WebGL-enabled browser to explore the interactive mountain.</p>
      )}

      {showTutorial && (
        <div className="notes-backdrop" role="presentation" onMouseDown={() => setShowTutorial(false)}>
          <section className="notes-panel tutorial-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="notes-close" onClick={() => setShowTutorial(false)} aria-label="Close tutorial"><X size={18} /></button>
            <p className="eyebrow"><span>PLAY</span> QUICK TUTORIAL</p>
            <h2 id="tutorial-title">Follow the water</h2>
            <p className="tutorial-intro">Find the source, shape a path, and let the mountain flow.</p>
            <ol>
              <li className="tutorial-goal"><b>YOUR GOAL</b><span>Lead the mountain’s water toward the thirsty yellow earth. With every patch that turns green, the valley quietly returns to life.</span></li>
              <li><b>FIND THE SOURCE</b><span>Water begins at the marker high on the mountain.</span></li>
              <li><b>EXPLORE</b><span>Drag <kbd>MIDDLE MOUSE</kbd> to orbit, add <kbd>SHIFT</kbd> to move, and scroll to zoom.</span></li>
              <li><b>SHAPE A PATH</b><span>Use <kbd>D</kbd> Carve, <kbd>B</kbd> Raise, or <kbd>S</kbd> Smooth, then drag across the terrain.</span></li>
              <li><b>LET IT FLOW</b><span>Press <kbd>SPACE</kbd> to start or pause the water.</span></li>
            </ol>
          </section>
        </div>
      )}

      {showSaves && (
        <div className="notes-backdrop" role="presentation" onMouseDown={() => setShowSaves(false)}>
          <section className="saves-panel notes-panel" role="dialog" aria-modal="true" aria-labelledby="saves-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="notes-close" onClick={() => setShowSaves(false)} aria-label="Close saved maps"><X size={18} /></button>
            <p className="eyebrow"><span>MAP</span> SAVED MAPS</p>
            <h2 id="saves-title">Saved maps</h2>
            {displayedSaves.length === 0 ? (
              <p className="saves-empty">No maps have been saved yet. Shape the terrain, then select Save to create your first one.</p>
            ) : (
              <ul className="saves-list">
                {displayedSaves.map((save) => {
                  const isFeatured = save.id === FEATURED_SAVE_ID;
                  return (
                    <li key={save.id} className={`saves-item ${isFeatured ? "is-featured" : ""}`}>
                      <div className="saves-item-info">
                        <strong>{save.name}{isFeatured && <small className="saves-badge">DEFAULT</small>}</strong>
                        <span>
                          SEED {save.seed} · PEAK {save.peakHeight.toFixed(1)} km
                          {isFeatured ? " · BUILT-IN MAP" : ` · ${new Date(save.createdAt).toLocaleString("en-US")}`}
                        </span>
                      </div>
                      <div className="saves-item-actions">
                        <button className="icon-button saves-load" onClick={() => handleLoad(save.id)} title="Load this map">
                          <Upload size={15} />
                        </button>
                        {!isFeatured && (
                          <button className="icon-button saves-delete" onClick={() => handleDelete(save.id)} title="Delete this map">
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

function FallbackMountain({ className = "" }: { className?: string }) {
  return (
    <span className={`fallback-mountain ${className}`.trim()} aria-hidden="true">
      <i className="fallback-sun" />
      <span className="mountain-back" />
      <span className="mountain-mid" />
      <span className="mountain-front" />
      <span className="mountain-snow" />
      <span className="fallback-ground" />
    </span>
  );
}
