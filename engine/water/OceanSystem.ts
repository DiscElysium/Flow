import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";

/** Procedural open water that begins beyond the generated beach. */
export class OceanSystem {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

  private readonly timeUniform = { value: 0 };
  private readonly shallowColor = { value: new THREE.Color("#73b9b0") };
  private readonly midColor = { value: new THREE.Color("#347f91") };
  private readonly deepColor = { value: new THREE.Color("#163f5b") };

  constructor(private readonly scene: THREE.Scene) {
    const startX = WORLD_CONFIG.size * 0.285;
    const endX = WORLD_CONFIG.size * 1.28;
    const width = endX - startX;
    const depth = WORLD_CONFIG.size * 1.55;
    const geometry = new THREE.PlaneGeometry(width, depth, 72, 84);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(startX + width * 0.5, WORLD_CONFIG.seaLevel, 0);

    const material = new THREE.MeshStandardMaterial({
      color: "#3f8794",
      roughness: 0.3,
      metalness: 0.04,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uOceanTime = this.timeUniform;
      shader.uniforms.uOceanShallowColor = this.shallowColor;
      shader.uniforms.uOceanMidColor = this.midColor;
      shader.uniforms.uOceanDeepColor = this.deepColor;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uOceanTime;
          varying float vOceanDepthMix;`,
        )
        .replace(
          "#include <begin_vertex>",
          `vec3 transformed = vec3(position);
          vOceanDepthMix = smoothstep(${(WORLD_CONFIG.size * 0.32).toFixed(2)}, ${(WORLD_CONFIG.size * 0.78).toFixed(2)}, position.x);
          float oceanWaveA = sin(position.x * 0.105 + uOceanTime * 0.72 + sin(position.z * 0.035));
          float oceanWaveB = sin(position.z * 0.16 - uOceanTime * 0.56 + position.x * 0.028);
          float oceanWaveC = sin((position.x + position.z) * 0.245 + uOceanTime * 0.91);
          transformed.y += oceanWaveA * 0.12 + oceanWaveB * 0.075 + oceanWaveC * 0.035;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform vec3 uOceanShallowColor;
          uniform vec3 uOceanMidColor;
          uniform vec3 uOceanDeepColor;
          varying float vOceanDepthMix;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float shallowToMid = smoothstep(0.02, 0.52, vOceanDepthMix);
          float midToDeep = smoothstep(0.42, 1.0, vOceanDepthMix);
          vec3 oceanDepthColor = mix(uOceanShallowColor, uOceanMidColor, shallowToMid);
          oceanDepthColor = mix(oceanDepthColor, uOceanDeepColor, midToDeep);
          diffuseColor.rgb = oceanDepthColor;
          diffuseColor.a *= mix(0.68, 1.0, vOceanDepthMix);`,
        );
    };
    material.customProgramCacheKey = () => "procedural-ocean-depth-v2";

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "procedural-ocean";
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  update(time: number): void {
    this.timeUniform.value = time * 0.001;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
