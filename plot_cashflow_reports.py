#!/usr/bin/env python3
"""Plot multiple anonymized cashflow report CSV files superimposed.

This script reads all CSV files matching the cashflow report format in a
specified directory and projects balances from each report's current balance
row using a constant monthly net from historical averages. Projection knot
points are monthly; balances between knots are filled with linear interpolation
so the plotted series has one sample per calendar day.

Output is saved to an image file and optionally displayed.
"""

import argparse
import calendar
import datetime
import math
import random
import statistics
from pathlib import Path

from cashflow_report_csv import load_report_csv


def parse_arguments():
    parser = argparse.ArgumentParser(
        description='Plot cashflow reports superimposed from a folder of CSV files.'
    )
    parser.add_argument(
        '--reports-dir', '-r',
        default='reports',
        help='Directory containing cashflow report CSV files.',
    )
    parser.add_argument(
        '--output', '-o',
        default='cashflow-reports-comparison.png',
        help='Output image filename for the full projection plot, saved inside --output-dir.',
    )
    parser.add_argument(
        '--output-dir', '-d',
        default='plots',
        help='Directory to save generated plots into.',
    )
    parser.add_argument(
        '--horizon', '-n',
        type=int,
        default=12,
        help='Number of future months to project (default 12).',
    )
    parser.add_argument(
        '--show',
        action='store_true',
        help='Show the plot interactively after generation.',
    )
    parser.add_argument(
        '--pairwise-t-star',
        action='store_true',
        help=(
            'Opt in to slow T* grid search, add the T* pairwise curve to plots, and '
            'write pairings.txt for the T* scenario (default is off; pairings use t50).'
        ),
    )
    parser.add_argument(
        '--t-star-coarse-days',
        type=int,
        default=7,
        metavar='N',
        help=(
            'With --pairwise-t-star: coarse grid step in days over [T_min, T_max] '
            '(default 7). Use a larger value (e.g. 30) for faster runs.'
        ),
    )
    parser.add_argument(
        '--t-star-fine-weeks',
        type=int,
        default=3,
        metavar='W',
        help=(
            'With --pairwise-t-star: daily refinement within +/- W weeks around '
            'the coarse winner (default 3). Use 1 for a faster, narrower refinement.'
        ),
    )
    parser.add_argument(
        '--pairwise-partial-seed',
        type=int,
        default=42,
        metavar='S',
        help=(
            'Random seed for the optional pairwise-t50 scenario where each greedy '
            'suggested transfer is kept with 50%% probability (reproducible plots).'
        ),
    )
    parser.add_argument(
        '--simple-zero-rate',
        action='store_true',
        help=(
            'Also save a minimal zero-rate plot with only the no-salary curve '
            '(for slides; avoids the multi-scenario clutter).'
        ),
    )
    return parser.parse_args()


def parse_month(month_value):
    try:
        return datetime.datetime.strptime(month_value, '%Y-%m').date()
    except ValueError as exc:
        raise ValueError(f"Invalid month format '{month_value}', expected YYYY-MM") from exc


def add_months(source_date, months):
    month = source_date.month - 1 + months
    year = source_date.year + month // 12
    month = month % 12 + 1
    day = min(source_date.day, calendar.monthrange(year, month)[1])
    return datetime.date(year, month, day)


def aggregate_report(rows):
    report = {}
    for month_value, type_value, category, amount in rows:
        report.setdefault(month_value, {'Income': 0.0, 'Expense': 0.0, 'Salary': 0.0, 'Food': 0.0})
        if type_value == 'Income':
            report[month_value]['Income'] += amount
            if category.strip().lower() == 'salary':
                report[month_value]['Salary'] += amount
        else:
            report[month_value]['Expense'] += amount
            if category.strip().lower() == 'food':
                report[month_value]['Food'] += amount
    return report


def build_projection(
    report_data,
    current_balance,
    horizon,
    exclude_salary=False,
    exclude_food=False,
    supplement_weekly_income=0.0,
    until_zero=False,
):
    monthly_nets = []
    for values in report_data.values():
        income = values['Income']
        if exclude_salary:
            income -= values.get('Salary', 0.0)
        expense = values['Expense']
        if exclude_food:
            expense -= values.get('Food', 0.0)
        monthly_nets.append(income - expense)
    average_net = sum(monthly_nets) / len(monthly_nets) if monthly_nets else 0.0
    average_net += supplement_weekly_income * 52.0 / 12.0

    if until_zero:
        if average_net < 0 and current_balance > 0:
            months_until_zero = math.ceil(current_balance / -average_net)
            horizon = max(horizon, months_until_zero + 1)
        elif average_net >= 0:
            horizon = max(horizon, 120)

    today = datetime.date.today()
    first_month = add_months(datetime.date(today.year, today.month, 1), 1)

    projected_months = []
    balances = []
    balance = current_balance
    for offset in range(horizon):
        balance += average_net
        month_date = add_months(first_month, offset)
        projected_months.append(month_date)
        balances.append(balance)

    return projected_months, balances


def interpolate_projection_daily(knot_dates, knot_balances):
    """Linearly interpolate balance between knot dates; one sample per calendar day."""
    if len(knot_dates) != len(knot_balances):
        raise ValueError('knot_dates and knot_balances must have the same length')
    if len(knot_dates) < 2:
        return list(knot_dates), list(knot_balances)

    daily_dates = []
    daily_balances = []

    for i in range(len(knot_dates) - 1):
        d0, b0 = knot_dates[i], knot_balances[i]
        d1, b1 = knot_dates[i + 1], knot_balances[i + 1]
        span = (d1 - d0).days
        is_last = i == len(knot_dates) - 2

        if span <= 0:
            if not daily_dates or daily_dates[-1] != d0:
                daily_dates.append(d0)
                daily_balances.append(b0)
            continue

        max_step = span if is_last else span - 1
        for step in range(max_step + 1):
            frac = step / span
            d = d0 + datetime.timedelta(days=step)
            daily_dates.append(d)
            daily_balances.append(b0 + (b1 - b0) * frac)

    return daily_dates, daily_balances


