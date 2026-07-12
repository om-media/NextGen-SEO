import asyncio
from contextlib import suppress

import app as worker


class FakeArray:
    def __init__(self, rows):
        self._rows = rows

    def astype(self, _dtype):
        return self

    def tolist(self):
        return self._rows


class FakeModel:
    def __init__(self):
        self.calls = []

    def encode(self, texts, batch_size, convert_to_numpy, normalize_embeddings, show_progress_bar):
        self.calls.append({
            'texts': list(texts),
            'batch_size': batch_size,
            'normalize': normalize_embeddings,
            'convert_to_numpy': convert_to_numpy,
            'show_progress_bar': show_progress_bar,
        })
        rows = []
        for index, _text in enumerate(texts):
            vector = [0.0] * 1024
            vector[index % 1024] = 1.0 if normalize_embeddings else 2.0
            rows.append(vector)
        return FakeArray(rows)


class SlowFakeModel(FakeModel):
    def __init__(self, delay_seconds):
        super().__init__()
        self.delay_seconds = delay_seconds

    def encode(self, texts, batch_size, convert_to_numpy, normalize_embeddings, show_progress_bar):
        import time
        time.sleep(self.delay_seconds)
        return super().encode(texts, batch_size, convert_to_numpy, normalize_embeddings, show_progress_bar)


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


async def verify_microbatch_and_metrics():
    saved_batch_wait_ms = worker.BATCH_WAIT_MS
    worker.BATCH_WAIT_MS = 25
    fake_model = FakeModel()
    worker.model = fake_model
    worker.state.update({'dimensions': 1024, 'error': None, 'status': 'ready'})
    batcher = worker.DynamicBatcher()
    await batcher.start()
    try:
        task_a = asyncio.create_task(batcher.submit(['alpha'], True))
        await asyncio.sleep(0)
        task_b = asyncio.create_task(batcher.submit(['beta', 'gamma'], True))
        task_c = asyncio.create_task(batcher.submit(['delta'], False))
        result_a, result_b, result_c = await asyncio.gather(task_a, task_b, task_c)
        metrics = batcher.metrics()

        assert_true(len(fake_model.calls) == 2, f'Expected 2 encode calls, saw {len(fake_model.calls)}')
        assert_true(fake_model.calls[0]['normalize'] is True, f'Expected first batch normalize=True, got {fake_model.calls[0]}')
        assert_true(fake_model.calls[0]['texts'] == ['alpha', 'beta', 'gamma'], f'Unexpected first batch texts: {fake_model.calls[0]}')
        assert_true(fake_model.calls[1]['normalize'] is False, f'Expected second batch normalize=False, got {fake_model.calls[1]}')
        assert_true(fake_model.calls[1]['texts'] == ['delta'], f'Unexpected second batch texts: {fake_model.calls[1]}')
        assert_true(len(result_a) == 1 and len(result_b) == 2 and len(result_c) == 1, 'Expected per-request embedding counts to survive batching.')
        assert_true(metrics['queue']['pendingRequests'] == 0, f'Expected empty queue metrics, got {metrics}')
        assert_true(metrics['inference']['inflightBatches'] == 0, f'Expected no inflight work, got {metrics}')
        assert_true(metrics['inference']['totalBatches'] == 2, f'Expected 2 total batches, got {metrics}')
        assert_true(metrics['inference']['completedRequests'] == 3, f'Expected 3 completed requests, got {metrics}')
        assert_true(metrics['inference']['completedTexts'] == 4, f'Expected 4 completed texts, got {metrics}')
        return {
            'batches': fake_model.calls,
            'metrics': metrics,
        }
    finally:
        worker.BATCH_WAIT_MS = saved_batch_wait_ms
        await batcher.stop()


async def verify_queue_full_and_timeout():
    saved_limits = (
        worker.MAX_QUEUE_REQUESTS,
        worker.MAX_QUEUE_TEXTS,
        worker.QUEUE_TIMEOUT_MS,
    )
    try:
        worker.MAX_QUEUE_REQUESTS = 1
        worker.MAX_QUEUE_TEXTS = 1
        worker.QUEUE_TIMEOUT_MS = 50
        worker.model = SlowFakeModel(delay_seconds=0.2)
        worker.state.update({'dimensions': 1024, 'error': None, 'status': 'ready'})

        queue_limited = worker.DynamicBatcher()
        pending_task = asyncio.create_task(queue_limited.submit(['held'], True))
        await asyncio.sleep(0)
        queue_full_triggered = False
        try:
            await queue_limited.submit(['overflow'], True)
        except worker.QueueFullError:
            queue_full_triggered = True
        pending_task.cancel()
        with suppress(asyncio.CancelledError, worker.QueueTimeoutError):
            await pending_task
        assert_true(queue_full_triggered, 'Expected queue limit enforcement to reject the second request.')

        timeout_batcher = worker.DynamicBatcher()
        await timeout_batcher.start()
        timed_out = False
        try:
            await timeout_batcher.submit(['timeout'], True)
        except worker.QueueTimeoutError:
            timed_out = True
        finally:
            await timeout_batcher.stop()
        assert_true(timed_out, 'Expected slow inference to trip the configured request timeout.')
    finally:
        worker.MAX_QUEUE_REQUESTS, worker.MAX_QUEUE_TEXTS, worker.QUEUE_TIMEOUT_MS = saved_limits


async def main():
    microbatch = await verify_microbatch_and_metrics()
    await verify_queue_full_and_timeout()
    print({
        'microbatchCalls': microbatch['batches'],
        'queueMetrics': microbatch['metrics']['queue'],
        'inferenceMetrics': microbatch['metrics']['inference'],
        'status': 'ok',
    })


if __name__ == '__main__':
    asyncio.run(main())