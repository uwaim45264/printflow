/** Password rules (the database enforces the same rules in printflow_private.password_problem). Hashing (bcrypt) happens in the database. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain letters and numbers.';
  return null;
}
