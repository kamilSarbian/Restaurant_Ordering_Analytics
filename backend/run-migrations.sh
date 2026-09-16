#!/bin/sh
set -eu

exec python -m app.database.migration_runner
