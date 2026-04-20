#!/usr/bin/env python3
"""Generate example anonymized cashflow report CSV files.

The output format matches the anonymized cashflow report CSV used by the app:
month,type,category,amount

Spending and income categories are generated per month from average monthly
values and a configurable variance.
"""

import argparse
import csv
import datetime
import hashlib
import io
import random
from pathlib import Path


DEFAULT_SPENDING = {
    'Food': 400,
    'Transport': 120,
    'Bills': 220,
    'Shopping': 140,
    'Other': 90,
}

DEFAULT_INCOME = {
    'Salary': 3000,
    'Supplementary Income': 250,
}


def parse_category_averages(value):
    if not value:
        return {}
    pairs = [chunk.strip() for chunk in value.split(',') if chunk.strip()]
    result = {}

    for pair in pairs:
        if '=' not in pair:
            raise argparse.ArgumentTypeError(
                f"Invalid category average entry '{pair}'. Expected format Category=Average"
            )
        category, avg = pair.split('=', 1)
        category = category.strip()
        if not category:
            raise argparse.ArgumentTypeError('Category name cannot be empty.')
        try:
            result[category] = float(avg)
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"Invalid average value for '{category}': {avg}. Must be a number."
            )
    return result


def parse_salary_range(value):
    if not value:
        return None
    if '-' not in value:
        raise argparse.ArgumentTypeError(
            f"Invalid salary range '{value}'. Expected format MIN-MAX"
        )
    min_value, max_value = value.split('-', 1)
    try:
        min_salary = float(min_value)
        max_salary = float(max_value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"Salary range values must be numbers: {value}"
        )
    if min_salary < 0 or max_salary < 0 or max_salary < min_salary:
        raise argparse.ArgumentTypeError(
            f"Salary range must be non-negative and min <= max: {value}"
        )
    return (min_salary, max_salary)


def month_range(start_date, months):
    current = datetime.date(start_date.year, start_date.month, 1)
    for _ in range(months):
        yield current
        month = current.month + 1
        year = current.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        current = datetime.date(year, month, 1)


def generate_report_rows(start_date, months, spending_avgs, income_avgs, variance, salary_range=None):
    rows = []

    if salary_range is not None:
        income_avgs = income_avgs.copy()
        income_avgs['Salary'] = random.uniform(*salary_range)

    for month_date in month_range(start_date, months):
        month_key = f"{month_date.year}-{month_date.month:02d}"

        for category, average in spending_avgs.items():
            stddev = abs(average) * variance
            amount = random.gauss(average, stddev) if stddev > 0 else average
            rows.append([
                month_key,
                'Expense',
                category,
                f"{max(0, amount):.2f}",
            ])

        for category, average in income_avgs.items():
            stddev = abs(average) * variance
            amount = random.gauss(average, stddev) if stddev > 0 else average
            rows.append([
                month_key,
                'Income',
                category,
                f"{max(0, amount):.2f}",
            ])

    return rows


def build_parser():
    parser = argparse.ArgumentParser(
        description='Generate a sample anonymized cashflow report CSV file.'
    )
    parser.add_argument(
        '--output', '-o',
        default='.',
        help='Output directory or path. Final file will be named cashflow-report-<fingerprint>.csv.',
    )
    parser.add_argument(
        '--months', '-m',
        type=int,
        default=12,
        help='Number of months to generate.',
    )
    parser.add_argument(
        '--start', '-s',
        default=None,
        help='Start month in YYYY-MM format (default is 12 months ago).',
    )
    parser.add_argument(
        '--batch',
        type=int,
        default=1,
        help='Number of reports to generate in batch mode. If >1, output must be a directory.',
    )
    parser.add_argument(
        '--spending',
        type=parse_category_averages,
        default=None,
        help=(
            'Comma-separated spending averages in Category=Average form. '
            'Example: Food=400,Transport=120,Bills=220'
        ),
    )
    parser.add_argument(
        '--income',
        type=parse_category_averages,
        default=None,
        help=(
            'Comma-separated income averages in Category=Average form. '
            'Example: Salary=3000,Supplementary Income=250'
        ),
    )
    parser.add_argument(
        '--salary-range',
        type=parse_salary_range,
        default=None,
        help=(
            'Optional salary range in MIN-MAX form to randomly choose a ' 
            'monthly salary average for each generated report. '
            'Example: 1500-3000'
        ),
    )
    parser.add_argument(
        '--variance',
        type=float,
        default=0.15,
        help='Relative standard deviation as a fraction of the average (default 0.15).',
    )
    parser.add_argument(
        '--seed',
        type=int,
        default=None,
        help='Random seed for reproducible output.',
    )
    return parser


