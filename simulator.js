const horizonSelect = document.getElementById('horizon');
const excludeSalary = document.getElementById('exclude-salary');
const excludeFood = document.getElementById('exclude-food');
const supplementWeekly = document.getElementById('supplement-weekly');
const cutCategory = document.getElementById('cut-category');
const cutPercent = document.getElementById('cut-percent');
const canvas = document.getElementById('simulator-chart');
const simulatorChartMessage = document.getElementById('simulator-chart-message');
const summarySection = document.getElementById('simulator-summary');
const summaryList = document.getElementById('simulator-summary-list');
const legendEl = document.getElementById('simulator-legend');

const presetJobLoss = document.getElementById('preset-job-loss');
const presetSupplement = document.getElementById('preset-supplement');
const presetReset = document.getElementById('preset-reset');

function getCategoryCuts() {
  const cat = cutCategory.value;
  const pct = parseFloat(cutPercent.value);
  if (!cat || Number.isNaN(pct) || pct <= 0) return {};
  return { [cat]: Math.min(100, Math.max(0, pct)) / 100 };
}

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '$0.00';
  const sign = x < 0 ? '-' : '';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function formatChartInterceptDate(d) {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sameCalendarDay(a, b) {
  if (!a || !b || !(a instanceof Date) || !(b instanceof Date)) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function drawProjectionChart(
  ctx,
  labels,
  baseline,
  scenario,
  chartCanvas,
  baselineDepletedOn,
  scenarioDepletedOn,
  baselineDepletedChartX,
  scenarioDepletedChartX
) {
  const width = chartCanvas.clientWidth;
  const height = chartCanvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = width * dpr;
  chartCanvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 36, right: 28, bottom: 52, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const H = labels.length;
  const all = [...baseline, ...scenario];
  const minValue = 0;
  let maxValue = Math.max(0, ...all);
  if (maxValue === 0) maxValue = 1;
  const range = maxValue - minValue || 1;
  const stepX = chartWidth / Math.max(H - 1, 1);

  function yFor(v) {
    return padding.top + chartHeight - ((v - minValue) / range) * chartHeight;
  }

  const yZero = yFor(0);

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(padding.left, padding.top, chartWidth, chartHeight);

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padding.left, yZero);
  ctx.lineTo(padding.left + chartWidth, yZero);
  ctx.stroke();

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    if (Math.abs(y - yZero) < 1) continue;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#475569';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i += 1) {
    const value = minValue + ((4 - i) / 4) * range;
    const y = padding.top + (chartHeight / 4) * i;
    ctx.fillText(`$${value.toFixed(0)}`, padding.left - 10, y + 4);
  }

  function xAtSeriesIndex(plotIndex) {
    return padding.left + stepX * plotIndex;
  }

  function drawSeries(values, strokeStyle, fillAlpha, depletedChartX) {
    if (values.length === 0) return;

    const bottom = padding.top + chartHeight;
    const useFractionalEnd =
      depletedChartX != null &&
      Number.isFinite(depletedChartX) &&
      values.length >= 2 &&
      values[values.length - 1] === 0;

    const lastX = useFractionalEnd
      ? padding.left + stepX * depletedChartX
      : xAtSeriesIndex(values.length - 1);

    function xForPoint(index) {
      if (useFractionalEnd && index === values.length - 1) {
        return lastX;
      }
      return xAtSeriesIndex(index);
    }

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xForPoint(index);
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = fillAlpha;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xForPoint(index);
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(lastX, bottom);
    ctx.lineTo(padding.left, bottom);
    ctx.closePath();
    ctx.fill();
  }

  drawSeries(
    baseline,
    'rgba(100, 116, 139, 0.9)',
    'rgba(100, 116, 139, 0.12)',
    baselineDepletedChartX
  );
  drawSeries(
    scenario,
    'rgba(37, 99, 235, 0.9)',
    'rgba(37, 99, 235, 0.14)',
    scenarioDepletedChartX
  );

  const baseXF = baselineDepletedChartX;
  const scenXF = scenarioDepletedChartX;
  const sameDepletionSpot =
    baseXF !== null &&
    scenXF !== null &&
    Math.abs(baseXF - scenXF) < 1e-6;

  function clampDepletionX(x) {
    return Math.min(Math.max(x, padding.left), padding.left + chartWidth);
  }

  function drawSharedDepletionVLine(xPixel) {
    const x = clampDepletionX(xPixel);
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawDepletionMarker(xPixel, seriesIsBaseline) {
    const x = clampDepletionX(xPixel);
    let markerY = yZero;
    if (sameDepletionSpot) {
      markerY = yZero + (seriesIsBaseline ? -8 : 8);
    }
    ctx.beginPath();
    ctx.arc(x, markerY, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = seriesIsBaseline ? '#64748b' : '#2563eb';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    return { x, markerY };
  }

  function drawInterceptLabel(x, y, text, color, textBaselineMode) {
    if (!text) return;
    ctx.save();
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = textBaselineMode || 'bottom';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  if (sameDepletionSpot) {
    const xPix = padding.left + stepX * baseXF;
    drawSharedDepletionVLine(xPix);
    const b = drawDepletionMarker(xPix, true);
    const s = drawDepletionMarker(xPix, false);
    const baseLabel = formatChartInterceptDate(baselineDepletedOn);
    const scenLabel = formatChartInterceptDate(scenarioDepletedOn);
    if (baseLabel && scenLabel && sameCalendarDay(baselineDepletedOn, scenarioDepletedOn)) {
      drawInterceptLabel(b.x, Math.min(b.markerY, s.markerY) - 12, baseLabel, '#0f172a', 'bottom');
    } else {
      if (baseLabel) {
        drawInterceptLabel(b.x, b.markerY - 12, baseLabel, '#475569', 'bottom');
      }
      if (scenLabel) {
        drawInterceptLabel(s.x, s.markerY + 14, scenLabel, '#1d4ed8', 'top');
      }
    }
  } else {
    if (baseXF !== null) {
      const xPix = padding.left + stepX * baseXF;
      drawSharedDepletionVLine(xPix);
      const { x, markerY } = drawDepletionMarker(xPix, true);
      const baseLabel = formatChartInterceptDate(baselineDepletedOn);
      if (baseLabel) {
        drawInterceptLabel(x, markerY - 12, baseLabel, '#475569', 'bottom');
      }
    }
    if (scenXF !== null) {
      const xPix = padding.left + stepX * scenXF;
      drawSharedDepletionVLine(xPix);
      const { x, markerY } = drawDepletionMarker(xPix, false);
      const scenLabel = formatChartInterceptDate(scenarioDepletedOn);
      if (scenLabel) {
        drawInterceptLabel(x, markerY - 12, scenLabel, '#1d4ed8', 'bottom');
      }
    }
  }

  ctx.fillStyle = '#0f172a';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(labels.length / 8));
  labels.forEach((label, index) => {
    if (index % labelStep !== 0 && index !== labels.length - 1) return;
    const x = padding.left + stepX * index;
    ctx.fillText(label, x, height - 20);
  });
}

function populateCategoryOptions(categories) {
  const current = cutCategory.value;
  cutCategory.innerHTML = '<option value="">— None —</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    cutCategory.appendChild(opt);
  });
  if (categories.includes(current)) {
    cutCategory.value = current;
  }
}

