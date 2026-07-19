import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AmbientAudioSystem } from "@/engine/audio/AmbientAudioSystem";
import { WORLD_CONFIG } from "@/engine/config";
import { ScenerySystem } from "@/engine/scenery/ScenerySystem";
import { SkyWildlifeSystem } from "@/engine/scenery/SkyWildlifeSystem";
import { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import type { MapSaveData, TerrainTool, WorldEventHandlers } from "@/engine/types";
import { ModelManager } from "@/engine/models/ModelManager";
import { MODELS_CONFIG } from "@/engine/models/presets";
import { WaterSimulation } from "@/engine/water/WaterSimulation";
import { OceanSystem } from "@/engine/water/OceanSystem";
import { WaterShowcaseScene } from "@/engine/water/WaterShowcaseScene";

const IRRIGATION_UPDATE_INTERVAL = 0.4;
const PIXEL_RATIO_CHECK_INTERVAL = 2_000;
const INTRO_CAMERA_DURATION_MS = 3_000;
const PLAY_HOME_DISTANCE = 210;
const CAMERA_SURFACE_CLEARANCE = 1.2;

type GpuTimerExtension = {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
};

function isWebGL2Context(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): context is WebGL2RenderingContext {
  return "createQuery" in context && "deleteQuery" in context;
}

export class AlpineWorld {
  readonly terrain: TerrainSystem;
  readonly water: WaterSimulation;
  readonly ocean: OceanSystem;
  readonly scenery: ScenerySystem;
  readonly models: ModelManager;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly gpuTimerContext: WebGL2RenderingContext | null;
  private readonly gpuTimerExtension: GpuTimerExtension | null;
  private readonly pendingGpuQueries: WebGLQuery[] = [];
  private readonly gpuQueryPool: WebGLQuery[] = [];
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly waterShowcase: WaterShowcaseScene;
  private readonly skyWildlife: SkyWildlifeSystem;
  private readonly ambientAudio: AmbientAudioSystem;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly brushCursor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private frame = 0;
  private disposed = false;
  private editMode = false;
  private tool: TerrainTool = "orbit";
  private brushRadius: number = WORLD_CONFIG.brush.radius;
  private brushStrength: number = WORLD_CONFIG.brush.strength;
  private irrigationRadius: number = WORLD_CONFIG.water.irrigationRadius;
  private _waterCheckAccum = 0;
  private readonly waterProximity: Uint8Array;
  private waterActive = false;
  private waterPulseRemaining = 0;
  private flowRate = 1;
  private flowDelay = 0.1;
  private editing = false;
  private editedInStroke = false;
  private lastEditTime = 0;
  private lastFrameTime = performance.now();
  private pixelRatioCheckTime = performance.now();
  private maxPixelRatio = 1;
  private renderPixelRatio = 1;
  private statsTime = 0;
  private fps = 60;
  private gpuFrameMs: number | null = null;
  private currentSeed: string;
  private hoverElevation = 0;
  private cursorPoint: THREE.Vector3 | null = null;
  private showcaseActive = false;
  private sourcePlacementActive = false;
  private readonly savedWorldCameraPosition = new THREE.Vector3();
  private readonly savedWorldCameraTarget = new THREE.Vector3();
  private savedWorldCameraZoom = 1;
  private readonly editCameraPosition = new THREE.Vector3();
  private readonly editCameraTarget = new THREE.Vector3();
  private editCameraZoom = 1;
  private readonly playCameraPosition = new THREE.Vector3();
  private readonly playCameraTarget = new THREE.Vector3();
  private playCameraZoom = 1;
  private introCameraActive = false;
  private introCameraStartTime = 0;
  private readonly introCameraStartPosition = new THREE.Vector3();
  private readonly introCameraEndPosition = new THREE.Vector3();
  private readonly introCameraTarget = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    seed: string,
    private readonly handlers: WorldEventHandlers = {},
  ) {
    this.currentSeed = seed;
    this.maxPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    this.renderPixelRatio = this.maxPixelRatio;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    const renderingContext = this.renderer.getContext();
    this.gpuTimerContext = isWebGL2Context(renderingContext) ? renderingContext : null;
    this.gpuTimerExtension = this.gpuTimerContext
      ? this.gpuTimerContext.getExtension("EXT_disjoint_timer_query_webgl2") as GpuTimerExtension | null
      : null;
    this.renderer.setPixelRatio(this.renderPixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.domElement.setAttribute("aria-label", "Interactive low-poly mountain scene");
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      WORLD_CONFIG.camera.fov,
      container.clientWidth / Math.max(1, container.clientHeight),
      WORLD_CONFIG.camera.near,
      WORLD_CONFIG.camera.far,
    );
    this.camera.position.fromArray(WORLD_CONFIG.camera.position);

    this.scene.fog = new THREE.FogExp2("#cbd9d4", 0.0036);
    this.createAtmosphere();
    this.createLighting();
    this.waterShowcase = new WaterShowcaseScene();
    this.terrain = new TerrainSystem(this.scene, seed);
    this.ocean = new OceanSystem(this.scene);
    this.scenery = new ScenerySystem(this.scene, this.terrain, seed);
    this.skyWildlife = new SkyWildlifeSystem(this.scene, this.terrain, seed);
    this.water = new WaterSimulation(this.scene, this.terrain);
    this.waterProximity = new Uint8Array(this.terrain.heights.length);
    this.models = new ModelManager(this.scene, this.terrain, MODELS_CONFIG);
    this.models.attachScenery(this.scenery);
    this.models.initialize().catch((err) => console.warn("Model loading failed:", err));
    this.ambientAudio = new AmbientAudioSystem();
    this.updateIrrigation();
    this.brushCursor = this.createBrushCursor();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.waterSourceViewTarget());
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 850;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.475;
    this.controls.enablePan = true;
    this.controls.update();
    this.editCameraPosition.copy(this.camera.position);
    this.editCameraTarget.copy(this.controls.target);
    this.editCameraZoom = this.camera.zoom;
    this.playCameraPosition.copy(this.camera.position);
    this.playCameraTarget.copy(this.controls.target);
    this.playCameraZoom = this.camera.zoom;
    this.constrainPlayOrbitTarget();
    this.syncControlMode();

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.animate();
    requestAnimationFrame(() => this.handlers.onReady?.());
  }

  setTool(tool: TerrainTool): void {
    this.tool = !this.editMode && this.isEditOnlyTool(tool) ? "orbit" : tool;
    this.brushCursor.visible = false;
    this.syncControlMode();
  }

  setEditMode(enabled: boolean): void {
    if (this.editMode === enabled) {
      this.syncControlMode();
      if (!enabled) this.constrainPlayOrbitTarget();
      return;
    }
    this.finishIntroCameraMove();
    if (enabled) {
      this.playCameraPosition.copy(this.camera.position);
      this.playCameraTarget.copy(this.controls.target);
      this.playCameraZoom = this.camera.zoom;
      this.camera.position.copy(this.editCameraPosition);
      this.controls.target.copy(this.editCameraTarget);
      this.camera.zoom = this.editCameraZoom;
    } else {
      this.finishSourcePlacement();
      this.editCameraPosition.copy(this.camera.position);
      this.editCameraTarget.copy(this.controls.target);
      this.editCameraZoom = this.camera.zoom;
      this.camera.position.copy(this.playCameraPosition);
      this.controls.target.copy(this.playCameraTarget);
      this.camera.zoom = this.playCameraZoom;
    }
    this.editMode = enabled;
    if (!enabled) {
      if (this.isEditOnlyTool(this.tool)) this.setTool("orbit");
    }
    this.camera.updateProjectionMatrix();
    this.syncControlMode();
    this.controls.update();
    if (!enabled) this.constrainPlayOrbitTarget();
  }

  setBrushRadius(radius: number): void {
    if (!this.editMode) return;
    this.brushRadius = THREE.MathUtils.clamp(radius, WORLD_CONFIG.brush.minRadius, WORLD_CONFIG.brush.maxRadius);
    this.brushCursor.scale.setScalar(this.brushRadius);
  }

  setBrushStrength(strength: number): void {
    if (!this.editMode) return;
    this.brushStrength = THREE.MathUtils.clamp(
      strength,
      WORLD_CONFIG.brush.minStrength,
      WORLD_CONFIG.brush.maxStrength,
    );
  }

  setWaterActive(active: boolean): void {
    this.waterActive = active;
  }

  /** Advance loaded water briefly without changing the play UI's paused state. */
  pulseWaterFlow(seconds = 0.1): void {
    this.waterPulseRemaining = Math.max(this.waterPulseRemaining, Math.max(0, seconds));
  }

  setFlowRate(rate: number): void {
    this.flowRate = THREE.MathUtils.clamp(
      rate,
      WORLD_CONFIG.water.minFlowRate,
      WORLD_CONFIG.water.maxFlowRate,
    );
  }

  setIrrigationRadius(radius: number): void {
    if (!this.editMode) return;
    this.irrigationRadius = THREE.MathUtils.clamp(
      radius,
      WORLD_CONFIG.water.minIrrigationRadius,
      WORLD_CONFIG.water.maxIrrigationRadius,
    );
    this.updateIrrigation();
  }

  setFlowDelay(seconds: number): void {
    if (!this.editMode) return;
    this.flowDelay = THREE.MathUtils.clamp(seconds, 0.02, 0.5);
  }

  /** Play the opening dolly from the full valley view toward the water source. */
  startIntroCameraMove(): number {
    if (this.showcaseActive) return 0;
    this.camera.position.fromArray(WORLD_CONFIG.camera.position);
    this.controls.target.copy(this.waterSourceViewTarget());
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.introCameraStartPosition.copy(this.camera.position);
    this.introCameraTarget.copy(this.controls.target);
    this.introCameraEndPosition.copy(
      this.cameraPositionForTarget(this.introCameraTarget, PLAY_HOME_DISTANCE),
    );
    this.introCameraStartTime = performance.now();
    this.introCameraActive = true;
    this.syncControlMode();
    return INTRO_CAMERA_DURATION_MS;
  }

  setShowcaseActive(active: boolean): void {
    if (this.showcaseActive === active) return;
    this.finishIntroCameraMove();
    this.showcaseActive = active;
    this.finishSourcePlacement();
    this.brushCursor.visible = false;
    this.editing = false;
    if (active) {
      this.savedWorldCameraPosition.copy(this.camera.position);
      this.savedWorldCameraTarget.copy(this.controls.target);
      this.savedWorldCameraZoom = this.camera.zoom;
      this.camera.position.set(0, 30, 52);
      this.controls.target.set(0, 2.2, 0);
      this.camera.zoom = 1;
    } else {
      this.camera.position.copy(this.savedWorldCameraPosition);
      this.controls.target.copy(this.savedWorldCameraTarget);
      this.camera.zoom = this.savedWorldCameraZoom;
    }
    this.camera.updateProjectionMatrix();
    this.syncControlMode();
    this.controls.update();
    if (!active && !this.editMode) this.constrainPlayOrbitTarget();
  }

  regenerate(seed: string): void {
    this.finishSourcePlacement();
    this.currentSeed = seed;
    this.terrain.regenerate(seed);
    this.scenery.regenerate(seed);
    this.skyWildlife.regenerate(seed);
    this.water.syncTerrain(false);
    this.water.setSource(this.terrain.sourceIndex);
    this.updateIrrigation();
    // Re-dock models to new terrain surface
    this.models.refreshHeights();
    // Re-apply scenery replacement if configured (placements changed with new seed)
    if (MODELS_CONFIG.replaceTrees?.enabled || MODELS_CONFIG.replaceRocks?.enabled) {
      this.models.clearSceneryReplacement();
      const treePath = MODELS_CONFIG.replaceTrees?.enabled
        ? MODELS_CONFIG.replaceTrees.modelPath
        : undefined;
      const rockPath = MODELS_CONFIG.replaceRocks?.enabled
        ? MODELS_CONFIG.replaceRocks.modelPath
        : undefined;
      this.models.replaceScenery(treePath, rockPath).catch((err) =>
        console.warn("Scenery replacement failed on regenerate:", err),
      );
    }
    this.hoverElevation = 0;
    this.focusHome();
  }

  resetTerrain(): void {
    this.terrain.reset();
    this.scenery.refreshHeights();
    this.models.refreshHeights();
    this.water.syncTerrain(true);
    this.updateIrrigation();
  }

  clearWater(): void {
    this.water.clear();
    this.updateIrrigation();
  }

  get seed(): string {
    return this.currentSeed;
  }

  /** 导出当前地形与水体的完整快照 */
  getSaveState(): MapSaveData {
    return {
      gridWidth: this.terrain.resolutionX,
      gridHeight: this.terrain.resolutionZ,
      verticalScale: WORLD_CONFIG.verticalScale,
      heights: Array.from(this.terrain.heights),
      waterDepths: this.water.getDepthSnapshot(),
      sourceIndex: this.terrain.sourceIndex,
      peakIndex: this.terrain.peakIndex,
      minHeight: this.terrain.minHeight,
      maxHeight: this.terrain.maxHeight,
      seed: this.currentSeed,
      groundPaint: this.terrain.getGroundPaintState(),
      rockPaint: this.terrain.getRockPaintState(),
      rockGroups: this.terrain.getRockGroupState(),
      rockHeightsIntegrated: true,
      modelInstances: this.models.getInstanceData(),
    };
  }

  /** 从快照恢复地形与水体的完整状态 */
  loadSaveState(data: MapSaveData): void {
    this.finishSourcePlacement();
    // Square saves from the previous world layout cannot be indexed safely by
    // the new 336 x 112 rectangular grid. Rebuild the same seed in the new
    // format instead of stretching its old cells or leaving invalid holes.
    if (data.heights.length !== this.terrain.heights.length) {
      this.regenerate(data.seed);
      return;
    }
    this.currentSeed = data.seed;
    // Rebuild the static side scenery from the save's seed first. The active
    // strip is overwritten below by the saved, edited height field.
    this.terrain.regenerate(data.seed);
    const savedVerticalScale = Math.max(0.0001, data.verticalScale ?? 1);
    const migrationScale = WORLD_CONFIG.verticalScale / savedVerticalScale;
    const migratedHeights = new Float32Array(data.heights.length);
    let migratedMinHeight = Number.POSITIVE_INFINITY;
    let migratedMaxHeight = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < data.heights.length; index += 1) {
      const height = WORLD_CONFIG.seaLevel
        + (data.heights[index] - WORLD_CONFIG.seaLevel) * migrationScale;
      migratedHeights[index] = height;
      migratedMinHeight = Math.min(migratedMinHeight, height);
      migratedMaxHeight = Math.max(migratedMaxHeight, height);
    }
    this.terrain.heights = migratedHeights;
    this.terrain.sourceIndex = data.sourceIndex;
    this.terrain.peakIndex = data.peakIndex;
    this.terrain.minHeight = migratedMinHeight;
    this.terrain.maxHeight = migratedMaxHeight;
    // 地形需要通过 regenerate 来重建几何体，但 regenerate 会覆盖 heights。
    // 所以这里直接用 TerrainSystem 的 rebuildGeometry 对应的方案：直接替换 + 重建
    this.terrain["rebuildGeometry"]();
    this.terrain.loadGroundPaintState(data.groundPaint);
    this.terrain.loadRockPaintState(data.rockPaint, data.rockGroups, data.rockHeightsIntegrated);
    this.scenery.regenerate(data.seed);
    this.skyWildlife.regenerate(data.seed);
    // 恢复外部模型（terrain 重建后高度已就绪）
    if (data.modelInstances && data.modelInstances.length > 0) {
      this.models.loadInstanceData(data.modelInstances).catch((err) =>
        console.warn("Model restore failed:", err),
      );
    }
    // 恢复水体
    this.water.restoreDepthSnapshot(data.waterDepths);
    this.updateIrrigation();
    this.focusHome();
  }

  focusHome(): void {
    this.introCameraActive = false;
    if (this.showcaseActive) {
      this.camera.position.set(0, 30, 52);
      this.controls.target.set(0, 2.2, 0);
      this.camera.zoom = 1;
    } else {
      const target = this.waterSourceViewTarget();
      this.camera.position.copy(this.editMode
        ? new THREE.Vector3().fromArray(WORLD_CONFIG.camera.position)
        : this.cameraPositionForTarget(target, PLAY_HOME_DISTANCE));
      this.controls.target.copy(target);
      this.camera.zoom = 1;
      if (this.editMode) {
        this.editCameraPosition.copy(this.camera.position);
        this.editCameraTarget.copy(this.controls.target);
        this.editCameraZoom = this.camera.zoom;
      } else {
        this.playCameraPosition.copy(this.camera.position);
        this.playCameraTarget.copy(this.controls.target);
        this.playCameraZoom = this.camera.zoom;
      }
    }
    this.camera.updateProjectionMatrix();
    this.syncControlMode();
    this.controls.update();
    if (!this.editMode && !this.showcaseActive) this.constrainPlayOrbitTarget();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.onPointerLeave);
    this.renderer.domElement.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.terrain.dispose();
    this.scenery.dispose();
    this.skyWildlife.dispose();
    this.models.dispose();
    this.water.dispose();
    this.ocean.dispose();
    this.waterShowcase.dispose();
    this.ambientAudio.dispose();
    this.brushCursor.geometry.dispose();
    this.brushCursor.material.dispose();
    for (const query of this.pendingGpuQueries) this.gpuTimerContext?.deleteQuery(query);
    for (const query of this.gpuQueryPool) this.gpuTimerContext?.deleteQuery(query);
    this.pendingGpuQueries.length = 0;
    this.gpuQueryPool.length = 0;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private createLighting(): void {
    this.scene.add(new THREE.HemisphereLight("#e7f0ee", "#55605b", 2.15));
    const sun = new THREE.DirectionalLight("#fff3d6", 4.25);
    sun.position.set(-96, 430, 62);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -340;
    sun.shadow.camera.right = 340;
    sun.shadow.camera.top = 340;
    sun.shadow.camera.bottom = -340;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    // 低多边形大平面容易和自身阴影发生深度竞争，形成整片摩尔纹。
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.075;
    sun.shadow.radius = 1.5;
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight("#b8d6dd", 1.3);
    rim.position.set(24, 30, -22);
    this.scene.add(rim);
  }

  private createAtmosphere(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1600, 20, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          topColor: { value: new THREE.Color("#8faea9") },
          horizonColor: { value: new THREE.Color("#dce4dc") },
          bottomColor: { value: new THREE.Color("#eef0e8") },
        },
        vertexShader: `
          varying float vHeight;
          void main() {
            vHeight = normalize(position).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 topColor;
          uniform vec3 horizonColor;
          uniform vec3 bottomColor;
          varying float vHeight;
          void main() {
            float upper = smoothstep(-0.02, 0.72, vHeight);
            float lower = smoothstep(-0.36, 0.02, vHeight);
            vec3 color = mix(bottomColor, horizonColor, lower);
            color = mix(color, topColor, upper);
            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    );
    this.scene.add(sky);

    const base = new THREE.Mesh(
      new THREE.CircleGeometry(560, 64),
      new THREE.MeshStandardMaterial({ color: "#74877d", roughness: 1, flatShading: true }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = WORLD_CONFIG.minHeight - 0.08;
    base.receiveShadow = true;
    this.scene.add(base);
  }

  private createBrushCursor(): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
    const cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 40),
      new THREE.MeshBasicMaterial({
        color: "#d66c4d",
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    cursor.rotation.x = -Math.PI / 2;
    cursor.scale.setScalar(this.brushRadius);
    cursor.renderOrder = 5;
    cursor.visible = false;
    this.scene.add(cursor);
    return cursor;
  }

  private syncControlMode(): void {
    const orbitMode = this.showcaseActive || this.tool === "orbit";
    this.controls.enabled = !this.sourcePlacementActive && !this.introCameraActive;
    this.controls.enablePan = true;
    this.controls.mouseButtons.LEFT = orbitMode ? THREE.MOUSE.ROTATE : (-1 as THREE.MOUSE);
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = -1 as THREE.MOUSE;
    this.controls.touches.ONE = orbitMode ? THREE.TOUCH.ROTATE : (-1 as THREE.TOUCH);
    const colors: Record<TerrainTool, string> = {
      orbit: "#dbe8df",
      carve: "#d66c4d",
      raise: "#6d9a70",
      smooth: "#78aab0",
      "paint-green": "#4f8172",
      "paint-yellow": "#d6bd61",
      "paint-rock": "#68706c",
    };
    this.brushCursor.material.color.set(colors[this.tool]);
    this.renderer.domElement.dataset.tool = this.showcaseActive ? "orbit" : this.tool;
    this.renderer.domElement.dataset.sourcePlacement = this.sourcePlacementActive ? "active" : "idle";
  }

  private waterSourceViewTarget(): THREE.Vector3 {
    const target = this.terrain.indexToWorld(this.terrain.sourceIndex);
    target.y += 2.5;
    return target;
  }

  private cameraPositionForTarget(target: THREE.Vector3, distance: number): THREE.Vector3 {
    const position = new THREE.Vector3().fromArray(WORLD_CONFIG.camera.position);
    const offset = position.sub(target);
    if (offset.lengthSq() < 0.0001) offset.set(1, 0.45, 0.8);
    offset.setLength(Math.min(distance, offset.length()));
    return target.clone().add(offset);
  }

  private finishIntroCameraMove(): void {
    if (!this.introCameraActive) return;
    this.camera.position.copy(this.introCameraEndPosition);
    this.controls.target.copy(this.introCameraTarget);
    this.introCameraActive = false;
    if (this.editMode) {
      this.editCameraPosition.copy(this.camera.position);
      this.editCameraTarget.copy(this.controls.target);
      this.editCameraZoom = this.camera.zoom;
    } else {
      this.playCameraPosition.copy(this.camera.position);
      this.playCameraTarget.copy(this.controls.target);
      this.playCameraZoom = this.camera.zoom;
    }
    this.syncControlMode();
    this.controls.update();
    this.constrainPlayOrbitTarget();
  }

  private updateIntroCamera(time: number): void {
    const progress = THREE.MathUtils.clamp(
      (time - this.introCameraStartTime) / INTRO_CAMERA_DURATION_MS,
      0,
      1,
    );
    const eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) * 0.5;
    this.camera.position.lerpVectors(
      this.introCameraStartPosition,
      this.introCameraEndPosition,
      eased,
    );
    this.controls.target.copy(this.introCameraTarget);
    this.camera.lookAt(this.introCameraTarget);
    if (progress >= 1) this.finishIntroCameraMove();
  }

  /** Keep Play Mode focused on the simulated middle third, not the static side scenery. */
  private constrainPlayOrbitTarget(): void {
    if (this.editMode || this.showcaseActive) return;
    const padding = this.terrain.cellSize;
    const halfLength = WORLD_CONFIG.sizeX * 0.5 - padding;
    const halfPlayableWidth = WORLD_CONFIG.sizeZ * 0.5 - padding;
    const clampedX = THREE.MathUtils.clamp(this.controls.target.x, -halfLength, halfLength);
    const clampedZ = THREE.MathUtils.clamp(
      this.controls.target.z,
      -halfPlayableWidth,
      halfPlayableWidth,
    );
    const correctionX = clampedX - this.controls.target.x;
    const correctionZ = clampedZ - this.controls.target.z;
    if (correctionX === 0 && correctionZ === 0) return;
    this.controls.target.x = clampedX;
    this.controls.target.z = clampedZ;
    // Shift the camera by the same amount so hitting a boundary does not alter
    // the current orbit angle or zoom distance.
    this.camera.position.x += correctionX;
    this.camera.position.z += correctionZ;
  }

  private updatePointer(event: PointerEvent): THREE.Intersection | null {
    if (this.showcaseActive) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersection = this.raycaster.intersectObjects([this.terrain.rockMesh, this.terrain.mesh], false)[0] ?? null;
    if (intersection) {
      this.cursorPoint = intersection.point.clone();
      this.hoverElevation = intersection.point.y;
      if (this.tool !== "orbit" && !this.sourcePlacementActive && (this.editMode || !this.isEditOnlyTool(this.tool))) {
        this.brushCursor.position.copy(intersection.point);
        this.brushCursor.position.y += 0.09;
        this.brushCursor.visible = true;
      }
    }
    return intersection;
  }

  private moveSourceTo(point: THREE.Vector3): void {
    const sourceIndex = this.terrain.indexAt(point.x, point.z);
    this.terrain.sourceIndex = sourceIndex;
    this.water.setSource(sourceIndex);
  }

  private beginSourcePlacement(): void {
    this.sourcePlacementActive = true;
    this.editing = false;
    this.brushCursor.visible = false;
    this.water.setSourceEditing(true);
    this.controls.enabled = false;
    this.handlers.onWaterSourcePlacementChange?.(true);
    this.syncControlMode();
  }

  private finishSourcePlacement(): void {
    if (!this.sourcePlacementActive) return;
    this.sourcePlacementActive = false;
    this.water.setSourceEditing(false);
    this.controls.enabled = true;
    this.handlers.onWaterSourcePlacementChange?.(false);
    this.syncControlMode();
  }

  private applyCurrentBrush(now: number): void {
    if (!this.cursorPoint || now - this.lastEditTime < 28) return;
    const deltaTime = Math.min(0.05, Math.max(0.012, (now - this.lastEditTime) / 1000));
    this.lastEditTime = now;
    const changedIndices = this.terrain.applyBrush(
      this.cursorPoint.x,
      this.cursorPoint.z,
      this.tool,
      this.brushRadius,
      this.brushStrength,
      deltaTime,
      !this.editMode,
    );
    if (changedIndices.length > 0) {
      this.editedInStroke = true;
      if (this.isPaintTool()) {
        this.scenery.updateTreeWatering((x, z) => this.terrain.isGreenAt(x, z));
        if (this.tool === "paint-rock") this.water.syncTerrainDuringStroke(changedIndices);
      } else {
        this.water.syncTerrainDuringStroke(changedIndices);
      }
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 阻止浏览器右键手势（如 Edge 的右键+拖拽=返回）
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.button !== 0 || this.showcaseActive || (!this.editMode && this.isEditOnlyTool(this.tool))) return;
    const hit = this.updatePointer(event);

    if (this.editMode && this.sourcePlacementActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!hit) return;
      this.moveSourceTo(hit.point);
      this.finishSourcePlacement();
      return;
    }

    if (this.editMode) {
      const sourceHit = this.water.raycastSource(this.raycaster);
      if (sourceHit && (!hit || sourceHit.distance <= hit.distance + 0.2)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.beginSourcePlacement();
        return;
      }
    }

    if (this.tool === "orbit") return;
    if (!hit) return;
    event.preventDefault();
    this.editing = true;
    this.editedInStroke = false;
    this.terrain.beginStroke(this.tool);
    this.lastEditTime = performance.now() - 32;
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
    this.applyCurrentBrush(performance.now());
  };

  private onPointerMove = (event: PointerEvent): void => {
    const hit = this.updatePointer(event);
    if (this.sourcePlacementActive && hit) this.moveSourceTo(hit.point);
    if (this.editing) this.applyCurrentBrush(performance.now());
  };

  private onPointerUp = (): void => {
    if (!this.editing) return;
    this.editing = false;
    this.terrain.finishStroke();
    if (this.editedInStroke) {
      if (this.isPaintTool()) {
        this.scenery.updateTreeWatering((x, z) => this.terrain.isGreenAt(x, z));
        if (this.tool === "paint-rock") {
          this.scenery.refreshHeights();
          this.models.refreshHeights();
          this.water.finishTerrainStroke();
        }
      } else {
        this.scenery.refreshHeights();
        this.models.refreshHeights();
        this.water.finishTerrainStroke();
      }
      this.handlers.onTerrainEdit?.();
    }
  };

  private onPointerLeave = (): void => {
    if (!this.editing) this.brushCursor.visible = false;
  };

  private onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private resize(): void {
    const width = this.container.clientWidth;
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private beginGpuFrameTimer(): WebGLQuery | null {
    const extension = this.gpuTimerExtension;
    const gl = this.gpuTimerContext;
    if (!extension || !gl) return null;
    this.resolveGpuFrameTimers(gl, extension);
    if (this.pendingGpuQueries.length >= 4) return null;

    const query = this.gpuQueryPool.pop() ?? gl.createQuery();
    if (!query) return null;
    try {
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      return query;
    } catch {
      gl.deleteQuery(query);
      return null;
    }
  }

  private endGpuFrameTimer(query: WebGLQuery | null): void {
    const gl = this.gpuTimerContext;
    if (!query || !this.gpuTimerExtension || !gl) return;
    try {
      gl.endQuery(this.gpuTimerExtension.TIME_ELAPSED_EXT);
      this.pendingGpuQueries.push(query);
    } catch {
      gl.deleteQuery(query);
    }
  }

  private resolveGpuFrameTimers(gl: WebGL2RenderingContext, extension: GpuTimerExtension): void {
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      for (const query of this.pendingGpuQueries) gl.deleteQuery(query);
      this.pendingGpuQueries.length = 0;
      return;
    }

    while (this.pendingGpuQueries.length > 0) {
      const query = this.pendingGpuQueries[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const elapsedNanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      this.pendingGpuQueries.shift();
      this.gpuQueryPool.push(query);
      const sampleMs = elapsedNanoseconds / 1_000_000;
      if (!Number.isFinite(sampleMs)) continue;
      this.gpuFrameMs = this.gpuFrameMs === null
        ? sampleMs
        : THREE.MathUtils.lerp(this.gpuFrameMs, sampleMs, 0.12);
    }
  }

  private animate = (time = performance.now()): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const frameDeltaTime = Math.max(0, (time - this.lastFrameTime) / 1000);
    const deltaTime = Math.min(0.05, Math.max(0.001, frameDeltaTime));
    this.lastFrameTime = time;
    const instantFps = 1 / deltaTime;
    this.fps = THREE.MathUtils.lerp(this.fps, instantFps, 0.06);
    this.updateAdaptivePixelRatio(time);
    if (this.introCameraActive) this.updateIntroCamera(time);
    else {
      this.controls.update();
      this.constrainPlayOrbitTarget();
    }
    if (!this.showcaseActive) {
      this.ocean.update(time);
      this.resolveCameraSurfaceCollision();
    }
    const audioFocus = this.controls.target;
    this.ambientAudio.update(deltaTime, {
      viewDistance: this.camera.position.distanceTo(audioFocus),
      waterPresence: this.showcaseActive ? 0 : this.waterPresenceNear(audioFocus.x, audioFocus.z),
      forestPresence: this.showcaseActive ? 0 : this.scenery.greenForestPresenceAt(audioFocus.x, audioFocus.z),
    });
    const waterPulseActive = this.waterPulseRemaining > 0;
    if (waterPulseActive) {
      this.waterPulseRemaining = Math.max(0, this.waterPulseRemaining - deltaTime);
    }
    if (!this.showcaseActive && (this.waterActive || waterPulseActive) && !this.sourcePlacementActive) {
      this.water.step(frameDeltaTime, this.flowRate, this.flowDelay);
    }
    if (this.showcaseActive) this.waterShowcase.update(time);
    else {
      this.skyWildlife.update(deltaTime, time);
      this.water.updateMarker(time, this.waterActive);

      // Keep terrain, trees, and tiny ground cover synchronized without doing the work every frame.
      this._waterCheckAccum += deltaTime;
      if (this._waterCheckAccum > IRRIGATION_UPDATE_INTERVAL) {
        const elapsed = this._waterCheckAccum;
        this._waterCheckAccum = 0;
        this.updateIrrigation(elapsed);
      }
    }
    if (this.brushCursor.visible) this.brushCursor.position.y += Math.sin(time * 0.005) * 0.0008;

    if (time - this.statsTime > 250) {
      this.statsTime = time;
      const waterPerformance = this.water.performance;
      this.handlers.onStats?.({
        elevation: this.hoverElevation,
        peak: this.terrain.maxHeight,
        waterVolume: this.water.volume,
        wateredYellowPercent: this.terrain.getWateredYellowPercentage(),
        fps: Math.min(99, Math.round(this.fps)),
        waterPhysicsMs: waterPerformance.physicsMs,
        waterGeometryMs: waterPerformance.geometryMs,
        waterTopologyMs: waterPerformance.topologyMs,
        gpuFrameMs: this.gpuFrameMs,
      });
    }
    const gpuQuery = this.beginGpuFrameTimer();
    try {
      this.renderer.render(this.showcaseActive ? this.waterShowcase.scene : this.scene, this.camera);
    } finally {
      this.endGpuFrameTimer(gpuQuery);
    }
  };

  /** Keep GPU cost stable by adjusting only the internal render resolution. */
  private updateAdaptivePixelRatio(time: number): void {
    if (time - this.pixelRatioCheckTime < PIXEL_RATIO_CHECK_INTERVAL) return;
    this.pixelRatioCheckTime = time;
    let nextPixelRatio = this.renderPixelRatio;
    if (this.fps < 48) nextPixelRatio -= 0.15;
    else if (this.fps > 57) nextPixelRatio += 0.1;
    nextPixelRatio = THREE.MathUtils.clamp(nextPixelRatio, 1, this.maxPixelRatio);
    nextPixelRatio = Math.round(nextPixelRatio * 20) / 20;
    if (Math.abs(nextPixelRatio - this.renderPixelRatio) < 0.001) return;
    this.renderPixelRatio = nextPixelRatio;
    this.renderer.setPixelRatio(this.renderPixelRatio);
  }

  private resolveCameraSurfaceCollision(): void {
    const { x, y, z } = this.camera.position;
    const terrainHalfX = WORLD_CONFIG.sizeX * 0.5;
    const terrainHalfZ = WORLD_CONFIG.sizeZ * 0.5;
    let surfaceHeight = Number.NEGATIVE_INFINITY;

    if (Math.abs(x) <= terrainHalfX && Math.abs(z) <= terrainHalfZ) {
      surfaceHeight = this.terrain.surfaceHeightAt(x, z);
    }

    const oceanHeight = this.ocean.surfaceHeightAt(x, z);
    if (oceanHeight !== null) surfaceHeight = Math.max(surfaceHeight, oceanHeight);
    if (!Number.isFinite(surfaceHeight)) return;

    const minimumCameraY = surfaceHeight + CAMERA_SURFACE_CLEARANCE;
    if (y < minimumCameraY) {
      this.camera.position.y = minimumCameraY;
      this.camera.lookAt(this.controls.target);
    }
  }

  private updateIrrigation(elapsedSeconds = IRRIGATION_UPDATE_INTERVAL): void {
    this.water.fillProximityMask(this.waterProximity, this.irrigationRadius);
    this.terrain.updateWateredArea(this.waterProximity);
    this.scenery.updateTreeWatering((x, z) => this.terrain.isGreenAt(x, z));
    this.scenery.updateGroundCoverWatering(
      (x, z) => this.terrain.isWateredAt(x, z),
      (x, z) => this.water.depthAt(x, z),
      elapsedSeconds,
    );
  }

  private waterPresenceNear(worldX: number, worldZ: number): number {
    let strongest = 0;
    const samples: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 1],
      [1.4, 0, 0.9], [-1.4, 0, 0.9], [0, 1.4, 0.9], [0, -1.4, 0.9],
      [3.2, 0, 0.7], [-3.2, 0, 0.7], [0, 3.2, 0.7], [0, -3.2, 0.7],
      [2.3, 2.3, 0.72], [-2.3, 2.3, 0.72], [2.3, -2.3, 0.72], [-2.3, -2.3, 0.72],
    ];
    for (const [offsetX, offsetZ, distanceWeight] of samples) {
      const depth = this.water.depthAt(worldX + offsetX, worldZ + offsetZ);
      const audibleDepth = THREE.MathUtils.smoothstep(depth, 0.002, 0.035);
      strongest = Math.max(strongest, audibleDepth * distanceWeight);
    }
    return strongest;
  }

  private isPaintTool(): boolean {
    return this.isEditOnlyTool(this.tool);
  }

  private isEditOnlyTool(tool: TerrainTool): boolean {
    return tool === "paint-green" || tool === "paint-yellow" || tool === "paint-rock";
  }
}
