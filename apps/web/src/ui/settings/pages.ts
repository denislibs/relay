// Страницы настроек — одним чанком (ui/lazy.tsx): App.tsx берёт их отсюда через import(), в основной бандл они не входят.
// Мелкие общие помощники (privacyLogic, profileForm, usePhotoPicker) импортируются напрямую и остаются в основном.
export { Autoload } from './Autoload';
export { Blocked } from './Blocked';
export { Data } from './Data';
export { Dev } from './Dev';
export { FolderChats } from './FolderChats';
export { FolderEdit } from './FolderEdit';
export { Folders } from './Folders';
export { General } from './General';
export { Main } from './Main';
export { Notifications } from './Notifications';
export { Passkeys } from './Passkeys';
export { Password } from './Password';
export { PeoplePicker } from './PeoplePicker';
export { Performance } from './Performance';
export { Privacy } from './Privacy';
export { PrivacyRule } from './PrivacyRule';
export { Profile } from './Profile';
export { Sessions } from './Sessions';
export { Wallpaper, WallpaperColor } from './Wallpaper';
export { LinkEdit } from '../links/LinkEdit';
export { Links } from '../links/Links';
