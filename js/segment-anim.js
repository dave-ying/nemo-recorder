import { state, WAVEFORM_STYLE, SEGMENT_VERTICAL_INSET_CSS_PX, SEGMENT_SHADOW_BLUR_CSS_PX, SEGMENT_SHADOW_OFFSET_Y_CSS_PX, SEGMENT_EDGE_WIDTH_CSS_PX, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_DELETE_ANIM_MS, SEGMENT_GAP_CSS_PX } from './state.js';
import { el, waveCtx } from './dom.js';
import { computeSegmentBoundsPure, audioRatioToVisualRatio, computePeaksForRange, buildWaveformPath, buildOneCardPath } from './waveform-math.js';

const SHATTER_TILE_CSS_PX = 12;
const SHATTER_MAX_TILES = 500;
const SHATTER_MAX_DRIFT_CSS_PX = 44;
const SHATTER_STAGGER_MS = 110;
const SNAPSHOT_PAD_CSS_PX = 16;

/**
 * @typedef {Object} SegmentSnapshot
 * @property {HTMLCanvasElement} canvas - offscreen copy of the card's pixels
 * @property {number} sx - x of the captured region on the waveform canvas (device px)
 * @property {number} sy - y of the captured region on the waveform canvas (device px)
 * @property {number} W - waveform canvas width at capture time (device px)
 * @property {number} H - waveform canvas height at capture time (device px)
 */

function _buildOneCardPath(x, w, H, dpr) {
  return buildOneCardPath(x, w, H, dpr, SEGMENT_CORNER_RADIUS_CSS_PX, SEGMENT_VERTICAL_INSET_CSS_PX);
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function snapshotRegion(sb, W, H, dpr, minX, maxX) {
  const pad = Math.round(SNAPSHOT_PAD_CSS_PX * dpr);
  const insetY = Math.round(SEGMENT_VERTICAL_INSET_CSS_PX * dpr);
  const sx = Math.max(0, minX, Math.floor(sb.drawStart - pad));
  const ex = Math.min(W, maxX, Math.ceil(sb.drawEnd + pad));
  const sy = Math.max(0, insetY - pad);
  const ey = Math.min(H, H - insetY + pad);
  if (ex <= sx || ey <= sy) return null;
  return { sx, sy, w: ex - sx, h: ey - sy };
}

/** @returns {{ off: HTMLCanvasElement, ctx: CanvasRenderingContext2D, sx: number, sy: number } | null} */
function makeSnapshotCanvas(sb, W, H, dpr, minX, maxX) {
  const region = sb ? snapshotRegion(sb, W, H, dpr, minX, maxX) : null;
  if (!region) return null;
  const off = document.createElement('canvas');
  off.width = region.w;
  off.height = region.h;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  return { off, ctx, sx: region.sx, sy: region.sy };
}

/** @returns {SegmentSnapshot | null} */
function captureCanvasRegion(sb, W, H, dpr, minX, maxX) {
  const snap = makeSnapshotCanvas(sb, W, H, dpr, minX, maxX);
  if (!snap) return null;
  snap.ctx.drawImage(el.waveformCanvas, snap.sx, snap.sy, snap.off.width, snap.off.height, 0, 0, snap.off.width, snap.off.height);
  return { canvas: snap.off, sx: snap.sx, sy: snap.sy, W, H };
}

/** @returns {SegmentSnapshot | null} */
export function renderCardSnapshot(sb, seg, channelData, W, H, dpr, playheadX) {
  const snap = makeSnapshotCanvas(sb, W, H, dpr, 0, W);
  if (!snap) return null;
  snap.ctx.translate(-snap.sx, -snap.sy);
  const slide = buildSlide(sb, sb, seg, channelData, H);
  drawSlideCard(snap.ctx, slide, sb.drawStart, sb.drawEnd, playheadX, H, dpr, SEGMENT_EDGE_WIDTH_CSS_PX * dpr);
  return { canvas: snap.off, sx: snap.sx, sy: snap.sy, W, H };
}

export function buildShatterTiles(snap, dpr) {
  if (!snap) return [];
  const sw = snap.canvas.width, sh = snap.canvas.height;
  let tile = SHATTER_TILE_CSS_PX * dpr;
  if ((sw / tile) * (sh / tile) > SHATTER_MAX_TILES) {
    tile = Math.sqrt((sw * sh) / SHATTER_MAX_TILES);
  }
  const cols = Math.max(1, Math.round(sw / tile));
  const rows = Math.max(1, Math.round(sh / tile));
  const tw = sw / cols, th = sh / rows;
  const centerX = snap.sx + sw / 2;
  const midY = snap.H / 2;

  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = snap.sx + (c + 0.5) * tw;
      const cy = snap.sy + (r + 0.5) * th;
      const dirX = cx === centerX ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cx - centerX);
      const dirY = cy === midY ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(cy - midY);
      tiles.push({
        sx: c * tw, sy: r * th, w: tw, h: th, cx, cy,
        vx: dirX * (0.25 + Math.random() * 0.6),
        vy: dirY * (0.3 + Math.random() * 0.7) - 0.25,
        rotSpeed: (Math.random() - 0.5) * 1.6,
        delay: Math.random() * SHATTER_STAGGER_MS
      });
    }
  }
  return tiles;
}

