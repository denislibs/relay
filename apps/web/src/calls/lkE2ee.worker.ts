// Поток шифрования кадров групповых звонков (livekit-client E2EE): отдельная точка входа сборки — Worker грузит её
// по адресу из assets (apps/web/build.ts), в основной бандл не входит.
import 'livekit-client/e2ee-worker';
