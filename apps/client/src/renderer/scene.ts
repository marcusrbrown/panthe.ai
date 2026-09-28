import type { Realm } from "@panthea/contracts";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { Sprite2D, SpriteGroup } from "three-flatland";

import type { ViewLocation, WorldViewModel } from "../store";
import { drawableEvents } from "./presentation";

export interface WorldRenderer {
  start(onDeviceLost: () => void): Promise<void>;
  draw(view: WorldViewModel, realm: Realm): readonly string[];
  dispose(): void;
}

export type RendererFactory = (canvas: HTMLCanvasElement) => WorldRenderer;

function markerTexture(color: string, dead = false): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 28;
  canvas.height = 36;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.fillStyle = color;
  context.beginPath();
  context.arc(14, 11, 8, 0, Math.PI * 2);
  context.fill();
  context.fillRect(8, 18, 12, 12);
  context.strokeStyle = dead ? "#f2eddf" : "#254b3f";
  context.lineWidth = 2;
  context.strokeRect(8, 18, 12, 12);
  if (dead) {
    context.strokeStyle = "#6c3e38";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(5, 4);
    context.lineTo(23, 31);
    context.moveTo(23, 4);
    context.lineTo(5, 31);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const REALM_TINT: Record<Realm, number> = {
  mortal: 0x9a7956,
  olympus: 0x8c9d91,
  underworld: 0x716b73,
};

const STATUS_TINT: Record<string, number> = {
  operational: 0x8d9e81,
  damaged: 0xb7794d,
  burning: 0xc95637,
  destroyed: 0x625b56,
  repairing: 0x71918b,
};

function locationPoints(
  locations: readonly ViewLocation[],
): Map<string, THREE.Vector2> {
  const points = new Map<string, THREE.Vector2>();
  const count = Math.max(1, locations.length);
  locations.forEach((location, index) => {
    const angle =
      count === 1 ? -Math.PI / 2 : (index / count) * Math.PI * 2 - Math.PI / 2;
    const radius = count === 1 ? 0 : Math.min(205, 110 + count * 14);
    points.set(
      location.id,
      new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius),
    );
  });
  return points;
}

function colorForBuilding(status: string): THREE.Color {
  return new THREE.Color(STATUS_TINT[status] ?? STATUS_TINT.operational);
}

