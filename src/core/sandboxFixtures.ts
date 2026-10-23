/**
 * Published PayPal sandbox test values the engine pays with. Documented test
 * data, not secrets, so they belong in the repo. The card number is from the
 * sandbox card-testing page on developer.paypal.com.
 */

export const SANDBOX_CARD = {
  number: "4012000033330026",
  expiry: "2030-01",
  security_code: "123",
  name: "Rehearsal Buyer",
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
export function unclaimedReceiver(token: string): string {
  const tail = token.replace(/[^a-z0-9]/gi, "").slice(-8) || "default";
  return `rehearsal-unclaimed-${tail}@example.com`;
}

export function cardOrderBody(amount: string, currency: string, reference: string) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: reference.slice(0, 127),
        description: `REHEARSAL ${reference}`.slice(0, 127),
        amount: { currency_code: currency, value: amount },
      },
    ],
    payment_source: { card: SANDBOX_CARD },
  };
}

/** A PayPal-wallet order, which is the only shape a buyer can later dispute. */
export function walletOrderBody(amount: string, currency: string, reference: string) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: reference.slice(0, 127),
        description: `REHEARSAL ${reference}`.slice(0, 127),
        amount: { currency_code: currency, value: amount },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: "https://example.com/rehearsal/return",
          cancel_url: "https://example.com/rehearsal/cancel",
          user_action: "PAY_NOW",
        },
      },
    },
  };
}
