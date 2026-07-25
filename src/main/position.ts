export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Candidate = Rectangle & {
  name: "above" | "below" | "left" | "right";
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function visibleArea(candidate: Rectangle, workArea: Rectangle): number {
  const left = Math.max(candidate.x, workArea.x);
  const top = Math.max(candidate.y, workArea.y);
  const right = Math.min(
    candidate.x + candidate.width,
    workArea.x + workArea.width,
  );
  const bottom = Math.min(
    candidate.y + candidate.height,
    workArea.y + workArea.height,
  );

  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

/**
 * Positions the popup next to the tray click rectangle in Electron's
 * device-independent screen coordinates, constrained to the selected display.
 */
export function positionPopup(
  trayBounds: Rectangle,
  workArea: Rectangle,
  popupSize: { width: number; height: number },
): Rectangle {
  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  const centeredX = Math.round(centerX - popupSize.width / 2);
  const centeredY = Math.round(centerY - popupSize.height / 2);

  const candidates: Candidate[] = [
    {
      name: "above",
      x: centeredX,
      y: trayBounds.y - popupSize.height,
      ...popupSize,
    },
    {
      name: "below",
      x: centeredX,
      y: trayBounds.y + trayBounds.height,
      ...popupSize,
    },
    {
      name: "left",
      x: trayBounds.x - popupSize.width,
      y: centeredY,
      ...popupSize,
    },
    {
      name: "right",
      x: trayBounds.x + trayBounds.width,
      y: centeredY,
      ...popupSize,
    },
  ];

  const best = candidates.reduce((winner, candidate) => {
    const candidateArea = visibleArea(candidate, workArea);
    const winnerArea = visibleArea(winner, workArea);
    return candidateArea > winnerArea ? candidate : winner;
  });

  return {
    x: clamp(
      best.x,
      workArea.x,
      workArea.x + workArea.width - popupSize.width,
    ),
    y: clamp(
      best.y,
      workArea.y,
      workArea.y + workArea.height - popupSize.height,
    ),
    ...popupSize,
  };
}
