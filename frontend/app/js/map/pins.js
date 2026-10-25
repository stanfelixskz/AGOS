/*
 * Evacuation center pin: a green map pin with a white house, drawn on a canvas
 * so the map needs no sprite or glyph files. The selected pin is larger and has
 * a blue ring. Images are drawn at 2x and registered with pixelRatio 2.
 */

export const PIN_ID = "agos-pin";
export const PIN_SELECTED_ID = "agos-pin-selected";

function drawPin(selected) {
  const scale = 2;
  const w = 36 * scale;
  const h = 46 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const cx = 18;
  const top = selected ? 4 : 5;
  const r = selected ? 14 : 13;
  const cy = top + r;
  const tipY = 43;

  const body = () => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.82, Math.PI * 0.18, false);
    ctx.lineTo(cx, tipY);
    ctx.closePath();
  };

  ctx.shadowColor = "rgba(15, 27, 45, 0.35)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  body();
  ctx.fillStyle = "#16a34a";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineJoin = "round";
  ctx.lineWidth = selected ? 3.2 : 2;
  ctx.strokeStyle = selected ? "#0b63c4" : "#ffffff";
  body();
  ctx.stroke();
  if (selected) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // White house: roof, walls, door.
  const k = r / 13;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 7.5 * k);
  ctx.lineTo(cx + 7.5 * k, cy - 0.5 * k);
  ctx.lineTo(cx - 7.5 * k, cy - 0.5 * k);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - 5 * k, cy - 0.5 * k, 10 * k, 7 * k);
  ctx.fillStyle = "#16a34a";
  ctx.fillRect(cx - 1.5 * k, cy + 2.5 * k, 3 * k, 4 * k);

  return { data: ctx.getImageData(0, 0, w, h), pixelRatio: scale };
}

/** Add both pin images to the map once (and again after a basemap change). */
export function addPinImages(map) {
  if (!map.hasImage(PIN_ID)) {
    const { data, pixelRatio } = drawPin(false);
    map.addImage(PIN_ID, data, { pixelRatio });
  }
  if (!map.hasImage(PIN_SELECTED_ID)) {
    const { data, pixelRatio } = drawPin(true);
    map.addImage(PIN_SELECTED_ID, data, { pixelRatio });
  }
}
