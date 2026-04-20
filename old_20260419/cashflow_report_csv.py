"""Parse cashflow report CSV files (Expense Tracker export / plot script input)."""

from __future__ import annotations

import csv
import io
from pathlib import Path

EXPECTED_HEADER = ['month', 'type', 'category', 'amount']


def parse_report_csv(text: str, *, source: str = 'report') -> tuple[list[tuple[str, str, str, float]], float | None]:
    """Parse report body as UTF-8 CSV. Returns (data_rows, current_balance_or_none).

    Each data row is (month, type, category, amount). Type is title-cased
    (Income, Expense). Balance rows are excluded from data_rows.
    """
    if text.startswith('\ufeff'):
        text = text[1:]

    rows: list[tuple[str, str, str, float]] = []
    current_balance: float | None = None
    reader = csv.reader(io.StringIO(text))
    header = [col.strip().lower() for col in next(reader, [])]
    if header != EXPECTED_HEADER:
        raise ValueError(f'Unsupported CSV header in {source}: {header}')

    for row in reader:
        if len(row) != 4:
            continue
        month_value, type_value, category, amount_text = [cell.strip() for cell in row]
        if not type_value or not amount_text:
            continue
        try:
            amount = float(amount_text)
        except ValueError as exc:
            raise ValueError(f'Invalid amount in {source}: {amount_text!r}') from exc
        type_value = type_value.title()

        if type_value == 'Balance' and category == 'Current balance':
            current_balance = amount
            continue

        if not month_value:
            continue

        rows.append((month_value, type_value, category, amount))

    return rows, current_balance


def load_report_csv(path: Path) -> tuple[list[tuple[str, str, str, float]], float | None]:
    """Load and parse a cashflow report CSV from disk."""
    label = str(path)
    with path.open(newline='', encoding='utf-8') as handle:
        return parse_report_csv(handle.read(), source=label)
