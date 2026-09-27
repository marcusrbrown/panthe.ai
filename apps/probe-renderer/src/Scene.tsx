// M0 renderer probe (D25): mounts a three-flatland scene onto three's
// WebGPURenderer and lets it fall back to the WebGL2 backend (WKWebView on
// this machine has no navigator.gpu — see tools/probes/webgpu-wkwebview).
// Pass `?forceWebGL=1` to force the WebGL2 backend explicitly.
//
// Deviations from the unit spec, recorded here because they were only
// discoverable by inspecting the installed package (three-flatland
// 0.1.0-alpha.10 / @three-flatland/nodes 0.1.0-alpha.10):
// - `PixelPerfectCamera` is not exported by three-flatland at this alpha
//   version (checked the full `index.d.ts` export list). This file
//   implements a minimal equivalent (`updatePixelPerfectCamera`) instead.
// - `createMaterialEffect` lives on the `three-flatland` top-level export,
//   not `@three-flatland/nodes` (that package supplies TSL *node
//   functions* like `pulseGlow`, not the effect factory).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { sin, time as tslTime, vec3, vec4 } from "three/tsl";
import { WebGPURenderer } from "three/webgpu";
import type {
  MaterialEffect,
  SpriteFrame,
  SpriteSheet,
  TileDefinition,
  TileLayerData,
  TileMapData,
  TilesetData,
} from "three-flatland";
import {
  AnimatedSprite2D,
  applyTextureOptions,
  createMaterialEffect,
  SortLayers,
  Sprite2D,
  SpriteGroup,
  TileMap2D,
} from "three-flatland";
import type { EffectFailure, MetricsSnapshot } from "./metrics";
import {
  ClickLatencyTracker,
  ContextLossTracker,
  dumpMetrics,
  FrameTimeTracker,
} from "./metrics";

const TILE_SIZE = 32;
const MAP_SIZE = 64;
const ACTOR_COUNT = 200;
const ANIM_ACTOR_COUNT = 30;
const ANIM_FRAME_SIZE = 32;
const ANIM_FRAME_COUNT = 4;
const BURST_INTENSITY = 3.4;
const NORMAL_INTENSITY = 1;

// ---------------------------------------------------------------------------
// Procedural textures — no binary assets, everything drawn on an offscreen
// <canvas> at module load / scene build time.
// ---------------------------------------------------------------------------

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function get2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(
      "2d canvas context unavailable while building a procedural texture",
    );
  }
  return ctx;
}

/** 2-tile atlas: a checker pavement tile and a road tile with a dashed centerline. */
function buildTilesetCanvas(): HTMLCanvasElement {
  const canvas = makeCanvas(TILE_SIZE * 2, TILE_SIZE);
  const ctx = get2DContext(canvas);
  const half = TILE_SIZE / 2;

  // Tile 0 (gid 1): checker pavement.
  ctx.fillStyle = "#9a9a9a";
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = "#7d7d7d";
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);

  // Tile 1 (gid 2): road with a dashed centerline.
  ctx.fillStyle = "#3a3a3e";
  ctx.fillRect(TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = "#e8d24a";
  ctx.fillRect(TILE_SIZE + half - 2, 4, 4, 10);
  ctx.fillRect(TILE_SIZE + half - 2, 18, 4, 10);

  return canvas;
}

/** Diamond marker used for the isometric-sorted actor sprites. */
function buildActorCanvas(): HTMLCanvasElement {
  const size = 24;
  const canvas = makeCanvas(size, size);
  const ctx = get2DContext(canvas);
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "#e4e4e4";
  ctx.fillRect(-size / 3, -size / 3, (size * 2) / 3, (size * 2) / 3);
  ctx.strokeStyle = "#1c1c1c";
  ctx.lineWidth = 2;
  ctx.strokeRect(-size / 3, -size / 3, (size * 2) / 3, (size * 2) / 3);
  return canvas;
}

