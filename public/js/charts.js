// 原生 SVG 圖表，不依賴外部 CDN。未知月份使用 null，折線在缺口斷開。
import { money, seriesStats } from './calc.js';
import { esc } from './html.js';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function path(values, x, y) {
  let started = false;
  return values.map((v, i) => {
    if (!finite(v)) { started = false; return ''; }
    const command = started ? 'L' : 'M'; started = true;
    return `${command}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
  }).filter(Boolean).join(' ');
}

function coordinates(count, values, cumulative) {
  const width = Math.max(680, count * 48 + 120), height = 260;
  const left = 74, right = cumulative ? 88 : 24, top = 36, bottom = 57;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const known = values.filter(finite);
  const min = Math.min(0, ...known), max = Math.max(1, ...known);
  const upper = max * 1.15, lower = min < 0 ? min * 1.15 : 0;
  const x = (i) => left + plotWidth * (i + .5) / Math.max(1, count);
  const y = (v) => top + plotHeight * (upper - v) / (upper - lower);
  return { width, height, left, right, top, bottom, plotWidth, plotHeight, x, y, upper, lower };
}

/** 文字靠近圖的左右邊緣時改成貼齊邊緣，避免被裁掉。 */
function labelAt(c, x) {
  if (x > c.width - c.right - 60) return `x="${c.width - c.right}" text-anchor="end"`;
  if (x < c.left + 60) return `x="${c.left}" text-anchor="start"`;
  return `x="${x}" text-anchor="middle"`;
}

function cumulativeScale(values, c) {
  const known = values.filter(finite);
  const upper = Math.max(1, ...known) * 1.15, lower = Math.min(0, ...known) * 1.15;
  return { upper, lower, y: (v) => c.top + c.plotHeight * (upper - v) / (upper - lower) };
}

function frame(c, points, body, id, cumulativeAxis = null) {
  const { width: w, height: h, left, right, top, bottom, plotHeight, x, y, upper, lower } = c;
  const step = Math.max(1, Math.ceil(points.length / 14));
  const grids = Array.from({ length: 5 }, (_, i) => {
    const value = upper - (upper - lower) * i / 4;
    return `<line x1="${left}" x2="${w - right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" class="chart-axis-text">${money(value)}</text>`;
  }).join('');
  const axis = points.map((p, i) => i % step === 0 || i === points.length - 1
    ? `<text x="${x(i)}" y="${h - bottom + 24}" text-anchor="middle" class="chart-axis-text">${esc(p.label)}</text>` : '').join('');
  const hits = points.map((p, i) => `<g id="${id}-point-${i}" tabindex="0" role="button" aria-label="${esc(p.label)}明細" data-chart-id="${id}" data-chart-point="${i}" class="chart-point"><title>${esc(p.label)}：${finite(p.total) ? money(p.total) + ' 元' : p.note || '尚無資料'}</title><rect x="${x(i) - c.plotWidth / Math.max(1, points.length) / 2}" y="${top}" width="${c.plotWidth / Math.max(1, points.length)}" height="${plotHeight}" fill="transparent"/></g>`).join('');
  const secondary = cumulativeAxis === null ? '' : Array.from({ length: 5 }, (_, i) =>
    `<text x="${w - right + 10}" y="${top + plotHeight * i / 4 + 4}" class="chart-axis-text chart-cumulative-text">${money(cumulativeAxis.upper - (cumulativeAxis.upper - cumulativeAxis.lower) * i / 4)}</text>`).join('');
  return `<div class="chart-scroll" tabindex="0" aria-label="可左右捲動${id === 'monthly' ? '每月支出' : '趨勢'}圖"><svg class="billing-chart-svg" viewBox="0 0 ${w} ${h}" style="min-width:${w}px" role="img" aria-label="${esc(id)}圖表">
    ${cumulativeAxis === null ? '' : `<text x="${w - right}" y="18" class="chart-axis-text chart-cumulative-text">累積（右軸）</text>`}
    ${grids}<line x1="${left}" x2="${w - right}" y1="${y(0)}" y2="${y(0)}" class="chart-zero"/>${body}${axis}${secondary}${hits}</svg></div>`;
}

export function stackedChart(points, groups, options) {
  const values = points.map((p) => p.available && groups.length && groups.every((g) => finite(p.values[g.key]))
    ? groups.reduce((sum, g) => sum + p.values[g.key], 0) : null);
  const stats = seriesStats(values, options.annual ? points.map((p) => p.complete) : null);
  const positive = points.map((p, i) => finite(values[i]) ? groups.reduce((s, g) => s + Math.max(0, p.values[g.key]), 0) : null);
  const negative = points.map((p, i) => finite(values[i]) ? groups.reduce((s, g) => s + Math.min(0, p.values[g.key]), 0) : null);
  const c = coordinates(points.length, [...positive, ...negative, options.average ? stats.average : null], options.cumulative);
  const barWidth = Math.min(44, c.plotWidth / Math.max(1, points.length) * .68);
  let body = points.map((p, i) => {
    if (!finite(values[i])) return '';
    let above = 0, below = 0;
    return groups.map((g) => {
      const v = p.values[g.key];
      const base = v >= 0 ? above : below;
      if (v >= 0) above += v; else below += v;
      return v === 0 ? '' : `<rect class="chart-stack-segment" data-stack-key="${g.key}" data-stack-value="${v}" data-point="${i}" x="${c.x(i) - barWidth / 2}" y="${Math.min(c.y(base), c.y(base + v))}" width="${barWidth}" height="${Math.abs(c.y(base) - c.y(base + v))}" fill="${g.color}" rx="2"/>`;
    }).join('');
  }).join('');
  if (options.average && finite(stats.average)) body += `<line class="chart-average-line" data-value="${stats.average}" x1="${c.left}" x2="${c.width - c.right}" y1="${c.y(stats.average)}" y2="${c.y(stats.average)}"/><text x="${c.left + 10}" y="${Math.max(c.top + 14, c.y(stats.average) - 8)}" class="chart-line-label">${options.annual ? '年均' : '月均'} ${money(stats.average)}</text>`;
  const cumulativeAxis = options.cumulative ? cumulativeScale(stats.cumulative, c) : null;
  if (options.cumulative) {
    body += `<path class="chart-cumulative-path" data-values="${esc(JSON.stringify(stats.cumulative))}" d="${path(stats.cumulative, c.x, cumulativeAxis.y)}"/>`;
  }
  if (options.extrema) {
    for (const [label, entries] of [['最高', stats.highest], ['最低', stats.lowest]]) {
      // 同額月份只標示第一個，避免整排文字擠在一起。
      for (const p of entries.slice(0, 1)) body += `<text ${labelAt(c, c.x(p.index))} y="${Math.max(c.top + 14, c.y(positive[p.index]) - (label === '最高' ? 9 : 23))}" class="chart-extreme" data-extreme="${label}">${label} ${money(p.value)}</text>`;
    }
  }
  const tooltip = (i) => {
    const p = points[i]; if (!p) return '';
    return `<strong>${esc(p.label)}</strong><span>${esc(p.note || '')}</span>${finite(values[i]) ? groups.map((g) => `<span><i class="dot" style="background:${g.color}"></i>${esc(g.name)} ${money(p.values[g.key])}</span>`).join('') + `<b>所選分類合計 ${money(values[i])}</b>${options.cumulative ? `<span>區間累積 ${money(stats.cumulative[i])}</span>` : ''}` : '<span>尚無已入帳數據</span>'}`;
  };
  return { html: frame(c, points, body, options.id, cumulativeAxis), tooltip, stats, values };
}

export function lineChart(points, series, options) {
  const stats = series.map((s) => seriesStats(s.values));
  const all = series.flatMap((s) => s.values);
  const c = coordinates(points.length, [...all, ...(options.average ? stats.map((s) => s.average) : [])], options.cumulative);
  const cumulativeAxis = options.cumulative ? cumulativeScale(stats.flatMap((s, i) => series[i].isBalance ? [] : s.cumulative), c) : null;
  let body = series.map((s, index) => {
    let drawing = `<path class="chart-item-line" data-series="${esc(s.key)}" stroke="${s.color}" d="${path(s.values, c.x, c.y)}"/>`;
    s.values.forEach((v, i) => { if (finite(v)) drawing += `<circle cx="${c.x(i)}" cy="${c.y(v)}" r="3" fill="${s.color}"/>`; });
    if (options.average && finite(stats[index].average)) drawing += `<line class="chart-average-line" data-value="${stats[index].average}" style="stroke:${s.color}" x1="${c.left}" x2="${c.width - c.right}" y1="${c.y(stats[index].average)}" y2="${c.y(stats[index].average)}"/>`;
    if (options.cumulative && !s.isBalance) drawing += `<path class="chart-item-cumulative" stroke="${s.color}" d="${path(stats[index].cumulative, c.x, cumulativeAxis.y)}"/>`;
    if (options.extrema) {
      for (const [label, entries] of [['最高', stats[index].highest], ['最低', stats[index].lowest]]) {
        for (const p of entries.slice(0, 1)) drawing += `<text ${labelAt(c, c.x(p.index))} y="${Math.max(c.top + 14, c.y(p.value) - (label === '最高' ? 10 : 24) - index * 14)}" class="chart-extreme" style="fill:${s.color}" data-extreme="${label}">${label} ${money(p.value)}</text>`;
      }
    }
    return drawing;
  }).join('');
  const tooltip = (i) => `<strong>${esc(points[i]?.label)}</strong>${series.map((s, j) => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}：${finite(s.values[i]) ? money(s.values[i]) : '—'}${options.cumulative && !s.isBalance && finite(stats[j].cumulative[i]) ? ` · 累積 ${money(stats[j].cumulative[i])}` : ''}</span>`).join('')}`;
  const empty = !series.length ? '<p class="empty">請選擇要比較的細項。</p>' : '';
  return { html: empty || frame(c, points, body, options.id, cumulativeAxis), tooltip, stats };
}
