import journal from './meta/_journal.json';
import m0000 from './0000_planner.sql';
import m0001 from './0001_notebook_capture.sql';
import m0002 from './0002_classification_input.sql';
import m0003 from './0003_classification_result.sql';
import m0004 from './0004_time_proposals.sql';
import m0005 from './0005_capture_classification_source.sql';
import m0006 from './0006_plugin_workflows.sql';
import m0007 from './0007_subtype_extraction.sql';
import m0008 from './0008_calendar_links.sql';
import m0009 from './0009_planner_goals.sql';
import m0010 from './0010_preserve_confirmed_logs.sql';
import m0011 from './0011_agent_inbox.sql';
import m0012 from './0012_agents_workspace.sql';
import m0013 from './0013_workspace_records.sql';
import m0014 from './0014_connected_workouts.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009,
m0010,
m0011,
m0012,
m0013,
m0014
    }
  }
  