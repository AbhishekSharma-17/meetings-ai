"""Leader election: only one API process runs background loops and startup recovery at a time.

During a deploy the new process starts (and must be ready to serve) while the old one is still
running and draining. The background loops (post-meeting minutes, indexing, calendar scheduling,
retention, …) and startup recovery all assume they are alone, so they only run in the process that
holds a PostgreSQL session-level advisory lock. The lock belongs to one dedicated connection: the
server releases it the moment that connection closes, including when the process crashes, so the
next process takes over within one poll. HTTP requests are served by every process; only
background work is gated.

SQLite (tests and local development) has no advisory locks and only ever runs one process, so it
always leads.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.pool import NullPool

from .database import Database

logger = logging.getLogger(__name__)

# Distinct from the migration lock (73906412 in database.py).
LEADER_LOCK_KEY = 73906413
POLL_SECONDS = 2.0    # how often a waiting process retries the lock
CHECK_SECONDS = 10.0  # how often the leader confirms it still holds it
# libpq settings for the lock connection: fail fast, bound every statement, detect dead peers.
_LOCK_CONNECT_ARGS = {
    "connect_timeout": 5,
    "options": "-c statement_timeout=5000",
    "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10, "keepalives_count": 3,
}


class LeaderLock(Protocol):
    def try_acquire(self) -> bool: ...
    def still_held(self) -> bool: ...
    def release(self) -> None: ...


class AlwaysLeader:
    """Single-process databases (SQLite): this process is always the leader."""

    def try_acquire(self) -> bool:
        return True

    def still_held(self) -> bool:
        return True

    def release(self) -> None:
        return None


class PostgresLeaderLock:
    """A session-level advisory lock held on one dedicated AUTOCOMMIT connection.

    The connection comes from its own single-connection engine, so it never takes a slot from the
    app's pool, and it has connect/statement timeouts plus TCP keepalives, so a dead network path
    is noticed and no call can hang shutdown. AUTOCOMMIT keeps it from idling inside an open
    transaction; session locks outlive transactions anyway. Every method is synchronous and is
    only ever called from one place at a time (LeaderElection serializes them).
    """

    def __init__(self, engine: Engine, key: int = LEADER_LOCK_KEY) -> None:
        self.key = key
        self.engine = create_engine(engine.url, poolclass=NullPool, connect_args=_LOCK_CONNECT_ARGS)
        self._connection: Connection | None = None

    def _connect(self) -> Connection:
        if self._connection is None or self._connection.closed or self._connection.invalidated:
            self._drop()
            self._connection = self.engine.connect().execution_options(isolation_level="AUTOCOMMIT")
        return self._connection

    def try_acquire(self) -> bool:
        try:
            connection = self._connect()
            if self._holds(connection):  # never stack the lock: one release must free it
                return True
            return bool(connection.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": self.key}).scalar())
        except Exception:
            logger.warning("could not try the background leader lock", exc_info=True)
            self._drop()
            return False

    def still_held(self) -> bool:
        if self._connection is None or self._connection.invalidated:
            return False
        try:
            return self._holds(self._connection)
        except Exception:
            logger.warning("lost the connection holding the background leader lock", exc_info=True)
            self._drop()
            return False

    def release(self) -> None:
        connection = self._connection
        if connection is not None and not connection.invalidated and not connection.closed:
            try:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": self.key})
            except Exception:
                logger.warning("could not release the background leader lock cleanly", exc_info=True)
        self._drop()

    def _holds(self, connection: Connection) -> bool:
        # A bigint key below 2^32 is shown with classid 0, objid = key and objsubid 1.
        held = connection.execute(text(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted "
            "AND pid = pg_backend_pid() AND classid = 0 AND objid = :key AND objsubid = 1"
        ), {"key": self.key}).scalar()
        return bool(held)

    def _drop(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()  # closing the session releases any lock it still held
            except Exception:
                logger.debug("closing the leader lock connection failed", exc_info=True)


def leader_lock_for(database: Database) -> LeaderLock:
    if database.engine.dialect.name == "postgresql":
        return PostgresLeaderLock(database.engine)
    return AlwaysLeader()


class LeaderElection:
    """Runs ``start`` while this process holds the lock and ``stop`` when it loses or gives it up."""

    def __init__(self, lock: LeaderLock, *, start: Callable[[], Awaitable[None]], stop: Callable[[], Awaitable[None]],
                 poll_seconds: float = POLL_SECONDS, check_seconds: float = CHECK_SECONDS) -> None:
        self._lock = lock
        self._start = start
        self._stop = stop
        self.poll_seconds = poll_seconds
        self.check_seconds = check_seconds
        self._leading = False
        self._calls = asyncio.Lock()  # the lock's connection is not safe for concurrent use

    async def _call(self, method: Callable[[], object]) -> object:
        async with self._calls:
            return await asyncio.to_thread(method)

    @property
    def is_leader(self) -> bool:
        return self._leading

    async def try_lead_now(self) -> bool:
        """One attempt, used at startup so a lone process recovers before it serves requests."""
        if self._leading:
            return True
        if not await self._call(self._lock.try_acquire):
            return False
        self._leading = True
        logger.info("this process now runs background work")
        try:
            await self._start()
        except BaseException:
            await self._step_down()
            raise
        return True

    async def run(self) -> None:
        """Wait for the lock, lead, and keep checking; hand everything back when cancelled."""
        try:
            while True:
                if not self._leading and not await self._attempt():
                    await asyncio.sleep(self.poll_seconds)
                    continue
                await asyncio.sleep(self.check_seconds)
                if await self._call(self._lock.still_held):
                    continue
                # The lock's connection dropped. If no other process took the lock meanwhile (the
                # usual case: one process and a network blip), take it straight back and carry on.
                if await self._call(self._lock.try_acquire):
                    logger.warning("background leader lock was lost and re-acquired; work continues")
                    continue
                logger.warning("another process now leads background work; stopping it in this process")
                await self._step_down()
        finally:
            if self._leading:
                await self._step_down()
            else:
                await self._call(self._lock.release)

    async def _attempt(self) -> bool:
        try:
            return await self.try_lead_now()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("could not start background work after becoming leader; will retry")
            return False

    async def _step_down(self) -> None:
        self._leading = False
        try:
            await self._stop()
        finally:
            await self._call(self._lock.release)
