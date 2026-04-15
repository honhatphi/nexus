# Plan: Promotion CDC Pipeline — Kafka Micro-batch (Giải pháp B)

**Ngày tạo:** 2026-04-15
**Trạng thái:** Draft
**Branch:** `fix/promotion-cdc-microbatch`

---

## 1. Bối cảnh & Vấn đề

### Triệu chứng

- `pull_cdc_product_gifts` và `promotion_transform` DAGs timeout khi ~20K records đến cùng lúc
- `dagrun_timeout=600s` kill task trước khi kịp xử lý (task bị queue 14 phút, timeout hết trước khi bắt đầu)

### Nguyên nhân gốc

1. **Pull**: consume KHÔNG giới hạn records → upsert + publish ALL → nếu run trước chạy lâu, run sau bị queue → `dagrun_timeout` kill
2. **Transform**: consume ALL markers → load ALL từ PG → publish ALL docs → nếu burst lớn, vượt `reserve_seconds=60s` → `execution_timeout` kill
3. **Kiến trúc batch-then-process**: tách biệt pha consume và pha xử lý → phải "đoán" `reserve_seconds` → luôn có rủi ro đoán sai

### Bằng chứng từ log

```
Task started at 16:39 for execution_date 16:25 (14 phút queue)
dagrun_timeout=600s expired at 16:35
Task chỉ consume được 1 record trước khi bị SIGTERM at 16:41
```

### Giải pháp chọn: Kafka Micro-batch (Giải pháp B)

- **Tất cả nguồn** đi qua Kafka changed topic (Pull, webhook, service khác) — giữ nguyên topic
- Transform xử lý micro-batch: `[poll batch → process → flush → commit] × N`
- Transform vẫn chạy `*/5` cron, poll liên tục đến `SAFETY_MARGIN=30s` — không dừng khi Kafka tạm rỗng
- Bỏ phụ thuộc vào `time_budget`, `reserve_seconds` → chỉ giữ `execution_timeout` làm safety net
- Không cần trigger Transform từ Pull — Transform tự `*/5` pick up markers

---

## 2. Kiến trúc trước & sau

### Trước

```
Pull (*/5):
  consume ALL (time_budget=300, reserve=60s) → upsert ALL → publish ALL markers → commit
  dagrun_timeout=600s ← gây kill khi queue

Transform (*/5):
  consume ALL markers (time_budget=240, reserve=60s) → classify ALL → publish ALL → commit
  dagrun_timeout=600s, execution_timeout=300s
  reserve_seconds=60s phải "đoán đúng" mới đủ thời gian flush
```

### Sau

```
Pull (*/5):
  [consume 1000 → upsert → publish markers → commit] × N
  dagrun_timeout=None, execution_timeout=300s

Transform (*/5 cron):
  chạy liên tục trong 270s (= execution_timeout 300s - SAFETY_MARGIN 30s)
  mỗi vòng lặp: poll Kafka 2s
    → có data: [classify → publish Mongo/Kafka → commit] (1 micro-batch 10 IDs)
    → không có data: chờ 2s rồi poll lại (Kafka poll blocking)
  elapsed >= 270s → dừng gracefully, markers còn lại chờ run */5 tiếp theo
  dagrun_timeout=None   ← không kill theo execution_date
  execution_timeout=300s ← chỉ kill nếu code bị stuck (DB hang, infinite loop)
```

---

## 3. Phases & Tasks

### Phase 1: Transform micro-batch ← ưu tiên cao, fix timeout ngay

#### Task 1.1 — Thêm `poll_marker_batch()` vào `kafka.py`

**File:** `dags/promotion_cdc/kafka.py`
**Hành động:** Thêm function mới. KHÔNG sửa `consume_change_markers()` (giữ backward compat).

