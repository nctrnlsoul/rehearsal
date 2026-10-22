/**
 * Published PayPal sandbox test values. These are documented test data, not
 * secrets, so they belong in the repo. Card number is from the sandbox
 * card-testing page on developer.paypal.com.
 */

export const CURRENCY = "USD";

export const SANDBOX_CARD = {
  number: "4012000033330026",
  expiry: "2030-01",
  security_code: "123",
  name: "Rehearsal Gate",
  billing_address: {
    address_line_1: "1 Test Street",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

/**
 * example.com is reserved by RFC 2606 and can never hold a PayPal account, so a
 * payout to it has to sit UNCLAIMED rather than settling.
 */
export function unclaimedReceiver(runId: string): string {
  return `rehearsal-unclaimed-${runId.slice(-6)}@example.com`;
}

export function cardOrderBody(amount: string, reference: string) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: reference,
        description: `REHEARSAL sample store, ${reference}`,
        amount: { currency_code: CURRENCY, value: amount },
      },
    ],
    payment_source: { card: SANDBOX_CARD },
  };
}
