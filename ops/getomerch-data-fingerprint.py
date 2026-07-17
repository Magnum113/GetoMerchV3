#!/usr/bin/env python3

import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$"
)


def fail(message):
    raise SystemExit(f"ERROR: {message}")


def normalized_decimal(value):
    if value == 0:
        return "0"
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def normalized_string(value):
    if not TIMESTAMP_RE.match(value):
        return value
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        return value
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def canonical(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Decimal):
        return normalized_decimal(value)
    if isinstance(value, str):
        return json.dumps(normalized_string(value), ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{json.dumps(str(key), ensure_ascii=False)}:{canonical(value[key])}"
            for key in sorted(value)
        ) + "}"
    fail(f"unsupported JSON value: {type(value).__name__}")


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def decimal_value(value, label):
    if value is None:
        return Decimal(0)
    if isinstance(value, (int, Decimal)):
        return Decimal(value)
    fail(f"{label} must be numeric")


def load_tables(path):
    tables = [line.strip() for line in Path(path).read_text().splitlines() if line.strip()]
    if len(tables) != 20 or len(set(tables)) != 20:
        fail("table allowlist must contain exactly 20 unique tables")
    if any(not re.fullmatch(r"merch_[a-z0-9_]+", table) for table in tables):
        fail("table allowlist contains an unsafe identifier")
    return tables


def fingerprint(tables_path, rows_path, output_path):
    tables = load_tables(tables_path)
    allowed = set(tables)
    table_state = {
        table: {
            "count": 0,
            "last_id": None,
            "pk": hashlib.sha256(),
            "rows": hashlib.sha256(),
            "created_at_min": None,
            "created_at_max": None,
            "updated_at_min": None,
            "updated_at_max": None,
        }
        for table in tables
    }
    current_table_index = 0
    order_quantities = defaultdict(Decimal)
    finance_monthly = defaultdict(
        lambda: {
            "count": 0,
            "amount": Decimal(0),
            "accruals_for_sale": Decimal(0),
            "sale_commission": Decimal(0),
        }
    )
    product_dimensions = Counter()
    workshop_links = Counter()
    ozon_item_quantity_total = Decimal(0)
    ozon_unmatched_item_count = 0
    workshop_item_quantity_total = Decimal(0)

    with Path(rows_path).open() as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line, parse_float=Decimal, parse_int=int)
            except json.JSONDecodeError as error:
                fail(f"invalid NDJSON at line {line_number}: {error}")
            table = row.get("table_name")
            payload = row.get("payload")
            if table not in allowed or not isinstance(payload, dict):
                fail(f"invalid row envelope at line {line_number}")

            table_index = tables.index(table)
            if table_index < current_table_index:
                fail(f"table order moved backwards at line {line_number}")
            current_table_index = table_index

            row_id = payload.get("id")
            if not isinstance(row_id, str) or not row_id:
                fail(f"missing string primary key for {table} at line {line_number}")
            state = table_state[table]
            if state["last_id"] is not None and row_id <= state["last_id"]:
                fail(f"primary keys are not strictly ordered for {table}")
            state["last_id"] = row_id
            state["count"] += 1
            state["pk"].update(f"{row_id}\n".encode())
            state["rows"].update(f"{canonical(payload)}\n".encode())

            for field in ("created_at", "updated_at"):
                raw_value = payload.get(field)
                if raw_value is None:
                    continue
                value = normalized_string(str(raw_value))
                minimum = f"{field}_min"
                maximum = f"{field}_max"
                state[minimum] = value if state[minimum] is None else min(state[minimum], value)
                state[maximum] = value if state[maximum] is None else max(state[maximum], value)

            if table == "merch_ozon_order_items":
                quantity = decimal_value(payload.get("quantity"), f"{table}.quantity")
                ozon_item_quantity_total += quantity
                order_quantities[str(payload.get("order_id"))] += quantity
                if payload.get("product_id") is None:
                    ozon_unmatched_item_count += 1
            elif table == "merch_ozon_finance_operations":
                operation_date = str(payload.get("operation_date") or "")
                if len(operation_date) < 7:
                    fail("finance operation is missing operation_date")
                month = operation_date[:7]
                bucket = finance_monthly[month]
                bucket["count"] += 1
                for field in ("amount", "accruals_for_sale", "sale_commission"):
                    bucket[field] += decimal_value(payload.get(field), f"{table}.{field}")
            elif table == "merch_products":
                dimension = canonical(
                    [
                        payload.get("design_id"),
                        payload.get("size_id"),
                        payload.get("fabric_id"),
                        payload.get("color_id"),
                    ]
                )
                product_dimensions[dimension] += 1
            elif table == "merch_workshop_order_items":
                quantity = decimal_value(payload.get("quantity"), f"{table}.quantity")
                workshop_item_quantity_total += quantity
                link = canonical(
                    [
                        payload.get("order_id"),
                        payload.get("blank_product_id"),
                        payload.get("design_id"),
                        payload.get("result_product_id"),
                    ]
                )
                workshop_links[link] += 1

    table_fingerprints = {}
    for table in tables:
        state = table_state[table]
        table_fingerprints[table] = {
            "row_count": state["count"],
            "primary_key_sha256": state["pk"].hexdigest(),
            "row_sha256": state["rows"].hexdigest(),
            "created_at_min": state["created_at_min"],
            "created_at_max": state["created_at_max"],
            "updated_at_min": state["updated_at_min"],
            "updated_at_max": state["updated_at_max"],
        }

    normalized_finance = {
        month: {
            "count": values["count"],
            "amount": normalized_decimal(values["amount"]),
            "accruals_for_sale": normalized_decimal(values["accruals_for_sale"]),
            "sale_commission": normalized_decimal(values["sale_commission"]),
        }
        for month, values in sorted(finance_monthly.items())
    }
    normalized_order_quantities = {
        key: normalized_decimal(value) for key, value in sorted(order_quantities.items())
    }
    normalized_dimensions = dict(sorted(product_dimensions.items()))
    normalized_workshop_links = dict(sorted(workshop_links.items()))
    business = {
        "ozon_item_quantity_total": normalized_decimal(ozon_item_quantity_total),
        "ozon_unmatched_item_count": ozon_unmatched_item_count,
        "ozon_order_quantity_group_count": len(normalized_order_quantities),
        "ozon_order_quantities_sha256": sha256_text(canonical(normalized_order_quantities)),
        "finance_month_count": len(normalized_finance),
        "finance_monthly_sha256": sha256_text(canonical(normalized_finance)),
        "product_dimension_group_count": len(normalized_dimensions),
        "product_dimensions_sha256": sha256_text(canonical(normalized_dimensions)),
        "workshop_item_quantity_total": normalized_decimal(workshop_item_quantity_total),
        "workshop_link_group_count": len(normalized_workshop_links),
        "workshop_links_sha256": sha256_text(canonical(normalized_workshop_links)),
    }
    result = {
        "format_version": 1,
        "tables": table_fingerprints,
        "business": business,
    }
    result["global_sha256"] = sha256_text(canonical(result))
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