```python
def poll_marker_batch(
    consumer,
    max_ids: int = 10,
    poll_timeout_ms: int = 2000,
    stats: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Poll markers từ Kafka, gom tối đa max_ids discount IDs rồi trả về.

    Khác consume_change_markers():
    - Không time-bounded, chỉ work-bounded (max_ids)
    - Return ngay khi đủ hoặc hết data (poll trả rỗng)
    - Dùng cho micro-batch loop trong transform
    """
    if stats is None:
        stats = new_consume_stats()

    discount_ids: set = set()
    sku_changes_set: set = set()
    types_passed_map: Dict[int, set] = {}

    while len(discount_ids) < max_ids:
        records = consumer.poll(timeout_ms=poll_timeout_ms)
        if not records:
            break  # hết data trong Kafka → return luôn

        for _partition, messages in records.items():
            for message in messages:
                stats["polled_messages"] += 1
                try:
                    payload = json.loads(message.value)
                except (json.JSONDecodeError, TypeError):
                    stats["skipped_parse_errors"] += 1
                    continue

                discount_id = payload.get("discount_id")
                if discount_id is None:
                    stats["skipped_parse_errors"] += 1
                    continue

                discount_id = int(discount_id)
                stats["parsed_ok"] += 1

                sku = payload.get("sku")
                if sku is not None:
                    sku_changes_set.add((discount_id, sku))
                else:
                    discount_ids.add(discount_id)

                marker_tp = payload.get("types_passed")
                if marker_tp:
                    types_passed_map.setdefault(discount_id, set()).update(marker_tp)

    # Dedup: nếu discount_id có cả discount-level và sku-level → drop sku-level
    filtered_sku_changes = [
        {"discount_id": did, "sku": sku}
        for did, sku in sorted(sku_changes_set)
        if did not in discount_ids
    ]

    return {
        "discount_ids": sorted(discount_ids),
        "sku_changes": filtered_sku_changes,
        "types_passed": {did: sorted(tp) for did, tp in types_passed_map.items()},
    }
```

---

#### Task 1.2 — Refactor `process_cdc_changes()` sang micro-batch

**File:** `dags/promotion_cdc/transform.py`
**Hành động:** Thay thế body của `process_cdc_changes()`.

```python
@task(
    retries=1,
    retry_delay=timedelta(seconds=10),
    execution_timeout=timedelta(seconds=300),  # giữ nguyên — safety net only
)
def process_cdc_changes(**context):
    """Nhận marker → phân loại → đẩy toàn bộ về pipeline cũ (micro-batch)."""
    import time

    from airflow.providers.postgres.hooks.postgres import PostgresHook
    from dags.constant.kafka_settings import kafka_settings
    from dags.promotion_cdc.kafka import kafka_consumer, new_consume_stats, poll_marker_batch, print_consume_stats
    from dags.promotion_cdc.core.query import resolve_discount_classifications, parse_trigger_config
    from dags.promotion_cdc.core.transition import apply_type_transitions
    from dags.promotion_cdc.core.publisher import publish_discount_docs

    BATCH_SIZE = 10
    SAFETY_MARGIN = 30  # dừng 30s trước execution_timeout

    hook = PostgresHook(postgres_conn_id="cps_hub")
    dag_run_conf = (context["dag_run"].conf or {}) if context.get("dag_run") else {}

    # ─── Manual trigger (giữ nguyên logic cũ) ───────────────────────────────
    manual_payload = parse_trigger_config(dag_run_conf, hook)
    manual_discount_ids = manual_payload.get("discount_ids") or []
    manual_sku_changes = manual_payload.get("sku_changes") or []

    if manual_discount_ids or manual_sku_changes:
        print(f"Manual trigger: discount_ids={manual_discount_ids}, sku_changes={len(manual_sku_changes)}")
        classifications = resolve_discount_classifications(hook, manual_discount_ids, manual_sku_changes)
        if not classifications:
            return {"status": "skip", "reason": "no_changes"}
        classifications = apply_type_transitions(classifications, manual_payload.get("types_passed", {}))
        results = publish_discount_docs(classifications)
        processed_ids = sorted({c.discount_id for c in classifications if c.discount_id is not None})
        return {
            "status": "published",
            "results": results,
            "processed_discount_ids": processed_ids,
            "types_passed": manual_payload.get("types_passed", {}),
        }

    # ─── Kafka micro-batch ───────────────────────────────────────────────────
    marker_stats = new_consume_stats()
    marker_topics = kafka_settings.get_promotion_discount_changed_topics()
    marker_group_id = kafka_settings.promotion_discount_changed_group_id

    all_processed_ids: set = set()
    all_results: dict = {}
    all_types_passed: dict = {}
    total_batches = 0
    start_time = time.time()

    with kafka_consumer(marker_topics, marker_group_id) as consumer:
        while True:
            elapsed = time.time() - start_time
            if elapsed >= 300 - SAFETY_MARGIN:
                print(f"Approaching execution_timeout ({elapsed:.0f}s elapsed), stopping gracefully")
                break

            batch = poll_marker_batch(consumer, max_ids=BATCH_SIZE, stats=marker_stats)

            if not batch["discount_ids"] and not batch["sku_changes"]:
                # Kafka tạm rỗng → tiếp tục poll, không dừng
                continue

            print(
                f"Batch {total_batches + 1}: "
                f"discount_ids={batch['discount_ids']}, "
                f"sku_changes={len(batch['sku_changes'])}"
            )

            classifications = resolve_discount_classifications(
                hook, batch["discount_ids"], batch["sku_changes"],
            )

            if classifications:
                classifications = apply_type_transitions(classifications, batch["types_passed"])
                batch_results = publish_discount_docs(classifications)

                # Merge results across batches
                for dtype, result in batch_results.items():
                    if dtype not in all_results:
                        all_results[dtype] = {"docs": 0, "batches": []}
                    all_results[dtype]["docs"] += result.get("docs", 0)
                    all_results[dtype]["batches"].append(result.get("batch_id"))

                all_processed_ids.update(
                    c.discount_id for c in classifications if c.discount_id is not None
                )

            for did, tp in batch["types_passed"].items():
                all_types_passed[str(did)] = tp

            # Commit sau mỗi batch — crash chỉ mất batch hiện tại
            consumer.commit()
            total_batches += 1

        print_consume_stats(marker_stats, "promotion transform micro-batch")

    processed_ids_sorted = sorted(all_processed_ids)
    print(f"Transform complete: {total_batches} batches, {len(processed_ids_sorted)} discount_ids processed")

    return {
        "status": "published" if all_results else "skip",
        "reason": None if all_results else "no_changes",
        "results": all_results,
        "processed_discount_ids": processed_ids_sorted,
        "types_passed": all_types_passed,
        "marker_stats": marker_stats,
        "batches": total_batches,
    }
```

