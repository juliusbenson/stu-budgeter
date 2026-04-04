const expenseForm = document.getElementById('expense-form');
const expenseBody = document.getElementById('expense-body');
const totalIncome = document.getElementById('total-income');
const totalExpenses = document.getElementById('total-expenses');
const balanceDisplay = document.getElementById('balance');
const expenseCount = document.getElementById('expense-count');
const emptyMessage = document.getElementById('empty-message');
const csvFileInput = document.getElementById('csv-file');
const importButton = document.getElementById('import-btn');
const exportButton = document.getElementById('export-btn');
const reportButton = document.getElementById('report-btn');
const reportMessage = document.getElementById('report-message');
const reportChart = document.getElementById('report-chart');
const reportChartMessage = document.getElementById('report-chart-message');
const balanceChart = document.getElementById('balance-chart');
const pieChart = document.getElementById('pie-chart');
const timeframeButtons = document.querySelectorAll('.timeframe-btn');
const chartMessage = document.getElementById('chart-message');
const pieChartMessage = document.getElementById('pie-chart-message');
const importMessage = document.getElementById('import-message');
const reportServerUrlInput = document.getElementById('report-server-url');
const reportSubmitBtn = document.getElementById('report-submit-btn');

const STORAGE_KEY = 'simple-expense-tracker-expenses';
const REPORT_SERVER_STORAGE_KEY = 'simple-expense-tracker-report-server-url';
const DEFAULT_CHART_MONTHS = 3;

function normalizeReportServerBaseUrl(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  return t.replace(/\/+$/, '');
}
let chartMonths = DEFAULT_CHART_MONTHS;

timeframeButtons.forEach(button => {
  button.addEventListener('click', () => {
    chartMonths = Number(button.dataset.months);
    timeframeButtons.forEach(btn => btn.classList.toggle('active', btn === button));
    renderChart();
  });
});

let expenses = loadExpenses();
renderExpenses();

if (reportServerUrlInput) {
  const savedUrl = localStorage.getItem(REPORT_SERVER_STORAGE_KEY);
  if (savedUrl) {
    reportServerUrlInput.value = savedUrl;
  }
  reportServerUrlInput.addEventListener('change', () => {
    const v = normalizeReportServerBaseUrl(reportServerUrlInput.value);
    if (v) {
      localStorage.setItem(REPORT_SERVER_STORAGE_KEY, v);
    }
  });
}

expenseForm.addEventListener('submit', event => {
  event.preventDefault();

  const description = document.getElementById('description').value.trim();
  const amount = parseFloat(document.getElementById('amount').value);
  const date = document.getElementById('date').value;
  const type = document.getElementById('type').value;
  const category = document.getElementById('category').value;

  if (!description || !date || Number.isNaN(amount) || amount <= 0 || !type) {
    return;
  }

  const expense = {
    id: Date.now().toString(),
    description,
    amount,
    type,
    date,
    category,
  };

  expenses.unshift(expense);
  saveExpenses(expenses);
  renderExpenses();
  expenseForm.reset();
  importMessage.textContent = '';
  document.getElementById('date').valueAsDate = new Date();
});

importButton.addEventListener('click', () => {
  const file = csvFileInput.files[0];
  importMessage.textContent = '';

  if (!file) {
    importMessage.textContent = 'Please choose a CSV file to import.';
    return;
  }

  const reader = new FileReader();
  reader.onload = event => {
    try {
      const imported = parseCsv(String(event.target.result));
      if (imported.length === 0) {
        importMessage.textContent = 'No valid expense rows were found in the CSV file.';
        return;
      }

      expenses = [...imported, ...expenses];
      saveExpenses(expenses);
      renderExpenses();
      importMessage.textContent = `Imported ${imported.length} transaction${imported.length === 1 ? '' : 's'} successfully.`;
      csvFileInput.value = '';
    } catch (error) {
      importMessage.textContent = `CSV import failed: ${error.message}`;
    }
  };
  reader.onerror = () => {
    importMessage.textContent = 'Unable to read the selected file.';
  };
  reader.readAsText(file);
});

