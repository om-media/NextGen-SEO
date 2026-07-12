from __future__ import annotations

import asyncio
import os
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
MODEL_CACHE = os.getenv("EMBEDDING_MODEL_CACHE", "/models")
DEVICE = os.getenv("EMBEDDING_DEVICE", "cpu")
BATCH_SIZE = max(1, int(os.getenv("EMBEDDING_BATCH_SIZE", "16")))
MAX_BATCH_SIZE = max(1, int(os.getenv("EMBEDDING_MAX_BATCH_SIZE", "64")))
MAX_TEXT_CHARS = max(256, int(os.getenv("EMBEDDING_MAX_TEXT_CHARS", "32768")))
CPU_THREADS = max(1, int(os.getenv("EMBEDDING_CPU_THREADS", str(os.cpu_count() or 1))))
BATCH_WAIT_MS = max(0, int(os.getenv("EMBEDDING_BATCH_WAIT_MS", "12")))
QUEUE_TIMEOUT_MS = max(1_000, int(os.getenv("EMBEDDING_QUEUE_TIMEOUT_MS", "120000")))
MAX_QUEUE_REQUESTS = max(1, int(os.getenv("EMBEDDING_MAX_QUEUE_REQUESTS", "128")))
MAX_QUEUE_TEXTS = max(MAX_BATCH_SIZE, int(os.getenv("EMBEDDING_MAX_QUEUE_TEXTS", str(MAX_BATCH_SIZE * 32))))

torch.set_num_threads(CPU_THREADS)

state: dict[str, Any] = {
    "dimensions": None,
    "error": None,
    "model": MODEL_NAME,
    "status": "loading",
}
model: SentenceTransformer | None = None


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_BATCH_SIZE)
    normalize: bool = True

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        cleaned: list[str] = []
        for text in texts:
            value = str(text).strip()
            if not value:
                raise ValueError("Embedding text cannot be empty.")
            if len(value) > MAX_TEXT_CHARS:
                raise ValueError(f"Embedding text exceeds {MAX_TEXT_CHARS} characters.")
            cleaned.append(value)
        return cleaned


class QueueFullError(RuntimeError):
    pass


class QueueTimeoutError(RuntimeError):
    pass


@dataclass(slots=True)
class PendingRequest:
    texts: list[str]
    normalize: bool
    future: asyncio.Future[list[list[float]]]
    enqueued_at: float
    deadline_at: float

    @property
    def text_count(self) -> int:
        return len(self.texts)


