const fs = require("node:fs");
const path = require("node:path");
const { ICON_SIZES, encodePng } = require("./icon-lib");

const outputDirectory = path.resolve("assets", "icons");
const supersampling = 4;

function distanceToSegment(x, y, startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared,
    ),
  );
  return Math.hypot(
    x - (startX + projection * deltaX),
    y - (startY + projection * deltaY),
  );
}

function colorAt(x, y) {
  const radius = Math.hypot(x, y);
  if (radius > 0.47) {
    return [0, 0, 0, 0];
  }

  let color = [8, 15, 28, 255];
  if (radius <= 0.36) {
    color = [248, 250, 252, 255];
  }

  const degrees = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const inGaugeSweep = degrees >= 135 || degrees <= 45;
  if (radius >= 0.275 && radius <= 0.37 && inGaugeSweep) {
    color = [14, 165, 233, 255];
  }

  if (distanceToSegment(x, y, 0, 0, 0.22, -0.22) <= 0.042) {
    color = [8, 15, 28, 255];
  }
  if (radius <= 0.072) {
    color = [8, 15, 28, 255];
  }
  return color;
}

function renderIcon(size) {
  const highResolutionSize = size * supersampling;
  const highResolution = Buffer.alloc(
    highResolutionSize * highResolutionSize * 4,
  );

  for (let y = 0; y < highResolutionSize; y += 1) {
    for (let x = 0; x < highResolutionSize; x += 1) {
      const normalizedX = (x + 0.5) / highResolutionSize - 0.5;
      const normalizedY = (y + 0.5) / highResolutionSize - 0.5;
      const color = colorAt(normalizedX, normalizedY);
      const offset = (y * highResolutionSize + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        highResolution[offset + channel] = color[channel];
      }
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < supersampling; sampleY += 1) {
        for (let sampleX = 0; sampleX < supersampling; sampleX += 1) {
          const sourceX = x * supersampling + sampleX;
          const sourceY = y * supersampling + sampleY;
          const sourceOffset =
            (sourceY * highResolutionSize + sourceX) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            totals[channel] += highResolution[sourceOffset + channel];
          }
        }
      }
      const destinationOffset = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        rgba[destinationOffset + channel] = Math.round(
          totals[channel] / (supersampling * supersampling),
        );
      }
    }
  }
  return encodePng(size, size, rgba);
}

function createIco(images) {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = directorySize;
  images.forEach(({ size, png }, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const images = ICON_SIZES.map((size) => {
  const png = renderIcon(size);
  fs.writeFileSync(path.join(outputDirectory, `tray-${size}.png`), png);
  return { size, png };
});
fs.writeFileSync(path.join(outputDirectory, "app.ico"), createIco(images));

process.stdout.write(
  `Generated ${images.length} PNG representations and app.ico.\n`,
);
