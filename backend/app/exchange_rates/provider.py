from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from email.message import Message
from http.client import HTTPException as HttpClientException
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree

ECB_DAILY_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
ECB_FETCH_TIMEOUT_SECONDS = 3.0
ECB_MAX_RESPONSE_BYTES = 64 * 1024
ECB_CACHE_TTL_SECONDS = 6 * 60 * 60
ECB_FAILURE_CACHE_TTL_SECONDS = 30.0
ECB_MAX_RATE_AGE_DAYS = 7
_GESMES_NAMESPACE = "http://www.gesmes.org/xml/2002-08-01"
_ECB_NAMESPACE = "http://www.ecb.int/vocabulary/2002-08-01/eurofxref"
_ENVELOPE_TAG = f"{{{_GESMES_NAMESPACE}}}Envelope"
_CUBE_TAG = f"{{{_ECB_NAMESPACE}}}Cube"
_RATE_PATTERN = re.compile(r"^(?:0|[1-9]\d{0,4})(?:\.\d{1,12})?$")
_REQUIRED_CURRENCIES = frozenset({"NOK", "PLN"})


class ExchangeRateUnavailableError(Exception):
    """Signal that a safe current reference-rate response is unavailable."""


@dataclass(frozen=True, slots=True)
class EcbExchangeRates:
    """One coherent dated ECB reference-rate snapshot."""

    rate_date: date
    nok_per_eur: Decimal
    pln_per_eur: Decimal


ExchangeRateFetcher = Callable[[str, float, int], bytes]
UtcNowProvider = Callable[[], datetime]
MonotonicProvider = Callable[[], float]


class ExchangeRateReader(Protocol):
    """Describe the provider boundary injected into the HTTP application."""

    def get_rates(self) -> EcbExchangeRates:
        """Return one validated current reference-rate snapshot."""
        ...


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: Message,
        new_url: str,
    ) -> None:
        return None


def fetch_ecb_daily_xml(
    url: str,
    timeout_seconds: float,
    max_bytes: int,
) -> bytes:
    """Fetch the pinned ECB daily XML document without following redirects."""
    if (
        url != ECB_DAILY_RATES_URL
        or timeout_seconds != ECB_FETCH_TIMEOUT_SECONDS
        or max_bytes != ECB_MAX_RESPONSE_BYTES
    ):
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")

    request = Request(
        url,
        headers={
            "Accept": "application/xml, text/xml;q=0.9",
            "User-Agent": "Nordic-Hearth-reference-rate-reader/1.0",
        },
        method="GET",
    )
    try:
        with build_opener(_RejectRedirects()).open(
            request,
            timeout=timeout_seconds,
        ) as response:
            if response.status != 200 or response.geturl() != ECB_DAILY_RATES_URL:
                raise ExchangeRateUnavailableError(
                    "ECB reference rates are unavailable"
                )
            content_type = response.headers.get_content_type()
            if content_type not in {"application/xml", "text/xml"}:
                raise ExchangeRateUnavailableError(
                    "ECB reference rates are unavailable"
                )
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                if not content_length.isascii() or not content_length.isdecimal():
                    raise ExchangeRateUnavailableError(
                        "ECB reference rates are unavailable"
                    )
                if int(content_length) > max_bytes:
                    raise ExchangeRateUnavailableError(
                        "ECB reference rates are unavailable"
                    )
            payload = response.read(max_bytes + 1)
    except ExchangeRateUnavailableError:
        raise
    except (
        HTTPError,
        URLError,
        HttpClientException,
        TimeoutError,
        OSError,
        ValueError,
    ):
        raise ExchangeRateUnavailableError(
            "ECB reference rates are unavailable"
        ) from None

    if not payload or len(payload) > max_bytes:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    return payload


