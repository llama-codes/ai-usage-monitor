const fs = require("node:fs");
const path = require("node:path");
const { ICON_SIZES, decodePng } = require("./icon-lib");

const iconDirectory = path.resolve("assets", "icons");
const stateSamples = [];

function verifyPixels(name, decoded) {
  let opaquePixels = 0;
  let transparentPixels = 0;
  let darkest = 255;
  let lightest = 0;

  for (let offset = 0; offset < decoded.rgba.length; offset += 4) {
    const red = decoded.rgba[offset];
    const green = decoded.rgba[offset + 1];
    const blue = decoded.rgba[offset + 2];
    const alpha = decoded.rgba[offset + 3];
    if (alpha >= 224) {
      opaquePixels += 1;
      const luminance = Math.round(
        red * 0.2126 + green * 0.7152 + blue * 0.0722,
      );
      darkest = Math.min(darkest, luminance);
      lightest = Math.max(lightest, luminance);
    }
    if (alpha === 0) {
      transparentPixels += 1;
    }
  }

  const pixelCount = decoded.width * decoded.height;
  const opaqueCoverage = opaquePixels / pixelCount;
  const transparentCoverage = transparentPixels / pixelCount;
  if (opaqueCoverage < 0.45 || opaqueCoverage > 0.82) {
    throw new Error(`${name} has suspicious opaque coverage`);
  }
  if (transparentCoverage < 0.08) {
    throw new Error(`${name} lacks a transparent background`);
  }
  if (lightest - darkest < 180) {
    throw new Error(`${name} lacks high-contrast opaque pixels`);
  }
}

for (const state of ["healthy", "warning", "critical"]) {
  for (const size of ICON_SIZES) {
    const name = `tray-${state}-${size}.png`;
    const buffer = fs.readFileSync(path.join(iconDirectory, name));
    const decoded = decodePng(buffer);
    if (decoded.width !== size || decoded.height !== size) {
      throw new Error(`${name} has incorrect dimensions`);
    }
    verifyPixels(name, decoded);
    if (size === 16) {
      stateSamples.push({ state, buffer });
    }
  }
}
for (let left = 0; left < stateSamples.length; left += 1) {
  for (let right = left + 1; right < stateSamples.length; right += 1) {
    if (stateSamples[left].buffer.equals(stateSamples[right].buffer)) {
      throw new Error(
        `${stateSamples[left].state} and ${stateSamples[right].state} tray states are identical`,
      );
    }
  }
}

const ico = fs.readFileSync(path.join(iconDirectory, "app.ico"));
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
  throw new Error("app.ico has an invalid ICO header");
}
const imageCount = ico.readUInt16LE(4);
if (imageCount !== ICON_SIZES.length) {
  throw new Error(`app.ico contains ${imageCount} representations`);
}

const icoSizes = [];
for (let index = 0; index < imageCount; index += 1) {
  const entryOffset = 6 + index * 16;
  const width = ico[entryOffset] || 256;
  const height = ico[entryOffset + 1] || 256;
  const byteLength = ico.readUInt32LE(entryOffset + 8);
  const imageOffset = ico.readUInt32LE(entryOffset + 12);
  if (width !== height || ico.readUInt16LE(entryOffset + 6) !== 32) {
    throw new Error(`app.ico representation ${index} is malformed`);
  }
  const decoded = decodePng(
    ico.subarray(imageOffset, imageOffset + byteLength),
  );
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error(`app.ico representation ${index} dimensions disagree`);
  }
  verifyPixels(`app.ico:${width}`, decoded);
  icoSizes.push(width);
}

if (JSON.stringify(icoSizes) !== JSON.stringify(ICON_SIZES)) {
  throw new Error(`app.ico sizes are incorrect: ${icoSizes.join(", ")}`);
}

process.stdout.write(
  `PASS: healthy, warning, and critical tray PNGs plus ICO decode with sizes ${icoSizes.join(", ")}.\n`,
);