class DynamicBatcher:
    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._pending: deque[PendingRequest] = deque()
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        self._pending_requests = 0
        self._pending_texts = 0
        self._inflight_batches = 0
        self._inflight_texts = 0
        self._last_batch_size = 0
        self._last_batch_latency_ms = 0
        self._last_batch_completed_at: str | None = None
        self._rejected_requests = 0
        self._timed_out_requests = 0
        self._canceled_requests = 0
        self._completed_requests = 0
        self._completed_texts = 0
        self._total_batches = 0

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="bge-m3-batcher")

    async def stop(self) -> None:
        async with self._condition:
            self._stopped = True
            self._condition.notify_all()
        if self._task is not None:
            await self._task
            self._task = None

    def metrics(self) -> dict[str, Any]:
        now = time.monotonic()
        oldest_age_ms = 0
        if self._pending:
            oldest_age_ms = max(0, int((now - self._pending[0].enqueued_at) * 1000))
        return {
            "queue": {
                "batchWaitMs": BATCH_WAIT_MS,
                "maxRequests": MAX_QUEUE_REQUESTS,
                "maxTexts": MAX_QUEUE_TEXTS,
                "oldestAgeMs": oldest_age_ms,
                "pendingRequests": self._pending_requests,
                "pendingTexts": self._pending_texts,
                "rejectedRequests": self._rejected_requests,
                "timedOutRequests": self._timed_out_requests,
            },
            "inference": {
                "completedRequests": self._completed_requests,
                "completedTexts": self._completed_texts,
                "inflightBatches": self._inflight_batches,
                "inflightTexts": self._inflight_texts,
                "lastBatchCompletedAt": self._last_batch_completed_at,
                "lastBatchLatencyMs": self._last_batch_latency_ms,
                "lastBatchSize": self._last_batch_size,
                "maxBatchSize": MAX_BATCH_SIZE,
                "requestTimeoutMs": QUEUE_TIMEOUT_MS,
                "totalBatches": self._total_batches,
                "canceledRequests": self._canceled_requests,
            },
        }

    async def submit(self, texts: list[str], normalize: bool) -> list[list[float]]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[list[list[float]]] = loop.create_future()
        now = time.monotonic()
        pending = PendingRequest(
            texts=texts,
            normalize=normalize,
            future=future,
            enqueued_at=now,
            deadline_at=now + (QUEUE_TIMEOUT_MS / 1000),
        )

        async with self._condition:
            self._drop_expired_locked(time.monotonic())
            if self._pending_requests >= MAX_QUEUE_REQUESTS or self._pending_texts + pending.text_count > MAX_QUEUE_TEXTS:
                self._rejected_requests += 1
                raise QueueFullError(
                    f"Embedding queue is full ({self._pending_requests}/{MAX_QUEUE_REQUESTS} requests, {self._pending_texts}/{MAX_QUEUE_TEXTS} texts)."
                )
            self._pending.append(pending)
            self._pending_requests += 1
            self._pending_texts += pending.text_count
            self._condition.notify_all()

        try:
            return await asyncio.wait_for(future, timeout=QUEUE_TIMEOUT_MS / 1000)
        except asyncio.TimeoutError as error:
            if not future.done():
                future.set_exception(QueueTimeoutError("Embedding request timed out waiting for inference."))
                self._timed_out_requests += 1
            raise QueueTimeoutError("Embedding request timed out waiting for inference.") from error
        except asyncio.CancelledError:
            if not future.done():
                future.cancel()
                self._canceled_requests += 1
            raise

    def _drop_expired_locked(self, now: float) -> None:
        if not self._pending:
            return
        kept: deque[PendingRequest] = deque()
        while self._pending:
            pending = self._pending.popleft()
            if pending.future.done():
                self._pending_requests -= 1
                self._pending_texts -= pending.text_count
                continue
            if pending.deadline_at <= now:
                self._pending_requests -= 1
                self._pending_texts -= pending.text_count
                self._timed_out_requests += 1
                pending.future.set_exception(QueueTimeoutError("Embedding request timed out waiting in the queue."))
                continue
            kept.append(pending)
        self._pending = kept

    def _take_next_locked(self, now: float) -> PendingRequest | None:
        self._drop_expired_locked(now)
        while self._pending:
            pending = self._pending.popleft()
            self._pending_requests -= 1
            self._pending_texts -= pending.text_count
            if pending.future.done() or pending.deadline_at <= now:
                if not pending.future.done():
                    self._timed_out_requests += 1
                    pending.future.set_exception(QueueTimeoutError("Embedding request timed out waiting in the queue."))
                continue
            return pending
        return None

    def _take_compatible_locked(self, normalize: bool, remaining_texts: int, now: float) -> PendingRequest | None:
        self._drop_expired_locked(now)
        for index, pending in enumerate(self._pending):
            if pending.future.done():
                continue
            if pending.normalize != normalize:
                continue
            if pending.text_count > remaining_texts:
                return None
            match = pending
            del self._pending[index]
            self._pending_requests -= 1
            self._pending_texts -= pending.text_count
            return match
        return None

    async def _next_batch(self) -> list[PendingRequest] | None:
        async with self._condition:
            while True:
                now = time.monotonic()
                batch_head = self._take_next_locked(now)
                if batch_head is not None:
                    break
                if self._stopped:
                    return None
                await self._condition.wait()

            batch = [batch_head]
            normalize = batch_head.normalize
            used_texts = batch_head.text_count
            wait_deadline = time.monotonic() + (BATCH_WAIT_MS / 1000)

            while used_texts < MAX_BATCH_SIZE:
                now = time.monotonic()
                pending = self._take_compatible_locked(normalize, MAX_BATCH_SIZE - used_texts, now)
                if pending is not None:
                    batch.append(pending)
                    used_texts += pending.text_count
                    continue
                remaining = wait_deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    break

            return batch

    async def _run(self) -> None:
        while True:
            batch = await self._next_batch()
            if batch is None:
                return
            await self._process_batch(batch)

    async def _process_batch(self, batch: list[PendingRequest]) -> None:
        texts: list[str] = []
        spans: list[tuple[PendingRequest, int, int]] = []
        for pending in batch:
            start = len(texts)
            texts.extend(pending.texts)
            spans.append((pending, start, len(texts)))

        started_at = time.perf_counter()
        self._inflight_batches += 1
        self._inflight_texts += len(texts)
        self._last_batch_size = len(texts)

        try:
            vectors = await asyncio.to_thread(encode_texts, texts, batch[0].normalize)
            if len(vectors) != len(texts):
                raise RuntimeError("BGE-M3 batcher returned an invalid embedding count.")
            for pending, start, end in spans:
                if pending.future.done():
                    continue
                pending.future.set_result(vectors[start:end])
                self._completed_requests += 1
                self._completed_texts += pending.text_count
        except Exception as error:
            for pending, _start, _end in spans:
                if pending.future.done():
                    continue
                pending.future.set_exception(error)
        finally:
            self._inflight_batches = max(0, self._inflight_batches - 1)
            self._inflight_texts = max(0, self._inflight_texts - len(texts))
            self._last_batch_latency_ms = int((time.perf_counter() - started_at) * 1000)
            self._last_batch_completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self._total_batches += 1