exportButton.addEventListener('click', () => {
  if (expenses.length === 0) {
    importMessage.textContent = 'No transactions to export.';
    return;
  }

  const header = ['description', 'amount', 'date', 'category', 'type'];
  const rows = expenses.map(expense => [
    escapeCsv(expense.description),
    expense.amount.toFixed(2),
    expense.date,
    escapeCsv(expense.category),
    escapeCsv(expense.type || 'Expense'),
  ]);

  const csvText = [header, ...rows].map(row => row.join(',')).join('\n');
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'expenses-export.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  importMessage.textContent = `Exported ${expenses.length} transaction${expenses.length === 1 ? '' : 's'}.`;
});

async function buildCashflowReportPayload() {
  const rows = getAnonymizedReportRows();
  if (rows.length === 0) {
    return {
      error: 'No eligible records are available for the last 12 months.',
    };
  }

  const balance = expenses.reduce((sum, expense) => {
    return sum + (expense.type === 'Income' ? expense.amount : -expense.amount);
  }, 0);
  const roundedBalance = Math.round(balance / 100) * 100;

  const header = ['month', 'type', 'category', 'amount'];
  const csvRows = [...rows, ['', 'Balance', 'Current balance', roundedBalance.toFixed(2)]];
  const csvText = [header, ...csvRows].map(row => row.map(escapeCsv).join(',')).join('\n');
  const fingerprint = await computeSha1Hex(csvText, 10);
  const filename = `cashflow-report-${fingerprint}.csv`;
  return { csvText, filename, rowCount: rows.length };
}

reportButton?.addEventListener('click', async () => {
  const payload = await buildCashflowReportPayload();
  if ('error' in payload) {
    reportMessage.textContent = payload.error;
    return;
  }

  downloadCsv(payload.csvText, payload.filename);
  reportMessage.textContent = `Report generated with ${payload.rowCount} monthly category rows plus current balance.`;
});

