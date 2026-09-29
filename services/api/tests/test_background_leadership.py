"""What the API does when it gains or loses background leadership (see app.leader and main.lifespan)."""

import asyncio
import time
from types import SimpleNamespace

from app.background_jobs import BackgroundJobService
from app.background_wiring import leadership_callbacks
from app.database import (
    LEGACY_ADMIN_USER_ID,
    LEGACY_ORGANIZATION_ID,
    BackgroundJobRow,
    Database,
)


class _Notifications:
    def __init__(self) -> None:
        self.pruned = 0

    def prune(self) -> None:
        self.pruned += 1


def _status(database: Database, job_id) -> str:
    with database.session_factory() as session:
        return session.get(BackgroundJobRow, str(job_id)).status


def test_leading_recovers_and_starts_loops_and_stepping_down_stops_loops_and_own_jobs() -> None:
    database = Database("sqlite+pysqlite:///:memory:")
    database.migrate()
    jobs = BackgroundJobService(database)
    release = asyncio.Event()

    async def slow(context):
        await release.wait()
        return {}

    jobs.register("slow", slow)
    app = SimpleNamespace(state=SimpleNamespace(notifications=_Notifications(), background_jobs=jobs))
    loop_cancelled: list[bool] = []

    async def loop_body() -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            loop_cancelled.append(True)
            raise

    async def scenario():
        lead, step_down = leadership_callbacks(app, lambda: [asyncio.create_task(loop_body())])
        await lead()
        assert app.state.notifications.pruned == 1
        job, _ = jobs.submit(organization_id=LEGACY_ORGANIZATION_ID, user_id=LEGACY_ADMIN_USER_ID,
                             kind="slow", subject_id="s", payload={})
        deadline = time.monotonic() + 5
        while _status(database, job.id) != "running":
            assert time.monotonic() < deadline
            await asyncio.sleep(0.01)
        await step_down()  # another process took over: nothing of ours may keep running
        return job.id

    job_id = asyncio.run(scenario())
    assert loop_cancelled == [True]
    assert jobs._tasks == {}
    # Left "running" on purpose: the new leader's recovery reports it as interrupted (retryable).
    assert _status(database, job_id) == "running"
