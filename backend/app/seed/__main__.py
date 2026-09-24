"""Command-line boundary for the explicit local demonstration seed."""

import argparse
from collections.abc import Sequence
from datetime import datetime

from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings
from app.database.session import create_session_factory
from app.demo import PortfolioDatasetError, generate_portfolio_dataset
from app.seed.portfolio import PortfolioSeedError, seed_portfolio_data
from app.seed.runner import SeedConflictError, seed_menu_data
from app.seed.safety import (
    DEVELOPMENT_DATABASE_NAME,
    PINNED_HOST,
    REQUIRED_PORT,
    SeedSafetyError,
    validate_local_seed_database_url,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Seed the approved local development menu dataset.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--portfolio-reference-end",
        metavar="ISO-8601",
        help=(
            "also persist the deterministic portfolio dataset ending at an "
            "explicit Europe/Oslo midnight"
        ),
    )
    return parser


def _parse_reference_end(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith(("Z", "z")):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        reference_end = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise PortfolioDatasetError(
            "Portfolio reference end must be a valid ISO-8601 datetime."
        ) from exc
    if reference_end.tzinfo is None or reference_end.utcoffset() is None:
        raise PortfolioDatasetError(
            "Portfolio reference end must include an explicit timezone."
        )
    return reference_end


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit local-only seed command and return its exit code."""
    parser = _build_parser()
    arguments = parser.parse_args(argv)

    engine: Engine | None = None
    exit_code = 1
    try:
        portfolio_plan = None
        if arguments.portfolio_reference_end is not None:
            reference_end = _parse_reference_end(arguments.portfolio_reference_end)
            portfolio_plan = generate_portfolio_dataset(reference_end)

        settings = Settings()
        if settings.database_url is None:
            raise SeedSafetyError("DATABASE_URL is required to run the seed.")

        database_url = validate_local_seed_database_url(settings.database_url)
        engine = create_engine(
            database_url,
            pool_pre_ping=True,
            hide_parameters=True,
            connect_args={
                "host": PINNED_HOST,
                "hostaddr": PINNED_HOST,
                "port": REQUIRED_PORT,
                "dbname": DEVELOPMENT_DATABASE_NAME,
            },
        )
        session_factory = create_session_factory(engine)
        if portfolio_plan is None:
            result = seed_menu_data(session_factory)
            print(
                "Seed completed for local development: "
                f"{result.categories_processed} categories and "
                f"{result.menu_items_processed} menu items processed."
            )
        else:
            portfolio_result = seed_portfolio_data(session_factory, portfolio_plan)
            action = "inserted" if portfolio_result.inserted else "already exact"
            print(
                "Portfolio seed completed for local development: "
                f"{portfolio_result.orders_processed} orders {action}."
            )
        exit_code = 0
    except (
        PortfolioDatasetError,
        PortfolioSeedError,
        SeedSafetyError,
        SeedConflictError,
    ) as exc:
        print(f"Seed failed: {exc}")
    except ValidationError:
        print("Seed failed: database configuration is invalid.")
    except SQLAlchemyError:
        print("Seed failed: the database operation did not complete.")
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except SQLAlchemyError:
                print("Seed failed: database cleanup did not complete.")
                exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
