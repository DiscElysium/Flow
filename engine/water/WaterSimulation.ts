import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

const FLOW_DELAY = 0.1; // 新流入的水需要经过0.1秒才能流出的时间窗口

export class WaterSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly resolution = WORLD_CONFIG.segments + 1;
  private readonly depth = new Float32Array(this.resolution * this.resolution);
  private readonly delta = new Float32Array(this.depth.length);
  private readonly previousTerrain = new Float32Array(this.depth.length);
  /**
   * 每个格子"最近0.1秒内流入的水量"（深度，不是绝对高度）。
   * 按指数衰减，只有 recentInflow 之外的水才能流出。
   * 这样持续有流入的地方，旧水仍然可以流出，只有新到的那部分被锁定。
   */
  private readonly recentInflow = new Float32Array(this.depth.length);
  private readonly depthAttribute: THREE.BufferAttribute;
  private readonly marker = new THREE.Group();
  private sourceIndex = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
  ) {
    const geometry = this.createGeometry();
    this.depthAttribute = geometry.getAttribute("aDepth") as THREE.BufferAttribute;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        // ── 颜色（三阶渐变：浅 → 中 → 深）──
        shallowColor:       { value: new THREE.Color("#47b5c7") },   // 水晶蓝
        midColor:           { value: new THREE.Color("#258f9e") },   // 中间过渡色 — 碧蓝
        deepColor:          { value: new THREE.Color("#051f42") },   // 深海蓝（纯蓝，零绿）
        sunColor:           { value: new THREE.Color("#fff4d9") },
        uSpecularColor:     { value: new THREE.Color("#fff8e8") },
        uFoamColor:         { value: new THREE.Color("#e8f4f0") },

        // ── 深度阈值（三阶过渡）──
        uShallowDepth:      { value: 0.05 },   // 浅→中 过渡起点 (m)
        uMidDepth:          { value: 1.20 },   // 浅→中 过渡终点 / 中→深 过渡起点 (m)
        uDeepDepth:         { value: 3.50 },   // 中→深 过渡终点 (m)
        uFoamThreshold:     { value: 0.04 },   // 泡沫最大深度
        uFoamFadeStart:     { value: 0.008 },  // 泡沫开始淡入深度

        // ── 光照与高光 ──
        uSunDirection:      { value: new THREE.Vector3(-0.4796, 0.7848, 0.3924) },
        uAmbientFloor:      { value: 0.58 },
        uDiffuseRange:      { value: 0.42 },
        uSpecularPower:     { value: 180.0 },
        uSpecularStrength:  { value: 0.78 },

        // ── 波纹 ──
        uTime:              { value: 0.0 },
        uRippleStrength:    { value: 0.042 },
        uShallowRippleBoost:{ value: 0.65 },

        // ── Fresnel ──
        uFresnelPower:      { value: 2.2 },
        uFresnelMix:        { value: 0.28 },

        // ── Alpha ──
        uAlphaFloor:        { value: 0.52 },
        uAlphaDepthRange:   { value: 0.38 },
        uAlphaFresnel:      { value: 0.12 },
        uDiscardDepth:      { value: 0.004 },
      },
      vertexShader: `
        attribute float aDepth;
        varying float vDepth;
        varying vec3 vWorldPosition;
        void main() {
          vDepth = aDepth;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 shallowColor;
        uniform vec3 midColor;
        uniform vec3 deepColor;
        uniform vec3 sunColor;
        uniform vec3 uSpecularColor;
        uniform vec3 uFoamColor;
        uniform float uShallowDepth;
        uniform float uMidDepth;
        uniform float uDeepDepth;
        uniform float uFoamThreshold;
        uniform float uFoamFadeStart;
        uniform vec3 uSunDirection;
        uniform float uAmbientFloor;
        uniform float uDiffuseRange;
        uniform float uSpecularPower;
        uniform float uSpecularStrength;
        uniform float uTime;
        uniform float uRippleStrength;
        uniform float uShallowRippleBoost;
        uniform float uFresnelPower;
        uniform float uFresnelMix;
        uniform float uAlphaFloor;
        uniform float uAlphaDepthRange;
        uniform float uAlphaFresnel;
        uniform float uDiscardDepth;

        varying float vDepth;
        varying vec3 vWorldPosition;

        void main() {
          if (vDepth < uDiscardDepth) discard;

          // ── 几何法线（屏幕空间导数）──
          vec3 dx = dFdx(vWorldPosition);
          vec3 dy = dFdy(vWorldPosition);
          vec3 normal = normalize(cross(dx, dy));
          if (normal.y < 0.0) normal *= -1.0;
          vec3 T = normalize(dx);
          vec3 B = normalize(dy);

          // ── 程序化水面波纹（3 层叠加）──
          float t = uTime;
          float waveX  = sin(vWorldPosition.x * 14.0 + t * 2.2) * cos(vWorldPosition.z * 9.5 - t * 1.6) * 0.45;
          waveX      += sin(vWorldPosition.x * 23.0 - t * 3.1) * cos(vWorldPosition.z * 18.0 + t * 2.7) * 0.28;
          waveX      += sin(vWorldPosition.x * 37.0 + vWorldPosition.z * 31.0 + t * 4.3) * 0.15;
          float waveZ  = cos(vWorldPosition.x * 10.5 + t * 1.9) * sin(vWorldPosition.z * 13.0 - t * 2.4) * 0.45;
          waveZ      += cos(vWorldPosition.x * 19.0 - t * 2.8) * sin(vWorldPosition.z * 25.0 + t * 3.5) * 0.28;
          waveZ      += cos(vWorldPosition.x * 33.0 - vWorldPosition.z * 29.0 + t * 4.1) * 0.15;

          // 浅水区波纹增强：depth 越小 ripple 越大，模拟浅滩激流
          float shallowBoost = 1.0 + (1.0 - smoothstep(0.0, 0.35, vDepth)) * uShallowRippleBoost;
          float rippleAmp = uRippleStrength * shallowBoost;
          vec3 perturbedNormal = normalize(normal + T * waveX * rippleAmp + B * waveZ * rippleAmp);

          // ── 视角方向 ──
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);

          // ── Lambertian 漫反射 ──
          float NdotL = max(dot(perturbedNormal, uSunDirection), 0.0);
          float diffuse = uAmbientFloor + NdotL * uDiffuseRange;

          // ── Blinn-Phong 高光 ──
          vec3 halfVec = normalize(viewDirection + uSunDirection);
          float specular = pow(max(dot(perturbedNormal, halfVec), 0.0), uSpecularPower);
          specular *= uSpecularStrength;

          // ── Fresnel 边缘光 ──
          float fresnel = pow(1.0 - max(dot(perturbedNormal, viewDirection), 0.0), uFresnelPower);
          float specFresnel = 0.25 + fresnel * 0.75;
          vec3 specularContrib = uSpecularColor * specular * specFresnel;

          // ── 深度颜色混合（三阶渐变：浅→中→深）──
          float midMix = smoothstep(uShallowDepth, uMidDepth, vDepth);
          float deepMix = smoothstep(uMidDepth, uDeepDepth, vDepth);
          vec3 waterColor = mix(shallowColor, midColor, midMix);
          waterColor = mix(waterColor, deepColor, deepMix);
          vec3 color = waterColor * diffuse + specularContrib;

          // ── 岸边泡沫 ──
          float foamAmount = 1.0 - smoothstep(uFoamFadeStart, uFoamThreshold, vDepth);
          foamAmount *= 0.72;
          // 波纹在浅水区域增加泡沫碎花感
          float rippleFoam = abs(waveX + waveZ) * 0.18 * foamAmount;
          color = mix(color, uFoamColor, foamAmount + rippleFoam);

          // ── Fresnel 暖光边缘 ──
          color = mix(color, sunColor, fresnel * uFresnelMix);

          // ── Alpha（随深度整体增加，最深水最不透明）──
          float depthAlpha = smoothstep(uShallowDepth, uDeepDepth, vDepth);
          float alpha = uAlphaFloor + depthAlpha * uAlphaDepthRange + fresnel * uAlphaFresnel;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "water-surface";
    this.mesh.renderOrder = 3;
    this.scene.add(this.mesh);

    this.previousTerrain.set(this.terrain.heights);
    this.createSourceMarker();
    this.setSource(this.terrain.sourceIndex);
    this.updateGeometry();
  }

  step(deltaTime: number, flowRate: number): void {
    const safeDelta = Math.min(deltaTime, 0.045);
    const subDelta = safeDelta / WORLD_CONFIG.water.substeps;

    // ── 指数衰减 recentInflow，解锁随时间的旧流入水量 ──
    // decay = e^(-dt / 0.1)：每0.1秒约63%的锁定水被解锁
    const decay = Math.exp(-safeDelta / FLOW_DELAY);
    for (let i = 0; i < this.recentInflow.length; i += 1) {
      this.recentInflow[i] *= decay;
    }

    for (let pass = 0; pass < WORLD_CONFIG.water.substeps; pass += 1) {
      // 源头注入
      const sourceAdded = WORLD_CONFIG.water.sourceRate * flowRate * subDelta;
      this.depth[this.sourceIndex] += sourceAdded;
      // 源头的水是"新"的 → 加入 recentInflow
      this.recentInflow[this.sourceIndex] += sourceAdded;

      this.delta.fill(0);
      for (let z = 0; z < this.resolution; z += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          const index = z * this.resolution + x;
          if (x < this.resolution - 1) this.exchange(index, index + 1);
          if (z < this.resolution - 1) this.exchange(index, index + this.resolution);
        }
      }
      for (let i = 0; i < this.depth.length; i += 1) {
        const edge = i < this.resolution || i >= this.depth.length - this.resolution || i % this.resolution === 0 || i % this.resolution === this.resolution - 1;
        const drainage = edge && this.terrain.heights[i] < 0.35 ? 0.992 : 1;
        this.depth[i] = Math.max(
          0,
          (this.depth[i] + this.delta[i] - WORLD_CONFIG.water.evaporation * subDelta) * drainage,
        );
        // recentInflow 不能超过实际水量（蒸发可能让实际水量比锁定量更少）
        if (this.recentInflow[i] > this.depth[i]) this.recentInflow[i] = this.depth[i];
      }
    }
    this.updateGeometry();
  }

  /** 暴露 ShaderMaterial 以便外部实时调参与调试 */
  get waterMaterial(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  clear(): void {
    this.depth.fill(0);
    this.recentInflow.fill(0);
    this.updateGeometry();
  }

  syncTerrain(preserveSurface = true): void {
    if (preserveSurface) {
      for (let i = 0; i < this.depth.length; i += 1) {
        const terrainDelta = this.terrain.heights[i] - this.previousTerrain[i];
        if (terrainDelta > 0.0001) {
          // 地形上升：挤出该位置的水，避免水嵌入山体
          this.depth[i] = Math.max(0, this.depth[i] - terrainDelta);
        }
        // 地形下降：不凭空生成水，水只能从源头流过来
        if (this.depth[i] < 0.0003) this.depth[i] = 0;
      }
    } else {
      this.depth.fill(0);
      this.recentInflow.fill(0);
    }
    this.previousTerrain.set(this.terrain.heights);
    this.updateGeometry();
    this.setSource(this.terrain.sourceIndex);
  }

  setSource(index: number): void {
    this.sourceIndex = index;
    const position = this.terrain.indexToWorld(index);
    this.marker.position.set(position.x, position.y + 0.62, position.z);
  }

  updateMarker(time: number, active: boolean): void {
    // 始终更新波纹时间（即使水流暂停，水面仍有微动）
    this.mesh.material.uniforms.uTime.value = time * 0.001;
    const pulse = 1 + Math.sin(time * 0.004) * 0.1;
    this.marker.scale.setScalar(active ? pulse : 0.88);
    this.marker.rotation.y = time * 0.00035;
    const core = this.marker.getObjectByName("source-core") as THREE.Mesh | undefined;
    if (core && core.material instanceof THREE.MeshStandardMaterial) {
      core.material.emissiveIntensity = active ? 1.25 + Math.sin(time * 0.006) * 0.25 : 0.32;
    }
  }

  /** 查询任意世界坐标的水深（双线性插值），供外部系统查询 */
  depthAt(worldX: number, worldZ: number): number {
    const half = WORLD_CONFIG.size / 2;
    const fx = (worldX + half) / this.terrain.cellSize;
    const fz = (worldZ + half) / this.terrain.cellSize;
    const x0 = Math.max(0, Math.min(this.resolution - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(this.resolution - 2, Math.floor(fz)));
    const tx = fx - x0;
    const tz = fz - z0;
    const idx = (z0: number, x0: number) => z0 * this.resolution + x0;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.depth[idx(z0, x0)], this.depth[idx(z0, x0 + 1)], tx),
      THREE.MathUtils.lerp(this.depth[idx(z0 + 1, x0)], this.depth[idx(z0 + 1, x0 + 1)], tx),
      tz,
    );
  }

  /** Mark every terrain vertex within `radius` world units of visible water. */
  fillProximityMask(target: Uint8Array, radius: number): void {
    if (target.length !== this.depth.length) return;
    target.fill(0);

    const radiusInCells = Math.ceil(radius / this.terrain.cellSize);
    const radiusSquared = radius * radius;
    for (let waterIndex = 0; waterIndex < this.depth.length; waterIndex += 1) {
      if (this.depth[waterIndex] < 0.004) continue;
      const waterX = waterIndex % this.resolution;
      const waterZ = Math.floor(waterIndex / this.resolution);

      for (let dz = -radiusInCells; dz <= radiusInCells; dz += 1) {
        const z = waterZ + dz;
        if (z < 0 || z >= this.resolution) continue;
        for (let dx = -radiusInCells; dx <= radiusInCells; dx += 1) {
          const x = waterX + dx;
          if (x < 0 || x >= this.resolution) continue;
          const distanceSquared = (dx * dx + dz * dz) * this.terrain.cellSize * this.terrain.cellSize;
          if (distanceSquared <= radiusSquared) target[z * this.resolution + x] = 1;
        }
      }
    }
  }

  get volume(): number {
    let sum = 0;
    for (let i = 0; i < this.depth.length; i += 1) sum += this.depth[i];
    return sum * this.terrain.cellSize * this.terrain.cellSize;
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.marker);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.marker.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      }
    });
  }

  /**
   * 相邻两格之间的水量交换。
   * 只有"旧水"（超出 recentInflow 的部分）才能流出；
   * 刚流入的水被锁定 0.1 秒，之后随指数衰减逐步解锁。
   */
  private exchange(a: number, b: number): void {
    const surfaceA = this.terrain.heights[a] + this.depth[a];
    const surfaceB = this.terrain.heights[b] + this.depth[b];
    const difference = surfaceA - surfaceB;
    if (Math.abs(difference) < 0.0003) return;

    if (difference > 0 && this.depth[a] > 0.0001) {
      // 只有"旧水"可以流出
      const locked = Math.min(this.recentInflow[a], this.depth[a]);
      const available = this.depth[a] - locked;
      if (available < 0.0001) return;
      const amount = Math.min(available * 0.18, difference * WORLD_CONFIG.water.flow);
      if (amount < 0.0001) return;
      this.delta[a] -= amount;
      this.delta[b] += amount;
      // 流入目标格的水标记为"新到的"
      this.recentInflow[b] += amount;
    } else if (difference < 0 && this.depth[b] > 0.0001) {
      const locked = Math.min(this.recentInflow[b], this.depth[b]);
      const available = this.depth[b] - locked;
      if (available < 0.0001) return;
      const amount = Math.min(available * 0.18, -difference * WORLD_CONFIG.water.flow);
      if (amount < 0.0001) return;
      this.delta[b] -= amount;
      this.delta[a] += amount;
      this.recentInflow[a] += amount;
    }
  }

  private createGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array(this.depth.length * 3);
    const depthValues = new Float32Array(this.depth.length);
    const indices: number[] = [];
    const half = WORLD_CONFIG.size / 2;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = z * this.resolution + x;
        positions[index * 3] = x * this.terrain.cellSize - half;
        positions[index * 3 + 1] = this.terrain.heights[index] - 0.06;
        positions[index * 3 + 2] = z * this.terrain.cellSize - half;
      }
    }
    for (let z = 0; z < WORLD_CONFIG.segments; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segments; x += 1) {
        const a = z * this.resolution + x;
        const b = a + 1;
        const c = a + this.resolution;
        const d = c + 1;
        if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aDepth", new THREE.BufferAttribute(depthValues, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  private updateGeometry(): void {
    const position = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.depth.length; i += 1) {
      position.setY(i, this.depth[i] > 0.003 ? this.terrain.heights[i] + this.depth[i] + 0.025 : this.terrain.heights[i] - 0.08);
      this.depthAttribute.setX(i, this.depth[i]);
    }
    position.needsUpdate = true;
    this.depthAttribute.needsUpdate = true;
  }

  private createSourceMarker(): void {
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({
        color: "#b8efeb",
        emissive: "#3fc8ca",
        emissiveIntensity: 0.5,
        roughness: 0.24,
        metalness: 0.05,
      }),
    );
    core.name = "source-core";
    core.castShadow = true;
    this.marker.add(core);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.48, 0.54, 24),
      new THREE.MeshBasicMaterial({ color: "#8de1df", transparent: true, opacity: 0.48, side: THREE.DoubleSide }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.36;
    this.marker.add(halo);
    this.scene.add(this.marker);
  }
}
