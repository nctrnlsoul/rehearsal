/**
 * Says nothing about order state. The state endpoint is behind a shared secret,
 * and a public page listing fulfilments would undo that.
 */
export default function Page() {
  return (
    <main>
      <h1>Ember and Wick</h1>
      <p>A sample merchant app. It takes PayPal webhooks and fulfils orders.</p>
      <ul>
        <li>
          <code>POST /api/paypal/webhook</code> handles an event
        </li>
        <li>
          <code>GET /api/store/state</code> order state, bearer token required
        </li>
      </ul>
      <p>No order data is shown here.</p>
    </main>
  );
}