def parse_start_month(value):
    if value is None:
        today = datetime.date.today()
        year = today.year
        month = today.month
        return datetime.date(year, month, 1)

    try:
        year_str, month_str = value.split('-', 1)
        return datetime.date(int(year_str), int(month_str), 1)
    except Exception as exc:
        raise argparse.ArgumentTypeError(
            f"Start month must be in YYYY-MM format: {value}"
        ) from exc


def main():
    parser = build_parser()
    args = parser.parse_args()

    start_date = parse_start_month(args.start)
    if args.months <= 0:
        raise SystemExit('Error: --months must be a positive integer.')
    if args.variance < 0:
        raise SystemExit('Error: --variance must be zero or positive.')

    spending_avgs = args.spending if args.spending is not None else DEFAULT_SPENDING
    income_avgs = args.income if args.income is not None else DEFAULT_INCOME

    if args.seed is not None:
        random.seed(args.seed)

    output_path = Path(args.output)

    if args.batch <= 0:
        raise SystemExit('Error: --batch must be a positive integer.')

    if args.batch > 1:
        if output_path.suffix.lower() == '.csv' and not output_path.is_dir():
            raise SystemExit('Error: --output must specify a directory when --batch > 1.')
        output_dir = output_path if output_path.is_dir() or args.output.endswith(('/', '\\')) else output_path
    else:
        output_dir = output_path if output_path.is_dir() or args.output.endswith(('/', '\\')) else output_path.parent

    output_dir = output_dir or Path('.')
    output_dir.mkdir(parents=True, exist_ok=True)

    def calculate_current_balance(rows):
        balance = 0.0
        for _, type_value, _, amount_text in rows:
            amount = float(amount_text)
            balance += amount if type_value == 'Income' else -amount
        return round(balance / 100) * 100

    def build_csv_text(rows):
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(['month', 'type', 'category', 'amount'])
        writer.writerows(rows)
        balance = calculate_current_balance(rows)
        writer.writerow(['', 'Balance', 'Current balance', f'{balance:.2f}'])
        return buffer.getvalue()

    def write_csv_report(csv_text):
        fingerprint = hashlib.sha1(csv_text.encode('utf-8')).hexdigest()[:10]
        filename = f'cashflow-report-{fingerprint}.csv'
        final_path = output_dir / filename
        with final_path.open('w', newline='', encoding='utf-8') as handle:
            handle.write(csv_text)
        return final_path

    if args.batch == 1:
        rows = generate_report_rows(
            start_date,
            args.months,
            spending_avgs,
            income_avgs,
            args.variance,
            salary_range=args.salary_range,
        )
        csv_text = build_csv_text(rows)
        final_path = write_csv_report(csv_text)
        print(f'Wrote {len(rows)} rows to {final_path}')
    else:
        for index in range(args.batch):
            rows = generate_report_rows(
                start_date,
                args.months,
                spending_avgs,
                income_avgs,
                args.variance,
                salary_range=args.salary_range,
            )
            csv_text = build_csv_text(rows)
            final_path = write_csv_report(csv_text)
            print(f'Wrote batch {index + 1}/{args.batch}: {final_path}')


if __name__ == '__main__':
    main()
