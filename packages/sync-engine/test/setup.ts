import 'fake-indexeddb/auto';
import { migrate } from '../../../apps/server/src/migrate';

await migrate();
