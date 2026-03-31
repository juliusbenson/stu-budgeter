# Simple Expense Tracker

A lightweight expense tracker app built with HTML, CSS, and JavaScript.

## Features

- Add expense entries with description, amount, date, and category
- View a running total and count of expenses
- Delete entries from the list
- Data persists in `localStorage`

## Run locally

Open `index.html` in your browser.

## CSV Import and Export

Use `sample-expenses.csv` as a template.
Upload a CSV file with columns: `description`, `amount`, `date`, `category`.

Click the **Export CSV** button to download your current transaction list as `expenses-export.csv`.

### Income support

Use the transaction type `Income` for income lines and `Expense` for expense lines.
### Balance chart

View your balance over the last 1, 3, 6, or 12 months using the chart controls.
The chart now plots daily balances and shows a 30-day moving average for a clearer cashflow trend.

### Expense breakdown

A pie chart now shows expense spending by category, making it easier to see where money is being spent.