def parse_ecb_daily_xml(payload: bytes) -> EcbExchangeRates:
    """Parse one bounded ECB daily XML response into the required rate pair."""
    if (
        not payload
        or len(payload) > ECB_MAX_RESPONSE_BYTES
        or b"<!DOCTYPE" in payload.upper()
        or b"<!ENTITY" in payload.upper()
    ):
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    try:
        root = ElementTree.fromstring(payload)
    except (ElementTree.ParseError, RecursionError):
        parsing_failed = True
    else:
        parsing_failed = False
    if parsing_failed:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")

    if root.tag != _ENVELOPE_TAG:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    outer_cubes = [element for element in root if element.tag == _CUBE_TAG]
    if len(outer_cubes) != 1:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    outer_cube = outer_cubes[0]
    dated_cubes = [element for element in outer_cube if element.tag == _CUBE_TAG]
    if len(dated_cubes) != 1:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    dated_cube = dated_cubes[0]
    try:
        rate_date = date.fromisoformat(dated_cube.attrib["time"])
    except (KeyError, ValueError):
        raise ExchangeRateUnavailableError(
            "ECB reference rates are unavailable"
        ) from None

    rates: dict[str, Decimal] = {}
    for element in dated_cube:
        if element.tag != _CUBE_TAG or len(element) != 0:
            raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
        currency = element.attrib.get("currency")
        rate_value = element.attrib.get("rate")
        if currency is None or rate_value is None:
            raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
        if currency not in _REQUIRED_CURRENCIES:
            continue
        if currency in rates:
            raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
        rates[currency] = _parse_rate(rate_value)
    if rates.keys() != _REQUIRED_CURRENCIES:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    return EcbExchangeRates(
        rate_date=rate_date,
        nok_per_eur=rates["NOK"],
        pln_per_eur=rates["PLN"],
    )


class ExchangeRateProvider:
    """Load and cache one safe current ECB rate snapshot in process memory."""

    def __init__(
        self,
        *,
        fetcher: ExchangeRateFetcher = fetch_ecb_daily_xml,
        utc_now_provider: UtcNowProvider | None = None,
        monotonic_provider: MonotonicProvider = time.monotonic,
    ) -> None:
        """Configure the bounded fetch, clock, and monotonic cache clock."""
        self._fetcher = fetcher
        self._utc_now_provider = utc_now_provider or (lambda: datetime.now(UTC))
        self._monotonic_provider = monotonic_provider
        self._lock = threading.Lock()
        self._cached_rates: EcbExchangeRates | None = None
        self._cache_expires_at = 0.0
        self._failure_cache_expires_at = 0.0

    def get_rates(self) -> EcbExchangeRates:
        """Return a fresh-enough cached or newly downloaded ECB rate snapshot."""
        with self._lock:
            now = self._validated_now()
            monotonic_now = self._monotonic_provider()
            if (
                self._cached_rates is not None
                and monotonic_now < self._cache_expires_at
                and _is_fresh(self._cached_rates.rate_date, now.date())
            ):
                return self._cached_rates
            if monotonic_now < self._failure_cache_expires_at:
                raise ExchangeRateUnavailableError(
                    "ECB reference rates are unavailable"
                )

            try:
                payload = self._fetcher(
                    ECB_DAILY_RATES_URL,
                    ECB_FETCH_TIMEOUT_SECONDS,
                    ECB_MAX_RESPONSE_BYTES,
                )
                rates = parse_ecb_daily_xml(payload)
                if not _is_fresh(rates.rate_date, now.date()):
                    raise ExchangeRateUnavailableError(
                        "ECB reference rates are unavailable"
                    )
            except ExchangeRateUnavailableError:
                self._remember_failure()
                raise
            except (OSError, TimeoutError, ValueError):
                self._remember_failure()
                raise ExchangeRateUnavailableError(
                    "ECB reference rates are unavailable"
                ) from None
            self._cached_rates = rates
            self._cache_expires_at = monotonic_now + ECB_CACHE_TTL_SECONDS
            self._failure_cache_expires_at = 0.0
            return rates

    def _remember_failure(self) -> None:
        self._failure_cache_expires_at = (
            self._monotonic_provider() + ECB_FAILURE_CACHE_TTL_SECONDS
        )

    def _validated_now(self) -> datetime:
        now = self._utc_now_provider()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
        return now.astimezone(UTC)


def _parse_rate(value: str | None) -> Decimal:
    if value is None or _RATE_PATTERN.fullmatch(value) is None:
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    try:
        rate = Decimal(value)
    except InvalidOperation:
        raise ExchangeRateUnavailableError(
            "ECB reference rates are unavailable"
        ) from None
    if not rate.is_finite() or rate <= 0 or rate > Decimal("10000"):
        raise ExchangeRateUnavailableError("ECB reference rates are unavailable")
    return rate


def _is_fresh(rate_date: date, current_date: date) -> bool:
    age_days = (current_date - rate_date).days
    return 0 <= age_days <= ECB_MAX_RATE_AGE_DAYS
