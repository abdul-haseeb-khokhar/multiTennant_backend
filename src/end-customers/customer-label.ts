import { WIDGET_EXTERNAL_ID_PREFIX } from '../widget/widget.constants';

/**
 * An end customer's `external_id` as staff may see it in a conversation or a notification. For an
 * anonymous widget visitor it is `web_<visitorId>`, and the visitor id is that person's only secret
 * (whoever knows it can resume their chat), so only its first characters are shown, enough to tell
 * two visitors apart. Phone numbers and tenant-supplied ids are shown whole.
 */
export function displayExternalId(externalId: string): string {
  if (externalId.startsWith(WIDGET_EXTERNAL_ID_PREFIX)) {
    const visitor = externalId.slice(WIDGET_EXTERNAL_ID_PREFIX.length);
    return `${WIDGET_EXTERNAL_ID_PREFIX}${visitor.slice(0, 6)}…`;
  }
  return externalId;
}

/** A single readable word for a customer: the name when there is one, else the shortened id. */
export function customerLabel(customer: {
  name: string | null;
  externalId: string;
}): string {
  return customer.name?.trim() || displayExternalId(customer.externalId);
}