---

#### Task 1.3 — Cập nhật DAG config trong `transform.py`

**File:** `dags/promotion_cdc/transform.py` — decorator `@dag`

| Config              | Trước                    | Sau             | Lý do                                 |
| ------------------- | ------------------------ | --------------- | ------------------------------------- |
| `dagrun_timeout`    | `timedelta(seconds=600)` | `None`          | Task tự dừng khi đến SAFETY_MARGIN    |
| `schedule_interval` | `"*/5 * * * *"`          | `"*/5 * * * *"` | Giữ — fallback khi Pull không trigger |

---

### Phase 2: Pull micro-batch + trigger Transform

#### Task 2.1 — Thêm `max_records` vào `consume_cdc_messages_continuous()`

**File:** `dags/promotion_cdc/kafka.py`
**Hành động:** Thêm 1 param + 1 điều kiện dừng. Backward-compat: default `max_records=5000`.

```python
def consume_cdc_messages_continuous(
    consumer,
    stats=None,
    time_budget=300,
    poll_timeout_ms=1000,
    reserve_seconds=60,
    max_records=5000,       # ← THÊM
) -> Generator[CDCRecord, None, None]:
    ...
    while True:
        if total_yielded >= max_records:
            print(f"Reached max_records={max_records}, stopping consume")
            break
        # ... giữ nguyên phần còn lại ...
```

---

#### Task 2.2 — Refactor `run_pull_cdc()` sang micro-batch

**File:** `dags/promotion_cdc/pull/ingestion.py`