def compare(source_path, target_path, output_path):
    source = json.loads(Path(source_path).read_text())
    target = json.loads(Path(target_path).read_text())
    source_tables = source.get("tables", {})
    target_tables = target.get("tables", {})
    table_names = sorted(set(source_tables) | set(target_tables))
    table_results = {}
    differences = []

    for table in table_names:
        source_value = source_tables.get(table)
        target_value = target_tables.get(table)
        mismatched_fields = []
        if not isinstance(source_value, dict) or not isinstance(target_value, dict):
            mismatched_fields.append("table_presence")
        else:
            for field in sorted(set(source_value) | set(target_value)):
                if source_value.get(field) != target_value.get(field):
                    mismatched_fields.append(field)
        if mismatched_fields:
            differences.append(f"table:{table}:{','.join(mismatched_fields)}")
        table_results[table] = {
            "match": not mismatched_fields,
            "mismatched_fields": mismatched_fields,
        }

    source_business = source.get("business", {})
    target_business = target.get("business", {})
    business_results = {}
    for field in sorted(set(source_business) | set(target_business)):
        matches = source_business.get(field) == target_business.get(field)
        business_results[field] = {"match": matches}
        if not matches:
            differences.append(f"business:{field}")

    global_match = source.get("global_sha256") == target.get("global_sha256")
    if not global_match:
        differences.append("global_sha256")

    report = {
        "format_version": 1,
        "status": "success" if not differences else "failed",
        "table_count": len(table_names),
        "matched_table_count": sum(1 for value in table_results.values() if value["match"]),
        "tables": table_results,
        "business": business_results,
        "global_match": global_match,
        "differences": differences,
    }
    Path(output_path).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if differences:
        fail(f"source/target fingerprints differ in {len(differences)} place(s)")


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in {"fingerprint", "compare"}:
        fail(
            "usage: getomerch-data-fingerprint.py fingerprint TABLES ROWS OUTPUT | "
            "compare SOURCE TARGET OUTPUT"
        )
    if sys.argv[1] == "fingerprint":
        fingerprint(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        compare(sys.argv[2], sys.argv[3], sys.argv[4])


if __name__ == "__main__":
    main()
