(function () {
  const STORAGE_KEY = 'simple-expense-tracker-expenses';

  function getDateOnly(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function loadExpenses() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  function computeCurrentBalance(expenses) {
    return expenses.reduce((sum, e) => {
      return sum + (e.type === 'Income' ? e.amount : -e.amount);
    }, 0);
  }

  function getLastTwelveMonthsRecords(expenses) {
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

  /**
   * Match Python plot_cashflow_reports.add_months (calendar month arithmetic).
   * @param {Date} sourceDate date at local midnight
   * @param {number} monthsDelta
   * @returns {Date}
   */
  function addMonths(sourceDate, monthsDelta) {
    const y = sourceDate.getFullYear();
    const m1 = sourceDate.getMonth() + 1;
    const d = sourceDate.getDate();
    let m = m1 - 1 + monthsDelta;
    const yr = y + Math.floor(m / 12);
    const mo = ((m % 12) + 12) % 12 + 1;
    const dim = new Date(yr, mo, 0).getDate();
    const day = Math.min(d, dim);
    return new Date(yr, mo - 1, day);
  }

  function aggregateMonths(records) {
    const byMonth = {};
    records.forEach(item => {
      const date = new Date(item.date);
      if (Number.isNaN(date.getTime())) return;

      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) {
        byMonth[key] = {
          income: 0,
          expense: 0,
          incomeByCat: {},
          expenseByCat: {},
        };
      }
      const bucket = byMonth[key];
      const category = item.category || 'Other';

      if (item.type === 'Income') {
        bucket.income += item.amount;
        bucket.incomeByCat[category] = (bucket.incomeByCat[category] || 0) + item.amount;
      } else {
        bucket.expense += item.amount;
        bucket.expenseByCat[category] = (bucket.expenseByCat[category] || 0) + item.amount;
      }
    });
    return byMonth;
  }

  function sumCategoryCaseInsensitive(byCat, targetLower) {
    return Object.entries(byCat).reduce((sum, [k, v]) => {
      return sum + (String(k).toLowerCase() === targetLower ? v : 0);
    }, 0);
  }

  /**
   * @param {object} monthData from aggregateMonths
   * @param {{ excludeSalary: boolean, excludeFood: boolean, categoryCuts: Record<string, number>, supplementWeekly: number }} opts
   *   categoryCuts: map category name -> fraction of that category's spend to remove (0..1)
   */
  function monthlyNetForMonth(monthData, opts) {
    let income = monthData.income;
    let expense = monthData.expense;

    if (opts.excludeSalary) {
      income -= sumCategoryCaseInsensitive(monthData.incomeByCat, 'salary');
    }
    if (opts.excludeFood) {
      expense -= sumCategoryCaseInsensitive(monthData.expenseByCat, 'food');
    }
    if (opts.categoryCuts && typeof opts.categoryCuts === 'object') {
      Object.entries(opts.categoryCuts).forEach(([cat, fraction]) => {
        const f = Number(fraction);
        if (!Number.isFinite(f) || f <= 0) return;
        const amt = monthData.expenseByCat[cat] || 0;
        expense -= amt * Math.min(f, 1);
      });
    }

    let net = income - expense;
    return net;
  }

  function averageMonthlyNet(byMonth, opts) {
    const keys = Object.keys(byMonth).sort();
    if (keys.length === 0) return 0;
    let sum = 0;
    keys.forEach(k => {
      sum += monthlyNetForMonth(byMonth[k], opts);
    });
    const avg = sum / keys.length;
    const weekly = Number(opts.supplementWeekly) || 0;
    return avg + (weekly * 52) / 12;
  }

  function buildProjectionMonthStarts(horizonMonths) {
    const today = getDateOnly(new Date());
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    let cursor = addMonths(firstOfThisMonth, 1);
    const starts = [];
    for (let i = 0; i < horizonMonths; i += 1) {
      starts.push(new Date(cursor.getTime()));
      cursor = addMonths(cursor, 1);
    }
    return starts;
  }

  function monthLabelsFromStarts(monthStarts) {
    return monthStarts.map(d =>
      d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    );
  }

  /** Fraction along chart x from today (0) to end of first projected month (1) where the next month starts. */
  function computeChartG0(today, firstProjMonthStart) {
    const m0End = addMonths(firstProjMonthStart, 1);
    const den = m0End.getTime() - today.getTime();
    if (den <= 0) return 0;
    const g = (firstProjMonthStart.getTime() - today.getTime()) / den;
    return Math.min(1, Math.max(0, g));
  }

  /** Continuous chart x: 0 = today, 1 = end of first projected month, i = end of month i for i>=1. */
  function projectionToChartDepletionX(projectionMonthIndex, depletedFractionInMonth, g0) {
    if (projectionMonthIndex === null) return null;
    const f = Number.isFinite(depletedFractionInMonth) ? depletedFractionInMonth : 0;
    if (projectionMonthIndex === 0) {
      return g0 + f * (1 - g0);
    }
    return projectionMonthIndex + f;
  }

  /**
   * Linear cashflow within the calendar month; balance hits 0 at fraction f in [0,1].
   * @param {number} prior balance at start of month
   * @param {number} averageNet
   * @param {Date} monthStart
   */
  function computeDepletionTiming(prior, averageNet, monthStart) {
    const monthEnd = addMonths(monthStart, 1);
    const span = monthEnd.getTime() - monthStart.getTime();

    if (prior <= 0) {
      return {
        depletedFractionInMonth: 0,
        depletedOn: new Date(monthStart.getTime()),
      };
    }

    if (averageNet >= 0) {
      return {
        depletedFractionInMonth: 0,
        depletedOn: new Date(monthStart.getTime()),
      };
    }

    let f = -prior / averageNet;
    if (f < 0) f = 0;
    if (f > 1) f = 1;

    let depletedOn;
    if (f >= 1 - 1e-12) {
      depletedOn = new Date(monthEnd.getTime() - 1);
    } else {
      depletedOn = new Date(monthStart.getTime() + f * span);
    }

    return { depletedFractionInMonth: f, depletedOn };
  }

  /**
   * @param {number} currentBalance
   * @param {number} averageNet
   * @param {Date[]} monthStarts length = horizon
   * @returns {{ balances: number[], depletedAtIndex: number|null, depletedOn: Date|null, depletedFractionInMonth: number|null }}
   */
  function projectBalances(currentBalance, averageNet, monthStarts) {
    const balances = [];
    let balance = currentBalance;
    const horizonMonths = monthStarts.length;

    for (let i = 0; i < horizonMonths; i += 1) {
      const prior = balance;
      balance += averageNet;
      if (balance <= 0) {
        balances.push(0);
        const { depletedFractionInMonth, depletedOn } = computeDepletionTiming(
          prior,
          averageNet,
          monthStarts[i]
        );
        return {
          balances,
          depletedAtIndex: i,
          depletedOn,
          depletedFractionInMonth,
        };
      }
      balances.push(balance);
    }

    return {
      balances,
      depletedAtIndex: null,
      depletedOn: null,
      depletedFractionInMonth: null,
    };
  }

  function collectExpenseCategories(byMonth) {
    const totals = {};
    Object.values(byMonth).forEach(m => {
      Object.entries(m.expenseByCat).forEach(([cat, amt]) => {
        totals[cat] = (totals[cat] || 0) + amt;
      });
    });
    return Object.keys(totals)
      .filter(cat => totals[cat] > 0)
      .sort((a, b) => totals[b] - totals[a]);
  }

  /**
   * @param {object} params
   * @param {Array} params.expenses full list from storage
   * @param {number} params.horizonMonths
   * @param {boolean} params.excludeSalary
   * @param {boolean} params.excludeFood
   * @param {number} params.supplementWeekly
   * @param {Record<string, number>} params.categoryCuts
   */
  function buildProjection(params) {
    const expenses = params.expenses || [];
    const horizonMonths = Math.max(1, Math.min(120, Number(params.horizonMonths) || 12));

    const records = getLastTwelveMonthsRecords(expenses);
    const byMonth = aggregateMonths(records);

    if (Object.keys(byMonth).length === 0) {
      return {
        error: 'No eligible records are available for the last 12 months.',
      };
    }

    const startingBalance = computeCurrentBalance(expenses);

    const baselineOpts = {
      excludeSalary: false,
      excludeFood: false,
      supplementWeekly: 0,
      categoryCuts: {},
    };

    const scenarioOpts = {
      excludeSalary: Boolean(params.excludeSalary),
      excludeFood: Boolean(params.excludeFood),
      supplementWeekly: Number(params.supplementWeekly) || 0,
      categoryCuts: params.categoryCuts && typeof params.categoryCuts === 'object' ? params.categoryCuts : {},
    };

    const averageNetBaseline = averageMonthlyNet(byMonth, baselineOpts);
    const averageNetScenario = averageMonthlyNet(byMonth, scenarioOpts);

    const today = getDateOnly(new Date());
    const monthStarts = buildProjectionMonthStarts(horizonMonths);
    const chartG0 = computeChartG0(today, monthStarts[0]);
    const todayLabel = today.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    const monthLabels = [todayLabel, ...monthLabelsFromStarts(monthStarts)];

    const baseline = projectBalances(startingBalance, averageNetBaseline, monthStarts);
    const scenario = projectBalances(startingBalance, averageNetScenario, monthStarts);

    const baselineBalances = [startingBalance, ...baseline.balances];
    const scenarioBalances = [startingBalance, ...scenario.balances];

    const baselineDepletedAtIndex =
      baseline.depletedAtIndex === null ? null : baseline.depletedAtIndex + 1;
    const scenarioDepletedAtIndex =
      scenario.depletedAtIndex === null ? null : scenario.depletedAtIndex + 1;

    const baselineDepletedChartX = projectionToChartDepletionX(
      baseline.depletedAtIndex,
      baseline.depletedFractionInMonth,
      chartG0
    );
    const scenarioDepletedChartX = projectionToChartDepletionX(
      scenario.depletedAtIndex,
      scenario.depletedFractionInMonth,
      chartG0
    );

    return {
      monthLabels,
      baselineBalances,
      scenarioBalances,
      baselineDepletedAtIndex,
      scenarioDepletedAtIndex,
      baselineDepletedOn: baseline.depletedOn,
      scenarioDepletedOn: scenario.depletedOn,
      baselineDepletedFractionInMonth: baseline.depletedFractionInMonth,
      scenarioDepletedFractionInMonth: scenario.depletedFractionInMonth,
      baselineDepletedChartX,
      scenarioDepletedChartX,
      averageNetBaseline,
      averageNetScenario,
      monthsUsed: Object.keys(byMonth).length,
      startingBalance,
      expenseCategories: collectExpenseCategories(byMonth),
    };
  }

  window.ExpenseProjection = {
    STORAGE_KEY,
    loadExpenses,
    computeCurrentBalance,
    getLastTwelveMonthsRecords,
    aggregateMonths,
    addMonths,
    buildProjection,
    collectExpenseCategories,
  };
})();