```python
def run_pull_cdc(
    cdc_topics, consumer_group_id, table_label,
    include_raw_products=False, sync_schedule_tracking=False,
) -> dict:
    BATCH_SIZE = 1000
    SAFETY_MARGIN = 30
    EXECUTION_BUDGET = 270  # 300s execution_timeout - 30s safety

    changed_skus: set = set()
    stats = new_consume_stats()
    marker_counts_total = {"expected": 0, "produced": 0, "skipped_snapshot": 0}
    grand_total = 0
    total_batches = 0
    start_time = time.time()

    consumer = build_kafka_consumer(cdc_topics, consumer_group_id)

    try:
        while True:
            elapsed = time.time() - start_time
            remaining = EXECUTION_BUDGET - elapsed
            if remaining <= 30:
                print(f"Approaching time limit ({elapsed:.0f}s), stopping")
                break

            records_by_table: Dict[str, list] = defaultdict(list)
            batch_count = 0

            for record in consume_cdc_messages_continuous(
                consumer=consumer, stats=stats,
                max_records=BATCH_SIZE,
                time_budget=int(remaining),
                reserve_seconds=30,
            ):
                records_by_table[record.pg_table].append(record)
                if include_raw_products:
                    sku = getattr(record.data, "product_code", None)
                    if sku:
                        changed_skus.add(str(sku))
                batch_count += 1

            if batch_count == 0:
                print(f"No more records after {total_batches} batches")
                break

            upsert_records_by_table(dict(records_by_table), db_id="cps_hub")

            if sync_schedule_tracking:
                discount_records = records_by_table.get("cdc_discounts", [])
                if discount_records:
                    from airflow.providers.postgres.hooks.postgres import PostgresHook
                    from dags.promotion_cdc.core.scheduler import sync_schedule_from_cdc
                    hook = PostgresHook(postgres_conn_id="cps_hub")
                    sync_result = sync_schedule_from_cdc([r.data.to_dict() for r in discount_records], hook)
                    print(f"Schedule sync: {sync_result}")

            batch_markers = publish_change_markers(dict(records_by_table))
            if batch_markers["produced"] != batch_markers["expected"]:
                raise RuntimeError(
                    f"Marker mismatch: produced={batch_markers['produced']} "
                    f"expected={batch_markers['expected']}"
                )

            for k in marker_counts_total:
                marker_counts_total[k] += batch_markers.get(k, 0)

            consumer.commit()
            print(f"✅ Committed batch {total_batches + 1} ({batch_count} records)")
            grand_total += batch_count
            total_batches += 1

    finally:
        consumer.close()

    force_full_scan = len(changed_skus) > SKU_XCOM_THRESHOLD
    return {
        "records": grand_total,
        "stats": stats,
        "markers": marker_counts_total,
        "changed_skus": [] if force_full_scan else sorted(changed_skus),
        "force_full_scan": force_full_scan,
        "batches": total_batches,
    }
```

---

#### Task 2.3 — Sửa DAG config trong factory

**File:** `dags/promotion_cdc/pull/factory.py`

| Config                              | Trước                      | Sau                      | Lý do                                  |
| ----------------------------------- | -------------------------- | ------------------------ | -------------------------------------- |
| `dagrun_timeout`                    | `timedelta(seconds=600)`   | `None`                   | Không cần — task tự bounded            |
| `execution_timeout` (pull_cdc task) | `timedelta(seconds=82800)` | `timedelta(seconds=300)` | 23h là bug, micro-batch cần 300s là đủ |

---

### Phase 3: Cleanup

#### Task 3.1 — Deprecate `estimate_poll_duration()`

**File:** `dags/promotion_cdc/kafka.py`

- Bỏ lời gọi trong `run_pull_cdc()` (đã bỏ ở Task 2.2)
- Thêm docstring `# DEPRECATED: micro-batch không cần dynamic time estimation`

#### Task 3.2 — Deprecate old constants

**File:** `dags/promotion_cdc/pull/ingestion.py`

```python
# DEPRECATED — không còn dùng với micro-batch
# PULL_TIME_BUDGET_SECONDS = 300
# STOP_BEFORE_BUDGET_SECONDS = 60
```

---

## 4. Files thay đổi

| File                                   | Phase         | Thay đổi                                                                                 | Rủi ro         |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- | -------------- |
| `dags/promotion_cdc/kafka.py`          | 1.1, 2.1, 3.1 | Thêm `poll_marker_batch()`, thêm `max_records` param, deprecate `estimate_poll_duration` | Thấp           |
| `dags/promotion_cdc/transform.py`      | 1.2, 1.3      | Refactor `process_cdc_changes()` → micro-batch, bỏ `dagrun_timeout`                      | **Trung bình** |
| `dags/promotion_cdc/pull/factory.py`   | 2.3           | Sửa `dagrun_timeout=None`, `execution_timeout=300s`                                      | Thấp           |
| `dags/promotion_cdc/pull/ingestion.py` | 2.2, 3.2      | Refactor `run_pull_cdc()` → micro-batch, deprecate constants                             | **Trung bình** |

