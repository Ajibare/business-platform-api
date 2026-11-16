export const ACCESS_TOKEN_TTL_SECONDS = Number(
  process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60,
);
export const REFRESH_TOKEN_TTL_DAYS = Number(process.env.AUTH_REFRESH_TOKEN_DAYS ?? 30);
export const REFRESH_COOKIE_NAME = 'psi_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const VERIFICATION_CODE_TTL_MINUTES = Number(
  process.env.AUTH_VERIFICATION_CODE_TTL_MINUTES ?? 15,
);
export const VERIFICATION_MAX_ATTEMPTS = Number(process.env.AUTH_VERIFICATION_MAX_ATTEMPTS ?? 5);
export const VERIFICATION_RESEND_COOLDOWN_SECONDS = Number(
  process.env.AUTH_VERIFICATION_RESEND_COOLDOWN_SECONDS ?? 60,
);
export const VERIFICATION_MAX_RESENDS = Number(process.env.AUTH_VERIFICATION_MAX_RESENDS ?? 6);

export const PASSWORD_RESET_TTL_MINUTES = Number(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES ?? 30);
export const INVITATION_TTL_DAYS = Number(process.env.AUTH_INVITATION_TTL_DAYS ?? 7);

export const LOGIN_MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5);
export const LOGIN_LOCK_MINUTES = Number(process.env.AUTH_LOGIN_LOCK_MINUTES ?? 15);

export const PASSWORD_MIN_LENGTH = 10;

/** bcrypt cost for new password hashes. Existing hashes keep verifying at their own cost. */
export const PASSWORD_HASH_ROUNDS = Number(process.env.AUTH_BCRYPT_ROUNDS ?? 12);

export const GENERIC_LOGIN_ERROR = 'Incorrect email, phone number or password.';
export const GENERIC_RESET_MESSAGE =
  'If an account exists for this email or phone, we have sent password-reset instructions.';