export function drawShatterTiles(ctx, snap, tiles, elapsedMs, dpr) {
  const maxDrift = SHATTER_MAX_DRIFT_CSS_PX * dpr;
  for (const t of tiles) {
    const localDuration = Math.max(60, SEGMENT_DELETE_ANIM_MS - t.delay);
    const pt = Math.max(0, Math.min(1, (elapsedMs - t.delay) / localDuration));
    const eased = 1 - Math.pow(1 - pt, 2);
    const alpha = 1 - Math.pow(pt, 1.6);
    if (alpha <= 0.01) continue;

    ctx.globalAlpha = alpha;
    const scale = 1 - 0.4 * eased;
    const rot = t.rotSpeed * eased;
    const cos = Math.cos(rot) * scale, sin = Math.sin(rot) * scale;
    ctx.setTransform(cos, sin, -sin, cos, t.cx + t.vx * maxDrift * eased, t.cy + t.vy * maxDrift * eased);
    ctx.drawImage(snap.canvas, t.sx, t.sy, t.w, t.h, -t.w / 2, -t.h / 2, t.w, t.h);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

export function buildSlide(oldSb, newSb, seg, channelData, H) {
  const finalWidth = Math.max(1, Math.round(newSb.drawEnd - newSb.drawStart));
  const peaks = computePeaksForRange(channelData, seg.start, seg.end, finalWidth);
  const localPath = new Path2D();
  buildWaveformPath(localPath, peaks, 0, finalWidth, H / 2, 0.88);
  return { oldSb, newSb, finalWidth, localPath };
}

export function drawSlideCard(ctx, s, curStart, curEnd, playheadX, H, dpr, edgeWidth) {
  const curWidth = curEnd - curStart;
  const cardPath = _buildOneCardPath(curStart, curWidth, H, dpr);
  if (!cardPath) return;

  ctx.save();
  ctx.shadowColor = WAVEFORM_STYLE.segmentShadowColor;
  ctx.shadowBlur = SEGMENT_SHADOW_BLUR_CSS_PX * dpr;
  ctx.shadowOffsetY = SEGMENT_SHADOW_OFFSET_Y_CSS_PX * dpr;
  ctx.fillStyle = WAVEFORM_STYLE.segmentCardBg;
  ctx.fill(cardPath);
  ctx.restore();

  ctx.save();
  ctx.clip(cardPath);

  ctx.strokeStyle = WAVEFORM_STYLE.midlineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(curStart, H / 2);
  ctx.lineTo(curEnd, H / 2);
  ctx.stroke();

  const scaleX = curWidth / s.finalWidth;
  const midX = Math.min(curEnd, Math.max(curStart, playheadX));
  if (midX > curStart) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(curStart, 0, midX - curStart, H);
    ctx.clip();
    ctx.translate(curStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.playedColor;
    ctx.fill(s.localPath);
    ctx.restore();
  }
  if (midX < curEnd) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(midX, 0, curEnd - midX, H);
    ctx.clip();
    ctx.translate(curStart, 0);
    ctx.scale(scaleX, 1);
    ctx.fillStyle = WAVEFORM_STYLE.unplayedColor;
    ctx.fill(s.localPath);
    ctx.restore();
  }

  ctx.restore();

  ctx.strokeStyle = WAVEFORM_STYLE.segmentEdgeColor;
  ctx.lineWidth = edgeWidth;
  ctx.stroke(cardPath);
}

export function drawDeleteAnimFrame(anim, now) {
  const { slides, snap, tiles, W, H, dpr } = anim;
  const elapsedMs = now - anim.startTime;
  const t = Math.max(0, Math.min(1, elapsedMs / SEGMENT_DELETE_ANIM_MS));
  const eased = easeOutCubic(t);

  waveCtx.clearRect(0, 0, W, H);

  const curPlayheadX = anim.oldPlayheadX + (anim.newPlayheadX - anim.oldPlayheadX) * eased;
  const edgeWidth = SEGMENT_EDGE_WIDTH_CSS_PX * dpr;

  for (const s of slides) {
    const curStart = s.oldSb.drawStart + (s.newSb.drawStart - s.oldSb.drawStart) * eased;
    const curEnd = s.oldSb.drawEnd + (s.newSb.drawEnd - s.oldSb.drawEnd) * eased;
    drawSlideCard(waveCtx, s, curStart, curEnd, curPlayheadX, H, dpr, edgeWidth);
  }

  if (snap && tiles.length > 0) {
    const tileElapsedMs = anim.reverseTiles ? SEGMENT_DELETE_ANIM_MS - elapsedMs : elapsedMs;
    drawShatterTiles(waveCtx, snap, tiles, tileElapsedMs, dpr);
  }
}

export function prepareCanvasForAnim() {
  const dpr = window.devicePixelRatio || 1;
  const rect = el.waveformCanvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * dpr));
  const H = Math.max(1, Math.floor(rect.height * dpr));
  if (el.waveformCanvas.width !== W) el.waveformCanvas.width = W;
  if (el.waveformCanvas.height !== H) el.waveformCanvas.height = H;
  return { dpr, W, H };
}

export function captureCanvasRegionForIndex(sb, W, H, dpr, minX, maxX) {
  return captureCanvasRegion(sb, W, H, dpr, minX, maxX);
}
