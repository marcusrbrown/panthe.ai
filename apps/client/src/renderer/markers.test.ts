import { expect, test } from "bun:test";
import * as THREE from "three";
import { Sprite2D, type SpriteGroup } from "three-flatland";

import { createMarkerLayer } from "./markers";

const texture = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
);
texture.needsUpdate = true;

/** Sprites sharing one texture batch together, as the scene's markers do. */
function sprite(): Sprite2D {
  return new Sprite2D({ texture, lit: false });
}

function spriteGroups(scene: THREE.Scene): SpriteGroup[] {
  return scene.children.filter(
    (child): child is SpriteGroup => (child as SpriteGroup).isSpriteGroup,
  );
}

test("more than 16 successive draws reuse one sprite group and never throw", () => {
  const scene = new THREE.Scene();
  const layer = createMarkerLayer(scene);

  for (let draw = 0; draw < 40; draw += 1) {
    layer.clear();
    layer.add(sprite());
    layer.add(sprite());
    scene.updateMatrixWorld(true);
  }

  expect(spriteGroups(scene)).toEqual([layer.group]);
  layer.dispose();
});

test("clearing drops every sprite from the batch, so a sprite from a previously viewed realm does not linger", () => {
  const scene = new THREE.Scene();
  const layer = createMarkerLayer(scene);
  layer.add(sprite());
  layer.add(sprite());
  scene.updateMatrixWorld(true);
  expect(layer.group.batchCount).toBe(1);
  expect(layer.group.isEmpty).toBe(false);

  layer.clear();
  scene.updateMatrixWorld(true);

  expect(layer.group.isEmpty).toBe(true);
  expect(layer.group.batchCount).toBe(0);

  layer.add(sprite());
  scene.updateMatrixWorld(true);
  expect(layer.group.batchCount).toBe(1);
  layer.dispose();
});

test("disposing the layer removes its group, and repeated renderer replacement never exhausts the world limit", () => {
  for (let renderer = 0; renderer < 40; renderer += 1) {
    const scene = new THREE.Scene();
    const layer = createMarkerLayer(scene);
    layer.add(sprite());
    scene.updateMatrixWorld(true);

    layer.dispose();

    expect(spriteGroups(scene)).toEqual([]);
  }
});

test("disposing a layer twice, or clearing after disposal, does not throw", () => {
  const scene = new THREE.Scene();
  const layer = createMarkerLayer(scene);
  layer.add(sprite());

  layer.dispose();

  expect(() => layer.dispose()).not.toThrow();
  expect(() => layer.clear()).not.toThrow();
});
