#!/usr/bin/env python3
"""Plot multiple anonymized cashflow report CSV files superimposed.

This script reads all CSV files matching the cashflow report format in a
specified directory and projects end-of-month balances for the upcoming year
from each report's current balance row.

Output is saved to an image file and optionally displayed.
"""

import argparse
import calendar
import csv
import datetime
import math
from pathlib import Path


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


def load_report_csv(path):
    rows = []
    current_balance = None
    with path.open(newline='', encoding='utf-8') as handle:
        reader = csv.reader(handle)
        header = [col.strip().lower() for col in next(reader, [])]
        if header != ['month', 'type', 'category', 'amount']:
            raise ValueError(f"Unsupported CSV header in {path}: {header}")

        for row in reader:
            if len(row) != 4:
                continue
            month_value, type_value, category, amount_text = [cell.strip() for cell in row]
            if not type_value or not amount_text:
                continue
            amount = float(amount_text)
            type_value = type_value.title()

            if type_value == 'Balance' and category == 'Current balance':
                current_balance = amount
                continue

            if not month_value:
                continue

            rows.append((month_value, type_value, category, amount))

    return rows, current_balance


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


def build_zero_rate(
    all_reports,
    horizon,
    exclude_salary=False,
    exclude_food=False,
    supplement_weekly_income=0.0,
):
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
        projections.append((months, balances))

    all_dates = sorted({month for months, _ in projections for month in months})
    zero_rate = []

    for month in all_dates:
        reached_zero = 0
        for months, balances in projections:
            if month in months:
                idx = months.index(month)
                balance = balances[idx]
            else:
                if month < months[0]:
                    balance = balances[0]
                else:
                    balance = balances[-1]
            if balance <= 0:
                reached_zero += 1
        zero_rate.append(reached_zero / len(projections))

    return all_dates, zero_rate


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
        for name, report_data, current_balance in all_reports:
            x_values, y_values = build_projection(
                report_data,
                current_balance,
                args.horizon,
                exclude_salary=exclude_salary,
                until_zero=until_zero,
            )
            plt.plot(x_values, y_values, marker='o', linewidth=1.8, label=name)
        plt.xlabel('Month')
        plt.ylabel('Projected End-of-Month Balance')
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

    def plot_zero_rate(filename):
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
        plt.figure(figsize=(12, 7))
        plt.plot(dates, zero_rate_salary, marker='o', linewidth=1.8, color='tab:purple', label='No salary')
        plt.plot(dates_no_food, zero_rate_salary_food, marker='o', linewidth=1.8, color='tab:orange', label='No salary and no food')
        plt.plot(
            dates_supplement,
            zero_rate_salary_supplement,
            marker='o',
            linewidth=1.8,
            color='tab:green',
            label='No salary + $100/week supplemental income',
        )
        plt.xlabel('Month')
        plt.ylabel('Proportion of projections at or below zero')
        plt.title('Proportion of Projections Reaching Zero Over Time')
        plt.grid(True, linestyle='--', alpha=0.4)
        ax = plt.gca()
        ax.set_ylim(0, 1)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
        plt.legend(loc='best', fontsize='small')
        plt.gcf().autofmt_xdate(rotation=45)
        plt.tight_layout()
        output_path = output_dir / filename
        plt.savefig(output_path, dpi=150)
        print(f'Saved plot to {output_path}')

    plot_projection(False, 'Projected Balance Over Time for Cashflow Reports', args.output)
    exclusion_filename = Path(args.output).stem + '-no-salary' + Path(args.output).suffix
    plot_projection(True, 'Projected Balance Over Time Excluding Salary', exclusion_filename, until_zero=True)
    zero_rate_filename = Path(args.output).stem + '-zero-rate' + Path(args.output).suffix
    plot_zero_rate(zero_rate_filename)

    if args.show:
        plt.show()


if __name__ == '__main__':
    main()
