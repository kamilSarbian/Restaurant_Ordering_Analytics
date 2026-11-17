import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
from email.message import EmailMessage
from http.client import IncompleteRead
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from app.exchange_rates import provider as provider_module
from app.exchange_rates.provider import (
    ECB_CACHE_TTL_SECONDS,
    ECB_DAILY_RATES_URL,
    ECB_FAILURE_CACHE_TTL_SECONDS,
    ECB_FETCH_TIMEOUT_SECONDS,
    ECB_MAX_RESPONSE_BYTES,
    ExchangeRateProvider,
    ExchangeRateUnavailableError,
    fetch_ecb_daily_xml,
    parse_ecb_daily_xml,
)


def _ecb_xml(
    *,
    rate_date: str = "2026-11-13",
    nok: str = "11.7000",
    pln: str = "4.2500",
) -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time="{rate_date}">
    <Cube currency="USD" rate="1.16"/>
    <Cube currency="PLN" rate="{pln}"/>
    <Cube currency="NOK" rate="{nok}"/>
  </Cube></Cube>
</gesmes:Envelope>""".encode()


def test_parse_ecb_daily_xml_returns_one_coherent_rate_snapshot() -> None:
    rates = parse_ecb_daily_xml(_ecb_xml())

    assert rates.rate_date.isoformat() == "2026-11-13"
    assert rates.nok_per_eur == Decimal("11.7000")
    assert rates.pln_per_eur == Decimal("4.2500")


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///x'>]><x>&e;</x>",
        _ecb_xml(nok="NaN"),
        _ecb_xml(pln="0"),
        _ecb_xml().replace(b'<Cube currency="NOK" rate="11.7000"/>', b""),
        _ecb_xml().replace(
            b'<Cube currency="NOK" rate="11.7000"/>',
            b'<Cube currency="NOK" rate="11.7000"/>'
            b'<Cube currency="NOK" rate="11.8000"/>',
        ),
        _ecb_xml().replace(
            b"http://www.gesmes.org/xml/2002-08-01",
            b"https://example.invalid/gesmes",
        ),
        _ecb_xml().replace(
            b"http://www.ecb.int/vocabulary/2002-08-01/eurofxref",
            b"https://example.invalid/eurofxref",
        ),
        _ecb_xml()
        .replace(b"  <Cube><Cube time=", b"  <Cube><Wrapper><Cube time=")
        .replace(b"  </Cube></Cube>", b"  </Cube></Wrapper></Cube>"),
        b"x" * (ECB_MAX_RESPONSE_BYTES + 1),
    ],
    ids=[
        "empty",
        "doctype",
        "non-finite",
        "zero",
        "missing-nok",
        "duplicate-nok",
        "wrong-envelope-namespace",
        "wrong-cube-namespace",
        "wrong-cube-hierarchy",
        "oversized",
    ],
)
def test_parse_ecb_daily_xml_rejects_unsafe_or_incomplete_documents(
    payload: bytes,
) -> None:
    with pytest.raises(ExchangeRateUnavailableError) as error:
        parse_ecb_daily_xml(payload)

    assert str(error.value) == "ECB reference rates are unavailable"


def test_parse_ecb_daily_xml_sanitizes_parser_recursion_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_to_parse(_payload: bytes) -> None:
        raise RecursionError("private parser detail")

    monkeypatch.setattr(provider_module.ElementTree, "fromstring", fail_to_parse)

    with pytest.raises(ExchangeRateUnavailableError) as error:
        parse_ecb_daily_xml(_ecb_xml())

    assert str(error.value) == "ECB reference rates are unavailable"
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


def test_provider_uses_exact_fetch_contract_and_six_hour_cache() -> None:
    calls: list[tuple[str, float, int]] = []
    monotonic_now = [100.0]

    def fetcher(url: str, timeout_seconds: float, max_bytes: int) -> bytes:
        calls.append((url, timeout_seconds, max_bytes))
        return _ecb_xml()

    provider = ExchangeRateProvider(
        fetcher=fetcher,
        utc_now_provider=lambda: datetime(2026, 11, 14, 12, tzinfo=UTC),
        monotonic_provider=lambda: monotonic_now[0],
    )

    first = provider.get_rates()
    monotonic_now[0] += ECB_CACHE_TTL_SECONDS - 1
    second = provider.get_rates()

    assert first is second
    assert calls == [
        (ECB_DAILY_RATES_URL, ECB_FETCH_TIMEOUT_SECONDS, ECB_MAX_RESPONSE_BYTES)
    ]

    monotonic_now[0] += 2
    provider.get_rates()
    assert len(calls) == 2


@pytest.mark.parametrize("rate_date", ["2026-11-06", "2026-11-15"])
def test_provider_rejects_stale_or_future_rate_dates(rate_date: str) -> None:
    provider = ExchangeRateProvider(
        fetcher=lambda _url, _timeout, _max_bytes: _ecb_xml(rate_date=rate_date),
        utc_now_provider=lambda: datetime(2026, 11, 14, 12, tzinfo=UTC),
    )

    with pytest.raises(ExchangeRateUnavailableError) as error:
        provider.get_rates()

    assert str(error.value) == "ECB reference rates are unavailable"


def test_provider_rejects_a_naive_clock() -> None:
    provider = ExchangeRateProvider(
        fetcher=lambda _url, _timeout, _max_bytes: _ecb_xml(),
        utc_now_provider=lambda: datetime(2026, 11, 14, 12),
    )

    with pytest.raises(ExchangeRateUnavailableError):
        provider.get_rates()


def test_provider_shares_one_bounded_failure_across_concurrent_callers() -> None:
    call_count = 0
    call_count_lock = threading.Lock()
    caller_barrier = threading.Barrier(8)
    fetch_started = threading.Event()
    release_fetch = threading.Event()

    def failing_fetcher(_url: str, _timeout: float, _max_bytes: int) -> bytes:
        nonlocal call_count
        with call_count_lock:
            call_count += 1
        fetch_started.set()
        if not release_fetch.wait(timeout=2):
            raise AssertionError("Expected the synthetic failing fetch to be released")
        raise TimeoutError("synthetic upstream timeout")

    provider = ExchangeRateProvider(
        fetcher=failing_fetcher,
        utc_now_provider=lambda: datetime(2026, 11, 14, 12, tzinfo=UTC),
        monotonic_provider=lambda: 100.0,
    )

    def get_safe_error() -> str:
        caller_barrier.wait(timeout=2)
        with pytest.raises(ExchangeRateUnavailableError) as error:
            provider.get_rates()
        return str(error.value)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(get_safe_error) for _ in range(8)]
        assert fetch_started.wait(timeout=2)
        release_fetch.set()
        errors = [future.result(timeout=2) for future in futures]

    assert errors == ["ECB reference rates are unavailable"] * 8
    assert call_count == 1


def test_provider_retries_only_after_failure_cache_expires() -> None:
    monotonic_now = [100.0]
    calls = 0

    def fail_then_succeed(_url: str, _timeout: float, _max_bytes: int) -> bytes:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("synthetic upstream timeout")
        return _ecb_xml()

    provider = ExchangeRateProvider(
        fetcher=fail_then_succeed,
        utc_now_provider=lambda: datetime(2026, 11, 14, 12, tzinfo=UTC),
        monotonic_provider=lambda: monotonic_now[0],
    )

    with pytest.raises(ExchangeRateUnavailableError):
        provider.get_rates()
    monotonic_now[0] += ECB_FAILURE_CACHE_TTL_SECONDS - 1
    with pytest.raises(ExchangeRateUnavailableError):
        provider.get_rates()
    assert calls == 1

    monotonic_now[0] += 1
    rates = provider.get_rates()

    assert calls == 2
    assert rates.nok_per_eur == Decimal("11.7000")


class _FakeResponse:
    def __init__(
        self,
        *,
        payload: bytes = b"safe",
        status: int = 200,
        url: str = ECB_DAILY_RATES_URL,
        content_type: str = "application/xml",
        content_length: str | None = None,
        read_error: Exception | None = None,
    ) -> None:
        self.status = status
        self._payload = payload
        self._read_error = read_error
        self._url = url
        self.headers = EmailMessage()
        self.headers["Content-Type"] = content_type
        if content_length is not None:
            self.headers["Content-Length"] = content_length

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def read(self, size: int) -> bytes:
        if self._read_error is not None:
            raise self._read_error
        return self._payload[:size]


class _FakeOpener:
    def __init__(self, response: _FakeResponse | Exception) -> None:
        self.response = response
        self.calls: list[tuple[str, str, float]] = []

    def open(self, request: Request, timeout: float) -> _FakeResponse:
        self.calls.append((request.full_url, request.method, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _install_fake_opener(
    monkeypatch: pytest.MonkeyPatch,
    response: _FakeResponse | Exception,
) -> _FakeOpener:
    opener = _FakeOpener(response)
    monkeypatch.setattr(provider_module, "build_opener", lambda _handler: opener)
    return opener


def test_bounded_fetch_uses_exact_source_method_timeout_and_read_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"<xml/>"
    opener = _install_fake_opener(monkeypatch, _FakeResponse(payload=payload))

    result = fetch_ecb_daily_xml(
        ECB_DAILY_RATES_URL,
        ECB_FETCH_TIMEOUT_SECONDS,
        ECB_MAX_RESPONSE_BYTES,
    )

    assert result == payload
    assert opener.calls == [(ECB_DAILY_RATES_URL, "GET", ECB_FETCH_TIMEOUT_SECONDS)]


@pytest.mark.parametrize(
    "response",
    [
        _FakeResponse(status=302),
        _FakeResponse(url="https://example.invalid/rates.xml"),
        _FakeResponse(content_type="text/html"),
        _FakeResponse(content_length="unknown"),
        _FakeResponse(content_length=str(ECB_MAX_RESPONSE_BYTES + 1)),
        _FakeResponse(payload=b"x" * (ECB_MAX_RESPONSE_BYTES + 1)),
        _FakeResponse(read_error=IncompleteRead(b"partial", 20)),
        HTTPError(ECB_DAILY_RATES_URL, 302, "redirect", EmailMessage(), None),
    ],
    ids=[
        "non-200",
        "changed-url",
        "content-type",
        "invalid-length",
        "declared-oversized",
        "read-oversized",
        "incomplete-read",
        "redirect-error",
    ],
)
def test_bounded_fetch_rejects_redirects_status_types_and_oversized_responses(
    monkeypatch: pytest.MonkeyPatch,
    response: _FakeResponse | Exception,
) -> None:
    _install_fake_opener(monkeypatch, response)

    with pytest.raises(ExchangeRateUnavailableError) as error:
        fetch_ecb_daily_xml(
            ECB_DAILY_RATES_URL,
            ECB_FETCH_TIMEOUT_SECONDS,
            ECB_MAX_RESPONSE_BYTES,
        )

    assert str(error.value) == "ECB reference rates are unavailable"


@pytest.mark.parametrize(
    ("url", "timeout", "max_bytes"),
    [
        ("https://example.invalid/rates.xml", ECB_FETCH_TIMEOUT_SECONDS, 65_536),
        (ECB_DAILY_RATES_URL, 4.0, 65_536),
        (ECB_DAILY_RATES_URL, ECB_FETCH_TIMEOUT_SECONDS, 65_535),
    ],
)
def test_bounded_fetch_rejects_any_changed_network_contract(
    url: str,
    timeout: float,
    max_bytes: int,
) -> None:
    with pytest.raises(ExchangeRateUnavailableError):
        fetch_ecb_daily_xml(url, timeout, max_bytes)