def build_zero_rate(
    all_reports,
    horizon,
    exclude_salary=False,
    exclude_food=False,
    supplement_weekly_income=0.0,
):
    today = datetime.date.today()
    projections = []
    for _, report_data, current_balance in all_reports:
        months, balances = build_projection(
            report_data,
            current_balance,
            horizon,
            exclude_salary=exclude_salary,
            exclude_food=exclude_food,
            supplement_weekly_income=supplement_weekly_income,
            until_zero=True,
        )
        knot_dates = [today, *months]
        knot_balances = [current_balance, *balances]
        daily_dates, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
        daily_map = dict(zip(daily_dates, daily_balances))
        projections.append((daily_dates[0], daily_balances[0],
                            daily_dates[-1], daily_balances[-1], daily_map))

    all_dates = sorted({d for _, _, _, _, dm in projections for d in dm})
    zero_rate = []

    for day in all_dates:
        reached_zero = 0
        for first_date, first_balance, last_date, last_balance, daily_map in projections:
            if day in daily_map:
                balance = daily_map[day]
            elif day < first_date:
                balance = first_balance
            else:
                balance = last_balance
            if balance <= 0:
                reached_zero += 1
        zero_rate.append(reached_zero / len(projections))

    return all_dates, zero_rate


def classify_early_late(all_reports, horizon):
    """Classify each report as 'early' or 'late' relative to t₅₀.

    t₅₀ is the first calendar day when at least 50% of the cohort has hit zero
    under the baseline no-salary scenario.  'Early' members are those whose
    trajectory first reaches zero on or before t₅₀.

    Returns:
        t50 (datetime.date | None): the t₅₀ date, or None if fewer than half
            the cohort reaches zero within the projection window.
        is_early (list[bool]): True for each report whose trajectory hits zero
            on or before t₅₀.
        baselines (list[tuple]): per-trajectory
            (first_date, first_balance, last_date, last_balance, daily_map)
            from the baseline no-salary projection, for reuse by callers.
    """
    today = datetime.date.today()
    baselines = []
    for _, report_data, current_balance in all_reports:
        months, balances = build_projection(
            report_data,
            current_balance,
            horizon,
            exclude_salary=True,
            until_zero=True,
        )
        knot_dates = [today, *months]
        knot_balances = [current_balance, *balances]
        daily_dates, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
        daily_map = dict(zip(daily_dates, daily_balances))
        baselines.append((
            daily_dates[0], daily_balances[0],
            daily_dates[-1], daily_balances[-1],
            daily_map,
        ))

    all_dates = sorted({d for _, _, _, _, dm in baselines for d in dm})
    zero_rate = []
    for day in all_dates:
        reached_zero = 0
        for fd, fb, ld, lb, dm in baselines:
            balance = dm.get(day, fb if day < fd else lb)
            if balance <= 0:
                reached_zero += 1
        zero_rate.append(reached_zero / len(baselines))

    t50 = next((d for d, zr in zip(all_dates, zero_rate) if zr >= 0.5), None)

    is_early = []
    for fd, fb, ld, lb, dm in baselines:
        if t50 is None:
            is_early.append(False)
        else:
            first_zero = next((d for d in sorted(dm) if dm[d] <= 0), None)
            is_early.append(first_zero is not None and first_zero <= t50)

    return t50, is_early, baselines


def build_zero_rate_targeted(
    all_reports,
    horizon,
    lump_sum_early=0.0,
    supplement_weekly_early=0.0,
    supplement_weekly_all=0.0,
    peer_donation_participation=0.0,
    peer_donation_fraction=0.0,
    peer_donation_decay_fn=None,
):
    """Build a zero-rate CDF with targeted interventions for 'early' members.

    'Early' members are those whose baseline no-salary trajectory first hits
    zero on or before t₅₀ (the date when 50% of the cohort is exhausted).

    Args:
        lump_sum_early: one-time lump sum added to early members' opening balance.
        supplement_weekly_early: weekly income added only for early members.
        supplement_weekly_all: weekly income added for every member.
        peer_donation_participation: fraction of late members (sorted by
            descending surplus at t₅₀) who donate to a shared pool.
        peer_donation_fraction: each selected donor contributes this fraction
            of their balance at t₅₀ to the pool, divided equally among early
            members as an upfront lump sum.
        peer_donation_decay_fn: if provided, overrides participation/fraction
            with a per-rank model.  ALL late members participate; the callable
            is invoked as peer_donation_decay_fn(r, n) where r is the 1-indexed
            rank of the donor (1 = highest surplus at t₅₀) and n is the total
            number of late donors.  The return value is the fraction of that
            donor's surplus contributed to the pool.  Example: lambda r, n: 1/r
            gives the harmonic "1/x" decay (rank-1 donates 100%, rank-2 donates
            50%, etc.).

    Returns:
        (dates, zero_rate): same structure as build_zero_rate.
    """
    t50, is_early, baselines = classify_early_late(all_reports, horizon)

    peer_lump_per_early = 0.0
    if t50 is not None:
        n_early = sum(is_early)
        if n_early > 0:
            late_surpluses = []
            for i, (fd, fb, ld, lb, dm) in enumerate(baselines):
                if not is_early[i]:
                    bal = dm.get(t50, fb if t50 < fd else lb)
                    late_surpluses.append(max(0.0, bal))
            late_surpluses.sort(reverse=True)

            if peer_donation_decay_fn is not None:
                n_late = len(late_surpluses)
                total_pool = sum(
                    s * peer_donation_decay_fn(r + 1, n_late)
                    for r, s in enumerate(late_surpluses)
                )
                peer_lump_per_early = total_pool / n_early
            elif peer_donation_participation > 0 and peer_donation_fraction > 0:
                n_donors = max(1, round(len(late_surpluses) * peer_donation_participation))
                total_pool = sum(s * peer_donation_fraction for s in late_surpluses[:n_donors])
                peer_lump_per_early = total_pool / n_early

    today = datetime.date.today()
    projections = []
    for i, (_, report_data, current_balance) in enumerate(all_reports):
        effective_balance = current_balance
        effective_supplement = supplement_weekly_all
        if is_early[i]:
            effective_balance += lump_sum_early + peer_lump_per_early
            effective_supplement += supplement_weekly_early

        months, balances = build_projection(
            report_data,
            effective_balance,
            horizon,
            exclude_salary=True,
            supplement_weekly_income=effective_supplement,
            until_zero=True,
        )
        knot_dates = [today, *months]
        knot_balances = [effective_balance, *balances]
        daily_dates, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
        daily_map = dict(zip(daily_dates, daily_balances))
        projections.append((
            daily_dates[0], daily_balances[0],
            daily_dates[-1], daily_balances[-1],
            daily_map,
        ))

    all_dates = sorted({d for _, _, _, _, dm in projections for d in dm})
    zero_rate = []
    for day in all_dates:
        reached_zero = 0
        for first_date, first_balance, last_date, last_balance, daily_map in projections:
            balance = daily_map.get(day, first_balance if day < first_date else last_balance)
            if balance <= 0:
                reached_zero += 1
        zero_rate.append(reached_zero / len(projections))

    return all_dates, zero_rate


