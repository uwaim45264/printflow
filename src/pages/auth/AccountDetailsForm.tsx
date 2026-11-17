import React, { useState } from 'react';
import { authService, ServiceError } from '../../services';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/toast';
import { Alert, Button, Field, Input, PasswordInput } from '../../components/ui';

/** Super Admin: change own username and name. */
export function AccountDetailsForm() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const u = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) errs.username = 'Use 3–40 letters, numbers, dots, dashes or underscores.';
    if (!name.trim()) errs.name = 'Enter your name.';
    if (!current) errs.currentPassword = 'Enter your current password.';
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      const updated = await authService.updateAdminAccount(current, u, name);
      setUser(updated);
      setUsername(updated.username);
      setName(updated.name);
      setCurrent('');
      toast('success', 'Account updated', `Sign in as "${updated.username}" from now on.`);
    } catch (err) {
      if (err instanceof ServiceError && err.field) setErrors({ [err.field]: err.message });
      else setFormError(err instanceof ServiceError ? err.message : 'Could not update account.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Field label="Username" hint="Used to sign in. Letters, numbers, dots, dashes or underscores." error={errors.username}>
        {(p) => (
          <Input {...p} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        )}
      </Field>
      <Field label="Name" error={errors.name}>
        {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Current password" hint="Needed to confirm the change." error={errors.currentPassword}>
        {(p) => <PasswordInput {...p} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Button type="submit" loading={saving}>
        Save sign-in details
      </Button>
    </form>
  );
}
