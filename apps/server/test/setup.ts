import { migrate } from '../src/migrate';
import { initPeerKeys } from '../src/crypto/peerKey';

await migrate();
await initPeerKeys();
