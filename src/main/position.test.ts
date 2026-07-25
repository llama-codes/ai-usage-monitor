import assert from "node:assert/strict";
import test from "node:test";
import { positionPopup, type Rectangle } from "./position";

const popup = { width: 340, height: 420 };

function assertInside(bounds: Rectangle, workArea: Rectangle): void {
  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
}

test("anchors above a bottom taskbar tray", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const result = positionPopup(
    { x: 1860, y: 1040, width: 24, height: 40 },
    workArea,
    popup,
  );
  assert.equal(result.y, 620);
  assertInside(result, workArea);
});

test("anchors below a top taskbar tray", () => {
  const workArea = { x: 0, y: 40, width: 1920, height: 1040 };
  const result = positionPopup(
    { x: 1860, y: 0, width: 24, height: 40 },
    workArea,
    popup,
  );
  assert.equal(result.y, 40);
  assertInside(result, workArea);
});

test("supports negative-coordinate and high-DPI display work areas", () => {
  const workArea = { x: -2560, y: -200, width: 2560, height: 1440 };
  const result = positionPopup(
    { x: -32, y: 1240, width: 32, height: 48 },
    workArea,
    popup,
  );
  assertInside(result, workArea);
});

test("anchors to left and right vertical taskbars", () => {
  const workArea = { x: 48, y: 0, width: 1872, height: 1080 };
  assertInside(
    positionPopup({ x: 0, y: 500, width: 48, height: 32 }, workArea, popup),
    workArea,
  );

  const rightWorkArea = { x: 0, y: 0, width: 1872, height: 1080 };
  assertInside(
    positionPopup(
      { x: 1872, y: 500, width: 48, height: 32 },
      rightWorkArea,
      popup,
    ),
    rightWorkArea,
  );
});
