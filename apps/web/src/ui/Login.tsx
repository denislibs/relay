import { AuthFlow } from './auth/AuthFlow';

/** Экран входа: телефон и код, QR, облачный пароль, паскей, регистрация (см. ui/auth). */
export function Login() {
  return <AuthFlow />;
}
