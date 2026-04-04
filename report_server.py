#!/usr/bin/env python3
"""HTTP server: accept cashflow report CSV uploads from the Expense Tracker."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from flask import Flask, Response, jsonify, request

from cashflow_report_csv import parse_report_csv

app = Flask(__name__)


def _reports_dir() -> Path:
    return Path(os.environ.get('STU_REPORTS_DIR', 'reports')).resolve()


def _cors_origins() -> str | list[str]:
    raw = os.environ.get('STU_CORS_ORIGINS', '*').strip()
    if raw == '*':
        return '*'
    return [o.strip() for o in raw.split(',') if o.strip()]


def _apply_cors(response: Response) -> Response:
    allowed = _cors_origins()
    origin = request.headers.get('Origin')
    if allowed == '*':
        response.headers['Access-Control-Allow-Origin'] = '*'
    elif origin and origin in allowed:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    elif isinstance(allowed, list) and len(allowed) == 1:
        response.headers['Access-Control-Allow-Origin'] = allowed[0]
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


@app.after_request
def cors_after(response: Response) -> Response:
    return _apply_cors(response)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


@app.route('/reports', methods=['POST', 'OPTIONS'])
def reports():
    if request.method == 'OPTIONS':
        return Response(status=204)

    raw = request.get_data()
    if not raw:
        return jsonify({'error': 'Empty body'}), 400

    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        return jsonify({'error': 'Body must be UTF-8'}), 400

    try:
        rows, current_balance = parse_report_csv(text, source='upload')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    if not rows:
        return jsonify({'error': 'Report must contain at least one data row'}), 400
    if current_balance is None:
        return jsonify({'error': 'Missing Current balance row'}), 400

    fingerprint = hashlib.sha1(raw).hexdigest()[:10]
    filename = f'cashflow-report-{fingerprint}.csv'
    out_dir = _reports_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / filename

    # Idempotent: same bytes produce the same file name; skip rewrite if present.
    if dest.exists():
        return (
            jsonify(
                {
                    'ok': True,
                    'path': str(dest),
                    'filename': filename,
                    'message': 'Already stored',
                }
            ),
            200,
        )

    dest.write_bytes(raw)
    return (
        jsonify(
            {
                'ok': True,
                'path': str(dest),
                'filename': filename,
                'message': 'Saved',
            }
        ),
        201,
    )


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', '5000')), debug=True)