function render() {
  const expenses = window.ExpenseProjection.loadExpenses();
  const result = window.ExpenseProjection.buildProjection({
    expenses,
    horizonMonths: Number(horizonSelect.value),
    excludeSalary: excludeSalary.checked,
    excludeFood: excludeFood.checked,
    supplementWeekly: parseFloat(supplementWeekly.value) || 0,
    categoryCuts: getCategoryCuts(),
  });

  if (result.error) {
    simulatorChartMessage.textContent = result.error;
    summarySection.hidden = true;
    if (legendEl) legendEl.style.visibility = 'hidden';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  populateCategoryOptions(result.expenseCategories);

  simulatorChartMessage.textContent = `Based on ${result.monthsUsed} month${
    result.monthsUsed === 1 ? '' : 's'
  } of data in the last ~12 months. The leftmost point is today (current balance); later points are month-ends. Each path stops at $0 (dashed line and marker) if cash runs out before the horizon. The calendar day for $0 is interpolated within that month assuming smooth cashflow—not your real transaction dates.`;
  if (legendEl) legendEl.style.visibility = 'visible';

  const ctx = canvas.getContext('2d');
  drawProjectionChart(
    ctx,
    result.monthLabels,
    result.baselineBalances,
    result.scenarioBalances,
    canvas,
    result.baselineDepletedOn,
    result.scenarioDepletedOn,
    result.baselineDepletedChartX,
    result.scenarioDepletedChartX
  );

  summarySection.hidden = false;
  const endBase = result.baselineBalances[result.baselineBalances.length - 1];
  const endScen = result.scenarioBalances[result.scenarioBalances.length - 1];

  function formatEstimateDepletionDate(depletedOn) {
    if (!depletedOn || !(depletedOn instanceof Date) || Number.isNaN(depletedOn.getTime())) {
      return '';
    }
    return depletedOn.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function depletionSummaryLine(depletedAtIndex, depletedOn, monthLabel) {
    if (depletedAtIndex === null) return 'Stays above $0 (within horizon)';
    const datePart = formatEstimateDepletionDate(depletedOn);
    if (datePart) return `Hits $0: ${datePart} (estimate)`;
    return `Hits $0: ${monthLabel}`;
  }

  summaryList.innerHTML = '';
  const items = [
    ['Starting balance', formatMoney(result.startingBalance)],
    ['Baseline avg monthly net', formatMoney(result.averageNetBaseline)],
    ['Scenario avg monthly net', formatMoney(result.averageNetScenario)],
    [
      'Baseline $0',
      depletionSummaryLine(
        result.baselineDepletedAtIndex,
        result.baselineDepletedOn,
        result.monthLabels[result.baselineDepletedAtIndex]
      ),
    ],
    [
      'Scenario $0',
      depletionSummaryLine(
        result.scenarioDepletedAtIndex,
        result.scenarioDepletedOn,
        result.monthLabels[result.scenarioDepletedAtIndex]
      ),
    ],
    ['End balance (baseline)', formatMoney(endBase)],
    ['End balance (scenario)', formatMoney(endScen)],
  ];
  items.forEach(([k, v]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="summary-key">${k}</span><span class="summary-val">${v}</span>`;
    summaryList.appendChild(li);
  });
}

function wireEvents() {
  [
    horizonSelect,
    excludeSalary,
    excludeFood,
    supplementWeekly,
    cutCategory,
    cutPercent,
  ].forEach(el => el.addEventListener('change', render));
  supplementWeekly.addEventListener('input', render);
  cutPercent.addEventListener('input', render);

  presetJobLoss.addEventListener('click', () => {
    excludeSalary.checked = true;
    render();
  });

  presetSupplement.addEventListener('click', () => {
    supplementWeekly.value = '100';
    render();
  });

  presetReset.addEventListener('click', () => {
    excludeSalary.checked = false;
    excludeFood.checked = false;
    supplementWeekly.value = '0';
    cutCategory.value = '';
    cutPercent.value = '0';
    render();
  });

  window.addEventListener('resize', () => {
    const simView = document.getElementById('view-simulator');
    if (simView && simView.hidden) return;
    render();
  });
}

wireEvents();
window.refreshExpenseSimulator = render;

(function routeSimulatorView() {
  const tracker = document.getElementById('view-tracker');
  const simView = document.getElementById('view-simulator');
  if (!tracker || !simView) {
    render();
    return;
  }

  function applyView() {
    const show = window.location.hash === '#simulator';
    tracker.hidden = show;
    simView.hidden = !show;
    document.title = show ? 'Balance simulator — Expense Tracker' : 'Simple Expense Tracker';
    if (show) render();
  }

  window.addEventListener('hashchange', applyView);

  document.querySelector('.header-simulator-link')?.addEventListener('click', e => {
    e.preventDefault();
    if (window.location.hash === '#simulator') return;
    window.location.hash = 'simulator';
  });

  document.querySelector('.header-back-link')?.addEventListener('click', e => {
    e.preventDefault();
    window.location.hash = '';
  });

  applyView();
})();
