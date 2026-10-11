/** `delivery` in API responses (H3): what happened to the email the request triggered. */
export const DELIVERY_STATUSES = ['sent', 'failed', 'skipped'] as const;

export const DELIVERY_DESCRIPTION =
  '`sent` = handed to the mail provider; `failed` = the provider could not take it (the record still exists, so offer a retry: revoke and re-invite, or resend); `skipped` = nothing was sent because the development console mailer is active. Delivery to the inbox is not confirmed by `sent`.';
