import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/migrations.js";
import type { PlannerStore } from "./planner.ts";

export function migratePlanner(store: PlannerStore) {
	const tables = new Set(
		store
			.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.map(({ name }) => name),
	);
	if (!tables.has("plan_head") || tables.has("__drizzle_migrations"))
		return migrate(store, migrations);

	// The pre-Drizzle planner created these tables directly. Place the bridge around the
	// original baseline *inside* the migrator's transaction, including its journal write.
	const legacyTables = ["dependency", "task", "plan_head", "day_page", "notebook_image"].filter(
		(name) => tables.has(name),
	);
	const baseline = [
		"DROP INDEX IF EXISTS by_dependent",
		...legacyTables.map((name) => `ALTER TABLE ${name} RENAME TO legacy_${name}`),
		migrations.migrations.m0000,
		"UPDATE plan_head SET revision = (SELECT revision FROM legacy_plan_head WHERE singleton = 1) WHERE singleton = 1",
		`INSERT INTO task (id, document)
		 SELECT id, json_set(
			json_insert(document, '$.parentId', NULL, '$.revision', (SELECT revision FROM plan_head WHERE singleton = 1)),
			'$.kind', CASE json_extract(document, '$.kind') WHEN 'meal' THEN 'task' ELSE json_extract(document, '$.kind') END
		 ) FROM legacy_task`,
		// Migration v1 uses the task UUID as this manual subtype's initial revision token.
		`INSERT INTO task_subtype (taskId, typeId, schemaVersion, revision, classifiedTitle, source, document)
		 SELECT id, 'nutrition.meal', 1, id, NULL, 'manual', '{}'
		 FROM legacy_task WHERE json_extract(document, '$.kind') = 'meal'`,
		"INSERT INTO dependency (prerequisite, dependent) SELECT prerequisite, dependent FROM legacy_dependency",
		...(tables.has("day_page")
			? [
					"INSERT INTO day_page (day, revision, document, commandHash) SELECT day, revision, document, '' FROM legacy_day_page",
				]
			: []),
		...(tables.has("notebook_image")
			? ["INSERT INTO notebook_image (id) SELECT id FROM legacy_notebook_image"]
			: []),
		...legacyTables.map((name) => `DROP TABLE legacy_${name}`),
	].join("\n--> statement-breakpoint\n");
	return migrate(store, {
		journal: migrations.journal,
		migrations: { ...migrations.migrations, m0000: baseline },
	});
}
