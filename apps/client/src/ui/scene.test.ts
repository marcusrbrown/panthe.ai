import { expect, test } from "bun:test";
import * as THREE from "three";
import { SpriteGroup } from "three-flatland";
import { replaceMarkerGroup } from "../renderer/scene";

test("replacing the realm marker group detaches stale sprites", () => {
  const scene = new THREE.Scene();
  const previous = new SpriteGroup();
  previous.add(new THREE.Object3D());
  scene.add(previous);

  const current = replaceMarkerGroup(scene, previous);

  expect(previous.parent).toBeNull();
  expect(current).not.toBe(previous);
  expect(current.children).toHaveLength(0);
  expect(scene.children).toEqual([current]);
});
