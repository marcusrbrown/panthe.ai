// The scene's actor markers: one SpriteGroup for the renderer's lifetime.
// A SpriteGroup owns an ECS world, and the world count is capped, so the
// group is never rebuilt per draw. Sprites are not children of the group
// (its batch meshes are), so clearing must release each sprite explicitly
// or it stays enrolled and keeps drawing.

import type * as THREE from "three";
import { type Sprite2D, SpriteGroup } from "three-flatland";

export interface MarkerLayer {
  readonly group: SpriteGroup;
  add(sprite: Sprite2D): void;
  /** Removes and disposes every sprite added since the last clear; the group and its world stay. */
  clear(): void;
  /** Clears, then removes and disposes the group, releasing its world. Safe to call twice. */
  dispose(): void;
}

export function createMarkerLayer(scene: THREE.Scene): MarkerLayer {
  const group = new SpriteGroup();
  const sprites: Sprite2D[] = [];
  scene.add(group);

  function clear(): void {
    for (const sprite of sprites.splice(0)) {
      group.remove(sprite);
      sprite.dispose();
    }
  }

  return {
    group,
    add(sprite) {
      group.add(sprite);
      sprites.push(sprite);
    },
    clear,
    dispose() {
      clear();
      scene.remove(group);
      group.dispose();
    },
  };
}