def load_model() -> None:
    global model
    try:
        loaded = SentenceTransformer(
            MODEL_NAME,
            cache_folder=MODEL_CACHE,
            device=DEVICE,
            trust_remote_code=False,
        )
        dimensions = loaded.get_sentence_embedding_dimension()
        if dimensions != 1024:
            raise RuntimeError(f"Expected a 1024-dimensional BGE-M3 model, received {dimensions}.")
        model = loaded
        state.update({"dimensions": dimensions, "error": None, "status": "ready"})
    except Exception as error:
        state.update({"error": str(error), "status": "error"})


def encode_texts(texts: list[str], normalize: bool) -> list[list[float]]:
    if model is None:
        raise RuntimeError("BGE-M3 is still loading.")
    vectors = model.encode(
        texts,
        batch_size=min(BATCH_SIZE, len(texts), MAX_BATCH_SIZE),
        convert_to_numpy=True,
        normalize_embeddings=normalize,
        show_progress_bar=False,
    )
    return vectors.astype("float32").tolist()


batcher = DynamicBatcher()


def health_payload() -> dict[str, Any]:
    return {
        "device": DEVICE,
        "dimensions": state["dimensions"],
        "error": state["error"],
        "model": MODEL_NAME,
        "status": state["status"],
        **batcher.metrics(),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    loader = threading.Thread(target=load_model, name="bge-m3-loader", daemon=True)
    loader.start()
    await batcher.start()
    try:
        yield
    finally:
        await batcher.stop()


app = FastAPI(title="GSC+ Built-in BGE-M3 Worker", version="1.1.0", lifespan=lifespan)


@app.get("/health/live")
async def health_live():
    return {
        "model": MODEL_NAME,
        "status": state["status"],
        **batcher.metrics(),
    }


@app.get("/health/ready")
async def health_ready():
    payload = health_payload()
    return JSONResponse(payload, status_code=200 if state["status"] == "ready" else 503)


@app.post("/embed")
async def embed(request: EmbedRequest):
    if state["status"] != "ready":
        raise HTTPException(
            status_code=503,
            detail=state["error"] or "BGE-M3 is still loading.",
        )

    try:
        embeddings = await batcher.submit(request.texts, request.normalize)
    except QueueFullError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except QueueTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    return {
        "dimensions": state["dimensions"],
        "embeddings": embeddings,
        "model": MODEL_NAME,
    }