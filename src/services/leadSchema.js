import { z } from 'zod';

// Deliberately permissive: a chatbot gets messy human input, and rejecting a
// real lead is far more expensive than storing a slightly odd phone number.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const trimmed = (max) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= max, { message: `must be at most ${max} characters` });

export const leadFieldsSchema = z.object({
  name: trimmed(120).optional(),
  email: trimmed(200)
    .refine((value) => value === '' || EMAIL_RE.test(value), { message: 'not a valid email address' })
    .optional(),
  phone: trimmed(40).optional(),
  company: trimmed(160).optional(),
  country: trimmed(80).optional(),
  industry: trimmed(120).optional(),
  service_interest: trimmed(160).optional(),
  requirement: trimmed(2000).optional(),
  current_technology: trimmed(500).optional(),
  required_integrations: trimmed(500).optional(),
  expected_volume: trimmed(200).optional(),
  number_of_users: trimmed(120).optional(),
  budget_range: trimmed(120).optional(),
  timeline: trimmed(120).optional(),
  preferred_contact_time: trimmed(120).optional(),
  notes: trimmed(2000).optional(),
});

/** Fields that must be present before a lead can be pushed to the webhook. */
export const REQUIRED_FIELDS = ['name', 'email', 'requirement'];

export function missingRequiredFields(lead) {
  return REQUIRED_FIELDS.filter((field) => !lead?.[field]);
}

/** Validates the lead as a whole, right before submission. */
export function validateForSubmit(lead) {
  const missing = missingRequiredFields(lead);
  if (missing.length) {
    return { ok: false, missing, error: `Missing required field(s): ${missing.join(', ')}` };
  }
  if (!EMAIL_RE.test(lead.email)) {
    return { ok: false, missing: ['email'], error: 'The email address looks invalid.' };
  }
  return { ok: true };
}
