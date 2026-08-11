"""Unit tests for deterministic and spreadsheet-safe CSV helpers."""

from __future__ import annotations

import codecs
import csv
import io
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from app.reports.csv_utils import (
    build_csv_bytes,
    build_orders_export_filename,
    format_oslo_datetime,
    sanitize_csv_text,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("=1+1", "'=1+1"),
        ("+SUM(A1:A2)", "'+SUM(A1:A2)"),
        ("-10+20", "'-10+20"),
        ('@HYPERLINK("http://example.com")', '\'@HYPERLINK("http://example.com")'),
        ("\t=1+1", "'\t=1+1"),
        ("\r=1+1", "'\r=1+1"),
        ("\n=1+1", "'\n=1+1"),
        (" =1+1", "' =1+1"),
        ("   =1+1", "'   =1+1"),
        ("   -hyphenated", "'   -hyphenated"),
        ("'Special", "'Special"),
        ("'=1+1", "'=1+1"),
        ("ordinary-hyphenated-text", "ordinary-hyphenated-text"),
        ("", ""),
        (None, ""),
        (12345, 12345),
    ],
)
def test_sanitize_csv_text_has_deterministic_formula_protection(
    value: object | None,
    expected: object,
) -> None:
    assert sanitize_csv_text(value) == expected


def test_build_csv_bytes_uses_one_bom_exact_dialect_and_round_trips() -> None:
    complex_text = 'Chef\'s "Special", seasonal\nmenu'
    crlf_text = "Line1\r\nLine2"
    carriage_return_text = "Line1\rLine2"
    spaced_text = " leading and trailing "
    unicode_text = "Kjøtt Grønnsaker Å Ø Æ é Łódź 🍽️"
    content = build_csv_bytes(
        ("plain", "quoted", "empty", "amount", "unicode", "crlf", "cr", "spaces"),
        [
            (
                complex_text,
                'A "quoted", value',
                None,
                12345,
                unicode_text,
                crlf_text,
                carriage_return_text,
                spaced_text,
            ),
        ],
    )

    assert content.startswith(codecs.BOM_UTF8)
    assert not content.startswith(codecs.BOM_UTF8 * 2)
    assert content.count(codecs.BOM_UTF8) == 1
    decoded = content.decode("utf-8-sig")
    assert decoded.endswith("\r\n")
    assert '"A ""quoted"", value"' in decoded
    assert '"Chef\'s ""Special"", seasonal\nmenu"' in decoded

    parsed = list(csv.reader(io.StringIO(decoded, newline="")))
    assert parsed == [
        ["plain", "quoted", "empty", "amount", "unicode", "crlf", "cr", "spaces"],
        [
            complex_text,
            'A "quoted", value',
            "",
            "12345",
            unicode_text,
            crlf_text,
            carriage_return_text,
            spaced_text,
        ],
    ]
    assert parsed[0][0] == "plain"


def test_build_csv_bytes_uses_only_crlf_record_separators_without_blank_rows() -> None:
    content = build_csv_bytes(("header",), [("first",), ("second",)])
    decoded = content.decode("utf-8-sig")

    assert decoded == "header\r\nfirst\r\nsecond\r\n"
    assert "\n" not in decoded.replace("\r\n", "")
    assert list(csv.reader(io.StringIO(decoded, newline=""))) == [
        ["header"],
        ["first"],
        ["second"],
    ]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("\x00", ""),
        ("A\x00B", "AB"),
        ("\x00=1+1", "'=1+1"),
        ("\x00\t=1+1", "'\t=1+1"),
    ],
)
def test_sanitize_csv_text_removes_nul_before_formula_analysis(
    value: str,
    expected: str,
) -> None:
    assert sanitize_csv_text(value) == expected


def test_build_csv_bytes_sanitizes_every_text_cell_but_not_numbers() -> None:
    content = build_csv_bytes(
        ("text", "number"),
        [("=2+2", 42)],
    )
    parsed = list(csv.reader(io.StringIO(content.decode("utf-8-sig"), newline="")))
    assert parsed == [["text", "number"], ["'=2+2", "42"]]


def test_orders_filename_is_deterministic_utc_safe_and_exact() -> None:
    oslo = ZoneInfo("Europe/Oslo")
    arguments = {
        "start": datetime(2026, 8, 11, 14, 0, tzinfo=oslo),
        "end": datetime(2026, 8, 12, 2, 30, tzinfo=oslo),
        "currency": "NOK",
        "order_status": "completed",
        "order_type": "dine_in",
    }

    filename = build_orders_export_filename(**arguments)

    assert filename == (
        "orders_20260811T120000Z_20260812T003000Z_" "NOK_completed_dine_in.csv"
    )
    assert build_orders_export_filename(**arguments) == filename
    assert not any(
        separator in filename for separator in ("/", "\\", " ", ":", ";", "\r", "\n")
    )
    assert filename.endswith(".csv")


def test_orders_filename_is_identical_for_equivalent_instants() -> None:
    utc_arguments = {
        "start": datetime(2026, 8, 11, 12, tzinfo=UTC),
        "end": datetime(2026, 8, 11, 14, tzinfo=UTC),
        "currency": None,
        "order_status": None,
        "order_type": None,
    }
    offset_arguments = {
        **utc_arguments,
        "start": datetime.fromisoformat("2026-08-11T14:00:00+02:00"),
        "end": datetime.fromisoformat("2026-08-11T16:00:00+02:00"),
    }
    assert build_orders_export_filename(
        **utc_arguments
    ) == build_orders_export_filename(**offset_arguments)


def test_orders_filename_uses_all_tokens_without_filters() -> None:
    filename = build_orders_export_filename(
        start=datetime(2026, 1, 1, tzinfo=UTC),
        end=datetime(2026, 1, 2, tzinfo=UTC),
        currency=None,
        order_status=None,
        order_type=None,
    )
    assert filename == ("orders_20260101T000000Z_20260102T000000Z_all_all_all.csv")


@pytest.mark.parametrize(
    "function",
    [
        lambda: format_oslo_datetime(datetime(2026, 1, 1)),
        lambda: build_orders_export_filename(
            start=datetime(2026, 1, 1),
            end=datetime(2026, 1, 2, tzinfo=UTC),
            currency=None,
            order_status=None,
            order_type=None,
        ),
    ],
)
def test_datetime_helpers_reject_naive_values(function) -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        function()


def test_format_oslo_datetime_uses_seasonal_offsets() -> None:
    assert format_oslo_datetime(datetime(2026, 1, 15, 12, tzinfo=UTC)).endswith(
        "+01:00"
    )
    assert format_oslo_datetime(datetime(2026, 7, 15, 12, tzinfo=UTC)).endswith(
        "+02:00"
    )