reportSubmitBtn?.addEventListener('click', async () => {
  const payload = await buildCashflowReportPayload();
  if ('error' in payload) {
    reportMessage.textContent = payload.error;
    return;
  }

  const base = normalizeReportServerBaseUrl(reportServerUrlInput?.value);
  if (!base) {
    reportMessage.textContent = 'Enter a report server URL.';
    return;
  }

  localStorage.setItem(REPORT_SERVER_STORAGE_KEY, base);
  if (reportServerUrlInput) {
    reportServerUrlInput.value = base;
  }

  try {
    const res = await fetch(`${base}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: payload.csvText,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* ignore non-JSON */
    }
    if (!res.ok) {
      reportMessage.textContent = data.error || `Upload failed (${res.status}).`;
      return;
    }
    reportMessage.textContent =
      data.message === 'Already stored'
        ? 'Report already on server (unchanged).'
        : `Report uploaded: ${data.filename}.`;
  } catch (err) {
    reportMessage.textContent = `Upload failed: ${err.message}`;
  }
});

function loadExpenses() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (error) {
    console.warn('Could not load expenses:', error);
    return [];
  }
}

function saveExpenses(data) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function renderExpenses() {
  expenseBody.innerHTML = '';

  if (expenses.length === 0) {
    emptyMessage.style.display = 'block';
    totalExpenses.textContent = '$0.00';
    totalIncome.textContent = '$0.00';
    balanceDisplay.textContent = '$0.00';
    expenseCount.textContent = '0';
    renderChart();
    renderPieChart();
    return;
  }

  emptyMessage.style.display = 'none';

  let totalIncomeValue = 0;
  let totalExpensesValue = 0;
  const sortedExpenses = [...expenses].sort((a, b) => new Date(a.date) - new Date(b.date));

  sortedExpenses.forEach(expense => {
    if (expense.type === 'Income') {
      totalIncomeValue += expense.amount;
    } else {
      totalExpensesValue += expense.amount;
    }

    const row = document.createElement('tr');

    const amountClass = expense.type === 'Income' ? 'amount-income' : 'amount-expense';
    row.innerHTML = `
      <td>${escapeHtml(expense.description)}</td>
      <td>${escapeHtml(expense.type)}</td>
      <td>${escapeHtml(expense.category)}</td>
      <td>${formatDate(expense.date)}</td>
      <td class="${amountClass}">$${expense.amount.toFixed(2)}</td>
      <td><button class="delete-btn" data-id="${expense.id}">Delete</button></td>
    `;

    expenseBody.appendChild(row);
  });

  totalExpenses.textContent = `$${totalExpensesValue.toFixed(2)}`;
  totalIncome.textContent = `$${totalIncomeValue.toFixed(2)}`;
  const balance = totalIncomeValue - totalExpensesValue;
  balanceDisplay.textContent = `$${balance.toFixed(2)}`;
  expenseCount.textContent = `${expenses.length}`;
  renderChart();
  renderPieChart();
  renderReportChart();
}

function renderChart() {
  if (!balanceChart) return;

  const { labels, values, movingAverage } = getBalanceSeries(chartMonths);
  const ctx = balanceChart.getContext('2d');

  if (values.length === 0) {
    chartMessage.textContent = 'No transactions yet.';
    ctx.clearRect(0, 0, balanceChart.width, balanceChart.height);
    return;
  }

  chartMessage.textContent = `Showing daily balance and 30-day moving average for the last ${chartMonths} month${chartMonths === 1 ? '' : 's'}.`;
  drawBalanceChart(ctx, labels, values, movingAverage, balanceChart);
}

function renderPieChart() {
  if (!pieChart) return;

  const { categories, values } = getExpenseBreakdown();
  const ctx = pieChart.getContext('2d');

  if (values.length === 0) {
    pieChartMessage.textContent = 'No expense categories available yet.';
    ctx.clearRect(0, 0, pieChart.width, pieChart.height);
    return;
  }

  pieChartMessage.textContent = 'Expense categories as a share of total spending.';
  drawPieChart(ctx, categories, values, pieChart);
}

function renderReportChart() {
  if (!reportChart) return;

  const { monthLabels, spendingCategories, incomeCategories, categories, valuesByCategory } = getMonthlyCashflowBreakdown();
  const ctx = reportChart.getContext('2d');

  if (categories.length === 0) {
    reportChartMessage.textContent = 'No recent cashflow records available yet.';
    ctx.clearRect(0, 0, reportChart.width, reportChart.height);
    return;
  }

  reportChartMessage.textContent = 'Monthly spending and income category breakdowns for the last 12 months.';
  drawReportChart(ctx, monthLabels, spendingCategories, incomeCategories, categories, valuesByCategory, reportChart);
}

function getMonthlyCashflowBreakdown() {
  const records12 = getLastTwelveMonthsRecords();
  const monthLabels = [];
  const monthKeys = [];
  const monthCursor = new Date();
  monthCursor.setDate(1);
  monthCursor.setHours(0, 0, 0, 0);
  monthCursor.setMonth(monthCursor.getMonth() - 11);

  for (let i = 0; i < 12; i += 1) {
    const key = `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, '0')}`;
    monthKeys.push(key);
    monthLabels.push(monthCursor.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }

  const monthTotals = monthKeys.reduce((acc, key) => {
    acc[key] = { income: {}, spending: {} };
    return acc;
  }, {});

  const incomeCategoryTotals = {};
  const spendingCategoryTotals = {};

  records12.forEach(item => {
    const date = new Date(item.date);
    if (Number.isNaN(date)) return;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthTotals[key]) return;

    if (item.type === 'Income') {
      monthTotals[key].income[item.category] = (monthTotals[key].income[item.category] || 0) + item.amount;
      incomeCategoryTotals[item.category] = (incomeCategoryTotals[item.category] || 0) + item.amount;
    } else {
      monthTotals[key].spending[item.category] = (monthTotals[key].spending[item.category] || 0) + item.amount;
      spendingCategoryTotals[item.category] = (spendingCategoryTotals[item.category] || 0) + item.amount;
    }
  });

  const spendingCategories = Object.keys(spendingCategoryTotals).sort((a, b) => spendingCategoryTotals[b] - spendingCategoryTotals[a]);
  const incomeCategories = Object.keys(incomeCategoryTotals).sort((a, b) => incomeCategoryTotals[b] - incomeCategoryTotals[a]);
  const categories = [...spendingCategories, ...incomeCategories];

  const valuesByCategory = categories.map(category => {
    const isIncome = incomeCategories.includes(category);
    const source = isIncome ? 'income' : 'spending';
    return monthKeys.map(key => monthTotals[key][source][category] || 0);
  });

  return { monthLabels, spendingCategories, incomeCategories, categories, valuesByCategory };
}

function drawReportChart(ctx, monthLabels, spendingCategories, incomeCategories, categories, valuesByCategory, canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 40, right: 24, bottom: 72, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const monthCount = monthLabels.length;
  const slotWidth = chartWidth / monthCount;
  const groupWidth = Math.min(120, slotWidth * 0.8);
  const gap = 10;
  const barWidth = Math.min(32, (groupWidth - gap) / 2);
  const spendingColors = ['#ef4444', '#f97316', '#f59e0b', '#be123c', '#a855f7', '#7c3aed', '#1d4ed8'];
  const incomeColors = ['#10b981', '#22c55e', '#14b8a6', '#0f766e', '#047857'];

  const monthMax = monthLabels.map((_, monthIndex) => {
    const spendingTotal = spendingCategories.reduce((sum, _, seriesIndex) => sum + valuesByCategory[seriesIndex][monthIndex], 0);
    const incomeTotal = incomeCategories.reduce((sum, _, seriesIndex) => sum + valuesByCategory[spendingCategories.length + seriesIndex][monthIndex], 0);
    return Math.max(spendingTotal, incomeTotal);
  });
  const dataMax = Math.max(1, ...monthMax);

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const y = padding.top + (chartHeight / 4) * line;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#475569';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let line = 0; line <= 4; line += 1) {
    const value = ((4 - line) / 4) * dataMax;
    const y = padding.top + (chartHeight / 4) * line;
    ctx.fillText(`$${value.toFixed(0)}`, padding.left - 10, y + 4);
  }

  monthLabels.forEach((_, monthIndex) => {
    const groupStart = padding.left + slotWidth * monthIndex + (slotWidth - groupWidth) / 2;
    const spendingX = groupStart;
    const incomeX = groupStart + barWidth + gap;

    let spendingStackBottom = padding.top + chartHeight;
    spendingCategories.forEach((category, seriesIndex) => {
      const amount = valuesByCategory[seriesIndex][monthIndex];
      if (amount <= 0) return;
      const y = padding.top + chartHeight - (amount / dataMax) * chartHeight;
      const heightPx = spendingStackBottom - y;
      ctx.fillStyle = spendingColors[seriesIndex % spendingColors.length];
      ctx.fillRect(spendingX, y, barWidth, heightPx);
      spendingStackBottom = y;
    });

    let incomeStackBottom = padding.top + chartHeight;
    incomeCategories.forEach((category, seriesIndex) => {
      const amount = valuesByCategory[spendingCategories.length + seriesIndex][monthIndex];
      if (amount <= 0) return;
      const y = padding.top + chartHeight - (amount / dataMax) * chartHeight;
      const heightPx = incomeStackBottom - y;
      ctx.fillStyle = incomeColors[seriesIndex % incomeColors.length];
      ctx.fillRect(incomeX, y, barWidth, heightPx);
      incomeStackBottom = y;
    });
  });

  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.font = '12px Inter, system-ui, sans-serif';
  monthLabels.forEach((label, monthIndex) => {
    const x = padding.left + slotWidth * monthIndex + slotWidth / 2;
    ctx.fillText(label, x, padding.top + chartHeight + 24);
  });

  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'left';
  ctx.font = '12px Inter, system-ui, sans-serif';
  categories.forEach((category, index) => {
    const x = padding.left + (index % 3) * 220;
    const y = padding.top - 20 + Math.floor(index / 3) * 20;
    const isIncome = incomeCategories.includes(category);
    ctx.fillStyle = isIncome ? incomeColors[incomeCategories.indexOf(category) % incomeColors.length] : spendingColors[spendingCategories.indexOf(category) % spendingColors.length];
    ctx.fillRect(x, y - 10, 14, 14);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(category, x + 20, y + 4);
  });
}

function getExpenseBreakdown() {
  const totals = expenses.reduce((acc, item) => {
    if (item.type !== 'Expense') return acc;
    acc[item.category] = (acc[item.category] || 0) + item.amount;
    return acc;
  }, {});

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return {
    categories: sorted.map(([category]) => category),
    values: sorted.map(([_, value]) => value),
  };
}

function drawPieChart(ctx, categories, values, canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 24, right: 24, bottom: 24, left: 24 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const radius = Math.min(chartWidth, chartHeight) * 0.35;
  const centerX = padding.left + radius;
  const centerY = padding.top + chartHeight / 2;
  const total = values.reduce((sum, value) => sum + value, 0) || 1;

  const colors = ['#2563eb', '#f97316', '#10b981', '#8b5cf6', '#ef4444', '#f59e0b', '#3b82f6', '#14b8a6'];
  let startAngle = -Math.PI / 2;

  values.forEach((value, index) => {
    const sliceAngle = (value / total) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    startAngle = endAngle;
  });

  const legendX = padding.left + radius * 2 + 24;
  let legendY = padding.top + 16;
  ctx.font = '13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';

  categories.forEach((category, index) => {
    const value = values[index];
    const percentage = ((value / total) * 100).toFixed(0);

    ctx.fillStyle = colors[index % colors.length];
    ctx.fillRect(legendX, legendY - 8, 16, 16);

    ctx.fillStyle = '#0f172a';
    ctx.fillText(`${category}: $${value.toFixed(2)} (${percentage}%)`, legendX + 24, legendY + 4);
    legendY += 24;
  });
}

function getDateOnly(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getBalanceSeries(months) {
  const now = getDateOnly(new Date());
  const startDate = getDateOnly(new Date(now.getFullYear(), now.getMonth() - months + 1, 1));
  const sorted = [...expenses]
    .map(expense => ({ ...expense, dateOnly: getDateOnly(expense.date) }))
    .sort((a, b) => a.dateOnly - b.dateOnly);

  let runningBalance = 0;
  let transactionIndex = 0;

  while (transactionIndex < sorted.length && sorted[transactionIndex].dateOnly < startDate) {
    const transaction = sorted[transactionIndex];
    runningBalance += transaction.type === 'Income' ? transaction.amount : -transaction.amount;
    transactionIndex += 1;
  }

  const labels = [];
  const values = [];
  const dailyDates = [];
  let cursor = new Date(startDate);

  while (cursor <= now) {
    const currentDay = getDateOnly(cursor);

    while (transactionIndex < sorted.length && sorted[transactionIndex].dateOnly.getTime() === currentDay.getTime()) {
      const transaction = sorted[transactionIndex];
      runningBalance += transaction.type === 'Income' ? transaction.amount : -transaction.amount;
      transactionIndex += 1;
    }

    dailyDates.push(new Date(currentDay));
    values.push(runningBalance);
    labels.push(formatChartLabel(currentDay, months));
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    labels,
    values,
    movingAverage: computeMovingAverage(values, 30),
  };
}

function computeMovingAverage(values, windowSize) {
  const averages = [];
  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= windowSize) {
      sum -= values[index - windowSize];
    }
    const count = Math.min(index + 1, windowSize);
    averages.push(sum / count);
  }

  return averages;
}

function drawBalanceChart(ctx, labels, values, movingAverage, canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 24, right: 28, bottom: 52, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const allValues = [...values, ...movingAverage];
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(...allValues);
  const range = maxValue - minValue || 1;
  const stepX = chartWidth / Math.max(values.length - 1, 1);

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(padding.left, padding.top, chartWidth, chartHeight);

  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();

  values.forEach((value, index) => {
    const x = padding.left + stepX * index;
    const y = padding.top + chartHeight - ((value - minValue) / range) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(59, 130, 246, 0.14)';
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = padding.left + stepX * index;
    const y = padding.top + chartHeight - ((value - minValue) / range) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  movingAverage.forEach((value, index) => {
    const x = padding.left + stepX * index;
    const y = padding.top + chartHeight - ((value - minValue) / range) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#0f172a';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';

  const labelStep = Math.max(1, Math.floor(labels.length / 8));
  labels.forEach((label, index) => {
    if (index % labelStep !== 0 && index !== labels.length - 1) return;
    const x = padding.left + stepX * index;
    ctx.fillText(label, x, height - 20);
  });

  ctx.fillStyle = '#475569';
  ctx.textAlign = 'left';
  ctx.fillText(`Starting balance: $${values[0].toFixed(2)}`, padding.left, padding.top - 6);
  ctx.fillText(`Moving average window: 30 days`, padding.left, padding.top + 12);
}

function formatChartLabel(date, months) {
  if (months === 1) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

expenseBody.addEventListener('click', event => {
  if (!event.target.matches('.delete-btn')) return;

  const id = event.target.dataset.id;
  expenses = expenses.filter(expense => expense.id !== id);
  saveExpenses(expenses);
  renderExpenses();
});

function formatDate(value) {
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  const headers = lines[0]
    .split(',')
    .map(header => header.trim().toLowerCase());

  const expected = ['description', 'amount', 'date', 'category'];
  if (!expected.every(column => headers.includes(column))) {
    throw new Error('CSV header must include description, amount, date, and category columns.');
  }

  return lines.slice(1).reduce((items, line, index) => {
    const values = line.split(',').map(value => value.trim());
    const row = headers.reduce((entry, header, idx) => {
      entry[header] = values[idx] ?? '';
      return entry;
    }, {});

    const description = row.description || '';
    const amount = parseFloat(row.amount);
    const date = row.date || '';
    const category = row.category || 'Other';
    const type = /^income$/i.test(row.type || '') ? 'Income' : 'Expense';

    if (!description || !date || Number.isNaN(amount) || amount <= 0) {
      return items;
    }

    items.push({
      id: `${Date.now()}-${index}`,
      description,
      amount,
      type,
      date,
      category,
    });

    return items;
  }, []);
}

function escapeCsv(value) {
  const text = String(value).replace(/"/g, '""');
  return /[",\n]/.test(text) ? `"${text}"` : text;
}

async function computeSha1Hex(text, length = 10) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, length);
}

function downloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getLastTwelveMonthsExpenses() {
  const now = getDateOnly(new Date());
  const startDate = new Date(now);
  startDate.setFullYear(startDate.getFullYear() - 1);

  return expenses
    .filter(expense => expense.type !== 'Income')
    .filter(expense => {
      const expenseDate = getDateOnly(expense.date);
      return expenseDate >= startDate && expenseDate <= now;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getLastTwelveMonthsRecords() {
  const now = getDateOnly(new Date());
  const startDate = new Date(now);
  startDate.setFullYear(startDate.getFullYear() - 1);

  return expenses
    .filter(item => {
      const itemDate = getDateOnly(item.date);
      return itemDate >= startDate && itemDate <= now;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getAnonymizedReportRows() {
  const totals = {};

  getLastTwelveMonthsRecords().forEach(item => {
    const date = new Date(item.date);
    if (Number.isNaN(date)) return;

    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const type = item.type === 'Income' ? 'Income' : 'Expense';
    const category = item.category || 'Other';

    if (!totals[month]) {
      totals[month] = {};
    }
    if (!totals[month][type]) {
      totals[month][type] = {};
    }

    totals[month][type][category] = (totals[month][type][category] || 0) + item.amount;
  });

  const rows = [];
  Object.keys(totals).sort().forEach(month => {
    Object.keys(totals[month]).forEach(type => {
      Object.keys(totals[month][type]).sort().forEach(category => {
        rows.push([month, type, category, totals[month][type][category].toFixed(2)]);
      });
    });
  });

  return rows;
}

function formatReportDate(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Set default date to today for convenience
const dateInput = document.getElementById('date');
if (dateInput) {
  dateInput.valueAsDate = new Date();
}
