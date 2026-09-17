const KEY = "kuchupuchu:contacts";

export interface Contact {
  email: string;
  name: string;
}

/** There is no roster endpoint — the allowlist lives in auth-service and is not
 * exposed. Until one exists, the roster is local, same concession the harness
 * made. It is also what maps a LiveKit participant identity (a device id) back
 * to an email for prekey lookups, so it is load-bearing for E2EE, not just
 * display. */
export function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((c) =>
      c && typeof c === "object" && typeof (c as Contact).email === "string"
        ? [{ email: (c as Contact).email, name: (c as Contact).name ?? (c as Contact).email }]
        : []
    );
  } catch {
    return [];
  }
}

export function saveContacts(contacts: Contact[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(contacts));
  } catch {
    // Nothing actionable; the list is re-enterable.
  }
}

export function displayName(email: string, contacts: Contact[]): string {
  return contacts.find((c) => c.email === email)?.name ?? email;
}

export function initials(label: string): string {
  const parts = label.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
