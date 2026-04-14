// ─────────────────────────────────────────────────────────────
// YAML DAG Parser — unit tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { CodeParser } from "../src/universal-parser.js";

const parser = new CodeParser();

describe("YAML DAG Parser", () => {
  const dagYaml = `
etl_daily_stock:
  description: "Daily stock synchronization"
  schedule_interval: "0 6 * * *"
  default_args:
    owner: data-team
  concurrency: 3
  tasks:
    extract_stock:
      operator: airflow.operators.python_operator.PythonOperator
      python_callable_file: /dags/stock/extract.py
      python_callable_name: extract_stock_data
      dependencies: []
      retries: 2
      execution_timeout_secs: 600
    transform_stock:
      operator: airflow.operators.python_operator.PythonOperator
      python_callable_file: /dags/stock/transform.py
      python_callable_name: transform_stock
      dependencies:
        - extract_stock
    load_stock:
      operator: airflow.operators.python_operator.PythonOperator
      python_callable_file: /dags/stock/load.py
      python_callable_name: load_to_warehouse
      dependencies:
        - transform_stock
      postgres_conn_id: warehouse_db
`;

  it("extracts DAG metadata", async () => {
    const result = await parser.parseSource("dags.yml", dagYaml);
    expect(result.language).toBe("yaml");
    expect(result.parseErrors).toEqual([]);
    expect(result.dags.length).toBe(1);

    const dag = result.dags[0];
    expect(dag.name).toBe("etl_daily_stock");
    expect(dag.description).toBe("Daily stock synchronization");
    expect(dag.scheduleInterval).toBe("0 6 * * *");
    expect(dag.owner).toBe("data-team");
    expect(dag.concurrency).toBe(3);
  });

  it("extracts all tasks", async () => {
    const result = await parser.parseSource("dags.yml", dagYaml);
    const dag = result.dags[0];
    expect(dag.tasks.length).toBe(3);

    const extract = dag.tasks.find((t) => t.name === "extract_stock");
    expect(extract).toBeDefined();
    expect(extract!.operator).toContain("PythonOperator");
    expect(extract!.pythonCallableFile).toBe("/dags/stock/extract.py");
    expect(extract!.pythonCallableName).toBe("extract_stock_data");
    expect(extract!.retries).toBe(2);
    expect(extract!.executionTimeoutSecs).toBe(600);
    expect(extract!.dependencies).toEqual([]);
  });

  it("extracts task dependencies", async () => {
    const result = await parser.parseSource("dags.yml", dagYaml);
    const dag = result.dags[0];

    const transform = dag.tasks.find((t) => t.name === "transform_stock");
    expect(transform!.dependencies).toEqual(["extract_stock"]);

    const load = dag.tasks.find((t) => t.name === "load_stock");
    expect(load!.dependencies).toEqual(["transform_stock"]);
    expect(load!.postgresConnId).toBe("warehouse_db");
  });

  it("parses non-DAG YAML as empty DAGs (no tasks)", async () => {
    const yaml = `
server:
  port: 8080
  host: localhost
`;
    const result = await parser.parseSource("config.yaml", yaml);
    expect(result.language).toBe("yaml");
    // The parser treats all top-level keys as potential DAGs,
    // but they'll have no tasks
    for (const dag of result.dags) {
      expect(dag.tasks).toEqual([]);
    }
    expect(result.symbols).toEqual([]);
  });

  it("handles invalid YAML gracefully", async () => {
    const invalid = `
  bad: yaml:
    - [unclosed
`;
    const result = await parser.parseSource("bad.yml", invalid);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.dags).toEqual([]);
  });

  it("handles YAML with no top-level object", async () => {
    const scalar = `just a string`;
    const result = await parser.parseSource("scalar.yaml", scalar);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it("handles multiple DAGs in one file", async () => {
    const multi = `
dag_alpha:
  description: "Alpha"
  schedule_interval: "@daily"
  tasks:
    task_a:
      operator: BashOperator
      bash_command: "echo alpha"

dag_beta:
  description: "Beta"
  schedule_interval: "@hourly"
  tasks:
    task_b:
      operator: BashOperator
      bash_command: "echo beta"
`;
    const result = await parser.parseSource("multi.yml", multi);
    expect(result.dags.length).toBe(2);
    expect(result.dags.map((d) => d.name).sort()).toEqual([
      "dag_alpha",
      "dag_beta",
    ]);
  });
});
