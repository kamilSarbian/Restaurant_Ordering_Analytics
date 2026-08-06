"""Command-line boundary for the explicit local demonstration seed."""

import argparse
from collections.abc import Sequence

from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings
from app.database.session import create_session_factory
from app.seed.runner import SeedConflictError, seed_menu_data
from app.seed.safety import SeedSafetyError, validate_local_seed_database_url


def _build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Seed the approved local development menu dataset."
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit local-only seed command and return its exit code."""
    parser = _build_parser()
    parser.parse_args(argv)

    engine: Engine | None = None
    try:
        settings = Settings()
        if settings.database_url is None:
            raise SeedSafetyError("DATABASE_URL is required to run the seed.")

        database_url = validate_local_seed_database_url(settings.database_url)
        engine = create_engine(database_url, pool_pre_ping=True)
        session_factory = create_session_factory(engine)
        result = seed_menu_data(session_factory)
        print(
            "Seed completed for local development: "
            f"{result.categories_processed} categories and "
            f"{result.menu_items_processed} menu items processed."
        )
        return 0
    except (SeedSafetyError, SeedConflictError) as exc:
        print(f"Seed failed: {exc}")
        return 1
    except ValidationError:
        print("Seed failed: database configuration is invalid.")
        return 1
    except SQLAlchemyError:
        print("Seed failed: the database operation did not complete.")
        return 1
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