def first_depletion_day(daily_map):
    """First calendar day with balance <= 0, or None if never in daily_map."""
    for d in sorted(daily_map.keys()):
        if daily_map[d] <= 0:
            return d
    return None


def first_depletion_balance(report_data, balance, horizon):
    """First depletion date for no-salary projection from given opening balance."""
    today = datetime.date.today()
    months, balances = build_projection(
        report_data,
        balance,
        horizon,
        exclude_salary=True,
        until_zero=True,
    )
    knot_dates = [today, *months]
    knot_balances = [balance, *balances]
    daily_dates, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
    return first_depletion_day(dict(zip(daily_dates, daily_balances)))


def _lump_upper_bound_for_search(report_data, balance, horizon):
    months, balances = build_projection(
        report_data,
        balance,
        horizon,
        exclude_salary=True,
        until_zero=True,
    )
    today = datetime.date.today()
    knot_dates = [today, *months]
    knot_balances = [balance, *balances]
    _, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
    m = min(daily_balances) if daily_balances else balance
    return max(1.0, abs(m) * 2.0 + 1.0, balance * 2.0 + 1.0)


def recipient_lump_to_deplete_on_or_after(report_data, balance, horizon, target_date):
    """Minimum lump added at t0 so first depletion is on or after target_date."""
    fd0 = first_depletion_balance(report_data, balance, horizon)
    if fd0 is None or fd0 >= target_date:
        return 0.0
    hi = _lump_upper_bound_for_search(report_data, balance, horizon)
    for _ in range(25):
        fd_hi = first_depletion_balance(report_data, balance + hi, horizon)
        if fd_hi is not None and fd_hi < target_date:
            hi *= 2.0
        else:
            break
    lo = 0.0
    for _ in range(80):
        mid = (lo + hi) / 2.0
        fd = first_depletion_balance(report_data, balance + mid, horizon)
        if fd is None:
            hi = mid
        elif fd >= target_date:
            hi = mid
        else:
            lo = mid
    lump = hi
    fd_final = first_depletion_balance(report_data, balance + lump, horizon)
    if fd_final is None or fd_final < target_date:
        return float('inf')
    return lump


def donor_max_lump_preserving_first_depletion_ge(report_data, balance, horizon, target_date):
    """Max lump removed at t0 so first depletion is still None or on/after target_date."""

    def ok(donate):
        nb = balance - donate
        if nb < 0:
            return False
        fd = first_depletion_balance(report_data, nb, horizon)
        if fd is None:
            return True
        return fd >= target_date

    if not ok(0.0):
        return 0.0
    if ok(balance):
        return balance
    lo, hi = 0.0, balance
    for _ in range(80):
        mid = (lo + hi) / 2.0
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo


def aggregate_zero_rate_from_deltas(all_reports, horizon, delta):
    """Build cohort zero-rate CDF from per-report opening-balance adjustments delta[i]."""
    today = datetime.date.today()
    projections = []
    for i, (_, report_data, current_balance) in enumerate(all_reports):
        eff = current_balance + delta[i]
        months, balances = build_projection(
            report_data,
            eff,
            horizon,
            exclude_salary=True,
            until_zero=True,
        )
        knot_dates = [today, *months]
        knot_balances = [eff, *balances]
        daily_dates, daily_balances = interpolate_projection_daily(knot_dates, knot_balances)
        daily_map = dict(zip(daily_dates, daily_balances))
        projections.append((
            daily_dates[0], daily_balances[0],
            daily_dates[-1], daily_balances[-1],
            daily_map,
        ))

    all_dates = sorted({d for _, _, _, _, dm in projections for d in dm})
    zero_rate = []
    for day in all_dates:
        reached_zero = 0
        for first_date, first_balance, last_date, last_balance, daily_map in projections:
            balance = daily_map.get(day, first_balance if day < first_date else last_balance)
            if balance <= 0:
                reached_zero += 1
        zero_rate.append(reached_zero / len(projections))

    return all_dates, zero_rate


def compute_pairwise_deltas_for_target(
    all_reports,
    horizon,
    target_date,
    *,
    return_pairings=False,
    transfer_keep_probability=1.0,
    rng=None,
):
    """Greedy pairwise water-fill for a sync target date (recipient need / donor cap vs target).

    Early/late membership and pairing order come from baseline classify_early_late (t50 cohort),
    not from target_date.  Returns (delta list, metadata dict).

    If transfer_keep_probability < 1, each pair's proposed transfer x (when x > 0) is kept
    independently with that probability; skipped pairs do not move funds (greedy order
    unchanged; unused need/cap are not reallocated to other pairs).
    """
    if transfer_keep_probability < 1.0 and rng is None:
        rng = random.Random()
    _, is_early, _ = classify_early_late(all_reports, horizon)
    n = len(all_reports)
    delta = [0.0] * n
    sentinel = datetime.date(3000, 1, 1)
    early_idx = []
    late_idx = []
    for i in range(n):
        _, report_data, b0 = all_reports[i]
        fd = first_depletion_balance(report_data, b0, horizon)
        if is_early[i]:
            early_idx.append((fd if fd is not None else sentinel, i))
        else:
            late_idx.append((fd if fd is not None else sentinel, i))

    early_idx.sort(key=lambda x: x[0])
    late_idx.sort(key=lambda x: x[0], reverse=True)

    earlies = [i for _, i in early_idx]
    lates = [i for _, i in late_idx]

    raw_need = []
    for i in earlies:
        _, report_data, b0 = all_reports[i]
        raw_need.append(recipient_lump_to_deplete_on_or_after(report_data, b0, horizon, target_date))

    cap = []
    for j in lates:
        _, report_data, b0 = all_reports[j]
        cap.append(donor_max_lump_preserving_first_depletion_ge(report_data, b0, horizon, target_date))

    n_need_total = sum(nv for nv in raw_need if nv < float('inf'))
    n_cap_total = sum(cap)
    if n_need_total <= 0:
        scale = 1.0
        scaled_need = [0.0] * len(earlies)
    else:
        scale = min(1.0, n_cap_total / n_need_total)
        scaled_need = [
            (nv * scale) if nv < float('inf') else 0.0
            for nv in raw_need
        ]

    rem_need = list(scaled_need)
    rem_cap = list(cap)
    npairs = min(len(earlies), len(lates))
    transferred = 0.0
    pair_records = []
    for k in range(npairs):
        e = earlies[k]
        l_ = lates[k]
        x = min(rem_need[k], rem_cap[k])
        if x > 0 and transfer_keep_probability < 1.0 and rng.random() > transfer_keep_probability:
            x = 0.0
        if x > 0:
            delta[e] += x
            delta[l_] -= x
            rem_need[k] -= x
            rem_cap[k] -= x
            transferred += x
            if return_pairings:
                e_rd, e_b0 = all_reports[e][1], all_reports[e][2]
                l_rd, l_b0 = all_reports[l_][1], all_reports[l_][2]
                pair_records.append({
                    'transfer': x,
                    'benefactor_name': all_reports[l_][0],
                    'recipient_name': all_reports[e][0],
                    'benefactor_new_zero': first_depletion_balance(l_rd, l_b0 - x, horizon),
                    'recipient_new_zero': first_depletion_balance(e_rd, e_b0 + x, horizon),
                })

    meta = {
        'n_need_total': n_need_total,
        'n_cap_total': n_cap_total,
        'scale': scale,
        'npairs': npairs,
        'transferred': transferred,
        'unmatched_early': len(earlies) - npairs,
        'unmatched_late': len(lates) - npairs,
        'pair_records': pair_records,
    }
    return delta, meta


