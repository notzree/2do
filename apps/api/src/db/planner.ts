import type { PlannerDatabase } from "../interfaces/database.ts";
import { task, type Direction, type Edge, type Task } from "../interfaces/plan.ts";

export class SqlitePlannerDatabase implements PlannerDatabase {
	private readonly sql: SqlStorage;
	private readonly storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.storage = storage;
		this.sql = storage.sql;
		this.transaction(() => {
			this.sql.exec(`CREATE TABLE IF NOT EXISTS plan_head (
				singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO plan_head VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS task (
				id TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS dependency (
				prerequisite TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
				dependent TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
				PRIMARY KEY(prerequisite, dependent), CHECK(prerequisite <> dependent)
			);
			CREATE INDEX IF NOT EXISTS by_dependent ON dependency(dependent, prerequisite);`);
		});
	}

	transaction<T>(write: () => T): T {
		return this.storage.transactionSync(write);
	}
	revision() {
		return this.sql
			.exec<{ revision: number }>("SELECT revision FROM plan_head WHERE singleton = 1")
			.one().revision;
	}
	advanceRevision() {
		this.sql.exec("UPDATE plan_head SET revision = revision + 1 WHERE singleton = 1");
	}
	tasks() {
		return this.sql
			.exec<{ document: string }>("SELECT document FROM task ORDER BY id")
			.toArray()
			.map((row) => task.parse(JSON.parse(row.document)));
	}
	task(id: string) {
		const [row] = this.sql.exec<{ document: string }>("SELECT document FROM task WHERE id = ?", id);
		return row && task.parse(JSON.parse(row.document));
	}
	insert(value: Task) {
		this.sql.exec("INSERT INTO task(id, document) VALUES (?, ?)", value.id, JSON.stringify(value));
	}
	update(value: Task) {
		this.sql.exec("UPDATE task SET document = ? WHERE id = ?", JSON.stringify(value), value.id);
	}
	remove(id: string) {
		this.sql.exec("DELETE FROM task WHERE id = ?", id);
	}
	edges() {
		return this.sql
			.exec<Edge>(
				'SELECT prerequisite AS "from", dependent AS "to" FROM dependency ORDER BY prerequisite, dependent',
			)
			.toArray();
	}
	private columns(direction: Direction) {
		return direction === "descendants"
			? (["prerequisite", "dependent"] as const)
			: (["dependent", "prerequisite"] as const);
	}
	neighbors(id: string, direction: Direction) {
		const [source, target] = this.columns(direction);
		return this.sql
			.exec<{ id: string }>(
				`SELECT ${target} AS id FROM dependency WHERE ${source} = ? ORDER BY id`,
				id,
			)
			.toArray()
			.map((r) => r.id);
	}
	reachable(id: string, direction: Direction) {
		const [source, target] = this.columns(direction);
		return this.sql
			.exec<{ id: string }>(
				`WITH RECURSIVE walk(id) AS (
			SELECT ${target} FROM dependency WHERE ${source} = ?
			UNION SELECT d.${target} FROM dependency d JOIN walk w ON d.${source} = w.id
		) SELECT id FROM walk ORDER BY id`,
				id,
			)
			.toArray()
			.map((r) => r.id);
	}
	link({ from, to }: Edge) {
		return (
			this.sql.exec("INSERT INTO dependency VALUES (?, ?) ON CONFLICT DO NOTHING", from, to)
				.rowsWritten > 0
		);
	}
	unlink({ from, to }: Edge) {
		return (
			this.sql.exec("DELETE FROM dependency WHERE prerequisite = ? AND dependent = ?", from, to)
				.rowsWritten > 0
		);
	}
}