/** 4-frame sheet: a ring that grows/shrinks, driving AnimatedSprite2D playback. */
function buildAnimSheetCanvas(): HTMLCanvasElement {
  const canvas = makeCanvas(
    ANIM_FRAME_SIZE * ANIM_FRAME_COUNT,
    ANIM_FRAME_SIZE,
  );
  const ctx = get2DContext(canvas);
  for (let frame = 0; frame < ANIM_FRAME_COUNT; frame++) {
    const cx = frame * ANIM_FRAME_SIZE + ANIM_FRAME_SIZE / 2;
    const cy = ANIM_FRAME_SIZE / 2;
    const radius = 5 + frame * 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `hsl(${30 + frame * 18}, 92%, 58%)`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  return canvas;
}

function canvasToTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  applyTextureOptions(texture, "pixel-art");
  texture.needsUpdate = true;
  return texture;
}

function buildTileMapData(texture: THREE.Texture): TileMapData {
  const tiles = new Map<number, TileDefinition>();
  tiles.set(1, { id: 1, uv: { x: 0, y: 0, width: 0.5, height: 1 } });
  tiles.set(2, { id: 2, uv: { x: 0.5, y: 0, width: 0.5, height: 1 } });

  const tileset: TilesetData = {
    name: "floor",
    firstGid: 1,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    imageWidth: TILE_SIZE * 2,
    imageHeight: TILE_SIZE,
    columns: 2,
    tileCount: 2,
    tiles,
    texture,
  };

  const data = new Uint32Array(MAP_SIZE * MAP_SIZE);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const onRoad = x % 8 === 3 || y % 8 === 3;
      data[y * MAP_SIZE + x] = onRoad ? 2 : (x + y) % 2 === 0 ? 1 : 2;
    }
  }

  const layer: TileLayerData = {
    name: "floor",
    id: 1,
    width: MAP_SIZE,
    height: MAP_SIZE,
    data,
  };

  return {
    width: MAP_SIZE,
    height: MAP_SIZE,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    orientation: "orthogonal",
    renderOrder: "right-down",
    infinite: false,
    tilesets: [tileset],
    tileLayers: [layer],
    objectLayers: [],
  };
}

function buildAnimSpriteSheet(texture: THREE.Texture): SpriteSheet {
  const frames = new Map<string, SpriteFrame>();
  const frameNames: string[] = [];
  for (let i = 0; i < ANIM_FRAME_COUNT; i++) {
    const name = `pulse_${i}`;
    frameNames.push(name);
    frames.set(name, {
      name,
      x: i / ANIM_FRAME_COUNT,
      y: 0,
      width: 1 / ANIM_FRAME_COUNT,
      height: 1,
      sourceWidth: ANIM_FRAME_SIZE,
      sourceHeight: ANIM_FRAME_SIZE,
    });
  }
  const pingPongFrames = [...frameNames, ...[...frameNames].reverse()];
  const animations = new Map([
    ["pulse", { frames: pingPongFrames, fps: 8, loop: true, pingPong: false }],
  ]);

  return {
    texture,
    frames,
    animations,
    width: ANIM_FRAME_SIZE * ANIM_FRAME_COUNT,
    height: ANIM_FRAME_SIZE,
    getFrame(name: string): SpriteFrame {
      const frame = frames.get(name);
      if (!frame) throw new Error(`Unknown animation frame: ${name}`);
      return frame;
    },
    getFrameNames(): string[] {
      return frameNames;
    },
    getAnimation(name: string) {
      return animations.get(name);
    },
    getAnimationNames(): string[] {
      return [...animations.keys()];
    },
  };
}

// ---------------------------------------------------------------------------
// Effect: lightning/fire-style flicker. Tries `@three-flatland/nodes`'
// `pulseGlow`; falls back to a hand-rolled TSL emissive flicker if the
// companion package's import fails, recording the failure instead of
// crashing.
// ---------------------------------------------------------------------------

const fireEffectSchema = { intensity: 1, speed: 6 } as const;