**Tổng: 4 files sửa, 0 file mới, 0 file xóa.**
**`factory.py` chỉ sửa 2 dòng config — không thêm task mới.**
**`query.py` không đổi.**

---

## 5. Timeout trước & sau

| Timeout                       | Trước          | Sau        | Ghi chú                                    |
| ----------------------------- | -------------- | ---------- | ------------------------------------------ |
| `dagrun_timeout` (Pull)       | `600s`         | `None`     | Xóa — gây kill khi queue                   |
| `dagrun_timeout` (Transform)  | `600s`         | `None`     | Xóa                                        |
| `PULL_TIME_BUDGET_SECONDS`    | `300s`         | Deprecated | Thay bằng micro-batch loop                 |
| `STOP_BEFORE_BUDGET_SECONDS`  | `60s`          | Deprecated | Không cần reserve                          |
| `time_budget` Transform       | `240s`         | Không dùng | Thay bằng `poll_marker_batch`              |
| `reserve_seconds` Transform   | `60s`          | Không dùng | Không cần — mỗi batch tự flush             |
| `execution_timeout` Pull      | `82800s` ← bug | **`300s`** | Safety net                                 |
| `execution_timeout` Transform | `300s`         | **`300s`** | Safety net                                 |
| `poll_timeout_ms`             | `1000/2000ms`  | `2000ms`   | Kafka poll — rỗng → continue, chờ data mới |

**Từ 6+ timeout phối hợp → 2 timeout còn lại (`execution_timeout` + `poll_timeout_ms`)**

---

## 6. Deploy order

```
Step 1 — Deploy Phase 1 (Transform micro-batch)
  - Fix timeout ngay lập tức
  - Pull vẫn hoạt động như cũ (publish markers vào Kafka)
  - Transform nhận markers từ Kafka, xử lý micro-batch, dừng sớm khi Kafka rỗng
  - Verify: Transform không hit timeout dù burst lớn
  - Verify: Transform với 0 markers chạy đến ~270s rồi exit gracefully

Step 2 — Deploy Phase 2 (Pull micro-batch)
  - Pull bounded theo BATCH_SIZE=1000
  - Verify: Pull không queue khi burst lớn
  - Verify: markers publish đúng sau mỗi batch

Step 3 — Deploy Phase 3 (Cleanup)
  - Comment out deprecated code
  - Không ảnh hưởng behavior
```

**Phase 1 triển khai trước** vì Transform đang timeout trực tiếp gây mất dữ liệu.
**Phase 2 có thể merge sau** vì Pull vẫn hoạt động — chỉ là tối ưu thêm.
**Không cần deploy thay đổi gì cho `factory.py` ở Phase 1** — Pull DAGs không đổi.

---

## 7. Rollback

- **Phase 1:** Revert `transform.py` + `kafka.py` → Transform chạy lại kiểu cũ
- **Phase 2:** Revert `factory.py` + `ingestion.py` → Pull chạy lại kiểu cũ, Transform vẫn micro-batch
- Kafka changed topic **không thay đổi** → rollback không ảnh hưởng data flow
- Consumer group offsets đã commit (per-batch) → không cần reset offset khi rollback

---

## 8. Regression checklist

- [ ] Manual trigger (`discount_id`, `list`, `range_time`) vẫn hoạt động như cũ
- [ ] `upsert_business_discounts` downstream nhận đúng `processed_discount_ids` (list tổng hợp từ tất cả batches)
- [ ] Kafka changed topic vẫn nhận markers từ Pull (`publish_change_markers` không thay đổi)
- [ ] Nguồn khác publish vào Kafka changed topic vẫn được Transform xử lý bình thường
- [ ] `max_active_runs=1` vẫn giữ
- [ ] Không publish duplicate (cùng discount_id trong 2 batch khác nhau → 2 batch_id riêng — OK)
- [ ] Transform với 0 markers poll liên tục đến SAFETY_MARGIN (~270s) rồi exit — không crash, không loop vô hạn
- [ ] Transform dừng gracefully khi `elapsed >= SAFETY_MARGIN`, không bắt đầu batch mới
- [ ] Type transitions (discount đổi loại) vẫn được xử lý đúng
- [ ] `execution_timeout` (300s) KHÔNG bị chạm trong điều kiện bình thường