export function createWorldRenderer(canvas: HTMLCanvasElement): WorldRenderer {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e7dfce");
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  camera.position.z = 120;
  const markers = new SpriteGroup();
  const owned: THREE.Object3D[] = [];
  const textures: THREE.Texture[] = [];
  let disposed = false;
  let lost = false;
  let onLost: (() => void) | undefined;

  scene.add(markers);

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
  }

  function clearScene(): void {
    for (const child of [...markers.children]) {
      markers.remove(child);
      const disposable = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      disposable.geometry?.dispose();
      if (disposable.material) {
        const materials = Array.isArray(disposable.material)
          ? disposable.material
          : [disposable.material];
        for (const material of materials) material.dispose();
      }
    }
    for (const child of owned.splice(0)) {
      scene.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of materials) material.dispose();
      }
    }
    for (const texture of textures.splice(0)) texture.dispose();
  }

  function line(
    from: THREE.Vector2,
    to: THREE.Vector2,
    color: number,
    width = 2,
  ): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, 0),
      new THREE.Vector3(to.x, to.y, 0),
    ]);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.75,
      linewidth: width,
    });
    const path = new THREE.Line(geometry, material);
    scene.add(path);
    owned.push(path);
  }

  function block(
    x: number,
    y: number,
    color: THREE.Color,
    width: number,
    height: number,
    z = 1,
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, 2);
    const material = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    owned.push(mesh);
    return mesh;
  }

  function draw(view: WorldViewModel, realm: Realm): readonly string[] {
    clearScene();
    const locations = view.realms[realm];
    const points = locationPoints(locations);
    const ink = REALM_TINT[realm];

    for (let y = -280; y < 320; y += 44) {
      line(new THREE.Vector2(-460, y), new THREE.Vector2(460, y), 0xbdb5a5, 1);
    }
    for (const location of locations) {
      const from = points.get(location.id);
      if (!from) continue;
      for (const edge of location.edges) {
        const to = points.get(edge.to);
        if (to && location.id < edge.to) line(from, to, ink, 3);
      }
      block(
        from.x,
        from.y,
        new THREE.Color(ink),
        realm === "mortal" ? 26 : 19,
        realm === "mortal" ? 26 : 19,
        2,
      );
      for (const [index, building] of location.buildings.entries()) {
        const x = from.x - 46 + (index % 3) * 42;
        const y = from.y + 50 + Math.floor(index / 3) * 35;
        block(x, y, colorForBuilding(building.status), 28, 22, 3);
        if (building.status === "burning") {
          const ratio = building.fire?.destroyAt
            ? Math.min(1, building.fire.intensity / building.fire.destroyAt)
            : 0.65;
          const flame = new THREE.Mesh(
            new THREE.CircleGeometry(7 + ratio * 8, 12),
            new THREE.MeshBasicMaterial({
              color: "#d56b36",
              transparent: true,
              opacity: 0.82,
            }),
          );
          flame.position.set(x + 9, y + 20, 4);
          scene.add(flame);
          owned.push(flame);
        }
        if (building.status === "repairing" && building.repair) {
          const ratio = building.repair.required
            ? building.repair.progress / building.repair.required
            : building.repair.progress / (building.repair.progress + 1);
          block(
            x,
            y - 15,
            new THREE.Color("#71918b"),
            28 * Math.min(1, ratio),
            3,
            5,
          );
        }
      }
      for (const [index, actor] of location.actors.entries()) {
        const texture = markerTexture(
          actor.alive ? "#315f4d" : "#7e7771",
          !actor.alive,
        );
        textures.push(texture);
        const sprite = new Sprite2D({
          texture,
          anchor: [0.5, 0],
          sortLayer: "entities",
          zIndex: from.y + index,
          lit: false,
        });
        sprite.position.set(
          from.x - 28 + (index % 7) * 12,
          from.y - 48 - Math.floor(index / 7) * 15,
          8,
        );
        markers.add(sprite);
      }
    }

    const drawnEventIds: string[] = [];
    for (const [index, event] of drawableEvents(view, realm).entries()) {
      const point = locations.length
        ? points.get(locations[index % locations.length]?.id ?? "")
        : undefined;
      if (!point) continue;
      const color =
        String(event.kind).toLowerCase().includes("fire") ||
        String(event.kind).toLowerCase().includes("ignit")
          ? 0xc95637
          : String(event.kind).toLowerCase().includes("worship")
            ? 0x8e7957
            : 0x668b80;
      const effect = new THREE.Mesh(
        new THREE.RingGeometry(13 + (index % 3) * 3, 17 + (index % 3) * 3, 20),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.72,
        }),
      );
      effect.position.set(point.x + 34, point.y - 23, 10);
      scene.add(effect);
      owned.push(effect);
      drawnEventIds.push(event.id);
    }

    resize();
    renderer.render(scene, camera);
    return drawnEventIds;
  }

  const handleResize = () => resize();
  window.addEventListener("resize", handleResize);

  return {
    async start(onDeviceLost) {
      onLost = onDeviceLost;
      await renderer.init();
      if (disposed) return;
      const backend = (
        renderer as unknown as {
          backend?: {
            isWebGLBackend?: boolean;
            device?: { lost?: Promise<unknown> };
          };
        }
      ).backend;
      if (backend?.isWebGLBackend) {
        canvas.addEventListener(
          "webglcontextlost",
          (event) => {
            event.preventDefault();
            if (lost) return;
            lost = true;
            onLost?.();
          },
          { once: true },
        );
      }
      backend?.device?.lost?.then(() => {
        if (lost || disposed) return;
        lost = true;
        onLost?.();
      });
      resize();
    },
    draw,
    dispose() {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      clearScene();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
  };
}