def _max_projection_calendar_date(all_reports, horizon):
    """Latest month-end (or knot) date across baseline no-salary projections."""
    today = datetime.date.today()
    mx = today
    for _, report_data, b0 in all_reports:
        months, _ = build_projection(
            report_data, b0, horizon, exclude_salary=True, until_zero=True,
        )
        if months:
            mx = max(mx, months[-1])
    return mx


def _variance_post_pairwise_target(all_reports, horizon, target_date, never_deplete_sentinel):
    """Sample variance of first-depletion ordinals after pairwise sync to target_date.

    Members who never deplete in the window use never_deplete_sentinel (ordinal penalty).
    """
    delta, _ = compute_pairwise_deltas_for_target(all_reports, horizon, target_date)
    never_o = never_deplete_sentinel.toordinal()
    vals = []
    for i, (_, rd, b0) in enumerate(all_reports):
        fd = first_depletion_balance(rd, b0 + delta[i], horizon)
        vals.append(never_o if fd is None else fd.toordinal())
    if len(vals) < 2:
        return 0.0
    return statistics.variance(vals)


def find_t_star_min_variance(
    all_reports,
    horizon,
    *,
    coarse_step_days=7,
    fine_window_weeks=3,
):
    """Grid search for sync target T* minimizing sample variance of post-transfer $0 dates.

    Coarse step in days over [T_min, T_max], then daily refinement within +- fine_window_weeks
    around the coarse winner (plan default: 7-day coarse, +-3 weeks fine). Pass larger
    coarse_step_days or smaller fine_window_weeks via CLI for faster runs.
    Early/late pairing is fixed from baseline t50 classification.
    Tie-break: prefer later T* when variance is equal (within 1e-9).

    Never-deplete in the projection window is mapped to an ordinal one day after the latest
    date in any baseline daily_map (same sentinel used when scoring each candidate).

    Returns (t_star, min_variance) or (None, float('nan')) if baseline t50 is undefined.
    """
    t50_baseline, _, baselines = classify_early_late(all_reports, horizon)
    if t50_baseline is None:
        return None, float('nan')

    first_zeros = []
    all_days = set()
    for fd, fb, ld, lb, dm in baselines:
        all_days.update(dm.keys())
        fz = first_depletion_day(dm)
        if fz is not None:
            first_zeros.append(fz)

    today = datetime.date.today()
    t_max = max(all_days) if all_days else _max_projection_calendar_date(all_reports, horizon)
    t_min = min(first_zeros) if first_zeros else today
    never_sentinel = t_max + datetime.timedelta(days=1)

    def consider(t, best_var, best_t):
        var = _variance_post_pairwise_target(all_reports, horizon, t, never_sentinel)
        if var < best_var - 1e-9 or (
            abs(var - best_var) <= 1e-9 and (best_t is None or t > best_t)
        ):
            return var, t
        return best_var, best_t

    best_var = float('inf')
    best_t = None
    d = t_min
    while d <= t_max:
        best_var, best_t = consider(d, best_var, best_t)
        d += datetime.timedelta(days=coarse_step_days)

    if best_t is None:
        best_t = t50_baseline
        best_var = _variance_post_pairwise_target(
            all_reports, horizon, best_t, never_sentinel,
        )

    win_lo = best_t - datetime.timedelta(days=7 * fine_window_weeks)
    win_hi = best_t + datetime.timedelta(days=7 * fine_window_weeks)
    d = max(t_min, win_lo)
    while d <= min(t_max, win_hi):
        best_var, best_t = consider(d, best_var, best_t)
        d += datetime.timedelta(days=1)

    return best_t, best_var


