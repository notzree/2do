import journal from './meta/_journal.json';
import m0000 from './0000_planner.sql';
import m0001 from './0001_notebook_capture.sql';
import m0002 from './0002_classification_input.sql';
import m0003 from './0003_classification_result.sql';
import m0004 from './0004_time_proposals.sql';
import m0005 from './0005_capture_classification_source.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005
    }
  }
  