async function createFireEffect(): Promise<{
  EffectClass: new () => MaterialEffect;
  usedNodesPackage: boolean;
  failure: EffectFailure | undefined;
}> {
  try {
    const nodes = await import("@three-flatland/nodes");
    const EffectClass = createMaterialEffect({
      name: "fireFlicker",
      schema: fireEffectSchema,
      node: ({ inputColor, attrs }) =>
        nodes.pulseGlow(
          inputColor,
          tslTime,
          [1, 0.45, 0.08],
          attrs.speed,
          attrs.intensity,
        ),
    });
    return { EffectClass, usedNodesPackage: true, failure: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const EffectClass = createMaterialEffect({
      name: "fireFlickerFallback",
      schema: fireEffectSchema,
      node: ({ inputColor, attrs }) => {
        const flicker = sin(tslTime.mul(attrs.speed))
          .mul(0.5)
          .add(0.5)
          .mul(attrs.intensity);
        return vec4(
          inputColor.rgb.add(vec3(flicker.mul(0.6), flicker.mul(0.22), 0)),
          inputColor.a,
        );
      },
    });
    return {
      EffectClass,
      usedNodesPackage: false,
      failure: {
        effectName: "fireFlicker",
        error: `@three-flatland/nodes import failed: ${message}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// PixelPerfectCamera equivalent (not exported by three-flatland at
// 0.1.0-alpha.10 — see header comment). 1 world unit == 1 CSS pixel; the
// renderer pins devicePixelRatio to 1 so this mapping holds exactly.
// ---------------------------------------------------------------------------

function updatePixelPerfectCamera(
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
): void {
  const halfWidth = canvas.clientWidth / 2;
  const halfHeight = canvas.clientHeight / 2;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.position.x = Math.round(camera.position.x);
  camera.position.y = Math.round(camera.position.y);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Scene() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  const dumpHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvasRefCurrent = canvasRef.current;
    if (!canvasRefCurrent) return;
    // Nested function declarations below don't retain TS's null-narrowing of
    // `canvasRef.current`, so bind it to a non-nullable-typed const instead.
    const canvasEl: HTMLCanvasElement = canvasRefCurrent;

    let disposed = false;
    let detachContextTracking: (() => void) | undefined;
    let overlayIntervalHandle: number | null = null;

    const effectFailures: EffectFailure[] = [];
    const frameTime = new FrameTimeTracker();
    const clickLatency = new ClickLatencyTracker();
    const contextLoss = new ContextLossTracker();
    const fireEffectClassRef: { current: (new () => MaterialEffect) | null } = {
      current: null,
    };

    const forceWebGL =
      new URLSearchParams(window.location.search).get("forceWebGL") === "1";
    const renderer = new WebGPURenderer({
      canvas: canvasEl,
      forceWebGL,
      antialias: false,
    });
    renderer.setPixelRatio(1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14141a);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    camera.position.z = 100;

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let selectedSprite: Sprite2D | null = null;
    let selectedOriginalTint: THREE.Color | null = null;
    let selectableSprites: Sprite2D[] = [];
    let burstActive = false;
    let fireEffects: (MaterialEffect & { intensity: number })[] = [];
    let backendName = "unknown";
    let backendDetectionProperty = "unknown";
    let webglDebugRenderer: {
      vendor: string | null;
      renderer: string | null;
    } | null = null;

    const group = new SpriteGroup();
    scene.add(group);

    const tilesetTexture = canvasToTexture(buildTilesetCanvas());
    const tilemap = new TileMap2D({
      data: buildTileMapData(tilesetTexture),
      baseLayer: SortLayers.GROUND,
    });
    tilemap.lit = false;
    scene.add(tilemap);

    const actorTexture = canvasToTexture(buildActorCanvas());
    const animTexture = canvasToTexture(buildAnimSheetCanvas());
    const animSheet = buildAnimSpriteSheet(animTexture);

    function populateActors(): { staticCount: number; animatedCount: number } {
      selectableSprites = [];

      for (let i = 0; i < ACTOR_COUNT; i++) {
        const worldX = Math.round((Math.random() - 0.5) * MAP_SIZE * TILE_SIZE);
        const worldY = Math.round((Math.random() - 0.5) * MAP_SIZE * TILE_SIZE);
        const sprite = new Sprite2D({
          texture: actorTexture,
          anchor: [0.5, 0.2],
          sortLayer: "entities",
          zIndex: worldY,
          lit: false,
        });
        sprite.position.set(worldX, worldY, 0);
        group.add(sprite);
        selectableSprites.push(sprite);
      }

      fireEffects = [];
      for (let i = 0; i < ANIM_ACTOR_COUNT; i++) {
        const worldX = Math.round((Math.random() - 0.5) * MAP_SIZE * TILE_SIZE);
        const worldY = Math.round((Math.random() - 0.5) * MAP_SIZE * TILE_SIZE);
        const animSprite = new AnimatedSprite2D({
          spriteSheet: animSheet,
          animation: "pulse",
          autoPlay: true,
          sortLayer: "entities",
          zIndex: worldY + 1,
        });
        animSprite.lit = false;
        animSprite.position.set(worldX, worldY, 0);
        group.add(animSprite);
        selectableSprites.push(animSprite);

        const EffectClass = fireEffectClassRef.current;
        if (EffectClass) {
          const effect = new EffectClass() as MaterialEffect & {
            intensity: number;
          };
          effect.intensity = burstActive ? BURST_INTENSITY : NORMAL_INTENSITY;
          try {
            animSprite.addEffect(effect);
            fireEffects.push(effect);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            effectFailures.push({
              effectName: "fireFlicker (addEffect)",
              error: message,
            });
          }
        }
      }

      return { staticCount: ACTOR_COUNT, animatedCount: ANIM_ACTOR_COUNT };
    }

    function updateOverlay(): void {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const stats = frameTime.percentiles();
      overlay.textContent = [
        `backend: ${backendName} (${backendDetectionProperty})`,
        `forceWebGL: ${forceWebGL}`,
        `frame p50/p95: ${stats.p50.toFixed(2)}ms / ${stats.p95.toFixed(2)}ms (n=${stats.sampleCount})`,
        `click->visible latency: ${clickLatency.latestMs !== null ? `${clickLatency.latestMs.toFixed(1)}ms` : "—"}`,
        `context lost/restored: ${contextLoss.lostCount}/${contextLoss.restoredCount}`,
        `sprites: ${selectableSprites.length}`,
        `burst: ${burstActive ? "ON" : "off"} (press b to toggle)`,
        `effect failures: ${effectFailures.length}`,
        "press d or click Dump to write metrics JSON",
      ].join("\n");
    }

    function buildSnapshot(): MetricsSnapshot {
      const stats = frameTime.percentiles();
      const nav = navigator as Navigator & { gpu?: unknown };
      return {
        timestamp: new Date().toISOString(),
        backend: backendName,
        backendDetectionProperty,
        navigatorGpuType: typeof nav.gpu,
        userAgent: navigator.userAgent,
        webglDebugRenderer,
        frameTime: stats,
        clickToVisibleLatencyMs: clickLatency.latestMs,
        contextLoss: {
          lostCount: contextLoss.lostCount,
          restoredCount: contextLoss.restoredCount,
        },
        spriteCount: selectableSprites.length,
        effectFailures,
      };
    }

    dumpHandlerRef.current = () => {
      void dumpMetrics(buildSnapshot());
    };

    function onPointerDown(event: PointerEvent): void {
      clickLatency.markPointerDown(performance.now());
      const rect = canvasEl.getBoundingClientRect();
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(selectableSprites, false);

      if (selectedSprite && selectedOriginalTint) {
        selectedSprite.tint = selectedOriginalTint;
      }
      const hit = hits[0]?.object;
      if (hit instanceof Sprite2D) {
        selectedOriginalTint = hit.tint.clone();
        hit.tint = new THREE.Color(0xffff66);
        selectedSprite = hit;
      } else {
        selectedSprite = null;
        selectedOriginalTint = null;
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "d" || event.key === "D") {
        dumpHandlerRef.current?.();
      } else if (event.key === "b" || event.key === "B") {
        burstActive = !burstActive;
        const intensity = burstActive ? BURST_INTENSITY : NORMAL_INTENSITY;
        for (const effect of fireEffects) {
          effect.intensity = intensity;
        }
      }
    }

    function onResize(): void {
      const width = canvasEl.clientWidth || window.innerWidth;
      const height = canvasEl.clientHeight || window.innerHeight;
      renderer.setSize(width, height, false);
      updatePixelPerfectCamera(camera, canvasEl);
    }

    async function boot(): Promise<void> {
      await renderer.init();
      if (disposed) return;

      const backend = (
        renderer as unknown as {
          backend: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
        }
      ).backend;
      if (backend.isWebGPUBackend) {
        backendName = "webgpu";
        backendDetectionProperty = "renderer.backend.isWebGPUBackend";
      } else if (backend.isWebGLBackend) {
        backendName = "webgl2";
        backendDetectionProperty = "renderer.backend.isWebGLBackend";
        const gl = canvasEl.getContext("webgl2");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        if (gl && ext) {
          webglDebugRenderer = {
            vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)),
            renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)),
          };
        }
      }

      const nav = navigator as Navigator & { gpu?: unknown };
      console.log("[probe-renderer] environment", {
        backendName,
        backendDetectionProperty,
        navigatorGpuType: typeof nav.gpu,
        userAgent: navigator.userAgent,
        webglDebugRenderer,
        forceWebGL,
      });

      onResize();

      const { EffectClass, usedNodesPackage, failure } =
        await createFireEffect();
      if (disposed) return;
      fireEffectClassRef.current = EffectClass;
      if (failure) effectFailures.push(failure);
      console.log(
        `[probe-renderer] fire effect source: ${usedNodesPackage ? "@three-flatland/nodes pulseGlow" : "fallback TSL flicker"}`,
      );

      populateActors();

      detachContextTracking = contextLoss.attach(canvasEl, () => {
        for (const child of [...group.children]) group.remove(child);
        const { staticCount, animatedCount } = populateActors();
        const expected = staticCount + animatedCount;
        console.log(
          `[probe-renderer] context restored — rebuilt ${selectableSprites.length} sprites (expected ${expected}): ${
            selectableSprites.length === expected ? "OK" : "MISMATCH"
          }`,
        );
      });

      window.addEventListener("resize", onResize);
      canvasEl.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKeyDown);

      let lastTimestamp = performance.now();
      renderer.setAnimationLoop((timestamp: number) => {
        const deltaMs = timestamp - lastTimestamp;
        lastTimestamp = timestamp;
        frameTime.record(deltaMs);

        for (const child of group.children) {
          if (child instanceof AnimatedSprite2D) {
            child.update(deltaMs);
          }
        }

        renderer.render(scene, camera);
        clickLatency.resolveIfPending(performance.now());
      });

      overlayIntervalHandle = window.setInterval(updateOverlay, 250);
    }

    boot().catch((error: unknown) => {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      console.error("[probe-renderer] boot() failed:", error);
      const overlay = overlayRef.current;
      if (overlay) {
        overlay.textContent = `boot() failed:\n${message}`;
        overlay.style.color = "#ff6b6b";
        overlay.style.background = "rgba(0,0,0,0.85)";
      }
    });

    return () => {
      disposed = true;
      if (overlayIntervalHandle !== null)
        window.clearInterval(overlayIntervalHandle);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      canvasEl.removeEventListener("pointerdown", onPointerDown);
      detachContextTracking?.();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      <pre
        ref={overlayRef}
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          margin: 0,
          padding: "8px 10px",
          color: "#f5f5f5",
          background: "rgba(0,0,0,0.45)",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          pointerEvents: "none",
          whiteSpace: "pre",
        }}
      >
        booting probe-renderer…
      </pre>
      <button
        type="button"
        onClick={() => dumpHandlerRef.current?.()}
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          padding: "8px 14px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Dump metrics
      </button>
    </>
  );
}
