-- A saved log is a user decision, including when the classifier originally suggested the type.
UPDATE task_subtype AS subtype
SET source = 'manual', classifiedTitle = NULL, revision = workflow.revision
FROM plugin_workflow AS workflow
WHERE subtype.taskId = workflow.taskId AND subtype.typeId = workflow.typeId
  AND subtype.source = 'automatic' AND subtype.document IS NOT NULL
  AND subtype.schemaVersion = 1 AND workflow.version = 1
  AND ((subtype.typeId IN ('fitness.activity', 'budgeting.expense', 'productivity.work-session')
        AND json_type(workflow.document, '$.entry') = 'object')
       OR (subtype.typeId = 'nutrition.meal' AND json_extract(workflow.document, '$.logged') = 1));
