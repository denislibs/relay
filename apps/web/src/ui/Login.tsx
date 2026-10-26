import { lazy } from './lazy';

/**
 * Экран входа: телефон и код, QR, облачный пароль, паскей, регистрация (см. ui/auth). Отдельным чанком — с ним
 * libphonenumber и QR-кодом (~200 КБ): вошедшему пользователю при загрузке они не нужны.
 */
export const Login = lazy(() => import('./auth/AuthFlow').then((m) => m.AuthFlow), false);
