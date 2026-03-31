#!/usr/bin/env python3
"""Generate a sample expense CSV with approximate category proportions."""

import argparse
import calendar
import csv
import datetime
import random
from pathlib import Path

MAJOR_CATEGORIES = {
    'Housing': 0.30,
    'Food': 0.13,
    'Transport': 0.07,
}
SECONDARY_CATEGORIES = {
    'Utilities': 0.12,
    'Health': 0.07,
    'Entertainment': 0.06,
}
OTHER_CATEGORIES = {
    'Bills': 0.05,
    'Shopping': 0.04,
    'Other': 0.03,
    'Travel': 0.03,
}

CATEGORY_GROUPS = {
    'major': MAJOR_CATEGORIES,
    'secondary': SECONDARY_CATEGORIES,
    'other': OTHER_CATEGORIES,
}

CATEGORY_LABELS = list(MAJOR_CATEGORIES) + list(SECONDARY_CATEGORIES) + list(OTHER_CATEGORIES)

INCOME_CATEGORIES = ['Salary', 'Bonus', 'Freelance', 'Supplementary Income']

MONTHLY_INCOME_BASE = 3000


def parse_args():
    parser = argparse.ArgumentParser(description='Generate a sample expense CSV file.')
    parser.add_argument('--output', '-o', default='sample-expenses-generated.csv', help='Output CSV file path')
    parser.add_argument('--months', '-m', type=int, default=12, help='Number of months to generate')
    parser.add_argument('--start', '-s', default=None, help='Start month in YYYY-MM format (default 12 months ago)')
    parser.add_argument('--seed', type=int, default=None, help='Random seed for reproducible output')
    return parser.parse_args()


def month_range(start_date, months):
    current = datetime.date(start_date.year, start_date.month, 1)
    for _ in range(months):
        yield current
        month = current.month + 1
        year = current.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        current = datetime.date(year, month, 1)


def month_last_day(date):
    last_day = calendar.monthrange(date.year, date.month)[1]
    return datetime.date(date.year, date.month, last_day)


def pick_day(date, day):
    last_day = calendar.monthrange(date.year, date.month)[1]
    return datetime.date(date.year, date.month, min(day, last_day))


def generate_entries(start_date, months):
    entries = []
    for month_date in month_range(start_date, months):
        last_day = month_last_day(month_date)

        # Monthly income entries
        entries.append(make_entry('Salary', MONTHLY_INCOME_BASE, last_day, 'Salary', 'Income'))
        if random.random() < 0.25:
            bonus = random.uniform(150, 400)
            entries.append(make_entry('Bonus', bonus, pick_day(month_date, 20), 'Supplementary Income', 'Income'))
        if random.random() < 0.35:
            gig = random.uniform(180, 520)
            entries.append(make_entry('Freelance payment', gig, pick_day(month_date, 14), 'Supplementary Income', 'Income'))

        # Expense structure per month
        housing = random.uniform(580, 720)
        entries.append(make_entry('Housing rent', housing, last_day, 'Housing', 'Expense'))

        food_total = random.uniform(280, 360)
        entries.extend(make_weekly_food_entries(food_total, month_date))

        transport_total = random.uniform(190, 230)
        entries.extend(make_transport_entries(transport_total, month_date))

        utilities_total = random.uniform(150, 185)
        entries.append(make_entry('Utilities bill', utilities_total, pick_day(month_date, 14), 'Utilities', 'Expense'))

        if random.random() < 0.75:
            health_cost = random.uniform(90, 140)
            entries.append(make_entry('Medical co-pay', health_cost, pick_day(month_date, 19), 'Health', 'Expense'))

        entertainment_total = random.uniform(155, 205)
        entries.extend(make_entertainment_entries(entertainment_total, month_date))

        bills_total = random.uniform(110, 130)
        entries.append(make_entry('Phone bill', bills_total, pick_day(month_date, 12), 'Bills', 'Expense'))

        shopping_total = random.uniform(120, 160)
        entries.append(make_entry('Shopping spree', shopping_total, pick_day(month_date, 25), 'Shopping', 'Expense'))

        other_total = random.uniform(90, 120)
        entries.append(make_entry('Subscription service', other_total, pick_day(month_date, 22), 'Other', 'Expense'))

        if month_date.month % 2 == 0:
            travel_cost = random.uniform(190, 270)
            entries.append(make_entry('Weekend getaway', travel_cost, pick_day(month_date, 18), 'Travel', 'Expense'))

    random.shuffle(entries)
    return entries


def make_entry(description, amount, date, category, entry_type):
    return {
        'description': description,
        'amount': f'{amount:.2f}',
        'date': date.isoformat(),
        'category': category,
        'type': entry_type,
    }


def split_amount(total, parts):
    weights = [random.uniform(0.8, 1.2) for _ in range(parts)]
    total_weight = sum(weights)
    return [round(total * (w / total_weight), 2) for w in weights]


def make_weekly_food_entries(amount, month_date):
    sub_amounts = split_amount(amount, 3)
    days = [5, 15, 25]
    return [make_entry('Groceries', sub_amounts[i], pick_day(month_date, days[i]), 'Food', 'Expense') for i in range(3)]


def make_transport_entries(amount, month_date):
    base = amount * 0.7
    extra = amount - base
    return [
        make_entry('Transport pass', round(base, 2), pick_day(month_date, 6), 'Transport', 'Expense'),
        make_entry('Fuel / rideshare', round(extra, 2), pick_day(month_date, 20), 'Transport', 'Expense'),
    ]


def make_entertainment_entries(amount, month_date):
    pieces = split_amount(amount, 3)
    return [
        make_entry('Dining out', pieces[0], pick_day(month_date, 11), 'Entertainment', 'Expense'),
        make_entry('Streaming subscription', pieces[1], pick_day(month_date, 6), 'Entertainment', 'Expense'),
        make_entry('Events / movies', pieces[2], pick_day(month_date, 17), 'Entertainment', 'Expense'),
    ]


def write_csv(path, rows):
    fieldnames = ['description', 'amount', 'date', 'category', 'type']
    with open(path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    args = parse_args()
    if args.seed is not None:
        random.seed(args.seed)
    if args.start:
        start_date = datetime.datetime.strptime(args.start, '%Y-%m').date()
    else:
        today = datetime.date.today()
        year = today.year
        month = today.month - args.months + 1
        while month <= 0:
            month += 12
            year -= 1
        start_date = datetime.date(year, month, 1)
    rows = generate_entries(start_date, args.months)
    path = Path(args.output)
    write_csv(path, rows)
    print(f'Wrote {len(rows)} rows to {path.resolve()}')


if __name__ == '__main__':
    main()