def build_zero_rate_pairwise_for_target(
    all_reports,
    horizon,
    target_date,
    print_status=True,
    return_pairings=False,
    *,
    status_prefix='pairwise sync',
    transfer_keep_probability=1.0,
    random_seed=None,
):
    """Pairwise peer sync with recipient/donor limits keyed to target_date (not baseline t50)."""
    rng = None
    if transfer_keep_probability < 1.0:
        rng = random.Random(random_seed)
    t50_baseline, _, _ = classify_early_late(all_reports, horizon)
    if t50_baseline is None:
        if print_status:
            print(
                'pairwise sync: no baseline t50 in window; skipping transfers '
                '(N_need=0, N_cap=0, scale=1.0, pairs=0).',
            )
        result = build_zero_rate(all_reports, horizon, exclude_salary=True)
        if return_pairings:
            return result[0], result[1], []
        return result

    delta, meta = compute_pairwise_deltas_for_target(
        all_reports,
        horizon,
        target_date,
        return_pairings=return_pairings,
        transfer_keep_probability=transfer_keep_probability,
        rng=rng,
    )
    if print_status:
        partial_note = ''
        if transfer_keep_probability < 1.0:
            seed_part = f', seed={random_seed}' if random_seed is not None else ''
            partial_note = (
                f', transfer_keep_prob={transfer_keep_probability:.2f}{seed_part}'
            )
        print(
            f'{status_prefix} (target {target_date}){partial_note}: '
            f'N_need(raw)={meta["n_need_total"]:.2f}, '
            f'N_cap={meta["n_cap_total"]:.2f}, scale={meta["scale"]:.4f}, pairs={meta["npairs"]}, '
            f'total_transferred={meta["transferred"]:.2f}, '
            f'unmatched_early={meta["unmatched_early"]}, '
            f'unmatched_late={meta["unmatched_late"]}.',
        )
    dates, zr = aggregate_zero_rate_from_deltas(all_reports, horizon, delta)
    if return_pairings:
        return dates, zr, meta['pair_records']
    return dates, zr


def build_zero_rate_pairwise_t50_sync(
    all_reports,
    horizon,
    print_status=True,
    return_pairings=False,
    *,
    transfer_keep_probability=1.0,
    random_seed=None,
):
    """Peer-only pairwise transfers with sync target = baseline cohort t50 (see classify_early_late).

    Same pairing policy as build_zero_rate_pairwise_for_target with target_date=t50.
    """
    t50, _, _ = classify_early_late(all_reports, horizon)
    if t50 is None:
        if print_status:
            print(
                'pairwise t50 sync: no t50 in window; skipping transfers '
                '(N_need=0, N_cap=0, scale=1.0, pairs=0).',
            )
        result = build_zero_rate(all_reports, horizon, exclude_salary=True)
        if return_pairings:
            return result[0], result[1], []
        return result
    return build_zero_rate_pairwise_for_target(
        all_reports,
        horizon,
        t50,
        print_status=print_status,
        return_pairings=return_pairings,
        status_prefix='pairwise t50 sync',
        transfer_keep_probability=transfer_keep_probability,
        random_seed=random_seed,
    )


def compute_weekly_pdf(dates, zero_rate):
    """Return (week_start_dates, weekly_fractions) from a daily CDF zero-rate series."""
    deltas = [zero_rate[0]] + [zero_rate[i] - zero_rate[i - 1] for i in range(1, len(zero_rate))]
    weeks = {}
    for d, delta in zip(dates, deltas):
        week_start = d - datetime.timedelta(days=d.weekday())  # Monday
        weeks[week_start] = weeks.get(week_start, 0.0) + delta
    week_starts = sorted(weeks)
    return week_starts, [weeks[w] for w in week_starts]


def build_series(month_keys, report_data, metric):
    series = []
    for month_key in month_keys:
        values = report_data.get(month_key, {'Income': 0.0, 'Expense': 0.0})
        if metric == 'income':
            series.append(values['Income'])
        elif metric == 'expense':
            series.append(values['Expense'])
        else:
            series.append(values['Income'] - values['Expense'])
    return series


def write_pairings_txt(all_reports, horizon, output_path, pairwise_target_date=None):
    """Write a tab-separated pairings file for the pairwise peer sync scenario.

    Each row: transfer_dollars, benefactor_hash, benefactor_new_zero,
    recipient_hash, recipient_new_zero.  Hashes are extracted from filenames
    of the form cashflow-report-{hash}.csv.

    If pairwise_target_date is None, uses baseline t50 as sync target (same as
    build_zero_rate_pairwise_t50_sync).  Otherwise uses that calendar date as
    the sync target for need/cap (e.g. T* from find_t_star_min_variance).
    """
    if pairwise_target_date is None:
        _, _, pairings = build_zero_rate_pairwise_t50_sync(
            all_reports, horizon, print_status=False, return_pairings=True,
        )
    else:
        _, _, pairings = build_zero_rate_pairwise_for_target(
            all_reports,
            horizon,
            pairwise_target_date,
            print_status=False,
            return_pairings=True,
        )

    def extract_hash(name):
        stem = name.removesuffix('.csv')
        return stem.removeprefix('cashflow-report-')

    with open(output_path, 'w', newline='') as f:
        f.write('transfer_dollars\tbenefactor_hash\tbenefactor_new_zero\trecipient_hash\trecipient_new_zero\n')
        for p in pairings:
            benefactor_hash = extract_hash(p['benefactor_name'])
            recipient_hash = extract_hash(p['recipient_name'])
            bzero = p['benefactor_new_zero'].isoformat() if p['benefactor_new_zero'] else 'never'
            rzero = p['recipient_new_zero'].isoformat() if p['recipient_new_zero'] else 'never'
            f.write(f"{p['transfer']:.2f}\t{benefactor_hash}\t{bzero}\t{recipient_hash}\t{rzero}\n")
    print(f'Saved pairings to {output_path}')


def find_report_files(directory):
    path = Path(directory)
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError(f"Reports directory not found: {directory}")
    return sorted(path.glob('cashflow-report-*.csv'))


