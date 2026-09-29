"""Leader election: only one API process runs background loops and startup recovery at a time."""

import asyncio
import os

import pytest

from app.database import Database
from app.leader import AlwaysLeader, LeaderElection, PostgresLeaderLock, leader_lock_for


class FakeLock:
    """A lock another process may hold (``free=False``); ``drop()`` simulates a lost connection."""

    def __init__(self, free: bool = True) -> None:
        self.free = free
        self.held = False
        self.released = 0

    def try_acquire(self) -> bool:
        if not self.held and self.free:
            self.held = True
        return self.held

    def still_held(self) -> bool:
        return self.held

    def release(self) -> None:
        self.held = False
        self.released += 1

    def drop(self, taken_by_another: bool = True) -> None:
        """The connection holding the lock went away; maybe another process grabbed it."""
        self.held = False
        self.free = not taken_by_another


class Recorder:
    def __init__(self) -> None:
        self.started = 0
        self.stopped = 0

    async def start(self) -> None:
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1


def _election(lock: FakeLock, work: Recorder) -> LeaderElection:
    return LeaderElection(lock, start=work.start, stop=work.stop, poll_seconds=0.01, check_seconds=0.01)


async def _until(predicate, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.005)


def test_waits_for_the_lock_then_starts_background_work_once() -> None:
    lock, work = FakeLock(free=False), Recorder()
    election = _election(lock, work)

    async def scenario() -> None:
        task = asyncio.create_task(election.run())
        await asyncio.sleep(0.08)
        assert work.started == 0 and not election.is_leader  # the other process still leads
        lock.free = True  # the other process exited
        await _until(lambda: work.started == 1)
        await asyncio.sleep(0.05)
        assert work.started == 1 and election.is_leader
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert work.stopped == 1
    assert lock.released == 1 and not lock.held


def test_losing_the_lock_stops_background_work_and_resumes_when_regained() -> None:
    lock, work = FakeLock(), Recorder()
    election = _election(lock, work)

    async def scenario() -> None:
        task = asyncio.create_task(election.run())
        await _until(lambda: work.started == 1)
        lock.drop()  # e.g. the database connection holding the lock went away
        await _until(lambda: work.stopped == 1)
        assert not election.is_leader
        lock.free = True
        await _until(lambda: work.started == 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert (work.started, work.stopped) == (2, 2)


def test_a_dropped_lock_that_nobody_else_took_is_taken_back_without_interruption() -> None:
    lock, work = FakeLock(), Recorder()
    election = _election(lock, work)

    async def scenario() -> None:
        task = asyncio.create_task(election.run())
        await _until(lambda: work.started == 1)
        lock.drop(taken_by_another=False)  # e.g. a network blip with only one API process
        await _until(lambda: lock.held)
        await asyncio.sleep(0.05)
        assert election.is_leader
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert (work.started, work.stopped) == (1, 1)  # never stopped until shutdown


def test_try_lead_now_starts_immediately_only_when_the_lock_is_free() -> None:
    async def scenario() -> None:
        busy, idle = Recorder(), Recorder()
        assert await _election(FakeLock(free=False), busy).try_lead_now() is False
        assert busy.started == 0
        election = _election(FakeLock(), idle)
        assert await election.try_lead_now() is True
        assert idle.started == 1 and election.is_leader

    asyncio.run(scenario())


def test_start_failure_does_not_leave_a_half_leader() -> None:
    lock = FakeLock()
    stopped: list[bool] = []

    async def failing_start() -> None:
        raise RuntimeError("boom")

    async def stop() -> None:
        stopped.append(True)

    election = LeaderElection(lock, start=failing_start, stop=stop, poll_seconds=0.01, check_seconds=0.01)

    async def scenario() -> None:
        with pytest.raises(RuntimeError):
            await election.try_lead_now()

    asyncio.run(scenario())
    assert not election.is_leader and not lock.held and stopped == [True]


def test_sqlite_databases_always_lead() -> None:
    database = Database("sqlite+pysqlite:///:memory:")
    lock = leader_lock_for(database)
    assert isinstance(lock, AlwaysLeader)
    assert lock.try_acquire() and lock.still_held()


@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="needs TEST_DATABASE_URL (PostgreSQL)")
def test_postgres_lock_is_exclusive_and_passes_on_when_released() -> None:
    database = Database(os.environ["TEST_DATABASE_URL"])
    first, second = leader_lock_for(database), leader_lock_for(database)
    assert isinstance(first, PostgresLeaderLock)
    try:
        assert first.try_acquire() is True
        assert first.still_held() is True
        assert second.try_acquire() is False  # another process already leads
        first.release()
        assert first.still_held() is False
        assert second.try_acquire() is True
        assert second.try_acquire() is True  # re-entrant check does not stack the lock
        second.release()
        assert first.try_acquire() is True  # one release fully frees it
        first.release()
        assert second.try_acquire() is True
        # A lost connection releases the lock on the server, and the holder notices.
        second._connection.invalidate()
        assert second.still_held() is False
        assert first.try_acquire() is True
    finally:
        first.release()
        second.release()
        database.engine.dispose()