def main():
    args = parse_arguments()
    report_files = find_report_files(args.reports_dir)
    if not report_files:
        raise SystemExit(f'No cashflow report CSV files found in {args.reports_dir}')

    all_reports = []
    for report_path in report_files:
        rows, current_balance = load_report_csv(report_path)
        report_data = aggregate_report(rows)
        if current_balance is None:
            raise SystemExit(f"Missing current balance row in {report_path}")
        all_reports.append((report_path.name, report_data, current_balance))

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    projection_months = []
    if all_reports:
        today = datetime.date.today()
        first_month = add_months(datetime.date(today.year, today.month, 1), 1)
        projection_months = [add_months(first_month, i) for i in range(args.horizon)]
    x_values = projection_months

    try:
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
    except ImportError as exc:
        raise SystemExit(
            'Matplotlib is required to run this script. Install it with `pip install matplotlib`.'
        ) from exc

    def plot_projection(exclude_salary, title, filename, until_zero=False):
        plt.figure(figsize=(12, 7))
        today = datetime.date.today()
        for name, report_data, current_balance in all_reports:
            x_values, y_values = build_projection(
                report_data,
                current_balance,
                args.horizon,
                exclude_salary=exclude_salary,
                until_zero=until_zero,
            )
            knot_dates = [today, *x_values]
            knot_balances = [current_balance, *y_values]
            daily_x, daily_y = interpolate_projection_daily(knot_dates, knot_balances)
            plt.plot(daily_x, daily_y, linewidth=1.8, label=name)
        plt.xlabel('Date')
        plt.ylabel('Projected balance (daily linear interpolation)')
        plt.title(title)
        plt.grid(True, linestyle='--', alpha=0.4)
        # plt.legend(loc='best', fontsize='small')
        ax = plt.gca()
        ax.set_ylim(bottom=0)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
        plt.gcf().autofmt_xdate(rotation=45)
        plt.tight_layout()
        output_path = output_dir / filename
        plt.savefig(output_path, dpi=150)
        print(f'Saved plot to {output_path}')

    def plot_zero_rate(filename, pairwise_tstar_curve=None):
        TARGETED_SUPPLEMENT_WEEKLY = 100.0
        LUMP_SUM_EARLY = 500.0
        PEER_DONATION_PARTICIPATION = 0.5
        PEER_DONATION_FRACTION = 0.1
        PEER_DONATION_PARTICIPATION_2 = 0.5
        PEER_DONATION_FRACTION_2 = 0.5
        PEER_DONATION_PARTICIPATION_3 = 0.1
        PEER_DONATION_FRACTION_3 = 0.5

        dates, zero_rate_salary = build_zero_rate(all_reports, args.horizon, exclude_salary=True)
        dates_no_food, zero_rate_salary_food = build_zero_rate(
            all_reports,
            args.horizon,
            exclude_salary=True,
            exclude_food=True,
        )
        dates_supplement, zero_rate_salary_supplement = build_zero_rate(
            all_reports,
            args.horizon,
            exclude_salary=True,
            supplement_weekly_income=100.0,
        )
        dates_targeted, zero_rate_targeted = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            supplement_weekly_early=TARGETED_SUPPLEMENT_WEEKLY,
        )
        dates_lump, zero_rate_lump = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            lump_sum_early=LUMP_SUM_EARLY,
        )
        dates_peer, zero_rate_peer = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION,
            peer_donation_fraction=PEER_DONATION_FRACTION,
        )
        dates_peer2, zero_rate_peer2 = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION_2,
            peer_donation_fraction=PEER_DONATION_FRACTION_2,
        )
        dates_peer3, zero_rate_peer3 = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION_3,
            peer_donation_fraction=PEER_DONATION_FRACTION_3,
        )
        dates_decay, zero_rate_decay = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_decay_fn=lambda r, n: 1 / r,
        )
        dates_pairwise, zero_rate_pairwise = build_zero_rate_pairwise_t50_sync(
            all_reports,
            args.horizon,
        )
        dates_pairwise_partial, zero_rate_pairwise_partial = build_zero_rate_pairwise_t50_sync(
            all_reports,
            args.horizon,
            print_status=False,
            transfer_keep_probability=0.5,
            random_seed=args.pairwise_partial_seed,
        )
        t50 = next((d for d, zr in zip(dates, zero_rate_salary) if zr >= 0.5), None)

        plt.figure(figsize=(12, 7))
        plt.plot(dates, zero_rate_salary, linewidth=1.8, color='tab:purple', label='No salary')
        plt.plot(dates_no_food, zero_rate_salary_food, linewidth=1.8, color='tab:orange', label='No salary and no food')
        plt.plot(
            dates_supplement,
            zero_rate_salary_supplement,
            linewidth=1.8,
            color='tab:green',
            label='No salary + $100/week supplemental income',
        )
        plt.plot(
            dates_targeted,
            zero_rate_targeted,
            linewidth=1.8,
            color='tab:blue',
            label=f'No salary + ${TARGETED_SUPPLEMENT_WEEKLY:.0f}/week (early members only)',
        )
        plt.plot(
            dates_lump,
            zero_rate_lump,
            linewidth=1.8,
            color='tab:red',
            label=f'No salary + ${LUMP_SUM_EARLY:.0f} lump sum (early members only)',
        )
        plt.plot(
            dates_peer,
            zero_rate_peer,
            linewidth=1.8,
            color='tab:brown',
            label=(
                f'No salary + peer donation'
                f' ({PEER_DONATION_PARTICIPATION:.0%} participation,'
                f' {PEER_DONATION_FRACTION:.0%} surplus)'
            ),
        )
        plt.plot(
            dates_peer2,
            zero_rate_peer2,
            linewidth=1.8,
            color='tab:pink',
            label=(
                f'No salary + peer donation'
                f' ({PEER_DONATION_PARTICIPATION_2:.0%} participation,'
                f' {PEER_DONATION_FRACTION_2:.0%} surplus)'
            ),
        )
        plt.plot(
            dates_peer3,
            zero_rate_peer3,
            linewidth=1.8,
            color='tab:olive',
            label=(
                f'No salary + peer donation'
                f' ({PEER_DONATION_PARTICIPATION_3:.0%} participation,'
                f' {PEER_DONATION_FRACTION_3:.0%} surplus)'
            ),
        )
        plt.plot(
            dates_decay,
            zero_rate_decay,
            linewidth=1.8,
            color='tab:cyan',
            label='No salary + peer donation (harmonic decay: rank-r gives 1/r of surplus)',
        )
        plt.plot(
            dates_pairwise,
            zero_rate_pairwise,
            linewidth=1.8,
            color='#17becf',
            label=(
                'No salary + pairwise peer sync to t\u2085\u2080 '
                '(100% participation, greedy latest-with-earliest match; early/late = baseline t\u2085\u2080)'
            ),
        )
        plt.plot(
            dates_pairwise_partial,
            zero_rate_pairwise_partial,
            linewidth=1.8,
            color='#bcbd22',
            label=(
                'No salary + pairwise peer sync to t\u2085\u2080, '
                '50% of greedy transfers realized (Bernoulli per pair; '
                f'seed={args.pairwise_partial_seed})'
            ),
        )
        if pairwise_tstar_curve is not None:
            d_ts, z_ts, t_star, var_ts = pairwise_tstar_curve
            plt.plot(
                d_ts,
                z_ts,
                linewidth=1.8,
                color='#9467bd',
                label=(
                    f'No salary + pairwise sync to T*={t_star} '
                    f'(min sample var of $0 ordinals={var_ts:.1f}; '
                    'never-deplete counts as day after max projection)'
                ),
            )
        ax = plt.gca()
        if t50 is not None:
            ax.axvline(t50, color='gray', linestyle=':', linewidth=1.5,
                       label=f't\u2085\u2080 \u2014 50% exhausted ({t50:%Y-%m-%d}, {(t50 - datetime.date.today()).days:+d} days from today)')
        plt.xlabel('Date')
        plt.ylabel('Proportion of projections at or below zero')
        plt.title('Proportion of Projections Reaching Zero Over Time')
        plt.grid(True, linestyle='--', alpha=0.4)
        ax.set_ylim(0, 1)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
        plt.legend(loc='best', fontsize='small')
        plt.gcf().autofmt_xdate(rotation=45)
        plt.tight_layout()
        output_path = output_dir / filename
        plt.savefig(output_path, dpi=150)
        print(f'Saved plot to {output_path}')

    def plot_hazard_rate(filename, pairwise_tstar_curve=None):
        TARGETED_SUPPLEMENT_WEEKLY = 100.0
        LUMP_SUM_EARLY = 500.0
        PEER_DONATION_PARTICIPATION = 0.5
        PEER_DONATION_FRACTION = 0.1
        PEER_DONATION_PARTICIPATION_2 = 0.5
        PEER_DONATION_FRACTION_2 = 0.5
        PEER_DONATION_PARTICIPATION_3 = 0.1
        PEER_DONATION_FRACTION_3 = 0.5

        dates, zero_rate_salary = build_zero_rate(all_reports, args.horizon, exclude_salary=True)
        dates_no_food, zero_rate_salary_food = build_zero_rate(
            all_reports,
            args.horizon,
            exclude_salary=True,
            exclude_food=True,
        )
        dates_supplement, zero_rate_salary_supplement = build_zero_rate(
            all_reports,
            args.horizon,
            exclude_salary=True,
            supplement_weekly_income=100.0,
        )
        dates_targeted, zero_rate_targeted = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            supplement_weekly_early=TARGETED_SUPPLEMENT_WEEKLY,
        )
        dates_lump, zero_rate_lump = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            lump_sum_early=LUMP_SUM_EARLY,
        )
        dates_peer, zero_rate_peer = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION,
            peer_donation_fraction=PEER_DONATION_FRACTION,
        )
        dates_peer2, zero_rate_peer2 = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION_2,
            peer_donation_fraction=PEER_DONATION_FRACTION_2,
        )
        dates_peer3, zero_rate_peer3 = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_participation=PEER_DONATION_PARTICIPATION_3,
            peer_donation_fraction=PEER_DONATION_FRACTION_3,
        )
        dates_decay, zero_rate_decay = build_zero_rate_targeted(
            all_reports,
            args.horizon,
            peer_donation_decay_fn=lambda r, n: 1 / r,
        )
        dates_pairwise, zero_rate_pairwise = build_zero_rate_pairwise_t50_sync(
            all_reports,
            args.horizon,
            print_status=False,
        )
        dates_pairwise_partial, zero_rate_pairwise_partial = build_zero_rate_pairwise_t50_sync(
            all_reports,
            args.horizon,
            print_status=False,
            transfer_keep_probability=0.5,
            random_seed=args.pairwise_partial_seed,
        )
        t50 = next((d for d, zr in zip(dates, zero_rate_salary) if zr >= 0.5), None)

        weeks, pdf_salary = compute_weekly_pdf(dates, zero_rate_salary)
        weeks_no_food, pdf_salary_food = compute_weekly_pdf(dates_no_food, zero_rate_salary_food)
        weeks_supplement, pdf_salary_supplement = compute_weekly_pdf(dates_supplement, zero_rate_salary_supplement)
        weeks_targeted, pdf_targeted = compute_weekly_pdf(dates_targeted, zero_rate_targeted)
        weeks_lump, pdf_lump = compute_weekly_pdf(dates_lump, zero_rate_lump)
        weeks_peer, pdf_peer = compute_weekly_pdf(dates_peer, zero_rate_peer)
        weeks_peer2, pdf_peer2 = compute_weekly_pdf(dates_peer2, zero_rate_peer2)
        weeks_peer3, pdf_peer3 = compute_weekly_pdf(dates_peer3, zero_rate_peer3)
        weeks_decay, pdf_decay = compute_weekly_pdf(dates_decay, zero_rate_decay)
        weeks_pairwise, pdf_pairwise = compute_weekly_pdf(dates_pairwise, zero_rate_pairwise)
        weeks_pairwise_partial, pdf_pairwise_partial = compute_weekly_pdf(
            dates_pairwise_partial, zero_rate_pairwise_partial,
        )
        weeks_tstar, pdf_tstar = (
            compute_weekly_pdf(pairwise_tstar_curve[0], pairwise_tstar_curve[1])
            if pairwise_tstar_curve is not None
            else (None, None)
        )

        bar_width = datetime.timedelta(days=0.5)
        n_hazard_bars = 12 + (1 if pairwise_tstar_curve is not None else 0)
        span = 0.5 * (n_hazard_bars - 1)
        lo = -span / 2.0
        offsets = [
            datetime.timedelta(days=lo + 0.5 * i)
            for i in range(n_hazard_bars)
        ]
        plt.figure(figsize=(12, 7))
        plt.bar([d + offsets[0] for d in weeks], pdf_salary, width=bar_width,
                color='tab:purple', label='No salary')
        plt.bar([d + offsets[1] for d in weeks_no_food], pdf_salary_food, width=bar_width,
                color='tab:orange', label='No salary and no food')
        plt.bar([d + offsets[2] for d in weeks_supplement], pdf_salary_supplement, width=bar_width,
                color='tab:green', label='No salary + $100/week supplemental income')
        plt.bar([d + offsets[3] for d in weeks_targeted], pdf_targeted, width=bar_width,
                color='tab:blue',
                label=f'No salary + ${TARGETED_SUPPLEMENT_WEEKLY:.0f}/week (early members only)')
        plt.bar([d + offsets[4] for d in weeks_lump], pdf_lump, width=bar_width,
                color='tab:red',
                label=f'No salary + ${LUMP_SUM_EARLY:.0f} lump sum (early members only)')
        plt.bar([d + offsets[5] for d in weeks_peer], pdf_peer, width=bar_width,
                color='tab:brown',
                label=(
                    f'No salary + peer donation'
                    f' ({PEER_DONATION_PARTICIPATION:.0%} participation,'
                    f' {PEER_DONATION_FRACTION:.0%} surplus)'
                ))
        plt.bar([d + offsets[6] for d in weeks_peer2], pdf_peer2, width=bar_width,
                color='tab:pink',
                label=(
                    f'No salary + peer donation'
                    f' ({PEER_DONATION_PARTICIPATION_2:.0%} participation,'
                    f' {PEER_DONATION_FRACTION_2:.0%} surplus)'
                ))
        plt.bar([d + offsets[7] for d in weeks_peer3], pdf_peer3, width=bar_width,
                color='tab:olive',
                label=(
                    f'No salary + peer donation'
                    f' ({PEER_DONATION_PARTICIPATION_3:.0%} participation,'
                    f' {PEER_DONATION_FRACTION_3:.0%} surplus)'
                ))
        plt.bar([d + offsets[8] for d in weeks_decay], pdf_decay, width=bar_width,
                color='tab:cyan',
                label='No salary + peer donation (harmonic decay: rank-r gives 1/r of surplus)')
        plt.bar([d + offsets[9] for d in weeks_pairwise], pdf_pairwise, width=bar_width,
                color='#17becf',
                label=(
                    'No salary + pairwise peer sync to t\u2085\u2080 '
                    '(100% participation, greedy latest-with-earliest match; early/late = baseline t\u2085\u2080)'
                ))
        plt.bar([d + offsets[10] for d in weeks_pairwise_partial], pdf_pairwise_partial, width=bar_width,
                color='#bcbd22',
                label=(
                    'No salary + pairwise t\u2085\u2080 sync, 50% of greedy transfers realized '
                    f'(seed={args.pairwise_partial_seed})'
                ))
        if pairwise_tstar_curve is not None:
            t_star = pairwise_tstar_curve[2]
            var_ts = pairwise_tstar_curve[3]
            plt.bar([d + offsets[11] for d in weeks_tstar], pdf_tstar, width=bar_width,
                    color='#9467bd',
                    label=(
                        f'No salary + pairwise sync to T*={t_star} '
                        f'(min sample var ordinals={var_ts:.1f})'
                    ))
        ax = plt.gca()
        if t50 is not None:
            ax.axvline(t50, color='gray', linestyle=':', linewidth=1.5,
                       label=f't\u2085\u2080 \u2014 50% exhausted ({t50:%Y-%m-%d})')
        plt.xlabel('Date')
        plt.ylabel('Fraction of projections first reaching zero')
        plt.title('Weekly Rate of Projections Reaching Zero')
        plt.grid(True, linestyle='--', alpha=0.4)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
        plt.legend(loc='best', fontsize='small')
        plt.gcf().autofmt_xdate(rotation=45)
        plt.tight_layout()
        output_path = output_dir / filename
        plt.savefig(output_path, dpi=150)
        print(f'Saved plot to {output_path}')

    plot_projection(False, 'Projected Balance Over Time for Cashflow Reports', args.output)
    exclusion_filename = Path(args.output).stem + '-no-salary' + Path(args.output).suffix
    plot_projection(True, 'Projected Balance Over Time Excluding Salary', exclusion_filename, until_zero=True)
    pairwise_tstar_curve = None
    if args.pairwise_t_star:
        t_star, var_opt = find_t_star_min_variance(
            all_reports,
            args.horizon,
            coarse_step_days=args.t_star_coarse_days,
            fine_window_weeks=args.t_star_fine_weeks,
        )
        if t_star is not None:
            print(
                f'pairwise T* (min sample variance of post-transfer $0 date ordinals): '
                f'{t_star} (var={var_opt:.2f}; never-deplete -> day after max projection date)',
            )
            d_opt, z_opt = build_zero_rate_pairwise_for_target(
                all_reports,
                args.horizon,
                t_star,
                print_status=True,
                status_prefix='pairwise T* sync',
            )
            pairwise_tstar_curve = (d_opt, z_opt, t_star, var_opt)
        else:
            print('pairwise T* search skipped (no baseline t50 in window).')

    zero_rate_filename = Path(args.output).stem + '-zero-rate' + Path(args.output).suffix
    plot_zero_rate(zero_rate_filename, pairwise_tstar_curve=pairwise_tstar_curve)

    if args.simple_zero_rate:
        simple_name = Path(args.output).stem + '-zero-rate-simple' + Path(args.output).suffix
        dates_ns, zr_ns = build_zero_rate(all_reports, args.horizon, exclude_salary=True)
        plt.figure(figsize=(10, 6))
        plt.plot(
            dates_ns,
            zr_ns,
            linewidth=2.4,
            color='tab:purple',
        )
        plt.xlabel('Date')
        plt.ylabel('Cumulative share at or below zero')
        plt.title('Projected savings exhaustion if salary is excluded')
        plt.grid(True, linestyle='--', alpha=0.4)
        plt.ylim(0, 1)
        ax = plt.gca()
        t50_simple = next((d for d, zr in zip(dates_ns, zr_ns) if zr >= 0.5), None)
        if t50_simple is not None:
            days_until = (t50_simple - datetime.date.today()).days
            ax.axvline(
                t50_simple,
                color='gray',
                linestyle=':',
                linewidth=1.5,
                label=(
                    f'50% exhausted ({t50_simple:%Y-%m-%d}; '
                    f'{days_until:+d} days from today)'
                ),
            )
            ax.legend(loc='best', fontsize=10)
        ax.axhline(0.5, color='gray', linestyle=':', linewidth=1.5)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
        plt.gcf().autofmt_xdate(rotation=45)
        plt.tight_layout()
        simple_path = output_dir / simple_name
        plt.savefig(simple_path, dpi=150)
        print(f'Saved plot to {simple_path}')

    hazard_filename = Path(args.output).stem + '-hazard-rate' + Path(args.output).suffix
    plot_hazard_rate(hazard_filename, pairwise_tstar_curve=pairwise_tstar_curve)

    pairings_path = output_dir / (Path(args.output).stem + '-pairings.txt')
    pairings_target = pairwise_tstar_curve[2] if pairwise_tstar_curve is not None else None
    write_pairings_txt(all_reports, args.horizon, pairings_path, pairwise_target_date=pairings_target)

    if args.show:
        plt.show()


if __name__ == '__main__':
    main()
